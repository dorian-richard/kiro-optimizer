// The local MCP server: store lifecycle, background indexing, freshness, stdio transport, one-shot CLI calls.
//
// User-level server (`kopt mcp` with no --root, configured once in ~/.kiro/settings/mcp.json): the project root is
// only known after `initialize`. Order: the client's MCP roots (roots/list, when it advertises the capability),
// then KOPT_ROOT, then the server's cwd (Kiro IDE 0.12 advertises no roots and starts MCP servers in the first
// workspace folder: verified in its bundle, MCP client capabilities = {elicitation} only, StdioClientTransport
// cwd = workspace folder). The directory is widened to its git root. A home directory or filesystem root is never
// indexed: tools then answer one line asking to open a project folder.
//
// Indexing never runs on the server's event loop: the first build and every refresh run in a worker thread
// (index-host.ts), so tool calls keep answering while files are parsed, written and resolved. During a first
// build, search/read/outline answer as soon as symbols are written (references are resolved after that); a call
// that would have to wait longer than buildWaitMs answers at once with the phase and an estimate.

import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, win32 } from 'node:path';
import { homedir } from 'node:os';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { findProjectRoot, indexPath, isUnsafeRoot, loadConfig, type KoptConfig } from '../core/config.js';
import { newToolContext, type ToolContext } from '../core/context.js';
import { META } from '../store/schema.js';
import { Store } from '../store/store.js';
import { findGitDirs, gitStateStamp, type GitDirs } from './gitstate.js';
import { IndexHost, WorkerUnavailable } from './index-host.js';
import { withModules, type IndexPhase, type IndexStats, type Modules } from './modules.js';
import { createServer, localTelemetrySink, type RepoHandle } from './server.js';
import { executeTool, parseToolArgs, toolNeedsStore, type ExecuteResult, type ToolName } from './tools.js';
import { warmLoginShellPath } from '../compress/runner.js';

export interface LocalRepoOptions {
  modules?: Partial<Modules>;
  /**
   * Max wait of a call for the first build. A call answers at once (phase + estimate) when the build will clearly
   * take longer than that. Default 15s.
   */
  buildWaitMs?: number;
  /** Max time a call blocks on a refresh of the files the agent wrote (or the start-up catch-up). Default 2s. */
  refreshWaitMs?: number;
  /** Cheap change check this often: dirty marker + git state stamp. Default 30s. 0 = full check before every call. */
  refreshIntervalMs?: number;
  /** Full freshness check (listing + stat of every file) at least this often even when git state did not change. Default 2 min. */
  fullRefreshIntervalMs?: number;
  refreshMaxFiles?: number;
  /** Keep the index fresh before calls. Default true. */
  autoRefresh?: boolean;
  onProgress?: (done: number, total: number) => void;
  log?: (msg: string) => void;
  /** Run builds and refreshes in a worker thread. Default: true unless an indexer module is injected. */
  buildInWorker?: boolean;
  /** The index worker thread exits after this long without work. Default 60s. */
  workerIdleMs?: number;
}

type State = 'closed' | 'building' | 'ready' | 'failed';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());

/** Resolves true when `p` settles within `ms`. Infinity waits forever. */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  if (ms === Infinity) {
    await p.catch(() => {});
    return true;
  }
  let done = false;
  await Promise.race([p.then(() => (done = true), () => (done = true)), sleep(ms)]);
  return done;
}

function fileStamp(path: string): string {
  try {
    const s = statSync(path);
    return `${s.ino}:${s.mtimeMs}:${s.size}`;
  } catch {
    return '';
  }
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** "~40 s", "~3 min". */
export function fmtEta(ms: number): string {
  if (ms < 60_000) return `~${Math.max(5, Math.round(ms / 5000) * 5)} s`;
  return `~${Math.round(ms / 60_000)} min`;
}

function fmtCount(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n);
}

/** Retry delay after the n-th consecutive failed build: 1, 2, 4... min, at most 30 min. */
export function retryDelayMs(failures: number): number {
  return Math.min(30 * 60_000, 60_000 * 2 ** Math.max(0, failures - 1));
}

/** Where the first build is: the time its phase started, and its first progress sample (rates are measured from it). */
interface BuildPhase extends IndexPhase {
  since: number;
  first?: { at: number; done: number };
}

