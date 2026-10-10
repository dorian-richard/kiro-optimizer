// "Did anything change in the workspace?" in a few milliseconds, without hashing file contents.
//
// Two parts:
//  - inputs: what a command reads and nothing it usually writes. git: HEAD + porcelain status (every untracked
//    file listed) + size/mtime of each dirty path; plus the ignored state that changes results without showing
//    in `git status`: env files (.env*), installed dependencies (node_modules markers, virtualenvs, vendor).
//    kopt_run takes it before and after a run and caches the result only when both match, so an edit made
//    while the command runs is never attached to the old output.
//  - outputs: ignored build output and generated dirs (target/, build/, dist/, obj/...) as their newest mtime
//    from a bounded scan, other ignored files, and the fetch state. A command may legitimately write these, so
//    they are not compared before/after; the cached result keeps the state after the run, and a rebuild from
//    the shell afterwards invalidates it.
// Not a git repo: bounded mtime/size scan for the inputs, the same ignored-dir rules for skipped dirs.

import { execFile, execFileSync } from 'node:child_process';
import { createHash, type Hash } from 'node:crypto';
import { readdirSync, realpathSync, statSync, type Dirent } from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';

const MAX_STATS = 20_000;
/** Ignored entries (`git status --ignored=matching`) examined; the rest are not tracked. */
const MAX_IGNORED = 2_000;
/** Entries stat'ed in total by the newest-mtime scans of ignored output dirs, and at most per dir. */
const OUTPUT_SCAN_BUDGET = 3_000;
const OUTPUT_SCAN_PER_DIR = 400;
const OUTPUT_SCAN_MIN_PER_DIR = 24;

/** Directories the non-git scan never descends into (each is classified like an ignored dir instead). */
const SCAN_SKIP = new Set([
  '.git', '.kopt', 'node_modules', 'vendor', 'dist', 'build', 'out', 'target', 'bin', 'obj', '.gradle', '.idea',
  '.vscode', '__pycache__', '.venv', 'venv', '.next', '.nuxt', 'coverage', '.pytest_cache', '.mypy_cache', '.tox',
  '.ruff_cache', '.cache', '.terraform',
]);

/** Ignored dirs that hold caches, editor state or logs: never part of a command's result. */
const NOISE_DIR_RE =
  /^(?:\.git|\.kopt|\.kiro|\.idea|\.vscode|\.vs|\.fleet|\.history|\.gradle|\.m2|\.ivy2|\.cache|\.npm|\.pnpm-store|\.yarn-cache|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.hypothesis|\.tox|\.nox|\.ipynb_checkpoints|\.terraform|\.terragrunt-cache|coverage|\.nyc_output|htmlcov|logs?|tmp|temp|\.tmp|\.temp|\.turbo|\.nx|\.parcel-cache|\.angular|\.sass-cache|\.swc|\.docusaurus|\.serverless|\.vercel|\.netlify|\.direnv|\.bsp|\.metals|\.bloop)$/i;
/** Ignored files that are editor/OS/tool noise. */
const NOISE_FILE_RE =
  /\.(?:log|pyc|pyo|swp|swo|swn|tmp|bak|orig|rej|pid|sock|lck)$|~$|^(?:\.DS_Store|Thumbs\.db|desktop\.ini|\.eslintcache|\.stylelintcache|\.coverage(?:\..*)?|\.python_history)$/i;
/**
 * Ignored files that a run reads: env files, local settings, and dependency manifests or lockfiles when a
 * project keeps them out of git (an install rewrites them).
 */
const ENV_FILE_RE =
  /^(?:\.env(?:\..+)?|.+\.env|\.envrc|\.flaskenv|local\.properties|local\.settings\.json|application-local\.(?:ya?ml|properties)|appsettings\.(?:Local|Development)\.json|\.npmrc|\.yarnrc(?:\.yml)?|\.pnpmfile\.cjs|settings\.xml|gradle\.properties|\.python-version|\.tool-versions|\.nvmrc|\.node-version|install-state\.gz|\.pnp\.c?js|\.pnp\.loader\.mjs|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|pdm\.lock|Pipfile\.lock|requirements[\w.-]*\.txt|Gemfile\.lock|composer\.lock|go\.sum|gradle\.lockfile|packages\.lock\.json|Podfile\.lock|pubspec\.lock|mix\.lock)$/i;
