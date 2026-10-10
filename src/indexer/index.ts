// Indexer entry points (see docs/CONTRACTS.md "indexer").
//
// Pass = list -> stat/compare -> parse changed files (worker pool) -> batched writes -> resolve refs/imports
// -> ranks -> meta. Every pass is resumable: files are committed in batches and an interrupted pass leaves
// `idx_dirty` set, which forces a full re-resolution next time.

import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { KoptConfig } from '../core/config.js';
import { META } from '../store/schema.js';
import type { Store } from '../store/store.js';
import { pythonModule } from './langs/python.js';
import { createPreparer } from './pool.js';
import { sha1, type PrepJob, type Prepared } from './prepare.js';
import { acquireLock, tryLock, type HeldLock } from './lock.js';
import { computeRanks } from './rank.js';
import { resolveIndex, type ResolveStats } from './resolve.js';
import { filterPaths, listFiles, normalizeRel } from './walker.js';
import { toPosixPath } from '../telemetry/fsutil.js';
import { dropSecondaryIndexes, INDEXER_SQL, newTracker, Writer, type DbFile, type WriteTracker } from './writer.js';

export { extractFile } from './parse.js';
export { languageForPath } from './languages.js';
export { splitIdentifier, termsForText } from './terms.js';

export interface IndexOptions {
  config: KoptConfig;
  /** Restrict to these repo-relative paths (incremental). Default: walk the whole repo. */
  paths?: string[];
  onProgress?: (done: number, total: number) => void;
  /** Phase changes and progress of every phase (parse progress is also reported through onProgress). */
  onPhase?: (p: IndexPhase) => void;
  /**
   * Another process indexing the same project (see lock.ts): 'wait' for it to finish (default), or 'skip' this
   * pass (stats.locked is then set and nothing was done).
   */
  lock?: 'wait' | 'skip';
}

/**
 * Where a pass is. 'index': a bulk first build recreates the secondary indexes it dropped. Symbols, files and
 * full-text search are complete (searchable) from 'resolve' on: only references (callers, callees, refs) and ranks are
 * still being computed.
 */
export interface IndexPhase {
  phase: 'wait' | 'list' | 'parse' | 'index' | 'resolve' | 'rank';
  done?: number;
  total?: number;
  /** 'wait': pid of the process holding the index lock. */
  holder?: number;
}

export interface IndexStats {
  filesSeen: number;
  filesIndexed: number;
  filesUnchanged: number;
  filesDeleted: number;
  symbols: number;
  refs: number;
  durationMs: number;
  commit?: string;
  /** Changed files left for a later pass because of `maxFiles` (refreshIndex). */
  filesPending?: number;
  /** Files skipped as binary / minified / too large / unparsable. */
  filesSkipped?: number;
  /** Refs (re)examined by the resolver in this pass, and how many got a target. */
  refsConsidered?: number;
  refsResolved?: number;
  /** True when this pass re-resolved the whole index (first build, recovery, or large change set). */
  fullResolve?: boolean;
  /** 'skip' lock mode: another process was indexing this project, so this pass did nothing. */
  locked?: boolean;
}

const META_DIRTY = 'idx_dirty';
const META_RANK_STALE = 'idx_rank_stale';
const META_PY_PACKAGES = 'idx_py_packages';
const BATCH_FILES = 200;
const BATCH_FILES_BULK = 1000;
const BULK_MIN_FILES = Number(process.env.KOPT_INDEX_BULK_MIN) || 2000;
const DEBUG = process.env.KOPT_INDEX_DEBUG === '1';

let toolVersion: string | undefined;
function getToolVersion(): string {
  if (toolVersion) return toolVersion;
  try {
    toolVersion = String(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version ?? '0.0.0');
  } catch {
    toolVersion = '0.0.0';
  }
  return toolVersion;
}

function gitHead(root: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', ['rev-parse', 'HEAD'], { cwd: root, timeout: 10_000, windowsHide: true }, (err, stdout) => {
      resolve(err ? undefined : stdout.trim() || undefined);
    });
  });
}

/** Serializes passes per store: concurrent writers would fight over the same rows. */
const running = new WeakMap<Store, Promise<unknown>>();

function serialized<T>(store: Store, fn: () => Promise<T>): Promise<T> {
  const prev = running.get(store) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  running.set(store, next);
  return next;
}

