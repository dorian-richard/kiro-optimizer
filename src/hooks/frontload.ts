// UserPromptSubmit front-load: a few symbol pointers for the prompt, only when retrieval is confident.
// Exit-0 stdout of UserPromptSubmit is added to the agent context, so a weak guess would be paid for
// on every later turn: emit nothing unless the top hit covers >= 2 query terms.

import { existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import type { KoptConfig } from '../core/config.js';
import { indexPath } from '../core/config.js';
import { estimateTokens } from '../core/tokens.js';
import type { ToolResult } from '../core/types.js';
import { queryTerms, termsForText } from '../indexer/terms.js';

export const FRONTLOAD_HEADER = 'kopt pointers (use kopt_read #id):';
const MAX_PROMPT_CHARS = 600;

interface RetrievalLike {
  find(store: unknown, p: { query: string; mode?: 'hits' | 'pack'; maxTokens?: number; limit?: number }, ctx: unknown): ToolResult;
}

export interface FrontloadDeps {
  loadRetrieval: () => Promise<RetrievalLike>;
  /** Opens the index read-only; returns the store and a close function. */
  openStore: (config: KoptConfig) => Promise<{ store: unknown; close: () => void }>;
  newContext: (config: KoptConfig, session?: string) => Promise<unknown>;
}

// Specifiers in variables: sibling modules may be absent while this one is built/tested alone.
const RETRIEVAL_SPEC = '../retrieval/index.js';
const STORE_SPEC = '../store/store.js';
const CONTEXT_SPEC = '../core/context.js';

const defaultDeps: FrontloadDeps = {
  loadRetrieval: async () => (await import(RETRIEVAL_SPEC)) as RetrievalLike,
  openStore: async (config) => {
    const { Store } = await import(STORE_SPEC);
    const store = Store.open(indexPath(config), { root: config.root, readonly: true });
    return { store, close: () => store.close() };
  },
  newContext: async (config, session) => {
    const { newToolContext } = await import(CONTEXT_SPEC);
    return newToolContext(config, () => {}, session);
  },
};

let deps: FrontloadDeps = defaultDeps;

/** Test hook: override dependencies (pass undefined to restore). */
export function setFrontloadDeps(d: Partial<FrontloadDeps> | undefined): void {
  deps = d ? { ...defaultDeps, ...d } : defaultDeps;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(undefined), Math.max(0, ms));
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(undefined); });
  });
}

const HANDLE_RE = /#[0-9a-z]{1,10}\b/;

/** One file group of a find result: optional path line + pointer lines (each with a #handle). */
export interface HitGroup { path?: string; pointers: string[] }

/**
 * Parse a find result: header dropped, hints / truncation markers dropped. Handles both the grouped
 * layout (path line, then indented `#id a-b kind sig` lines) and flat lines carrying their own path.
 */
export function hitGroups(text: string): HitGroup[] {
  const groups: HitGroup[] = [];
  for (const raw of text.split('\n').slice(1)) {
    const line = raw.trimEnd();
    const t = line.trim();
    if (!t || /^(next:|narrow|…|\.\.\.|\+\d+ more)/.test(t)) continue;
    const handle = HANDLE_RE.exec(t);
    if (handle && t.startsWith('#')) {
      const g = groups[groups.length - 1];
      if (g && /^\s/.test(line)) g.pointers.push(line);
      else groups.push({ pointers: [line] });
    } else if (!handle && !/^\s/.test(line)) {
      groups.push({ path: line, pointers: [] });
    } else {
      groups.push({ pointers: [line] });
    }
  }
  return groups.filter((g) => g.pointers.length);
}

/** Light stemmer: enough to match plurals / inflections the way retrieval's prefix matching does. */
export function stem(t: string): string {
  const w = t.toLowerCase();
  for (const [suf, rep] of [['ations', ''], ['ation', ''], ['ings', ''], ['ing', ''], ['ies', 'y'], ['es', ''], ['ed', ''], ['s', '']] as const) {
    if (w.length - suf.length >= 3 && w.endsWith(suf)) return w.slice(0, w.length - suf.length) + rep;
  }
  return w;
}

