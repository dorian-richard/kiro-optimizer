// Shared helpers for the retrieval tools: budgets, headers, dedup, path filters, ranking priors.

import { createHash } from 'node:crypto';
import type { Ledger } from '../core/context.js';
import { estimateTokens, tokensToChars } from '../core/tokens.js';
import type { ToolResult } from '../core/types.js';
import type { SymbolRow } from '../store/schema.js';
import { symbolHandle } from '../store/store.js';
import { repoRelative } from '../telemetry/fsutil.js';

/** Symbol row joined with the few file columns every renderer needs. */
export type SymRow = SymbolRow & { path: string; file_rank: number };

export const SYM_COLS = 's.*, f.path AS path, f.rank AS file_rank';

export function budgetOf(requested: unknown, fallback: number): number {
  const n = Number(requested);
  if (requested === undefined || requested === null || !Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.floor(n));
}

/** Hard cap: keep whole lines from the head; only a lone over-long first line is cut. */
export function enforce(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  const maxChars = tokensToChars(maxTokens);
  const lines = text.split('\n');
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    const add = line.length + (out.length ? 1 : 0);
    if (used + add > maxChars) break;
    out.push(line);
    used += add;
  }
  if (out.length) return out.join('\n');
  return lines[0].slice(0, Math.max(0, maxChars - 1)) + '…';
}

/**
 * Prepend a header line whose `~N tok` matches the final text, then enforce the cap.
 * `head(tok)` must return the header line for a given token count.
 */
export function compose(head: (tok: number) => string, body: string, maxTokens: number): string {
  let tok = estimateTokens(body) + 10;
  let text = '';
  for (let i = 0; i < 4; i++) {
    text = body ? `${head(tok)}\n${body}` : head(tok);
    const t = estimateTokens(text);
    if (t === tok) break;
    tok = t;
  }
  return enforce(text, maxTokens);
}

/**
 * Header + body within `maxTokens`: drops trailing body lines (counted in "+k more") until the whole text fits,
 * so the cap never cuts lines silently and the header's ~tok matches the text.
 */
export function fitBody(head: (more: number) => (tok: number) => string, body: string[], more: number, maxTokens: number): string {
  const lines = [...body];
  let m = more;
  for (;;) {
    const text = compose(head(m), lines.join('\n'), Number.MAX_SAFE_INTEGER);
    if (estimateTokens(text) <= maxTokens || !lines.length) return compose(head(m), lines.join('\n'), maxTokens);
    lines.pop();
    m++;
  }
}

export function result(text: string, maxTokens: number, meta?: Record<string, unknown>, baselineTokens?: number): ToolResult {
  const t = enforce(text, maxTokens);
  const r: ToolResult = { text: t, tokens: estimateTokens(t) };
  if (baselineTokens !== undefined) r.baselineTokens = baselineTokens;
  if (meta) r.meta = meta;
  return r;
}

/** The answer with one more trailing line (a resolution note), when it still fits `maxTokens`. */
export function withNote(r: ToolResult, note: string | undefined, maxTokens: number): ToolResult {
  if (!note) return r;
  const text = `${r.text}\n${note}`;
  const tokens = estimateTokens(text);
  return tokens <= maxTokens ? { ...r, text, tokens } : r;
}

/** Tools never throw: unexpected errors (I/O, SQLite busy...) become a one-line answer. */
export function guard(label: string, maxTokens: number, fn: () => ToolResult): ToolResult {
  try {
    return fn();
  } catch (err) {
    const msg = String((err as Error)?.message ?? err).split('\n')[0];
    process.stderr.write(`kopt: ${label} failed: ${msg}\n`);
    return result(`${label} failed: ${msg}`, maxTokens, { error: true });
  }
}

/**
 * "+k more (...)" header suffix naming the constraint that actually cut the list, so that following the hint
 * returns more: the token budget, the result limit, or (repo map) the scope.
 */
export function moreSuffix(k: number, why: 'maxTokens' | 'limit' | 'scope' = 'maxTokens'): string {
  if (k <= 0) return '';
  const hint = why === 'limit' ? 'raise limit or narrow query' : why === 'scope' ? 'narrow with path or focus' : 'raise maxTokens or narrow query';
  return ` · +${k} more (${hint})`;
}

export function quote(q: string, max = 60): string {
  const s = q.replace(/\s+/g, ' ').trim();
  return `"${s.length > max ? s.slice(0, max - 1) + '…' : s}"`;
}

