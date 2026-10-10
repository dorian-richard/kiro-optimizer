// Per-Kiro-session governor state: <userDir>/sessions/<session_id>.json.
// Each hook is a separate short-lived process, so state is a small JSON file updated under a lock
// (Kiro may run hooks for parallel tool calls concurrently) and written atomically (temp + rename).

import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite, withFileLock } from '../telemetry/fsutil.js';

export interface RunRecord {
  at: number;
  /** writeSeq when the command last ran: equal to the current writeSeq means "nothing written since". */
  writeSeq: number;
  /** writeSeq at which a duplicate was already blocked once (allow the retry to avoid deadlocks). */
  dupBlockedAt?: number;
  /** promptSeq when it ran: a new user prompt ("run it again") always lets the next identical run through. */
  promptSeq?: number;
  /** Workspace fingerprint taken right after the run (PostToolUse); see fingerprint.ts. */
  fp?: string;
}

export interface SessionState {
  v: 1;
  id: string;
  startedAt: number;
  updatedAt: number;
  /** All tool calls seen by PreToolUse in this session. */
  toolCalls: number;
  /** toolCalls value when the budget window was (re)armed; re-armed by the next user prompt after a stop. */
  budgetFrom: number;
  /** Blocks per reason: budget | big-read | verbose-cmd | duplicate-run. */
  blocks: Record<string, number>;
  /** Files whose whole-file read was denied once (path -> count). */
  deniedReads: Record<string, number>;
  /** Commands redirected to kopt_run once (key -> count). */
  redirected: Record<string, number>;
  /** Last run of each test/build command (key -> record). */
  runs: Record<string, RunRecord>;
  /** Incremented on every observed file write. */
  writeSeq: number;
  lastWriteCall: number;
  lastWriteAt: number;
  /** Symbol handles already front-loaded by UserPromptSubmit (not re-sent in the same session). */
  frontSent: string[];
  /** Incremented on every user prompt. */
  promptSeq: number;
}

const MAX_MAP_ENTRIES = 300;
const PRUNE_AGE_MS = 7 * 24 * 3600_000;

export function sessionsDir(userDir: string): string {
  return join(userDir, 'sessions');
}

/** Session ids come from Kiro; keep file names safe. */
export function sessionFile(userDir: string, sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 128) || 'default';
  return join(sessionsDir(userDir), `${safe}.json`);
}

export function newSession(id: string, now = Date.now()): SessionState {
  return {
    v: 1, id, startedAt: now, updatedAt: now, toolCalls: 0, budgetFrom: 0, blocks: {}, deniedReads: {}, redirected: {},
    runs: {}, writeSeq: 0, lastWriteCall: 0, lastWriteAt: 0, frontSent: [], promptSeq: 0,
  };
}

export function loadSession(userDir: string, id: string): SessionState {
  const file = sessionFile(userDir, id);
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (raw && raw.v === 1 && typeof raw.toolCalls === 'number') {
      const base = newSession(id, raw.startedAt ?? Date.now());
      return { ...base, ...raw, blocks: raw.blocks ?? {}, deniedReads: raw.deniedReads ?? {}, redirected: raw.redirected ?? {}, runs: raw.runs ?? {},
        frontSent: Array.isArray(raw.frontSent) ? raw.frontSent : [], promptSeq: typeof raw.promptSeq === 'number' ? raw.promptSeq : 0 };
    }
  } catch {
    // missing or corrupt: start fresh
  }
  return newSession(id);
}

function capMap<T>(m: Record<string, T>, score: (v: T) => number): Record<string, T> {
  const keys = Object.keys(m);
  if (keys.length <= MAX_MAP_ENTRIES) return m;
  const kept = keys.sort((a, b) => score(m[b]) - score(m[a])).slice(0, MAX_MAP_ENTRIES);
  return Object.fromEntries(kept.map((k) => [k, m[k]]));
}

export function saveSession(userDir: string, s: SessionState): void {
  s.updatedAt = Date.now();
  s.runs = capMap(s.runs, (r) => r.at);
  s.deniedReads = capMap(s.deniedReads, (n) => n);
  s.redirected = capMap(s.redirected, (n) => n);
  if (s.frontSent.length > MAX_MAP_ENTRIES) s.frontSent = s.frontSent.slice(-MAX_MAP_ENTRIES);
  atomicWrite(sessionFile(userDir, s.id), JSON.stringify(s));
}

/**
 * Run `fn` holding the session lock. Gives up after `timeoutMs` and runs unlocked: losing one
 * counter update beats stalling the user's tool call.
 */
export function withSessionLock<T>(userDir: string, id: string, fn: () => T, timeoutMs = 150): T {
  return withFileLock(sessionFile(userDir, id) + '.lock', fn, { timeoutMs, staleMs: 2000, runUnlocked: true }) as T;
}

/** Delete session files not touched for 7 days. Cheap (one readdir); called on SessionStart. */
export function pruneSessions(userDir: string, now = Date.now()): number {
  const dir = sessionsDir(userDir);
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    try {
      const st = statSync(p);
      const tmpOrLock = name.endsWith('.tmp') || name.endsWith('.lock');
      if (now - st.mtimeMs > (tmpOrLock ? 3600_000 : PRUNE_AGE_MS)) {
        unlinkSync(p);
        n++;
      }
    } catch { /* concurrent delete */ }
  }
  return n;
}