/**
 * A repo with a checkout on disk. Uses two SQLite connections: a writer owned by in-process build/refresh and a
 * reader for retrieval, so queries see the last committed state (WAL) while the indexer works.
 */
export class LocalRepo implements RepoHandle {
  readonly name: string;
  private readonly modules: Modules;
  private readonly dbPath: string;
  private readonly dirtyPath: string;
  private reader?: Store;
  private writer?: Store;
  private host?: IndexHost;
  private state: State = 'closed';
  private build?: Promise<void>;
  private phase: BuildPhase = { phase: 'list', since: Date.now() };
  /** How long the finished phases of the first build took (ms). */
  private phaseMs: Partial<Record<IndexPhase['phase'], number>> = {};
  /** First build: symbols and search are written, references are being resolved. */
  private searchable = false;
  private refreshing?: Promise<void>;
  /** Whether a call should wait (bounded) for the running refresh: files the agent wrote, or the start-up catch-up. */
  private refreshWaitable = false;
  private progress = { done: 0, total: 0 };
  private lastCheck = 0;
  private lastFull = 0;
  private lastDirty = '';
  private gitDirs?: GitDirs | null;
  private lastGitStamp = '';
  private startupCheck = false;
  /** Paths a refresh could not index (another process held the index lock): retried with the next refresh. */
  private readonly pendingPaths = new Set<string>();
  /** Bytes of <dataDir>/dirty already consumed (hooks append one repo-relative path per written file). */
  private dirtyOffset = 0;
  private failure?: { message: string; at: number };
  private failures = 0;
  private readonly o: Required<Omit<LocalRepoOptions, 'modules' | 'onProgress'>> & Pick<LocalRepoOptions, 'onProgress'>;

  constructor(readonly config: KoptConfig, opts: LocalRepoOptions = {}) {
    this.name = basename(config.root);
    this.modules = withModules(opts.modules);
    this.dbPath = indexPath(config);
    this.dirtyPath = join(config.dataDir, 'dirty');
    this.o = {
      buildWaitMs: opts.buildWaitMs ?? 15_000,
      refreshWaitMs: opts.refreshWaitMs ?? 2_000,
      refreshIntervalMs: opts.refreshIntervalMs ?? 30_000,
      fullRefreshIntervalMs: opts.fullRefreshIntervalMs ?? 120_000,
      refreshMaxFiles: opts.refreshMaxFiles ?? 200,
      autoRefresh: opts.autoRefresh ?? true,
      buildInWorker: opts.buildInWorker ?? !opts.modules?.indexer,
      workerIdleMs: opts.workerIdleMs ?? 60_000,
      onProgress: opts.onProgress,
      log: opts.log ?? ((m) => process.stderr.write(`kopt: ${m}\n`)),
    };
    if (this.o.buildInWorker) this.host = new IndexHost(config, { idleMs: this.o.workerIdleMs });
  }

  /** Open the index and start the initial build in the background if it is empty. Idempotent. */
  start(): void {
    if (this.state !== 'closed' && this.state !== 'failed') return;
    // a failing build is retried after 1, 2, 4... min (not every call: each attempt can cost seconds of CPU)
    if (this.state === 'failed' && this.failure && Date.now() - this.failure.at < retryDelayMs(this.failures)) return;
    try {
      this.openConnections();
    } catch (err) {
      this.fail(err);
      return;
    }
    if (this.needsBuild()) this.startBuild();
    else {
      this.state = 'ready';
      // Catch up with edits made while no server was running (full check, so earlier dirty entries are covered).
      // Deferred so initialize/tools/list are answered first; a tool call arriving earlier triggers it itself.
      this.dirtyOffset = fileSize(this.dirtyPath);
      if (this.o.autoRefresh) {
        this.lastCheck = 0;
        this.startupCheck = true;
        setTimeout(() => {
          if (this.state === 'ready') void this.maybeRefresh();
        }, 500).unref();
      }
    }
  }

  /** The index when it is ready (not during a first build), without waiting or refreshing. */
  peek(): Store | undefined {
    this.start();
    return this.state === 'ready' ? this.reader : undefined;
  }

  status(): { state: State; done: number; total: number; error?: string; phase?: string } {
    return { state: this.state, ...this.progress, error: this.failure?.message, phase: this.state === 'building' ? this.phase.phase : undefined };
  }

