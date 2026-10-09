// Hybrid lexical symbol search: name lookups (exact / case-insensitive / qualified / glob) + FTS5 bm25,
// re-ranked in JS with coverage, priors and test demotion.

import { FTS_WEIGHTS } from '../store/schema.js';
import type { Store } from '../store/store.js';
import { queryTerms, splitIdentifier, termsForText } from '../indexer/terms.js';
import {
  SYM_COLS,
  type PathFilter,
  type SymRow,
  asciiLower,
  byScoreThen,
  isTestPath,
  kindPrior,
  mentionsTests,
  stemOf,
} from './common.js';

/** Strength of a name lookup match (higher = stronger). */
export const NameMatch = { None: 0, Glob: 1, QualifiedCI: 2, CaseInsensitive: 3, Qualified: 4, Exact: 5 } as const;
export type NameMatch = (typeof NameMatch)[keyof typeof NameMatch];

const NAME_BOOST: Record<number, number> = { 0: 0, 1: 1.6, 2: 2.6, 3: 2.6, 4: 3.0, 5: 3.0 };

export interface Candidate {
  row: SymRow;
  /** Raw bm25 (negative, lower is better); 0 when not an FTS hit. */
  bm25: number;
  name: NameMatch;
  coverage: number;
  score: number;
}

export interface SearchOptions {
  kinds?: string[];
  filter?: PathFilter;
  /** Raw path filter text (a test directory filter means tests are wanted). */
  pathText?: string;
  /** FTS candidate pool size. */
  pool?: number;
}

export interface SearchResult {
  ranked: Candidate[];
  terms: string[];
  /** True when the query contained identifier-like tokens that were looked up by name. */
  identifierQuery: boolean;
  /** Lower-cased file stems the query names explicitly (diversity exemption). */
  targetStems: Set<string>;
}

const FTS_W = FTS_WEIGHTS.join(', ');
const FTS_SQL = `SELECT rowid AS id, bm25(symbols_fts, ${FTS_W}) AS score FROM symbols_fts WHERE symbols_fts MATCH ? ORDER BY score LIMIT ?`;
const FTS_FILTERED_SQL = `SELECT s.id AS id, bm25(symbols_fts, ${FTS_W}) AS score
  FROM symbols_fts JOIN symbols s ON s.id = symbols_fts.rowid JOIN files f ON f.id = s.file_id
  WHERE symbols_fts MATCH :q AND (:glob IS NULL OR f.path GLOB :glob)
    AND (:kinds IS NULL OR s.kind IN (SELECT value FROM json_each(:kinds)))
  ORDER BY score LIMIT :lim`;
const ROWS_BY_IDS_SQL = `SELECT ${SYM_COLS} FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id IN (SELECT value FROM json_each(?))`;
const BY_LNAME_SQL = `SELECT ${SYM_COLS} FROM symbols s JOIN files f ON f.id = s.file_id WHERE lower(s.name) = ? ORDER BY s.rank DESC, s.id LIMIT 500`;
const BY_LNAME_RANGE_SQL = `SELECT ${SYM_COLS} FROM symbols s JOIN files f ON f.id = s.file_id
  WHERE lower(s.name) >= ? AND lower(s.name) < ? AND lower(s.name) LIKE ? ESCAPE '\\' ORDER BY s.rank DESC, s.id LIMIT 300`;
const BY_NAME_LIKE_SQL = `SELECT ${SYM_COLS} FROM symbols s JOIN files f ON f.id = s.file_id
  WHERE s.name LIKE ? ESCAPE '\\' ORDER BY s.rank DESC, s.id LIMIT 300`;
const BY_QNAME_LIKE_SQL = `SELECT ${SYM_COLS} FROM symbols s JOIN files f ON f.id = s.file_id
  WHERE s.qname LIKE ? ESCAPE '\\' ORDER BY s.rank DESC, s.id LIMIT 300`;
const CHILDREN_SQL = `SELECT ${SYM_COLS} FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.parent_id = ? ORDER BY s.start_line, s.id`;

// ---------------------------------------------------------------------------------------------
// Query parsing

/** Light stemming so "refunds"/"computed" reach "refund"/"compute" through FTS prefix queries. */
export function stemTerm(t: string): string {
  if (t.length >= 6 && t.endsWith('ing')) return t.slice(0, -3);
  if (t.length >= 5 && t.endsWith('ed')) return t.slice(0, -2);
  if (t.length >= 5 && t.endsWith('ies')) return t.slice(0, -3);
  if (t.length >= 5 && t.endsWith('es') && /(ss|x|ch|sh)es$/.test(t)) return t.slice(0, -2);
  if (t.length >= 4 && t.endsWith('s') && !/(ss|us|is)$/.test(t)) return t.slice(0, -1);
  return t;
}

