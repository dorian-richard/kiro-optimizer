// kopt_find: ranked pointers (hits) or a task-level context pack (pointers + best bodies + callers/callees).

import type { FindParams } from '../core/api.js';
import type { ToolContext } from '../core/context.js';
import { estimateTokens, tokensToChars } from '../core/tokens.js';
import type { ToolResult } from '../core/types.js';
import type { Store } from '../store/store.js';
import { queryTerms } from '../indexer/terms.js';
import { budgetOf, compactLine, compose, fitBody, guard, h, isFieldKind, isTestPath, mentionsTests, moreSuffix, pathFilter, plural, pointerLine, quote, result, shortQ, type SymRow } from './common.js';
import { type Section, symbolSection } from './read.js';
import { type Candidate, NameMatch, diversify, identifierTokens, relevantCount, search } from './search.js';
import { isContainer } from './skeleton.js';
import { loadSource, locate, sliceLines } from './source.js';
import { type UsageRow, calleeLines, countFiles, possibleRows, thinWrappers, unresolvedCount, usageLines, usageRows } from './usage.js';

export { usageTargets } from './usage.js';

const KINDS = new Set(['class', 'interface', 'enum', 'type', 'record', 'struct', 'trait', 'module', 'namespace', 'function', 'method', 'constructor', 'field', 'property', 'constant']);
/** Bodies longer than this are packed as skeletons (the agent reads the parts it needs with kopt_read). */
const PACK_BODY_MAX_LINES = 80;
/** Containers up to this many lines are packed whole (records, small classes) rather than as skeletons. */
const SMALL_CONTAINER_LINES = 15;
const PACK_MAX_BODIES = 5;
const PACK_POINTERS = 8;
const PACK_COMPACT_POINTERS = 4;
/** Bodies are added while the pack stays under this share of its budget (the first one may go beyond). */
const PACK_FILL = 0.6;
/** Candidates scoring below this share of the top score are not worth a body. */
const BODY_CUTOFF = 0.55;
/** Share of budgets.pack a pack for a single identifier gets when the call gives no maxTokens. */
const SINGLE_IDENT_PACK = 0.6;
/** At most this many symbols get a callers section. */
const MAX_CALLER_FOCUS = 3;

