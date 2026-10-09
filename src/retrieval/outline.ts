// kopt_outline: file skeleton, or an aider-style repo map of a directory (ranked, optionally personalized by focus).

import type { OutlineParams } from '../core/api.js';
import type { ToolContext } from '../core/context.js';
import { estimateTokens, tokensToChars } from '../core/tokens.js';
import type { ToolResult } from '../core/types.js';
import { FTS_WEIGHTS, type FileRow, type SymbolRow } from '../store/schema.js';
import type { Store } from '../store/store.js';
import { queryTerms, termsForText } from '../indexer/terms.js';
import {
  type PathFilter,
  baseName,
  budgetOf,
  compose,
  dirOf,
  guard,
  isFieldKind,
  isGlob,
  isPrivate,
  isTestPath,
  mentionsTests,
  moreSuffix,
  normalizeRel,
  pathFilter,
  plural,
  quote,
  result,
} from './common.js';
import { fileSkeleton, symbolSection } from './read.js';
import { fileSymbols, resolveTarget } from './resolve.js';
import { buildFtsQuery, selectFtsTerms, stemTerm } from './search.js';
import { loadSource } from './source.js';

interface MapFile {
  id: number;
  path: string;
  rank: number;
  lang: string | null;
  score: number;
}

const ALL_FILES_SQL = 'SELECT id, path, rank, lang FROM files ORDER BY rank DESC, path';
const DIR_FILES_SQL = 'SELECT id, path, rank, lang FROM files WHERE path >= ? AND path < ? ORDER BY rank DESC, path';
const FOCUS_SQL = `SELECT s.file_id AS file_id, s.id AS id, bm25(symbols_fts, ${FTS_WEIGHTS.join(', ')}) AS score
  FROM symbols_fts JOIN symbols s ON s.id = symbols_fts.rowid WHERE symbols_fts MATCH ? ORDER BY score LIMIT 600`;
const NEIGHBORS_SQL = `SELECT target_file_id AS id FROM file_imports WHERE file_id = ? AND target_file_id IS NOT NULL
  UNION SELECT file_id AS id FROM file_imports WHERE target_file_id = ?`;

export function outline(store: Store, p: OutlineParams, ctx: ToolContext): ToolResult {
  ctx.ledger.tick();
  const maxTokens = budgetOf(p?.maxTokens, ctx.config.budgets.outline);
  const raw = typeof p?.path === 'string' ? p.path : '';
  const focus = typeof p?.focus === 'string' && p.focus.trim() ? p.focus.trim() : undefined;
  const rel = normalizeRel(raw, store.root).replace(/\/+$/, '');
  return guard('outline', maxTokens, () => {
    if (rel === '') return repoMap(store, '', undefined, focus, maxTokens);
    if (isGlob(rel)) return repoMap(store, '', pathFilter(rel, store.root), focus, maxTokens, rel);
    const t = resolveTarget(store, rel);
    switch (t.kind) {
      case 'file':
        return fileOutline(store, t.path, t.file, maxTokens);
      case 'range':
        return fileOutline(store, t.path, t.file, maxTokens);
      case 'dir':
        return repoMap(store, t.path, undefined, focus, maxTokens);
      case 'symbol':
        return result(symbolSection(store, t.symbol, t.file, { mode: 'skeleton', ctx, maxTokens }).text, maxTokens, { kind: 'symbol' });
      case 'ambiguous':
        return result(`"${rel}" names ${t.total} symbols; pass a file or directory path (or kopt_read ${rel})`, maxTokens);
      case 'none':
        return result(`no file or directory "${rel}"; kopt_outline . shows the repo map`, maxTokens);
    }
  });
}

function fileOutline(store: Store, path: string, file: FileRow | undefined, maxTokens: number): ToolResult {
  const src = loadSource(store, path, file);
  if (!src) return result(`${path}: source not available`, maxTokens);
  const n = src.lines.length;
  const full = estimateTokens(src.text);
  const what = `outline ${path}`;
  const reserve = estimateTokens(`${what} · 9999 symbols · 99999 lines · ~99999 tok${moreSuffix(999)}`) + 2;
  const sk = fileSkeleton(store, src, file, Math.max(1, maxTokens - reserve));
  if (!sk.lines.length) {
    const text = compose((tok) => `${what} · 0 symbols · ${n} lines · ~${tok} tok`, `next: kopt_read ${path}:1-${Math.min(n, 80)}`, maxTokens);
    return result(text, maxTokens, { kind: 'file', symbols: 0 });
  }
  const body = [...sk.lines, ...(sk.note ? [sk.note] : [])].join('\n');
  const text = compose((tok) => `${what} · ${sk.symbols} symbols · ${n} lines · ~${tok} tok${moreSuffix(sk.omitted)}`, body, maxTokens);
  return result(text, maxTokens, { kind: 'file', symbols: sk.symbols, omitted: sk.omitted }, full);
}