export function indexRepo(store: Store, opts: IndexOptions): Promise<IndexStats> {
  return serialized(store, () => runPass(store, opts));
}

/** Cheap freshness check (git listing + mtime/size compare); re-indexes only changed files. */
export function refreshIndex(store: Store, opts: IndexOptions & { maxFiles?: number }): Promise<IndexStats> {
  return serialized(store, () => runPass(store, opts, opts.maxFiles));
}

interface Candidate {
  rel: string;
  size: number;
  mtimeMs: number;
  /** Re-parse even if the content hash did not change (derived data such as the module name did). */
  force?: boolean;
}

function pythonPackages(...lists: string[][]): Set<string> {
  const out = new Set<string>();
  for (const list of lists) {
    for (const rel of list) {
      if (rel.endsWith('/__init__.py') || rel.endsWith('/__init__.pyi')) out.add(rel.slice(0, rel.lastIndexOf('/')));
    }
  }
  return out;
}

interface Plan {
  /** Directories holding an `__init__.py` (Python package roots). */
  pyPackages: Set<string>;
  pkgSig: string;
  listed: string[];
  removed: string[];
  /** Skip markers of files that no longer exist. */
  staleSkips: string[];
  candidates: Candidate[];
  preSkipped: Prepared[];
  unchanged: number;
  pending: number;
}

class Timer {
  private last = Date.now();
  mark(label: string): void {
    if (!DEBUG) return;
    const now = Date.now();
    const m = process.memoryUsage();
    process.stderr.write(`kopt index: ${label} ${now - this.last}ms (rss ${Math.round(m.rss / 1e6)}MB heap ${Math.round(m.heapUsed / 1e6)}MB)\n`);
    this.last = now;
  }
}

function loadDbFiles(store: Store): Map<string, DbFile> {
  const out = new Map<string, DbFile>();
  for (const r of store.db.prepare('SELECT id, path, size, mtime_ms, hash FROM files').all() as unknown as Array<DbFile & { path: string }>) {
    out.set(r.path, { id: r.id, size: r.size, mtime_ms: r.mtime_ms, hash: r.hash });
  }
  return out;
}

function realpathOrUndefined(p: string): string | undefined {
  try {
    return realpathSync.native(p);
  } catch {
    return undefined;
  }
}

/**
 * Spelling of a hook-reported path as the filesystem stores it, relative to the real root: fixes the case on
 * case-insensitive filesystems (a second `files` row for `src/userservice.ts` would duplicate every symbol of
 * `src/UserService.ts`) and resolves symlinked parent directories. Undefined when the file lives outside the
 * repository (a symlink escaping it); the input spelling when the file does not exist (deleted).
 */
export function canonicalRel(rootReal: string, root: string, rel: string): string | undefined {
  const real = realpathOrUndefined(join(root, rel));
  if (real === undefined) return rel;
  const r = toPosixPath(relative(rootReal, real));
  if (!r || r === '..' || r.startsWith('../') || /^[A-Za-z]:/.test(r) || r.startsWith('/')) return undefined;
  return r;
}

