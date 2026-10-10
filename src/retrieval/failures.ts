// Source context for a failing kopt_run: where the failure points in the index. Each stack frame / test location
// in the compressed output is mapped to its enclosing symbol. A failing test is followed below the product function
// it calls, to the function that actually produced the failing value: through thin wrappers, to the function that
// sets the asserted field (`stored` in a `- "stored": true` diff), or to the function the test is named after. A
// failure message that is a string literal of one product function points at that function. The agent can then read
// the suspect directly instead of searching for it.

import { estimateTokens, tokensToChars } from '../core/tokens.js';
import type { FileRow, SymbolRow } from '../store/schema.js';
import type { Store } from '../store/store.js';
import { h, isTestPath, normalizeRel, shortQ } from './common.js';
import { loadSource, sliceLines, type Source } from './source.js';

const INNERMOST_SQL = `SELECT * FROM symbols WHERE file_id = ? AND start_line <= ? AND end_line >= ?
  ORDER BY (end_line - start_line) ASC, id LIMIT 1`;
const BY_SUFFIX_SQL = "SELECT * FROM files WHERE path LIKE ? ESCAPE '\\' ORDER BY length(path) LIMIT 3";
/**
 * Resolved calls made at the top level of a file (an `it(...)` block has no symbol of its own, and the index keeps
 * one ref per name for the whole file level): matched to a test block by name in the block's text.
 */
const FILE_LEVEL_CALLS_SQL = `SELECT r.line AS line, t.id AS id, t.name AS name, t.qname AS qname, t.start_line AS start_line, tf.path AS path
  FROM refs r JOIN symbols t ON t.id = r.to_symbol_id JOIN files tf ON tf.id = t.file_id
  WHERE r.file_id = ? AND r.from_symbol_id IS NULL AND r.kind IN ('call', 'new') ORDER BY r.line, r.id LIMIT 2000`;
const CALLS_FROM_SQL = `SELECT r.line AS line, t.id AS id, t.name AS name, t.qname AS qname, t.start_line AS start_line, tf.path AS path
  FROM refs r JOIN symbols t ON t.id = r.to_symbol_id JOIN files tf ON tf.id = t.file_id
  WHERE r.from_symbol_id = ? AND r.kind IN ('call', 'new') ORDER BY r.line, r.id LIMIT 200`;
const LITERAL_SQL = `SELECT s.id AS id FROM symbols_fts JOIN symbols s ON s.id = symbols_fts.rowid
  WHERE symbols_fts MATCH ? LIMIT 40`;