  async acquire(tool?: string): Promise<Store | string> {
    this.start();
    if (this.state === 'building' && this.build) {
      const needsRefs = tool === 'kopt_refs';
      const t0 = Date.now();
      // the CLI waits for the whole build (it closes the connections right after its one call)
      if (this.o.buildWaitMs === Infinity) await settlesWithin(this.build, Infinity);
      for (;;) {
        if (this.state !== 'building') break;
        if (this.searchable && !needsRefs && this.reader) return this.reader;
        const waited = Date.now() - t0;
        const left = this.o.buildWaitMs - waited;
        if (left <= 0) return this.buildingMessage(needsRefs);
        const eta = this.eta(needsRefs);
        // clearly longer than we may wait: answer now instead of holding the agent for buildWaitMs
        if (eta !== undefined ? eta > left : waited >= Math.min(2_000, this.o.buildWaitMs)) return this.buildingMessage(needsRefs);
        await settlesWithin(this.build, Math.min(250, left));
      }
    }
    if (this.state === 'failed' || !this.reader) {
      return `index unavailable: ${this.failure?.message ?? 'not opened'} – run 'kopt index' in ${this.config.root}`;
    }
    if (this.o.autoRefresh) {
      const pending = this.maybeRefresh();
      if (pending) await settlesWithin(pending, this.o.refreshWaitMs);
    }
    return this.reader;
  }

  /**
   * Estimated time until the build serves this call (search: symbols written; refs: references resolved too), from
   * the progress rate of the current phase and the length of the earlier ones. Measured ratios on 15k-33k file
   * repositories: index rebuild 0.15-0.35x the parse, resolution 0.7-2x, ranks 0.15-0.25x the resolution.
   */
  private eta(needsRefs: boolean): number | undefined {
    const p = this.phase;
    const now = Date.now();
    const elapsed = now - p.since;
    // progress rate since the first sample of this phase (the work before it, e.g. loading the graph, is not progress)
    const left = (): number | undefined => {
      if (!p.first || !p.total || !p.done || p.done <= p.first.done || now - p.first.at < 1_000) return undefined;
      return (p.total - p.done) / ((p.done - p.first.done) / (now - p.first.at));
    };
    switch (p.phase) {
      case 'parse': {
        const l = left();
        if (l === undefined) return undefined;
        const parse = elapsed + l;
        return l + parse * (needsRefs ? 1.8 : 0.25);
      }
      case 'index': {
        const parse = this.phaseMs.parse ?? elapsed * 3;
        const rest = Math.max(2_000, parse * 0.3 - elapsed);
        return needsRefs ? rest + parse * 1.5 : rest;
      }
      case 'resolve': {
        const l = left();
        return l === undefined ? undefined : l + (elapsed + l) * 0.2;
      }
      case 'rank':
        return Math.max(2_000, (this.phaseMs.resolve ?? 20_000) * 0.25 - elapsed);
      default:
        return undefined;
    }
  }

  private buildingMessage(needsRefs: boolean): string {
    const p = this.phase;
    const eta = this.eta(needsRefs);
    const left = eta !== undefined ? `, ${fmtEta(eta)} left` : '';
    if (needsRefs && this.searchable) {
      const what =
        p.phase === 'rank'
          ? `the index is being ranked${left}`
          : `references are being resolved${p.total ? ` (${fmtCount(p.done ?? 0)}/${fmtCount(p.total)}${left})` : left}`;
      return `kopt_refs: ${what} – kopt_find and kopt_read already answer`;
    }
    let what: string;
    if (p.phase === 'wait') what = `another kopt process${p.holder ? ` (pid ${p.holder})` : ''} is indexing this project`;
    else if (p.phase === 'parse' && p.total) what = `${p.done ?? 0}/${p.total} files parsed${left}`;
    else if (p.phase === 'index') what = `writing the search indexes${left}`;
    else if (p.phase === 'resolve' || p.phase === 'rank') what = `resolving references${left}`;
    else what = 'listing files';
    return `index building: ${what} – use built-in search/read tools until then`;
  }

  close(): void {
    this.state = 'closed';
    this.host?.close();
    for (const s of [this.reader, this.writer]) {
      try {
        s?.close();
      } catch {
        // already closed
      }
    }
    this.reader = this.writer = undefined;
  }

  private openConnections(): void {
    this.closeConnections();
    this.writer = Store.open(this.dbPath, { root: this.config.root });
    this.reader = Store.open(this.dbPath, { root: this.config.root });
    for (const s of [this.writer, this.reader]) s.db.exec('PRAGMA busy_timeout=5000');
  }

