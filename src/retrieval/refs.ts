// kopt_refs: usages (in), callees (out) and 2-level impact of a symbol; importers/imports of a file.

import type { RefsParams } from '../core/api.js';
import type { ToolContext } from '../core/context.js';
import { estimateTokens, tokensToChars } from '../core/tokens.js';
import type { ToolResult } from '../core/types.js';
import type { FileRow, SymbolRow } from '../store/schema.js';
import type { Store } from '../store/store.js';
import { budgetOf, compose, guard, h, isTestPath, moreSuffix, plural, quote, result, shortQ } from './common.js';
import { usageTargets } from './find.js';
import { ambiguousText, suggest } from './read.js';
import { fileSymbols, resolveTarget } from './resolve.js';
import { descendantIds, isContainer } from './skeleton.js';

interface UsageRow {
  line: number;
  kind: string;
  file_id: number;
  path: string;
  from_id: number | null;
  from_name: string | null;
  from_qname: string | null;
}

const IN_SQL = `SELECT r.line AS line, r.kind AS kind, r.file_id AS file_id, f.path AS path,
    r.from_symbol_id AS from_id, s.name AS from_name, s.qname AS from_qname
  FROM refs r JOIN files f ON f.id = r.file_id LEFT JOIN symbols s ON s.id = r.from_symbol_id
  WHERE r.to_symbol_id IN (SELECT value FROM json_each(?))
  ORDER BY f.path, r.line, r.id LIMIT 5000`;
const UNRESOLVED_SQL = `SELECT r.line AS line, r.kind AS kind, r.file_id AS file_id, f.path AS path,
    r.from_symbol_id AS from_id, s.name AS from_name, s.qname AS from_qname
  FROM refs r JOIN files f ON f.id = r.file_id LEFT JOIN symbols s ON s.id = r.from_symbol_id
  WHERE r.name = ? AND r.to_symbol_id IS NULL
  ORDER BY f.path, r.line, r.id LIMIT 500`;
const OUT_SQL = `SELECT r.name AS name, r.qualifier AS qualifier, r.kind AS kind, r.line AS line, r.to_symbol_id AS to_id,
    ts.name AS to_name, ts.qname AS to_qname, tf.path AS to_path
  FROM refs r LEFT JOIN symbols ts ON ts.id = r.to_symbol_id LEFT JOIN files tf ON tf.id = ts.file_id
  WHERE r.from_symbol_id IN (SELECT value FROM json_each(?))
  ORDER BY r.line, r.id LIMIT 3000`;
const FILE_USERS_SQL = `SELECT f.path AS path, count(*) AS n FROM symbols s
  JOIN refs r ON r.to_symbol_id = s.id JOIN files f ON f.id = r.file_id
  WHERE s.file_id = ? AND r.file_id <> ? GROUP BY r.file_id ORDER BY n DESC, f.path LIMIT 300`;
const FILE_IMPORTERS_SQL = `SELECT DISTINCT f.path AS path FROM file_imports i JOIN files f ON f.id = i.file_id
  WHERE i.target_file_id = ? ORDER BY f.path LIMIT 300`;
const FILE_IMPORTS_SQL = `SELECT i.spec AS spec, f.path AS path FROM file_imports i LEFT JOIN files f ON f.id = i.target_file_id
  WHERE i.file_id = ? ORDER BY i.rowid LIMIT 300`;

const KIND_TAG: Record<string, string> = { new: ' new', inherit: ' extends', implement: ' implements', import: ' import', type_ref: ' type' };

/** Greedy line packing; returns kept lines and how many were dropped. */
function packLines(lines: string[], maxChars: number): { kept: string[]; dropped: number; used: number } {
  const kept: string[] = [];
  let used = 0;
  let i = 0;
  for (; i < lines.length; i++) {
    const add = lines[i].length + 1;
    if (used + add > maxChars) break;
    kept.push(lines[i]);
    used += add;
  }
  return { kept, dropped: lines.length - i, used };
}

