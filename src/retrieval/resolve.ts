// Target resolution shared by read/refs: handles, ranges, paths, qualified and simple names.

import { statSync } from 'node:fs';
import { resolve as resolvePath, sep } from 'node:path';
import type { FileRow, SymbolRow } from '../store/schema.js';
import { parseSymbolHandle, type Store } from '../store/store.js';
import { SYM_COLS, type SymRow, isTestPath, kindPrior, normalizeRel } from './common.js';
import { NameMatch, nameLookup } from './search.js';

export interface SymbolCandidate {
  symbol: SymbolRow;
  file: FileRow;
}

export type ResolvedTarget =
  | { kind: 'symbol'; symbol: SymbolRow; file: FileRow }
  | { kind: 'range'; path: string; file?: FileRow; start: number; end: number }
  | { kind: 'file'; path: string; file?: FileRow }
  | { kind: 'dir'; path: string }
  | {
      kind: 'ambiguous';
      query: string;
      /** Best first, at most 8. */
      candidates: SymbolCandidate[];
      total: number;
    }
  | { kind: 'none'; query: string; message: string };

const INNERMOST_SQL = `SELECT * FROM symbols WHERE file_id = ? AND start_line <= ? AND end_line >= ?
  ORDER BY (start_line = ?) DESC, (end_line - start_line) ASC, id LIMIT 1`;
const MAX_ENCLOSING_LINES = 150;

type DiskKind = 'file' | 'dir' | undefined;

function onDisk(store: Store, rel: string): DiskKind {
  if (!store.root) return undefined;
  const root = resolvePath(store.root);
  const abs = resolvePath(root, rel);
  // Never resolve outside the repo.
  if (abs !== root && !abs.startsWith(root + sep)) return undefined;
  try {
    const st = statSync(abs);
    return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : undefined;
  } catch {
    return undefined;
  }
}

function hasIndexedUnder(store: Store, dir: string): boolean {
  const p = dir.replace(/\/+$/, '') + '/';
  const upper = p.slice(0, -1) + '0';
  return !!store.prepare('SELECT 1 AS x FROM files WHERE path >= ? AND path < ? LIMIT 1').get(p, upper);
}

function asFile(store: Store, rel: string): { file?: FileRow; kind: DiskKind } {
  const file = store.fileByPath(rel);
  if (file) return { file, kind: 'file' };
  const d = onDisk(store, rel);
  if (d) return { kind: d };
  if (rel && hasIndexedUnder(store, rel)) return { kind: 'dir' };
  return { kind: undefined };
}

const FILE_EXT_RE =
  /\.(java|kt|kts|scala|groovy|ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyi|go|rs|cs|php|rb|swift|c|h|cc|cpp|hpp|m|vue|svelte|md|mdx|json|ya?ml|toml|xml|html?|css|scss|less|sql|sh|bash|gradle|properties|txt|ini|cfg|conf|proto|graphql|tf|hcl)$/i;

function looksLikePath(s: string): boolean {
  return s.includes('/') || FILE_EXT_RE.test(s);
}

/** Files whose path ends with `/<suffix>` (partial paths, bare file names). */
function filesBySuffix(store: Store, suffix: string): FileRow[] {
  return store
    .prepare("SELECT * FROM files WHERE path LIKE ? ESCAPE '\\' ORDER BY rank DESC, path LIMIT 6")
    .all('%/' + suffix.replace(/[\\%_]/g, (c) => '\\' + c)) as unknown as FileRow[];
}

/** Score used to pick a dominant candidate among same-named symbols. */
function candScore(c: SymRow): number {
  return (c.exported ? 0.5 : 0) + (c.rank || 0) + 0.3 * (c.file_rank || 0) + kindPrior(c.kind) - (isTestPath(c.path) ? 0.6 : 0);
}

function toCandidate(store: Store, r: SymRow): SymbolCandidate {
  const { path: _p, file_rank: _r, ...symbol } = r;
  return { symbol: symbol as SymbolRow, file: store.fileById(r.file_id)! };
}

export function pickCandidates(store: Store, query: string, rows: SymRow[]): ResolvedTarget {
  if (!rows.length) return { kind: 'none', query, message: `no symbol matches "${query}"` };
  // A class and its same-named constructor are one thing for the reader.
  const ids = new Set(rows.map((r) => r.id));
  let list = rows.filter((r) => !(r.kind === 'constructor' && r.parent_id !== null && ids.has(r.parent_id)));
  list = [...list].sort((a, b) => candScore(b) - candScore(a) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.start_line - b.start_line || a.id - b.id);
  if (list.length === 1) return { kind: 'symbol', ...toCandidate(store, list[0]) };
  const [top, second] = list;
  const exportedOthers = list.slice(1).some((r) => r.exported);
  const nonTest = list.filter((r) => !isTestPath(r.path));
  const dominates =
    (top.exported && !exportedOthers && !isTestPath(top.path)) ||
    candScore(top) - candScore(second) >= 0.6 ||
    (nonTest.length === 1 && nonTest[0] === top);
  if (dominates) return { kind: 'symbol', ...toCandidate(store, top) };
  return { kind: 'ambiguous', query, candidates: list.slice(0, 8).map((r) => toCandidate(store, r)), total: list.length };
}

