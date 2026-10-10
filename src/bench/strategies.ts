// Exploration strategies compared by the offline benchmark. Each returns exactly what would enter the
// model context (concatenated tool outputs) and the list of emulated tool calls.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { estimateTokens } from '../core/tokens.js';
import type { KoptConfig } from '../core/config.js';
import { newToolContext, type ToolContext } from '../core/context.js';
import type { FindParams, ReadParams } from '../core/api.js';
import type { ToolResult } from '../core/types.js';
import type { Store } from '../store/store.js';
import { grepKeywords, nativeGrep, KIRO_GREP_LIMITS, type GrepLimits, type GrepMatch, type GrepResult } from './grep.js';
import type { StrategyOutput, ToolCallRecord } from './types.js';

export interface NativeOptions {
  grepLimits?: GrepLimits;
  /** native-naive: files read whole after the grep (Kiro read_file default cap: 2000 lines). */
  naiveTopFiles?: number;
  naiveMaxLines?: number;
  /** native-ranged: matches whose ±context lines are read. */
  rangedMatches?: number;
  rangedContext?: number;
  /** Memo of grep results keyed by root+input, so strategies sharing the same grep do not re-run it. */
  grepCache?: Map<string, GrepResult>;
}

export const NATIVE_DEFAULTS = { naiveTopFiles: 3, naiveMaxLines: 2000, rangedMatches: 4, rangedContext: 60 } as const;

function call(tool: string, args: string, text: string): ToolCallRecord {
  return { tool, args, chars: text.length, tokens: estimateTokens(text) };
}

function fileLines(root: string, path: string, cache: Map<string, string[]>): string[] {
  let lines = cache.get(path);
  if (!lines) {
    try {
      lines = readFileSync(join(root, path), 'utf8').split('\n');
    } catch {
      lines = [];
    }
    cache.set(path, lines);
  }
  return lines;
}

function grepCall(root: string, input: string, limits: GrepLimits, cache?: Map<string, GrepResult>): { g: GrepResult; rec: ToolCallRecord } {
  const key = `${root}\0${input}\0${limits.maxMatches}/${limits.maxChars}/${limits.maxLineChars}`;
  let g = cache?.get(key);
  if (!g) {
    g = nativeGrep(root, grepKeywords(input), limits);
    cache?.set(key, g);
  }
  return { g, rec: call('grep', g.pattern || '(no keyword)', g.text) };
}

/** Visible files ordered by visible match count, then distinct keywords on their lines, then display order. */
export function topVisibleFiles(visible: GrepMatch[], n: number): string[] {
  const stats = new Map<string, { count: number; terms: number; order: number }>();
  for (const m of visible) {
    const s = stats.get(m.path) ?? { count: 0, terms: 0, order: stats.size };
    s.count++;
    s.terms = Math.max(s.terms, m.terms);
    stats.set(m.path, s);
  }
  return [...stats.entries()]
    .sort(([, a], [, b]) => b.count - a.count || b.terms - a.terms || a.order - b.order)
    .slice(0, n)
    .map(([p]) => p);
}

/** grep_search + read_file (whole file, capped) of the top files by match count. */
export function nativeNaive(root: string, input: string, opts: NativeOptions = {}): StrategyOutput {
  const limits = opts.grepLimits ?? KIRO_GREP_LIMITS;
  const topN = opts.naiveTopFiles ?? NATIVE_DEFAULTS.naiveTopFiles;
  const maxLines = opts.naiveMaxLines ?? NATIVE_DEFAULTS.naiveMaxLines;
  const { g, rec } = grepCall(root, input, limits, opts.grepCache);
  const calls = [rec];
  const parts = [g.text];
  const cache = new Map<string, string[]>();
  for (const path of topVisibleFiles(g.visible, topN)) {
    const lines = fileLines(root, path, cache);
    let text = lines.slice(0, maxLines).join('\n');
    if (lines.length > maxLines) text += `\n[truncated: showing lines 1-${maxLines} of ${lines.length}]`;
    calls.push(call('read_file', path, text));
    parts.push(text);
  }
  return { calls, text: parts.join('\n') };
}

const DEF_LIKE = /\b(class|interface|enum|record|def|function|fun|func|struct|trait|public|protected|private|static|void)\b/;

export interface LineWindow {
  path: string;
  start: number;
  end: number;
}

/**
 * Pick the best `n` grep matches a disciplined agent would open: most keywords on the line, definition-like
 * lines, earlier (better ranked) files. Overlapping windows in a file are merged into one read.
 */
export function pickWindows(visible: GrepMatch[], n: number, context: number, lineCount: (path: string) => number): LineWindow[] {
  const fileOrder = new Map<string, number>();
  for (const m of visible) if (!fileOrder.has(m.path)) fileOrder.set(m.path, fileOrder.size);
  const scored = visible
    .map((m, i) => ({ m, i, score: m.terms * 10 + (DEF_LIKE.test(m.text) ? 5 : 0) + Math.max(0, 3 - (fileOrder.get(m.path) ?? 3)) }))
    .sort((a, b) => b.score - a.score || a.i - b.i);
  const chosen: LineWindow[] = [];
  for (const { m } of scored) {
    if (chosen.length >= n) break;
    if (chosen.some((w) => w.path === m.path && m.line >= w.start && m.line <= w.end)) continue;
    const total = lineCount(m.path);
    chosen.push({ path: m.path, start: Math.max(1, m.line - context), end: Math.max(1, Math.min(total || m.line + context, m.line + context)) });
  }
  // merge overlapping/adjacent windows of the same file (an agent would not re-read the same lines)
  chosen.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.start - b.start));
  const merged: LineWindow[] = [];
  for (const w of chosen) {
    const last = merged[merged.length - 1];
    if (last && last.path === w.path && w.start <= last.end + 1) last.end = Math.max(last.end, w.end);
    else merged.push({ ...w });
  }
  return merged;
}