function intIn(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Number(v);
  if (v === undefined || v === null || !Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

interface Selection {
  rows: SymRow[];
  /** Rendered line per symbol id (full, with doc, or compact). */
  lines: Map<number, string>;
  /** Why the selection stopped before the end of the list. */
  stop?: 'limit' | 'budget';
}

/**
 * Greedy selection in rank order (path line counted once per file). A hit whose full line does not fit is
 * shown compact (handle, range, kind, name); docs are added afterwards while the budget allows.
 */
function selectHits(list: Candidate[], limit: number, budgetChars: number, docs: boolean, sigMax = 140, fullCount = Infinity): Selection {
  const rows: SymRow[] = [];
  const lines = new Map<number, string>();
  const files = new Set<string>();
  let used = 0;
  let stop: Selection['stop'];
  for (const c of list) {
    if (rows.length >= limit) {
      stop = 'limit';
      break;
    }
    const pathCost = files.has(c.row.path) ? 0 : c.row.path.length + 1;
    let line = rows.length < fullCount ? pointerLine(c.row, false, sigMax) : compactLine(c.row);
    if (used + pathCost + line.length + 1 > budgetChars) {
      line = compactLine(c.row);
      if (used + pathCost + line.length + 1 > budgetChars) {
        stop = 'budget';
        break;
      }
    }
    rows.push(c.row);
    lines.set(c.row.id, line);
    files.add(c.row.path);
    used += pathCost + line.length + 1;
  }
  if (docs) {
    for (const r of rows) {
      const cur = lines.get(r.id)!;
      if (!r.doc || cur !== pointerLine(r, false, sigMax)) continue;
      const withDoc = pointerLine(r, true, sigMax);
      if (used + withDoc.length - cur.length > budgetChars) continue;
      lines.set(r.id, withDoc);
      used += withDoc.length - cur.length;
    }
  }
  return { rows, lines, stop };
}

function noHits(query: string, maxTokens: number): ToolResult {
  const what = `find ${quote(query)}`;
  if (!queryTerms(query).length && !identifierTokens(query).length) {
    return result(`${what} · 0 hits · no searchable terms; use identifiers or domain words`, maxTokens, { hits: 0 });
  }
  const hint = 'next: try other words (synonyms, a class or file name) or kopt_outline . for the repo map';
  return result(compose((tok) => `${what} · 0 hits · ~${tok} tok`, hint, maxTokens), maxTokens, { hits: 0 });
}

/**
 * When the kinds / path filters leave nothing, the same search with fewer filters (kinds dropped first, then the
 * path, then both), and the one-line note that says so: a "retry without filters" answer would cost a call.
 */
function relaxFilters(
  store: Store,
  query: string,
  p: FindParams,
  kinds: string[] | undefined,
  filter: ReturnType<typeof pathFilter>,
  pack: boolean,
): { sr: ReturnType<typeof search>; ranked: Candidate[]; note: string } | undefined {
  const hasKinds = !!kinds?.length;
  const tries: Array<{ k?: string[]; f?: typeof filter; dropped: string }> = [];
  if (hasKinds && filter) tries.push({ f: filter, dropped: 'kinds' }, { k: kinds, dropped: 'path' });
  tries.push({ dropped: hasKinds && filter ? 'kinds and path' : hasKinds ? 'kinds' : 'path' });
  for (const t of tries) {
    const sr = search(store, query, { kinds: t.k, filter: t.f, pathText: t.f ? p.path : undefined, deadline: p.deadline });
    const ranked = diversify(sr.ranked, sr.targetStems, 3, t.f?.exact, 3, undefined, pack ? undefined : 0);
    if (!ranked.length) continue;
    const what = [hasKinds ? `kinds ${kinds!.join(',')}` : '', filter ? `path ${p.path}` : ''].filter(Boolean).join(' + ');
    return { sr, ranked, note: `note: no hits with ${what}; showing hits without the ${t.dropped} filter` };
  }
  return undefined;
}

function overlaps(a: SymRow, b: SymRow): boolean {
  return a.path === b.path && a.start_line <= b.end_line && b.start_line <= a.end_line;
}

/** Files in first-appearance order, path printed once, hits indented below, then the file's extra names. */
function renderPointers(rows: SymRow[], lineOf: (r: SymRow) => string, also: Map<string, string>): string {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.path)) continue;
    seen.add(r.path);
    out.push(r.path);
    for (const x of rows) if (x.path === r.path) out.push(lineOf(x));
    const a = also.get(r.path);
    if (a) out.push(a);
  }
  return out.join('\n');
}

/**
 * "  also: name L12 #h, other L40 #h2" for files already listed: relevant symbols of the same file left out by
 * the per-file cap or the limit. Names only (a few tokens each), best first.
 */
function alsoLines(ranked: Candidate[], shown: SymRow[], floor: number, budgetChars: number, perFile = 5, firstFile = 8): { lines: Map<string, string>; count: number } {
  const files = new Map<string, Candidate[]>();
  const shownIds = new Set(shown.map((r) => r.id));
  const paths = new Set(shown.map((r) => r.path));
  for (const c of ranked) {
    if (c.score < floor) break;
    if (shownIds.has(c.row.id) || !paths.has(c.row.path) || isFieldKind(c.row.kind) || c.row.kind === 'constructor') continue;
    const arr = files.get(c.row.path) ?? [];
    if (arr.length < (c.row.path === shown[0]?.path ? firstFile : perFile) && !arr.some((x) => x.row.name === c.row.name)) arr.push(c);
    files.set(c.row.path, arr);
  }
  const lines = new Map<string, string>();
  let used = 0;
  let count = 0;
  for (const p of paths) {
    const arr = files.get(p);
    if (!arr?.length) continue;
    const parts: string[] = [];
    let len = 10;
    for (const c of arr) {
      const part = `${c.row.name} L${c.row.start_line} ${h(c.row.id)}`;
      if (used + len + part.length + 2 > budgetChars) break;
      parts.push(part);
      len += part.length + 2;
    }
    if (!parts.length) continue;
    lines.set(p, `  also: ${parts.join(', ')}`);
    used += len;
    count += parts.length;
  }
  return { lines, count };
}

/** Score floor of "also:" names, relative to the best candidate the query does not name (a name boost says nothing about the rest). */
function alsoFloorOf(all: Candidate[], top: Candidate): number {
  const unnamed = all.find((c) => c.name < NameMatch.QualifiedCI && !c.spelled);
  return Math.max(0.45 * (unnamed?.score ?? top.score), 1.2);
}

