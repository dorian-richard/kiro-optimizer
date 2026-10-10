// kopt_refs: usages (in), callees (out) and 2-level impact of a symbol; importers/imports of a file.

import type { RefsParams } from '../core/api.js';
import type { ToolContext } from '../core/context.js';
import { estimateTokens, tokensToChars } from '../core/tokens.js';
import type { ToolResult } from '../core/types.js';
import type { FileRow, SymbolRow } from '../store/schema.js';
import type { Store } from '../store/store.js';
import { budgetOf, fitBody, guard, h, isFieldKind, isTestPath, moreSuffix, plural, quote, result, shortQ, withNote } from './common.js';
import { ambiguousText, suggest } from './read.js';
import { resolveTarget } from './resolve.js';
import { isContainer } from './skeleton.js';
import {
  USAGES_SQL as IN_SQL,
  type Site,
  type UsageRow,
  calleeLines,
  countFiles,
  definedAt,
  methodFamily,
  siteList,
  thinWrappers,
  unresolvedCount,
  unresolvedRows,
  usageLines,
  usageRows,
  usageTargets,
} from './usage.js';
/** Above this many functions naming the symbol, the text check is skipped (a common name says nothing). */
const MAX_MENTIONS = 300;
const FILE_USERS_SQL = `SELECT f.path AS path, count(*) AS n FROM symbols s
  JOIN refs r ON r.to_symbol_id = s.id JOIN files f ON f.id = r.file_id
  WHERE s.file_id = ? AND r.file_id <> ? GROUP BY r.file_id ORDER BY n DESC, f.path LIMIT 300`;
const FILE_IMPORTERS_SQL = `SELECT DISTINCT f.path AS path FROM file_imports i JOIN files f ON f.id = i.file_id
  WHERE i.target_file_id = ? ORDER BY f.path LIMIT 300`;
const FILE_IMPORTS_SQL = `SELECT i.spec AS spec, f.path AS path FROM file_imports i LEFT JOIN files f ON f.id = i.target_file_id
  WHERE i.file_id = ? ORDER BY i.rowid LIMIT 300`;

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
        // Overloads (same qualified name), or an interface method and its implementations, are one target for usages.
        const fam = new Set(methodFamily(store, t.candidates[0].symbol));
        if (t.total === t.candidates.length && (qn.size === 1 || t.candidates.every((c) => fam.has(c.symbol.id)))) {
          return withNote(symbolRefs(store, t.candidates.map((c) => c.symbol), direction, depth, maxTokens), t.candidates.length > 1 && qn.size > 1 ? `note: ${t.candidates.length} declarations of one method family (interface + implementations) counted together` : undefined, maxTokens);
        }
        return message(ambiguousText(`refs ${quote(t.query)}`, t.candidates, t.total, maxTokens).replace('next: kopt_read', 'next: kopt_refs'), maxTokens);
      }
      case 'symbol':
        return withNote(symbolRefs(store, [t.symbol], direction, depth, maxTokens), t.note, maxTokens);
    }
  });
}

/** At most this many unresolved same-name references are listed under "possible". */
const MAX_POSSIBLE = 20;

/** A titled list of reference sites; `tail(k)` replaces the last `k` sites that did not fit (else "+k more"). */
interface SiteBlock {
  title?: string;
  sites: Site[];
  tail?: (k: number) => string;
}

/**
 * Packs site blocks in `maxChars`: first every block's plain lines (path:line + caller + its lines) in order,
 * then, with what is left, each kept line upgraded to its "code" variant (the line's source) in order.
 */
