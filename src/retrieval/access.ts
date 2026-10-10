// What kopt_read / kopt_outline (and every tool that quotes source lines: find pack bodies, refs code lines, the
// source hints of a failing kopt_run) may serve from disk. The read-only tools are auto-approved, so a path is
// refused when it leaves the project (`..`, absolute elsewhere, a symlink pointing out), lies inside `.git`, or is
// excluded by .gitignore / .git/info/exclude / the user's global git excludes (core.excludesFile) / .kiroignore
// (nested files, the .gitignore files of a parent repository when the project is a subfolder of one, and Kiro's
// global kiroignore included): an agent cannot read through kopt what git and Kiro keep out of the project. loadSource() (source.ts) applies this check to every file
// it reads, so no caller can skip it.

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { IgnoreRules, globalKiroignorePath } from '../indexer/walker.js';
import { findGitDirs } from '../mcp/gitstate.js';
import { stripBom } from '../telemetry/fsutil.js';

const realpath = realpathSync.native;
const realRoots = new Map<string, string>();

function realRoot(root: string): string {
  let r = realRoots.get(root);
  if (r === undefined) {
    try {
      r = realpath(root);
    } catch {
      r = resolve(root);
    }
    realRoots.set(root, r);
  }
  return r;
}

/**
 * Repo-relative form of the real location of `rel` (symlinks resolved; on Windows also the real case, long names
 * and no trailing dots), `null` when it lies outside the root, undefined when it does not exist.
 */
function realRel(root: string, rel: string): string | null | undefined {
  let real: string;
  try {
    real = realpath(join(root, rel));
  } catch {
    return undefined;
  }
  const rr = realRoot(root);
  // Windows paths compare without case (a drive letter or folder may come back in another case)
  const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  if (fold(real) === fold(rr)) return '';
  if (!fold(real).startsWith(fold(rr.endsWith(sep) ? rr : rr + sep))) return null;
  return relative(rr, real).split(sep).join('/');
}

// ---------------------------------------------------------------------------------------------
// Ignore rules (cached: the check runs on every file a tool quotes)

/** Compiled ignore files, by absolute path; re-read when their size or times change. */
const ignoreFiles = new Map<string, { stamp: string; ig: Ignore | undefined }>();
const MAX_IGNORE_FILES = 4096;
const NONE = ignore();