/** True for short bodies that only delegate (`return super.x(...)`, a one-line forward): not worth a slot. */
function trivialBody(store: Store, row: SymRow): boolean {
  const n = row.end_line - row.start_line + 1;
  if (n > 4 || isContainer(row.kind)) return false;
  if (n <= 1) return true;
  const src = loadSource(store, row.path);
  if (!src) return false;
  const loc = locate(store, src, row);
  const body = sliceLines(src, loc.start, loc.end)
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l && l !== '}' && l !== 'end' && l !== '{');
  return body.length <= 1 && (body.length === 0 || /\bsuper\b|^return\s+\w+(\.\w+)*\(.*\);?$|^\w+(\.\w+)*\(.*\);?$/.test(body[0]));
}

/**
 * Symbols the query names (identifier tokens matched by name, or names spelled by its words), best ranked first;
 * members win over their container, and a class stands for its constructors.
 */
function namedFocus(ranked: Candidate[]): SymRow[] {
  const named = ranked.filter((c) => (c.name >= NameMatch.QualifiedCI || c.spelled) && c.row.kind !== 'constructor' && (c.name >= NameMatch.QualifiedCI || !isFieldKind(c.row.kind)));
  const out: SymRow[] = [];
  const names = new Set<string>();
  for (const c of named) {
    const key = c.row.name.toLowerCase();
    if (names.has(key)) continue;
    names.add(key);
    out.push(c.row);
  }
  // A named container whose named member is also listed: the member is the more specific target.
  return out.filter((r) => !(isContainer(r.kind) && out.some((m) => m !== r && m.parent_id === r.id)));
}

/** "  tests: path (12), path (3), +2 files" */
function testsLine(rows: UsageRow[]): string {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.path, (counts.get(r.path) ?? 0) + 1);
  const files = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const shown = files.slice(0, 3).map(([p, n]) => `${p} (${n})`);
  return `  tests: ${shown.join(', ')}${files.length > 3 ? `, +${plural(files.length - 3, 'file')}` : ''}`;
}

interface CallerSection {
  lines: string[];
  more: number;
}

/**
 * "callers of #h Name · n refs in f files · complete:" then one line per file with path, lines and calling symbols
 * (each with its declaration lines), then the callers of thin wrappers among them when room is left. "complete"
 * means every reference to the name in the index resolved; otherwise the head counts the unresolved ones.
 */
function callersSection(store: Store, sym: SymRow, maxChars: number): CallerSection | undefined {
  const label = `${h(sym.id)} ${shortQ(sym.qname, sym.name)}`;
  const { rows, family } = usageRows(store, sym);
  const fam = family.length > 1 ? ` (+${family.length - 1} related decl${family.length > 2 ? 's' : ''})` : '';
  const who = isFieldKind(sym.kind) ? 'users' : 'callers';
  let body: string[];
  let head: string;
  if (rows.length) {
    const unresolved = unresolvedCount(store, sym, family);
    const status = unresolved ? `${unresolved >= 10000 ? '10,000+' : unresolved} unresolved same-name ref${unresolved === 1 ? '' : 's'}` : 'complete';
    head = `${who} of ${label}${fam} · ${plural(rows.length, 'ref')} in ${plural(countFiles(rows), 'file')} · ${status}:`;
    // Product code one line per file; tests (which files cover it) on one summary line.
    const prod = rows.filter((r) => !isTestPath(r.path));
    const tests = rows.filter((r) => isTestPath(r.path));
    body = usageLines(prod, '  ', 3, 5);
    if (tests.length) body.push(testsLine(tests));
  } else {
    const possible = possibleRows(store, sym, new Set(family));
    if (possible.length) {
      head = `${who} of ${label}: none resolved; possible (unresolved refs named ${sym.name}):`;
      body = usageLines(possible, '  ? ', 3, 5);
    } else {
      const line = `${who} of ${label}: none found`;
      return line.length <= maxChars ? { lines: [line], more: 0 } : undefined;
    }
  }
  if (head.length + 1 > maxChars) return undefined;
  const lines = [head];
  let used = head.length + 1;
  let i = 0;
  const tail = (k: number) => `  +${plural(k, 'file')} (kopt_refs ${h(sym.id)})`;
  for (; i < body.length; i++) {
    const reserve = i < body.length - 1 ? tail(body.length - i).length + 1 : 0;
    if (used + body[i].length + 1 + reserve > maxChars) break;
    lines.push(body[i]);
    used += body[i].length + 1;
  }
  const more = body.length - i;
  if (more > 0) lines.push(tail(more));
  else if (rows.length) {
    // Room left: the callers of thin wrappers (a small function that only forwards to it) are its real users.
    const direct = new Set(rows.map((r) => r.from_id));
    for (const w of thinWrappers(store, rows, new Set(family), 2)) {
      const ws = store.symbolById(w.from_id!);
      if (!ws) continue;
      const wu = usageRows(store, ws);
      const own = new Set(wu.family);
      const wrows = wu.rows.filter(
        (r) => r.kind !== 'import' && !isTestPath(r.path) && (r.from_id === null || (!own.has(r.from_id) && !family.includes(r.from_id) && !direct.has(r.from_id))),
      );
      if (!wrows.length) continue;
      const wl = [`  via wrapper ${h(ws.id)} ${shortQ(ws.qname, ws.name)} · ${plural(wrows.length, 'ref')}:`, ...usageLines(wrows, '    ', 2, 3)];
      let k = 0;
      let add = 0;
      for (; k < wl.length && used + add + wl[k].length + 1 <= maxChars; k++) add += wl[k].length + 1;
      if (k < 2) break;
      lines.push(...wl.slice(0, k));
      used += add;
      if (k < wl.length) break;
    }
  }
  if (lines.length === 1) return undefined;
  return { lines, more };
}

