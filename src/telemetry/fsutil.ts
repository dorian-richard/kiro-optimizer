// Small synchronous file and path helpers shared by hooks, telemetry, compress, indexer and retrieval
// (short-lived processes, no daemons). Everything here must behave the same on Linux, macOS and Windows.

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { rename as renameAsync } from 'node:fs/promises';
import { dirname, posix } from 'node:path';

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
export function sleepMs(ms: number): void {
  Atomics.wait(sleepBuf, 0, 0, ms);
}

// ---------------------------------------------------------------------------------------------------------------
// Text

/** Drops a leading UTF-8 byte order mark (Notepad, PowerShell 5 `Out-File -Encoding utf8` and others write one). */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** UTF-8 text of a file without a BOM. Throws like readFileSync. */
export function readTextFile(path: string): string {
  return stripBom(readFileSync(path, 'utf8'));
}

// ---------------------------------------------------------------------------------------------------------------
// Paths

/** Default filesystems on Windows (NTFS) and macOS (APFS) are case-insensitive. */
export function caseInsensitiveFs(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

/** Backslashes -> forward slashes (DB paths, model-facing locations). */
export function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/** `file:///C:/x`, `\\?\C:\x`, `C:\x` -> `C:/x`; POSIX paths keep their leading slash. */
function cleanAbsolute(p: string): string {
  let s = toPosixPath(p.trim());
  if (/^file:\/\//i.test(s)) {
    s = s.replace(/^file:\/\/(?:localhost)?/i, '');
    try {
      s = decodeURIComponent(s);
    } catch {
      /* keep as is */
    }
    if (/^\/[A-Za-z]:\//.test(s)) s = s.slice(1);
  }
  if (s.startsWith('//?/UNC/')) s = '//' + s.slice(8);
  else if (s.startsWith('//?/') || s.startsWith('//./')) s = s.slice(4);
  return s;
}

function isAbsoluteAny(s: string, platform: NodeJS.Platform): boolean {
  if (s.startsWith('/')) return true;
  return platform === 'win32' && /^[A-Za-z]:(?:\/|$)/.test(s);
}

/** macOS: /var, /tmp and /etc are symlinks to /private/...; git and realpath report the /private form. */
function rootAliases(root: string, platform: NodeJS.Platform): string[] {
  const out = [root];
  if (platform === 'darwin') {
    if (/^\/private\/(?:var|tmp|etc)(?:\/|$)/.test(root)) out.push(root.slice('/private'.length));
    else if (/^\/(?:var|tmp|etc)(?:\/|$)/.test(root)) out.push('/private' + root);
  }
  return out;
}

/**
 * Repo-relative, forward-slash form of `p` (absolute or relative, any separator, `file://` URL or `\\?\` long
 * path), or undefined when it points outside `root`. Matching is case-insensitive where the filesystem is
 * (Windows, macOS); the returned relative part keeps the caller's spelling. `''` means the root itself.
 */
export function repoRelative(root: string, p: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const s = cleanAbsolute(p);
  const rel = (x: string): string | undefined => {
    const n = posix.normalize(x || '.').replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
    if (n === '.' || n === '') return '';
    if (n === '..' || n.startsWith('../')) return undefined;
    return n;
  };
  if (!isAbsoluteAny(s, platform)) return rel(s);
  const ci = caseInsensitiveFs(platform);
  const cmp = (x: string) => (ci ? x.toLowerCase() : x);
  const target = cmp(s);
  for (const alias of rootAliases(cleanAbsolute(root).replace(/(.)\/+$/, '$1'), platform)) {
    const r = cmp(alias);
    if (target === r) return '';
    const prefix = r.endsWith('/') ? r : r + '/';
    if (target.startsWith(prefix)) return rel(s.slice(prefix.length));
  }
  return undefined;
}

/** Same file location (separators, case on case-insensitive filesystems, trailing slashes). */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const n = (x: string) => {
    const s = cleanAbsolute(x).replace(/(.)\/+$/, '$1');
    return caseInsensitiveFs(platform) ? s.toLowerCase() : s;
  };
  return n(a) === n(b);
}

// ---------------------------------------------------------------------------------------------------------------
// Renames and locks

/**
 * Windows answers EPERM / EACCES / EBUSY while another process (an editor, the indexer, antivirus, Windows
 * Search) holds the target or the source open: those clear within milliseconds, so retry with backoff there.
 * On POSIX these codes are permanent and are thrown at once.
 */
const TRANSIENT_WIN = new Set(['EPERM', 'EACCES', 'EBUSY']);

export interface RetryOptions {
  /** Give up after this long (default 2000 ms). */
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  /** Injected for tests. */
  rename?: (from: string, to: string) => void;
}

function transient(err: unknown, platform: NodeJS.Platform): boolean {
  return platform === 'win32' && TRANSIENT_WIN.has(String((err as NodeJS.ErrnoException)?.code));
}

/**
 * renameSync that survives transient Windows sharing violations. Never use it to replace an SQLite database
 * that another connection may have open: Windows refuses that for as long as the database stays open.
 */
export function renameWithRetry(from: string, to: string, opts: RetryOptions = {}): void {
  const platform = opts.platform ?? process.platform;
  const doRename = opts.rename ?? renameSync;
  const deadline = Date.now() + (opts.timeoutMs ?? 2000);
  let delay = 5;
  for (;;) {
    try {
      doRename(from, to);
      return;
    } catch (err) {
      if (!transient(err, platform) || Date.now() >= deadline) throw err;
      sleepMs(delay);
      delay = Math.min(delay * 2, 100);
    }
  }
}

/** Async variant of renameWithRetry (does not block the event loop while waiting). */
export async function renameWithRetryAsync(
  from: string,
  to: string,
  opts: Omit<RetryOptions, 'rename'> & { rename?: (from: string, to: string) => Promise<void> } = {},
): Promise<void> {
  const platform = opts.platform ?? process.platform;
  const doRename = opts.rename ?? renameAsync;
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  let delay = 10;
  for (;;) {
    try {
      await doRename(from, to);
      return;
    } catch (err) {
      if (!transient(err, platform) || Date.now() >= deadline) throw err;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 250);
    }
  }
}