  private closeConnections(): void {
    for (const s of [this.reader, this.writer]) {
      try {
        s?.close();
      } catch {
        // ignore
      }
    }
    this.reader = this.writer = undefined;
  }

  /** No completed pass yet (fresh DB or an interrupted first build): indexRepo is incremental, so resuming is cheap. */
  private needsBuild(): boolean {
    return !this.reader!.getMeta(META.indexedAt);
  }

  private fail(err: unknown): void {
    const message = (err as Error)?.message ?? String(err);
    this.failure = { message: message.split('\n')[0], at: Date.now() };
    this.failures++;
    this.state = 'failed';
    this.o.log(`index error: ${message}${this.failures > 1 ? ` (attempt ${this.failures}, next in ${fmtEta(retryDelayMs(this.failures))})` : ''}`);
    // `kopt doctor` shows it
    try {
      mkdirSync(this.config.dataDir, { recursive: true });
      writeFileSync(join(this.config.dataDir, 'last-error.json'), JSON.stringify({ at: this.failure.at, message: this.failure.message, attempts: this.failures }));
    } catch {
      // best effort
    }
  }

  private onPhase(p: IndexPhase): void {
    const now = Date.now();
    if (p.phase !== this.phase.phase) {
      this.phaseMs[this.phase.phase] = now - this.phase.since;
      this.phase = { ...p, since: now };
    } else this.phase = { ...this.phase, ...p };
    if (!this.phase.first && (p.done ?? 0) > 0) this.phase.first = { at: now, done: p.done! };
    if (p.phase === 'resolve' || p.phase === 'rank') this.searchable = true;
    if (p.phase === 'parse' && p.total !== undefined) {
      this.progress = { done: p.done ?? 0, total: p.total };
      this.o.onProgress?.(p.done ?? 0, p.total);
    }
  }

  private gitStamp(): string {
    if (this.gitDirs === undefined) this.gitDirs = findGitDirs(this.config.root) ?? null;
    return gitStateStamp(this.gitDirs ?? undefined);
  }

  private async inProcess(kind: 'build' | 'refresh', o: { paths?: string[]; maxFiles?: number; lock?: 'wait' | 'skip' }, onPhase?: (p: IndexPhase) => void): Promise<IndexStats> {
    const indexer = await this.modules.indexer();
    const opts = {
      config: this.config,
      paths: o.paths,
      lock: o.lock,
      onPhase,
      // indexers that only report parse progress (older modules, test fakes)
      onProgress: onPhase ? (done: number, total: number) => onPhase({ phase: 'parse', done, total }) : undefined,
    };
    return kind === 'build' ? indexer.indexRepo(this.writer!, opts) : indexer.refreshIndex(this.writer!, { ...opts, maxFiles: o.maxFiles });
  }

  /** Runs a pass in the worker thread, or in-process when workers are off or cannot load the indexer. */
  private async pass(kind: 'build' | 'refresh', o: { paths?: string[]; maxFiles?: number; lock?: 'wait' | 'skip' }, onPhase?: (p: IndexPhase) => void): Promise<IndexStats> {
    if (this.host && !this.host.unavailable) {
      try {
        return await this.host.run({ kind, ...o }, onPhase);
      } catch (err) {
        if (!(err instanceof WorkerUnavailable)) throw err;
        this.o.log(`index worker unavailable (${err.message}); indexing in-process`);
      }
    }
    return this.inProcess(kind, o, onPhase);
  }

  private startBuild(): void {
    this.state = 'building';
    this.searchable = false;
    this.progress = { done: 0, total: 0 };
    this.phase = { phase: 'list', since: Date.now() };
    this.phaseMs = {};
    const startedAt = Date.now();
    const stamp = this.gitStamp();
    const dirtyAtStart = fileStamp(this.dirtyPath);
    const dirtyOffset = fileSize(this.dirtyPath);
    this.build = (async () => {
      const stats = await this.pass('build', {}, (p) => this.onPhase(p));
      // what changed during the build is caught by the next check: hook-reported paths after the build started, and
      // a full check when git state moved meanwhile
      this.lastCheck = Date.now();
      this.lastFull = startedAt;
      this.lastGitStamp = stamp;
      this.lastDirty = dirtyAtStart;
      this.dirtyOffset = dirtyOffset;
      this.state = 'ready';
      this.searchable = false;
      this.failure = undefined;
      this.failures = 0;
      this.o.log(`indexed ${stats.filesIndexed}/${stats.filesSeen} files, ${stats.symbols} symbols in ${Date.now() - startedAt}ms`);
    })().catch((err) => this.fail(err));
  }

