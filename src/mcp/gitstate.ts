// A few stat() calls that change whenever git changes the working tree: checkout, pull, merge, reset, commit,
// stash, add. The MCP server compares this stamp every 30 s and runs the full freshness check (git ls-files of
// tracked and untracked files + a stat of every indexed file: seconds on a 50k-file repository) only when it
// changed, or every couple of minutes for edits made outside both git and Kiro's agent.

import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export interface GitDirs {
  /** Per-worktree git dir (HEAD, index). */
  gitDir: string;
  /** Shared dir of linked worktrees (refs, packed-refs); same as gitDir otherwise. */
  commonDir: string;
}

/** The git dirs of the repository holding `root` (a linked worktree's `.git` file is followed), or undefined. */
export function findGitDirs(root: string): GitDirs | undefined {
  let dir = resolve(root);
  for (let i = 0; i < 64; i++) {
    const dotGit = join(dir, '.git');
    try {
      const st = statSync(dotGit);
      if (st.isDirectory()) return { gitDir: dotGit, commonDir: dotGit };
      if (st.isFile()) {
        const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
        if (!m) return undefined;
        const gitDir = isAbsolute(m[1]) ? m[1] : resolve(dir, m[1]);
        let commonDir = gitDir;
        try {
          const c = readFileSync(join(gitDir, 'commondir'), 'utf8').trim();
          if (c) commonDir = isAbsolute(c) ? c : resolve(gitDir, c);
        } catch {
          // not a linked worktree
        }
        return { gitDir, commonDir };
      }
    } catch {
      // no .git here
    }
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
  return undefined;
}

function stamp(path: string): string {
  try {
    const s = statSync(path);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return '-';
  }
}

/** Changes when HEAD moves (commit, checkout, pull, reset) or the git index is rewritten (add, merge, stash). */
export function gitStateStamp(dirs: GitDirs | undefined): string {
  if (!dirs) return '';
  let head = '';
  try {
    head = readFileSync(join(dirs.gitDir, 'HEAD'), 'utf8').trim();
  } catch {
    return '';
  }
  const parts = [head, stamp(join(dirs.gitDir, 'index')), stamp(join(dirs.commonDir, 'packed-refs'))];
  const ref = /^ref:\s*(\S+)$/.exec(head)?.[1];
  if (ref && !ref.includes('..')) parts.push(stamp(join(dirs.commonDir, ref)), stamp(join(dirs.gitDir, ref)));
  return parts.join('|');
}