/** Distinct query terms found in `text` (exact, or shared stem prefix of >= 4 chars). */
export function termCoverage(queryTerms: string[], text: string): number {
  const hit = termsForText(text);
  const hitStems = hit.map(stem);
  let n = 0;
  for (const q of new Set(queryTerms)) {
    const qs = stem(q);
    const ok = hit.includes(q) || hitStems.some((h) => {
      const a = h.length <= qs.length ? h : qs;
      const b = h.length <= qs.length ? qs : h;
      return a.length >= 4 && b.startsWith(a);
    });
    if (ok) n++;
  }
  return n;
}

/** Coverage a top hit needs to be worth front-loading: 2 terms, 3 for longer prompts. */
export function requiredCoverage(termCount: number): number {
  return termCount >= 6 ? 3 : 2;
}

/** Flattened hit lines (kept for callers that only need text). */
export function hitLines(text: string): string[] {
  return hitGroups(text).flatMap((g) => (g.path ? [g.path, ...g.pointers] : g.pointers));
}

/**
 * Front-load pointers for `prompt`. Returns the stdout text, or undefined when there is nothing
 * convincing, no index, or the time limit was exceeded. `alreadySent` handles are not repeated;
 * newly sent handles are appended to it.
 */
export async function frontload(prompt: string, config: KoptConfig, opts: { session?: string; alreadySent?: string[]; timeLimitMs?: number } = {}): Promise<string | undefined> {
  const budget = config.budgets.frontload;
  if (!(budget > 0) || !prompt) return undefined;
  const text = prompt.slice(0, MAX_PROMPT_CHARS);
  const terms = queryTerms(text);
  if (terms.length < 2) return undefined;
  if (!existsSync(indexPath(config))) return undefined;
  const limit = opts.timeLimitMs ?? 400;
  const t0 = performance.now();
  const left = () => limit - (performance.now() - t0);

  const opening = deps.openStore(config);
  const loaded = await withTimeout(Promise.all([deps.loadRetrieval(), opening, deps.newContext(config, opts.session)]), left());
  if (!loaded) {
    // Too slow, or another dependency failed: the index is (or will be) open all the same, so close it. A handle
    // left open keeps index.db locked on Windows (kopt uninstall, temp-dir cleanup) for as long as this process lives.
    opening.then((o) => { try { o.close(); } catch { /* ignore */ } }, () => {});
    return undefined;
  }
  const [retrieval, opened, ctx] = loaded;
  let result: ToolResult;
  try {
    if (left() <= 0) return undefined;
    const headerTok = estimateTokens(FRONTLOAD_HEADER + '\n');
    result = retrieval.find(opened.store, { query: text, mode: 'hits', maxTokens: Math.max(40, budget - headerTok), limit: 8 }, ctx);
  } finally {
    try { opened.close(); } catch { /* ignore */ }
  }
  // find() is synchronous and cannot be interrupted: discard a late answer instead.
  if (left() < 0 || !result || typeof result.text !== 'string') return undefined;

  const groups = hitGroups(result.text);
  if (!groups.length) return undefined;
  const metaCov = result.meta?.topTermsMatched;
  const top = `${groups[0].path ?? ''} ${groups[0].pointers[0]}`;
  const covered = typeof metaCov === 'number' ? metaCov : termCoverage(terms, top);
  if (covered < requiredCoverage(terms.length)) return undefined;

  const sent = new Set(opts.alreadySent ?? []);
  const out: string[] = [FRONTLOAD_HEADER];
  let used = estimateTokens(FRONTLOAD_HEADER);
  outer: for (const g of groups) {
    const fresh = g.pointers.filter((p) => !sent.has(HANDLE_RE.exec(p)?.[0] ?? ''));
    let pathPending = g.path;
    for (const p of fresh) {
      const add = (pathPending ? '\n' + pathPending : '') + '\n' + p;
      const t = estimateTokens(add);
      if (used + t > budget) break outer;
      if (pathPending) out.push(pathPending);
      pathPending = undefined;
      out.push(p);
      used += t;
      const m = HANDLE_RE.exec(p);
      if (m && opts.alreadySent) opts.alreadySent.push(m[0]);
    }
  }
  return out.length > 1 ? out.join('\n') : undefined;
}