  /**
   * Starts (or joins) a refresh; returns a promise only when the caller should wait for it (bounded by
   * refreshWaitMs): a refresh of the files the agent wrote, or the start-up catch-up. Every refreshIntervalMs the
   * dirty marker and the git state stamp are compared; the full freshness check (listing + stat of every file)
   * runs when git state moved, every fullRefreshIntervalMs, or when the hooks reported too many paths.
   */
  private maybeRefresh(): Promise<void> | undefined {
    if (this.refreshing) return this.refreshWaitable ? this.refreshing : undefined;
    const now = Date.now();
    const dirty = fileStamp(this.dirtyPath);
    const intervalDue = now - this.lastCheck >= this.o.refreshIntervalMs;
    if (dirty === this.lastDirty && !intervalDue && !this.pendingPaths.size) return undefined;
    this.lastDirty = dirty;
    const paths = [...new Set([...this.pendingPaths, ...this.takeDirtyPaths()])];
    this.pendingPaths.clear();
    let full = false;
    if (intervalDue) {
      this.lastCheck = now;
      const stamp = this.gitStamp();
      full = this.startupCheck || this.o.refreshIntervalMs === 0 || stamp !== this.lastGitStamp || now - this.lastFull >= this.o.fullRefreshIntervalMs;
      this.lastGitStamp = stamp;
    }
    if (!full && paths.length > this.o.refreshMaxFiles) full = true;
    if (!full && !paths.length) return undefined;
    if (full) this.lastFull = now;
    const waitable = !full || this.startupCheck;
    this.startupCheck = false;
    this.refreshWaitable = waitable;
    this.refreshing = this.refresh(full ? undefined : paths).finally(() => {
      this.refreshing = undefined;
      this.refreshWaitable = false;
    });
    return waitable ? this.refreshing : undefined;
  }

  /** Complete lines appended to the dirty file since the last read. */
  private takeDirtyPaths(): string[] {
    const size = fileSize(this.dirtyPath);
    if (size < this.dirtyOffset) this.dirtyOffset = 0; // truncated or replaced
    if (size === this.dirtyOffset) return [];
    const len = Math.min(size - this.dirtyOffset, 1 << 20);
    const buf = Buffer.alloc(len);
    let fd: number | undefined;
    try {
      fd = openSync(this.dirtyPath, 'r');
      readSync(fd, buf, 0, len, this.dirtyOffset);
    } catch {
      return [];
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    const end = buf.lastIndexOf(0x0a);
    if (end < 0) return []; // a writer is mid-line; pick it up next time
    this.dirtyOffset += end + 1;
    const paths = buf.subarray(0, end).toString('utf8').split('\n').map((l) => l.trim().replace(/\\/g, '/')).filter(Boolean);
    return [...new Set(paths)];
  }

  private async refresh(paths?: string[]): Promise<void> {
    try {
      // Another process indexing (a second Kiro window, `kopt index`): skip, and retry the reported paths later.
      // In the worker a large change set (a pull) is caught up pass after pass without blocking any call.
      for (let i = 0; i < (this.host && !this.host.unavailable ? 20 : 1); i++) {
        const stats = await this.pass('refresh', { paths, maxFiles: this.o.refreshMaxFiles, lock: 'skip' });
        if (stats.locked) {
          for (const p of paths ?? []) this.pendingPaths.add(p);
          if (!paths) this.lastFull = 0;
          return;
        }
        if (paths || !stats.filesPending) return;
      }
    } catch (err) {
      this.o.log(`refresh failed: ${(err as Error)?.message ?? err}`);
    }
  }
}

/** Route console.* to stderr: stdout is the MCP stdio channel and one stray console.log corrupts it. */
export function protectStdout(): void {
  const toErr = (...args: unknown[]) => console.error(...args);
  console.log = toErr;
  console.info = toErr;
  console.debug = toErr;
}

export interface StdioOptions {
  modules?: Partial<Modules>;
  repo?: LocalRepoOptions;
}

/** Serve MCP over stdio for one local repo. Resolves when the client disconnects. */
export async function serveStdio(config: KoptConfig, opts: StdioOptions = {}): Promise<void> {
  protectStdout();
  const repo = new LocalRepo(config, { ...opts.repo, modules: opts.modules ?? opts.repo?.modules });
  repo.start();
  const server = createServer({
    config,
    repo,
    modules: opts.modules,
    sessionId: `stdio-${randomUUID().slice(0, 8)}`,
  });
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    server.onclose = resolve;
    process.stdin.once('end', resolve);
    process.stdin.once('close', resolve);
  });
  await server.connect(transport);
  // kopt_run's PATH includes the login shell's: read it now, not on the first command.
  warmLoginShellPath();
  await closed;
  await server.close().catch(() => {});
  repo.close();
}

