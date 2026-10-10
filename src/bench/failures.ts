// Failure analysis of the kopt strategies (kopt bench failures / kopt bench all).
//
// For every task a kopt strategy (default kopt-pack) misses, this module re-runs the strategy, records what kopt
// returned (top pointers, callers line), what was expected, and classifies every missed gold item with mechanical
// evidence taken from the index:
//
//   (c) extraction    the gold file is not indexed, or no symbol with the gold name covers the gold line
//   (d) budget-format the gold name is shown but not its path (callers line), or the item appears with a 4x budget
//   (b) unresolved    usage/impact: the gold caller has no reference to the target, or the reference is unresolved
//   (e) multi-step    the item is one hop away from what was shown (resolved reference to/from a shown symbol, or
//                     callers of a shown target), but the query words do not describe it
//   (a) ranking       everything else: the item is in the index, the query describes it (or not: natural-language
//                     mismatch), but it is ranked below what fits in one pack
//
// A task's primary cause is the most severe cause among its missed items: c > b > a > e > d (an extraction gap
// cannot be fixed by ranking; a ranking miss cannot be fixed by a second call; a budget cut is the cheapest fix).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KoptConfig } from '../core/config.js';
import { newToolContext } from '../core/context.js';
import type { Store } from '../store/store.js';
import { computeRecall, mentionsName, mentionsPath } from './metrics.js';
import { blankStringsAndComments } from './quality.js';
import type { RetrievalModule } from './strategies.js';
import type { Lang } from '../core/types.js';
import type { BenchInput, BenchTask, FailureCause, GoldSymbol, LangId, StrategyName, TaskKind, TaskStrategyResult } from './types.js';
import { writePortable } from './portable.js';

export type { FailureCause } from './types.js';

/** Report order (a)..(e), as in the task description. */
export const FAILURE_CAUSES: readonly FailureCause[] = ['ranking', 'unresolved-refs', 'extraction', 'budget-format', 'multi-step'];

/** Severity order used to pick a task's primary cause (first = most severe). */
export const CAUSE_SEVERITY: readonly FailureCause[] = ['extraction', 'unresolved-refs', 'ranking', 'multi-step', 'budget-format'];

export const CAUSE_LABEL: Record<FailureCause, string> = {
  ranking: '(a) ranking / natural-language mismatch',
  'unresolved-refs': '(b) unresolved references',
  extraction: '(c) extraction gap',
  'budget-format': '(d) budget / format',
  'multi-step': '(e) needs multi-step exploration',
};

/** A pointer line of a kopt find/pack output (`  #w66 30-32 method def disable_rate_limits!`). */
export interface ShownHit {
  handle: string;
  path: string;
  start: number;
  end: number;
  kind: string;
  text: string;
}

export interface ParsedKoptOutput {
  header: string;
  hits: ShownHit[];
  /** Section headers of the packed bodies (`path:start-end #id`). */
  bodies: string[];
  /** `callers of #id: ...` line, when present. */
  callers?: string;
}

export interface ItemEvidence {
  item: 'symbol' | 'file';
  name?: string;
  file: string;
  line?: number;
  /** The gold file is in the index. */
  indexed: boolean;
  /** A symbol with the gold name covers the gold line (null for file items). */
  extracted: boolean | null;
  /** Same-name symbols of the file when none covers the line (wrong range), e.g. `verify 12-14`. */
  extractedElsewhere?: string[];
  /** The gold line lies inside an ERROR/MISSING node of a fresh parse (only checked for extraction gaps). */
  parseErrorAtLine?: boolean;
  /** 1-based rank in kopt's full candidate ranking (null: not a candidate at all). */
  rank: number | null;
  /** Rank after kopt's per-file diversification and weak-tail cut (null: dropped or not a candidate). */
  rankShown: number | null;
  /** Share of the query terms found in the item's name, qualified name, path, signature and doc. */
  coverage: number | null;
  /** Query words removed as stopwords although they are sub-words of the gold name (e.g. `get` of get_or_create). */
  stopwordsInName?: string[];
  /** The gold name appears in the output (its path does not). */
  nameShown: boolean;
  /** The item appears in a pack with 4x the budget and 30 pointers. */
  inBiggerPack: boolean;
  /** usage/impact callers: call sites of the target(s) in the gold symbol (comments and strings ignored) and the
   *  references the index holds for them. */
  refs?: { targets: string[]; callSites: number[]; extracted: number; resolved: number; attributedElsewhere: number };
  /** A shown symbol with a resolved reference to/from this item (handle + name). */
  linkedTo?: string;
  cause: FailureCause;
  why: string;
}

export interface TaskFailure {
  repo: string;
  language: LangId | string;
  taskId: string;
  kind: TaskKind;
  strategy: StrategyName;
  query: string;
  tokens: number;
  header: string;
  /** First pointers kopt returned, in output order. */
  topHits: Array<{ path: string; lines: string; kind: string; text: string }>;
  callers?: string;
  expected: { files: string[]; symbols: string[] };
  missed: { files: string[]; symbols: string[] };
  /** Usage/impact target identifiers taken from the question. */
  targets: string[];
  /** Top candidate of the full ranking (what kopt preferred), with its term coverage. */
  preferred?: { name: string; path: string; lines: string; kind: string; coverage: number; fixture: boolean };
  items: ItemEvidence[];
  cause: FailureCause;
  causes: FailureCause[];
  /** Set when re-running the strategy found the task (the bench run and this analysis disagree). */
  note?: string;
}

export type CauseCounts = Record<FailureCause, number>;