/** Installed-dependency dirs: the files their installers rewrite on every install. */
const DEP_MARKERS: Record<string, string[]> = {
  node_modules: ['.package-lock.json', '.yarn-integrity', '.modules.yaml', '.yarn-state.yml', '.pnpm', '.bin'],
  vendor: ['composer/installed.json', 'modules.txt', 'autoload.php', 'bundle'],
  '.bundle': ['config'],
  '.yarn': ['install-state.gz', 'unplugged'],
  bower_components: [],
  Pods: ['Manifest.lock'],
  '.dart_tool': ['package_config.json'],
  'elm-stuff': [],
  deps: [],
  '.pixi': [],
  '.conda': ['conda-meta'],
};

const GIT_OPTS = {
  timeout: 20_000,
  maxBuffer: 512 * 1024 * 1024,
  // Never take index.lock (would race with the user's own git commands / the IDE).
  env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  windowsHide: true,
};

function git(root: string, args: string[], encoding: 'utf8' | 'buffer' = 'utf8'): string | Buffer | undefined {
  try {
    return execFileSync('git', ['-C', root, ...args], { ...GIT_OPTS, encoding: encoding === 'utf8' ? 'utf8' : 'buffer', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return undefined;
  }
}

/** Same as git(), without blocking the event loop (`git status` takes seconds on a 50k-file checkout). */
function gitAsync(root: string, args: string[], encoding: 'utf8' | 'buffer' = 'utf8'): Promise<string | Buffer | undefined> {
  return new Promise((resolve) => {
    const child = execFile('git', ['-C', root, ...args], { ...GIT_OPTS, encoding: encoding === 'utf8' ? 'utf8' : 'buffer' }, (err, stdout) => {
      resolve(err ? undefined : (stdout as string | Buffer));
    });
    child.stdin?.end();
  });
}

type GitRun = (root: string, args: string[], encoding?: 'utf8' | 'buffer') => string | Buffer | undefined | Promise<string | Buffer | undefined>;

function statKey(abs: string): string {
  try {
    const s = statSync(abs);
    return `${s.size}:${Math.round(s.mtimeMs)}`;
  } catch {
    return '-';
  }
}

function mtimeOf(abs: string): number | undefined {
  try {
    return statSync(abs).mtimeMs;
  } catch {
    return undefined;
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

function unique(): string {
  return `${process.pid}:${Date.now()}:${Math.random()}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Ignored state

/** A virtualenv's site-packages dir (POSIX lib/pythonX.Y/site-packages, Windows Lib/site-packages). */
function sitePackages(venv: string): string[] {
  const out: string[] = [];
  for (const lib of ['lib', 'Lib', 'lib64']) {
    let names: string[];
    try {
      names = readdirSync(join(venv, lib));
    } catch {
      continue;
    }
    if (names.includes('site-packages')) out.push(join(venv, lib, 'site-packages'));
    for (const n of names.sort()) if (/^python\d/.test(n)) out.push(join(venv, lib, n, 'site-packages'));
  }
  return out;
}

type IgnoredKind = 'noise' | 'env' | 'deps' | 'output';

function classify(name: string, isDir: boolean, abs: string): IgnoredKind {
  if (isDir) {
    if (NOISE_DIR_RE.test(name)) return 'noise';
    if (name in DEP_MARKERS) return 'deps';
    // Any virtualenv, whatever its name (.venv, venv, env, .env, py311...).
    if (mtimeOf(join(abs, 'pyvenv.cfg')) !== undefined || mtimeOf(join(abs, 'conda-meta')) !== undefined) return 'deps';
    return 'output';
  }
  if (ENV_FILE_RE.test(name)) return 'env';
  if (NOISE_FILE_RE.test(name)) return 'noise';
  return 'output';
}

/** Install markers of a dependency dir: rewritten by npm/yarn/pnpm/pip/composer/bundler on every install. */
function depsKey(abs: string, name: string): string {
  const parts = [statKey(abs)];
  for (const m of DEP_MARKERS[name] ?? []) parts.push(`${m}=${statKey(join(abs, m))}`);
  if (!(name in DEP_MARKERS)) {
    parts.push(`pyvenv.cfg=${statKey(join(abs, 'pyvenv.cfg'))}`, `conda-meta=${statKey(join(abs, 'conda-meta'))}`);
    for (const sp of sitePackages(abs)) parts.push(`${relative(abs, sp).split(sep).join('/')}=${statKey(sp)}`);
  }
  return parts.join(',');
}

/**
 * Newest mtime and entry count of a directory tree, breadth first, at most `budget` entries (sorted, so the same
 * tree always visits the same entries). Build tools rewrite top-level outputs and markers (jars, bundles,
 * .tsbuildinfo, maven-status, .fingerprint) on every build, which a shallow scan sees.
 */
function newestMtime(dir: string, budget: number): { key: string; used: number } {
  let newest = mtimeOf(dir) ?? 0;
  let count = 0;
  const queue = [dir];
  while (queue.length && count < budget) {
    const d = queue.shift()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (count >= budget) break;
      count++;
      const abs = join(d, e.name);
      const m = mtimeOf(abs);
      if (m !== undefined && m > newest) newest = m;
      if (e.isDirectory()) queue.push(abs);
    }
  }
  return { key: `${Math.round(newest)}#${count}`, used: count };
}

interface Ignored {
  /** Path relative to the fingerprint base, forward slashes, no trailing slash. */
  rel: string;
  abs: string;
  isDir: boolean;
}

/** Hash the ignored entries into `inputs` (env files, dependencies) and `outputs` (everything else useful). */
function hashIgnored(entries: Ignored[], inputs: Hash, outputs: Hash): void {
  const outDirs: Ignored[] = [];
  let examined = 0;
  for (const e of entries) {
    if (examined++ >= MAX_IGNORED) break;
    const name = basename(e.abs);
    const kind = classify(name, e.isDir, e.abs);
    if (kind === 'noise') continue;
    if (kind === 'env') inputs.update(`env\0${e.rel}\0${statKey(e.abs)}\0`);
    else if (kind === 'deps') inputs.update(`deps\0${e.rel}\0${depsKey(e.abs, name)}\0`);
    else if (e.isDir) outDirs.push(e);
    else outputs.update(`file\0${e.rel}\0${statKey(e.abs)}\0`);
  }
  let budget = OUTPUT_SCAN_BUDGET;
  for (let i = 0; i < outDirs.length; i++) {
    const share = Math.min(OUTPUT_SCAN_PER_DIR, Math.max(OUTPUT_SCAN_MIN_PER_DIR, Math.floor(budget / (outDirs.length - i))));
    const r = newestMtime(outDirs[i].abs, Math.max(0, Math.min(share, budget)));
    budget -= r.used;
    outputs.update(`dir\0${outDirs[i].rel}\0${r.key}\0`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// git

const REV_PARSE = ['rev-parse', '--show-toplevel', '--absolute-git-dir', 'HEAD'];
// `--ignored=matching` lists an ignored dir once (`!! node_modules/`), never its content.
const STATUS = ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'];

/** Both git calls of a fingerprint, through a sync or an async runner. */
function gitState(root: string, run: GitRun): { info?: string; status?: Buffer; top?: string } | Promise<{ info?: string; status?: Buffer; top?: string }> {
  const step2 = (info: string | undefined): { info?: string; status?: Buffer; top?: string } | Promise<{ info?: string; status?: Buffer; top?: string }> => {
    if (info === undefined) return {};
    const top = info.trim().split(/\r?\n/)[0];
    if (!top) return { info };
    const st = run(top, STATUS, 'buffer');
    return st instanceof Promise ? st.then((status) => ({ info, top, status: status as Buffer | undefined })) : { info, top, status: st as Buffer | undefined };
  };
  const step1 = (info: string | undefined) => {
    // Unborn HEAD (no commit yet) makes the HEAD argument fail.
    if (info !== undefined) return step2(info);
    const again = run(root, REV_PARSE.slice(0, -1));
    return again instanceof Promise ? again.then((i) => step2(i as string | undefined)) : step2(again as string | undefined);
  };
  const first = run(root, REV_PARSE);
  return first instanceof Promise ? first.then((i) => step1(i as string | undefined)) : step1(first as string | undefined);
}

function gitFingerprint(root: string, inputs: Hash, outputs: Hash, exclude: string[], state: { info?: string; status?: Buffer }): boolean {
  const info = state.info;
  if (info === undefined) return false;
  const [top, gitDir, head = 'unborn'] = info.trim().split(/\r?\n/);
  if (!top) return false;
  inputs.update(`git\0${head}\0`);
  for (const f of ['FETCH_HEAD', 'packed-refs']) outputs.update(`${f}=${statKey(join(gitDir, f))}\0`);
  const status = state.status;
  if (status === undefined) return false;
  const prefixes = exclude.map((e) => toPrefix(top, root, e)).filter((p): p is string => !!p);
  const parts = status.toString('utf8').split('\0');
  const ignored: Ignored[] = [];
  let stats = 0;
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    // -z rename/copy entries carry the original path as the next field
    if (xy[0] === 'R' || xy[0] === 'C') i++;
    if (prefixes.some((p) => path.startsWith(p) || `${path.replace(/\/$/, '')}/` === p)) continue;
    if (xy === '!!') {
      const isDir = path.endsWith('/');
      const rel = path.replace(/\/$/, '');
      ignored.push({ rel, abs: join(top, rel), isDir });
      continue;
    }
    inputs.update(`${entry}\0`);
    if (stats++ < MAX_STATS) inputs.update(`${statKey(join(top, path))}\0`);
  }
  // Too many dirty paths to stat: content changes could go unnoticed, so make this state unmatchable.
  if (stats > MAX_STATS) inputs.update(unique());
  hashIgnored(ignored, inputs, outputs);
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// No git: bounded scan

function scanFingerprint(root: string, inputs: Hash, outputs: Hash, exclude: string[]): void {
  inputs.update('scan\0');
  const skipAbs = new Set(exclude.map((e) => (isAbsolute(e) ? e : join(root, e))));
  const special: Ignored[] = [];
  let budget = MAX_STATS;
  const walk = (dir: string) => {
    if (budget <= 0) return;
    let entries: Dirent[];
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
        if (skipAbs.has(abs)) continue;
        if (SCAN_SKIP.has(e.name)) {
          special.push({ rel: relative(root, abs).split(sep).join('/'), abs, isDir: true });
          continue;
        }
        walk(abs);
      } else if (e.isFile()) {
        inputs.update(`${relative(root, abs).split(sep).join('/')}\0${statKey(abs)}\0`);
      }
    }
  };
  walk(root);
  // Scan truncated: later files are unchecked, so never claim "nothing changed".
  if (budget <= 0) inputs.update(unique());
  hashIgnored(special, inputs, outputs);
}

// ---------------------------------------------------------------------------------------------------------------

export interface FingerprintParts {
  /** Files a command reads: compared before/after a run (an edit during the run means "do not cache"). */
  inputs: string;
  /** Ignored outputs and repository metadata: part of the cache key, not compared before/after. */
  outputs: string;
  /** The cache key: both parts. */
  key: string;
}

/**
 * Fingerprint of the workspace state relevant to "same command, nothing changed". `exclude` = directories
 * (absolute, or relative to root) whose changes are ignored; kopt's own data dir by default.
 */
function finish(root: string, exclude: string[], state: { info?: string; status?: Buffer }): FingerprintParts {
  const inputs = createHash('sha1');
  const outputs = createHash('sha1');
  if (!gitFingerprint(root, inputs, outputs, exclude, state)) {
    // a half-written hash state would be wrong: start over for the scan
    const si = createHash('sha1');
    const so = createHash('sha1');
    scanFingerprint(root, si, so, exclude);
    return digest(si, so);
  }
  return digest(inputs, outputs);
}

function digest(inputs: Hash, outputs: Hash): FingerprintParts {
  const i = inputs.digest('hex');
  const o = outputs.digest('hex');
  return { inputs: i, outputs: o, key: createHash('sha1').update(`${i}\0${o}`).digest('hex') };
}

export function fingerprintParts(root: string, exclude: string[] = [join(root, '.kopt')]): FingerprintParts {
  return finish(root, exclude, gitState(root, git) as { info?: string; status?: Buffer });
}

/** fingerprintParts() with git run asynchronously: the MCP server keeps answering other calls meanwhile. */
export async function fingerprintPartsAsync(root: string, exclude: string[] = [join(root, '.kopt')]): Promise<FingerprintParts> {
  return finish(root, exclude, await gitState(root, gitAsync));
}

export function workspaceFingerprint(root: string, exclude: string[] = [join(root, '.kopt')]): string {
  return fingerprintParts(root, exclude).key;
}