// Document frequencies through a temp fts5vocab table (temp schema: works on read-only connections too).
const vocabReady = new WeakMap<Store, { ok: boolean; n: number; at: number }>();
const COMMON_DF = 0.35;

function vocabInfo(store: Store): { ok: boolean; n: number } {
  const now = Date.now();
  let v = vocabReady.get(store);
  if (v && now - v.at < 60_000) return v;
  try {
    store.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS temp.kopt_fts_vocab USING fts5vocab(main, 'symbols_fts', 'row')");
    const n = (store.prepare('SELECT count(*) AS n FROM symbols').get() as { n: number }).n;
    v = { ok: true, n, at: now };
  } catch {
    v = { ok: false, n: 0, at: now };
  }
  vocabReady.set(store, v);
  return v;
}

/**
 * Terms for the FTS candidate query. Terms present in more than COMMON_DF of all symbols make bm25 scan most
 * of the index while adding little ranking signal; they are left to the JS coverage score when rarer terms exist.
 */
export function selectFtsTerms(store: Store, terms: string[]): string[] {
  if (terms.length < 2) return terms;
  const v = vocabInfo(store);
  if (!v.ok || v.n < 5000) return terms;
  // The stem approximates what the prefix query will match ("refunds" -> "refund"*).
  const df = terms.map((t) => (store.prepare('SELECT doc FROM temp.kopt_fts_vocab WHERE term = ?').get(stemTerm(t)) as { doc: number } | undefined)?.doc ?? 0);
  const rare = terms.filter((_, i) => df[i] <= COMMON_DF * v.n);
  if (rare.length) return rare;
  // All common: keep the two rarest.
  return terms
    .map((t, i) => ({ t, d: df[i] }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 2)
    .map((x) => x.t);
}

/** FTS5 query: OR of quoted terms, prefix match for terms >= 4 chars (on the light stem). */
export function buildFtsQuery(terms: string[]): string | undefined {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const t of terms) {
    const clean = t.replace(/[^a-z0-9_$]/g, '');
    if (!clean) continue;
    const s = stemTerm(clean);
    const part = s.length >= 4 ? `"${s}"*` : `"${clean}"`;
    if (seen.has(part)) continue;
    seen.add(part);
    parts.push(part);
    if (parts.length >= 12) break;
  }
  return parts.length ? parts.join(' OR ') : undefined;
}

