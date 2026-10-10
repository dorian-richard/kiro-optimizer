import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, posix, resolve, win32 } from 'node:path';
import { readTextFile, samePath } from '../telemetry/fsutil.js';
import { setCharsPerToken } from './tokens.js';

export interface Budgets {
  /** kopt_find in `hits` mode. */
  find: number;
  /** kopt_find in `pack` mode (task-level context pack). */
  pack: number;
  /** kopt_read of a range, or of anything when the call passes maxTokens. */
  read: number;
  /**
   * kopt_read of a named function or method (#handle, Class.method, path:line inside it) without maxTokens: the
   * whole body up to this size in one call (a skeleton card would cost the agent a second call).
   */
  readSymbol: number;
  /** kopt_read of a file or a type (class, struct...) without maxTokens: verbatim up to this size, else a skeleton. */
  readFile: number;
  outline: number;
  refs: number;
  run: number;
  expand: number;
  /**
   * UserPromptSubmit prompt pointers (#handles for the prompt), in tokens. 0 (the default) disables them: on the
   * 175 bench questions they fired on 55% of the prompts (~126 tokens each, re-billed on every later request) and
   * only 21% of the pointers named an expected symbol (3 of 9 fired prompts on the agent A/B tasks); the agent's
   * first kopt_find gives the same pointers, ranked for its own query.
   */
  frontload: number;
}

export interface KoptConfig {
  /** Absolute repo root. */
  root: string;
  /**
   * Per-repo data dir (index, command logs). Default: an OS cache dir keyed by the root
   * (`cacheRoot()/<name>-<hash8>`), so nothing is written into the repository; `<root>/.kopt` when that
   * directory already exists (per-project mode); `KOPT_DATA_DIR` or a config file override both.
   */
  dataDir: string;
  /** Per-user dir (telemetry, session state). Default `~/.kopt`. */
  userDir: string;
  /** Glob patterns (gitignore syntax) excluded from indexing in addition to .gitignore/.kiroignore. */
  exclude: string[];
  maxFileBytes: number;
  budgets: Budgets;
  dedup: {
    enabled: boolean;
    /** A symbol body already returned within this many tool calls is not re-sent. */
    windowCalls: number;
    windowMinutes: number;
  };
  governor: {
    /** Hard stop (exit 2) after this many tool calls in one Kiro session. 0 disables. */
    maxToolCallsPerSession: number;
    /**
     * Whole-file reads: a read with no range, or a range wider than this many lines, counts as whole. 0 disables the
     * big-read rule.
     */
    bigFileLines: number;
    /**
     * Deny (once per file) a whole-file read of a file estimated above this many tokens, pointing to its outline or
     * a line range. A block costs one model request, so only files whose resident cost clearly exceeds it are
     * blocked. 0 disables the big-read rule.
     */
    bigFileTokens: number;
    /** Deny (once per command) test/build shell commands with predictably long output and point to kopt_run. */
    enforceRunForVerbose: boolean;
    /** Deny re-running an identical test/build command when no file changed since. */
    blockDuplicateRuns: boolean;
  };
  telemetry: {
    /** Local usage log under <userDir>/telemetry (read by `kopt stats`); it never leaves the machine. */
    enabled: boolean;
  };
  charsPerToken: number;
  /** Kiro integration. */
  kiro?: {
    /**
     * Kiro IDE 0.x only loads hooks from `<workspace>/.kiro/hooks/*.kiro.hook`. `auto` (default): the MCP server
     * writes kopt's legacy hook files into a workspace when the installed IDE is 0.x. Env: KOPT_LEGACY_WORKSPACE_HOOKS.
     */
    legacyWorkspaceHooks?: 'auto' | 'on' | 'off';
  };
}

export const DEFAULT_EXCLUDES = [
  'node_modules/', 'vendor/', 'dist/', 'build/', 'out/', 'target/', 'bin/', 'obj/', '.git/', '.kopt/',
  '.gradle/', '.idea/', '.vscode/', '__pycache__/', '.venv/', 'venv/', '.next/', '.nuxt/', 'coverage/',
  '*.min.js', '*.min.css', '*.map', '*.lock', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
  '*.generated.*', '*.g.cs', '*.designer.cs', '*_pb2.py', '*.pb.go',
];