function cachedIgnore(abs: string): Ignore | undefined {
  let stamp: string;
  try {
    // most folders have no ignore file: no exception for those (this runs for every level of every path)
    const st = statSync(abs, { throwIfNoEntry: false });
    if (!st?.isFile()) return undefined;
    stamp = `${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
  } catch {
    return undefined;
  }
  const hit = ignoreFiles.get(abs);
  if (hit && hit.stamp === stamp) return hit.ig;
  let ig: Ignore | undefined;
  try {
    ig = ignore().add(stripBom(readFileSync(abs, 'utf8')).split(/\r?\n/));
  } catch {
    ig = undefined;
  }
  if (ignoreFiles.size >= MAX_IGNORE_FILES) ignoreFiles.clear();
  ignoreFiles.set(abs, { stamp, ig });
  return ig;
}

interface GitLayout {
  /** Work tree top (holds `.git`): the root itself or a parent of it. */
  top: string;
  /** The root relative to `top` ('' when the root is the top), forward slashes. */
  prefix: string;
  /** `info/exclude` of the repository (the shared git dir of a linked worktree). */
  exclude: string;
  /** The user's excludes file (globalExcludesFile). */
  userExclude: string;
}

/**
 * The excludes file git reads for the work tree `top` besides the .gitignore files and info/exclude:
 * `core.excludesFile` (global or repository config, `~` expanded by git), else `$XDG_CONFIG_HOME/git/ignore`, else
 * `~/.config/git/ignore`. A usual place for `.envrc`, `*.pem` and other files kept out of every repository.
 */
export function globalExcludesFile(top: string, env: NodeJS.ProcessEnv = process.env): string {
  let configured = '';
  try {
    configured = execFileSync('git', ['config', '--path', '--get', 'core.excludesFile'], {
      cwd: top,
      env,
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
  } catch {
    // not set (exit 1), or no git: the default location
  }
  if (configured) return isAbsolute(configured) ? configured : resolve(top, configured);
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'git', 'ignore');
  return join(env.HOME || homedir(), '.config', 'git', 'ignore');
}

const layouts = new Map<string, { at: number; layout: GitLayout | undefined }>();
const LAYOUT_TTL_MS = 30_000;

/** Where git's rules for `root` come from: the enclosing work tree, when there is one. */
function gitLayout(root: string): GitLayout | undefined {
  const hit = layouts.get(root);
  if (hit && Date.now() - hit.at < LAYOUT_TTL_MS) return hit.layout;
  let layout: GitLayout | undefined;
  let dir = resolve(root);
  for (let i = 0; i < 64; i++) {
    let found = false;
    try {
      found = !!statSync(join(dir, '.git'), { throwIfNoEntry: false });
    } catch {
      // unreadable: not a work tree we can use
    }
    if (found) {
      const dirs = findGitDirs(dir);
      const prefix = relative(dir, resolve(root)).split(sep).join('/');
      layout = { top: dir, prefix, exclude: join(dirs?.commonDir ?? join(dir, '.git'), 'info', 'exclude'), userExclude: globalExcludesFile(dir) };
      break;
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  layouts.set(root, { at: Date.now(), layout });
  return layout;
}

/** Applies the ignore files found from the rules' root down to the folder of `rel`. */
function rulesFor(rel: string, isDir: boolean, file: string, rules: IgnoreRules): boolean {
  const parts = rel.split('/');
  const depth = isDir ? parts.length : parts.length - 1;
  for (let i = 0; i <= depth; i++) rules.addFile(parts.slice(0, i).join('/'), file);
  return rules.ignores(rel, isDir);
}

/**
 * Ignore rules that apply to `rel`: Kiro's global kiroignore and every .kiroignore from the root down (a match in any
 * of them excludes); git's rules from the work tree top (the root, or a parent repository) down to its folder, by
 * increasing precedence: the user's excludes file, info/exclude, then every .gitignore (nothing re-includes a file
 * inside an excluded folder). (The `exclude` setting only keeps noise out of the index.)
 */
function ignored(root: string, rel: string, isDir: boolean): boolean {
  const kiro = new IgnoreRules(root, [], { load: cachedIgnore, base: cachedIgnore(globalKiroignorePath()) ?? NONE, semantics: 'kiro' });
  if (rulesFor(rel, isDir, '.kiroignore', kiro)) return true;
  const g = gitLayout(root);
  const top = g?.top ?? root;
  const gitRel = g?.prefix ? `${g.prefix}/${rel}` : rel;
  const base: Ignore[] = [];
  for (const file of [g?.userExclude, g?.exclude ?? join(root, '.git', 'info', 'exclude')]) {
    const ig = file ? cachedIgnore(file) : undefined;
    if (ig) base.push(ig);
  }
  return rulesFor(gitRel, isDir, '.gitignore', new IgnoreRules(top, [], { load: cachedIgnore, base }));
}

/** The reasons that only depend on how `rel` is spelled and on the ignore files. */
function ruleReason(root: string, rel: string, isDir: boolean): string | undefined {
  // `.GIT/config` is `.git/config` on a case-insensitive file system (macOS, Windows).
  if (rel.split('/').some((p) => p.toLowerCase() === '.git')) return 'inside .git';
  if (ignored(root, rel, isDir)) return 'excluded by .gitignore or .kiroignore';
  return undefined;
}

/**
 * Why the repo-relative path `rel` may not be served, as a short phrase, or undefined when it may.
 * `rel` is the normalized form (forward slashes, no leading `./`). Both the path as written and the real location
 * it opens are checked: a symlink inside the project that points at `.env` or into `.git` is refused like its
 * target, and so are the spellings Windows maps to an ignored file (`debug.log.`, `DEBUG~1.LOG`, `id_rsa::$DATA`).
 */
export function denyReason(root: string | undefined, rel: string, isDir = false): string | undefined {
  if (!root || !rel) return undefined;
  rel = rel.replace(/\/+$/, '');
  if (!rel) return undefined;
  if (isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.split('/').includes('..')) return 'outside the project';
  // An NTFS stream name (`file::$DATA`, `file:alt`) opens the file it is attached to.
  if (process.platform === 'win32' && rel.includes(':')) return 'outside the project';
  const asWritten = ruleReason(root, rel, isDir);
  if (asWritten) return asWritten;
  const real = realRel(root, rel);
  if (real === null) return 'a link that leaves the project';
  if (real && real !== rel) return ruleReason(root, real, isDir);
  if (process.platform === 'win32') {
    // Windows drops trailing dots and spaces of every name: `debug.log.` opens debug.log.
    const trimmed = rel
      .split('/')
      .map((p) => p.replace(/[. ]+$/, '') || p)
      .join('/');
    if (trimmed !== rel) return ruleReason(root, trimmed, isDir);
  }
  return undefined;
}

/** One-line refusal shown to the agent. */
export function deniedMessage(rel: string, reason: string): string {
  return `${rel}: not readable through kopt (${reason})`;
}