/** Lists files and compares size/mtime with the index; only changed files will be read. */
async function plan(store: Store, opts: IndexOptions, dbFiles: Map<string, DbFile>, maxFiles: number | undefined, timer: Timer): Promise<Plan> {
  const cfg = opts.config;
  const root = cfg.root;
  const skipped = new Map<string, { size: number; mtime_ms: number; reason: string }>();
  for (const r of store.db.prepare('SELECT path, size, mtime_ms, reason FROM idx_skipped').all() as Array<{ path: string; size: number; mtime_ms: number; reason: string }>) {
    skipped.set(r.path, r);
  }
  let listed: string[];
  const removed: string[] = [];
  const staleSkips: string[] = [];
  const rootReal = realpathOrUndefined(root) ?? root;
  if (opts.paths) {
    const rels = new Set<string>();
    for (const p of opts.paths) {
      const rel = normalizeRel(root, p);
      const canon = canonicalRel(rootReal, root, rel);
      if (canon !== undefined) rels.add(canon);
      else if (dbFiles.has(rel)) removed.push(rel);
    }
    const { keep, dropped } = filterPaths(cfg, [...rels]);
    listed = keep;
    for (const p of dropped) if (dbFiles.has(p)) removed.push(p);
  } else {
    listed = (await listFiles(cfg)).files;
    const set = new Set(listed);
    for (const p of dbFiles.keys()) if (!set.has(p)) removed.push(p);
    for (const p of skipped.keys()) if (!set.has(p)) staleSkips.push(p);
  }
  timer.mark(`list (${listed.length} files)`);

  let unchanged = 0;
  const candidates: Candidate[] = [];
  const preSkipped: Prepared[] = [];
  for (const rel of listed) {
    // Symlinks are never followed: one pointing outside the repository would put the contents of an
    // arbitrary file (credentials, host files) into the index and its answers, and one pointing inside only
    // duplicates a file that is indexed under its own path. git lists symlinks as plain entries.
    const st = lstatSync(join(root, rel), { throwIfNoEntry: false });
    if (!st || !st.isFile()) {
      if (dbFiles.has(rel)) removed.push(rel);
      continue;
    }
    const mtime = Math.round(st.mtimeMs);
    const row = dbFiles.get(rel);
    if (row && row.size === st.size && row.mtime_ms === mtime) {
      unchanged++;
      continue;
    }
    const sk = skipped.get(rel);
    // skip markers stand until the file changes, except parse timeouts (load-dependent): those are retried
    if (!row && sk && sk.reason !== 'timeout' && sk.size === st.size && sk.mtime_ms === mtime) continue;
    if (st.size > cfg.maxFileBytes) {
      preSkipped.push({ kind: 'skip', rel, size: st.size, mtimeMs: st.mtimeMs, reason: 'large' });
      continue;
    }
    candidates.push({ rel, size: st.size, mtimeMs: st.mtimeMs });
  }
  const pyPackages = pythonPackages(listed, opts.paths ? [...dbFiles.keys()] : []);
  // Adding/removing an __init__.py renames the modules of files that did not change themselves.
  const pkgSig = sha1([...pyPackages].sort().join('\n'));
  if (!opts.paths && dbFiles.size && store.getMeta(META_PY_PACKAGES) !== pkgSig) {
    const queued = new Set(candidates.map((c) => c.rel));
    for (const r of store.db.prepare("SELECT path, namespace FROM files WHERE lang = 'python'").all() as Array<{ path: string; namespace: string | null }>) {
      if (queued.has(r.path) || pythonModule(r.path, pyPackages) === r.namespace) continue;
      const st = lstatSync(join(root, r.path), { throwIfNoEntry: false });
      if (st?.isFile()) {
        candidates.push({ rel: r.path, size: st.size, mtimeMs: st.mtimeMs, force: true });
        unchanged--;
      }
    }
  }
  let pending = 0;
  if (maxFiles !== undefined && maxFiles >= 0 && candidates.length > maxFiles) {
    // most recently modified first: that is what the agent is working on
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.rel < b.rel ? -1 : 1));
    pending = candidates.length - maxFiles;
    candidates.length = maxFiles;
  }
  timer.mark(`stat (${candidates.length} changed, ${removed.length} removed)`);
  return { pyPackages, pkgSig, listed, removed, staleSkips, candidates, preSkipped, unchanged, pending };
}