/** One line per file: "path: L12,L40 in #h Caller.name; L88 in #h Other.run". Non-test files first, then most usages. */
function usageLines(rows: UsageRow[], prefix = ''): string[] {
  const byFile = new Map<string, UsageRow[]>();
  for (const r of rows) {
    const arr = byFile.get(r.path) ?? [];
    arr.push(r);
    byFile.set(r.path, arr);
  }
  const files = [...byFile.entries()].sort(
    (a, b) => Number(isTestPath(a[0])) - Number(isTestPath(b[0])) || b[1].length - a[1].length || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  );
  return files.map(([path, list]) => {
    const byFrom = new Map<string, { label: string; lines: string[] }>();
    for (const r of list) {
      const k = r.from_id === null ? 'file' : String(r.from_id);
      const e = byFrom.get(k) ?? { label: r.from_id === null ? '' : ` in ${h(r.from_id)} ${shortQ(r.from_qname ?? '', r.from_name ?? '')}`, lines: [] };
      const l = `L${r.line}${KIND_TAG[r.kind] ?? ''}`;
      if (!e.lines.includes(l)) e.lines.push(l);
      byFrom.set(k, e);
    }
    const parts = [...byFrom.values()].map((e) => `${e.lines.slice(0, 6).join(',')}${e.lines.length > 6 ? ',…' : ''}${e.label}`);
    return `${prefix}${path}: ${parts.join('; ')}`;
  });
}

function countFiles(rows: UsageRow[]): number {
  return new Set(rows.map((r) => r.file_id)).size;
}

function message(text: string, maxTokens: number): ToolResult {
  return result(text, maxTokens);
}

export function refs(store: Store, p: RefsParams, ctx: ToolContext): ToolResult {
  ctx.ledger.tick();
  const maxTokens = budgetOf(p?.maxTokens, ctx.config.budgets.refs);
  const direction = p?.direction ?? 'in';
  if (direction !== 'in' && direction !== 'out' && direction !== 'both') return message(`unknown direction "${String(direction)}"; use in, out or both`, maxTokens);
  const depth = Number(p?.depth) === 2 ? 2 : 1;
  const target = typeof p?.target === 'string' ? p.target : '';
  return guard('refs', maxTokens, () => {
    const t = resolveTarget(store, target);
    switch (t.kind) {
      case 'none': {
        const s = t.message.startsWith('no symbol') ? suggest(store, t.query) : '';
        return message(`${t.message}${s || (t.message.startsWith('no symbol') ? `; try kopt_find ${quote(t.query.toLowerCase())}` : '')}`, maxTokens);
      }
      case 'dir':
        return message(`refs needs a symbol or file; ${t.path || '.'} is a directory`, maxTokens);
      case 'file':
      case 'range':
        return t.file ? fileRefs(store, t.file, direction, maxTokens) : message(`${t.path} is not indexed; no references known`, maxTokens);
      case 'ambiguous': {
        const qn = new Set(t.candidates.map((c) => c.symbol.qname));
        // Overloads (same qualified name) are one target for usages.
        if (qn.size === 1 && t.total === t.candidates.length) {
          return symbolRefs(store, t.candidates.map((c) => c.symbol), direction, depth, maxTokens);
        }
        return message(ambiguousText(`refs ${quote(t.query)}`, t.candidates, t.total, maxTokens).replace('next: kopt_read', 'next: kopt_refs'), maxTokens);
      }
      case 'symbol':
        return symbolRefs(store, [t.symbol], direction, depth, maxTokens);
    }
  });
}

