// kopt_read: symbol bodies / skeletons / cards, ranges and files, with ledger dedup and staleness handling.

import type { ReadParams } from '../core/api.js';
import type { ToolContext } from '../core/context.js';
import { estimateTokens, tokensToChars } from '../core/tokens.js';
import type { ExtractedFile, ToolResult } from '../core/types.js';
import type { FileRow, SymbolRow } from '../store/schema.js';
import type { Store } from '../store/store.js';
import {
  type SymRow,
  budgetOf,
  clip,
  compose,
  coveringShownRange,
  guard,
  h,
  noteShownRange,
  pointerLine,
  quote,
  renderGrouped,
  result,
  sha1,
  shortQ,
  unchangedLine,
  withNote,
} from './common.js';
import { fileSymbols, resolveTarget, type ResolvedTarget, type SymbolCandidate } from './resolve.js';
import { search } from './search.js';
import { descendantIds, fitEntries, functionSkeleton, isContainer, skeletonEntries } from './skeleton.js';
import { type Located, type Source, currentExtraction, loadSource, locate, relocate, sliceLines } from './source.js';
import { methodFamily, unresolvedCount } from './usage.js';

/** Largest maxTokens a caller may pass (MAX_TOKENS_CAP of the MCP layer): one call can return up to this. */
export const READ_CAP = 8000;
/** Defaults of budgets.readSymbol / budgets.readFile for configs written before they existed. */
const READ_SYMBOL_DEFAULT = 6000;
const READ_FILE_DEFAULT = 4000;

/**
 * Budgets of one read call. Without an explicit maxTokens, a named function gets up to `symbol` tokens and a file
 * or type up to `file` tokens verbatim (one call instead of a skeleton card plus a re-read); ranges keep `range`.
 */
interface ReadBudgets {
  range: number;
  symbol: number;
  file: number;
  explicit: boolean;
}

export type ReadMode = 'body' | 'skeleton' | 'card';

/** A rendered piece of output that is only recorded in the ledger once actually sent. */
export interface Section {
  text: string;
  kind: 'body' | 'skeleton' | 'unchanged' | 'card' | 'error';
  commit?: () => void;
}

const staleNote = (loc: Located): string | undefined =>
  loc.how === 'relocated'
    ? 'note: file changed since indexing; lines re-located'
    : loc.how === 'stale'
      ? 'note: file changed since indexing and the symbol was not found; lines may be off (run kopt index)'
      : undefined;

function digestFn(src: Source): (s: number, e: number) => string {
  return (s, e) => sha1(sliceLines(src, s, e));
}

/** Dedup check for a range that is about to be sent. */
function alreadyShown(ctx: ToolContext, key: string, path: string, start: number, end: number, src: Source, digest: string): number | undefined | false {
  if (ctx.ledger.wasShown(key, digest)) return ctx.ledger.shownAt(key);
  const cover = coveringShownRange(ctx.ledger, path, start, end, digestFn(src));
  if (cover) return ctx.ledger.shownAt(cover.key);
  return false;
}

function commitRange(ctx: ToolContext, key: string, digest: string, path: string, start: number, end: number): void {
  ctx.ledger.markShown(key, digest);
  noteShownRange(ctx.ledger, path, start, end, key);
}

// ---------------------------------------------------------------------------------------------
// Symbol sections

export interface SymbolSectionOpts {
  mode: 'body' | 'skeleton';
  ctx: ToolContext;
  fresh?: boolean;
  /** Budget for this section (tokens). */
  maxTokens: number;
}

