// Cross-process lock around indexing passes: `<index.db>.lock`.
//
// Several processes can index one project: the MCP server of a Kiro IDE window, the one of a Kiro CLI session on
// the same folder, `kopt index` typed by the user, the background refresh a SessionStart hook starts. Two passes
// at once parse the same files twice and the second one fails on `UNIQUE constraint failed: files.path`, leaving
// the index marked dirty (a full re-resolution next time). One pass at a time, whatever the process.
//
// The lock file holds {pid, host, token, at} and its mtime is refreshed while the pass runs. It is stale (taken
// over) when its process is gone (same host) or when it was not refreshed for STALE_MS: a holder that crashed, a
// worker thread that was terminated, or a lock left on a disk shared with another machine.

import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, utimesSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** A holder that has not refreshed the lock for this long is presumed dead (long synchronous SQLite steps included). */
export const STALE_MS = 120_000;
const HEARTBEAT_MS = 10_000;

export interface LockInfo {
  pid: number;
  host: string;
  token: string;
  at: number;
}

export interface HeldLock {
  readonly path: string;
  release(): void;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The current holder, or undefined when the lock is free or stale. */
export function lockHolder(path: string, now = Date.now()): LockInfo | undefined {
  let info: LockInfo;
  let mtime: number;
  try {
    mtime = statSync(path).mtimeMs;
    info = JSON.parse(readFileSync(path, 'utf8')) as LockInfo;
  } catch {
    // missing, or being written right now (empty / partial JSON): a fresh file is a live holder
    try {
      return now - statSync(path).mtimeMs < 5_000 ? { pid: 0, host: '', token: '', at: now } : undefined;
    } catch {
      return undefined;
    }
  }
  if (now - mtime > STALE_MS) return undefined;
  if (info.host === hostname() && typeof info.pid === 'number' && info.pid > 0 && !alive(info.pid)) return undefined;
  return info;
}

function tryCreate(path: string): HeldLock | undefined {
  let fd: number;
  try {
    fd = openSync(path, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
    throw err;
  }
  const info: LockInfo = { pid: process.pid, host: hostname(), token: randomUUID(), at: Date.now() };
  try {
    writeSync(fd, JSON.stringify(info));
  } finally {
    closeSync(fd);
  }
  const beat = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(path, now, now);
    } catch {
      // removed by someone who judged it stale: nothing to do, the pass finishes anyway
    }
  }, HEARTBEAT_MS);
  beat.unref?.();
  let released = false;
  return {
    path,
    release() {
      if (released) return;
      released = true;
      clearInterval(beat);
      try {
        // only our own lock: a stale-lock takeover may have replaced it
        const cur = JSON.parse(readFileSync(path, 'utf8')) as LockInfo;
        if (cur.token === info.token) unlinkSync(path);
      } catch {
        // already gone
      }
    },
  };
}

/** Takes the lock if it is free (removing a stale one); undefined when another live process holds it. */
export function tryLock(path: string): HeldLock | undefined {
  mkdirSync(dirname(path), { recursive: true });
  const got = tryCreate(path);
  if (got) return got;
  if (lockHolder(path)) return undefined;
  try {
    unlinkSync(path);
  } catch {
    // someone else removed it first
  }
  return tryCreate(path);
}

export interface LockWait {
  /** Give up after this long (default: wait as long as the holder lives). */
  timeoutMs?: number;
  /** Called once when the lock is busy, with its holder. */
  onBusy?: (holder: LockInfo) => void;
  pollMs?: number;
}

/** Waits for the lock; undefined on timeout. */
export async function acquireLock(path: string, o: LockWait = {}): Promise<HeldLock | undefined> {
  const deadline = o.timeoutMs === undefined ? Infinity : Date.now() + o.timeoutMs;
  let told = false;
  for (;;) {
    const got = tryLock(path);
    if (got) return got;
    if (!told) {
      told = true;
      const h = lockHolder(path);
      if (h) o.onBusy?.(h);
    }
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, Math.min(o.pollMs ?? 500, Math.max(1, deadline - Date.now()))));
  }
}
