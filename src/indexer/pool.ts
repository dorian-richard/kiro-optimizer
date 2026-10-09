// Parse pool: tree-sitter WASM is single-threaded, so big runs fan out to worker_threads.
//
// Each worker gets a deep queue of jobs (posted messages queue up on its port): the main thread spends
// long stretches in synchronous SQLite batches, and workers must keep parsing meanwhile instead of
// waiting to be handed their next file. Falls back to in-process parsing if workers cannot run: a worker
// that fails to start, crashes or exits has its queued jobs re-run in-process, so a pass always completes.
//
// Worker scripts are addressed by file URL (never a bare path), which is what Node expects on Windows too.
// From the TypeScript sources (tsx dev runs, vitest) the worker is worker.ts and gets the tsx loader as an
// absolute file URL; from dist/ it is worker.js with the parent's Node flags.

import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { prepareFile, type PrepJob, type Prepared } from './prepare.js';

export interface Preparer {
  run(job: PrepJob): Promise<Prepared>;
  /** How many jobs the caller should keep in flight to saturate the preparer. */
  readonly window: number;
  close(): Promise<void>;
}

class InlinePreparer implements Preparer {
  readonly window = 16;
  run(job: PrepJob): Promise<Prepared> {
    return prepareFile(job);
  }
  async close(): Promise<void> {}
}

interface Pending {
  resolve: (r: Prepared) => void;
  reject: (e: Error) => void;
  job: PrepJob;
  worker: Worker;
}

/** Jobs queued per worker: ~1ms each, enough to cover a long synchronous write batch on the main thread. */
const DEPTH = 256;

/** True when this module runs from TypeScript sources (tsx, vitest) rather than from dist/. */
function fromSource(): boolean {
  return /\.[cm]?ts$/.test(new URL(import.meta.url).pathname);
}

/** URL of the worker entry next to this module. */
export function workerScriptUrl(): URL {
  return new URL(fromSource() ? './worker.ts' : './worker.js', import.meta.url);
}

/** Absolute file URL of tsx's loader, or undefined when tsx cannot be resolved. */
function tsxLoaderUrl(): string | undefined {
  try {
    return pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  } catch {
    return undefined;
  }
}

/**
 * Node flags for a worker. Inspector flags are dropped (one debug port per process). From sources the tsx
 * loader must be registered in the worker: the parent's own flags already do it when it was started through
 * tsx; otherwise (vitest, `node --experimental-strip-types`...) it is added as an absolute file URL.
 */
export function workerExecArgv(execArgv: string[] = process.execArgv, source = fromSource(), loader = tsxLoaderUrl()): string[] {
  const args = execArgv.filter((a) => !a.startsWith('--inspect') && !a.startsWith('--debug'));
  // A bare `--import tsx` resolves from the cwd: pin it to the loader this module resolves.
  for (let i = 1; i < args.length; i++) {
    if ((args[i - 1] === '--import' || args[i - 1] === '--loader') && /^tsx(?:\/esm)?$/.test(args[i]) && loader) args[i] = loader;
  }
  if (!source || args.some((a) => /[\\/]tsx[\\/]|^tsx$/.test(a))) return args;
  return loader ? [...args, '--import', loader] : args;
}

class WorkerPool implements Preparer {
  private readonly workers: Worker[] = [];
  private readonly load = new Map<Worker, number>();
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private rr = 0;
  private broken = false;
  private closing = false;
  private readonly inline = new InlinePreparer();
  readonly window: number;

  constructor(size: number, script: URL) {
    this.window = size * DEPTH;
    const execArgv = workerExecArgv();
    for (let i = 0; i < size; i++) {
      let w: Worker;
      try {
        w = new Worker(script, {
          execArgv,
          // never let a worker write to our stdout: it is the MCP stdio channel
          stdout: true,
          stderr: false,
        });
      } catch (err) {
        // do not leave the workers already started running (they would keep the process alive)
        this.closing = true;
        for (const started of this.workers) void started.terminate().catch(() => 0);
        throw err;
      }
      w.stdout.on('data', (d: Buffer) => process.stderr.write(d));
      w.on('message', (m: { id: number; r?: Prepared; error?: string }) => this.onMessage(w, m));
      w.on('error', (err) => this.onError(w, err));
      // Any exit before close() is a failure, even code 0: its queued jobs would otherwise never settle.
      w.on('exit', (code) => {
        if (!this.closing) this.onError(w, new Error(`parse worker exited with code ${code}`));
      });
      this.workers.push(w);
      this.load.set(w, 0);
    }
  }

  /** Whether all workers are still alive (tests). */
  get healthy(): boolean {
    return !this.broken && this.load.size === this.workers.length;
  }

  run(job: PrepJob): Promise<Prepared> {
    const live = this.workers.filter((w) => this.load.has(w));
    if (this.broken || !live.length) return this.inline.run(job);
    // least-loaded worker (round-robin among ties keeps queues even)
    let best = live[this.rr++ % live.length];
    for (const w of live) if (this.load.get(w)! < this.load.get(best)!) best = w;
    const id = this.nextId++;
    this.load.set(best, this.load.get(best)! + 1);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, job, worker: best });
      best.postMessage({ id, job });
    });
  }

  private onMessage(w: Worker, m: { id: number; r?: Prepared; error?: string }): void {
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (this.load.has(w)) this.load.set(w, Math.max(0, this.load.get(w)! - 1));
    if (m.r) p.resolve(m.r);
    else this.inline.run(p.job).then(p.resolve, p.reject);
  }

  /** A dead worker degrades the pool to in-process parsing; its queued jobs are retried inline. */
  private onError(w: Worker, err: Error): void {
    if (!this.broken) process.stderr.write(`kopt: parse worker failed (${err.message}); continuing in-process\n`);
    this.broken = true;
    this.load.delete(w);
    for (const [id, p] of this.pending) {
      if (p.worker !== w) continue;
      this.pending.delete(id);
      this.inline.run(p.job).then(p.resolve, p.reject);
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.all(this.workers.map((w) => w.terminate().catch(() => 0)));
    // Jobs still queued on a worker that was terminated (caller closed early) must not hang forever.
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      this.inline.run(p.job).then(p.resolve, p.reject);
    }
  }
}

/** Below this many files the worker startup cost (~50-100ms each) is not worth it. */
const MIN_FILES_FOR_WORKERS = 150;
const FILES_PER_WORKER = 100;

export interface PreparerOptions {
  /** Worker count override (default: KOPT_INDEX_WORKERS, else up to 6). */
  workers?: number;
  /** Worker entry override (tests). */
  script?: URL;
}

export function createPreparer(fileCount: number, opts: PreparerOptions = {}): Preparer {
  const env = process.env.KOPT_INDEX_WORKERS;
  // measured on spring-framework (9.6k files): 6 workers ~2.1x faster than in-process, more adds memory only
  const max =
    opts.workers !== undefined
      ? Math.max(0, opts.workers | 0)
      : env !== undefined && env !== ''
        ? Math.max(0, Number(env) | 0)
        : Math.min(6, Math.max(0, availableParallelism() - 1));
  if (max <= 1 || fileCount < MIN_FILES_FOR_WORKERS) return new InlinePreparer();
  const n = Math.max(1, Math.min(max, Math.ceil(fileCount / FILES_PER_WORKER)));
  try {
    return new WorkerPool(n, opts.script ?? workerScriptUrl());
  } catch (err) {
    process.stderr.write(`kopt: cannot start parse workers (${(err as Error).message}); parsing in-process\n`);
    return new InlinePreparer();
  }
}