/** Rows matching a (possibly qualified) name, strongest match class only. */
export function symbolsForName(store: Store, name: string): SymRow[] {
  const hits = nameLookup(store, name).filter((x) => x.match !== NameMatch.Glob);
  if (!hits.length) return [];
  const best = Math.max(...hits.map((x) => x.match));
  // Exact-case beats case-insensitive; qualified beats bare.
  const tier = (m: number) => (m === NameMatch.Exact || m === NameMatch.Qualified ? 2 : 1);
  const bestTier = tier(best);
  return hits.filter((x) => tier(x.match) === bestTier).map((x) => x.row);
}

function innermostAt(store: Store, file: FileRow, line: number): SymbolRow | undefined {
  return store.prepare(INNERMOST_SQL).get(file.id, line, line, line) as SymbolRow | undefined;
}

/** Resolve a target string (handle, qualified name, name, path, path:range) to symbols/files. */
export function resolveTarget(store: Store, target: string): ResolvedTarget {
  const raw = (target ?? '').trim().replace(/^[`'"]+|[`'"]+$/g, '');
  if (!raw) return { kind: 'none', query: '', message: 'empty target; pass a handle (#3mv), a name, a path or path:start-end' };

  const id = parseSymbolHandle(raw);
  if (id !== undefined) {
    const symbol = store.symbolById(id);
    const file = symbol && store.fileById(symbol.file_id);
    if (symbol && file) return { kind: 'symbol', symbol, file };
    return { kind: 'none', query: raw, message: `unknown handle ${raw} (index rebuilt?); use kopt_find to get fresh handles` };
  }

  // path:10-40, path:10, path#L10-L40, path:10:5 (compiler line:col)
  const m = /^(.+?)(?::|#L)(\d+)(?:\s*-\s*L?(\d+))?$/.exec(raw.replace(/^(.+?:\d+):\d+$/, '$1'));
  if (m) {
    const rel = normalizeRel(m[1], store.root);
    const f = asFile(store, rel);
    if (f.kind === 'file') {
      let a = parseInt(m[2], 10);
      let b = m[3] !== undefined ? parseInt(m[3], 10) : undefined;
      if (b !== undefined && b < a) [a, b] = [b, a];
      a = Math.max(1, a);
      if (b !== undefined) return { kind: 'range', path: rel, file: f.file, start: a, end: b };
      // A single line: the declaration starting there or the (small) enclosing symbol, else a window.
      if (f.file) {
        const s = innermostAt(store, f.file, a);
        if (s && (s.start_line === a || s.end_line - s.start_line < MAX_ENCLOSING_LINES)) return { kind: 'symbol', symbol: s, file: f.file };
      }
      return { kind: 'range', path: rel, file: f.file, start: Math.max(1, a - 20), end: a + 20 };
    }
  }

  const rel = normalizeRel(raw, store.root);
  if (rel === '') return { kind: 'dir', path: '' };
  const f = asFile(store, rel);
  if (f.kind === 'file') return { kind: 'file', path: rel, file: f.file };
  if (f.kind === 'dir') return { kind: 'dir', path: rel.replace(/\/+$/, '') };

  if (/\s/.test(raw)) return { kind: 'none', query: raw, message: `"${raw}" is not a handle, name or path; use kopt_find for searches` };

  if (looksLikePath(raw)) {
    const byName = rel.includes('/') ? [] : symbolsForName(store, raw);
    if (byName.length) return pickCandidates(store, raw, byName);
    const files = filesBySuffix(store, rel);
    if (files.length === 1) return { kind: 'file', path: files[0].path, file: files[0] };
    if (files.length > 1) {
      const list = files.slice(0, 5).map((f) => f.path).join(', ');
      return { kind: 'none', query: raw, message: `"${raw}" matches several files: ${list}${files.length > 5 ? ', …' : ''}` };
    }
    return { kind: 'none', query: raw, message: `no file "${rel}" in the index or on disk` };
  }

  const rows = symbolsForName(store, raw);
  if (!rows.length) return { kind: 'none', query: raw, message: `no symbol matches "${raw}"` };
  return pickCandidates(store, raw, rows);
}

/** All symbol rows of a file, ordered by position. */
export function fileSymbols(store: Store, fileId: number): SymbolRow[] {
  return store.prepare('SELECT * FROM symbols WHERE file_id = ? ORDER BY start_line, id').all(fileId) as unknown as SymbolRow[];
}

export function symRowsByIds(store: Store, ids: number[]): SymRow[] {
  if (!ids.length) return [];
  return store
    .prepare(`SELECT ${SYM_COLS} FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(ids)) as unknown as SymRow[];
}
