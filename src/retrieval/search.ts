// Hybrid lexical symbol search: name lookups (exact / case-insensitive / qualified / glob) + FTS5 bm25,
// re-ranked in JS with coverage, priors and test demotion.

import { performance } from 'node:perf_hooks';
import { FTS_WEIGHTS } from '../store/schema.js';
import type { Store } from '../store/store.js';
import { IDENTIFIER_STOPWORDS, QUERY_STOPWORDS, joinedNames, parseQuery, splitIdentifier, termsForText } from '../indexer/terms.js';
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
/** Boost of a name spelled by consecutive query words ("get bean" -> getBean), scaled by the share of words used. */
const JOINED_FULL_BOOST = 2.2;
const JOINED_BOOST_BASE = 0.5;
const JOINED_BOOST_SPAN = 0.9;

export interface Candidate {
  row: SymRow;
  /** Raw bm25 (negative, lower is better); 0 when not an FTS hit. */
  bm25: number;
  name: NameMatch;
  coverage: number;
  score: number;
  /** Words of the query that this symbol's name spells when joined (getBean for "get bean"). */
  joined?: number;
  /** The spelled name earned a boost: the query names this symbol as surely as an identifier would. */
  spelled?: boolean;
}

export interface SearchOptions {
  kinds?: string[];
  filter?: PathFilter;
  /** Raw path filter text (a test directory filter means tests are wanted). */
  pathText?: string;
  /** FTS candidate pool size. */
  pool?: number;
  /** `performance.now()` deadline: when less than FTS_MIN_MS remain, only name lookups run. */
  deadline?: number;
}

/**
 * Kinds a kind filter also accepts: agents say "function" for methods (and the languages disagree: a Python method,
 * a Go method, a JS class method), "class" for structs and records, "field" for properties.
 */
const KIND_GROUPS: Record<string, string[]> = {
  function: ['function', 'method', 'constructor'],
  method: ['method', 'function', 'constructor'],
  constructor: ['constructor', 'method', 'function'],
  class: ['class', 'struct', 'record'],
  struct: ['struct', 'class', 'record'],
  record: ['record', 'class', 'struct'],
  field: ['field', 'property'],
  property: ['property', 'field'],
};

/** A kind filter widened with the kinds an agent means by the same word (see KIND_GROUPS). */
export function expandKinds(kinds: readonly string[]): string[] {
  const out = new Set<string>();
  for (const k of kinds) for (const x of KIND_GROUPS[k] ?? [k]) out.add(x);
  return [...out];
}

/** Time a full-text query may need on a large index; below it, a deadline-bound search skips that step. */
export const FTS_MIN_MS = 150;

export interface SearchResult {
  ranked: Candidate[];
  terms: string[];
  /** Identifier-like stopwords of the query (low-weight name terms). */
  weak: string[];
  /** True when the query contained identifier-like tokens that were looked up by name. */
  identifierQuery: boolean;
  /** Lower-cased file stems the query names explicitly (diversity exemption). */
  targetStems: Set<string>;
}

const FTS_W = FTS_WEIGHTS.join(', ');
// `rank MATCH` + ORDER BY rank: FTS5 ranks inside the virtual table (same bm25 values), about twice as fast as
// sorting a bm25() column when a common term matches hundreds of thousands of symbols.
const FTS_SQL = `SELECT rowid AS id, rank AS score FROM symbols_fts WHERE symbols_fts MATCH ? AND rank MATCH 'bm25(${FTS_W})' ORDER BY rank LIMIT ?`;
const FTS_FILTERED_SQL = `SELECT s.id AS id, bm25(symbols_fts, ${FTS_W}) AS score
  FROM symbols_fts JOIN symbols s ON s.id = symbols_fts.rowid JOIN files f ON f.id = s.file_id
  WHERE symbols_fts MATCH :q AND (:glob IS NULL OR f.path GLOB :glob)
    AND (:kinds IS NULL OR s.kind IN (SELECT value FROM json_each(:kinds)))
  ORDER BY score LIMIT :lim`;
const ROWS_BY_IDS_SQL = `SELECT ${SYM_COLS} FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id IN (SELECT value FROM json_each(?))`;
// Ruby predicate/bang methods (`valid?`, `consume!`) are found by their bare name too.
const BY_LNAME_SQL = `SELECT ${SYM_COLS} FROM symbols s JOIN files f ON f.id = s.file_id
  WHERE lower(s.name) IN (?1, ?1 || '!', ?1 || '?') ORDER BY s.rank DESC, s.id LIMIT 500`;
