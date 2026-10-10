// UserPromptSubmit front-load: a few symbol pointers for the prompt, only when retrieval is confident.
// Exit-0 stdout of UserPromptSubmit stays in the agent context and is re-billed on every later turn, and the
// steering already makes `kopt_find mode=pack` the first call of a new task. So pointers are added only when they are
// very likely right, and most prompts get nothing:
//  - follow-ups and short conversational prompts ("fix the failing test", "revert the last change", "yes, continue")
//    are skipped;
//  - a prompt that names code (backticks, CamelCase, snake_case, dotted names, file paths) gets pointers only when
//    the top hit IS one of those names;
//  - otherwise, after dropping generic developer words (test, fix, error, build, change, commit, add, type...), the
//    top hit must cover at least 2 of the remaining words and 2/3 of them;
//  - at most MAX_POINTERS pointers within budgets.frontload tokens (200), never a handle already sent in the session.

import { existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import type { KoptConfig } from '../core/config.js';
import { indexPath } from '../core/config.js';
import { estimateTokens } from '../core/tokens.js';
import type { ToolResult } from '../core/types.js';
import { QUERY_STOPWORDS, termsForText } from '../indexer/terms.js';

export const FRONTLOAD_HEADER = 'kopt pointers (use kopt_read #id):';
const MAX_PROMPT_CHARS = 600;
/** Pointer lines per prompt. */
export const MAX_POINTERS = 4;

/** Developer and conversational words that say nothing about where in the code a task is. */
const GENERIC = new Set([
  'test', 'tests', 'testing', 'tested', 'spec', 'specs', 'fail', 'fails', 'failing', 'failed', 'failure', 'failures', 'fix', 'fixed', 'fixes',
  'fixing', 'error', 'errors', 'bug', 'bugs', 'issue', 'issues', 'problem', 'problems', 'build', 'builds', 'run', 'runs', 'running', 'rerun',
  'write', 'writes', 'writing', 'written', 'add', 'adds', 'adding', 'added', 'update', 'updates', 'updated', 'updating', 'change', 'changes',
  'changed', 'changing', 'new', 'old', 'commit', 'commits', 'message', 'messages', 'version', 'versions', 'setting', 'settings', 'type',
  'types', 'typed', 'list', 'empty', 'edge', 'case', 'cases', 'readable', 'clean', 'cleanup', 'refactor', 'refactoring', 'rename', 'move',
  'remove', 'removed', 'delete', 'deleted', 'make', 'makes', 'create', 'created', 'check', 'checks', 'please', 'thanks', 'now', 'again',
  'instead', 'also', 'just', 'still', 'only', 'more', 'less', 'better', 'same', 'other', 'another', 'last', 'first', 'next', 'previous',
  'before', 'after', 'above', 'below', 'line', 'lines', 'comment', 'comments', 'doc', 'docs', 'documentation', 'readme', 'value', 'values',
  'data', 'name', 'names', 'return', 'returns', 'call', 'calls', 'support', 'feature', 'features', 'implement', 'explain', 'describe', 'look',
  'see', 'help', 'want', 'need', 'needs', 'like', 'way', 'thing', 'things', 'stuff', 'part', 'parts', 'step', 'steps', 'review', 'improve',
  'optimize', 'simple', 'simplify', 'small', 'big', 'good', 'bad', 'wrong', 'right', 'correct', 'works', 'working', 'broken', 'try', 'keep',
  'let', 'lets', 'ok', 'okay', 'yes', 'no', 'not', 'dont', 'sure', 'go', 'continue', 'done', 'finish', 'start', 'stop', 'project', 'repo',
  'repository', 'module', 'modules', 'package', 'packages', 'function', 'functions', 'variable', 'variables', 'param', 'params', 'parameter',
  'parameters', 'argument', 'arguments', 'output', 'input', 'result', 'results', 'unit', 'integration', 'lint', 'linter', 'format', 'style',
  'code', 'file', 'files', 'folder', 'directory', 'path', 'hint', 'hints', 'log', 'logs', 'print', 'debug', 'entry', 'entries', 'item', 'items',
  'object', 'objects', 'string', 'number', 'true', 'false', 'null', 'undefined', 'default', 'config', 'configuration', 'option', 'options',
  'set', 'sets', 'get', 'gets', 'decide', 'decides', 'determine', 'determines', 'happen', 'happens', 'know', 'understand', 'tell', 'show',
  'find', 'search', 'read', 'open', 'have', 'has', 'had', 'want', 'wants', 'should', 'must', 'could', 'would', 'might', 'every', 'each',
]);

const FOLLOW_UP_START = /^\s*(yes|yeah|yep|no|nope|ok(ay)?|sure|thanks|thank you|great|perfect|nice|cool|continue|go (ahead|on)|proceed|do it|try (it )?again|again|retry|keep going|looks good|lgtm|sounds good|please (do|continue)|undo|revert)\b/i;
const CONVERSATION_REF = /\b(you just|you (did|made|wrote|changed|added)|your (last|previous)|(the|my) last (change|commit|edit|step)|previous (answer|change|step|message|commit)|as before|same as before|i have open|currently open|the open file|this file|these changes|that change|the change you|commit message|the diff|the failing tests?|the (build|tests?) (again|fail))\b/i;

/** What a prompt says about where in the code its task is. */
export interface PromptSignal {
  /**
   * Code the prompt names (backticks, CamelCase, snake_case, dotted names, paths), each as the normalized parts (lower
   * case, letters and digits only) that must all appear in a hit: `OrderService.place` -> [orderservice, place].
   */
  identifiers: string[][];
  /** Distinct non-generic words. */
  words: string[];
  /** A follow-up or conversational prompt: no pointers. */
  followUp: boolean;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|java|go|rs|cs|kt|kts|rb|php|scala|vue|svelte|swift|c|h|cpp|hpp)$/i;

export function promptSignal(prompt: string, extraGeneric: string[] = []): PromptSignal {
  const text = prompt.slice(0, MAX_PROMPT_CHARS);
  const ids = new Map<string, string[]>();
  const addId = (raw: string) => {
    const t = raw.replace(/^[`'"(]+|[`'"),.:;!?]+$/g, '').replace(/\(\)$/, '');
    if (/^\d+(\.\d+)*$/.test(t) || /^(e\.g|i\.e|etc)\.?$/i.test(t) || /^https?:/i.test(t)) return;
    // a path: its file name without extension; a qualified name: every segment
    const pathLike = /[\\/]/.test(t) || CODE_EXT.test(t);
    const parts = (pathLike ? [t.split(/[\\/]/).pop()!.replace(CODE_EXT, '')] : t.split(/\.|::|#/)).map(norm).filter((x) => x.length >= 3);
    if (!parts.length || parts.join('').length < 4) return;
    ids.set(parts.join('|'), parts);
  };
  for (const m of text.matchAll(/`([^`\n]{2,80})`/g)) for (const tok of m[1].split(/\s+/)) addId(tok);
  const unquoted = text.replace(/`[^`\n]*`/g, ' ');
  for (const m of unquoted.matchAll(/[A-Za-z_$][\w$]*(?:(?:\.|::|#)[A-Za-z_$][\w$]*)+(?:\(\))?/g)) addId(m[0]); // dotted / :: / #
  for (const m of unquoted.matchAll(/\b[a-z]+(?:[A-Z][a-z0-9]*)+\b/g)) addId(m[0]); // camelCase
  for (const m of unquoted.matchAll(/\b(?:[A-Z][a-z0-9]+){2,}[A-Za-z0-9]*\b|\b[A-Z]{2,}[a-z][A-Za-z0-9]*\b/g)) addId(m[0]); // PascalCase, HTTPServer
  for (const m of unquoted.matchAll(/\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/g)) addId(m[0]); // snake_case, SCREAMING_CASE
  for (const m of unquoted.matchAll(/(?:[\w.-]+\/)+[\w.-]+|\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|py|java|go|rs|cs|kt|rb|php|scala|vue|svelte)\b/g)) addId(m[0]); // paths
  const words: string[] = [];
  const seenStem = new Set<string>();
  const extra = new Set(extraGeneric.map((w) => w.toLowerCase()));
  for (const m of unquoted.matchAll(/[A-Za-z][A-Za-z']{2,}/g)) {
    const w = m[0].toLowerCase().replace(/'s$/, '').replace(/'/g, '');
    if (w.length < 3 || GENERIC.has(w) || QUERY_STOPWORDS.has(w) || extra.has(w)) continue;
    const st = stem(w);
    if (GENERIC.has(st) || seenStem.has(st)) continue;
    seenStem.add(st);
    words.push(w);
  }
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  const followUp = FOLLOW_UP_START.test(text) || CONVERSATION_REF.test(text) || (ids.size === 0 && (wordCount < 4 || text.trim().length < 20));
  // `OrderService.place` also matches the CamelCase rule alone: keep the stricter group
  const groups = [...ids.values()];
  const identifiers = groups.filter((g) => !groups.some((o) => o.length > g.length && g.every((x) => o.includes(x))));
  return { identifiers, words, followUp };
}

/**
 * Is `top` (the best hit: path + pointer line) a confident answer to the prompt? Named code must be the hit itself;
 * plain words must be mostly covered (>= 2 words and >= 2/3 of them).
 */
export function confidentHit(sig: PromptSignal, top: string): boolean {
  if (sig.followUp) return false;
  if (sig.identifiers.length) {
    const t = norm(top);
    return sig.identifiers.some((parts) => parts.every((x) => t.includes(x)));
  }
  if (sig.words.length < 2) return false;
  const covered = termCoverage(sig.words, top);
  return covered >= 2 && covered * 3 >= sig.words.length * 2;
}

interface RetrievalLike {
  find(store: unknown, p: { query: string; mode?: 'hits' | 'pack'; maxTokens?: number; limit?: number; deadline?: number }, ctx: unknown): ToolResult;
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
 * Parse a find result: header dropped, hints / truncation markers dropped, and the per-file `also: name L12 #id`
 * lines (other names of a shown file: not pointers). Handles both the grouped layout (path line, then indented
 * `#id a-b kind sig` lines) and flat lines carrying their own path.
 */
export function hitGroups(text: string): HitGroup[] {
  const groups: HitGroup[] = [];
  for (const raw of text.split('\n').slice(1)) {
    const line = raw.trimEnd();
    const t = line.trim();
    if (!t || /^(next:|narrow|also:|…|\.\.\.|\+\d+ more)/.test(t)) continue;
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
  // the project's own name says nothing about where in it the task is
  const repoWords = (config.root.split(/[\\/]/).pop() ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const sig = promptSignal(text, repoWords);
  if (sig.followUp || (!sig.identifiers.length && sig.words.length < 2)) return undefined;
  if (!existsSync(indexPath(config))) return undefined;
  const limit = opts.timeLimitMs ?? 400;
  // Kiro waits for the whole hook, Node start-up included: in a hook process that just started (performance.now()
  // counts from process start), the limit counts from there
  const now = performance.now();
  const t0 = now < 300 ? 0 : now;
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
    result = retrieval.find(opened.store, { query: text, mode: 'hits', maxTokens: Math.max(40, budget - headerTok), limit: 8, deadline: t0 + limit }, ctx);
  } finally {
    try { opened.close(); } catch { /* ignore */ }
  }
  // find() is synchronous and cannot be interrupted: discard a late answer instead.
  if (left() < 0 || !result || typeof result.text !== 'string') return undefined;

  const groups = hitGroups(result.text);
  if (!groups.length) return undefined;
  const top = `${groups[0].path ?? ''} ${groups[0].pointers[0]}`;
  if (!confidentHit(sig, top)) return undefined;

  const sent = new Set(opts.alreadySent ?? []);
  const out: string[] = [FRONTLOAD_HEADER];
  let used = estimateTokens(FRONTLOAD_HEADER);
  let pointers = 0;
  outer: for (const g of groups) {
    const fresh = g.pointers.filter((p) => !sent.has(HANDLE_RE.exec(p)?.[0] ?? ''));
    let pathPending = g.path;
    for (const p of fresh) {
      const add = (pathPending ? '\n' + pathPending : '') + '\n' + p;
      const t = estimateTokens(add);
      if (used + t > budget || pointers >= MAX_POINTERS) break outer;
      pointers++;
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
