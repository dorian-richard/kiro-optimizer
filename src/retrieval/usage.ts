// Usages of symbols shared by kopt_refs and kopt_find pack: which ids count as "the symbol" (constructors,
// overloads, interface methods and their implementations), caller rows and their one-line-per-file rendering,
// and callees grouped by target file.

import type { SymbolRow } from '../store/schema.js';
import type { Store } from '../store/store.js';
import { h, isFieldKind, isTestPath, shortQ } from './common.js';
import { fileSymbols } from './resolve.js';
import { descendantIds, isContainer } from './skeleton.js';
import { loadSource, type Source } from './source.js';

export interface UsageRow {
  line: number;
  kind: string;
  file_id: number;
  path: string;
  from_id: number | null;
  from_name: string | null;
  from_qname: string | null;
  /** First and last line of the calling symbol's declaration. */
  from_line: number | null;
  from_end: number | null;
  from_kind: string | null;
}

const CTOR_IDS_SQL = "SELECT id FROM symbols WHERE parent_id = ? AND kind = 'constructor'";
const SUPERS_SQL = `SELECT DISTINCT to_symbol_id AS id FROM refs
  WHERE from_symbol_id = ? AND kind IN ('inherit', 'implement') AND to_symbol_id IS NOT NULL LIMIT 20`;
const SUBS_SQL = `SELECT DISTINCT from_symbol_id AS id FROM refs
  WHERE to_symbol_id = ? AND kind IN ('inherit', 'implement') AND from_symbol_id IS NOT NULL LIMIT 50`;
const SAME_NAME_MEMBERS_SQL = `SELECT id FROM symbols
  WHERE parent_id IN (SELECT value FROM json_each(?)) AND name = ? AND kind = ? LIMIT 60`;

const ROW_COLS = `r.line AS line, r.kind AS kind, r.file_id AS file_id, f.path AS path, r.from_symbol_id AS from_id,
    s.name AS from_name, s.qname AS from_qname, s.start_line AS from_line, s.end_line AS from_end, s.kind AS from_kind`;
export const USAGES_SQL = `SELECT ${ROW_COLS}
  FROM refs r JOIN files f ON f.id = r.file_id LEFT JOIN symbols s ON s.id = r.from_symbol_id
  WHERE r.to_symbol_id IN (SELECT value FROM json_each(?))
  ORDER BY f.path, r.line, r.id LIMIT 5000`;
/** Unresolved refs named `?1` of the kinds in the JSON array `?2`. */
export const UNRESOLVED_USAGES_SQL = `SELECT ${ROW_COLS}
  FROM refs r JOIN files f ON f.id = r.file_id LEFT JOIN symbols s ON s.id = r.from_symbol_id
  WHERE r.name = ? AND r.to_symbol_id IS NULL AND r.kind IN (SELECT value FROM json_each(?))
  ORDER BY f.path, r.line, r.id LIMIT 500`;
const UNRESOLVED_COUNT_SQL = `SELECT count(*) AS n FROM (SELECT 1 FROM refs r WHERE r.name = ? AND r.to_symbol_id IS NULL
  AND r.kind IN (SELECT value FROM json_each(?)) AND (r.from_symbol_id IS NULL OR r.from_symbol_id NOT IN (SELECT value FROM json_each(?))) LIMIT 10000)`;

/** Languages where a method can be referenced as a value through a member read (`obj.handler` as a callback). */
const METHOD_VALUES = new Set(['javascript', 'typescript', 'tsx', 'python', 'php', 'ruby', 'go', 'scala']);

/**
 * Ref kinds through which an unresolved reference could mean `sym`: calls for functions (and member reads where a
 * method can be a value), member reads / writes (and calls of a stored function, PHP `X::C` constant uses) for
 * fields, instantiations and type uses for types.
 */
