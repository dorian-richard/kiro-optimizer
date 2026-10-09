// Skeleton and card rendering: signatures with start lines, bodies elided, budget-trimmed by dropping
// private members and fields first.

import { CONTAINER_KINDS, type SymbolKind } from '../core/types.js';
import { estimateTokens, tokensToChars } from '../core/tokens.js';
import type { SymbolRow } from '../store/schema.js';
import type { Store } from '../store/store.js';
import { clip, isFieldKind, isPrivate } from './common.js';

export function isContainer(kind: string): boolean {
  return CONTAINER_KINDS.has(kind as SymbolKind);
}

export interface SkeletonEntry {
  sym: SymbolRow;
  depth: number;
  line: number;
  text: string;
  /** Lower tiers are dropped first when over budget (Infinity = never dropped). */
  tier: number;
}

/** Map parent id -> children (position order). Unknown parents are treated as roots. */
export function childrenIndex(rows: SymbolRow[]): Map<number | null, SymbolRow[]> {
  const ids = new Set(rows.map((r) => r.id));
  const m = new Map<number | null, SymbolRow[]>();
  for (const r of rows) {
    const p = r.parent_id !== null && ids.has(r.parent_id) ? r.parent_id : null;
    const arr = m.get(p);
    if (arr) arr.push(r);
    else m.set(p, [r]);
  }
  return m;
}

/** Ids of `root` and all its descendants. */
export function descendantIds(rows: SymbolRow[], rootId: number): number[] {
  const kids = childrenIndex(rows);
  const out: number[] = [];
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    out.push(id);
    for (const c of kids.get(id) ?? []) stack.push(c.id);
  }
  return out;
}

function tierOf(sym: SymbolRow, depth: number): number {
  if (depth === 0) return Infinity;
  const field = isFieldKind(sym.kind);
  const priv = isPrivate(sym);
  if (field && priv) return 1;
  if (field) return 2;
  if (priv) return 3;
  if (depth >= 2) return 4;
  if (/(^|\s)protected\s/.test(sym.signature + ' ')) return 5;
  return 6;
}

/**
 * Flatten roots + descendants into skeleton entries, depth-first in position order.
 * `lineOf` lets callers substitute re-located start lines for stale files.
 */
export function skeletonEntries(rows: SymbolRow[], roots: SymbolRow[], lineOf: (s: SymbolRow) => number = (s) => s.start_line): SkeletonEntry[] {
  const kids = childrenIndex(rows);
  const out: SkeletonEntry[] = [];
  const walk = (s: SymbolRow, depth: number) => {
    const line = lineOf(s);
    const sig = clip(s.signature || `${s.kind} ${s.name}`, 240);
    out.push({ sym: s, depth, line, text: `${'  '.repeat(depth)}L${line} ${sig}`, tier: tierOf(s, depth) });
    if (depth > 6) return;
    for (const c of kids.get(s.id) ?? []) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return out;
}

/**
 * Drop entries (lowest tier first, bottom-most first within a tier) until the joined text fits.
 * Returns kept lines and how many entries were omitted.
 */
export function fitEntries(entries: SkeletonEntry[], maxTokens: number): { lines: string[]; omitted: number } {
  const budget = tokensToChars(maxTokens);
  let total = entries.reduce((n, e) => n + e.text.length + 1, 0);
  const dropped = new Set<number>();
  if (total > budget) {
    const order = entries
      .map((e, i) => ({ e, i }))
      .filter((x) => x.e.tier !== Infinity)
      .sort((a, b) => a.e.tier - b.e.tier || b.i - a.i);
    for (const { e, i } of order) {
      if (total <= budget) break;
      dropped.add(i);
      total -= e.text.length + 1;
    }
  }
  let lines = entries.filter((_, i) => !dropped.has(i)).map((e) => e.text);
  let omitted = dropped.size;
  if (total > budget) {
    // Even top-level declarations do not fit: keep the head.
    const kept: string[] = [];
    let used = 0;
    for (const l of lines) {
      if (used + l.length + 1 > budget) break;
      kept.push(l);
      used += l.length + 1;
    }
    omitted += lines.length - kept.length;
    lines = kept;
  }
  return { lines, omitted };
}

const CALLS_SQL = `SELECT name, qualifier, kind, line, to_symbol_id FROM refs WHERE from_symbol_id = ? AND kind IN ('call', 'new') ORDER BY line, id LIMIT 400`;

/** "calls: a, repo.save, new Foo" for a function (distinct, in order of first use). */
export function callsLine(store: Store, symId: number, max = 24): string | undefined {
  const rows = store.prepare(CALLS_SQL).all(symId) as unknown as Array<{ name: string; qualifier: string | null; kind: string }>;
  if (!rows.length) return undefined;
  const seen = new Set<string>();
  const names: string[] = [];
  for (const r of rows) {
    const q = r.qualifier && r.qualifier.length <= 24 && !/[\s(]/.test(r.qualifier) ? r.qualifier + '.' : '';
    const n = (r.kind === 'new' ? 'new ' : '') + q + r.name;
    if (seen.has(n)) continue;
    seen.add(n);
    names.push(n);
  }
  const shown = names.slice(0, max);
  return `calls: ${shown.join(', ')}${names.length > max ? `, +${names.length - max}` : ''}`;
}

/** Skeleton of a function-like symbol: signature, doc, calls. */
export function functionSkeleton(store: Store, sym: SymbolRow): string[] {
  const out = [sym.signature || `${sym.kind} ${sym.name}`];
  if (sym.doc) out.push(`// ${clip(sym.doc, 200)}`);
  const calls = callsLine(store, sym.id);
  if (calls) out.push(calls);
  return out;
}

export function estimateLines(lines: string[]): number {
  return estimateTokens(lines.join('\n'));
}
