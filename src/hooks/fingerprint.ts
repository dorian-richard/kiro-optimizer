// Workspace state for the governor's duplicate-run rule: "the same test/build command, and nothing changed since it
// last ran". Agent writes are seen by the hooks (writeSeq), but edits made in a shell, by the user in their editor,
// by `git checkout` / `git stash` or by a formatter are not: so the rule also compares this fingerprint, taken right
// after the previous run, with the current one.
//
// git checkouts only (HEAD + `git status --porcelain` with every untracked file + size/mtime of each dirty path),
// bounded in time: a hook must answer within Kiro's timeout, so a slow `git status` (huge monorepo without
// fsmonitor) yields undefined and the rule falls back to writeSeq alone. Gitignored files (dependencies, .env, build
// outputs) are not covered; the governor also treats any non-read-only shell command as a possible write.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

/** Default time budget of one fingerprint (two git processes). */
export const FINGERPRINT_TIMEOUT_MS = 1500;
const MAX_STATS = 5000;

function git(root: string, args: string[], timeoutMs: number): Buffer | undefined {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      // never take index.lock (would race with the user's own git commands and the IDE)
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      windowsHide: true,
    });
  } catch {
    return undefined;
  }
}

function real(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

/**
 * Fingerprint of a git workspace, or undefined (not a git checkout, git missing, too slow, too many changes).
 * `exclude`: absolute folders whose changes do not count (kopt's own data and session folders when they sit inside
 * the repository).
 */
export function governorFingerprint(root: string, exclude: string[] = [], timeoutMs = FINGERPRINT_TIMEOUT_MS): string | undefined {
  const t0 = Date.now();
  const head = git(root, ['rev-parse', '--show-toplevel', 'HEAD'], timeoutMs)?.toString('utf8') ?? git(root, ['rev-parse', '--show-toplevel'], timeoutMs)?.toString('utf8');
  if (head === undefined) return undefined;
  const [top, rev = 'unborn'] = head.trim().split(/\r?\n/);
  if (!top) return undefined;
  const left = timeoutMs - (Date.now() - t0);
  if (left <= 50) return undefined;
  const status = git(top, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], left);
  if (status === undefined) return undefined;
  const realTop = real(top);
  const prefixes = exclude
    .map((d) => relative(realTop, real(d)))
    .filter((r) => r && !r.startsWith('..') && !isAbsolute(r))
    .map((r) => r.split(sep).join('/') + '/');
  const h = createHash('sha1').update(`${rev}\0`);
  const parts = status.toString('utf8').split('\0');
  let stats = 0;
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    // -z rename/copy entries carry the original path as the next field
    if (xy[0] === 'R' || xy[0] === 'C') i++;
    if (prefixes.some((p) => entry.slice(3).startsWith(p))) continue;
    h.update(`${entry}\0`);
    if (++stats > MAX_STATS) return undefined;
    try {
      const st = statSync(join(top, entry.slice(3)));
      h.update(`${st.size}:${Math.round(st.mtimeMs)}\0`);
    } catch {
      h.update('-\0');
    }
  }
  return h.digest('hex');
}