export interface FailureReport {
  schema: 'kopt-bench-failures/1';
  date: string;
  strategy: StrategyName;
  input: BenchInput;
  repos: Array<{ repo: string; language: string; tasks: number; missed: number; byCause: CauseCounts; itemsByCause: CauseCounts }>;
  /** Missed tasks per primary cause, per language. */
  byLanguage: Record<string, CauseCounts>;
  totals: CauseCounts;
  /** Missed gold items per cause (a task with 3 missed items counts 3 times). */
  itemTotals: CauseCounts;
  failures: TaskFailure[];
}

export function emptyCounts(): CauseCounts {
  return { ranking: 0, 'unresolved-refs': 0, extraction: 0, 'budget-format': 0, 'multi-step': 0 };
}

export function primaryCause(causes: FailureCause[]): FailureCause {
  for (const c of CAUSE_SEVERITY) if (causes.includes(c)) return c;
  return 'ranking';
}

// ---------------------------------------------------------------------------------------------------------
// Output parsing

const POINTER_RE = /^\s+(#[0-9a-z]+)\s+(\d+)-(\d+)\s+(\S+)\s*(.*)$/;

/** Splits a kopt find/pack output into its pointer list, packed body headers and callers line. */
export function parseKoptOutput(text: string): ParsedKoptOutput {
  const lines = text.split('\n');
  const out: ParsedKoptOutput = { header: lines[0] ?? '', hits: [], bodies: [] };
  let path = '';
  let i = 1;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) break;
    const m = POINTER_RE.exec(l);
    if (m) out.hits.push({ handle: m[1], path, start: Number(m[2]), end: Number(m[3]), kind: m[4], text: m[5].trim() });
    else if (!/^\s/.test(l)) path = l.trim();
  }
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (/^callers of #/.test(l)) out.callers = l.trim();
    else if (/^[^\s#][^\s]*:\d+-\d+( #[0-9a-z]+)?/.test(l)) out.bodies.push(l.trim());
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Targets of usage/impact tasks

/** Last segment of a code reference (`Foo::Bar.baz!` -> `baz!`, `resolveDriver()` -> `resolveDriver`). */
export function lastSegment(ref: string): string {
  const s = ref.replace(/\(.*$/, '').trim();
  const parts = s.split(/::|->|#|\.|\\/).filter(Boolean);
  return parts[parts.length - 1] ?? s;
}

/** Identifiers the question puts in backticks, else code-looking tokens of the search phrase. */
export function taskTargets(task: BenchTask): string[] {
  const out = new Set<string>();
  for (const m of task.question.matchAll(/`([^`]+)`/g)) {
    // file names, paths and phrases (`.ignore`, `a/b`, `x y`) are not code references
    if (/^\.|\/|\s/.test(m[1].trim())) continue;
    const seg = lastSegment(m[1]);
    if (/^[A-Za-z_$][\w$]*[?!=]?$/.test(seg)) out.add(seg);
    // `Foo.bar` also targets the class (callers referencing it qualified)
    const parts = m[1].replace(/\(.*$/, '').split(/::|->|#|\.|\\/).filter(Boolean);
    if (parts.length > 1 && /^[A-Z]/.test(parts[parts.length - 2])) out.add(parts[parts.length - 2]);
  }
  if (!out.size) {
    for (const t of (task.search ?? task.question).split(/\s+/)) {
      if (/[a-z][A-Z]|_|^[A-Z][a-z]+[A-Z]|[?!]$/.test(t)) out.add(lastSegment(t));
    }
  }
  return [...out];
}

// ---------------------------------------------------------------------------------------------------------
// Term coverage (same tokenizer as the index)

type TermsModule = { queryTerms(q: string): string[]; termsForText(t: string): string[]; QUERY_STOPWORDS: ReadonlySet<string> };

function stem(t: string): string {
  for (const suf of ['ing', 'ed', 'es', 's']) if (t.endsWith(suf) && t.length - suf.length >= 3) return t.slice(0, -suf.length);
  return t;
}

export function termCoverage(terms: string[], textTerms: string[]): number {
  if (!terms.length) return 0;
  const have = new Set(textTerms);
  let n = 0;
  for (const t of terms) {
    const s = stem(t);
    if (have.has(t) || [...have].some((x) => x === s || (s.length >= 3 && x.startsWith(s)))) n++;
  }
  return n / terms.length;
}

// ---------------------------------------------------------------------------------------------------------
// Analysis

interface SymLite {
  id: number;
  name: string;
  qname: string;
  kind: string;
  start_line: number;
  end_line: number;
  signature: string;
  doc: string | null;
  path: string;
}

type RankedRow = { row: { id: number; path: string; name: string; qname?: string; kind: string; start_line: number; end_line: number }; score: number };
type SearchFn = (store: Store, query: string) => { ranked: RankedRow[]; targetStems: Set<string> };
type DiversifyFn = (ranked: unknown[], targetStems: Set<string>, perFile?: number) => Array<{ row: { id: number } }>;

export interface FailureOptions {
  repo: string;
  language: LangId | string;
  repoRoot: string;
  store: Store;
  config: KoptConfig;
  retrieval: RetrievalModule;
  tasks: BenchTask[];
  /** Results of the bench run; only tasks the strategy missed are analyzed. */
  results: TaskStrategyResult[];
  input: BenchInput;
  /** Text given to the strategy for a task (search phrase, question...). */
  inputOf: (task: BenchTask) => string;
  strategy?: StrategyName;
  onProgress?: (m: string) => void;
}

async function loadInternals(): Promise<{ search?: SearchFn; diversify?: DiversifyFn; terms?: TermsModule; parserFor?: (lang: string) => Promise<any>; languageForPath?: (p: string) => string | undefined }> {
  const out: Awaited<ReturnType<typeof loadInternals>> = {};
  try {
    const s = await import(new URL('../retrieval/search.js', import.meta.url).href);
    if (typeof s.search === 'function') out.search = s.search;
    if (typeof s.diversify === 'function') out.diversify = s.diversify;
  } catch {
    /* ranking evidence becomes null */
  }
  try {
    const t = await import(new URL('../indexer/terms.js', import.meta.url).href);
    if (typeof t.queryTerms === 'function') out.terms = t as TermsModule;
  } catch {
    /* coverage evidence becomes null */
  }
  try {
    const l = await import(new URL('../indexer/languages.js', import.meta.url).href);
    out.parserFor = l.parserFor;
    out.languageForPath = l.languageForPath;
  } catch {
    /* no parse evidence */
  }
  return out;
}

/** True when `line` (1-based) lies inside an ERROR or MISSING node of a fresh parse of the file. */
async function parseErrorAt(repoRoot: string, path: string, line: number, internals: Awaited<ReturnType<typeof loadInternals>>): Promise<boolean | undefined> {
  const lang = internals.languageForPath?.(path);
  if (!lang || !internals.parserFor) return undefined;
  let text: string;
  try {
    text = readFileSync(join(repoRoot, path), 'utf8');
  } catch {
    return undefined;
  }
  const parser = await internals.parserFor(lang);
  const tree = parser.parse(text);
  if (!tree) return undefined;
  try {
    const row = line - 1;
    const stack = [tree.rootNode];
    while (stack.length) {
      const n = stack.pop();
      if (n.startPosition.row > row || n.endPosition.row < row) continue;
      if (n.isError || n.isMissing) return true;
      if (!n.hasError) continue;
      for (let i = 0; i < n.childCount; i++) stack.push(n.child(i));
    }
    return false;
  } finally {
    tree.delete();
  }
}

export async function analyzeFailures(o: FailureOptions): Promise<TaskFailure[]> {
  const strategy = o.strategy ?? 'kopt-pack';
  const log = o.onProgress ?? (() => {});
  const internals = await loadInternals();
  const db = o.store.db;
  const qFile = db.prepare('SELECT id FROM files WHERE path = ?');
  const qSyms = db.prepare(
    'SELECT s.id, s.name, s.qname, s.kind, s.start_line, s.end_line, s.signature, s.doc, f.path FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = ? AND s.name = ? ORDER BY s.start_line',
  );
  const qFileSyms = db.prepare(
    'SELECT s.id, s.name, s.qname, s.kind, s.start_line, s.end_line, s.signature, s.doc, f.path FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = ? ORDER BY s.start_line',
  );
  const qSym = db.prepare('SELECT s.id, s.name, s.qname, s.kind, s.start_line, s.end_line, s.signature, s.doc, f.path FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?');
  const qLinked = db.prepare(
    `SELECT r.from_symbol_id AS a, r.to_symbol_id AS b FROM refs r
     WHERE (r.from_symbol_id = ? AND r.to_symbol_id IN (SELECT value FROM json_each(?)))
        OR (r.to_symbol_id = ? AND r.from_symbol_id IN (SELECT value FROM json_each(?)))
     LIMIT 1`,
  );
  const qRefsAt = db.prepare(
    `SELECT r.name, r.qualifier, r.from_symbol_id AS from_id, r.to_symbol_id AS to_id FROM refs r JOIN files f ON f.id = r.file_id
     WHERE f.path = ? AND r.line = ?`,
  );
  const qParent = db.prepare('SELECT parent_id FROM symbols WHERE id = ?');
  const qTwoHop = db.prepare(
    `SELECT m.id AS mid, m.name AS name, m.qname AS qname FROM refs r1 JOIN files f ON f.id = r1.file_id
       JOIN symbols m ON m.id = r1.to_symbol_id
       JOIN refs r2 ON r2.from_symbol_id = m.id
       JOIN symbols t ON t.id = r2.to_symbol_id
     WHERE f.path = ? AND r1.line BETWEEN ? AND ? AND t.name IN (SELECT value FROM json_each(?)) LIMIT 1`,
  );
  const codeCache = new Map<string, string[] | undefined>();
  const codeLines = (path: string): string[] | undefined => {
    if (!codeCache.has(path)) {
      let lines: string[] | undefined;
      try {
        const text = readFileSync(join(o.repoRoot, path), 'utf8');
        const lang = internals.languageForPath?.(path) as Lang | undefined;
        lines = (lang ? blankStringsAndComments(text, lang) : text).split('\n');
      } catch {
        lines = undefined;
      }
      codeCache.set(path, lines);
    }
    return codeCache.get(path);
  };
  const terms = internals.terms;
  const out: TaskFailure[] = [];

  for (const task of o.tasks) {
    const res = o.results.find((r) => r.taskId === task.id && r.strategy === strategy);
    if (!res || res.skipped || res.recall.found) continue;
    const query = o.inputOf(task);
    log(`failures: ${task.id}`);
    const ctx = newToolContext(o.config);
    const outText = o.retrieval.find(o.store, { query, mode: 'pack' }, ctx).text;
    const recall = computeRecall(outText, task.gold);
    const parsed = parseKoptOutput(outText);
    const bigger = o.retrieval.find(o.store, { query, mode: 'pack', maxTokens: o.config.budgets.pack * 4, limit: 30 }, newToolContext(o.config)).text;
    const qTerms = terms ? terms.queryTerms(query) : [];
    const rawWords = terms ? terms.termsForText(query) : [];
    const stopped = terms ? rawWords.filter((w) => terms.QUERY_STOPWORDS.has(w)) : [];
    const symTerms = (s: SymLite) => (terms ? terms.termsForText(`${s.name} ${s.qname} ${s.path} ${s.signature} ${s.doc ?? ''}`) : []);

    // full ranking (pre- and post-diversification)
    let ranked: RankedRow[] = [];
    let shownIds: number[] = [];
    if (internals.search) {
      try {
        const sr = internals.search(o.store, query);
        ranked = sr.ranked;
        if (internals.diversify) shownIds = internals.diversify(sr.ranked, sr.targetStems, 3).map((c) => c.row.id);
      } catch {
        ranked = [];
      }
    }
    const rankOf = (pred: (r: { id: number; path: string }) => boolean) => {
      const i = ranked.findIndex((c) => pred(c.row));
      return i < 0 ? null : i + 1;
    };
    const rankShownOf = (id: number | undefined) => {
      if (id === undefined) return null;
      const i = shownIds.indexOf(id);
      return i < 0 ? null : i + 1;
    };
    const preferredRow = ranked[0]?.row;
    let preferred: TaskFailure['preferred'];
    if (preferredRow) {
      const s = qSym.get(preferredRow.id) as SymLite | undefined;
      if (s) preferred = { name: s.qname || s.name, path: s.path, lines: `${s.start_line}-${s.end_line}`, kind: s.kind, coverage: round2(termCoverage(qTerms, symTerms(s))), fixture: FIXTURE_RE.test(s.path) };
    }
    // symbols shown in the output (pointer handles, body headers, callers line)
    const shownHandles = new Set<number>();
    for (const m of outText.matchAll(/(?:^|\s)#([0-9a-z]{1,10})\b/g)) shownHandles.add(parseInt(m[1], 36));
    const shownList = JSON.stringify([...shownHandles]);
    const biggerHandles = new Set<number>();
    for (const m of bigger.matchAll(/(?:^|\s)#([0-9a-z]{1,10})\b/g)) biggerHandles.add(parseInt(m[1], 36));
    const targets = task.kind === 'usage' || task.kind === 'impact' ? taskTargets(task) : [];
    const focusHandle = /^callers of #([0-9a-z]+):/.exec(parsed.callers ?? '')?.[1];
    const callersFocus = focusHandle ? parseInt(focusHandle, 36) : undefined;
    const targetShown = targets.length > 0 && parsed.hits.some((h) => targets.some((t) => new RegExp(`(?<![\\w$])${escapeRe(t)}(?![\\w$])`).test(h.text)));

    const items: ItemEvidence[] = [];
    const missedSyms = task.gold.symbols.filter((s) => recall.symbolsMissed.includes(s.name) || (!mentionsPath(outText, s.file) && recall.filesMissed.includes(s.file)));
    const seen = new Set<string>();
    for (const g of missedSyms) {
      const key = `${g.file}:${g.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(await symbolEvidence(g));
    }
    // missed files without a missed gold symbol in them
    for (const f of recall.filesMissed) {
      if (items.some((it) => it.file === f)) continue;
      items.push(fileEvidence(f));
    }

    /** Call sites of the targets attributed to gold caller `g`: occurrences (comments/strings blanked) from its
     *  definition line up to the next gold symbol of the same file or the end of its indexed range, whichever is
     *  later, with the references the index holds at those lines. */
    /** Last line of gold caller `g`: its source extent (or indexed range, whichever is longer), cut at the next
     *  gold symbol of the same file. */
    function callerEnd(g: GoldSymbol, sym: SymLite): number {
      const code = codeLines(g.file) ?? [];
      const nextGold = task.gold.symbols.filter((x) => x.file === g.file && x.line > g.line).map((x) => x.line).sort((a, b) => a - b)[0];
      const lang = (internals.languageForPath?.(g.file) ?? '') as string;
      return Math.min(Math.max(sourceExtentEnd(code, g.line, lang), sym.end_line), nextGold ? nextGold - 1 : Infinity);
    }

    function callSites(g: GoldSymbol, sym: SymLite): Array<{ line: number; refs: Array<{ from_id: number | null; to_id: number | null }> }> {
      const code = codeLines(g.file);
      if (!code) return [];
      // the caller's extent from the source itself (index ranges may be broken), cut at the next gold symbol
      const until = callerEnd(g, sym);
      const ruby = /\.rb$/.test(g.file);
      const res = targets.map((t) => new RegExp(`(?<![\\w$])${escapeRe(t)}(?![\\w$${ruby ? '?!' : ''}])`));
      const out: Array<{ line: number; refs: Array<{ from_id: number | null; to_id: number | null }> }> = [];
      for (let l = g.line; l <= until && l <= code.length; l++) {
        if (!res.some((re) => re.test(code[l - 1]))) continue;
        const refs = (qRefsAt.all(g.file, l) as unknown as Array<{ name: string; qualifier: string | null; from_id: number | null; to_id: number | null }>).filter(
          (r) => targets.includes(r.name) || (r.qualifier !== null && targets.includes(lastSegment(r.qualifier))),
        );
        out.push({ line: l, refs });
      }
      return out;
    }

    /** True when symbol `inner` is `outer` or nested in it (parent chain). */
    function isInside(inner: number, outer: number): boolean {
      let cur: number | null = inner;
      for (let i = 0; cur !== null && i < 20; i++) {
        if (cur === outer) return true;
        cur = ((qParent.get(cur) as { parent_id: number | null } | undefined)?.parent_id ?? null) as number | null;
      }
      return false;
    }

    function dropReason(id: number): string {
      const c = ranked.find((x) => x.row.id === id);
      if (!c) return 'not a candidate';
      const top = ranked[0]?.score ?? 0;
      const samePathShown = shownIds.filter((sid) => ranked.find((x) => x.row.id === sid)?.row.path === c.row.path).length;
      if (top > 0 && c.score < 0.35 * top) return `below the weak-tail cut: score ${Math.round((c.score / top) * 100)}% of the top`;
      if (samePathShown >= 3) return 'dropped by the per-file cap: 3 hits of this file already listed';
      return 'dropped by diversification';
    }

    async function symbolEvidence(g: GoldSymbol): Promise<ItemEvidence> {
      const indexed = !!qFile.get(g.file);
      const ev: ItemEvidence = { item: 'symbol', name: g.name, file: g.file, line: g.line, indexed, extracted: false, rank: null, rankShown: null, coverage: null, nameShown: false, inBiggerPack: false, cause: 'ranking', why: '' };
      if (!indexed) {
        ev.cause = 'extraction';
        ev.why = 'gold file is not in the index (skipped or excluded)';
        return ev;
      }
      const same = qSyms.all(g.file, g.name) as unknown as SymLite[];
      const covering = same.filter((s) => s.start_line <= g.line && g.line <= s.end_line).sort((a, b) => a.end_line - a.start_line - (b.end_line - b.start_line));
      const sym = covering[0];
      ev.extracted = !!sym;
      if (!sym) {
        ev.extractedElsewhere = same.map((s) => `${s.kind} ${s.start_line}-${s.end_line}`);
        ev.parseErrorAtLine = await parseErrorAt(o.repoRoot, g.file, g.line, internals);
        // the enclosing symbol(s) the indexer did produce at that line
        const around = (qFileSyms.all(g.file) as unknown as SymLite[]).filter((s) => s.start_line <= g.line && g.line <= s.end_line).slice(-1)[0];
        ev.cause = 'extraction';
        ev.why = same.length
          ? `\`${g.name}\` is indexed in this file but no range covers line ${g.line} (${ev.extractedElsewhere.join(', ')})`
          : `no symbol \`${g.name}\` in the index for this file${ev.parseErrorAtLine ? '; the line is inside a parse ERROR node' : ''}${around ? `; innermost indexed symbol at that line: ${around.kind} ${around.name} ${around.start_line}-${around.end_line}` : ''}`;
        return ev;
      }
      ev.inBiggerPack = biggerHandles.has(sym.id) && mentionsPath(bigger, g.file);
      ev.rank = rankOf((r) => r.id === sym.id);
      ev.rankShown = rankShownOf(sym.id);
      ev.coverage = round2(termCoverage(qTerms, symTerms(sym)));
      const nameWords = terms ? terms.termsForText(g.name) : [];
      const sw = stopped.filter((w) => nameWords.includes(w));
      if (sw.length) ev.stopwordsInName = sw;

      // shown by handle (pointer or callers line), itself or through a member, but its path is not in the output
      const callerHandles = [...(parsed.callers ?? '').matchAll(/#([0-9a-z]{1,10})\b/g)].map((m) => parseInt(m[1], 36)).slice(1);
      const viaMember = callerHandles.find((h) => h !== sym.id && isInside(h, sym.id));
      ev.nameShown = shownHandles.has(sym.id) || viaMember !== undefined;
      if (ev.nameShown && !mentionsPath(outText, g.file)) {
        ev.cause = 'budget-format';
        if (callerHandles.includes(sym.id)) ev.why = 'listed on the callers line (handle + qualified name only); its path is never shown';
        else if (viaMember !== undefined) {
          const ms = qSym.get(viaMember) as SymLite | undefined;
          ev.why = `listed on the callers line through its member ${ms?.qname || ms?.name || `#${viaMember.toString(36)}`} (handle + qualified name only); its path is never shown`;
        } else ev.why = 'shown by handle, path missing from the output';
        return ev;
      }
      const isCaller = targets.length > 0 && !targets.includes(g.name);
      if (isCaller) {
        const sites = callSites(g, sym);
        ev.refs = { targets, callSites: sites.map((x) => x.line), extracted: 0, resolved: 0, attributedElsewhere: 0 };
        const refRows = sites.flatMap((site) => site.refs);
        ev.refs.extracted = sites.filter((x) => x.refs.length).length;
        const own = refRows.filter((r) => r.from_id === sym.id || (r.from_id !== null && isInside(r.from_id, sym.id)));
        ev.refs.attributedElsewhere = refRows.length - own.length;
        const resolved = own.filter((r) => r.to_id !== null);
        ev.refs.resolved = resolved.length;
        if (!sites.length) {
          // transitive caller (impact tasks): it calls a symbol that calls the target
          const hop = qTwoHop.get(g.file, sym.start_line, callerEnd(g, sym), JSON.stringify(targets)) as { mid: number; name: string; qname: string } | undefined;
          if (hop) {
            ev.cause = 'multi-step';
            ev.why = `transitive: it calls ${hop.qname || hop.name} (#${hop.mid.toString(36)}), which calls ${targets.join('/')}; a depth-2 kopt_refs (or a second call) reaches it`;
          } else {
            ev.cause = 'unresolved-refs';
            ev.why = `no call site of ${targets.join('/')} in its source and no resolved 2-hop path to it in the graph`;
          }
          return ev;
        }
        if (!ev.refs.extracted) {
          const pe = await parseErrorAt(o.repoRoot, g.file, sites[0].line, internals);
          ev.parseErrorAtLine = pe;
          ev.cause = 'extraction';
          ev.why = `the use of ${targets.join('/')} at line ${sites.map((x) => x.line).join(', ')} is not extracted as a reference${pe ? ' (inside a parse ERROR node)' : ''}`;
          return ev;
        }
        if (!own.length) {
          const other = refRows.find((r) => r.from_id !== null);
          const os = other ? (qSym.get(other.from_id!) as SymLite | undefined) : undefined;
          ev.cause = 'extraction';
          ev.why = `the use at line ${sites[0].line} is attributed to ${os ? `${os.kind} ${os.name} ${os.start_line}-${os.end_line}` : 'the file level'}, not to ${g.name} (${sym.start_line}-${sym.end_line}): wrong enclosing range`;
          return ev;
        }
        if (!resolved.length) {
          ev.cause = 'unresolved-refs';
          ev.why = `${own.length} reference(s) to ${targets.join('/')} in ${g.name} (line ${sites.map((x) => x.line).join(', ')}) but none resolved, so no callers edge`;
          return ev;
        }
        const focus = callersFocus ? (qSym.get(callersFocus) as SymLite | undefined) : undefined;
        const resolvedSyms = resolved.map((r) => qSym.get(r.to_id!) as SymLite | undefined).filter((x): x is SymLite => !!x);
        if (focus && resolved.some((r) => r.to_id === focus.id)) {
          ev.cause = 'budget-format';
          ev.why = `callers line of the target ${focus.name} is truncated (${/\(\+\d+ more\)/.exec(parsed.callers ?? '')?.[0] ?? 'cut'}) before ${g.name}`;
          return ev;
        }
        if (!resolvedSyms.some((t) => targets.includes(t.name) || t.qname.split(/[.:#\\/]+/).some((seg) => targets.includes(seg)))) {
          const t = resolvedSyms[0];
          ev.cause = 'unresolved-refs';
          ev.why = `the reference resolves to ${t ? `${t.qname || t.name} (${t.path}:${t.start_line})` : 'another symbol'}, not to the target ${targets.join('/')}`;
          return ev;
        }
        const shownTarget = resolvedSyms.find((t) => shownHandles.has(t.id));
        if (shownTarget) {
          ev.cause = 'multi-step';
          ev.why = `the called ${shownTarget.qname || shownTarget.name} (#${shownTarget.id.toString(36)}) is shown and the edge is resolved, but the callers line is for ${focus ? `#${focus.id.toString(36)} ${focus.qname || focus.name}` : 'another symbol'}; one kopt_refs on #${shownTarget.id.toString(36)} lists it`;
          return ev;
        }
        if (focus && resolvedSyms.some((t) => isInside(t.id, focus.id))) {
          ev.cause = 'unresolved-refs';
          ev.why = `calls to members of ${focus.qname || focus.name} (${resolvedSyms.map((t) => t.name).join(', ')}) are not counted as usages of the class, so its callers line says "${(parsed.callers ?? '').split(': ').slice(1).join(': ').slice(0, 40)}"`;
          return ev;
        }
      }
      if (ev.inBiggerPack) {
        ev.cause = 'budget-format';
        ev.why = `shown with a 4x budget (rank ${fmtRank(ev.rank)}, after diversification ${fmtRank(ev.rankShown)})`;
        return ev;
      }
      if (isCaller) {
        ev.cause = 'ranking';
        ev.why = `the callers edge is resolved but the called ${targets.join('/')} is not among the shown hits${targetShown ? '' : ' (target not surfaced by the query)'}`;
        return ev;
      }
      const link = qLinked.get(sym.id, shownList, sym.id, shownList) as { a: number; b: number } | undefined;
      if (link) {
        const other = link.a === sym.id ? link.b : link.a;
        const os = qSym.get(other) as SymLite | undefined;
        ev.linkedTo = `#${other.toString(36)} ${os?.name ?? ''}`.trim();
      }
      if (link && (ev.coverage ?? 0) < 0.5) {
        ev.cause = 'multi-step';
        ev.why = `query words cover ${pct(ev.coverage)} of it; reachable in one hop from shown ${ev.linkedTo} (${link.a === sym.id ? 'it references the shown symbol' : 'the shown symbol references it'})`;
        return ev;
      }
      ev.cause = 'ranking';
      const pref = preferred ? `; top candidate ${preferred.name} covers ${pct(preferred.coverage)}${preferred.fixture ? ' and is a test/fixture/doc file' : ''}` : '';
      const swNote = ev.stopwordsInName?.length ? `; query word(s) ${ev.stopwordsInName.map((w) => `"${w}"`).join(', ')} dropped as stopwords although part of the name` : '';
      ev.why =
        ev.rank === null
          ? `not a candidate at all (no FTS/name match); query words cover ${pct(ev.coverage)} of it${swNote}`
          : `ranked ${ev.rank} of ${ranked.length} candidates (pack lists ${parsed.hits.length} pointers${ev.rankShown ? `; ${ev.rankShown} after diversification` : `; ${dropReason(sym.id)}`}); query words cover ${pct(ev.coverage)} of it${pref}${swNote}`;
      return ev;
    }

    function fileEvidence(f: string): ItemEvidence {
      const indexed = !!qFile.get(f);
      const ev: ItemEvidence = { item: 'file', file: f, indexed, extracted: null, rank: null, rankShown: null, coverage: null, nameShown: false, inBiggerPack: mentionsPath(bigger, f), cause: 'ranking', why: '' };
      if (!indexed) {
        ev.cause = 'extraction';
        ev.why = 'file is not in the index';
        return ev;
      }
      ev.rank = rankOf((r) => r.path === f);
      const best = ranked.find((c) => c.row.path === f)?.row.id;
      ev.rankShown = rankShownOf(best);
      if (ev.inBiggerPack) {
        ev.cause = 'budget-format';
        ev.why = `file shown with a 4x budget (best symbol rank ${fmtRank(ev.rank)})`;
      } else {
        ev.why = ev.rank === null ? 'no symbol of this file is a candidate' : `best symbol of the file ranked ${ev.rank}`;
      }
      return ev;
    }

    const causes = [...new Set(items.map((i) => i.cause))];
    const f: TaskFailure = {
      repo: o.repo,
      language: o.language,
      taskId: task.id,
      kind: task.kind,
      strategy,
      query,
      tokens: res.tokens,
      header: parsed.header,
      topHits: parsed.hits.slice(0, 6).map((h) => ({ path: h.path, lines: `${h.start}-${h.end}`, kind: h.kind, text: h.text.slice(0, 120) })),
      callers: parsed.callers,
      expected: { files: [...task.gold.files], symbols: task.gold.symbols.map((s) => s.name) },
      missed: { files: res.recall.filesMissed, symbols: res.recall.symbolsMissed },
      targets,
      preferred,
      items,
      cause: primaryCause(causes),
      causes,
    };
    if (recall.found) f.note = 'the re-run found every gold item (non-deterministic output?)';
    out.push(f);
  }
  return out;
}

/**
 * Last line (1-based) of the definition starting at `line`, computed from the source (comments and strings already
 * blanked): `end` aligned with the definition (Ruby), dedent (Python), or the closing brace of the first block; an
 * expression body without braces ends before the next line indented like the definition.
 */
export function sourceExtentEnd(code: string[], line: number, lang: string): number {
  const indent = (l: string) => (/^[ \t]*/.exec(l)?.[0] ?? '').replace(/\t/g, '    ').length;
  const max = Math.min(code.length, line + 600);
  const ind0 = indent(code[line - 1] ?? '');
  if (lang === 'ruby') {
    for (let l = line + 1; l <= max; l++) {
      const t = code[l - 1];
      if (!t.trim()) continue;
      if (indent(t) < ind0) return l - 1;
      if (indent(t) === ind0) return /^\s*end\b/.test(t) ? l : l - 1;
    }
    return max;
  }
  if (lang === 'python') {
    let last = line;
    for (let l = line + 1; l <= max; l++) {
      const t = code[l - 1];
      if (!t.trim()) continue;
      if (indent(t) <= ind0) return last;
      last = l;
    }
    return last;
  }
  // braces inside parentheses (parameter object types, default values `= {}`) do not open the body
  let depth = 0;
  let paren = 0;
  let opened = false;
  for (let l = line; l <= max; l++) {
    const t = code[l - 1];
    // a line indented like the definition ends an expression body, unless it continues the header (`)`, `{`...)
    if (l > line && !opened && paren <= 0 && t.trim() && indent(t) <= ind0 && !/^\s*[).\]}{:]|^\s*(extends|implements|where|throws)\b/.test(t)) return l - 1;
    for (const ch of t) {
      if (ch === '(') paren++;
      else if (ch === ')') paren = Math.max(0, paren - 1);
      else if (paren === 0 && ch === '{') {
        depth++;
        opened = true;
      } else if (paren === 0 && ch === '}') {
        depth--;
        if (opened && depth <= 0) return l;
      }
    }
  }
  return max;
}

/** Test, fixture and documentation-snippet paths (broader than retrieval's test demotion, for diagnostics only). */
export const FIXTURE_RE =
  /(^|\/)(tests?|__tests__|__mocks__|spec|specs|testing|e2e|sbt-test|fixtures?|testdata|it|documentation|docs?)\/|\.(spec|test|e2e)\.[^/]+$|(Test|Tests|IT|Spec)\.(java|kt|kts|scala|cs|groovy|swift)$|_test\.(go|py|rb|exs?)$|(^|\/)test_[^/]+\.py$|_spec\.rb$/;

const round2 = (x: number) => Math.round(x * 100) / 100;
const pct = (x: number | null | undefined) => (x === null || x === undefined ? 'n/a' : `${Math.round(x * 100)}%`);
const fmtRank = (r: number | null) => (r === null ? 'none' : String(r));
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------------------------------------------------
// Report

export function buildFailureReport(
  failures: TaskFailure[],
  repos: Array<{ repo: string; language: string; tasks: number }>,
  strategy: StrategyName,
  input: BenchInput,
): FailureReport {
  const byLanguage: Record<string, CauseCounts> = {};
  const totals = emptyCounts();
  const itemTotals = emptyCounts();
  const repoRows = repos.map((r) => {
    const fs = failures.filter((f) => f.repo === r.repo);
    const byCause = emptyCounts();
    const itemsByCause = emptyCounts();
    for (const f of fs) {
      byCause[f.cause]++;
      for (const it of f.items) itemsByCause[it.cause]++;
    }
    return { repo: r.repo, language: r.language, tasks: r.tasks, missed: fs.length, byCause, itemsByCause };
  });
  for (const r of repoRows) {
    const l = (byLanguage[r.language] ??= emptyCounts());
    for (const c of FAILURE_CAUSES) {
      l[c] += r.byCause[c];
      totals[c] += r.byCause[c];
      itemTotals[c] += r.itemsByCause[c];
    }
  }
  return { schema: 'kopt-bench-failures/1', date: new Date().toISOString(), strategy, input, repos: repoRows, byLanguage, totals, itemTotals, failures };
}

const md = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

function table(head: string[], rows: string[][]): string {
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

export function renderFailuresMarkdown(r: FailureReport): string {
  const out: string[] = [];
  const missed = r.failures.length;
  const tasks = r.repos.reduce((a, x) => a + x.tasks, 0);
  out.push(`# kopt bench: failure analysis (${r.strategy})`);
  out.push('');
  out.push(`${missed} of ${tasks} tasks missed by \`${r.strategy}\` · input = \`${r.input}\` · ${r.date}`);
  out.push('');
  out.push('Every missed gold item is classified mechanically from the index (see `src/bench/failures.ts`):');
  out.push('');
  out.push('- **(c) extraction gap**: the gold file is not indexed, or no indexed symbol with the gold name covers the gold line.');
  out.push('- **(b) unresolved references** (usage/impact): the gold caller has no reference to the target, or it is unresolved.');
  out.push('- **(d) budget / format**: the gold name is shown without its path (callers line), or the item appears with 4x the pack budget.');
  out.push('- **(e) multi-step**: one hop away from a shown symbol (resolved reference) while the query words do not describe it, or a');
  out.push('  caller of a shown target (one `kopt_refs` call away).');
  out.push('- **(a) ranking / natural-language mismatch**: everything else; the item is indexed and reachable but ranked out of the pack.');
  out.push('');
  out.push("A task's primary cause is its most severe item cause: c > b > a > e > d.");
  out.push('');
  out.push('## Missed tasks per primary cause');
  out.push('');
  const head = ['language', 'repo', 'missed / tasks', ...FAILURE_CAUSES.map((c) => CAUSE_LABEL[c])];
  const rows = r.repos.map((x) => [x.language, x.repo, `${x.missed}/${x.tasks}`, ...FAILURE_CAUSES.map((c) => (x.byCause[c] ? String(x.byCause[c]) : '·'))]);
  rows.push(['**all**', '', `**${missed}/${tasks}**`, ...FAILURE_CAUSES.map((c) => `**${r.totals[c]}**`)]);
  out.push(table(head, rows));
  out.push('');
  out.push('## Missed gold items per cause');
  out.push('');
  const irows = r.repos.map((x) => [x.language, x.repo, ...FAILURE_CAUSES.map((c) => (x.itemsByCause[c] ? String(x.itemsByCause[c]) : '·'))]);
  irows.push(['**all**', '', ...FAILURE_CAUSES.map((c) => `**${r.itemTotals[c]}**`)]);
  out.push(table(['language', 'repo', ...FAILURE_CAUSES.map((c) => CAUSE_LABEL[c])], irows));
  out.push('');

  for (const repo of r.repos) {
    const fs = r.failures.filter((f) => f.repo === repo.repo);
    out.push(`## ${repo.language}: ${repo.repo} (${fs.length} missed of ${repo.tasks})`);
    out.push('');
    if (!fs.length) {
      out.push('No miss.');
      out.push('');
      continue;
    }
    for (const f of fs) {
      out.push(`### ${f.taskId} (${f.kind}) — ${CAUSE_LABEL[f.cause]}${f.causes.length > 1 ? ` (also ${f.causes.filter((c) => c !== f.cause).map((c) => CAUSE_LABEL[c].split(' ')[0]).join(', ')})` : ''}`);
      out.push('');
      out.push(`- query: \`${md(f.query)}\` · ${f.tokens} tok`);
      out.push(`- kopt returned: ${f.topHits.length ? f.topHits.slice(0, 5).map((h) => `\`${md(h.path.split('/').slice(-2).join('/'))}:${h.lines} ${md(h.text.slice(0, 60))}\``).join('; ') : '(no pointer)'}`);
      if (f.callers) out.push(`- callers line: \`${md(f.callers.slice(0, 160))}\``);
      if (f.preferred) out.push(`- top candidate: \`${md(f.preferred.name)}\` (${f.preferred.kind}, ${md(f.preferred.path)}:${f.preferred.lines}, query coverage ${pct(f.preferred.coverage)})`);
      out.push(`- expected: ${f.expected.symbols.map((s) => `\`${md(s)}\``).join(', ')} in ${f.expected.files.map((p) => `\`${md(p)}\``).join(', ')}`);
      out.push(`- missed: ${[...f.missed.symbols.map((s) => `\`${md(s)}\``), ...f.missed.files.map((p) => `\`${md(p.split('/').pop() ?? p)}\` (path)`)].join(', ')}`);
      for (const it of f.items) {
        const what = it.item === 'symbol' ? `\`${md(it.name ?? '')}\` ${md(it.file.split('/').pop() ?? '')}:${it.line}` : `file \`${md(it.file)}\``;
        out.push(`  - ${what}: ${CAUSE_LABEL[it.cause].split(' ')[0]} ${md(it.why)}`);
      }
      if (f.note) out.push(`- note: ${f.note}`);
      out.push('');
    }
  }
  return out.join('\n');
}

export function writeFailures(r: FailureReport, outDir: string, label = 'failures'): string[] {
  mkdirSync(outDir, { recursive: true });
  const mdPath = join(outDir, `${label}.md`);
  const jsonPath = join(outDir, `${label}.json`);
  writePortable(mdPath, renderFailuresMarkdown(r));
  writePortable(jsonPath, JSON.stringify(r, null, 2) + '\n');
  return [mdPath, jsonPath];
}