const MAX_FRAMES = 12;
const MAX_CALLEES = 4;
/** Product functions explored below a failing test's direct callees (breadth first). */
const MAX_DEEP_NODES = 80;
const MAX_DEEP_DEPTH = 3;
/** A function this short with one product callee only forwards the call (`return expandOutput(p, ctx)`). */
const WRAPPER_MAX_LINES = 4;
/** Benchmarks, examples and the like never hold the code a failing test exercises (on top of isTestPath). */
const NON_SUSPECT_RE = /(^|\/)(bench|benchmarks?|examples?|samples?|demos?|fixtures?|testdata)\//;
const CALLABLE = new Set(['function', 'method', 'constructor']);
/** Test-block openers: `it(`, `test(`, `it.each(...)(`, `specify(`. */
const TEST_BLOCK_RE = /^\s*(?:it|test|specify)(?:\.\w+)*\s*\(\s*(?:['"`]|\w+\s*,)/;

interface Frame {
  file: FileRow;
  line: number;
  /** Index of the output line the location was read from. */
  at: number;
}

interface Callee {
  id: number;
  name: string;
  qname: string;
  start_line: number;
  path: string;
}

type Loc = { path: string; line: number; jvmSuffix?: string };

/** Locations with the output line they come from (see frameLocations). */
function locationsAt(text: string): Array<Loc & { at: number }> {
  const out: Array<Loc & { at: number }> = [];
  const seen = new Set<string>();
  const lines = text.split('\n');
  for (let at = 0; at < lines.length; at++) {
    const raw = lines[at];
    const add = (path: string, line: number, jvmSuffix?: string) => {
      const k = `${jvmSuffix ?? path}:${line}`;
      if (seen.has(k) || !(line > 0)) return;
      seen.add(k);
      out.push({ path, line, jvmSuffix, at });
    };
    let m: RegExpExecArray | null;
    const py = /File "([^"]+)", line (\d+)/.exec(raw);
    if (py) add(py[1], Number(py[2]));
    const jvm = /\bat ([\w$.]+)\.[\w$<>-]+\(([\w$]+\.(?:java|kt|kts|scala|groovy)):(\d+)\)/.exec(raw);
    if (jvm) {
      const pkg = jvm[1].replace(/\$.*$/, '').split('.').slice(0, -1).join('/');
      add(jvm[2], Number(jvm[3]), `${pkg ? pkg + '/' : ''}${jvm[2]}`);
    }
    const cs = /\bin (.+?\.(?:cs|fs|vb)):line (\d+)/.exec(raw);
    if (cs) add(cs[1], Number(cs[2]));
    const re = /(?:^|[\s('"`[❯>]|at )((?:[A-Za-z]:)?[\w@.+~\\/-]*[\w-]\.[A-Za-z]{1,6}):(\d+)(?::\d+)?/g;
    while ((m = re.exec(raw))) add(m[1], Number(m[2]));
    if (out.length >= MAX_FRAMES * 2) break;
  }
  return out;
}

/** `path:line` locations in a test / build output, in order: paths, Python tracebacks, JVM and .NET frames. */
export function frameLocations(text: string): Loc[] {
  return locationsAt(text).map(({ path, line, jvmSuffix }) => ({ path, line, jvmSuffix }));
}

function fileFor(store: Store, loc: { path: string; jvmSuffix?: string }): FileRow | undefined {
  if (loc.jvmSuffix) {
    const rows = store.prepare(BY_SUFFIX_SQL).all('%/' + loc.jvmSuffix.replace(/[\\%_]/g, (c) => '\\' + c)) as unknown as FileRow[];
    return rows.length === 1 ? rows[0] : undefined;
  }
  const rel = normalizeRel(loc.path, store.root);
  if (!rel || rel.startsWith('../') || /^[A-Za-z]:|^\//.test(rel)) {
    // an absolute path outside the root spelling (container paths, other checkouts): match by suffix when unique
    const parts = rel.split('/').filter(Boolean);
    if (parts.length < 2) return undefined;
    const rows = store.prepare(BY_SUFFIX_SQL).all('%/' + parts.slice(-3).join('/').replace(/[\\%_]/g, (c) => '\\' + c)) as unknown as FileRow[];
    return rows.length === 1 ? rows[0] : undefined;
  }
  return store.fileByPath(rel);
}

function innermost(store: Store, file: FileRow, line: number): SymbolRow | undefined {
  return store.prepare(INNERMOST_SQL).get(file.id, line, line) as SymbolRow | undefined;
}

/** Line range of the `it(...)` / `test(...)` block around `line` (brace counting from its opening line). */
function testBlock(src: Source, line: number): [number, number] | undefined {
  let start = -1;
  for (let i = Math.min(line, src.lines.length); i >= Math.max(1, line - 400); i--) {
    if (TEST_BLOCK_RE.test(src.lines[i - 1] ?? '')) {
      start = i;
      break;
    }
  }
  if (start < 0) return undefined;
  let depth = 0;
  let opened = false;
  for (let i = start; i <= Math.min(src.lines.length, start + 600); i++) {
    const l = (src.lines[i - 1] ?? '').replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');
    for (const c of l) {
      if (c === '{' || c === '(') {
        depth++;
        opened = true;
      } else if (c === '}' || c === ')') depth--;
    }
    if (opened && depth <= 0) return i >= line ? [start, i] : undefined;
  }
  return undefined;
}

const isProduct = (path: string) => !isTestPath(path) && !NON_SUSPECT_RE.test(path);

/**
 * Product-code callees in call order. A call to a test helper (makeConfig, a fixture builder) stands for the
 * product code that helper calls, one level deep: the bug is often in what the helper sets up.
 */
function calleeList(store: Store, rows: Array<Callee & { line: number }>): Callee[] {
  const out: Callee[] = [];
  const seen = new Set<number>();
  const push = (r: Callee) => {
    if (seen.has(r.id)) return;
    seen.add(r.id);
    out.push(r);
  };
  for (const r of rows) {
    if (isProduct(r.path)) push(r);
    else if (!seen.has(r.id) && isTestPath(r.path)) {
      seen.add(r.id);
      const sub = store.prepare(CALLS_FROM_SQL).all(r.id) as unknown as Array<Callee & { line: number }>;
      for (const x of sub) if (isProduct(x.path)) push(x);
    }
  }
  return out;
}

/** Calls on the failing line first, then the ones just before it (what set up the failing state), then after. */
const proximity = (line: number, fail: number) => (line <= fail ? fail - line : 1000 + line - fail);
function byProximity<T extends { line: number }>(rows: T[], fail: number): T[] {
  return [...rows].sort((a, b) => proximity(a.line, fail) - proximity(b.line, fail));
}

const symLabel = (id: number, qname: string, name: string) => `${h(id)} ${shortQ(qname, name)}`;
const calleeLabel = (c: Callee) => `${symLabel(c.id, c.qname, c.name)} ${c.path}:${c.start_line}`;

function productCallees(store: Store, id: number): Callee[] {
  const rows = store.prepare(CALLS_FROM_SQL).all(id) as unknown as Callee[];
  const seen = new Set<number>();
  return rows.filter((r) => r.id !== id && isProduct(r.path) && !seen.has(r.id) && (seen.add(r.id), true));
}

function sourceOf(store: Store, sym: SymbolRow): string | undefined {
  const f = store.fileById(sym.file_id);
  const src = f && loadSource(store, f.path, f);
  return src ? sliceLines(src, sym.start_line, sym.end_line) : undefined;
}

/** `return expandOutput(p, ctx)`: a short function whose only product callee is the one it forwards to. */
function forwardsTo(store: Store, c: Callee): Callee | undefined {
  const sym = store.symbolById(c.id);
  if (!sym || !CALLABLE.has(sym.kind) || sym.end_line - sym.start_line + 1 > WRAPPER_MAX_LINES) return undefined;
  const next = productCallees(store, c.id);
  return next.length === 1 ? next[0] : undefined;
}

/** Follows thin wrappers (at most 3) to the function doing the work. */
function unwrap(store: Store, c: Callee): { target: Callee; via: Callee[] } {
  const via: Callee[] = [];
  let cur = c;
  for (let i = 0; i < 3; i++) {
    const next = forwardsTo(store, cur);
    if (!next || next.id === c.id || via.some((v) => v.id === next.id)) break;
    via.push(cur);
    cur = next;
  }
  return { target: cur, via };
}

/** The failure message of the test whose location is on output line `at`: the lines up to its `FAIL` title. */
function failureBlock(lines: string[], at: number): string[] {
  const out: string[] = [];
  for (let i = at - 1; i >= 0 && out.length < 40; i--) {
    const l = lines[i];
    if (/^(?:FAIL|FAILED|ERROR|ERRORED|--- FAIL:)\s/.test(l) || /^\S.*:$/.test(l)) break;
    out.unshift(l);
  }
  return out;
}

/** The argument of `expect(...)` on a source line (balanced parentheses), or undefined. */
function expectArgument(line: string): string | undefined {
  const i = line.search(/\bexpect\s*\(/);
  if (i < 0) return undefined;
  const open = line.indexOf('(', i);
  let depth = 0;
  for (let j = open; j < line.length; j++) {
    const c = line[j];
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return line.slice(open + 1, j);
  }
  return undefined;
}

interface Asserted {
  names: string[];
  /** Named on both sides of a diff: the field whose value differs (a strong signal). */
  diff: boolean;
}

/**
 * Field names the failing assertion is about: a key on both sides of a diff (`- "stored": true` / `+ "stored":
 * false`), else the property the assertion reads (`expect(r.meta.stored)`, `assert refund.amount == ...`).
 */
export function assertedFields(block: string[], sourceLine = ''): Asserted {
  const minus = new Set<string>();
  const plus = new Set<string>();
  for (const l of block) {
    const m = /^\s*([-+])\s+["']?([A-Za-z_$][\w$]*)["']?\s*[:=]\s/.exec(l);
    if (m) (m[1] === '-' ? minus : plus).add(m[2]);
  }
  const both = [...minus].filter((k) => plus.has(k));
  if (both.length) return { names: both.slice(0, 3), diff: true };
  const arg = expectArgument(sourceLine);
  const read = (arg && /\.([A-Za-z_$][\w$]*)\s*\)*\s*$/.exec(arg)) || /\bassert\s+[\w.()[\]'"]*\.(\w+)\s*(?:==|!=|<=|>=|<|>|is\b|in\b)/.exec(sourceLine);
  return { names: read && read[1].length > 2 ? [read[1]] : [], diff: false };
}

/** Does `text` (a function's source) give `field` a value: `field: x`, `.field = x`, `field = x`, `{ field, ... }`? */
function setsField(text: string, field: string): boolean {
  const f = field.replace(/[$]/g, '\\$&');
  return new RegExp(`(?:^|[\\s{,(.])["']?${f}["']?\\s*(?::(?!:)|=(?![=>]))|(?:^|[{,])\\s*${f}\\s*(?=[,}])`, 'm').test(text);
}

const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Names a test title gives to code: identifier-like words (`PreToolUse`, `parse_args`, `toolCalls`) and 2-3
 * consecutive words joined (`read file` -> readfile). A plain single word (`result`, `read`) names nothing.
 */
function titleNames(title: string): Set<string> {
  const out = new Set<string>();
  for (const w of title.split(/[\s>›:()'"`,.;[\]{}]+/)) {
    if (/[a-z][A-Z]|[A-Za-z]_[A-Za-z]|[A-Za-z][0-9]/.test(w) && normName(w).length >= 5) out.add(normName(w));
  }
  const words = title.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w.toLowerCase());
  for (let i = 0; i < words.length; i++) {
    let acc = words[i];
    for (let j = i + 1; j < Math.min(words.length, i + 3); j++) {
      acc += words[j];
      if (acc.length >= 6) out.add(acc);
    }
  }
  return out;
}

interface Suspect {
  sym: Callee;
  /** Direct callee of the test it was reached from (when different). */
  from?: Callee;
  why: string;
}

/**
 * Below the test's direct product callees: the function the test is named after, else the one function that sets
 * the asserted field. Undefined when neither singles one out.
 */
function deepSuspect(store: Store, direct: Callee[], title: string, asserted: Asserted): Suspect | undefined {
  const names = titleNames(title);
  const nodes: Array<{ c: Callee; root: Callee; depth: number }> = [];
  const seen = new Set<number>();
  const queue = direct.slice(0, MAX_CALLEES * 2).map((c) => ({ c, root: c, depth: 0 }));
  for (const q of queue) seen.add(q.c.id);
  while (queue.length && nodes.length < MAX_DEEP_NODES) {
    const n = queue.shift()!;
    nodes.push(n);
    if (n.depth >= MAX_DEEP_DEPTH) continue;
    for (const c of productCallees(store, n.c.id)) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      queue.push({ c, root: n.root, depth: n.depth + 1 });
    }
  }
  const bySetter = (): Suspect | undefined => {
    for (const field of asserted.names) {
      const setters = nodes.filter((n) => {
        const sym = store.symbolById(n.c.id);
        const text = sym && CALLABLE.has(sym.kind) ? sourceOf(store, sym) : undefined;
        return !!text && setsField(text.split('\n').slice(1).join('\n'), field);
      });
      // one setter (for a field both sides of a diff name, also one below the direct callees): the value comes from it
      const deeper = setters.filter((n) => n.depth > 0);
      const pick = setters.length === 1 ? setters[0] : asserted.diff && deeper.length === 1 && setters.length <= 2 ? deeper[0] : undefined;
      if (pick) return { sym: pick.c, from: pick.depth ? pick.root : undefined, why: `sets ${field}` };
    }
    return undefined;
  };
  const byName = (): Suspect | undefined => {
    const named = nodes.find((n) => n.depth > 0 && names.has(normName(n.c.name)));
    return named && { sym: named.c, from: named.root, why: 'named in the test' };
  };
  // a field that differs between expected and received beats a name in the title, which beats a field merely read
  return asserted.diff ? bySetter() ?? byName() : byName() ?? bySetter();
}

/** Literal pieces of a failure message (quoted actual values, error messages) long enough to be distinctive. */
export function messagePieces(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (!/Received|received|Error|error:|expected|Expected|but was|Actual|actual|!=|panic:|raise|Exception/.test(line)) continue;
    const quoted = [...line.matchAll(/(["'`])((?:\\.|(?!\1).){12,200})\1/g)].map((m) => m[2]);
    const tail = /(?:Error|Exception|panic):\s+(.{12,200})$/.exec(line)?.[1];
    for (const q of [...quoted, ...(tail ? [tail] : [])]) {
      // template parts (`${path}: not readable...`) are not in the source as a whole: try the pieces between values
      for (const piece of q.split(/[:()"'`{}[\]]|\s-\s|\s{2,}/)) {
        const p = piece.trim();
        if (p.length >= 12 && /[a-z]{3,}\s+[a-z]{2,}/i.test(p) && !out.includes(p)) out.push(p);
      }
    }
    if (out.length >= 6) break;
  }
  return out;
}

/** String literals of a source text (quotes of any kind, one line each; template parts included). */
function stringLiterals(text: string): string[] {
  return [...text.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g)].map((m) => m[2]);
}

/**
 * The product function whose source has `piece` inside a string literal (an error message it builds), verified on
 * the file's text: code that merely reads like the message (`return total`) does not count. Several candidates:
 * none (the message is not specific to one function).
 */
function literalHome(store: Store, piece: string): SymbolRow | undefined {
  const words = [...new Set((piece.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) ?? []))].slice(0, 6);
  if (words.length < 2) return undefined;
  let ids: number[];
  try {
    ids = (store.prepare(LITERAL_SQL).all(words.map((w) => `body_terms : "${w}"`).join(' AND ')) as unknown as Array<{ id: number }>).map((r) => r.id);
  } catch {
    return undefined;
  }
  const out: SymbolRow[] = [];
  for (const id of ids) {
    const s = store.symbolById(id);
    if (!s || !CALLABLE.has(s.kind)) continue;
    const f = store.fileById(s.file_id);
    if (!f || !isProduct(f.path)) continue;
    const text = sourceOf(store, s);
    if (text && stringLiterals(text).some((l) => l.includes(piece))) out.push(s);
  }
  // innermost first: a method, not its class or an enclosing function
  out.sort((a, b) => a.end_line - a.start_line - (b.end_line - b.start_line));
  const inner = out.filter((s) => !out.some((o) => o !== s && o.start_line >= s.start_line && o.end_line <= s.end_line && o.file_id === s.file_id));
  return inner.length === 1 ? inner[0] : undefined;
}

/**
 * Lines that map a failing run's output onto the index, within `maxTokens`:
 *   at src/a.ts:42 in #ab Foo.bar (def L30)
 *   test test/a.test.ts:120 calls #k2 parse src/parse.ts:12 > #k5 build src/build.ts:40 (sets stored), #k3 load ...
 *   "a link that leaves the project" is written in #3k denyReason src/retrieval/access.ts:41
 * Undefined when nothing in the output maps to indexed code.
 */
export function failureContext(store: Store, output: string, maxTokens: number): string | undefined {
  const outLines = output.split('\n');
  const lines: string[] = [];
  const frames: Frame[] = [];
  for (const loc of locationsAt(output)) {
    const file = fileFor(store, loc);
    if (file && !frames.some((f) => f.file.id === file.id && f.line === loc.line)) frames.push({ file, line: loc.line, at: loc.at });
    if (frames.length >= MAX_FRAMES) break;
  }
  const shown = new Set<number>();
  // Product code first: the frames the failure went through, the deepest first (Python prints it last).
  const product = frames.filter((f) => !isTestPath(f.file.path));
  const python = product.length > 1 && product.every((f) => /\.py$/.test(f.file.path));
  for (const f of python ? [...product].reverse() : product) {
    const s = innermost(store, f.file, f.line);
    if (!s || shown.has(s.id)) continue;
    shown.add(s.id);
    lines.push(`at ${f.file.path}:${f.line} in ${symLabel(s.id, s.qname, s.name)} (def L${s.start_line})`);
  }
  // Failing tests: the source functions each one calls, followed to the one that produced the failing value.
  const testsSeen = new Set<string>();
  for (const f of frames) {
    if (!isTestPath(f.file.path)) continue;
    const s = innermost(store, f.file, f.line);
    const src = loadSource(store, f.file.path, f.file);
    let callees: Callee[] = [];
    let where = `${f.file.path}:${f.line}`;
    if (s && CALLABLE.has(s.kind) && s.end_line - s.start_line < 400) {
      if (testsSeen.has(`s${s.id}`)) continue;
      testsSeen.add(`s${s.id}`);
      callees = calleeList(store, byProximity(store.prepare(CALLS_FROM_SQL).all(s.id) as unknown as Array<Callee & { line: number }>, f.line));
      where += ` in ${symLabel(s.id, s.qname, s.name)}`;
    } else {
      const block = src && testBlock(src, f.line);
      if (!block || testsSeen.has(`${f.file.id}:${block[0]}`)) continue;
      testsSeen.add(`${f.file.id}:${block[0]}`);
      const body = sliceLines(src, block[0], block[1]);
      const calls = store.prepare(FILE_LEVEL_CALLS_SQL).all(f.file.id) as unknown as Array<Callee & { line: number }>;
      // line of the call nearest the failing line (a name may be called several times in the block)
      const at = (c: Callee): number => {
        const re = new RegExp(`(?:^|[^\\w$.])(?:new\\s+)?${c.name.replace(/[$]/g, '\\$&')}\\s*[(<]`, 'g');
        let best = -1;
        for (const m of body.matchAll(re)) {
          const line = block[0] + (body.slice(0, m.index).match(/\n/g)?.length ?? 0);
          if (best < 0 || proximity(line, f.line) < proximity(best, f.line)) best = line;
        }
        return best;
      };
      callees = calleeList(store, byProximity(calls.map((c) => ({ ...c, line: at(c) })).filter((c) => c.line >= 0), f.line));
      where += ` (test L${block[0]}-${block[1]})`;
    }
    // thin wrappers stand for the function they forward to
    const direct = callees.map((c) => unwrap(store, c));
    const title = /^(?:FAIL|FAILED|ERROR|ERRORED|--- FAIL:)\s+(.*)$/.exec(outLines.slice(0, f.at).reverse().find((l) => /^(?:FAIL|FAILED|ERROR|ERRORED|--- FAIL:)\s/.test(l)) ?? '')?.[1] ?? '';
    const asserted = assertedFields(failureBlock(outLines, f.at), src?.lines[f.line - 1] ?? '');
    const deep = deepSuspect(store, direct.map((d) => d.target), title, asserted);
    const parts: string[] = [];
    const label = (d: { target: Callee; via: Callee[] }) => `${d.via.length ? `${symLabel(d.via[0].id, d.via[0].qname, d.via[0].name)} > ` : ''}${calleeLabel(d.target)}`;
    if (deep && !shown.has(deep.sym.id)) {
      shown.add(deep.sym.id);
      const from = deep.from ? direct.find((d) => d.target.id === deep.from!.id) : undefined;
      if (from) shown.add(from.target.id);
      parts.push(`${from ? `${label(from)} > ` : ''}${calleeLabel(deep.sym)} (${deep.why})`);
    }
    const fresh = direct.filter((d) => !shown.has(d.target.id));
    for (const d of fresh) shown.add(d.target.id);
    const room = MAX_CALLEES - parts.length;
    parts.push(...fresh.slice(0, room).map(label));
    if (!parts.length) continue;
    lines.push(`test ${where} calls ${parts.join(', ')}${fresh.length > room ? `, +${fresh.length - room}` : ''}`);
    if (testsSeen.size >= 4) break;
  }
  // Failure messages that are a string literal of one product function.
  for (const piece of messagePieces(output)) {
    const home = literalHome(store, piece);
    if (!home || shown.has(home.id)) continue;
    shown.add(home.id);
    lines.push(`"${piece.length > 60 ? piece.slice(0, 59) + '…' : piece}" is written in ${symLabel(home.id, home.qname, home.name)} ${store.fileById(home.file_id)?.path}:${home.start_line}`);
    if (lines.length >= 10) break;
  }
  if (!lines.length) return undefined;
  const head = 'source (kopt index):';
  const budget = tokensToChars(maxTokens);
  const kept: string[] = [];
  let used = head.length + 1;
  for (const l of lines) {
    if (used + l.length + 3 > budget) break;
    kept.push(`  ${l}`);
    used += l.length + 3;
  }
  if (!kept.length) return undefined;
  const text = [head, ...kept].join('\n');
  return estimateTokens(text) <= maxTokens ? text : undefined;
}
