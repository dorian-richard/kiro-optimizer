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
  /** Rules that apply from the root, lowest precedence first, in place of `extra` + Kiro's global kiroignore. */
  base?: Ignore | Ignore[];
  /** How the ignore files combine (default 'git'): see IgnoreRules. */
  semantics?: 'git' | 'kiro';
}

type TestResult = { ignored: boolean; unignored: boolean };
type RuleSet = { test(path: string, checkUnignored: boolean, mode: string): TestResult };

const ruleSet = (ig: Ignore) => (ig as unknown as { _rules?: RuleSet })._rules;

/**
 * `ignore` 7 tests one path without its parent folders on its rule set (`ignore().test()` applies the parent folders
 * first). Probed once: a release without it (or with another signature) makes testOne use the public test.
 */
const ONE_PATH = (() => {
  try {
    const rules = ruleSet(ignore().add(['a/', 'b']));
    return rules?.test('a/c', true, 'regex')?.ignored === false && rules.test('b', true, 'regex')?.ignored === true;
  } catch {
    return false;
  }
})();

/**
 * One path against the rules of one ignore file, without the file's verdict on the parent folders: the folders are
 * checked on their own, across all the files that apply. Without the single-path test, the public test can only
 * exclude more (a folder a deeper file re-includes stays excluded).
 */
function testOne(ig: Ignore, path: string): TestResult {
  return ONE_PATH ? ruleSet(ig)!.test(path, true, 'regex') : ig.test(path);
}

/** Whether the single-path test of `ignore` is used (checked by the tests: an upgrade must not lose it silently). */
export function ignoreTestsOnePath(): boolean {
  return ONE_PATH;
}

/**
 * Applies ignore files from the root down.
 * - 'git': like git, the deepest file with a matching pattern decides, so a deeper file can re-include (`!pattern`)
 *   what a shallower one excludes; but no file can re-include anything inside an excluded folder (folders are
 *   checked from the top down, the first excluded one decides).
 * - 'kiro': like Kiro, each ignore file is its own evaluator and a match in any of them excludes: a nested
 *   `.kiroignore` cannot re-include what the root one or the global kiroignore excludes.
 */
export class IgnoreRules {
  private readonly scoped: Scoped[] = [];
  private readonly load: (abs: string) => Ignore | undefined;
  private readonly kiro: boolean;
  /** Folders already checked ('git'), cleared when an ignore file is added. */
  private readonly folders = new Map<string, boolean>();

  /** The access checks (src/retrieval/access.ts) pass cached rules: they run on every file a tool quotes. */
  constructor(private readonly root: string, extra: string[] = [], opts: IgnoreRulesOptions = {}) {
    this.load = opts.load ?? loadIgnore;
    this.kiro = opts.semantics === 'kiro';
    if (opts.base) {
      for (const ig of Array.isArray(opts.base) ? opts.base : [opts.base]) this.scoped.push({ dir: '', ig });
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
    this.folders.clear();
  }

  ignores(rel: string, isDir = false): boolean {
    if (this.kiro) {
      for (const { dir, ig } of this.scoped) {
        const sub = within(dir, rel);
        if (sub && ig.ignores(isDir ? sub + '/' : sub)) return true;
      }
      return false;
    }
    for (let at = rel.indexOf('/'); at > 0; at = rel.indexOf('/', at + 1)) {
      const folder = rel.slice(0, at);
      let excluded = this.folders.get(folder);
      if (excluded === undefined) {
        excluded = this.decide(folder, true);
        this.folders.set(folder, excluded);
      }
      if (excluded) return true;
    }
    return this.decide(rel, isDir);
  }

  /** git: the deepest ignore file with a pattern matching `rel` itself decides (its last matching pattern). */
  private decide(rel: string, isDir: boolean): boolean {
    for (let i = this.scoped.length - 1; i >= 0; i--) {
      const { dir, ig } = this.scoped[i];
      const sub = within(dir, rel);
      if (!sub) continue;
      const r = testOne(ig, isDir ? sub + '/' : sub);
      if (r.ignored) return true;
      if (r.unignored) return false;
    }
    return false;
  }
}

/** `rel` relative to the folder `dir` of an ignore file, undefined when that file does not apply to it. */
function within(dir: string, rel: string): string | undefined {
  if (!dir) return rel || undefined;
  return rel.startsWith(dir + '/') && rel.length > dir.length + 1 ? rel.slice(dir.length + 1) : undefined;
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
  const git = new IgnoreRules(root, [], { base: [] });
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
  const rules = new IgnoreRules(root, config.exclude, { semantics: 'kiro' });
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
  const git = new IgnoreRules(config.root, [], { base: [] });
  const kiro = new IgnoreRules(config.root, config.exclude, { semantics: 'kiro' });
  const dirs = new Set<string>(['']);
  for (const p of paths) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  for (const d of [...dirs].sort((a, b) => a.length - b.length)) {
    // the .gitignore files of the folders on the way (no git call per file)
    if (existsSync(join(config.root, d, '.gitignore'))) git.addFile(d, '.gitignore');
    if (existsSync(join(config.root, d, '.kiroignore'))) kiro.addFile(d, '.kiroignore');
  }
  const keep: string[] = [];
  const dropped: string[] = [];
  for (const p of paths) (languageForPath(p) && !git.ignores(p) && !kiro.ignores(p) ? keep : dropped).push(p);
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
