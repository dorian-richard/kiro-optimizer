// What kopt_read / kopt_outline may serve from disk. The read-only tools are auto-approved, so a path is refused
// when it leaves the project (`..`, absolute elsewhere, a symlink pointing out), lies inside `.git`, or is
// excluded by .gitignore / .kiroignore (nested files and Kiro's global kiroignore included): an agent cannot read
// through kopt what git and Kiro keep out of the project.

import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';
import { IgnoreRules } from '../indexer/walker.js';

const realRoots = new Map<string, string>();

function realRoot(root: string): string {
  let r = realRoots.get(root);
  if (r === undefined) {
    try {
      r = realpathSync(root);
    } catch {
      r = root;
    }
    realRoots.set(root, r);
  }
  return r;
}

/** True when the real location of `abs` (symlinks resolved) is the root or below it. Missing files pass. */
export function staysInside(root: string, abs: string): boolean {
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return true;
  }
  const rr = realRoot(root);
  return real === rr || real.startsWith(rr.endsWith(sep) ? rr : rr + sep);
}

/**
 * Ignore rules that apply to `rel`: Kiro's global kiroignore, .git/info/exclude, and every .gitignore and
 * .kiroignore from the root down to its folder. (The `exclude` setting only keeps noise out of the index.)
 */
function ignored(root: string, rel: string, isDir: boolean): boolean {
  const rules = new IgnoreRules(root);
  let info: string[] = [];
  try {
    info = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8').split(/\r?\n/);
  } catch {
    info = [];
  }
  const git = new IgnoreRules(root, info);
  const parts = rel.split('/');
  const depth = isDir ? parts.length : parts.length - 1;
  for (let i = 0; i <= depth; i++) {
    const dir = parts.slice(0, i).join('/');
    git.addFile(dir, '.gitignore');
    rules.addFile(dir, '.kiroignore');
  }
  return git.ignores(rel, isDir) || rules.ignores(rel, isDir);
}

/**
 * Why the repo-relative path `rel` may not be served, as a short phrase, or undefined when it may.
 * `rel` is the normalized form (forward slashes, no leading `./`).
 */
export function denyReason(root: string | undefined, rel: string, isDir = false): string | undefined {
  if (!root || !rel) return undefined;
  if (isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.split('/').includes('..')) return 'outside the project';
  if (rel.split('/').some((p) => p === '.git')) return 'inside .git';
  if (!staysInside(root, join(root, rel))) return 'a link that leaves the project';
  if (ignored(root, rel, isDir)) return 'excluded by .gitignore or .kiroignore';
  return undefined;
}

/** One-line refusal shown to the agent. */
export function deniedMessage(rel: string, reason: string): string {
  return `${rel}: not readable through kopt (${reason})`;
}