/** grep_search + read_file with offset/limit (±context lines) around the best matches. */
export function nativeRanged(root: string, input: string, opts: NativeOptions = {}): StrategyOutput {
  const limits = opts.grepLimits ?? KIRO_GREP_LIMITS;
  const n = opts.rangedMatches ?? NATIVE_DEFAULTS.rangedMatches;
  const context = opts.rangedContext ?? NATIVE_DEFAULTS.rangedContext;
  const { g, rec } = grepCall(root, input, limits, opts.grepCache);
  const calls = [rec];
  const parts = [g.text];
  const cache = new Map<string, string[]>();
  for (const w of pickWindows(g.visible, n, context, (p) => fileLines(root, p, cache).length)) {
    const text = fileLines(root, w.path, cache).slice(w.start - 1, w.end).join('\n');
    calls.push(call('read_file', `${w.path}:${w.start}-${w.end}`, text));
    parts.push(text);
  }
  return { calls, text: parts.join('\n') };
}

// ---------------------------------------------------------------------------------------------------------
// kopt strategies. retrieval/indexer are separate modules (possibly not built yet): loaded dynamically.

export interface RetrievalModule {
  find(store: Store, p: FindParams, ctx: ToolContext): ToolResult;
  read(store: Store, p: ReadParams, ctx: ToolContext): ToolResult;
}

type IndexOpts = { config: KoptConfig; repoName?: string; onProgress?: (done: number, total: number) => void };
type IndexStatsLike = { filesIndexed: number; symbols: number; durationMs: number };

export interface IndexerModule {
  indexRepo(store: Store, opts: IndexOpts): Promise<IndexStatsLike>;
  refreshIndex?(store: Store, opts: IndexOpts): Promise<IndexStatsLike>;
}

export interface KoptModules {
  retrieval?: RetrievalModule;
  indexer?: IndexerModule;
  /** Why a module could not be loaded. */
  errors: string[];
}

async function tryImport<T>(rel: string, check: (m: any) => boolean): Promise<{ mod?: T; error?: string }> {
  try {
    // computed specifier: the module may not exist at type-check time
    const m = await import(new URL(rel, import.meta.url).href);
    if (!check(m)) return { error: `${rel} does not export the expected functions` };
    return { mod: m as T };
  } catch (err) {
    return { error: `${rel}: ${(err as Error).message.split('\n')[0]}` };
  }
}

export async function loadKoptModules(): Promise<KoptModules> {
  const r = await tryImport<RetrievalModule>('../retrieval/index.js', (m) => typeof m.find === 'function' && typeof m.read === 'function');
  const i = await tryImport<IndexerModule>('../indexer/index.js', (m) => typeof m.indexRepo === 'function');
  return { retrieval: r.mod, indexer: i.mod, errors: [r.error, i.error].filter((e): e is string => !!e) };
}

/**
 * Up to `n` follow-up targets from a `find` hits listing: symbol handles first (`#3mv`), else `path:start-end`.
 * The header line and the per-file `also: name L12 #id` lines (other names of a listed file, not hits) are skipped.
 */
export function extractTargets(text: string, n: number): string[] {
  const out: string[] = [];
  for (const line of text.split('\n').slice(1)) {
    if (out.length >= n) break;
    if (/^\s*also:/.test(line)) continue;
    const handle = /(?:^|\s)(#[0-9a-z]{1,10})\b/.exec(line)?.[1];
    const range = /([\w./-]+\.[\w]+:\d+-\d+)/.exec(line)?.[1];
    const t = handle ?? range;
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

function resultRecord(tool: string, args: string, r: ToolResult): ToolCallRecord {
  return { tool, args, chars: r.text.length, tokens: estimateTokens(r.text) };
}

/** One kopt_find mode=pack call with the default pack budget. */
export function koptPack(store: Store, retrieval: RetrievalModule, config: KoptConfig, input: string): StrategyOutput {
  const ctx = newToolContext(config);
  const r = retrieval.find(store, { query: input, mode: 'pack' }, ctx);
  return { calls: [resultRecord('kopt_find', `pack "${input}"`, r)], text: r.text };
}

/** kopt_find hits, then kopt_read of the top `n` hits, in one session (shared dedup ledger). */
export function koptHitsRead(store: Store, retrieval: RetrievalModule, config: KoptConfig, input: string, n = 2): StrategyOutput {
  const ctx = newToolContext(config);
  const hits = retrieval.find(store, { query: input, mode: 'hits' }, ctx);
  const calls = [resultRecord('kopt_find', `hits "${input}"`, hits)];
  const parts = [hits.text];
  for (const target of extractTargets(hits.text, n)) {
    const r = retrieval.read(store, { target }, ctx);
    calls.push(resultRecord('kopt_read', target, r));
    parts.push(r.text);
  }
  return { calls, text: parts.join('\n') };
}