export const NO_PROJECT_MESSAGE =
  'kopt: no project folder is open (kopt never indexes a home directory or a filesystem root) – open a project folder in Kiro';

/** `file://` URI -> local path for `platform` (Windows drive letters and UNC hosts, %-decoding). */
export function fileUriToPath(uri: string, platform: NodeJS.Platform = process.platform): string | undefined {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'file:') return undefined;
  let path: string;
  try {
    path = decodeURIComponent(u.pathname);
  } catch {
    return undefined;
  }
  if (platform === 'win32') {
    let p = path.replace(/\//g, '\\');
    if (/^\\[A-Za-z]:/.test(p)) p = p.slice(1);
    if (u.hostname && u.hostname !== 'localhost') return `\\\\${u.hostname}${p}`;
    return win32.normalize(p);
  }
  return path || '/';
}

export interface RootDecision {
  root?: string;
  source: 'roots' | 'env' | 'cwd';
  /** Set when there is no usable project (home dir, filesystem root). */
  message?: string;
}

export interface RootSearch {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  platform?: NodeJS.Platform;
  home?: string;
  timeoutMs?: number;
}

function finalizeRoot(dir: string, source: RootDecision['source'], home: string): RootDecision {
  const root = source === 'env' ? resolve(dir) : findProjectRoot(dir, home);
  return isUnsafeRoot(root, home) ? { source, message: NO_PROJECT_MESSAGE } : { root, source };
}

/** Project root for a user-level server: client roots, then KOPT_ROOT, then the git root of the cwd. */
export async function decideRoot(server: Server, o: RootSearch = {}): Promise<RootDecision> {
  const env = o.env ?? process.env;
  const home = o.home ?? homedir();
  if (server.getClientCapabilities()?.roots) {
    try {
      const { roots } = await server.listRoots(undefined, { timeout: o.timeoutMs ?? 5000 });
      for (const r of roots ?? []) {
        const p = fileUriToPath(r.uri, o.platform);
        if (p) return finalizeRoot(p, 'roots', home);
      }
    } catch {
      // client advertised roots but did not answer: fall back
    }
  }
  if (env.KOPT_ROOT) return finalizeRoot(env.KOPT_ROOT, 'env', home);
  return finalizeRoot(o.cwd ?? process.cwd(), 'cwd', home);
}

export interface AutoRepoOptions {
  modules?: Partial<Modules>;
  repo?: LocalRepoOptions;
  /** Start the background index build as soon as the root is known (default true; env KOPT_INDEX_ON_START=0). */
  indexOnStart?: boolean;
  /** Called once per newly selected root (legacy IDE hooks, logging). */
  onRoot?: (root: string, config: KoptConfig) => void;
  /** Max wait of a tool call for the root decision. Default 10s. */
  waitMs?: number;
  /** Config for a root (default loadConfig). */
  configFor?: (root: string) => KoptConfig;
}

/** The repo of a user-level server: known after `initialize`, may change when the client's roots change. */
export class AutoRepo implements RepoHandle {
  private current?: LocalRepo;
  /** Why no tool can run (no project folder open). */
  private unavailable?: string;
  private settle!: () => void;
  private readonly decided: Promise<void>;
  private settled = false;

  constructor(private readonly base: KoptConfig, private readonly o: AutoRepoOptions = {}) {
    this.decided = new Promise<void>((r) => (this.settle = r));
  }

  get name(): string {
    return this.current?.name ?? basename(this.base.root);
  }

  get config(): KoptConfig {
    return this.current?.config ?? this.base;
  }

  /** Current root, once decided. */
  get root(): string | undefined {
    return this.current?.config.root;
  }