// ---------------------------------------------------------------------------------------------
// Repo map

function focusScores(store: Store, files: MapFile[], focus: string): { fileScore: Map<number, number>; symHits: Map<number, Set<number>>; terms: string[] } {
  const terms = queryTerms(focus);
  const fileScore = new Map<number, number>();
  const symHits = new Map<number, Set<number>>();
  const fq = buildFtsQuery(selectFtsTerms(store, terms));
  if (!fq) return { fileScore, symHits, terms };
  let rows: Array<{ file_id: number; id: number; score: number }> = [];
  try {
    rows = store.prepare(FOCUS_SQL).all(fq) as unknown as typeof rows;
  } catch {
    rows = [];
  }
  const best = rows.reduce((m, r) => Math.min(m, r.score), 0);
  // Sum of the top-3 symbol scores per file: rewards files with several relevant symbols without letting huge files win.
  const perFile = new Map<number, number[]>();
  for (const r of rows) {
    const s = best < 0 ? Math.sqrt(r.score / best) : 0;
    const arr = perFile.get(r.file_id) ?? [];
    arr.push(s);
    perFile.set(r.file_id, arr);
    const set = symHits.get(r.file_id) ?? new Set<number>();
    set.add(r.id);
    symHits.set(r.file_id, set);
  }
  for (const [fid, arr] of perFile) {
    arr.sort((a, b) => b - a);
    fileScore.set(fid, arr.slice(0, 3).reduce((a, b) => a + b, 0) / 3);
  }
  const stems = terms.map(stemTerm);
  for (const f of files) {
    // Cheap substring pre-check: tokenizing every path of a 50k-file repo is the expensive part.
    const lower = f.path.toLowerCase();
    if (!stems.some((st) => lower.includes(st))) continue;
    const pt = termsForText(f.path);
    let k = 0;
    for (const st of stems) if (pt.some((t) => t.startsWith(st))) k++;
    if (k) fileScore.set(f.id, (fileScore.get(f.id) ?? 0) + (0.5 * k) / Math.max(1, stems.length));
  }
  // One hop of personalization over the import graph (cheap stand-in for personalized PageRank).
  const top = [...fileScore.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 15);
  const boost = new Map<number, number>();
  for (const [fid, s] of top) {
    for (const r of store.prepare(NEIGHBORS_SQL).all(fid, fid) as unknown as Array<{ id: number }>) {
      boost.set(r.id, Math.max(boost.get(r.id) ?? 0, 0.3 * s));
    }
  }
  for (const [fid, b] of boost) fileScore.set(fid, (fileScore.get(fid) ?? 0) + b);
  return { fileScore, symHits, terms };
}

/** "TopSymbol{member1,member2,…}, other" for one file, focus matches and exported/high-rank first. */
function fileEntry(rows: SymbolRow[], focusIds: Set<number> | undefined, maxChars: number, membersPerRoot: number): string {
  if (!rows.length) return '';
  const ids = new Set(rows.map((r) => r.id));
  const kids = new Map<number, SymbolRow[]>();
  const roots: SymbolRow[] = [];
  for (const r of rows) {
    if (r.parent_id !== null && ids.has(r.parent_id)) {
      const arr = kids.get(r.parent_id) ?? [];
      arr.push(r);
      kids.set(r.parent_id, arr);
    } else roots.push(r);
  }
  const hit = (r: SymbolRow) => (focusIds?.has(r.id) ? 1 : 0);
  const subtreeHit = (r: SymbolRow): number => hit(r) || ((kids.get(r.id) ?? []).some((k) => hit(k)) ? 1 : 0);
  const order = (a: SymbolRow, b: SymbolRow) =>
    subtreeHit(b) - subtreeHit(a) || b.exported - a.exported || b.rank - a.rank || a.start_line - b.start_line || a.id - b.id;
  const parts: string[] = [];
  let used = 0;
  const sortedRoots = roots.filter((r) => !(isPrivate(r) && !r.exported && roots.length > 1)).sort(order);
  for (const r of sortedRoots) {
    let s = r.name;
    const members = (kids.get(r.id) ?? []).filter((k) => !isPrivate(k) && k.kind !== 'constructor');
    const methods = members.filter((k) => !isFieldKind(k.kind));
    const pool = (methods.length ? methods : members).sort(order);
    const names: string[] = [];
    for (const k of pool) if (!names.includes(k.name)) names.push(k.name);
    if (names.length && membersPerRoot > 0) {
      const shown = names.slice(0, membersPerRoot);
      s += `{${shown.join(',')}${names.length > shown.length ? ',…' : ''}}`;
    }
    if (used + s.length + 2 > maxChars && parts.length) {
      parts.push(`+${sortedRoots.length - parts.length}`);
      break;
    }
    parts.push(s);
    used += s.length + 2;
  }
  return parts.join(', ');
}

