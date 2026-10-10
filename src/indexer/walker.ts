// File listing: git ls-files when available (fast, honors .gitignore), else a recursive walk honoring
// nested .gitignore files. Then .kiroignore (root + nested + Kiro's global file) and config.exclude.

import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import type { KoptConfig } from '../core/config.js';
import { repoRelative, stripBom, toPosixPath } from '../telemetry/fsutil.js';
import { languageForPath } from './languages.js';

export interface ListResult {
  /** Repo-relative paths (forward slashes) of files with a supported language, after all ignore rules. */
  files: string[];
  /** True when the listing came from git. */
  git: boolean;
}

interface Scoped {
  /** Directory of the ignore file relative to the root ('' = root). */
  dir: string;
  ig: Ignore;
}

/** Lines of an ignore file (CRLF and a UTF-8 BOM tolerated: Windows editors write both). */
function readIgnore(abs: string): string[] | undefined {
  try {
    return stripBom(readFileSync(abs, 'utf8')).split(/\r?\n/);
  } catch {
    return undefined;
  }
}

/**
 * Kiro's user directory (`~/.kiro`, `%USERPROFILE%\.kiro`); KOPT_KIRO_HOME (tests, sandboxes) then Kiro's own
 * KIRO_HOME override it. Same rule as kiroHomeDir() in src/kiro/paths.ts.
 */
function kiroHome(): string {
  return process.env.KOPT_KIRO_HOME || process.env.KIRO_HOME || join(homedir(), '.kiro');
}

/** Kiro's global ignore file (`~/.kiro/settings/kiroignore`). */
export function globalKiroignorePath(): string {
  return join(kiroHome(), 'settings', 'kiroignore');
}

function loadIgnore(abs: string): Ignore | undefined {
  const lines = readIgnore(abs);
  return lines ? ignore().add(lines) : undefined;
}

export interface IgnoreRulesOptions {
  /** Compiled rules of an ignore file, undefined when it is missing (default: read and compile it). */
  load?: (abs: string) => Ignore | undefined;
  /** Rules that apply from the root, in place of `extra` + Kiro's global kiroignore. */
  base?: Ignore;
}

/** Applies ignore files from the root down; deeper files can re-include (`!pattern`) like git does. */
export class IgnoreRules {
  private readonly scoped: Scoped[] = [];
  private readonly load: (abs: string) => Ignore | undefined;

  /** The access checks (src/retrieval/access.ts) pass cached rules: they run on every file a tool quotes. */
  constructor(private readonly root: string, extra: string[] = [], opts: IgnoreRulesOptions = {}) {
    this.load = opts.load ?? loadIgnore;
    if (opts.base) {
      this.scoped.push({ dir: '', ig: opts.base });
      return;
    }
    const base = ignore();
    if (extra.length) base.add(extra);
    const global = readIgnore(globalKiroignorePath());
    if (global) base.add(global);
    this.scoped.push({ dir: '', ig: base });
  }

  /** Registers an ignore file located at `dir` (repo-relative, '' for root). */
  addFile(dir: string, file: string): void {
    const ig = this.load(join(this.root, dir, file));
    if (!ig) return;
    this.scoped.push({ dir, ig });
    this.scoped.sort((a, b) => a.dir.length - b.dir.length);
  }

  ignores(rel: string, isDir = false): boolean {
    let ignored = false;
    for (const { dir, ig } of this.scoped) {
      if (dir && !rel.startsWith(dir + '/')) continue;
      const sub = dir ? rel.slice(dir.length + 1) : rel;
      if (!sub) continue;
      const r = ig.test(isDir ? sub + '/' : sub);
      if (r.ignored) ignored = true;
      else if (r.unignored) ignored = false;
    }
    return ignored;
  }
}

function gitList(root: string): Promise<string[] | undefined> {
  return new Promise((resolveP) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=off', 'ls-files', '-co', '--exclude-standard', '-z'],
      { cwd: root, maxBuffer: 1 << 30, timeout: 60_000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolveP(undefined);
        resolveP(stdout.split('\0').filter(Boolean));
      },
    );
  });
}

/** Recursive walk honoring .gitignore files; prunes ignored directories early. */
function walk(root: string, rules: IgnoreRules): string[] {
  const out: string[] = [];
  const git = new IgnoreRules(root);
  const stack: string[] = [''];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.some((e) => e.name === '.gitignore' && e.isFile())) git.addFile(dir, '.gitignore');
    if (entries.some((e) => e.name === '.kiroignore' && e.isFile())) rules.addFile(dir, '.kiroignore');
    for (const e of entries) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name === '.git' || e.name === '.hg' || e.name === '.svn') continue;
        if (git.ignores(rel, true) || rules.ignores(rel, true)) continue;
        stack.push(rel);
      } else if (e.isFile()) {
        if (!git.ignores(rel)) out.push(rel);
      }
      // symlinks are skipped: they can point outside the repo or create cycles
    }
  }
  return out;
}

export async function listFiles(config: KoptConfig): Promise<ListResult> {
  const root = config.root;
  const rules = new IgnoreRules(root, config.exclude);
  // git also works from a subdirectory of a repository (paths come back relative to cwd)
  const listed = await gitList(root);
  let files: string[];
  let git = false;
  if (listed) {
    git = true;
    files = listed;
    for (const f of files) {
      if (f === '.kiroignore' || f.endsWith('/.kiroignore')) rules.addFile(posix.dirname(f) === '.' ? '' : posix.dirname(f), '.kiroignore');
    }
    if (!files.includes('.kiroignore') && existsSync(join(root, '.kiroignore'))) rules.addFile('', '.kiroignore');
  } else {
    if (existsSync(join(root, '.kiroignore'))) rules.addFile('', '.kiroignore');
    files = walk(root, rules);
  }
  const out: string[] = [];
  for (const f of files) {
    if (!languageForPath(f)) continue;
    if (rules.ignores(f)) continue;
    out.push(f);
  }
  out.sort();
  return { files: out, git };
}

/** Filters an explicit path list (incremental runs) through the same rules as a full listing. */
export function filterPaths(config: KoptConfig, paths: string[]): { keep: string[]; dropped: string[] } {
  const rules = new IgnoreRules(config.root, config.exclude);
  const dirs = new Set<string>(['']);
  for (const p of paths) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  for (const d of [...dirs].sort((a, b) => a.length - b.length)) {
    // .gitignore files use the same syntax; good enough for explicit paths (no git call per file)
    if (existsSync(join(config.root, d, '.gitignore'))) rules.addFile(d, '.gitignore');
    if (existsSync(join(config.root, d, '.kiroignore'))) rules.addFile(d, '.kiroignore');
  }
  const keep: string[] = [];
  const dropped: string[] = [];
  for (const p of paths) (languageForPath(p) && !rules.ignores(p) ? keep : dropped).push(p);
  return { keep, dropped };
}

/**
 * Normalizes a user/agent supplied path to repo-relative forward-slash form: either separator, Windows drive
 * letters in any case, `\\?\` long paths, macOS /private aliases. A path outside the root keeps its (cleaned)
 * spelling, which matches no indexed file.
 */
export function normalizeRel(root: string, p: string, platform: NodeJS.Platform = process.platform): string {
  const rel = repoRelative(root, p, platform);
  if (rel !== undefined) return rel;
  return posix.normalize(toPosixPath(p)).replace(/^\.\//, '').replace(/^\/+/, '');
}