function symbolRefs(store: Store, syms: SymbolRow[], direction: 'in' | 'out' | 'both', depth: 1 | 2, maxTokens: number): ToolResult {
  const main = syms[0];
  const label = `${h(main.id)} ${shortQ(main.qname, main.name)}`;
  const targets = [...new Set(syms.flatMap((s) => usageTargets(store, s)))];
  const headReserve = estimateTokens(`impact ${label} · 99999 usages in 9999 files · 999 possible · 999 callees (999 resolved) · ~99999 tok${moreSuffix(999)}`) + 1;
  const budget = tokensToChars(Math.max(0, maxTokens - headReserve));
  const body: string[] = [];
  const head: string[] = [];
  let more = 0;
  let used = 0;
  const meta: Record<string, unknown> = { direction, depth };

  if (direction === 'in' || direction === 'both') {
    const inBudget = direction === 'both' ? Math.floor(budget * 0.6) : budget;
    const rows = store.prepare(IN_SQL).all(JSON.stringify(targets)) as unknown as UsageRow[];
    const nFiles = countFiles(rows);
    const lines = usageLines(rows);
    const sections: string[][] = [];
    let level2: UsageRow[] = [];
    if (depth === 2) {
      const direct = [...new Set(rows.map((r) => r.from_id).filter((x): x is number => x !== null && !targets.includes(x)))];
      const ids = [...new Set(direct.flatMap((id) => { const s = store.symbolById(id); return s ? usageTargets(store, s) : [id]; }))];
      level2 = ids.length ? (store.prepare(IN_SQL).all(JSON.stringify(ids)) as unknown as UsageRow[]).filter((r) => r.from_id === null || !targets.includes(r.from_id)) : [];
      sections.push(['direct:', ...lines], ['indirect (callers of callers):', ...impactLines(level2)]);
    } else sections.push(lines);

    // Few resolved usages: show same-name unresolved refs as possible matches, clearly separated.
    let possible: UsageRow[] = [];
    if (rows.length < 5) {
      const own = new Set(syms.flatMap((s) => [s.id]));
      possible = (store.prepare(UNRESOLVED_SQL).all(main.name) as unknown as UsageRow[]).filter((r) => r.from_id === null || !own.has(r.from_id));
      if (possible.length) sections.push([`possible (unresolved refs named ${main.name}):`, ...usageLines(possible, '? ')]);
    }
    if (!rows.length && !possible.length) sections.push(['no references found (dynamic dispatch, reflection and external callers are not tracked)']);

    let left = inBudget;
    for (const sec of sections) {
      const pk = packLines(sec, left);
      // A section title alone is noise.
      if (pk.kept.length <= 1 && sec.length > 1 && /:$/.test(sec[0])) {
        more += sec.length - 1;
        continue;
      }
      body.push(...pk.kept);
      more += pk.dropped;
      left -= pk.used;
      used += pk.used;
    }
    if (depth === 2) {
      const n = rows.length + level2.length;
      const m = new Set([...rows, ...level2].map((r) => r.file_id)).size;
      head.push(`${plural(n, 'usage')} in ${plural(m, 'file')} (depth 2: ${rows.length} direct, ${level2.length} indirect)`);
    } else head.push(`${plural(rows.length, 'usage')} in ${plural(nFiles, 'file')}`);
    if (possible.length) head.push(`${possible.length} possible`);
    meta.usages = rows.length;
    meta.files = nFiles;
    meta.possible = possible.length;
  }

  if (direction === 'out' || direction === 'both') {
    const out = calleeLines(store, syms);
    if (direction === 'both') body.push('out:');
    const pk = packLines(out.lines.length ? out.lines : ['no outgoing references indexed'], Math.max(0, budget - used));
    body.push(...pk.kept);
    more += pk.dropped;
    head.push(`${out.total} callees (${out.resolved} resolved)`);
    meta.callees = out.total;
  }
  if (direction === 'both' && body.length && body[0] !== 'out:') body.unshift('in:');

  const kind = depth === 2 && direction !== 'out' ? 'impact' : direction === 'out' ? 'refs out' : 'refs';
  const text = compose((tok) => `${kind} ${label} · ${head.join(' · ')} · ~${tok} tok${moreSuffix(more)}`, body.join('\n'), maxTokens);
  return result(text, maxTokens, meta);
}

/** Per-file aggregation for second-level callers: "path: 3 refs · #a Foo.run, #b Bar.go". */
function impactLines(rows: UsageRow[]): string[] {
  const byFile = new Map<string, { n: number; callers: Map<number, { label: string; n: number }> }>();
  for (const r of rows) {
    const e = byFile.get(r.path) ?? { n: 0, callers: new Map() };
    e.n++;
    if (r.from_id !== null) {
      const c = e.callers.get(r.from_id) ?? { label: `${h(r.from_id)} ${shortQ(r.from_qname ?? '', r.from_name ?? '')}`, n: 0 };
      c.n++;
      e.callers.set(r.from_id, c);
    }
    byFile.set(r.path, e);
  }
  return [...byFile.entries()]
    .sort((a, b) => Number(isTestPath(a[0])) - Number(isTestPath(b[0])) || b[1].n - a[1].n || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([path, e]) => {
      const top = [...e.callers.values()].sort((a, b) => b.n - a.n || (a.label < b.label ? -1 : 1));
      const names = top.slice(0, 3).map((c) => c.label);
      return `${path}: ${plural(e.n, 'ref')}${names.length ? ' · ' + names.join(', ') : ''}${top.length > 3 ? `, +${top.length - 3}` : ''}`;
    });
}

interface OutRow {
  name: string;
  qualifier: string | null;
  kind: string;
  line: number;
  to_id: number | null;
  to_name: string | null;
  to_qname: string | null;
  to_path: string | null;
}