function packSites(blocks: SiteBlock[], maxChars: number): { lines: string[]; dropped: number; used: number } {
  type Kept = { site?: Site; text: string };
  const out: Kept[] = [];
  let used = 0;
  let dropped = 0;
  for (const b of blocks) {
    if (!b.sites.length) continue;
    const title = b.title ? [{ text: b.title }] : [];
    const titleCost = title.reduce((n, t) => n + t.text.length + 1, 0);
    const items: Kept[] = [];
    let cost = titleCost;
    let i = 0;
    for (; i < b.sites.length; i++) {
      const add = b.sites[i].plain.length + 1;
      const rest = b.sites.length - i - 1;
      const reserve = rest > 0 && b.tail ? b.tail(rest).length + 1 : 0;
      if (used + cost + add + reserve > maxChars) break;
      items.push({ site: b.sites[i], text: b.sites[i].plain });
      cost += add;
    }
    if (!items.length) {
      dropped += b.sites.length;
      continue;
    }
    const k = b.sites.length - i;
    if (k > 0 && b.tail) items.push({ text: b.tail(k) }), (cost += b.tail(k).length + 1);
    else dropped += k;
    out.push(...title, ...items);
    used += cost;
  }
  for (const o of out) {
    const code = o.site?.code();
    if (!code) continue;
    const extra = code.length - o.text.length;
    if (used + extra > maxChars) continue;
    o.text = code;
    used += extra;
  }
  return { lines: out.map((o) => o.text), dropped, used };
}

