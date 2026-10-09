// kopt_find: ranked pointers (hits) or a task-level context pack (pointers + best bodies + callers).

import type { FindParams } from '../core/api.js';
import type { ToolContext } from '../core/context.js';
import { estimateTokens, tokensToChars } from '../core/tokens.js';
import type { ToolResult } from '../core/types.js';
import type { Store } from '../store/store.js';
import { queryTerms } from '../indexer/terms.js';
import { budgetOf, compactLine, compose, guard, h, isFieldKind, moreSuffix, pathFilter, plural, pointerLine, quote, renderGrouped, result, shortQ, type SymRow } from './common.js';
import { type Section, symbolSection } from './read.js';
import { type Candidate, diversify, identifierTokens, relevantCount, search } from './search.js';
import { isContainer } from './skeleton.js';

const KINDS = new Set(['class', 'interface', 'enum', 'type', 'record', 'struct', 'trait', 'module', 'namespace', 'function', 'method', 'constructor', 'field', 'property', 'constant']);
/** Bodies longer than this are packed as skeletons. */
const PACK_BODY_MAX_LINES = 80;
const PACK_MAX_BODIES = 3;

function intIn(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Number(v);
  if (v === undefined || v === null || !Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

interface Selection {
  rows: SymRow[];
  /** Rendered line per symbol id (full, with doc, or compact). */
  lines: Map<number, string>;
}

/**
 * Greedy selection in rank order (path line counted once per file). A hit whose full line does not fit is
 * shown compact (handle, range, kind, name); docs are added afterwards while the budget allows.
 */
function selectHits(list: Candidate[], limit: number, budgetChars: number, docs: boolean): Selection {
  const rows: SymRow[] = [];
  const lines = new Map<number, string>();
  const files = new Set<string>();
  let used = 0;
  for (const c of list) {
    if (rows.length >= limit) break;
    const pathCost = files.has(c.row.path) ? 0 : c.row.path.length + 1;
    let line = pointerLine(c.row, false);
    if (used + pathCost + line.length + 1 > budgetChars) {
      line = compactLine(c.row);
      if (used + pathCost + line.length + 1 > budgetChars) break;
    }
    rows.push(c.row);
    lines.set(c.row.id, line);
    files.add(c.row.path);
    used += pathCost + line.length + 1;
  }
  if (docs) {
    for (const r of rows) {
      const cur = lines.get(r.id)!;
      if (!r.doc || cur !== pointerLine(r, false)) continue;
      const withDoc = pointerLine(r, true);
      if (used + withDoc.length - cur.length > budgetChars) continue;
      lines.set(r.id, withDoc);
      used += withDoc.length - cur.length;
    }
  }
  return { rows, lines };
}

function noHits(query: string, filtered: boolean, maxTokens: number): ToolResult {
  const what = `find ${quote(query)}`;
  if (!queryTerms(query).length && !identifierTokens(query).length) {
    return result(`${what} · 0 hits · no searchable terms; use identifiers or domain words`, maxTokens, { hits: 0 });
  }
  const hint = filtered
    ? 'next: retry without path/kinds filters'
    : 'next: try other words (synonyms, a class or file name) or kopt_outline . for the repo map';
  return result(compose((tok) => `${what} · 0 hits · ~${tok} tok`, hint, maxTokens), maxTokens, { hits: 0 });
}

const CALLERS_SQL = `SELECT r.from_symbol_id AS id, s.name AS name, s.qname AS qname, count(*) AS n
  FROM refs r JOIN symbols s ON s.id = r.from_symbol_id
  WHERE r.to_symbol_id IN (SELECT value FROM json_each(?))
  GROUP BY r.from_symbol_id ORDER BY n DESC, s.rank DESC, s.id LIMIT 200`;
const CTOR_IDS_SQL = "SELECT id FROM symbols WHERE parent_id = ? AND kind = 'constructor'";
const UNRESOLVED_NAME_COUNT_SQL = 'SELECT count(*) AS n FROM refs WHERE name = ? AND to_symbol_id IS NULL';

/** Target ids whose usages count as usages of `sym` (a class is also used through its constructors). */
export function usageTargets(store: Store, sym: { id: number; kind: string }): number[] {
  const ids = [sym.id];
  if (isContainer(sym.kind)) for (const r of store.prepare(CTOR_IDS_SQL).all(sym.id) as unknown as Array<{ id: number }>) ids.push(r.id);
  return ids;
}

function callersLine(store: Store, top: SymRow, maxChars: number): string | undefined {
  const rows = store.prepare(CALLERS_SQL).all(JSON.stringify(usageTargets(store, top))) as unknown as Array<{ id: number; name: string; qname: string }>;
  const head = `callers of ${h(top.id)}:`;
  if (!rows.length) {
    const n = (store.prepare(UNRESOLVED_NAME_COUNT_SQL).get(top.name) as { n: number }).n;
    return n ? `${head} none resolved; ${n} unresolved refs named ${top.name} (kopt_refs ${h(top.id)})` : `${head} none found`;
  }
  const parts: string[] = [];
  let used = head.length;
  for (const r of rows) {
    const p = `${h(r.id)} ${shortQ(r.qname, r.name)}`;
    if (used + p.length + 2 + 12 > maxChars) break;
    parts.push(p);
    used += p.length + 2;
  }
  if (!parts.length) return undefined;
  const more = rows.length - parts.length;
  return `${head} ${parts.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`;
}

function overlaps(a: SymRow, b: SymRow): boolean {
  return a.path === b.path && a.start_line <= b.end_line && b.start_line <= a.end_line;
}

export function find(store: Store, p: FindParams, ctx: ToolContext): ToolResult {
  ctx.ledger.tick();
  const mode = p?.mode === 'pack' ? 'pack' : 'hits';
  const maxTokens = budgetOf(p?.maxTokens, mode === 'pack' ? ctx.config.budgets.pack : ctx.config.budgets.find);
  const query = typeof p?.query === 'string' ? p.query.trim() : '';
  if (!query) return result('find: query is required (words or identifiers, e.g. "compute refund" or OrderService.place)', maxTokens);
  return guard('find', maxTokens, () => findImpl(store, p, ctx, mode, query, maxTokens));
}

function findImpl(store: Store, p: FindParams, ctx: ToolContext, mode: 'hits' | 'pack', query: string, maxTokens: number): ToolResult {
  const limit = intIn(p.limit, 1, 100, mode === 'pack' ? 8 : 12);
  const kinds = Array.isArray(p.kinds) ? p.kinds.filter((k) => KINDS.has(k)) : undefined;
  const filter = pathFilter(p.path, store.root);

  const sr = search(store, query, { kinds, filter, pathText: p.path });
  const ranked = diversify(sr.ranked, sr.targetStems, 3, filter?.exact);
  if (!ranked.length) return noHits(query, !!(filter || kinds?.length), maxTokens);
  const relevant = relevantCount(ranked);
  const what = `${mode === 'pack' ? 'pack' : 'find'} ${quote(query)}`;
  const n = Math.min(limit, ranked.length);
  const headReserve = estimateTokens(`${what} · ${plural(n, 'hit')} · ${mode === 'pack' ? '3 bodies · ' : ''}~${maxTokens} tok${moreSuffix(ranked.length)}`) + 1;
  const lineOf = (sel: Selection) => (r: SymRow) => sel.lines.get(r.id)!;

  if (mode === 'hits') {
    let sel = selectHits(ranked, limit, tokensToChars(Math.max(0, maxTokens - headReserve)), true);
    let suffix = moreSuffix;
    if (!sel.rows.length) {
      // Tiny budget: a short "+k more" leaves room for at least the top hit.
      suffix = (k: number) => (k > 0 ? ` · +${k} more` : '');
      const shortReserve = estimateTokens(`${what} · 1 hit · ~${maxTokens} tok${suffix(ranked.length)}`) + 1;
      sel = selectHits(ranked, limit, tokensToChars(Math.max(0, maxTokens - shortReserve)), false);
    }
    const more = Math.max(0, Math.max(relevant, n) - sel.rows.length);
    const body = renderGrouped(sel.rows, lineOf(sel));
    const text = compose((tok) => `${what} · ${plural(sel.rows.length, 'hit')} · ~${tok} tok${suffix(more)}`, body, maxTokens);
    return result(text, maxTokens, { mode, hits: sel.rows.length, more, top: sel.rows[0]?.id });
  }

  // pack: pointers (<= ~30% of budget), then bodies, then one callers line.
  const avail = Math.max(0, maxTokens - headReserve);
  const ptr = selectHits(ranked, limit, tokensToChars(Math.floor(avail * 0.3)), false);
  const pointers = renderGrouped(ptr.rows, lineOf(ptr));
  const callersReserve = Math.min(80, Math.floor(avail * 0.1));
  let remaining = avail - estimateTokens(pointers) - callersReserve - 2;

  const chosen: Candidate[] = [];
  const top = ranked[0];
  for (const c of ranked) {
    if (chosen.length >= PACK_MAX_BODIES) break;
    if (chosen.length && c.score < 0.6 * top.score) break;
    // A field's body is its signature, already in the pointer list.
    if (isFieldKind(c.row.kind) || chosen.some((x) => overlaps(x.row, c.row))) continue;
    chosen.push(c);
  }
  const sections: string[] = [];
  let bodies = 0;
  for (const c of chosen) {
    if (remaining < 20) break;
    const file = store.fileById(c.row.file_id);
    if (!file) continue;
    const long = c.row.end_line - c.row.start_line + 1 > PACK_BODY_MAX_LINES;
    const want: 'body' | 'skeleton' = isContainer(c.row.kind) || long ? 'skeleton' : 'body';
    let sec: Section = symbolSection(store, c.row, file, { mode: want, ctx, fresh: !!p.fresh, maxTokens: remaining });
    if (estimateTokens(sec.text) > remaining && want === 'body') {
      sec = symbolSection(store, c.row, file, { mode: 'skeleton', ctx, fresh: !!p.fresh, maxTokens: remaining });
    }
    const t = estimateTokens(sec.text) + 1;
    if (sec.kind === 'error' || t > remaining) continue;
    sec.commit?.();
    sections.push(sec.text);
    if (sec.kind === 'body' || sec.kind === 'skeleton') bodies++;
    remaining -= t;
  }
  // Callers of the best symbol actually packed (the top hit may be a field, which is never packed).
  const focus = chosen[0]?.row ?? top.row;
  const callers = callersLine(store, focus, tokensToChars(callersReserve + Math.max(0, remaining)));
  const body = [pointers, ...sections, callers ?? ''].filter(Boolean).join('\n\n');
  const more = Math.max(0, relevant - ptr.rows.length);
  const text = compose((tok) => `${what} · ${plural(ptr.rows.length, 'hit')} · ${plural(bodies, 'body', 'bodies')} · ~${tok} tok${moreSuffix(more)}`, body, maxTokens);
  return result(text, maxTokens, { mode, hits: ptr.rows.length, bodies, more, top: focus.id });
}