export function relatedKinds(kind: string, lang?: string | null): string[] {
  if (isFieldKind(kind)) return ['read', 'write', 'call', 'type_ref'];
  if (isContainer(kind) || kind === 'type') return ['new', 'call', 'type_ref', 'inherit', 'implement'];
  return lang && METHOD_VALUES.has(lang) && kind !== 'constructor' ? ['call', 'new', 'read'] : ['call', 'new'];
}

function kindsFor(store: Store, sym: Pick<SymbolRow, 'kind' | 'file_id'>): string {
  return JSON.stringify(relatedKinds(sym.kind, store.fileById(sym.file_id)?.lang));
}

/** Unresolved references that could mean `sym` (same name, related kind), outside `exclude` (its own family). */
export function unresolvedRows(store: Store, sym: Pick<SymbolRow, 'name' | 'kind' | 'file_id'>, exclude: Set<number>): UsageRow[] {
  return (store.prepare(UNRESOLVED_USAGES_SQL).all(sym.name, kindsFor(store, sym)) as unknown as UsageRow[]).filter(
    (r) => r.from_id === null || !exclude.has(r.from_id),
  );
}

/** How many such unresolved references exist (capped at 10,000). */
export function unresolvedCount(store: Store, sym: Pick<SymbolRow, 'name' | 'kind' | 'file_id'>, exclude: Iterable<number>): number {
  return (store.prepare(UNRESOLVED_COUNT_SQL).get(sym.name, kindsFor(store, sym), JSON.stringify([...exclude])) as { n: number }).n;
}

/** Target ids whose usages count as usages of `sym` (a class is also used through its constructors). */
export function usageTargets(store: Store, sym: { id: number; kind: string }): number[] {
  const ids = [sym.id];
  if (isContainer(sym.kind)) for (const r of store.prepare(CTOR_IDS_SQL).all(sym.id) as unknown as Array<{ id: number }>) ids.push(r.id);
  return ids;
}

function relatedTypes(store: Store, sql: string, id: number): number[] {
  return (store.prepare(sql).all(id) as unknown as Array<{ id: number }>).map((r) => r.id);
}

/**
 * A method together with the same-named methods of its supertypes (2 levels: the interface method a caller
 * actually references), of its subtypes (overrides) and its overloads. Other symbols: themselves.
 */
export function methodFamily(store: Store, sym: Pick<SymbolRow, 'id' | 'name' | 'kind' | 'parent_id'>): number[] {
  if (sym.parent_id === null || isContainer(sym.kind) || isFieldKind(sym.kind)) return [sym.id];
  const types = new Set<number>([sym.parent_id]);
  const up1 = relatedTypes(store, SUPERS_SQL, sym.parent_id);
  for (const t of up1) {
    types.add(t);
    for (const u of relatedTypes(store, SUPERS_SQL, t)) types.add(u);
  }
  for (const t of relatedTypes(store, SUBS_SQL, sym.parent_id)) types.add(t);
  const ids = new Set<number>([sym.id]);
  for (const r of store.prepare(SAME_NAME_MEMBERS_SQL).all(JSON.stringify([...types]), sym.name, sym.kind) as unknown as Array<{ id: number }>) ids.add(r.id);
  return [...ids];
}

/**
 * Usages of a symbol: refs to its family (see methodFamily) or, for a container, refs to the container, its
 * constructors and its members from code outside the container.
 */
export function usageRows(store: Store, sym: SymbolRow): { rows: UsageRow[]; family: number[] } {
  if (!isContainer(sym.kind)) {
    const family = methodFamily(store, sym);
    const own = new Set(family);
    const rows = (store.prepare(USAGES_SQL).all(JSON.stringify(family)) as unknown as UsageRow[]).filter((r) => r.from_id === null || !own.has(r.from_id));
    return { rows, family };
  }
  const inside = new Set(descendantIds(fileSymbols(store, sym.file_id), sym.id));
  const targets = [...inside].slice(0, 400);
  const rows = (store.prepare(USAGES_SQL).all(JSON.stringify(targets)) as unknown as UsageRow[]).filter((r) => r.from_id === null || !inside.has(r.from_id));
  return { rows, family: usageTargets(store, sym) };
}

