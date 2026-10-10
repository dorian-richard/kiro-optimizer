// Parameter types of the user-facing operations. The MCP layer (src/mcp) validates input with zod
// and calls the module functions listed in docs/CONTRACTS.md with these shapes.

import type { SymbolKind } from './types.js';

export interface FindParams {
  /** Natural language or identifiers ("where are refunds computed", "OrderService.place", "validate*Token"). */
  query: string;
  /** `hits` (default): ranked pointers only. `pack`: pointers + bodies of the best few symbols, task-level context in one call. */
  mode?: 'hits' | 'pack';
  kinds?: SymbolKind[];
  /** Restrict to paths starting with this prefix or matching this glob. */
  path?: string;
  limit?: number;
  maxTokens?: number;
  fresh?: boolean;
  /**
   * Internal (prompt pointers, not exposed to the model): `performance.now()` time by which the answer is needed.
   * Close to it, the full-text step is skipped and only name lookups answer.
   */
  deadline?: number;
}

export interface ReadParams {
  /**
   * What to read: a symbol handle ("#3mv"), a (qualified) symbol name ("OrderService.place"),
   * a file path ("src/a.ts"), or a range ("src/a.ts:120-180").
   */
  target: string;
  /**
   * `body` (default for symbols/ranges): exact source with a single `path:start-end` header.
   * `skeleton`: signatures of the symbol/file members, bodies elided.
   * `card`: signature + doc + location + counts of callers/callees (~60 tokens).
   */
  mode?: 'body' | 'skeleton' | 'card';
  maxTokens?: number;
  fresh?: boolean;
}

export interface OutlineParams {
  /** File or directory (repo-relative). Empty or "." = repo map. */
  path?: string;
  /** Optional focus words: ranks files/symbols relevant to the task first (personalized ranking). */
  focus?: string;
  maxTokens?: number;
}

export interface RefsParams {
  /** Symbol handle or (qualified) name. */
  target: string;
  /** `in` = callers/usages (default), `out` = callees/dependencies, `both`. */
  direction?: 'in' | 'out' | 'both';
  /** 1 (default) or 2 for transitive impact ("blast radius"). */
  depth?: 1 | 2;
  maxTokens?: number;
}

export interface RunParams {
  /** Shell command executed in the repo root (tests, builds, linters, git...). */
  command: string;
  /** Working directory relative to the repo root. */
  cwd?: string;
  timeoutSec?: number;
  maxTokens?: number;
  /** Bypass the "identical command, no file changed" cache. */
  fresh?: boolean;
}

export interface ExpandParams {
  /** Output handle returned by kopt_run (e.g. "o7f3a"). */
  handle: string;
  /** Regex to filter lines (with 2 lines of context). */
  grep?: string;
  startLine?: number;
  endLine?: number;
  maxTokens?: number;
}
