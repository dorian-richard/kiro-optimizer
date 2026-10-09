// Contract-typed lazy loaders for sibling modules (signatures mirror docs/CONTRACTS.md).
//
// Specifiers live in a table instead of literal `import('...')` calls so that:
//  - this layer typechecks and degrades gracefully while sibling modules are missing or broken
//    (e.g. kopt_find keeps working if compress/ fails to load);
//  - each CLI command / server only pays for the modules it actually touches (`kopt hook` stays fast).

import type { KoptConfig } from '../core/config.js';
import type { ToolContext } from '../core/context.js';
import type { ExpandParams, FindParams, OutlineParams, ReadParams, RefsParams, RunParams } from '../core/api.js';
import type { TelemetryEvent, ToolResult } from '../core/types.js';
import type { Store } from '../store/store.js';

export interface RetrievalModule {
  find(store: Store, p: FindParams, ctx: ToolContext): ToolResult;
  read(store: Store, p: ReadParams, ctx: ToolContext): ToolResult;
  outline(store: Store, p: OutlineParams, ctx: ToolContext): ToolResult;
  refs(store: Store, p: RefsParams, ctx: ToolContext): ToolResult;
}

export interface CompressModule {
  runCommand(p: RunParams, ctx: ToolContext): Promise<ToolResult>;
  expand(p: ExpandParams, ctx: ToolContext): ToolResult;
}

export interface IndexOptions {
  config: KoptConfig;
  paths?: string[];
  onProgress?: (done: number, total: number) => void;
}

export interface IndexStats {
  filesSeen: number;
  filesIndexed: number;
  filesUnchanged: number;
  filesDeleted: number;
  symbols: number;
  refs: number;
  durationMs: number;
  commit?: string;
}

export interface IndexerModule {
  indexRepo(store: Store, opts: IndexOptions): Promise<IndexStats>;
  refreshIndex(store: Store, opts: IndexOptions & { maxFiles?: number }): Promise<IndexStats>;
}

export interface TelemetryModule {
  record(event: TelemetryEvent, config: KoptConfig): void;
  stats(config: KoptConfig, opts?: { days?: number }): string;
  collectKiroCredits(config: KoptConfig): TelemetryEvent[];
}

export interface HookEvent {
  hook_event_name: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: any;
  tool_response?: any;
  prompt?: string;
  [k: string]: unknown;
}

export interface HookOutcome {
  exitCode: 0 | 2;
  stdout?: string;
  stderr?: string;
}

export interface HooksModule {
  handleHook(event: HookEvent, config: KoptConfig): Promise<HookOutcome>;
}

export interface InstallOptions {
  root: string;
  scope: 'workspace' | 'user';
  explorerModel?: string;
  dryRun?: boolean;
  force?: boolean;
}

export interface KiroModule {
  installKiro(o: InstallOptions): Promise<{ written: string[]; skipped: string[]; notes: string[] }>;
}

export interface BenchModule {
  runBenchCli(argv: string[]): Promise<void>;
}

/** Everything the MCP/CLI layer calls into. Tests inject fakes through `Partial<Modules>`. */
export interface Modules {
  retrieval: () => Promise<RetrievalModule>;
  compress: () => Promise<CompressModule>;
  indexer: () => Promise<IndexerModule>;
  telemetry: () => Promise<TelemetryModule>;
  hooks: () => Promise<HooksModule>;
  kiro: () => Promise<KiroModule>;
  bench: () => Promise<BenchModule>;
}

// Paths are relative to this file (src/mcp/ or dist/mcp/).
const SPECS: Record<keyof Modules, string> = {
  retrieval: '../retrieval/index.js',
  compress: '../compress/index.js',
  indexer: '../indexer/index.js',
  telemetry: '../telemetry/index.js',
  hooks: '../hooks/index.js',
  kiro: '../kiro/index.js',
  bench: '../bench/index.js',
};

const cache = new Map<string, Promise<unknown>>();

function load<T>(spec: string): Promise<T> {
  let p = cache.get(spec);
  if (!p) {
    p = import(spec);
    // Do not memoize failures: a module fixed on disk (dev) or a transient error can succeed later.
    p.catch(() => cache.delete(spec));
    cache.set(spec, p);
  }
  return p as Promise<T>;
}

export const defaultModules: Modules = {
  retrieval: () => load<RetrievalModule>(SPECS.retrieval),
  compress: () => load<CompressModule>(SPECS.compress),
  indexer: () => load<IndexerModule>(SPECS.indexer),
  telemetry: () => load<TelemetryModule>(SPECS.telemetry),
  hooks: () => load<HooksModule>(SPECS.hooks),
  kiro: () => load<KiroModule>(SPECS.kiro),
  bench: () => load<BenchModule>(SPECS.bench),
};

export function withModules(over?: Partial<Modules>): Modules {
  return over ? { ...defaultModules, ...over } : defaultModules;
}