/** "callees of #h Name:" then resolved callees grouped by target file. */
function calleesSection(store: Store, sym: SymRow, maxChars: number): string[] | undefined {
  if (isContainer(sym.kind) || isFieldKind(sym.kind)) return undefined;
  const out = calleeLines(store, [sym], { kinds: new Set(['call', 'new']), perFile: 8, dropDubious: true });
  const resolved = out.lines.filter((l) => !l.startsWith('unresolved/external:'));
  if (!resolved.length) return undefined;
  const head = `callees of ${h(sym.id)} ${shortQ(sym.qname, sym.name)}:`;
  const lines = [head];
  let used = head.length + 1;
  for (const l of resolved) {
    const line = `  ${l}`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.length > 1 ? lines : undefined;
}

export function find(store: Store, p: FindParams, ctx: ToolContext): ToolResult {
  ctx.ledger.tick();
  const mode = p?.mode === 'pack' ? 'pack' : 'hits';
  const query = typeof p?.query === 'string' ? p.query.trim() : '';
  // A pack for one identifier needs its body, callers and callees, not a dozen neighbours: a smaller default budget.
  const packBudget = !/\s/.test(query) && identifierTokens(query).length === 1 ? Math.round(ctx.config.budgets.pack * SINGLE_IDENT_PACK) : ctx.config.budgets.pack;
  const maxTokens = budgetOf(p?.maxTokens, mode === 'pack' ? packBudget : ctx.config.budgets.find);
  if (!query) return result('find: query is required (words or identifiers, e.g. "compute refund" or OrderService.place)', maxTokens);
  return guard('find', maxTokens, () => findImpl(store, p, ctx, mode, query, maxTokens));
}

function findImpl(store: Store, p: FindParams, ctx: ToolContext, mode: 'hits' | 'pack', query: string, maxTokens: number): ToolResult {
  // Pack: 8 pointers with signatures, then up to 4 compact ones (handle, lines, kind, name: ~10 tokens each).
  const limit = intIn(p.limit, 1, 100, mode === 'pack' ? PACK_POINTERS + PACK_COMPACT_POINTERS : 12);
  const kinds = Array.isArray(p.kinds) ? p.kinds.filter((k) => KINDS.has(k)) : undefined;
  const filter = pathFilter(p.path, store.root);

  let sr = search(store, query, { kinds, filter, pathText: p.path, deadline: p.deadline });
  // Hits keep 3 per file (file diversity) and name the rest on an "also:" line; pack lets a dominant file have more.
  let ranked = diversify(sr.ranked, sr.targetStems, 3, filter?.exact, 3, undefined, mode === 'pack' ? undefined : 0);
  let note = '';
  if (!ranked.length && (filter || kinds?.length)) {
    const relaxed = relaxFilters(store, query, p, kinds, filter, mode === 'pack');
    if (relaxed) ({ sr, ranked, note } = relaxed);
  }
  if (!ranked.length) return noHits(query, maxTokens);
  const relevant = relevantCount(ranked);
  const what = `${mode === 'pack' ? 'pack' : 'find'} ${quote(query)}`;
  const n = Math.min(limit, ranked.length);
  const headReserve =
    estimateTokens(`${what} · ${plural(n, 'hit')} · ${mode === 'pack' ? '5 bodies · ' : ''}~${maxTokens} tok${moreSuffix(ranked.length, 'maxTokens')}`) +
    1 +
    (note ? estimateTokens(note) + 1 : 0);
  const lineOf = (sel: Selection) => (r: SymRow) => sel.lines.get(r.id)!;

  if (mode === 'hits') {
    const avail = Math.max(0, maxTokens - headReserve);
    const alsoChars = tokensToChars(Math.floor(avail * 0.12));
    let sel = selectHits(ranked, limit, tokensToChars(avail) - alsoChars, true);
    let suffix = (k: number) => moreSuffix(k, sel.stop === 'limit' ? 'limit' : 'maxTokens');
    if (!sel.rows.length) {
      // Tiny budget: a short "+k more" leaves room for at least the top hit.
      suffix = (k: number) => (k > 0 ? ` · +${k} more` : '');
      const shortReserve = estimateTokens(`${what} · 1 hit · ~${maxTokens} tok${suffix(ranked.length)}`) + 1;
      sel = selectHits(ranked, limit, tokensToChars(Math.max(0, maxTokens - shortReserve)), false);
    }
    const also = sel.rows.length ? alsoLines(sr.ranked, sel.rows, alsoFloorOf(sr.ranked, ranked[0]), alsoChars) : { lines: new Map<string, string>(), count: 0 };
    const more = Math.max(0, Math.max(relevant, n) - sel.rows.length - also.count);
    const body = (note ? note + '\n' : '') + renderPointers(sel.rows, lineOf(sel), also.lines);
    const text = compose((tok) => `${what} · ${plural(sel.rows.length, 'hit')} · ~${tok} tok${suffix(more)}`, body, maxTokens);
    return result(text, maxTokens, { mode, hits: sel.rows.length, more, top: sel.rows[0]?.id });
  }
  return packImpl(store, p, ctx, sr.ranked, ranked, { what, terms: sr.terms, limit, maxTokens, headReserve, relevant, note });
}

interface PackOpts {
  what: string;
  terms: string[];
  limit: number;
  maxTokens: number;
  headReserve: number;
  relevant: number;
  /** One line printed before the pointers (filters relaxed). */
  note?: string;
}

/**
 * pack: pointers (<= ~30% of the budget, with the extra relevant names of the listed files), then bodies of the
 * best symbols (skeletons for containers and long ones, members of a packed container that match the query),
 * then callers of the symbols the query names (or of the best body) with path:line, then callees of the best body.
 */
function packImpl(store: Store, p: FindParams, ctx: ToolContext, all: Candidate[], ranked: Candidate[], o: PackOpts): ToolResult {
  const { what, limit, maxTokens, headReserve, relevant } = o;
  const wantsTests = mentionsTests(o.terms);
  const avail = Math.max(0, maxTokens - headReserve);
  const top = ranked[0];
  const ptr = selectHits(ranked, limit, tokensToChars(Math.floor(avail * 0.3)), false, 110, PACK_POINTERS);
  const also = alsoLines(all, ptr.rows, alsoFloorOf(all, top), tokensToChars(Math.floor(avail * 0.08)));
  const pointers = renderPointers(ptr.rows, (r) => ptr.lines.get(r.id)!, also.lines);
  let used = estimateTokens(pointers) + 1;

  // Which symbols get a callers section: the ones the query names, else the best non-field hit.
  const named = namedFocus(all.slice(0, 60));
  const bodyCands = ranked.filter((c) => !isFieldKind(c.row.kind));
  const focus: SymRow[] = named.length ? named.slice(0, MAX_CALLER_FOCUS) : bodyCands.length ? [bodyCands[0].row] : [];

  // Callers (path:line per caller) of the focus symbols: computed first, their actual size is charged.
  const callerTexts: string[] = [];
  let callerChars = tokensToChars(Math.min(Math.floor(avail * 0.25), 140 + 125 * focus.length));
  for (const f of focus) {
    const per = Math.floor(callerChars / Math.max(1, focus.length - focus.indexOf(f)));
    const cs = callersSection(store, f, per);
    if (!cs) continue;
    const text = cs.lines.join('\n');
    callerTexts.push(text);
    callerChars -= text.length + 2;
    used += estimateTokens(text) + 1;
  }

  // Bodies: named symbols first, then by rank; containers as skeletons followed by their matching members.
  const order: Candidate[] = [];
  const namedIds = new Set(named.map((r) => r.id));
  for (const c of all) if (namedIds.has(c.row.id) && !isFieldKind(c.row.kind)) order.push(c);
  for (const c of bodyCands) if (!order.includes(c)) order.push(c);
  const calleesReserve = Math.min(Math.floor(avail * 0.08), 160);
  let remaining = avail - used - calleesReserve - 2;
  const softCap = Math.floor(maxTokens * PACK_FILL) - headReserve - calleesReserve;

  // Unnamed bodies must score close to the best candidate the query does not name.
  const bodyFloor = BODY_CUTOFF * (all.find((c) => c.name < NameMatch.QualifiedCI && !c.spelled)?.score ?? top.score);
  const sections: string[] = [];
  const packed: SymRow[] = [];
  let bodies = 0;
  const tryPack = (row: SymRow, isNamed: boolean): boolean => {
    if (remaining < 20 || packed.length >= PACK_MAX_BODIES) return false;
    if (packed.some((x) => overlaps(x, row) && !(isContainer(x.kind) && row.parent_id === x.id))) return false;
    const file = store.fileById(row.file_id);
    if (!file) return false;
    const lines = row.end_line - row.start_line + 1;
    const long = lines > PACK_BODY_MAX_LINES;
    // A small container (record, short class) reads best as its body; a one-liner adds nothing to its pointer.
    if (isContainer(row.kind) && lines <= 2 && !isNamed) return false;
    const want: 'body' | 'skeleton' = (isContainer(row.kind) && lines > SMALL_CONTAINER_LINES) || long ? 'skeleton' : 'body';
    let sec: Section = symbolSection(store, row, file, { mode: want, ctx, fresh: !!p.fresh, maxTokens: remaining });
    if (estimateTokens(sec.text) > remaining && want === 'body') {
      sec = symbolSection(store, row, file, { mode: 'skeleton', ctx, fresh: !!p.fresh, maxTokens: remaining });
    }
    const t = estimateTokens(sec.text) + 1;
    if (sec.kind === 'error' || t > remaining) return false;
    // Past the soft cap only the first body is worth its tokens.
    if (packed.length && used + t > softCap) return false;
    sec.commit?.();
    sections.push(sec.text);
    packed.push(row);
    if (sec.kind === 'body' || sec.kind === 'skeleton') bodies++;
    remaining -= t;
    used += t;
    return true;
  };
  for (const c of order) {
    if (packed.length >= PACK_MAX_BODIES || remaining < 20) break;
    const isNamed = namedIds.has(c.row.id);
    if (!isNamed && c.score < bodyFloor) break;
    if (!isNamed && packed.length && used >= softCap) break;
    if (!isNamed && (trivialBody(store, c.row) || (!wantsTests && isTestPath(c.row.path)))) continue;
    if (!tryPack(c.row, isNamed)) continue;
    if (isContainer(c.row.kind)) {
      // The container's skeleton lists its members; add the bodies of the members that match the query.
      const members = all.filter((m) => m.row.parent_id === c.row.id && !isFieldKind(m.row.kind) && m.score >= bodyFloor && !trivialBody(store, m.row));
      for (const m of members.slice(0, 2)) if (used < softCap) tryPack(m.row, namedIds.has(m.row.id));
    }
  }

  // Callees of the best packed function body (else of the first named function).
  const tail = [...callerTexts];
  const calleeOf = packed.find((r) => !isContainer(r.kind)) ?? focus.find((r) => !isContainer(r.kind));
  if (calleeOf) {
    const cl = calleesSection(store, calleeOf, tokensToChars(calleesReserve + Math.max(0, Math.min(remaining, Math.floor(avail * 0.04)))));
    if (cl) tail.push(cl.join('\n'));
  }

  const body = [o.note ? `${o.note}\n${pointers}` : pointers, ...sections, ...tail].filter(Boolean).join('\n\n');
  const more = Math.max(0, relevant - ptr.rows.length - also.count);
  const why = ptr.stop === 'budget' ? 'maxTokens' : 'limit';
  // Tail lines (callees, then callers) are dropped first if a small budget is exceeded; "+k more" counts them.
  const text = fitBody(
    (m) => (tok) => `${what} · ${plural(ptr.rows.length, 'hit')} · ${plural(bodies, 'body', 'bodies')} · ~${tok} tok${moreSuffix(m, m > more ? 'maxTokens' : why)}`,
    body.split('\n'),
    more,
    maxTokens,
  );
  return result(text, maxTokens, { mode: 'pack', hits: ptr.rows.length, bodies, more, top: (packed[0] ?? focus[0] ?? top.row).id });
}
