import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setCharsPerToken } from './tokens.js';

export interface Budgets {
  /** kopt_find in `hits` mode. */
  find: number;
  /** kopt_find in `pack` mode (task-level context pack). */
  pack: number;
  read: number;
  outline: number;
  refs: number;
  run: number;
  expand: number;
  /** UserPromptSubmit front-load (pointers only). 0 disables. */
  frontload: number;
}

export interface KoptConfig {
  /** Absolute repo root. */
  root: string;
  /** Per-repo data dir (index, outputs). Default `<root>/.kopt`. */
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
    /** Deny whole-file reads (no offset/limit) of files above this many lines. 0 disables. */
    bigFileLines: number;
    /** Deny verbose test/build shell commands and point to kopt_run. */
    enforceRunForVerbose: boolean;
    /** Deny re-running an identical test/build command when no file changed since. */
    blockDuplicateRuns: boolean;
  };
  telemetry: {
    enabled: boolean;
    /** Central ingestion endpoint (POST JSON lines). */
    endpoint?: string;
    /** Name of the env var holding the bearer token for the endpoint. */
    tokenEnv: string;
  };
  central: {
    /** Remote MCP URL (Streamable HTTP) when the team uses the centralized server. */
    mcpUrl?: string;
    /** URL template to download a repo snapshot: `{repo}` and `{commit}` placeholders. */
    snapshotUrl?: string;
    /** Logical repo name used centrally (defaults to the git remote name). */
    repoName?: string;
  };
  charsPerToken: number;
}

export const DEFAULT_EXCLUDES = [
  'node_modules/', 'vendor/', 'dist/', 'build/', 'out/', 'target/', 'bin/', 'obj/', '.git/', '.kopt/',
  '.gradle/', '.idea/', '.vscode/', '__pycache__/', '.venv/', 'venv/', '.next/', '.nuxt/', 'coverage/',
  '*.min.js', '*.min.css', '*.map', '*.lock', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
  '*.generated.*', '*.g.cs', '*.designer.cs', '*_pb2.py', '*.pb.go',
];

export function defaultConfig(root: string): KoptConfig {
  const absRoot = resolve(root);
  return {
    root: absRoot,
    dataDir: join(absRoot, '.kopt'),
    userDir: process.env.KOPT_HOME || join(homedir(), '.kopt'),
    exclude: [...DEFAULT_EXCLUDES],
    maxFileBytes: 1_000_000,
    budgets: { find: 700, pack: 2500, read: 2000, outline: 1200, refs: 900, run: 900, expand: 1500, frontload: 350 },
    dedup: { enabled: true, windowCalls: 40, windowMinutes: 30 },
    governor: {
      maxToolCallsPerSession: 200,
      bigFileLines: 800,
      enforceRunForVerbose: true,
      blockDuplicateRuns: true,
    },
    telemetry: { enabled: true, tokenEnv: 'KOPT_TOKEN' },
    central: {},
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

/**
 * Load config: defaults < ~/.kopt/config.json < <root>/.kopt/config.json < <root>/kopt.config.json < env.
 */
export function loadConfig(root: string = process.cwd()): KoptConfig {
  let cfg = defaultConfig(root);
  const candidates = [join(cfg.userDir, 'config.json'), join(cfg.dataDir, 'config.json'), join(cfg.root, 'kopt.config.json')];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      cfg = merge(cfg, JSON.parse(readFileSync(file, 'utf8')));
    } catch (err) {
      process.stderr.write(`kopt: ignoring invalid config ${file}: ${(err as Error).message}\n`);
    }
  }
  if (process.env.KOPT_TELEMETRY_ENDPOINT) cfg.telemetry.endpoint = process.env.KOPT_TELEMETRY_ENDPOINT;
  if (process.env.KOPT_TELEMETRY === '0') cfg.telemetry.enabled = false;
  if (process.env.KOPT_MCP_URL) cfg.central.mcpUrl = process.env.KOPT_MCP_URL;
  if (process.env.KOPT_SNAPSHOT_URL) cfg.central.snapshotUrl = process.env.KOPT_SNAPSHOT_URL;
  setCharsPerToken(cfg.charsPerToken);
  return cfg;
}

export function indexPath(cfg: KoptConfig): string {
  return join(cfg.dataDir, 'index.db');
}