function symbolRefs(store: Store, syms: SymbolRow[], direction: 'in' | 'out' | 'both', depth: 1 | 2, maxTokens: number): ToolResult {
  const main = syms[0];
  const label = `${h(main.id)} ${shortQ(main.qname, main.name)}`;
  const targets = [...new Set(syms.flatMap((s) => [...usageTargets(store, s), ...methodFamily(store, s)]))];
  const headReserve =
    estimateTokens(`impact ${label} · 99999 usages in 9999 files (depth 2: 99999 direct, 99999 indirect) (9999 reads, 9999 writes) · +9999 via 3 wrappers · incomplete · 999 callees (999 resolved) · ~99999 tok${moreSuffix(999)}`) + 1;
  // The in:/out: labels of direction "both" are body lines too.
  const budget = tokensToChars(Math.max(0, maxTokens - headReserve)) - (direction === 'both' ? 9 : 0);
  const body: string[] = [];
  const head: string[] = [];
  let more = 0;
  let used = 0;
  const meta: Record<string, unknown> = { direction, depth };

  if (direction === 'in' || direction === 'both') {
    const inBudget = direction === 'both' ? Math.floor(budget * 0.6) : budget;
    const rows = store.prepare(IN_SQL).all(JSON.stringify(targets)) as unknown as UsageRow[];
    const nFiles = countFiles(rows);
    const family = new Set(targets);
    let usageHead = `${plural(rows.length, 'usage')} in ${plural(nFiles, 'file')}`;
    if (isFieldKind(main.kind) && rows.length) {
      const reads = rows.filter((r) => r.kind === 'read').length;
      const writes = rows.filter((r) => r.kind === 'write').length;
      if (reads || writes) usageHead += ` (${plural(reads, 'read')}, ${plural(writes, 'write')})`;
    }
    if (depth === 2) {
      const lines = usageLines(rows);
      const direct = [...new Set(rows.map((r) => r.from_id).filter((x): x is number => x !== null && !family.has(x)))];
      const ids = [...new Set(direct.flatMap((id) => { const s = store.symbolById(id); return s ? usageTargets(store, s) : [id]; }))];
      const level2 = ids.length ? (store.prepare(IN_SQL).all(JSON.stringify(ids)) as unknown as UsageRow[]).filter((r) => r.from_id === null || !family.has(r.from_id)) : [];
      let left = inBudget;
      for (const sec of [['direct:', ...lines], ['indirect (callers of callers):', ...impactLines(level2)]]) {
        const pk = packLines(sec, left);
        // A section title alone is noise.
        if (pk.kept.length <= 1 && sec.length > 1) {
          more += sec.length - 1;
          continue;
        }
        body.push(...pk.kept);
        more += pk.dropped;
        left -= pk.used;
        used += pk.used;
      }
      if (!rows.length) body.push('no references found (dynamic dispatch, reflection and external callers are not tracked)');
      const n = rows.length + level2.length;
      const m = new Set([...rows, ...level2].map((r) => r.file_id)).size;
      head.push(`${plural(n, 'usage')} in ${plural(m, 'file')} (depth 2: ${rows.length} direct, ${level2.length} indirect)`);
    } else {
      // Unresolved references of the same name and a related kind: the list is complete only without them.
      const unresolved = unresolvedRows(store, main, family);
      const nUnresolved = unresolved.length >= 500 ? unresolvedCount(store, main, family) : unresolved.length;
      const possible = nUnresolved <= MAX_POSSIBLE ? unresolved : [];
      const check = textCheck(store, main, family, rows, unresolved);
      const status = completeness(main, rows.length, nUnresolved, possible.length > 0, check);

      const left = inBudget - status.length - 1;
      // One line per caller when they all fit, else one line per file (more callers in the same budget).
      let sites = siteList(store, rows);
      if (sites.reduce((n, x) => n + x.plain.length + 1, 0) > left) sites = usageLines(rows).map((plain) => ({ plain, code: () => undefined }));
      // Thin wrappers among the callers: their callers are the target's real users, one level up.
      const blocks: SiteBlock[] = [{ sites }];
      const direct = new Set(rows.map((r) => r.from_id));
      let viaWrappers = 0;
      let nWrappers = 0;
      for (const w of thinWrappers(store, rows, family)) {
        const ws = store.symbolById(w.from_id!);
        if (!ws) continue;
        const { rows: wrows, family: wfam } = usageRows(store, ws);
        const own = new Set(wfam);
        // callers already listed as direct callers are not repeated
        const callers = wrows.filter((r) => r.kind !== 'import' && (r.from_id === null || (!own.has(r.from_id) && !family.has(r.from_id) && !direct.has(r.from_id))));
        if (!callers.length) continue;
        viaWrappers += callers.length;
        nWrappers++;
        const wl = `${h(ws.id)} ${shortQ(ws.qname, ws.name)}`;
        blocks.push({
          title: `via wrapper ${wl} (${w.path}:${w.from_line}-${w.from_end}) · ${plural(callers.length, 'usage')} in ${plural(countFiles(callers), 'file')}:`,
          sites: siteList(store, callers, '  '),
          tail: (k) => `  +${k} more (kopt_refs ${h(ws.id)})`,
        });
      }
      if (possible.length) blocks.push({ title: `possible (unresolved refs named ${main.name}):`, sites: siteList(store, possible, '? ') });

      const pk = packSites(blocks, left);
      body.push(...pk.lines);
      more += pk.dropped;
      used += pk.used;
      body.push(status);
      used += status.length + 1;
      head.push(usageHead);
      if (viaWrappers) head.push(`+${viaWrappers} via ${plural(nWrappers, 'wrapper')}`);
      head.push(status.startsWith('complete') ? 'complete' : 'incomplete');
      meta.possible = nUnresolved;
      meta.wrappers = nWrappers;
    }
    meta.usages = rows.length;
    meta.files = nFiles;
  }

  if (direction === 'out' || direction === 'both') {
    const out = calleeLines(store, syms);
    if (direction === 'both') body.push('out:');
    const outLines = out.lines.length || out.fields ? [...out.lines, ...(out.fields ? [out.fields] : [])] : ['no outgoing references indexed'];
    const pk = packLines(outLines, Math.max(0, budget - used));
    body.push(...pk.kept);
    more += pk.dropped;
    head.push(`${out.total} callees (${out.resolved} resolved)`);
    meta.callees = out.total;
  }
  if (direction === 'both' && body.length && body[0] !== 'out:') body.unshift('in:');

  const kind = depth === 2 && direction !== 'out' ? 'impact' : direction === 'out' ? 'refs out' : 'refs';
  // The completeness line is the last line of the "in" part: never the one dropped to fit.
  const text = fitBody((m) => (tok) => `${kind} ${label} · ${head.join(' · ')} · ~${tok} tok${moreSuffix(m)}`, body, more, maxTokens);
  return result(text, maxTokens, meta);
}