  get isDecided(): boolean {
    return this.settled;
  }

  setDecision(d: RootDecision): void {
    if (d.root && this.current && resolve(this.current.config.root) === resolve(d.root)) return this.done();
    this.current?.close();
    this.current = undefined;
    this.unavailable = undefined;
    if (!d.root) {
      this.unavailable = d.message ?? NO_PROJECT_MESSAGE;
    } else {
      const config = (this.o.configFor ?? loadConfig)(d.root);
      const repo = new LocalRepo(config, { ...this.o.repo, modules: this.o.modules ?? this.o.repo?.modules });
      this.current = repo;
      if (this.o.indexOnStart !== false) repo.start();
      try {
        this.o.onRoot?.(d.root, config);
      } catch {
        // side work must not break the server
      }
    }
    this.done();
  }

  private done(): void {
    this.settled = true;
    this.settle();
  }

  async prepare(): Promise<string | undefined> {
    await settlesWithin(this.decided, this.o.waitMs ?? 10_000);
    if (this.unavailable) return this.unavailable;
    if (!this.current) return 'kopt: still waiting for the project root from Kiro – retry shortly';
    return undefined;
  }

  async acquire(tool?: string): Promise<Store | string> {
    const m = await this.prepare();
    if (m) return m;
    return this.current!.acquire(tool);
  }

  peek(): Store | undefined {
    return this.current?.peek();
  }

  close(): void {
    this.current?.close();
  }
}

export interface AutoServerOptions extends AutoRepoOptions, RootSearch {
  sessionId?: string;
  /** Fallback when the client never sends `initialized`. Default 3s. */
  initFallbackMs?: number;
}

/** MCP server whose project root is resolved after initialize (see the file header). */
export function createAutoServer(base: KoptConfig, o: AutoServerOptions = {}): { server: Server; repo: AutoRepo; ready: () => Promise<RootDecision> } {
  const repo = new AutoRepo(base, o);
  const server = createServer({
    config: base,
    repo,
    modules: o.modules,
    sessionId: o.sessionId ?? `stdio-${randomUUID().slice(0, 8)}`,
  });
  let last: Promise<RootDecision> | undefined;
  const decide = () => {
    last = decideRoot(server, o).then((d) => {
      repo.setDecision(d);
      return d;
    });
    return last;
  };
  server.oninitialized = () => void decide();
  const fallback = setTimeout(() => {
    if (!last) void decide();
  }, o.initFallbackMs ?? 3000);
  fallback.unref?.();
  server.setNotificationHandler(RootsListChangedNotificationSchema, () => void decide());
  return { server, repo, ready: () => last ?? decide() };
}

/** Legacy IDE 0.x workspace hooks, when wanted on this machine (lazy: most users never need the module). */
async function legacyHooksFor(root: string, config: KoptConfig, log: (m: string) => void): Promise<void> {
  try {
    // IDE 0.x only runs the prompt hook there, and all it adds is prompt pointers: none to write when they are off
    if (!(config.budgets.frontload > 0)) return;
    const legacy = await import('../kiro/legacy.js');
    if (!legacy.legacyHooksWanted(config)) return;
    const r = legacy.ensureLegacyWorkspaceHooks(root, config);
    if (r.written.length) log(`wrote Kiro IDE 0.x hooks: ${r.written.join(', ')}`);
  } catch (err) {
    log(`legacy hooks skipped: ${(err as Error)?.message ?? err}`);
  }
}

/** Serve MCP over stdio for whatever project the client opens (user-level server, no --root). */
export async function serveStdioAuto(base: KoptConfig, opts: StdioOptions & { env?: NodeJS.ProcessEnv; cwd?: string } = {}): Promise<void> {
  protectStdout();
  const env = opts.env ?? process.env;
  const log = opts.repo?.log ?? ((m: string) => process.stderr.write(`kopt: ${m}\n`));
  const { server, repo } = createAutoServer(base, {
    modules: opts.modules,
    repo: opts.repo,
    env,
    cwd: opts.cwd,
    indexOnStart: env.KOPT_INDEX_ON_START !== '0',
    onRoot: (root, config) => {
      log(`project root ${root} (index: ${indexPath(config)})`);
      void legacyHooksFor(root, config, log);
    },
  });
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolveClosed) => {
    server.onclose = resolveClosed;
    process.stdin.once('end', resolveClosed);
    process.stdin.once('close', resolveClosed);
  });
  await server.connect(transport);
  warmLoginShellPath();
  await closed;
  await server.close().catch(() => {});
  repo.close();
}