/** Parses candidates (workers on big runs) and writes them in batched transactions as results arrive. */
async function parseAndWrite(
  store: Store,
  opts: IndexOptions,
  p: Plan,
  dbFiles: Map<string, DbFile>,
  writer: Writer,
  tracker: WriteTracker,
  timer: Timer,
): Promise<{ sameContent: number }> {
  const { candidates } = p;
  let sameContent = 0;
  if (!candidates.length) return { sameContent };
  const cfg = opts.config;
  // Bulk mode (first build / mostly new content): drop secondary indexes and rebuild them once at the
  // end, which is much cheaper than maintaining them row by row. Not worth it on a big existing index.
  const existing = candidates.reduce((n, c) => n + (dbFiles.has(c.rel) ? 1 : 0), 0);
  const bulk = candidates.length >= BULK_MIN_FILES && existing <= 50 && candidates.length >= dbFiles.size - existing;
  const batchFiles = bulk ? BATCH_FILES_BULK : BATCH_FILES;
  const restoreIndexes = bulk ? dropSecondaryIndexes(store) : undefined;
  const preparer = createPreparer(candidates.length);
  const window = Math.max(1, preparer.window || 1);
  const total = candidates.length;
  const buffer: Prepared[] = [];
  let inflight = 0;
  let next = 0;
  let done = 0;
  let writeMs = 0;
  let wake: (() => void) | undefined;

  const flush = () => {
    if (!buffer.length) return;
    const items = buffer.splice(0);
    for (const it of items) if (it.kind === 'same') sameContent++;
    const t = Date.now();
    writer.writeBatch(items, dbFiles, tracker);
    writeMs += Date.now() - t;
    done += items.length;
    opts.onProgress?.(done, total);
    opts.onPhase?.({ phase: 'parse', done, total });
  };
  const launch = (c: Candidate) => {
    const job: PrepJob = {
      abs: join(cfg.root, c.rel),
      rel: c.rel,
      size: c.size,
      mtimeMs: c.mtimeMs,
      maxBytes: cfg.maxFileBytes,
      knownHash: c.force ? undefined : dbFiles.get(c.rel)?.hash,
    };
    if (c.rel.endsWith('.py') || c.rel.endsWith('.pyi')) job.pythonModule = pythonModule(c.rel, p.pyPackages);
    inflight++;
    preparer
      .run(job)
      .then(
        (r) => void buffer.push(r),
        () => void buffer.push({ kind: 'skip', rel: c.rel, size: c.size, mtimeMs: c.mtimeMs, reason: 'parse' }),
      )
      .finally(() => {
        inflight--;
        const w = wake;
        wake = undefined;
        w?.();
      });
  };

  opts.onPhase?.({ phase: 'parse', done: 0, total });
  try {
    while (next < total || inflight > 0) {
      while (next < total && inflight < window) launch(candidates[next++]);
      if (buffer.length < batchFiles && inflight > 0) await new Promise<void>((r) => (wake = r));
      if (buffer.length >= batchFiles) flush();
    }
    flush();
  } finally {
    await preparer.close();
    if (restoreIndexes) {
      opts.onPhase?.({ phase: 'index' });
      const t = Date.now();
      await restoreIndexes();
      if (DEBUG) process.stderr.write(`kopt index: rebuild indexes ${Date.now() - t}ms\n`);
    }
  }
  timer.mark(`parse+write (${tracker.filesIndexed} files, db writes ${writeMs}ms, bulk=${bulk})`);
  return { sameContent };
}

function lockedStats(t0: number): IndexStats {
  return { filesSeen: 0, filesIndexed: 0, filesUnchanged: 0, filesDeleted: 0, symbols: 0, refs: 0, durationMs: Date.now() - t0, locked: true };
}

async function runPass(store: Store, opts: IndexOptions, maxFiles?: number): Promise<IndexStats> {
  const t0 = Date.now();
  const cfg = opts.config;
  // An unreachable root would look like "every file was deleted" and wipe the index.
  if (!existsSync(cfg.root) || !statSync(cfg.root).isDirectory()) throw new Error(`kopt index: repo root not found: ${cfg.root}`);
  let lock: HeldLock | undefined;
  if (store.path !== ':memory:' && store.path !== '') {
    const path = `${store.path}.lock`;
    if (opts.lock === 'skip') {
      lock = tryLock(path);
      if (!lock) return lockedStats(t0);
    } else {
      lock = await acquireLock(path, { onBusy: (h) => opts.onPhase?.({ phase: 'wait', holder: h.pid }) });
    }
  }
  try {
    return await lockedPass(store, opts, maxFiles, t0);
  } finally {
    lock?.release();
  }
}