/** Body (verbatim, deduped) or skeleton of one symbol. Falls back to a skeleton when the body does not fit. */
export function symbolSection(store: Store, sym: SymbolRow, file: FileRow, o: SymbolSectionOpts): Section & { overBudget?: { tokens: number; start: number; end: number } } {
  const src = loadSource(store, file.path, file);
  if (!src) return { kind: 'error', text: `${file.path}: source not available (file missing on disk)` };
  const loc = locate(store, src, sym);
  const handle = h(sym.id);
  const loc0 = `${file.path}:${loc.start}-${loc.end}`;
  const note = staleNote(loc);

  if (o.mode === 'body') {
    const body = sliceLines(src, loc.start, loc.end);
    const digest = sha1(body);
    const key = `sym:${sym.id}`;
    if (!o.fresh) {
      const shown = alreadyShown(o.ctx, key, file.path, loc.start, loc.end, src, digest);
      if (shown !== false) return { kind: 'unchanged', text: unchangedLine(loc0, handle, shown) };
    }
    const text = [`${loc0} ${handle}`, body, ...(note ? [note] : [])].join('\n');
    if (estimateTokens(text) <= o.maxTokens) {
      return { kind: 'body', text, commit: () => commitRange(o.ctx, key, digest, file.path, loc.start, loc.end) };
    }
    const sk = skeletonSection(store, sym, file, src, loc, o.maxTokens);
    return { ...sk, overBudget: { tokens: estimateTokens(body), start: loc.start, end: loc.end } };
  }
  return skeletonSection(store, sym, file, src, loc, o.maxTokens);
}

function skeletonSection(store: Store, sym: SymbolRow, file: FileRow, src: Source, loc: Located, maxTokens: number): Section {
  const head = `${file.path}:${loc.start}-${loc.end} ${h(sym.id)} skeleton`;
  const note = staleNote(loc);
  if (isContainer(sym.kind)) {
    const rows = fileSymbols(store, file.id);
    const ids = new Set(descendantIds(rows, sym.id));
    const sub = rows.filter((r) => ids.has(r.id));
    const root = sub.find((r) => r.id === sym.id) ?? sym;
    const lineOf = lineMapper(store, src, sub);
    const entries = skeletonEntries(sub, [root], lineOf);
    if (root.doc && entries.length) entries[0].text += ` — ${clip(root.doc, 120)}`;
    const reserve = estimateTokens(head) + (note ? estimateTokens(note) : 0) + 20;
    const fit = fitEntries(entries, Math.max(1, maxTokens - reserve));
    const tail = fit.omitted ? [`… ${fit.omitted} members omitted (private/fields first)`] : [];
    return { kind: 'skeleton', text: [head, ...fit.lines, ...tail, ...(note ? [note] : [])].join('\n') };
  }
  return { kind: 'skeleton', text: [head, ...functionSkeleton(store, sym), ...(note ? [note] : [])].join('\n') };
}

/** Start-line mapper for skeletons of possibly stale files. */
function lineMapper(store: Store, src: Source, rows: SymbolRow[]): (s: SymbolRow) => number {
  if (!src.stale) return (s) => s.start_line;
  const cache = new Map<number, number>();
  for (const r of rows) cache.set(r.id, locate(store, src, r).start);
  return (s) => cache.get(s.id) ?? s.start_line;
}

/** Sub-ranges of roughly `chunkTokens` each, split at line boundaries (prefers blank lines). */
export function subRanges(src: Source, start: number, end: number, chunkTokens: number, max = 4): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const budget = tokensToChars(chunkTokens);
  let a = start;
  let used = 0;
  let lastBlank = -1;
  for (let i = start; i <= end; i++) {
    const len = (src.lines[i - 1] ?? '').length + 1;
    if (used + len > budget && i > a) {
      const cut = lastBlank > a + (i - a) / 2 ? lastBlank : i - 1;
      out.push([a, cut]);
      a = cut + 1;
      used = 0;
      for (let j = a; j <= i; j++) used += (src.lines[j - 1] ?? '').length + 1;
      lastBlank = -1;
      if (out.length >= max) break;
      continue;
    }
    used += len;
    if (!(src.lines[i - 1] ?? '').trim()) lastBlank = i;
  }
  if (out.length < max && a <= end) out.push([a, end]);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Cards

const CALLERS_COUNT_SQL = 'SELECT count(*) AS n, count(DISTINCT file_id) AS f FROM refs WHERE to_symbol_id = ?';
const CALLEES_COUNT_SQL = "SELECT count(DISTINCT name) AS n FROM refs WHERE from_symbol_id = ? AND kind IN ('call', 'new')";
const MEMBERS_COUNT_SQL = 'SELECT count(*) AS n FROM symbols WHERE parent_id = ?';
const IMPORTS_COUNT_SQL = 'SELECT count(*) AS n FROM file_imports WHERE file_id = ?';
const IMPORTERS_COUNT_SQL = 'SELECT count(DISTINCT file_id) AS n FROM file_imports WHERE target_file_id = ?';
const FILE_SYMS_COUNT_SQL = 'SELECT count(*) AS n FROM symbols WHERE file_id = ?';
const TOP_SYMS_SQL = 'SELECT name FROM symbols WHERE file_id = ? AND parent_id IS NULL ORDER BY exported DESC, rank DESC, start_line LIMIT 8';