const IDENT_TOKEN_RE = /^[A-Za-z_$*?][\w$*?]*(?:(?:\.|::|#|->)[A-Za-z_$*?][\w$*?]*)*$/;

/** Identifier-like tokens to look up by name. A query without spaces is one token. */
export function identifierTokens(query: string): string[] {
  const q = query.trim();
  const raw = /\s/.test(q) ? q.split(/\s+/) : [q];
  const out: string[] = [];
  for (let tok of raw) {
    tok = tok.replace(/^[`'"(\[]+|[`'",;:)\]]+$/g, '').replace(/\(\)$/, '');
    if (/\s/.test(q)) tok = tok.replace(/[?.!]+$/, '');
    if (!tok || !IDENT_TOKEN_RE.test(tok)) continue;
    const spaced = /\s/.test(q);
    // Inside a sentence only clearly-code tokens count (camelCase, snake_case, qualified, glob).
    if (spaced && !/[a-z0-9][A-Z]|[A-Za-z]_[A-Za-z]|\.|::|#|->|\*/.test(tok)) continue;
    if (!out.includes(tok)) out.push(tok);
    if (out.length >= 4) break;
  }
  return out;
}

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

function globToLike(g: string): string {
  return likeEscape(g).replace(/\*/g, '%').replace(/\?/g, '_');
}

function globRegex(g: string, flags = 'i'): RegExp {
  const body = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`, flags);
}

export function splitQualified(token: string): string[] {
  return token
    .replace(/::|#|->/g, '.')
    .split('.')
    .filter(Boolean);
}

// ---------------------------------------------------------------------------------------------
// Name lookups

export function rowsByName(store: Store, name: string): SymRow[] {
  return store.prepare(BY_LNAME_SQL).all(asciiLower(name)) as unknown as SymRow[];
}

function rowsByNameGlob(store: Store, glob: string): SymRow[] {
  const lower = asciiLower(glob);
  const prefix = /^[^*?]*/.exec(lower)![0];
  if (prefix) {
    const upper = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
    return store.prepare(BY_LNAME_RANGE_SQL).all(prefix, upper, globToLike(lower)) as unknown as SymRow[];
  }
  return store.prepare(BY_NAME_LIKE_SQL).all(globToLike(glob)) as unknown as SymRow[];
}

function qualifierMatches(row: SymRow, qual: string[], ci: boolean): boolean {
  const parts = row.qname.split('.');
  if (parts.length - 1 < qual.length) {
    // TS/JS module-level symbols: allow the file stem as qualifier ("refunds.computeRefundPreview").
    return qual.length === 1 && eq(stemOf(row.path), qual[0], true);
  }
  const tail = parts.slice(parts.length - 1 - qual.length, parts.length - 1);
  for (let i = 0; i < qual.length; i++) {
    const q = qual[i];
    if (/[*?]/.test(q) ? !globRegex(q, ci ? 'i' : '').test(tail[i]) : !eq(tail[i], q, ci)) return false;
  }
  return true;
}

function eq(a: string, b: string, ci: boolean): boolean {
  return ci ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Name lookup for one identifier-like token: exact, case-insensitive, qualified suffix, glob. */
export function nameLookup(store: Store, token: string): Array<{ row: SymRow; match: NameMatch }> {
  const segs = splitQualified(token);
  if (!segs.length) return [];
  const last = segs[segs.length - 1];
  const qual = segs.slice(0, -1);
  const wild = /[*?]/.test(token);
  const out: Array<{ row: SymRow; match: NameMatch }> = [];

  if (!qual.length) {
    const rows = /[*?]/.test(last) ? rowsByNameGlob(store, last) : rowsByName(store, last);
    for (const row of rows) {
      const m = /[*?]/.test(last) ? NameMatch.Glob : row.name === last ? NameMatch.Exact : NameMatch.CaseInsensitive;
      out.push({ row, match: m });
    }
    return out;
  }

  const wildLast = /[*?]/.test(last);
  const qualToken = qual.join('.');
  if (!/[*?]/.test(qualToken)) {
    // Resolve the qualifier first, then its members: exact even when the member name is very common.
    const parents = nameLookup(store, qualToken).filter((p) => p.match >= NameMatch.QualifiedCI);
    const rx = wildLast ? globRegex(last) : undefined;
    for (const p of parents.slice(0, 50)) {
      for (const row of store.prepare(CHILDREN_SQL).all(p.row.id) as unknown as SymRow[]) {
        if (rx) {
          if (rx.test(row.name)) out.push({ row, match: NameMatch.Glob });
        } else if (eq(row.name, last, true)) {
          const exact = row.name === last && (p.match === NameMatch.Exact || p.match === NameMatch.Qualified);
          out.push({ row, match: exact ? NameMatch.Qualified : NameMatch.QualifiedCI });
        }
      }
    }
    if (out.length) return out;
  }

  // Qualifier is not a symbol (package, module/file stem) or contains wildcards: match on qualified names.
  let rows: SymRow[];
  if (wildLast) rows = rowsByNameGlob(store, last);
  else if (/[*?]/.test(qualToken)) rows = store.prepare(BY_QNAME_LIKE_SQL).all('%' + globToLike(segs.join('.'))) as unknown as SymRow[];
  else rows = rowsByName(store, last);
  for (const row of rows) {
    if (!wild && row.name === last && qualifierMatches(row, qual, false)) out.push({ row, match: NameMatch.Qualified });
    else if (qualifierMatches(row, qual, true) && (wildLast ? globRegex(last).test(row.name) : eq(row.name, last, true)))
      out.push({ row, match: wild ? NameMatch.Glob : NameMatch.QualifiedCI });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Ranking

interface TermIndex {
  name: Set<string>;
  other: Set<string>;
}

function termIndex(row: SymRow): TermIndex {
  const name = new Set(termsForText(`${row.name} ${row.qname}`));
  const other = new Set(termsForText(`${row.signature} ${row.path} ${row.doc ?? ''}`));
  return { name, other };
}

function hasTerm(set: Set<string>, t: string, stem: string): boolean {
  if (set.has(t) || set.has(stem)) return true;
  if (stem.length < 4) return false;
  for (const x of set) if (x.startsWith(stem)) return true;
  return false;
}

export function search(store: Store, query: string, opts: SearchOptions = {}): SearchResult {
  const terms = queryTerms(query);
  const stems = terms.map(stemTerm);
  const idents = identifierTokens(query);
  const wantsTests = mentionsTests(terms) || /(^|[/_.-])(tests?|specs?|__tests__)([/_.-]|$)/i.test(opts.pathText ?? '');
  const kinds = opts.kinds?.length ? new Set(opts.kinds) : undefined;
  const cands = new Map<number, Candidate>();

  const accept = (row: SymRow) => (!kinds || kinds.has(row.kind)) && (!opts.filter || opts.filter.test(row.path));

  for (const tok of idents) {
    for (const { row, match } of nameLookup(store, tok)) {
      if (!accept(row)) continue;
      const c = cands.get(row.id);
      if (c) c.name = Math.max(c.name, match) as NameMatch;
      else cands.set(row.id, { row, bm25: 0, name: match, coverage: 0, score: 0 });
    }
  }

  const fq = buildFtsQuery(selectFtsTerms(store, terms));
  if (fq) {
    let hits: Array<{ id: number; score: number }> = [];
    const pool = opts.pool ?? 300;
    try {
      hits = (opts.filter || kinds
        ? store.prepare(FTS_FILTERED_SQL).all({
            q: fq,
            glob: opts.filter?.sqlGlob ?? null,
            kinds: kinds ? JSON.stringify([...kinds]) : null,
            lim: pool,
          })
        : store.prepare(FTS_SQL).all(fq, pool)) as unknown as Array<{ id: number; score: number }>;
    } catch (err) {
      process.stderr.write(`kopt: fts query failed (${(err as Error).message})\n`);
    }
    const missing = hits.filter((x) => !cands.has(x.id)).map((x) => x.id);
    const rows = missing.length ? (store.prepare(ROWS_BY_IDS_SQL).all(JSON.stringify(missing)) as unknown as SymRow[]) : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const x of hits) {
      const c = cands.get(x.id);
      if (c) c.bm25 = x.score;
      else {
        const row = byId.get(x.id);
        if (row && accept(row)) cands.set(x.id, { row, bm25: x.score, name: NameMatch.None, coverage: 0, score: 0 });
      }
    }
  }

  let best = 0;
  for (const c of cands.values()) if (c.bm25 < best) best = c.bm25;
  const termSet = new Set(terms);
  for (const c of cands.values()) {
    const ti = termIndex(c.row);
    let covered = 0;
    for (let i = 0; i < terms.length; i++) if (hasTerm(ti.name, terms[i], stems[i]) || hasTerm(ti.other, terms[i], stems[i])) covered++;
    c.coverage = terms.length ? covered / terms.length : 0;
    // How much of the symbol's own name the query explains (penalizes extra words: computeRefundPreview).
    const nameWords = splitIdentifier(c.row.name).filter((w) => w.length >= 2);
    let nameCov = 0;
    if (nameWords.length && terms.length) {
      let k = 0;
      for (const w of nameWords) if (termSet.has(w) || stems.some((s) => s.length >= 3 && w.startsWith(s))) k++;
      nameCov = k / nameWords.length;
    }
    const bm = c.bm25 < 0 && best < 0 ? Math.sqrt(c.bm25 / best) : 0;
    const test = !wantsTests && isTestPath(c.row.path) ? 0.6 : 0;
    c.score =
      bm +
      1.2 * c.coverage +
      0.4 * nameCov +
      NAME_BOOST[c.name] +
      0.25 * (c.row.rank || 0) +
      0.15 * (c.row.file_rank || 0) +
      kindPrior(c.row.kind) +
      (c.row.exported ? 0.05 : 0) -
      test;
  }

  const targetStems = new Set<string>();
  for (const tok of idents) for (const s of splitQualified(tok)) targetStems.add(s.toLowerCase());
  for (const t of terms) targetStems.add(t);

  const ranked = [...cands.values()].sort(byScoreThen);
  return { ranked, terms, identifierQuery: idents.length > 0, targetStems };
}

/** Weak tail candidates (below this fraction of the top score) are not worth their tokens. */
export const RELATIVE_CUTOFF = 0.35;

/**
 * Drop the weak tail (keeping at least `minKeep`), constructors whose class is listed too, and cap hits per
 * file unless the query names that file (its stem is a query term).
 */
export function diversify(ranked: Candidate[], targetStems: Set<string>, perFile = 3, exactFile?: string, minKeep = 3): Candidate[] {
  const counts = new Map<string, number>();
  const out: Candidate[] = [];
  const cut = ranked.length ? RELATIVE_CUTOFF * ranked[0].score : 0;
  const listed = new Set(ranked.filter((c) => c.score >= cut).map((c) => c.row.id));
  for (const c of ranked) {
    if (c.score < cut && out.length >= minKeep) break;
    if (c.row.kind === 'constructor' && c.row.parent_id !== null && listed.has(c.row.parent_id)) continue;
    const p = c.row.path;
    const n = counts.get(p) ?? 0;
    const targeted = p === exactFile || targetStems.has(stemOf(p).toLowerCase());
    if (n >= perFile && !targeted) continue;
    counts.set(p, n + 1);
    out.push(c);
  }
  return out;
}

/** Candidates relevant enough to count in "+k more". */
export function relevantCount(ranked: Candidate[]): number {
  if (!ranked.length) return 0;
  const cut = Math.max(0.45 * ranked[0].score, 0.5);
  let n = 0;
  for (const c of ranked) if (c.score >= cut) n++;
  return n;
}