const MENTIONS_SQL = `SELECT s.id AS id, s.name AS name, s.qname AS qname, s.kind AS kind, s.start_line AS start_line, s.end_line AS end_line, f.path AS path
  FROM symbols_fts JOIN symbols s ON s.id = symbols_fts.rowid JOIN files f ON f.id = s.file_id
  WHERE symbols_fts MATCH ? LIMIT ${MAX_MENTIONS + 1}`;
const REFS_NAMED_FROM_SQL = 'SELECT line, to_symbol_id AS to_id FROM refs WHERE from_symbol_id = ? AND name = ? ORDER BY line LIMIT 4';
const BODY_KINDS = new Set(['function', 'method', 'constructor', 'field', 'property', 'constant']);

/** What the text says about a caller list: the functions whose body names the symbol, against the callers listed. */
export interface TextCheck {
  /** Functions (other than the symbol's own family) whose body names it. */
  named: number;
  /** ... of which listed as callers. */
  listed: number;
  /** ... whose references of that name all resolved to another symbol: "#x Other.name" of one such target each. */
  other: string[];
  /** ... with an unresolved reference of that name (counted in the "possible" references). */
  unresolved: number;
  /** ... with no reference of that name at all: "path:line in #h Caller (defined a-b)". */
  unlinked: string[];
}

/**
 * Cross-check of a caller list with the text (FTS body terms, so it costs one indexed query): the functions
 * whose body names the symbol, against the callers listed. Agents re-verify refs with grep otherwise. Undefined
 * for names too common to check, or for types (their mentions are not calls).
 */
export function textCheck(store: Store, sym: SymbolRow, family: Set<number>, rows: UsageRow[], unresolved: UsageRow[]): TextCheck | undefined {
  if (isContainer(sym.kind)) return undefined;
  const term = /^[A-Za-z_$][\w$]*$/.test(sym.name) ? sym.name.replace(/^[_$]+|[_$]+$/g, '').toLowerCase() : '';
  if (term.length < 3) return undefined;
  let mentions: Array<{ id: number; name: string; qname: string; kind: string; start_line: number; end_line: number; path: string }>;
  try {
    mentions = store.prepare(MENTIONS_SQL).all(`body_terms : "${term}"`) as unknown as typeof mentions;
  } catch {
    return undefined;
  }
  if (mentions.length > MAX_MENTIONS) return undefined;
  const callers = new Set(rows.map((r) => r.from_id).filter((x): x is number => x !== null));
  const inUnresolved = new Set(unresolved.map((r) => r.from_id).filter((x): x is number => x !== null));
  const users = mentions.filter((m) => BODY_KINDS.has(m.kind) && !family.has(m.id) && m.name !== sym.name);
  const c: TextCheck = { named: users.length, listed: 0, other: [], unresolved: 0, unlinked: [] };
  for (const m of users) {
    if (callers.has(m.id)) {
      c.listed++;
      continue;
    }
    const named = store.prepare(REFS_NAMED_FROM_SQL).all(m.id, sym.name) as unknown as Array<{ line: number; to_id: number | null }>;
    // a reference that resolved to another symbol of that name (another class's method) is not a caller
    if (named.length && named.every((r) => r.to_id !== null && !family.has(r.to_id))) {
      const t = store.symbolById(named[0].to_id!);
      c.other.push(t ? `${h(m.id)} ${shortQ(m.qname, m.name)} → ${h(t.id)} ${shortQ(t.qname, t.name)}` : `${h(m.id)} ${shortQ(m.qname, m.name)}`);
      continue;
    }
    if (inUnresolved.has(m.id)) {
      c.unresolved++;
      continue;
    }
    const line = named.find((r) => r.to_id === null)?.line ?? m.start_line;
    c.unlinked.push(`${m.path}:${line} in ${h(m.id)} ${shortQ(m.qname, m.name)} (defined ${m.start_line}-${m.end_line})`);
  }
  return c;
}

/**
 * The last line of a caller list, saying whether it is complete: "complete: ..." when every reference to the
 * name in the index resolved and every function whose code names it is listed (or calls another symbol of that
 * name), else "incomplete: ..." with what may be missing (unresolved references, functions naming it unlinked).
 */