const num = (store: Store, sql: string, ...args: Array<string | number>) => (store.prepare(sql).get(...args) as { n: number }).n;

export function symbolCard(store: Store, sym: SymbolRow, file: FileRow): string {
  const callers = store.prepare(CALLERS_COUNT_SQL).get(sym.id) as { n: number; f: number };
  const callees = num(store, CALLEES_COUNT_SQL, sym.id);
  const members = num(store, MEMBERS_COUNT_SQL, sym.id);
  const unresolved = callers.n < 3 ? unresolvedCount(store, sym, methodFamily(store, sym)) : 0;
  const lines = [
    `${h(sym.id)} ${sym.kind} ${shortQ(sym.qname, sym.name)} · ${file.path}:${sym.start_line}-${sym.end_line} (${sym.end_line - sym.start_line + 1} lines)`,
    clip(sym.signature || sym.name, 300),
  ];
  if (sym.doc) lines.push(`// ${clip(sym.doc, 200)}`);
  const parts = [`callers ${callers.n} in ${callers.f} files`];
  if (unresolved) parts.push(`${unresolved} unresolved same-name refs`);
  parts.push(`callees ${callees}`);
  if (members) parts.push(`members ${members}`);
  lines.push(parts.join(' · '));
  return lines.join('\n');
}