/** Same-name refs that the indexer could not resolve, for names distinctive enough to be meaningful. */
export function possibleRows(store: Store, sym: SymbolRow, exclude: Set<number>): UsageRow[] {
  const name = sym.name;
  if (name.length < 6 && !/[a-z0-9][A-Z]|_/.test(name)) return [];
  const rows = unresolvedRows(store, sym, exclude);
  return rows.length > 60 ? [] : rows;
}

export const KIND_TAG: Record<string, string> = {
  new: ' new',
  inherit: ' extends',
  implement: ' implements',
  import: ' import',
  type_ref: ' type',
  read: ' read',
  write: ' write',
};

/** "defined 10-42": the calling symbol's declaration lines. */
export function definedAt(r: Pick<UsageRow, 'from_line' | 'from_end'>): string {
  if (!r.from_line) return '';
  return r.from_end && r.from_end > r.from_line ? `defined ${r.from_line}-${r.from_end}` : `defined ${r.from_line}`;
}

/** " in #h Caller.name (defined 10-42)": the calling symbol and the lines of its declaration. */
export function callerLabel(r: Pick<UsageRow, 'from_id' | 'from_name' | 'from_qname' | 'from_line' | 'from_end'>): string {
  if (r.from_id === null) return '';
  const d = definedAt(r);
  return ` in ${h(r.from_id)} ${shortQ(r.from_qname ?? '', r.from_name ?? '')}${d ? ` (${d})` : ''}`;
}

/**
 * One line per file: "path: L12,L40 in #h Caller.name (defined 10-42); L88 in #h Other.run (defined 80-95)".
 * Non-test files first, then most usages. The caller's own declaration lines save the agent a search for it.
 */
export function usageLines(rows: UsageRow[], prefix = '', perCaller = 6, maxCallers = Infinity): string[] {
  return filesInOrder(rows).map(([path, list]) => {
    const byFrom = new Map<string, { label: string; lines: string[] }>();
    for (const r of list) {
      const k = r.from_id === null ? 'file' : String(r.from_id);
      const e = byFrom.get(k) ?? { label: callerLabel(r), lines: [] };
      const l = `L${r.line}${KIND_TAG[r.kind] ?? ''}`;
      if (!e.lines.includes(l)) e.lines.push(l);
      byFrom.set(k, e);
    }
    const all = [...byFrom.values()];
    const parts = all.slice(0, maxCallers).map((e) => `${e.lines.slice(0, perCaller).join(',')}${e.lines.length > perCaller ? ',…' : ''}${e.label}`);
    const rest = all.length - parts.length;
    return `${prefix}${path}: ${parts.join('; ')}${rest > 0 ? `; +${rest} more` : ''}`;
  });
}

/** Longest code excerpt printed after a call site. */
export const SITE_CODE_MAX = 100;

/** One reference site: its rendering without and with the code of its line. */
export interface Site {
  plain: string;
  /** `plain` + ": <code of the line>" (undefined when the file is unreadable or changed since indexing); reads the file on first use. */
  code(): string | undefined;
}

/** Files in caller-list order: product code first, then most usages, then path. */
function filesInOrder(rows: UsageRow[]): Array<[string, UsageRow[]]> {
  const byFile = new Map<string, UsageRow[]>();
  for (const r of rows) {
    const arr = byFile.get(r.path) ?? [];
    arr.push(r);
    byFile.set(r.path, arr);
  }
  return [...byFile.entries()].sort(
    (a, b) => Number(isTestPath(a[0])) - Number(isTestPath(b[0])) || b[1].length - a[1].length || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  );
}

/** The trimmed source line, at most SITE_CODE_MAX characters. */
export function codeAt(src: Source | undefined, line: number): string | undefined {
  if (!src || src.stale) return undefined;
  const raw = src.lines[line - 1];
  if (raw === undefined) return undefined;
  const t = raw.replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  return t.length > SITE_CODE_MAX ? t.slice(0, SITE_CODE_MAX - 1) + '…' : t;
}