export function completeness(sym: SymbolRow, resolved: number, nUnresolved: number, possibleListed: boolean, check: TextCheck | undefined): string {
  const name = sym.name;
  const what = isFieldKind(sym.kind) ? 'reads or writes of it' : isContainer(sym.kind) ? 'uses of it' : 'calls to it';
  // functions that name it but whose references resolved to another symbol of that name
  const others = (c: TextCheck, lead: string) => {
    if (!c.other.length) return '';
    const shown = c.other.slice(0, 3).join(', ');
    return `${lead}${c.other.length === 1 ? 'one calls' : `${c.other.length} call`} a different ${name}: ${shown}${c.other.length > 3 ? ', …' : ''}`;
  };
  if (!nUnresolved && !check?.unlinked.length) {
    if (!resolved && (!check || !check.named)) {
      return `complete: no reference to ${name} in the index${check ? ` and no other function's code names it` : ''} (dynamic dispatch, reflection and callers outside the repository are not tracked)`;
    }
    let t = `complete: every reference to ${name} in the index is resolved`;
    if (check?.named) {
      if (!check.other.length) t += check.named === 1 ? '; the one function whose code names it is listed' : `; ${check.named === 2 ? 'both' : `all ${check.named}`} functions whose code names it are listed`;
      else t += `; ${check.listed} of the ${plural(check.named, 'function')} whose code names it ${check.listed === 1 ? 'is' : 'are'} listed${others(check, ', the other ')}`;
    } else if (!check && !isContainer(sym.kind)) t += ' (name too common for a text check)';
    return t;
  }
  const parts: string[] = [];
  if (nUnresolved) {
    const where = possibleListed ? ' (listed under possible)' : nUnresolved > MAX_POSSIBLE ? ' (too many to list)' : '';
    parts.push(`${nUnresolved >= 10000 ? '10,000+' : nUnresolved} unresolved ${nUnresolved === 1 ? 'reference' : 'references'} named ${name} (receiver type unknown) may be ${what}${where}`);
  }
  if (check?.unlinked.length) {
    const shown = check.unlinked.slice(0, check.unlinked.length > 4 ? 2 : 4);
    parts.push(`${plural(check.unlinked.length, 'function names', 'functions name')} ${name} with no reference linked: ${shown.join(', ')}${check.unlinked.length > shown.length ? `, +${check.unlinked.length - shown.length} more` : ''}`);
  }
  if (check?.other.length) parts.push(others(check, `of the functions whose code names it, `));
  return `incomplete: ${parts.join('; ')}`;
}

/** Per-file aggregation for second-level callers: "path: 3 refs · #a Foo.run (defined 3-20), #b Bar.go (defined 9-12)". */
function impactLines(rows: UsageRow[]): string[] {
  const byFile = new Map<string, { n: number; callers: Map<number, { label: string; n: number }> }>();
  for (const r of rows) {
    const e = byFile.get(r.path) ?? { n: 0, callers: new Map() };
    e.n++;
    if (r.from_id !== null) {
      const d = definedAt(r);
      const c = e.callers.get(r.from_id) ?? { label: `${h(r.from_id)} ${shortQ(r.from_qname ?? '', r.from_name ?? '')}${d ? ` (${d})` : ''}`, n: 0 };
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

function fileRefs(store: Store, file: FileRow, direction: 'in' | 'out' | 'both', maxTokens: number): ToolResult {
  const headReserve = estimateTokens(`refs ${file.path} · 9999 using files · 9999 imports · ~99999 tok${moreSuffix(999)}`) + 1;
  const budget = tokensToChars(Math.max(0, maxTokens - headReserve)) - (direction === 'both' ? 9 : 0);
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
  const text = fitBody((m) => (tok) => `refs ${file.path} · ${head.join(' · ')} · ~${tok} tok${moreSuffix(m)}`, body, more, maxTokens);
  return result(text, maxTokens, { direction, file: true });
}