function repoMap(store: Store, dir: string, filter: PathFilter | undefined, focus: string | undefined, maxTokens: number, globText?: string): ToolResult {
  let files: MapFile[];
  if (dir) {
    const lo = dir + '/';
    files = store.prepare(DIR_FILES_SQL).all(lo, dir + '0') as unknown as MapFile[];
  } else files = store.prepare(ALL_FILES_SQL).all() as unknown as MapFile[];
  if (filter) files = files.filter((f) => filter.test(f.path));
  const code = files.filter((f) => f.lang);
  if (code.length) files = code;
  const label = dir ? `outline ${dir}/` : globText ? `repo map ${quote(globText)}` : 'repo map';
  const what = `${label}${focus ? ` focus ${quote(focus, 40)}` : ''}`;
  if (!files.length) return result(`${what} · 0 files indexed${dir ? ` under ${dir}/` : ''}; run kopt index`, maxTokens);

  const maxRank = files.reduce((m, f) => Math.max(m, f.rank || 0), 0) || 1;
  let fs: ReturnType<typeof focusScores> | undefined;
  if (focus) fs = focusScores(store, files, focus);
  const wantsTests = fs ? mentionsTests(fs.terms) : false;
  for (const f of files) {
    const base = (f.rank || 0) / maxRank;
    const test = isTestPath(f.path) && !wantsTests ? (fs ? 0.3 : 0.1) : 0;
    f.score = (fs ? (fs.fileScore.get(f.id) ?? 0) + 0.35 * base : base) - test;
  }
  files.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const headReserve = estimateTokens(`${what} · 9999 files · ~99999 tok${moreSuffix(99999)}`) + 1;
  const budget = tokensToChars(Math.max(0, maxTokens - headReserve));
  const footerReserve = files.length > 20 ? 150 : 0;
  const chosen: Array<{ f: MapFile; line: string }> = [];
  const dirs = new Set<string>();
  let used = 0;
  for (const f of files) {
    const d = dirOf(f.path) || './';
    const dirCost = dirs.has(d) ? 0 : d.length + 1;
    const rows = fileSymbols(store, f.id);
    const focusIds = fs?.symHits.get(f.id);
    let line = '';
    for (const members of [6, 3, 0]) {
      const entry = fileEntry(rows, focusIds, 180, members);
      line = `  ${baseName(f.path)}${entry ? ': ' + entry : ''}`;
      if (used + dirCost + line.length + 1 <= budget - footerReserve) break;
      line = '';
    }
    if (!line) break;
    chosen.push({ f, line });
    dirs.add(d);
    used += dirCost + line.length + 1;
  }

  // Render grouped by directory, groups in order of their best file.
  const groups = new Map<string, string[]>();
  for (const c of chosen) {
    const d = dirOf(c.f.path) || './';
    const arr = groups.get(d) ?? [];
    arr.push(c.line);
    groups.set(d, arr);
  }
  const out: string[] = [];
  for (const [d, lines] of groups) out.push(d, ...lines);
  const omitted = files.length - chosen.length;
  if (omitted > 0) {
    const footer = omittedSummary(files.slice(chosen.length), dir, tokensToChars(maxTokens - headReserve) - used - 2);
    if (footer) out.push(footer);
  }
  const text = compose((tok) => `${what} · ${plural(chosen.length, 'file')} · ~${tok} tok${moreSuffix(omitted)}`, out.join('\n'), maxTokens);
  return result(text, maxTokens, { kind: 'map', files: chosen.length, omitted });
}

/** "more: src/a/ (120), web/ (80), …" — where the omitted files live, one level below the map root. */
function omittedSummary(rest: MapFile[], dir: string, maxChars: number): string | undefined {
  if (maxChars < 30) return undefined;
  const prefix = dir ? dir + '/' : '';
  const counts = new Map<string, number>();
  for (const f of rest) {
    const sub = f.path.slice(prefix.length);
    const i = sub.indexOf('/');
    const key = i < 0 ? prefix || './' : prefix + sub.slice(0, i + 1);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  let s = 'more:';
  let n = 0;
  for (const [k, c] of sorted) {
    const part = ` ${k} (${c}),`;
    if (s.length + part.length + 2 > maxChars) break;
    s += part;
    n++;
  }
  if (!n) return undefined;
  return n < sorted.length ? s + ' …' : s.slice(0, -1);
}