const BY_LNAME_RANGE_SQL = `SELECT ${SYM_COLS} FROM symbols s JOIN files f ON f.id = s.file_id
  WHERE lower(s.name) >= ? AND lower(s.name) < ? AND lower(s.name) LIKE ? ESCAPE '\\' ORDER BY s.rank DESC, s.id LIMIT 300`;
const BY_NAME_LIKE_SQL = `SELECT ${SYM_COLS} FROM symbols s JOIN files f ON f.id = s.file_id
  WHERE s.name LIKE ? ESCAPE '\\' ORDER BY s.rank DESC, s.id LIMIT 300`;
const BY_QNAME_LIKE_SQL = `SELECT ${SYM_COLS} FROM symbols s JOIN files f ON f.id = s.file_id
  WHERE s.qname LIKE ? ESCAPE '\\' ORDER BY s.rank DESC, s.id LIMIT 300`;
const CHILDREN_SQL = `SELECT ${SYM_COLS} FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.parent_id = ? ORDER BY s.start_line, s.id`;
const BY_LNAMES_SQL = `SELECT ${SYM_COLS} FROM symbols s JOIN files f ON f.id = s.file_id
  WHERE lower(s.name) IN (SELECT value FROM json_each(?)) ORDER BY s.rank DESC, s.id LIMIT 400`;

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
/**
 * Symbols the candidate query may match before more (commoner) terms stop being added. bm25 is computed for every
 * match: `index*` alone matches 209k of 573k symbols on elasticsearch (1 s). Rarer terms already select the
 * candidates; the dropped ones still count in the coverage score.
 */