/** Callees grouped by target file (resolved, with handles), then one line of unresolved/external names. */
function calleeLines(store: Store, syms: SymbolRow[]): { lines: string[]; total: number; resolved: number } {
  const from = new Set<number>();
  for (const s of syms) {
    if (isContainer(s.kind)) for (const id of descendantIds(fileSymbols(store, s.file_id), s.id)) from.add(id);
    else from.add(s.id);
  }
  const rows = store.prepare(OUT_SQL).all(JSON.stringify([...from])) as unknown as OutRow[];
  const byFile = new Map<string, Map<number, string>>();
  const unresolved: string[] = [];
  let resolved = 0;
  for (const r of rows) {
    if (r.kind === 'import') continue;
    if (r.to_id !== null && r.to_path) {
      if (from.has(r.to_id)) continue; // internal calls of a container / recursion
      const m = byFile.get(r.to_path) ?? new Map<number, string>();
      if (!m.has(r.to_id)) {
        m.set(r.to_id, `${h(r.to_id)} ${shortQ(r.to_qname ?? '', r.to_name ?? r.name)}${KIND_TAG[r.kind] ?? ''}`);
        resolved++;
      }
      byFile.set(r.to_path, m);
    } else {
      const q = r.qualifier && r.qualifier.length <= 24 && !/[\s(]/.test(r.qualifier) ? r.qualifier + '.' : '';
      const n = `${r.kind === 'new' ? 'new ' : ''}${q}${r.name}`;
      if (!unresolved.includes(n)) unresolved.push(n);
    }
  }
  const lines = [...byFile.entries()]
    .sort((a, b) => b[1].size - a[1].size || (a[0] < b[0] ? -1 : 1))
    .map(([path, m]) => `${path}: ${[...m.values()].join(', ')}`);
  if (unresolved.length) lines.push(`unresolved/external: ${unresolved.slice(0, 30).join(', ')}${unresolved.length > 30 ? `, +${unresolved.length - 30}` : ''}`);
  return { lines, total: resolved + unresolved.length, resolved };
}

function fileRefs(store: Store, file: FileRow, direction: 'in' | 'out' | 'both', maxTokens: number): ToolResult {
  const headReserve = estimateTokens(`refs ${file.path} · 9999 using files · 9999 imports · ~99999 tok${moreSuffix(999)}`) + 1;
  const budget = tokensToChars(Math.max(0, maxTokens - headReserve));
  const body: string[] = [];
  const head: string[] = [];
  let more = 0;
  let used = 0;
  if (direction !== 'out') {
    const users = store.prepare(FILE_USERS_SQL).all(file.id, file.id) as unknown as Array<{ path: string; n: number }>;
    const importers = store.prepare(FILE_IMPORTERS_SQL).all(file.id) as unknown as Array<{ path: string }>;
    const m = new Map<string, number>();
    for (const u of users) m.set(u.path, u.n);
    for (const i of importers) if (!m.has(i.path)) m.set(i.path, 0);
    const lines = [...m.entries()]
      .sort((a, b) => Number(isTestPath(a[0])) - Number(isTestPath(b[0])) || b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .map(([p, n]) => `${p}${n ? ` (${plural(n, 'ref')})` : ' (import)'}`);
    if (direction === 'both') body.push('in:');
    const pk = packLines(lines.length ? lines : ['no indexed file uses it'], direction === 'both' ? Math.floor(budget * 0.6) : budget);
    body.push(...pk.kept);
    more += pk.dropped;
    used += pk.used;
    head.push(`${m.size} using files`);
  }
  if (direction !== 'in') {
    const imps = store.prepare(FILE_IMPORTS_SQL).all(file.id) as unknown as Array<{ spec: string; path: string | null }>;
    const lines = imps.map((i) => (i.path ? `${i.spec} → ${i.path}` : i.spec));
    if (direction === 'both') body.push('out:');
    const pk = packLines(lines.length ? lines : ['no imports indexed'], Math.max(0, budget - used));
    body.push(...pk.kept);
    more += pk.dropped;
    head.push(`${imps.length} imports`);
  }
  const text = compose((tok) => `refs ${file.path} · ${head.join(' · ')} · ~${tok} tok${moreSuffix(more)}`, body.join('\n'), maxTokens);
  return result(text, maxTokens, { direction, file: true });
}