export interface PlatformEnv {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/** `path` flavour of a (possibly simulated) platform. */
export function pathFor(platform: NodeJS.Platform = process.platform): typeof posix {
  return platform === 'win32' ? win32 : posix;
}

/**
 * Base directory of kopt's per-repo caches, outside every repository:
 * macOS `~/Library/Caches/kopt`, Linux `$XDG_CACHE_HOME/kopt` (default `~/.cache/kopt`),
 * Windows `%LOCALAPPDATA%\kopt`. `KOPT_CACHE_DIR` overrides it.
 */
export function cacheRoot(o: PlatformEnv = {}): string {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const home = o.home ?? homedir();
  const p = pathFor(platform);
  if (env.KOPT_CACHE_DIR) return p.resolve(env.KOPT_CACHE_DIR);
  if (platform === 'darwin') return p.join(home, 'Library', 'Caches', 'kopt');
  if (platform === 'win32') return p.join(env.LOCALAPPDATA || p.join(home, 'AppData', 'Local'), 'kopt');
  return p.join(env.XDG_CACHE_HOME || p.join(home, '.cache'), 'kopt');
}

/** Per-user dir (telemetry, governor sessions, install manifest): `KOPT_HOME`, else `~/.kopt` (`%USERPROFILE%\.kopt`). */
export function userDirFor(o: PlatformEnv = {}): string {
  const env = o.env ?? process.env;
  return env.KOPT_HOME || pathFor(o.platform).join(o.home ?? homedir(), '.kopt');
}

function realpathOr(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

/**
 * Stable cache key of a repo root: `<name>-<sha1(path)[:8]>`. The path is canonicalized (symlinks resolved,
 * case-folded on Windows) so the MCP server, the hooks and the CLI agree whatever spelling they were given.
 */
export function repoCacheKey(root: string, platform: NodeJS.Platform = process.platform): string {
  let canonical = realpathOr(root);
  if (platform === 'win32') canonical = canonical.replace(/\//g, '\\').toLowerCase();
  const hash = createHash('sha1').update(canonical).digest('hex').slice(0, 8);
  const name = pathFor(platform).basename(canonical).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40) || 'root';
  return `${name}-${hash}`;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Default data dir of a repo (see `KoptConfig.dataDir`). */
export function defaultDataDir(root: string): string {
  const absRoot = resolve(root);
  const fromEnv = process.env.KOPT_DATA_DIR;
  if (fromEnv) return isAbsolute(fromEnv) ? fromEnv : resolve(absRoot, fromEnv);
  const local = join(absRoot, '.kopt');
  // ~/.kopt is the user dir, never a project's data dir.
  if (!isUnsafeRoot(absRoot) && isDir(local)) return local;
  return join(cacheRoot(), repoCacheKey(absRoot));
}

/** Home dir or filesystem root: never treated as a project (nothing is indexed there). */
export function isUnsafeRoot(root: string, home: string = homedir()): boolean {
  const abs = resolve(root);
  if (abs === parse(abs).root) return true;
  // compare canonical paths: a cwd is reported through symlinks resolved (/private/var vs /var on macOS), and
  // case-insensitively where the filesystem is (c:\users\me vs C:\Users\me on Windows)
  return samePath(abs, resolve(home)) || samePath(realpathOr(abs), realpathOr(resolve(home)));
}

/**
 * Project root of a directory: the nearest ancestor holding `.git` or a per-project `.kopt/index.db`, else the
 * directory itself. Used alike by the CLI, the hooks and the MCP server so they all key the same index.
 */
export function findProjectRoot(start: string, home: string = homedir()): string {
  const begin = resolve(start);
  const homeAbs = resolve(home);
  const homeReal = realpathOr(homeAbs);
  let dir = begin;
  for (;;) {
    // never climb into the home dir (a dotfiles repo there is not the user's project)
    if (dir !== begin && (dir === homeAbs || dir === homeReal)) return begin;
    if (existsSync(join(dir, '.git'))) return dir;
    if (dir !== homeAbs && dir !== homeReal && existsSync(join(dir, '.kopt', 'index.db'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return begin;
    dir = parent;
  }
}

/** True when the repo keeps its data in `<root>/.kopt` (per-project mode) rather than in the user cache. */
export function usesProjectDataDir(cfg: Pick<KoptConfig, 'root' | 'dataDir'>): boolean {
  return resolve(cfg.dataDir) === join(resolve(cfg.root), '.kopt');
}

export function defaultConfig(root: string): KoptConfig {
  const absRoot = resolve(root);
  return {
    root: absRoot,
    dataDir: defaultDataDir(absRoot),
    userDir: userDirFor(),
    exclude: [...DEFAULT_EXCLUDES],
    maxFileBytes: 1_000_000,
    budgets: { find: 700, pack: 2500, read: 3000, readSymbol: 6000, readFile: 4000, outline: 1200, refs: 900, run: 900, expand: 1500, frontload: 0 },
    dedup: { enabled: true, windowCalls: 40, windowMinutes: 30 },
    governor: {
      maxToolCallsPerSession: 200,
      bigFileLines: 800,
      bigFileTokens: 8000,
      enforceRunForVerbose: true,
      blockDuplicateRuns: true,
    },
    telemetry: { enabled: true },
    charsPerToken: 3.0,
  };
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function merge<T>(base: T, over: DeepPartial<T> | undefined): T {
  if (!over) return base;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    const b = (base as any)[k];
    out[k] = b && typeof b === 'object' && !Array.isArray(b) && v && typeof v === 'object' && !Array.isArray(v)
      ? merge(b, v as any)
      : v;
  }
  return out;
}

export interface LoadConfigOptions {
  /**
   * Where warnings go (an invalid config file is skipped with a warning). Default: stderr. Hooks pass a sink that
   * writes to <userDir>/hook-errors.log: any output on a hook's allow path intercepts the tool call in Kiro.
   */
  onWarning?: (message: string) => void;
}

/**
 * Load config: defaults < ~/.kopt/config.json < <dataDir>/config.json < <root>/kopt.config.json < env.
 * A relative `dataDir` in a config file is resolved against the repo root.
 */
export function loadConfig(root: string = process.cwd(), opts: LoadConfigOptions = {}): KoptConfig {
  const warn = opts.onWarning ?? ((m: string) => process.stderr.write(m + '\n'));
  let cfg = defaultConfig(root);
  const candidates = [join(cfg.userDir, 'config.json'), join(cfg.dataDir, 'config.json'), join(cfg.root, 'kopt.config.json')];
  for (const file of [...new Set(candidates)]) {
    if (!existsSync(file)) continue;
    try {
      const over = JSON.parse(readTextFile(file));
      if (over && typeof over.dataDir === 'string' && !process.env.KOPT_DATA_DIR) over.dataDir = resolve(cfg.root, over.dataDir);
      else if (over && 'dataDir' in over) delete over.dataDir;
      cfg = merge(cfg, over);
    } catch (err) {
      warn(`kopt: ignoring invalid config ${file}: ${(err as Error).message}`);
    }
  }
  // the environment wins over the config files (a kopt.config.json committed in a repository cannot move the
  // per-user dir away from KOPT_HOME); KOPT_TELEMETRY=0 turns the local usage log off, =1 forces it on
  if (process.env.KOPT_HOME) cfg.userDir = process.env.KOPT_HOME;
  if (process.env.KOPT_TELEMETRY === '0') cfg.telemetry.enabled = false;
  else if (process.env.KOPT_TELEMETRY === '1') cfg.telemetry.enabled = true;
  const legacy = process.env.KOPT_LEGACY_WORKSPACE_HOOKS?.toLowerCase();
  if (legacy) {
    const mode = ['1', 'on', 'true', 'yes'].includes(legacy) ? 'on' : ['0', 'off', 'false', 'no'].includes(legacy) ? 'off' : 'auto';
    cfg.kiro = { ...cfg.kiro, legacyWorkspaceHooks: mode };
  }
  setCharsPerToken(cfg.charsPerToken);
  return cfg;
}

export function indexPath(cfg: KoptConfig): string {
  return join(cfg.dataDir, 'index.db');
}