export const MATCH_BUDGET = 60_000;

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
export function selectFtsTerms(store: Store, terms: string[], budget = MATCH_BUDGET): string[] {
  if (terms.length < 2) return terms;
  const v = vocabInfo(store);
  if (!v.ok || v.n < 5000) return terms;
  // The stem approximates what the prefix query will match ("refunds" -> "refund"*).
  const df = terms.map((t) => (store.prepare('SELECT doc FROM temp.kopt_fts_vocab WHERE term = ?').get(stemTerm(t)) as { doc: number } | undefined)?.doc ?? 0);
  const common = (i: number) => df[i] > COMMON_DF * v.n;
  const order = [...terms.keys()].sort((a, b) => df[a] - df[b] || a - b);
  // All common: keep the two rarest.
  if (common(order[0])) return terms.filter((_, i) => i === order[0] || i === order[1]);
  // Rarest first, until a common term or the match budget; terms that match nothing do not count as selective.
  const keep = new Set<number>();
  let sum = 0;
  for (const i of order) {
    if (sum > 0 && (common(i) || sum + df[i] > budget)) break;
    keep.add(i);
    sum += df[i];
  }
  return terms.filter((_, i) => keep.has(i));
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

const IDENT_TOKEN_RE = /^\\?[A-Za-z_$*?][\w$*?]*(?:(?:\.|::|#|->|\\)[A-Za-z_$*?][\w$*?]*)*$/;

/** Identifier-like tokens to look up by name. A query without spaces is one token. */
export function identifierTokens(query: string): string[] {
  const q = query.trim();
  const raw = /\s/.test(q) ? q.split(/\s+/) : [q];
  const out: string[] = [];
  for (let tok of raw) {
    tok = tok.replace(/^[`'"(\[]+|[`'",;:)\]]+$/g, '').replace(/\(\)$/, '');
    const spaced = /\s/.test(q);
    // A Ruby bang method (`consume!`) is code even inside a sentence; its bare name finds it.
    const bang = spaced && /^[a-z_]\w{3,}!$/.test(tok);
    if (spaced) tok = tok.replace(/[?.!]+$/, '');
    if (!tok || !IDENT_TOKEN_RE.test(tok)) continue;
    // Inside a sentence only clearly-code tokens count (camelCase, snake_case, qualified, glob).
    if (spaced && !bang && !/[a-z0-9][A-Z]|[A-Za-z]_[A-Za-z]|\.|::|#|->|\\|\*/.test(tok)) continue;
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

/** `Illuminate\\Image\\Image::resolveDriver`, `pkg::Type::f`, `Type#m`, `$obj->m` -> dotted segments. */
export function splitQualified(token: string): string[] {
  return token
    .replace(/::|#|->|\\/g, '.')
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

/** Type declaration files (often generated, e.g. a 30k-line types.d.ts) rank below the code they describe. */
const DECLARATION_FILE_RE = /\.d\.[cm]?ts$/;
/** Weight of an identifier-like stopword ("get", "is", "or") relative to a content term. */
const WEAK_WEIGHT = 0.4;
/** Terms at least this long also match inside compound names ("silence" -> should_autosilence). */
const INFIX_MIN = 5;

interface TermIndex {
  /** Sub-words of the symbol's own name (plus the whole lower-cased name). */
  own: Set<string>;
  /** Sub-words of the qualified name (containers, module). */
  qual: Set<string>;
  other: Set<string>;
}

function termIndex(row: SymRow): TermIndex {
  const own = new Set(termsForText(row.name));
  for (const w of splitIdentifier(row.name)) if (w.length >= 2) own.add(w);
  const qual = new Set(termsForText(row.qname));
  const other = new Set(termsForText(`${row.signature} ${row.path} ${row.doc ?? ''}`));
  return { own, qual, other };
}

function hasTerm(set: Set<string>, t: string, stem: string, infix = false): boolean {
  if (set.has(t) || set.has(stem)) return true;
  if (stem.length < 4) return false;
  for (const x of set) if (x.startsWith(stem) || (infix && stem.length >= INFIX_MIN && x.includes(stem))) return true;
  return false;
}

/**
 * Names holding the term in lower case after another character (`*?silence*`): a compound such as
 * should_autosilence or shouldAutosilence. Case-sensitive on purpose: a capitalized occurrence (getSilence) starts
 * a camelCase word, which FTS already matches.
 */
const INFIX_SQL = (n: number) => `SELECT ${SYM_COLS} FROM symbols s JOIN files f ON f.id = s.file_id
  WHERE ${Array.from({ length: n }, () => 's.name GLOB ?').join(' OR ')}
  ORDER BY s.rank DESC, s.id LIMIT 200`;

const PAIR_FTS_SQL = `SELECT rowid AS id FROM symbols_fts WHERE symbols_fts MATCH ? LIMIT 400`;

/**
 * Symbols whose name holds two consecutive query words joined, inside a longer name ("configuration class" ->
 * checkConfigurationClassCandidate, "price list" -> getPriceListRules): the full-text query keeps only the rarest
 * terms of a long query, and a name made of common words is otherwise never a candidate. Pairs of long words only;
 * the name sub-words of the full-text index find them (no scan of the symbols table).
 */
export function pairInfixCandidates(store: Store, words: string[]): SymRow[] {
  const ids = new Set<number>();
  const joins: string[] = [];
  let pairs = 0;
  for (let i = 0; i + 1 < words.length && pairs < 3; i++) {
    const [a, b] = [words[i], words[i + 1]];
    if (!/^[a-z][a-z0-9]*$/.test(a) || !/^[a-z][a-z0-9]*$/.test(b)) continue;
    if (QUERY_STOPWORDS.has(a) && QUERY_STOPWORDS.has(b)) continue;
    if (a.length < 4 || a.length + b.length < 10) continue;
    pairs++;
    joins.push(a + b, `${a}_${b}`);
    try {
      for (const r of store.prepare(PAIR_FTS_SQL).all(`name_terms : "${a}" AND name_terms : "${b}"`) as unknown as Array<{ id: number }>) ids.add(r.id);
    } catch {
      // no FTS table (or a malformed term): nothing to add
    }
  }
  if (!ids.size) return [];
  const rows = store.prepare(ROWS_BY_IDS_SQL).all(JSON.stringify([...ids])) as unknown as SymRow[];
  return rows.filter((r) => {
    const n = asciiLower(r.name);
    return joins.some((j) => n.includes(j));
  });
}

/** Symbols whose name contains a query term inside a word (autosilence for "silence"): FTS only matches prefixes. */
function infixCandidates(store: Store, stems: string[]): SymRow[] {
  const long = [...new Set(stems.filter((t) => t.length >= INFIX_MIN && /^[a-z0-9]+$/.test(t)))].slice(0, 4);
  if (!long.length) return [];
  try {
    return store.prepare(INFIX_SQL(long.length)).all(...long.map((t) => `*?${t}*`)) as unknown as SymRow[];
  } catch {
    return [];
  }
}

export function search(store: Store, query: string, opts: SearchOptions = {}): SearchResult {
  const pq = parseQuery(query);
  const terms = pq.terms;
  const weak = pq.weak.filter((w) => !terms.includes(w));
  const stems = terms.map(stemTerm);
  const idents = identifierTokens(query);
  const wantsTests = mentionsTests(terms) || /(^|[/_.-])(tests?|specs?|__tests__)([/_.-]|$)/i.test(opts.pathText ?? '');
  const kinds = opts.kinds?.length ? new Set(expandKinds(opts.kinds)) : undefined;
  const cands = new Map<number, Candidate>();

  const accept = (row: SymRow) => (!kinds || kinds.has(row.kind)) && (!opts.filter || opts.filter.test(row.path));
  const add = (row: SymRow): Candidate => {
    let c = cands.get(row.id);
    if (!c) cands.set(row.id, (c = { row, bm25: 0, name: NameMatch.None, coverage: 0, score: 0 }));
    return c;
  };

  for (const tok of idents) {
    for (const { row, match } of nameLookup(store, tok)) {
      if (!accept(row)) continue;
      const c = add(row);
      c.name = Math.max(c.name, match) as NameMatch;
    }
  }

  // Names spelled by consecutive words, stopwords included: "get bean" -> getBean / get_bean.
  if (/\s/.test(query.trim())) {
    const joins = joinedNames(pq.words);
    if (joins.length) {
      const words = new Map(joins.map((j) => [j, j.includes('_') ? j.split('_').length : 0]));
      for (const row of store.prepare(BY_LNAMES_SQL).all(JSON.stringify(joins)) as unknown as SymRow[]) {
        if (!accept(row)) continue;
        const lname = asciiLower(row.name);
        // camelCase joins carry no word count: recover it from the snake_case twin.
        const n = words.get(lname) || splitIdentifier(row.name).length;
        const c = add(row);
        c.joined = Math.max(c.joined ?? 0, n);
      }
    }
  }

  const late = opts.deadline !== undefined && opts.deadline - performance.now() < FTS_MIN_MS;
  const fq = late ? undefined : buildFtsQuery(selectFtsTerms(store, terms));
  if (fq) {
    let hits: Array<{ id: number; score: number }> = [];
    const pool = opts.pool ?? 400;
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
  // Words that name no symbol: compound names the prefix query cannot reach ("silence" -> should_autosilence?).
  if (![...cands.values()].some((c) => c.name >= NameMatch.QualifiedCI)) for (const row of infixCandidates(store, stems)) if (accept(row)) add(row);
  // A long natural-language query: names holding two of its words joined ("configuration class").
  if (!late && pq.words.length >= 3) for (const row of pairInfixCandidates(store, pq.words)) if (accept(row)) add(row);

  const nStrong = terms.length;
  const denom = nStrong + WEAK_WEIGHT * weak.length;
  const weakStems = weak.map(stemTerm);
  const explains = new Set([...terms, ...weak]);
  const nameStems = [...stems, ...weakStems];
  const queryWords = pq.words.filter((w) => !QUERY_STOPWORDS.has(w) || IDENTIFIER_STOPWORDS.has(w)).length;
  let best = 0;
  for (const c of cands.values()) if (c.bm25 < best) best = c.bm25;
  for (const c of cands.values()) {
    const ti = termIndex(c.row);
    let covered = 0;
    let inName = 0;
    for (let i = 0; i < nStrong; i++) {
      const own = hasTerm(ti.own, terms[i], stems[i], true);
      if (own) inName++;
      if (own || hasTerm(ti.qual, terms[i], stems[i]) || hasTerm(ti.other, terms[i], stems[i])) covered++;
    }
    let weakInName = 0;
    for (let i = 0; i < weak.length; i++) if (ti.own.has(weak[i])) weakInName++;
    // A matched stopword-like name part counts; an unmatched one never lowers the coverage of other names.
    c.coverage = nStrong || weakInName ? (covered + WEAK_WEIGHT * weakInName) / (nStrong + WEAK_WEIGHT * weakInName) : 0;
    const nameTermCov = denom ? (inName + WEAK_WEIGHT * weakInName) / denom : 0;
    // How much of the symbol's own name the query explains (penalizes extra words: computeRefundPreview).
    const nameWords = splitIdentifier(c.row.name).filter((w) => w.length >= 2);
    let nameCov = 0;
    if (nameWords.length && denom) {
      let k = 0;
      for (const w of nameWords) if (explains.has(w) || nameStems.some((s) => s.length >= 3 && w.startsWith(s))) k++;
      nameCov = k / nameWords.length;
    }
    const bm = c.bm25 < 0 && best < 0 ? Math.sqrt(c.bm25 / best) : 0;
    const test = !wantsTests && isTestPath(c.row.path) ? 0.6 : DECLARATION_FILE_RE.test(c.row.path) ? 0.3 : 0;
    // A spelled name earns a boost when it covers the whole query or contains words the coverage cannot count
    // (get_or_create for "get or create queryset"); "compute refund" in "compute refund test" is plain coverage.
    const joinedBoost = !c.joined
      ? 0
      : c.joined >= queryWords
        ? JOINED_FULL_BOOST
        : c.joined >= 3 || nameWords.some((w) => QUERY_STOPWORDS.has(w))
          ? JOINED_BOOST_BASE + (JOINED_BOOST_SPAN * c.joined) / Math.max(2, queryWords)
          : 0;
    c.spelled = joinedBoost > 0;
    c.score =
      bm +
      1.2 * c.coverage +
      0.4 * nameCov +
      0.5 * nameTermCov +
      Math.max(NAME_BOOST[c.name], joinedBoost) +
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
  return { ranked, terms, weak, identifierQuery: idents.length > 0, targetStems };
}

/** Weak tail candidates (below this fraction of the top score) are not worth their tokens. */
export const RELATIVE_CUTOFF = 0.35;

/** A file holding at least this many of the top 10 candidates gets `DOMINANT_EXTRA` more slots. */
const DOMINANT_MIN = 3;
const DOMINANT_EXTRA = 3;
const SAME_NAME_PER_FILE = 2;

/**
 * Drop the weak tail (keeping at least `minKeep`), constructors whose class is listed too, and cap hits per
 * file unless the query names that file (its stem is a query term). A file that dominates the top results
 * (the code the query is about) gets a larger cap. Candidates cut only by the per-file cap go to `capped`.
 */
export function diversify(
  ranked: Candidate[],
  targetStems: Set<string>,
  perFile = 3,
  exactFile?: string,
  minKeep = 3,
  capped?: Candidate[],
  dominantExtra = DOMINANT_EXTRA,
): Candidate[] {
  const counts = new Map<string, number>();
  const out: Candidate[] = [];
  const cut = ranked.length ? RELATIVE_CUTOFF * ranked[0].score : 0;
  const listed = new Set(ranked.filter((c) => c.score >= cut).map((c) => c.row.id));
  const topCount = new Map<string, number>();
  for (const c of ranked.slice(0, 10)) if (c.score >= cut) topCount.set(c.row.path, (topCount.get(c.row.path) ?? 0) + 1);
  const sameName = new Map<string, number>();
  for (const c of ranked) {
    if (c.score < cut && out.length >= minKeep) break;
    if (c.row.kind === 'constructor' && c.row.parent_id !== null && listed.has(c.row.parent_id)) continue;
    const p = c.row.path;
    const n = counts.get(p) ?? 0;
    // Overrides of one name in one file (5 `reduce` methods) take 2 slots; the rest go to the "also" names.
    const nameKey = `${p}\0${c.row.name}`;
    if ((sameName.get(nameKey) ?? 0) >= SAME_NAME_PER_FILE) {
      capped?.push(c);
      continue;
    }
    const targeted = p === exactFile || targetStems.has(stemOf(p).toLowerCase());
    const cap = perFile + ((topCount.get(p) ?? 0) >= DOMINANT_MIN ? dominantExtra : 0);
    if (n >= cap && !targeted) {
      capped?.push(c);
      continue;
    }
    counts.set(p, n + 1);
    sameName.set(nameKey, (sameName.get(nameKey) ?? 0) + 1);
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