async function lockedPass(store: Store, opts: IndexOptions, maxFiles: number | undefined, t0: number): Promise<IndexStats> {
  const timer = new Timer();
  const cfg = opts.config;
  opts.onPhase?.({ phase: 'list' });
  store.db.exec(INDEXER_SQL);
  // another process (CLI vs MCP server) may hold the write lock for a batch: wait instead of failing
  const busy = (store.db.prepare('PRAGMA busy_timeout').get() as { timeout: number } | undefined)?.timeout ?? 0;
  if (busy < 10_000) store.db.exec('PRAGMA busy_timeout = 10000');
  const completed = !!store.getMeta(META.indexedAt);
  const wasDirty = store.getMeta(META_DIRTY) === '1';
  const dbFiles = loadDbFiles(store);
  const p = await plan(store, opts, dbFiles, maxFiles, timer);

  const anyChange = p.candidates.length > 0 || p.removed.length > 0 || p.preSkipped.length > 0;
  if (anyChange) store.setMeta(META_DIRTY, '1');
  // A big page cache matters a lot for index maintenance during bulk writes; restored after the pass.
  const prevCache = (store.db.prepare('PRAGMA cache_size').get() as { cache_size: number }).cache_size;
  store.db.exec(`PRAGMA cache_size = ${-Math.min(262144, Math.max(16384, p.candidates.length * 16))}`);
  const tracker = newTracker();
  let sameContent = 0;
  let rs: ResolveStats | undefined;
  let full = false;
  try {
    const writer = new Writer(store);
    writer.deleteFiles(p.removed, dbFiles, tracker);
    writer.forgetSkipped(p.staleSkips);
    writer.writeBatch(p.preSkipped, dbFiles, tracker);
    ({ sameContent } = await parseAndWrite(store, opts, p, dbFiles, writer, tracker, timer));
    writer.pruneRetired();

    // Resolution (+ ranks) only when something changed or a previous pass did not complete.
    const fileCount = dbFiles.size;
    const changedFiles = tracker.changedFileIds.size + tracker.removedFileIds.size;
    full = !completed || wasDirty || changedFiles > Math.max(500, fileCount * 0.2);
    if (full || changedFiles > 0) {
      opts.onPhase?.({ phase: 'resolve', done: 0 });
      rs = await resolveIndex(store, {
        onProgress: opts.onPhase ? (done, total) => opts.onPhase!({ phase: 'resolve', done, total }) : undefined,
        full,
        root: cfg.root,
        changedFileIds: tracker.changedFileIds,
        removedSymbolIds: tracker.removedSymbolIds,
        changedNames: tracker.changedNames,
        addedFileIds: tracker.addedFileIds,
        removedFileIds: tracker.removedFileIds,
        removedPaths: tracker.removedPaths,
      });
      timer.mark(`resolve (${rs.refsResolved}/${rs.refsConsidered} refs, full=${full})`);
      // Ranks are priors: recompute globally after big changes, let small edits accumulate otherwise.
      const stale = Number(store.getMeta(META_RANK_STALE) ?? '0') + changedFiles;
      if (full || fileCount <= 3000 || stale > fileCount * 0.05) {
        opts.onPhase?.({ phase: 'rank' });
        computeRanks(store);
        store.setMeta(META_RANK_STALE, '0');
        timer.mark('ranks');
      } else {
        store.setMeta(META_RANK_STALE, String(stale));
      }
    }
    if (full) {
      // fresh statistics for the retrieval queries, and give back the WAL space of a big build
      store.db.exec('PRAGMA optimize');
      store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    }
  } finally {
    store.db.exec(`PRAGMA cache_size = ${prevCache}`);
  }

  const commit = await gitHead(cfg.root);
  if (commit) store.setMeta(META.commit, commit);
  store.setMeta(META.toolVersion, getToolVersion());
  store.setMeta(META.indexedAt, String(Date.now()));
  // left-over renamed modules are picked up again next pass when this is not recorded yet
  if (!opts.paths && !p.pending) store.setMeta(META_PY_PACKAGES, p.pkgSig);
  store.setMeta(META_DIRTY, '0');

  const counts = store.counts();
  store.setMeta('symbol_count', String(counts.symbols));
  const stats: IndexStats = {
    filesSeen: p.listed.length,
    filesIndexed: tracker.filesIndexed,
    filesUnchanged: p.unchanged + sameContent,
    filesDeleted: tracker.filesDeleted,
    symbols: counts.symbols,
    refs: counts.refs,
    durationMs: Date.now() - t0,
    filesSkipped: tracker.filesSkipped,
  };
  if (commit) stats.commit = commit;
  if (p.pending) stats.filesPending = p.pending;
  if (rs) {
    stats.refsConsidered = rs.refsConsidered;
    stats.refsResolved = rs.refsResolved;
    stats.fullResolve = full;
  }
  return stats;
}