/** Lock contention: the file exists, or (Windows) it is being deleted by its previous owner. */
function lockBusy(err: unknown): boolean {
  const code = String((err as NodeJS.ErrnoException)?.code);
  return code === 'EEXIST' || (process.platform === 'win32' && TRANSIENT_WIN.has(code));
}

/**
 * Run `fn` holding an O_EXCL lock file. Locks older than `staleMs` are broken. When the lock
 * cannot be taken within `timeoutMs`: run unlocked if `runUnlocked`, else return undefined.
 */
export function withFileLock<T>(lockPath: string, fn: () => T, opts: { timeoutMs?: number; staleMs?: number; runUnlocked?: boolean } = {}): T | undefined {
  const { timeoutMs = 150, staleMs = 2000, runUnlocked = true } = opts;
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = openSync(lockPath, 'wx');
    } catch (err) {
      if (!lockBusy(err)) break;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs) { unlinkSync(lockPath); continue; }
      } catch { /* owner released it meanwhile */ }
      if (Date.now() > deadline) break;
      sleepMs(3);
    }
  }
  if (fd === undefined && !runUnlocked) return undefined;
  try {
    return fn();
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
      try { unlinkSync(lockPath); } catch { /* ignore */ }
    }
  }
}

/** Write to a temp file next to `path`, then rename over it (retrying transient Windows sharing violations). */
export function atomicWrite(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, data);
  try {
    renameWithRetry(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/** Parsed JSON object of a file (BOM tolerated), or `fallback` when missing, invalid or not an object. */
export function readJson<T>(path: string, fallback: T): T {
  try {
    const v = JSON.parse(readTextFile(path));
    return v && typeof v === 'object' ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}