/**
 * One line per calling symbol and file, in caller-list order: "path:120 in #h Foo.bar (defined 98-140)" (several
 * lines of one caller: "path:120,134 in ..."), with a `code` variant ending in ": <code of its first line>" so
 * the agent sees the call's arguments without opening the file. Kinds other than a call are tagged (new, read,
 * write, type...).
 */
export function siteList(store: Store, rows: UsageRow[], prefix = ''): Site[] {
  const out: Site[] = [];
  const sources = new Map<string, Source | undefined>();
  for (const [path, list] of filesInOrder(rows)) {
    const byCaller = new Map<string, { row: UsageRow; lines: number[]; tags: string[] }>();
    for (const r of [...list].sort((a, b) => a.line - b.line)) {
      const key = r.from_id === null ? `file\u0000${r.line}` : String(r.from_id);
      const e = byCaller.get(key) ?? { row: r, lines: [], tags: [] };
      if (!e.lines.includes(r.line)) e.lines.push(r.line);
      const tag = KIND_TAG[r.kind];
      if (tag && !e.tags.includes(tag)) e.tags.push(tag);
      byCaller.set(key, e);
    }
    for (const e of byCaller.values()) {
      const lines = e.lines.length > 6 ? `${e.lines.slice(0, 6).join(',')},…` : e.lines.join(',');
      const label = e.row.from_id === null ? ' (file level)' : callerLabel(e.row);
      const plain = `${prefix}${path}:${lines}${e.tags.join(',')}${label}`;
      const code = () => {
        if (!sources.has(path)) sources.set(path, loadSource(store, path));
        const c = codeAt(sources.get(path), e.lines[0]);
        return c ? `${plain}: ${c}` : undefined;
      };
      out.push({ plain, code });
    }
  }
  return out;
}

const CALLABLE_KINDS = new Set(['function', 'method']);
/** A thin wrapper's declaration spans at most this many lines (header + ~5 body lines + closing line). */
export const WRAPPER_MAX_LINES = 7;
const WRAPPER_CALLS_SQL = "SELECT count(DISTINCT name) AS n FROM refs WHERE from_symbol_id = ? AND kind IN ('call', 'new')";

/**
 * Callers that only wrap the target: a small function or method (WRAPPER_MAX_LINES) of product code that calls
 * it and makes at most 2 other calls (`NewMigrationHTTPTransport` building the transport and setting one field).
 * Their own callers are the target's real users; at most `max`, in caller-list order.
 */
export function thinWrappers(store: Store, rows: UsageRow[], family: Set<number>, max = 3): UsageRow[] {
  const out: UsageRow[] = [];
  const seen = new Set<number>();
  for (const [, list] of filesInOrder(rows)) {
    for (const r of list) {
      if (out.length >= max) return out;
      if (r.from_id === null || seen.has(r.from_id) || family.has(r.from_id)) continue;
      seen.add(r.from_id);
      if ((r.kind !== 'call' && r.kind !== 'new') || !CALLABLE_KINDS.has(r.from_kind ?? '') || isTestPath(r.path)) continue;
      const span = (r.from_end ?? 0) - (r.from_line ?? 0) + 1;
      if (span < 1 || span > WRAPPER_MAX_LINES) continue;
      if ((store.prepare(WRAPPER_CALLS_SQL).get(r.from_id) as { n: number }).n > 3) continue;
      out.push(r);
    }
  }
  return out;
}