export function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

export function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

export function unchangedLine(loc: string, handle: string | undefined, call: number | undefined): string {
  return `${loc}${handle ? ' ' + handle : ''} unchanged (shown in call ${call ?? '?'}) – pass fresh:true to resend`;
}

// Ranges shown per ledger, so a symbol inside an already-sent range is not re-sent either.

export function noteShownRange(ledger: Ledger, path: string, start: number, end: number, key: string): void {
  const m = ledger.ranges;
  const arr = m.get(path) ?? [];
  if (!arr.some((r) => r.key === key)) arr.push({ key, start, end });
  if (arr.length > 64) arr.shift();
  m.set(path, arr);
}

/** An earlier shown range covering [start,end] whose text is unchanged (digest recomputed from current lines). */
export function coveringShownRange(
  ledger: Ledger,
  path: string,
  start: number,
  end: number,
  digestOf: (s: number, e: number) => string,
): { key: string; start: number; end: number } | undefined {
  const arr = ledger.ranges.get(path);
  if (!arr) return undefined;
  for (const r of arr) {
    if (r.start <= start && r.end >= end && ledger.wasShown(r.key, digestOf(r.start, r.end))) return r;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Paths

export function normalizeRel(p: string, root?: string): string {
  // absolute paths in any spelling (drive-letter case, `\\?\`, file://, macOS /private aliases, case-insensitive FS)
  const inRoot = root ? repoRelative(root, p) : undefined;
  if (inRoot !== undefined) return inRoot;
  let s = p.trim().replace(/\\/g, '/');
  if (root) {
    const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
    if (s === r) return '';
    if (s.startsWith(r + '/')) s = s.slice(r.length + 1);
  }
  s = s.replace(/^(\.\/)+/, '').replace(/\/{2,}/g, '/');
  if (s === '.' || s === './') return '';
  return s;
}

const TEST_PATH_RE =
  /(^|\/)(tests?|__tests__|__mocks__|spec|specs|testing|e2e)\/|\.(spec|test|e2e)\.[^/]+$|(Test|Tests|IT|Spec)\.(java|kt|kts|scala|cs|groovy|swift)$|_test\.(go|py|rb|exs?)$|(^|\/)test_[^/]+\.py$|_spec\.rb$/;
/** Code that is not the product: fixtures, sbt scripted tests, documentation snippets, examples, benchmarks. */
const NON_PRODUCT_PATH_RE =
  /(^|\/)(sbt-test|fixtures?|__fixtures__|__snapshots__|testdata|test-?data|test-?fixtures|testFixtures|integration-tests?|it-tests?|documentation|docs?|examples?|samples?|jmh|benchmarks?)\//;

/** Tests and other non-product code (fixtures, docs snippets, examples, benchmarks): demoted in rankings. */
export function isTestPath(path: string): boolean {
  return TEST_PATH_RE.test(path) || NON_PRODUCT_PATH_RE.test(path);
}

const TEST_TERMS = new Set(['test', 'tests', 'spec', 'specs', 'mock', 'mocks', 'junit', 'fixture', 'fixtures', 'testing', 'unittest', 'e2e', 'jest', 'vitest', 'pytest', 'stub', 'stubs']);

export function mentionsTests(terms: string[]): boolean {
  return terms.some((t) => TEST_TERMS.has(t));
}

/** Glob with `*`, `**`, `?` -> anchored RegExp. Patterns without `/` match the basename anywhere (gitignore-like). */
export function globToRegExp(glob: string): RegExp {
  const g = glob.replace(/^\.\//, '');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(g.includes('/') ? `^${re}$` : `(?:^|/)${re}$`);
}

export function isGlob(s: string): boolean {
  return /[*?]/.test(s);
}

/** Literal escape for SQLite GLOB. */
export function globLiteral(s: string): string {
  return s.replace(/[*?[]/g, (c) => `[${c}]`);
}

export interface PathFilter {
  /** Precise predicate. */
  test: (path: string) => boolean;
  /** SQLite GLOB superset used to push the filter into SQL. */
  sqlGlob: string;
  /** Exact file when the filter names one file. */
  exact?: string;
}

export function pathFilter(raw: string | undefined, root?: string): PathFilter | undefined {
  if (!raw || !raw.trim()) return undefined;
  const p = normalizeRel(raw, root);
  if (!p) return undefined;
  if (isGlob(p)) {
    const rx = globToRegExp(p);
    const sql = (p.includes('/') ? '' : '*') + p.replace(/\*\*\/?/g, '*');
    return { test: (x) => rx.test(x), sqlGlob: sql };
  }
  return { test: (x) => x.startsWith(p), sqlGlob: globLiteral(p) + '*', exact: p };
}

// ---------------------------------------------------------------------------------------------
// Symbols

export function kindPrior(kind: string): number {
  switch (kind) {
    case 'class':
    case 'interface':
    case 'trait':
    case 'struct':
    case 'record':
    case 'enum':
    case 'type':
      return 0.2;
    case 'function':
    case 'method':
      return 0.15;
    case 'module':
    case 'namespace':
      return 0.08;
    case 'constructor':
      return 0.05;
    case 'field':
    case 'property':
    case 'constant':
      // Doc-commented fields otherwise outrank the functions that use them on NL queries.
      return -0.15;
    default:
      return 0;
  }
}

export function isFieldKind(kind: string): boolean {
  return kind === 'field' || kind === 'property' || kind === 'constant';
}

export function isPrivate(sym: Pick<SymbolRow, 'name' | 'signature'>): boolean {
  return /(^|\s)private\s/.test(sym.signature + ' ') || /^[_#]/.test(sym.name);
}

/** `com.acme.billing.RefundService.computeRefund` -> `RefundService.computeRefund`. */
export function shortQ(qname: string, name?: string): string {
  const parts = qname.split('.').filter(Boolean);
  if (!parts.length) return name || '';
  const [a, b] = parts.slice(-2);
  // "com.acme.billing.RefundService": a lower-case package segment adds nothing.
  if (b !== undefined && /^[a-z]/.test(a) && /^[A-Z]/.test(b) && parts.length > 2) return b;
  return parts.length <= 2 ? parts.join('.') : `${a}.${b}`;
}

export function plural(n: number, word: string, many = word + 's'): string {
  return `${n} ${n === 1 ? word : many}`;
}

export function h(id: number): string {
  return symbolHandle(id);
}

export function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i + 1);
}

export function baseName(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

export function stemOf(path: string): string {
  const b = baseName(path);
  const i = b.indexOf('.');
  return i <= 0 ? b : b.slice(0, i);
}

/** SQLite lower() only folds ASCII; mirror it so `lower(name) = ?` hits the index consistently. */
export function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

export function byScoreThen<T extends { score: number; row: { path: string; start_line: number; id: number } }>(a: T, b: T): number {
  return b.score - a.score || (a.row.path < b.row.path ? -1 : a.row.path > b.row.path ? 1 : 0) || a.row.start_line - b.row.start_line || a.row.id - b.row.id;
}

/** Group items by file path, preserving the order in which files first appear. */
export function groupByPath<T>(items: T[], pathOf: (x: T) => string): Array<[string, T[]]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const p = pathOf(it);
    const arr = m.get(p);
    if (arr) arr.push(it);
    else m.set(p, [it]);
  }
  return [...m.entries()];
}

// ---------------------------------------------------------------------------------------------
// Pointer rendering (find hits, ambiguity lists)

export function pointerLine(row: Pick<SymRow, 'id' | 'start_line' | 'end_line' | 'kind' | 'signature' | 'name' | 'doc'>, withDoc: boolean, sigMax = 140): string {
  const sig = clip(row.signature || row.name, sigMax);
  const doc = withDoc && row.doc ? ` — ${clip(row.doc, 90)}` : '';
  return `  ${h(row.id)} ${row.start_line}-${row.end_line} ${row.kind} ${sig}${doc}`;
}

/** Minimal pointer used when the full signature does not fit the budget. */
export function compactLine(row: Pick<SymRow, 'id' | 'start_line' | 'end_line' | 'kind' | 'name' | 'qname'>): string {
  return `  ${h(row.id)} ${row.start_line}-${row.end_line} ${row.kind} ${shortQ(row.qname, row.name)}`;
}

/** Files in first-appearance order, path printed once, hits indented below. */
export function renderGrouped(rows: SymRow[], lineOf: (r: SymRow) => string): string {
  const out: string[] = [];
  for (const [path, list] of groupByPath(rows, (r) => r.path)) {
    out.push(path);
    for (const r of list) out.push(lineOf(r));
  }
  return out.join('\n');
}