function fileCard(store: Store, path: string, file: FileRow | undefined, src: Source | undefined): string {
  const n = src?.lines.length ?? file?.line_count ?? 0;
  const parts = [path];
  if (file?.lang) parts.push(file.lang);
  parts.push(`${n} lines`);
  if (file) {
    parts.push(`${num(store, FILE_SYMS_COUNT_SQL, file.id)} symbols`);
    parts.push(`imports ${num(store, IMPORTS_COUNT_SQL, file.id)}`);
    parts.push(`imported by ${num(store, IMPORTERS_COUNT_SQL, file.id)}`);
  }
  const lines = [parts.join(' · ')];
  if (file) {
    const top = (store.prepare(TOP_SYMS_SQL).all(file.id) as unknown as Array<{ name: string }>).map((r) => r.name);
    if (top.length) lines.push(`top: ${top.join(', ')}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// File skeletons (shared with outline)

/** Symbols of a file with current line numbers (re-extracted or re-located when the file is stale). */
function currentSymbols(store: Store, src: Source, file: FileRow): { rows: SymbolRow[]; note?: string } {
  const rows = fileSymbols(store, file.id);
  if (!src.stale || !rows.length) return { rows };
  const ef = currentExtraction(store, src);
  if (ef) return { rows: fromExtracted(ef, file.id) };
  const moved = rows.map((r) => {
    const loc = relocate(src, r);
    return loc ? { ...r, start_line: loc.start, end_line: loc.end } : r;
  });
  return { rows: moved, note: 'note: file changed since indexing; line numbers re-located (approximate)' };
}

function fromExtracted(ef: ExtractedFile, fileId: number): SymbolRow[] {
  // Synthetic negative ids: these rows are only rendered, never used as handles.
  return ef.symbols.map((s, i) => ({
    id: -(i + 1),
    file_id: fileId,
    name: s.name,
    qname: s.qualifiedName,
    kind: s.kind,
    start_line: s.startLine,
    end_line: s.endLine,
    start_byte: s.startByte,
    end_byte: s.endByte,
    signature: s.signature,
    doc: s.doc ?? null,
    parent_id: s.parent !== undefined ? -(s.parent + 1) : null,
    exported: s.exported ? 1 : 0,
    rank: 0,
  }));
}

export interface FileSkeleton {
  lines: string[];
  omitted: number;
  symbols: number;
  note?: string;
}

/** Whole-file skeleton (top-level declarations + members, line-prefixed), trimmed to `maxTokens`. */
export function fileSkeleton(store: Store, src: Source, file: FileRow | undefined, maxTokens: number): FileSkeleton {
  if (!file) return markdownOrEmpty(src, maxTokens);
  const { rows, note } = currentSymbols(store, src, file);
  if (!rows.length) return markdownOrEmpty(src, maxTokens);
  const ids = new Set(rows.map((r) => r.id));
  const roots = rows.filter((r) => r.parent_id === null || !ids.has(r.parent_id));
  const entries = skeletonEntries(rows, roots);
  const fit = fitEntries(entries, Math.max(1, maxTokens - (note ? estimateTokens(note) + 1 : 0)));
  return { lines: fit.lines, omitted: fit.omitted, symbols: rows.length, note };
}

function markdownOrEmpty(src: Source, maxTokens: number): FileSkeleton {
  if (!/\.(md|mdx|markdown|rst|adoc)$/i.test(src.path)) return { lines: [], omitted: 0, symbols: 0 };
  const entries: Array<{ text: string; depth: number }> = [];
  let fence = false;
  src.lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    const m = !fence && /^(#{1,6})\s+(.+)$/.exec(l);
    if (m) entries.push({ depth: m[1].length - 1, text: `${'  '.repeat(m[1].length - 1)}L${i + 1} ${clip(m[2], 120)}` });
  });
  const budget = tokensToChars(maxTokens);
  const lines: string[] = [];
  let used = 0;
  // Deeper headings go first when over budget.
  const maxDepth = entries.reduce((d, e) => Math.max(d, e.depth), 0);
  let keepDepth = maxDepth;
  while (keepDepth > 0 && entries.filter((e) => e.depth <= keepDepth).reduce((n, e) => n + e.text.length + 1, 0) > budget) keepDepth--;
  const kept = entries.filter((e) => e.depth <= keepDepth);
  for (const e of kept) {
    if (used + e.text.length + 1 > budget) break;
    lines.push(e.text);
    used += e.text.length + 1;
  }
  return { lines, omitted: entries.length - lines.length, symbols: entries.length };
}

// ---------------------------------------------------------------------------------------------
// read()

/** Budget suggestion rounded up to a multiple of 100, capped at READ_CAP. */
function roundUp(tokens: number): number {
  return Math.min(READ_CAP, Math.ceil(tokens / 100) * 100);
}

function message(text: string, maxTokens: number, meta?: Record<string, unknown>): ToolResult {
  return result(text, maxTokens, meta);
}

/** "did you mean" suggestions for a name that resolved to nothing. */
export function suggest(store: Store, query: string, max = 3): string {
  if (!/[A-Za-z]/.test(query)) return '';
  try {
    const { ranked } = search(store, query, { pool: 60 });
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of ranked) {
      const label = `${h(c.row.id)} ${shortQ(c.row.qname, c.row.name)}`;
      if (seen.has(label)) continue;
      seen.add(label);
      out.push(label);
      if (out.length >= max) break;
    }
    return out.length ? `; did you mean ${out.join(', ')}?` : '';
  } catch {
    return '';
  }
}

function noneResult(store: Store, t: Extract<ResolvedTarget, { kind: 'none' }>, maxTokens: number): ToolResult {
  const isName = t.query && !/[\s/]/.test(t.query) && t.message.startsWith('no symbol');
  const s = isName ? suggest(store, t.query) : '';
  const tail = isName ? (s || `; try kopt_find ${quote(t.query.toLowerCase())}`) : '';
  return message(`${t.message}${tail}`, maxTokens, { resolved: 'none' });
}

export function ambiguousText(what: string, candidates: SymbolCandidate[], total: number, maxTokens: number): string {
  const rows = candidates.map((c) => ({ ...c.symbol, path: c.file.path, file_rank: c.file.rank })) as SymRow[];
  const first = candidates[0];
  const qual = first ? shortQ(first.symbol.qname, first.symbol.name) : '';
  const hint = `next: kopt_read ${first ? h(first.symbol.id) : '#id'}${qual.includes('.') ? ` (or a qualified name like ${qual})` : ''}`;
  const more = total > candidates.length ? ` · +${total - candidates.length} more` : '';
  return compose((tok) => `${what} · ${total} candidates · ~${tok} tok${more}`, `${renderGrouped(rows, (r) => pointerLine(r, false))}\n${hint}`, maxTokens);
}

/** Budgets of a read call (see ReadBudgets). */
export function readBudgets(config: ToolContext['config'], requested: unknown): ReadBudgets {
  const b = config.budgets;
  const range = budgetOf(requested, b.read);
  const n = Number(requested);
  const explicit = requested !== undefined && requested !== null && Number.isFinite(n) && n > 0;
  if (explicit) return { range, symbol: range, file: range, explicit };
  const symbol = Math.min(READ_CAP, Math.max(range, budgetOf(b.readSymbol, READ_SYMBOL_DEFAULT)));
  const file = Math.min(READ_CAP, Math.max(range, budgetOf(b.readFile, READ_FILE_DEFAULT)));
  return { range, symbol, file, explicit };
}

/** Largest output a read call may return (the MCP layer's safety cap when the call omits maxTokens). */
export function readCap(config: ToolContext['config'], requested?: unknown): number {
  const r = readBudgets(config, requested);
  return Math.max(r.range, r.symbol, r.file);
}

export function read(store: Store, p: ReadParams, ctx: ToolContext): ToolResult {
  ctx.ledger.tick();
  const budgets = readBudgets(ctx.config, p?.maxTokens);
  const maxTokens = budgets.range;
  const target = typeof p?.target === 'string' ? p.target : '';
  const mode = p?.mode;
  if (mode !== undefined && mode !== 'body' && mode !== 'skeleton' && mode !== 'card') {
    return message(`unknown mode "${String(mode)}"; use body, skeleton or card`, maxTokens);
  }
  const cap = Math.max(budgets.range, budgets.symbol, budgets.file);
  return guard('read', cap, () => readTarget(store, resolveTarget(store, target), mode, ctx, budgets, !!p.fresh));
}

function readTarget(store: Store, t: ResolvedTarget, mode: ReadMode | undefined, ctx: ToolContext, b: ReadBudgets, fresh: boolean): ToolResult {
  const maxTokens = b.range;
  switch (t.kind) {
    case 'none':
      return noneResult(store, t, maxTokens);
    case 'dir':
      return message(`${t.path || '.'} is a directory; use kopt_outline ${t.path || '.'}`, maxTokens);
    case 'ambiguous': {
      const text = ambiguousText(`read ${quote(t.query)}`, t.candidates, t.total, maxTokens);
      return message(text, maxTokens, { resolved: 'ambiguous', candidates: t.total });
    }
    case 'symbol': {
      // A named function comes whole up to budgets.readSymbol, a type up to budgets.readFile (like a file).
      const m = mode ?? 'body';
      const budget = m === 'body' ? (isContainer(t.symbol.kind) ? b.file : b.symbol) : maxTokens;
      return withNote(readSymbol(store, t.symbol, t.file, m, ctx, budget, fresh, b.explicit), t.note, budget);
    }
    case 'range':
      return readRange(store, t.path, t.file, t.start, t.end, ctx, maxTokens, fresh);
    case 'file':
      return readFile(store, t.path, t.file, mode, ctx, b, fresh);
  }
}

function readSymbol(store: Store, sym: SymbolRow, file: FileRow, mode: ReadMode, ctx: ToolContext, maxTokens: number, fresh: boolean, explicit = true): ToolResult {
  const meta = { resolved: 'symbol', mode };
  if (mode === 'card') return result(symbolCard(store, sym, file), maxTokens, meta);
  const sec = symbolSection(store, sym, file, { mode, ctx, fresh, maxTokens });
  if (sec.kind === 'error' || sec.kind === 'unchanged') return result(sec.text, maxTokens, { ...meta, outcome: sec.kind });
  if (!sec.overBudget) {
    sec.commit?.();
    return result(sec.text, maxTokens, { ...meta, outcome: sec.kind });
  }
  const src = loadSource(store, file.path, file)!;
  const ob = sec.overBudget;
  // A long function read by name, no budget given: its code from the top, and the exact range of the rest
  // (a skeleton would only make the agent call again for the code).
  if (!explicit && !isContainer(sym.kind)) return symbolHead(store, sym, file, src, ob, ctx, maxTokens, fresh);
  sec.commit?.();
  // Body over budget: skeleton + where to read in parts.
  let hint: string;
  if (isContainer(sym.kind)) {
    hint = `body ~${ob.tokens} tok > maxTokens ${maxTokens}; read a member with kopt_read ${file.path}:<L> or raise maxTokens`;
  } else if (ob.tokens + 60 <= READ_CAP) {
    // One more call returns it all: never suggest several part reads when one fits.
    hint = `body ~${ob.tokens} tok > maxTokens ${maxTokens}; pass maxTokens ${roundUp(ob.tokens + 60)} to read it whole`;
  } else {
    // Too big for one call: parts as large as a call allows.
    const parts = subRanges(src, ob.start, ob.end, Math.floor(READ_CAP * 0.9), 4);
    const last = parts[parts.length - 1];
    const list = parts.map(([a, b], i) => (i === 0 ? `${file.path}:${a}-${b}` : `${a}-${b}`)).join(', ');
    const rest = last && last[1] < ob.end ? ', …' : '';
    hint = `body ~${ob.tokens} tok > maxTokens ${maxTokens}; read it in parts with maxTokens ${READ_CAP}: ${list}${rest}`;
  }
  // Rebuild the skeleton with exactly what the hint leaves.
  const loc = locate(store, src, sym);
  const sk = skeletonSection(store, sym, file, src, loc, Math.max(1, maxTokens - estimateTokens(hint) - 1));
  return result(`${sk.text}\n${hint}`, maxTokens, { ...meta, outcome: 'skeleton-over-budget' });
}

/** First part of an over-budget function body, verbatim, then the range of the rest in as few calls as possible. */
function symbolHead(store: Store, sym: SymbolRow, file: FileRow, src: Source, ob: { tokens: number; start: number; end: number }, ctx: ToolContext, maxTokens: number, fresh: boolean): ToolResult {
  const meta = { resolved: 'symbol', mode: 'body', outcome: 'body-head' };
  const handle = h(sym.id);
  const restHint = (from: number) => {
    const rest = estimateTokens(sliceLines(src, from, ob.end)) + 40;
    if (rest <= READ_CAP) return `next: kopt_read ${file.path}:${from}-${ob.end}${rest > maxTokens ? ` with maxTokens ${roundUp(rest)}` : ''} (rest of ${handle}, ~${rest - 40} tok)`;
    const parts = subRanges(src, from, ob.end, Math.floor(READ_CAP * 0.9), 3);
    const list = parts.map(([a, b2], i) => (i === 0 ? `${file.path}:${a}-${b2}` : `${a}-${b2}`)).join(', ');
    const last = parts[parts.length - 1];
    return `next: kopt_read ${list}${last && last[1] < ob.end ? ', …' : ''} with maxTokens ${READ_CAP} (rest of ${handle}, ~${rest - 40} tok)`;
  };
  const head = `${file.path}:${ob.start}-${ob.end} ${handle} (~${ob.tokens} tok; first part below)`;
  const reserve = estimateTokens(head) + estimateTokens(restHint(ob.start + 1)) + 4;
  const fit = fitRange(src, ob.start, ob.end, Math.max(1, maxTokens - reserve));
  if (fit.end < ob.start) return result(`${head}\n${restHint(ob.start)}`, maxTokens, meta);
  const body = sliceLines(src, ob.start, fit.end);
  const key = `range:${file.path}:${ob.start}-${fit.end}`;
  const digest = sha1(body);
  if (!fresh) {
    const shown = alreadyShown(ctx, key, file.path, ob.start, fit.end, src, digest);
    if (shown !== false) return result(`${unchangedLine(`${file.path}:${ob.start}-${fit.end}`, handle, shown)}\n${restHint(fit.end + 1)}`, maxTokens, { ...meta, outcome: 'unchanged' });
  }
  commitRange(ctx, key, digest, file.path, ob.start, fit.end);
  return result(`${head}\n${body}\n${restHint(fit.end + 1)}`, maxTokens, meta);
}

function readRange(store: Store, path: string, file: FileRow | undefined, start: number, end: number, ctx: ToolContext, maxTokens: number, fresh: boolean): ToolResult {
  const src = loadSource(store, path, file);
  if (!src) return message(`${path}: source not available`, maxTokens);
  const n = src.lines.length;
  if (start > n) return message(`${path} has ${n} lines; requested ${start}-${end}`, maxTokens);
  const e = Math.min(end, n);
  const fit = fitRange(src, start, e, maxTokens);
  if (fit.end < start) {
    const tok = estimateTokens(src.lines[start - 1] ?? '');
    return message(`${path}:${start} is a single line of ~${tok} tok (> maxTokens ${maxTokens}; minified or generated?)`, maxTokens, { resolved: 'range', outcome: 'too-long-line' });
  }
  const body = sliceLines(src, start, fit.end);
  const digest = sha1(body);
  const key = `range:${path}:${start}-${fit.end}`;
  const loc = `${path}:${start}-${fit.end}`;
  if (!fresh) {
    const shown = alreadyShown(ctx, key, path, start, fit.end, src, digest);
    if (shown !== false) return message(unchangedLine(loc, undefined, shown), maxTokens, { resolved: 'range', outcome: 'unchanged' });
  }
  commitRange(ctx, key, digest, path, start, fit.end);
  let hint = '';
  if (fit.end < e) {
    const rest = estimateTokens(sliceLines(src, fit.end + 1, e)) + 40;
    // The rest fits one call: say how, so the agent does not page through the range.
    hint = `\nnext: kopt_read ${path}:${fit.end + 1}-${e}${rest <= READ_CAP && rest > maxTokens ? ` with maxTokens ${roundUp(rest)}` : ''}`;
  }
  return result(`${loc}\n${body}${hint}`, maxTokens, { resolved: 'range', outcome: 'body', cut: fit.end < e });
}

/** Last line of [start, end] that fits with header + continuation hint (start - 1 when none does). */
function fitRange(src: Source, start: number, end: number, maxTokens: number): { end: number } {
  const budget = tokensToChars(maxTokens) - (src.path.length * 2 + 48);
  let used = 0;
  for (let i = start; i <= end; i++) {
    const len = (src.lines[i - 1] ?? '').length + 1;
    if (used + len > budget) return { end: i - 1 };
    used += len;
  }
  return { end };
}

function readFile(store: Store, path: string, file: FileRow | undefined, mode: ReadMode | undefined, ctx: ToolContext, b: ReadBudgets, fresh: boolean): ToolResult {
  const maxTokens = b.range;
  const src = loadSource(store, path, file);
  if (!src) return message(`${path}: source not available`, maxTokens);
  const n = src.lines.length;
  const meta = { resolved: 'file', mode: mode ?? 'auto' };
  if (mode === 'card') return result(fileCard(store, path, file, src), maxTokens, meta);
  const fullTokens = estimateTokens(src.text);
  // Without a budget, a file that fits budgets.readFile comes verbatim (a skeleton would be followed by a re-read).
  const bodyBudget = b.explicit ? maxTokens : b.file;
  const wantBody = mode === 'body' || mode === undefined;
  if (wantBody) {
    const head = `${path}:1-${n}`;
    if (estimateTokens(head) + fullTokens + 1 <= bodyBudget) {
      const digest = sha1(sliceLines(src, 1, n));
      const key = `range:${path}:1-${n}`;
      if (!fresh) {
        const shown = alreadyShown(ctx, key, path, 1, n, src, digest);
        if (shown !== false) return message(unchangedLine(head, undefined, shown), bodyBudget, { ...meta, outcome: 'unchanged' });
      }
      commitRange(ctx, key, digest, path, 1, n);
      return result(`${head}\n${sliceLines(src, 1, n)}`, bodyBudget, { ...meta, outcome: 'body' });
    }
  }
  // Skeleton (explicit, default for long files, or body over budget).
  const reserve = 60 + path.length;
  const sk = fileSkeleton(store, src, file, Math.max(1, maxTokens - reserve));
  if (!sk.lines.length) {
    // Nothing structural to show: head of the file + where to continue.
    return readRange(store, path, file, 1, n, ctx, maxTokens, fresh);
  }
  const whole = fullTokens + 40 <= READ_CAP ? ` (or the whole file: mode body, maxTokens ${roundUp(fullTokens + 40)})` : '';
  const bodyHint = wantBody ? `file ~${fullTokens} tok > maxTokens ${bodyBudget}; ` : '';
  const omitted = sk.omitted ? `${sk.omitted} entries omitted; ` : '';
  const hint = `${bodyHint}${omitted}read parts with kopt_read ${path}:<start>-<end>${whole}`;
  const text = [`${path}:1-${n} skeleton`, ...sk.lines, ...(sk.note ? [sk.note] : []), hint].join('\n');
  return result(text, maxTokens, { ...meta, outcome: 'skeleton', symbols: sk.symbols }, fullTokens);
}