export function countFiles(rows: UsageRow[]): number {
  return new Set(rows.map((r) => r.file_id)).size;
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

const OUT_SQL = `SELECT r.name AS name, r.qualifier AS qualifier, r.kind AS kind, r.line AS line, r.to_symbol_id AS to_id,
    ts.name AS to_name, ts.qname AS to_qname, tf.path AS to_path
  FROM refs r LEFT JOIN symbols ts ON ts.id = r.to_symbol_id LEFT JOIN files tf ON tf.id = ts.file_id
  WHERE r.from_symbol_id IN (SELECT value FROM json_each(?))
  ORDER BY r.line, r.id LIMIT 3000`;

/** Callees grouped by target file (resolved, with handles), then one line of unresolved/external names. */
/** First path segment ("app", "lib", "spring-core"). */
function topDir(path: string): string {
  const i = path.indexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/**
 * A resolved call that is probably a name-only guess: its receiver (`authorizations.where`) names nothing like the
 * target's type or file, and the target lives in another top-level folder. Short receivers (`s`, `p`, `db`) are
 * not judged.
 */
export function dubiousCall(qualifier: string | null, fromPath: string, toPath: string, toQname: string): boolean {
  if (!qualifier || topDir(fromPath) === topDir(toPath)) return false;
  const q = (qualifier.split(/[.:>-]/).filter(Boolean).pop() ?? '').replace(/^[@$_]+|[!?]$/g, '').toLowerCase();
  if (q.length < 3 || /^(self|this|super|cls|static|parent)$/.test(q)) return false;
  const owner = (toQname.split('.').slice(-2, -1)[0] ?? '').toLowerCase();
  const stem = (toPath.split('/').pop() ?? '').replace(/\..*$/, '').replace(/[_-]/g, '').toLowerCase();
  const sing = q.replace(/s$/, '');
  return !(owner.includes(sing) || (owner.length >= 3 && sing.includes(owner)) || stem.includes(sing));
}

export function calleeLines(
  store: Store,
  syms: SymbolRow[],
  o: { kinds?: Set<string>; perFile?: number; dropDubious?: boolean } = {},
): { lines: string[]; total: number; resolved: number; unresolved: string[]; fields?: string } {
  const callerPath = syms.length ? (store.fileById(syms[0].file_id)?.path ?? '') : '';
  // member reads / writes are not callees: the resolved ones are summarized on one "fields" line
  const fieldsRead = new Map<number, string>();
  const fieldsWritten = new Map<number, string>();
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
    if (o.kinds && !o.kinds.has(r.kind)) continue;
    if (r.kind === 'read' || r.kind === 'write') {
      if (r.to_id !== null && !from.has(r.to_id)) (r.kind === 'read' ? fieldsRead : fieldsWritten).set(r.to_id, `${h(r.to_id)} ${shortQ(r.to_qname ?? '', r.to_name ?? r.name)}`);
      continue;
    }
    if (r.to_id !== null && r.to_path) {
      if (from.has(r.to_id)) continue; // internal calls of a container / recursion
      if (o.dropDubious && dubiousCall(r.qualifier, callerPath, r.to_path, r.to_qname ?? '')) continue;
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
    .sort((a, b) => Number(isTestPath(a[0])) - Number(isTestPath(b[0])) || b[1].size - a[1].size || (a[0] < b[0] ? -1 : 1))
    .map(([path, m]) => {
      const names = [...m.values()];
      const max = o.perFile ?? Infinity;
      return `${path}: ${names.slice(0, max).join(', ')}${names.length > max ? `, +${names.length - max}` : ''}`;
    });
  if (unresolved.length) lines.push(`unresolved/external: ${unresolved.slice(0, 30).join(', ')}${unresolved.length > 30 ? `, +${unresolved.length - 30}` : ''}`);
  const list = (m: Map<number, string>) => `${[...m.values()].slice(0, 12).join(', ')}${m.size > 12 ? `, +${m.size - 12}` : ''}`;
  const parts = [fieldsRead.size ? `reads ${list(fieldsRead)}` : '', fieldsWritten.size ? `writes ${list(fieldsWritten)}` : ''].filter(Boolean);
  return { lines, total: resolved + unresolved.length, resolved, unresolved, fields: parts.length ? `fields: ${parts.join('; ')}` : undefined };
}
