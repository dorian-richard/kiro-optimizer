// "Did anything change in the workspace?" in a few milliseconds, without hashing file contents.
// git: HEAD + porcelain status (every untracked file listed) + size/mtime of each dirty path + fetch state.
// Not a git repo: bounded mtime/size scan.

import { execFileSync } from 'node:child_process';
import { createHash, type Hash } from 'node:crypto';
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

const MAX_STATS = 20_000;
const SCAN_SKIP = new Set([
  '.git', '.kopt', 'node_modules', 'vendor', 'dist', 'build', 'out', 'target', 'bin', 'obj', '.gradle', '.idea',
  '.vscode', '__pycache__', '.venv', 'venv', '.next', '.nuxt', 'coverage', '.pytest_cache', '.mypy_cache', '.tox',
  '.ruff_cache', '.cache', '.terraform',
]);

function git(root: string, args: string[], encoding: 'utf8' | 'buffer' = 'utf8'): string | Buffer | undefined {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: encoding === 'utf8' ? 'utf8' : 'buffer',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 20_000,
      maxBuffer: 512 * 1024 * 1024,
      // Never take index.lock (would race with the user's own git commands / the IDE).
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      windowsHide: true,
    });
  } catch {
    return undefined;
  }
}

function statKey(abs: string): string {
  try {
    const s = statSync(abs);
    return `${s.size}:${Math.round(s.mtimeMs)}`;
  } catch {
    return '-';
  }
}

/** Canonical path as git reports it: macOS /var -> /private/var; Windows 8.3 short names and case expanded. */
function real(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  }
}

/** Exclude dir -> path prefix relative to the git toplevel (git reports realpaths, e.g. /private/var on macOS). */
function toPrefix(top: string, root: string, p: string): string | undefined {
  const abs = isAbsolute(p) ? p : join(root, p);
  const underRoot = relative(root, abs);
  const rel = (!underRoot.startsWith('..') && !isAbsolute(underRoot) ? join(relative(top, real(root)), underRoot) : relative(top, real(abs)))
    .split(sep)
    .join('/');
  return rel && !rel.startsWith('..') ? `${rel.replace(/\/$/, '')}/` : undefined;
}

function gitFingerprint(root: string, h: Hash, exclude: string[]): boolean {
  let info = git(root, ['rev-parse', '--show-toplevel', '--absolute-git-dir', 'HEAD']) as string | undefined;
  // Unborn HEAD (no commit yet) makes the HEAD argument fail.
  if (info === undefined) info = git(root, ['rev-parse', '--show-toplevel', '--absolute-git-dir']) as string | undefined;
  if (info === undefined) return false;
  const [top, gitDir, head = 'unborn'] = info.trim().split(/\r?\n/);
  if (!top) return false;
  h.update(`git\0${head}\0`);
  for (const f of ['FETCH_HEAD', 'packed-refs']) h.update(`${f}=${statKey(join(gitDir, f))}\0`);
  const status = git(top, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], 'buffer') as Buffer | undefined;
  if (status === undefined) return false;
  const prefixes = exclude.map((e) => toPrefix(top, root, e)).filter((p): p is string => !!p);
  const parts = status.toString('utf8').split('\0');
  let stats = 0;
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    // -z rename/copy entries carry the original path as the next field
    if (xy[0] === 'R' || xy[0] === 'C') i++;
    if (prefixes.some((p) => path.startsWith(p))) continue;
    h.update(`${entry}\0`);
    if (stats++ < MAX_STATS) h.update(`${statKey(join(top, path))}\0`);
  }
  // Too many dirty paths to stat: content changes could go unnoticed, so make this state unmatchable.
  if (stats > MAX_STATS) h.update(unique());
  return true;
}

function scanFingerprint(root: string, h: Hash, exclude: string[]): void {
  h.update('scan\0');
  const skipAbs = new Set(exclude.map((e) => (isAbsolute(e) ? e : join(root, e))));
  let budget = MAX_STATS;
  const walk = (dir: string) => {
    if (budget <= 0) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (budget-- <= 0) return;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (SCAN_SKIP.has(e.name) || skipAbs.has(abs)) continue;
        walk(abs);
      } else if (e.isFile()) {
        h.update(`${relative(root, abs).split(sep).join('/')}\0${statKey(abs)}\0`);
      }
    }
  };
  walk(root);
  // Scan truncated: later files are unchecked, so never claim "nothing changed".
  if (budget <= 0) h.update(unique());
}

function unique(): string {
  return `${process.pid}:${Date.now()}:${Math.random()}`;
}

/**
 * Fingerprint of the workspace state relevant to "same command, nothing changed". `exclude` = directories
 * (absolute, or relative to root) whose changes are ignored; kopt's own data dir by default.
 */
export function workspaceFingerprint(root: string, exclude: string[] = [join(root, '.kopt')]): string {
  const h = createHash('sha1');
  if (!gitFingerprint(root, h, exclude)) scanFingerprint(root, h, exclude);
  return h.digest('hex');
}
