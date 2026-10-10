// Parent side of index-worker.ts: one worker thread per project runs the first build and every refresh, one pass
// at a time (the indexer serializes passes on its connection). The thread is started on demand and asked to exit
// after `idleMs` without work, which gives back the parsers' memory between bursts of edits.

import { unlinkSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { indexPath, type KoptConfig } from '../core/config.js';
import { lockHolder } from '../indexer/lock.js';
import type { IndexPhase, IndexStats } from './modules.js';

/** The worker could not load the indexer at all (callers fall back to indexing in-process). */
export class WorkerUnavailable extends Error {}

export interface HostJob {
  kind: 'build' | 'refresh';
  paths?: string[];
  maxFiles?: number;
  lock?: 'wait' | 'skip';
}

interface Pending {
  resolve: (s: IndexStats) => void;
  reject: (e: Error) => void;
  onPhase?: (p: IndexPhase) => void;
}

export interface IndexHostOptions {
  /** Ask the thread to exit after this long without a job. Default 60 s. */
  idleMs?: number;
}

export class IndexHost {
  private worker?: Worker;
  private loaded = false;
  private broken?: string;
  private readonly jobs = new Map<number, Pending>();
  private nextId = 1;
  private idle?: NodeJS.Timeout;

  constructor(private readonly config: KoptConfig, private readonly o: IndexHostOptions = {}) {}

  /** True once the worker failed to load the indexer: every later job is rejected with WorkerUnavailable. */
  get unavailable(): boolean {
    return this.broken !== undefined;
  }

  run(job: HostJob, onPhase?: (p: IndexPhase) => void): Promise<IndexStats> {
    if (this.broken !== undefined) return Promise.reject(new WorkerUnavailable(this.broken));
    if (this.idle) clearTimeout(this.idle);
    this.idle = undefined;
    let w: Worker;
    try {
      w = this.worker ?? this.spawn();
    } catch (err) {
      this.broken = (err as Error).message;
      return Promise.reject(new WorkerUnavailable(this.broken));
    }
    const id = this.nextId++;
    return new Promise<IndexStats>((resolve, reject) => {
      this.jobs.set(id, { resolve, reject, onPhase });
      w.postMessage({ type: 'job', id, job });
    });
  }

  private spawn(): Worker {
    // From sources (tsx) the worker is the .ts file; tsx's loader is inherited through execArgv.
    const file = import.meta.url.endsWith('.ts') ? './index-worker.ts' : './index-worker.js';
    const w = new Worker(new URL(file, import.meta.url), { workerData: { config: this.config }, stdout: true, stderr: true });
    this.worker = w;
    this.loaded = false;
    // Never let worker output reach our stdout (the MCP channel). Worker threads print their own node:sqlite
    // ExperimentalWarning (bin.ts only filters the main thread): drop it from the log.
    w.stdout.pipe(process.stderr);
    w.stderr.on('data', (c: Buffer) => {
      const text = String(c).replace(/^\(node:\d+\) ExperimentalWarning: SQLite[^\n]*\n?(\(Use `node --trace-warnings[^\n]*\n?)?/gm, '');
      if (text) process.stderr.write(text);
    });
    // the MCP server lives as long as its stdin; a pass must never keep a finished process alive
    w.unref();
    w.on('message', (m: { type: string; id?: number; phase?: IndexPhase; stats?: IndexStats; loaded?: boolean; message?: string }) => {
      if (m.type === 'loaded') {
        this.loaded = true;
        return;
      }
      if (m.type === 'error' && m.loaded === false) {
        this.broken = m.message ?? 'indexer failed to load';
        this.drop(w, new WorkerUnavailable(this.broken));
        return;
      }
      const job = m.id !== undefined ? this.jobs.get(m.id) : undefined;
      if (!job) return;
      if (m.type === 'phase' && m.phase) {
        job.onPhase?.(m.phase);
      } else if (m.type === 'done') {
        this.jobs.delete(m.id!);
        job.resolve(m.stats!);
        this.armIdle();
      } else if (m.type === 'error') {
        this.jobs.delete(m.id!);
        job.reject(new Error(m.message));
        this.armIdle();
      }
    });
    w.on('error', (err) => {
      if (!this.loaded) this.broken = err.message;
      this.drop(w, this.loaded ? err : new WorkerUnavailable(err.message));
    });
    w.on('exit', (code) => {
      const err = new Error(`index worker exited (${code})`);
      this.drop(w, this.loaded ? err : new WorkerUnavailable(err.message), !this.loaded);
    });
    return w;
  }

  /** The thread is gone: fail its jobs (a later job starts a new thread unless it could not load at all). */
  private drop(w: Worker, err: Error, markBroken = false): void {
    if (this.worker !== w) return;
    this.worker = undefined;
    if (markBroken && this.broken === undefined && this.jobs.size) this.broken = err.message;
    for (const [id, j] of this.jobs) {
      this.jobs.delete(id);
      j.reject(err);
    }
  }

  private armIdle(): void {
    if (this.jobs.size || !this.worker) return;
    if (this.idle) clearTimeout(this.idle);
    const w = this.worker;
    this.idle = setTimeout(() => {
      this.idle = undefined;
      if (this.worker !== w || this.jobs.size) return;
      this.worker = undefined;
      w.postMessage({ type: 'close' });
      // a thread that does not exit by itself within 5 s is stopped
      setTimeout(() => void w.terminate().catch(() => 0), 5_000).unref();
    }, this.o.idleMs ?? 60_000);
    this.idle.unref();
  }

  /** Stops the thread now; a pass it was running is abandoned (the next one resumes it). */
  close(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = undefined;
    const w = this.worker;
    if (!w) return;
    const busy = this.jobs.size > 0;
    this.drop(w, new Error('index worker closed'));
    void w.terminate().then(
      () => {
        // A pass cut short leaves its lock file behind; nothing else in this process indexes this project.
        if (!busy) return;
        const path = `${indexPath(this.config)}.lock`;
        if (lockHolder(path)?.pid === process.pid) {
          try {
            unlinkSync(path);
          } catch {
            // gone already
          }
        }
      },
      () => 0,
    );
  }
}