export interface RunOnceOptions {
  modules?: Partial<Modules>;
  session?: string;
  /** Progress of an initial build (CLI prints it to stderr). */
  onProgress?: (done: number, total: number) => void;
}

/** One tool call outside MCP (CLI). Waits for a full build/refresh instead of answering "retry shortly". */
/** The project's index read-only when one exists, else undefined. */
function openIndexQuietly(config: KoptConfig): Store | undefined {
  const path = indexPath(config);
  if (!existsSync(path)) return undefined;
  try {
    return Store.open(path, { root: config.root, readonly: true });
  } catch {
    return undefined;
  }
}

export async function runToolOnce(config: KoptConfig, name: ToolName, raw: Record<string, unknown>, o: RunOnceOptions = {}): Promise<ExecuteResult> {
  const parsed = parseToolArgs(name, raw);
  if (!parsed.ok) return { text: `${name}: ${parsed.message}`, isError: true };
  const modules = withModules(o.modules);
  const sink = localTelemetrySink(config, modules);
  // Loaded up front so the event is recorded synchronously before the CLI exits.
  await sink.ready;
  const session = o.session ?? process.env.KOPT_SESSION;
  const ctx = newToolContext(config, sink, session ?? 'cli', basename(config.root));
  // A named session (KOPT_SESSION, e.g. an agent driving kopt through the shell) keeps its dedup ledger between
  // calls, as the MCP server does within a session: code already sent comes back as one "unchanged" line.
  const ledger = session ? ledgerFile(config, session) : undefined;
  if (ledger) loadLedger(ctx, ledger);
  try {
    return await runOnceIn(config, name, parsed.args, ctx, modules, o);
  } finally {
    if (ledger) saveLedger(ctx, ledger);
  }
}

/** Where a CLI session's ledger lives: <dataDir>/ledgers/<sha1(session)>.json. */
function ledgerFile(config: KoptConfig, session: string): string {
  return join(config.dataDir, 'ledgers', `${createHash('sha1').update(session).digest('hex').slice(0, 16)}.json`);
}

function loadLedger(ctx: ToolContext, file: string): void {
  try {
    // older than the dedup window: nothing in it would count
    if (Date.now() - statSync(file).mtimeMs > ctx.config.dedup.windowMinutes * 60_000) return;
    ctx.ledger.load(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    // no ledger yet, or unreadable: start empty
  }
}

function saveLedger(ctx: ToolContext, file: string): void {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(ctx.ledger.toState()), { mode: 0o600 });
    renameSync(tmp, file);
    // forget sessions idle for a day
    const dir = dirname(file);
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      try {
        if (Date.now() - statSync(p).mtimeMs > 86_400_000) unlinkSync(p);
      } catch {
        /* removed meanwhile */
      }
    }
  } catch {
    // dedup is an optimization: never fail the call for it
  }
}

async function runOnceIn(config: KoptConfig, name: ToolName, args: Record<string, unknown>, ctx: ToolContext, modules: Modules, o: RunOnceOptions): Promise<ExecuteResult> {
  const parsed = { args };
  if (name === 'kopt_run') {
    // the source context of a failing run uses the index as it is (no build, no refresh)
    const store = openIndexQuietly(config);
    try {
      return await executeTool(name, parsed.args, { modules, ctx, store });
    } finally {
      try {
        store?.close();
      } catch {
        /* already closed */
      }
    }
  }
  if (!toolNeedsStore(name, parsed.args)) return executeTool(name, parsed.args, { modules, ctx });
  if (!existsSync(indexPath(config))) process.stderr.write(`kopt: building index for ${config.root} (first run)…\n`);
  const repo = new LocalRepo(config, {
    modules: o.modules,
    buildWaitMs: Infinity,
    refreshWaitMs: Infinity,
    refreshIntervalMs: 0,
    // A CLI call may block: in-process avoids a second load of the indexer and its grammars.
    buildInWorker: false,
    onProgress: o.onProgress,
    log: () => {},
  });
  try {
    const store = await repo.acquire(name);
    if (typeof store === 'string') return { text: store, isError: true };
    return await executeTool(name, parsed.args, { modules, ctx, store });
  } finally {
    repo.close();
  }
}
