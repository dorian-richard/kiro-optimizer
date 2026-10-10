// Shared building blocks for output filters: failure blocks with dedup, compiler diagnostics grouped by
// file, stack-frame trimming, near-duplicate collapsing and budget-aware layout.

import { estimateTokens, tokensToChars, truncateLines } from '../../core/tokens.js';
import type { CommandInfo } from '../command.js';

export interface FilterInput {
  command: CommandInfo;
  /** Normalized output lines (ANSI stripped, repo root made relative). */
  lines: string[];
  exitCode: number;
  maxTokens: number;
}

export interface Filter {
  name: string;
  /**
   * Confidence that this filter understands the output: ~90 command match, 50-70 output signature,
   * ~40 package-manager wrapper (so a test framework's signature wins over `npm test`). 0 = no.
   */
  match(cmd: CommandInfo, sample: string): number;
  /** Compressed text within `maxTokens`, or undefined to fall back to the generic filter. */
  compress(input: FilterInput): string | undefined;
}

/** One failure / error with its evidence. Blocks with the same `key` are merged ("same error in N more"). */
export interface Block {
  title: string;
  lines: string[];
  key?: string;
}

export interface Diag {
  file: string;
  line?: number;
  col?: number;
  severity: 'error' | 'warning';
  code?: string;
  message: string;
  /** Continuation lines worth keeping (e.g. javac `symbol:` / `location:`). */
  extra?: string[];
}

export const MAX_LINE_CHARS = 600;

export function capLine(line: string, max = MAX_LINE_CHARS): string {
  return line.length <= max ? line : `${line.slice(0, max)}… [+${line.length - max} chars]`;
}

export function fit(text: string, maxTokens: number): string {
  return estimateTokens(text) <= maxTokens ? text : truncateLines(text, maxTokens).text;
}

/** Join items into one line no longer than `maxChars`, ending with `+k` when cut. */
export function joinWithin(items: string[], maxChars: number, sep = ', '): string {
  let out = '';
  let i = 0;
  for (; i < items.length; i++) {
    const add = (i ? sep : '') + items[i];
    if (out.length + add.length > maxChars && i > 0) break;
    out += add;
  }
  return i < items.length ? `${out}${sep}+${items.length - i}` : out;
}

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Blocks

/** Drop the prefix `name` shares with `ref` (up to a separator) so lists of similar test names stay short. */
export function shortenAgainst(name: string, ref: string): string {
  let i = 0;
  while (i < name.length && i < ref.length && name[i] === ref[i]) i++;
  if (i < 8) return name;
  const cut = Math.max(name.lastIndexOf('::', i), name.lastIndexOf(' › ', i), name.lastIndexOf(' > ', i), name.lastIndexOf('/', i), name.lastIndexOf('.', i));
  if (cut <= 0) return name;
  const sepLen = name.startsWith('::', cut) ? 2 : name.startsWith(' › ', cut) || name.startsWith(' > ', cut) ? 3 : 1;
  return name.slice(cut + sepLen) || name;
}

function renderGroup(first: Block, others: string[]): string {
  const lines = [first.title, ...first.lines.map((l) => capLine(l))];
  // `FAIL a › x` / `FAIL b › y`: the status word is implied by "same error"
  const status = /^(?:FAIL|FAILED|ERROR) /.exec(first.title)?.[0];
  const names = others.map((o) => shortenAgainst(o, first.title)).map((n) => (status && n.startsWith(status) ? n.slice(status.length) : n));
  if (others.length) lines.push(`  same error in ${others.length} more: ${joinWithin(names, 300)}`);
  return lines.join('\n');
}

/** A failing test's block title: `FAIL a.test.ts > suite > name`, `FAILED tests/x.py::test_y`, `--- FAIL: TestX`... */
const TEST_TITLE_RE = /^(?:FAIL|FAILED|ERROR|ERRORED|--- FAIL:)\s+/;

/**
 * The file (or class) a failing test belongs to and its name within it: `FAIL test/a.test.ts > suite > name` ->
 * [test/a.test.ts, suite > name]; `FAILED tests/x.py::test_y` -> [tests/x.py, test_y]; `FAILED com.acme.FooTest.bar`
 * -> [com.acme.FooTest, bar]. Titles without such a structure (`--- FAIL: TestX`) have no file.
 */
export function splitTestTitle(title: string): { file: string; name: string } {
  const t = title.replace(TEST_TITLE_RE, '').replace(/\s+/g, ' ').trim();
  let best = -1;
  let sepLen = 0;
  for (const sep of [' > ', ' › ', '::']) {
    const i = t.indexOf(sep);
    if (i > 0 && (best < 0 || i < best)) {
      best = i;
      sepLen = sep.length;
    }
  }
  if (best > 0) return { file: t.slice(0, best), name: t.slice(best + sepLen) };
  const fq = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\.([\w$]+(?:\(.*\))?)$/.exec(t);
  if (fq) return { file: fq[1], name: fq[2] };
  return { file: '', name: t };
}

/** Share of the budget the list of failing tests may take when not every failure fits in detail. */
const OVERVIEW_SHARE = 0.5;
/** Characters kept per test name in that list, longest first: shortened until the list fits its share. */
const OVERVIEW_NAME_CHARS = [120, 80, 50, 36];

/**
 * Every failing test under its file, one line per distinct failure: `  test/a.test.ts:` then `    suite > name`
 * lines (a file with one failure keeps it on its own line). Tests that failed with the same error share a line
 * (`a · b · c (same error)`). Names are shortened, then the list is cut (`+k more`), only when it would not fit
 * `maxTokens`. `groups`: titles of the tests that failed with the same error, one array per error.
 */
export function failureOverview(groups: string[][], maxTokens: number, noun = 'failures'): string {
  const byFile = new Map<string, { names: string[] }[]>();
  let total = 0;
  for (const g of groups) {
    if (!g.length) continue;
    total += g.length;
    const first = splitTestTitle(g[0]);
    const names = g.map((t, k) => {
      const x = splitTestTitle(t);
      return k && x.file !== first.file ? `${x.file ? `${x.file} > ` : ''}${x.name}` : x.name;
    });
    const arr = byFile.get(first.file) ?? [];
    arr.push({ names });
    byFile.set(first.file, arr);
  }
  const head = `${total} ${noun}${byFile.size > 1 ? ` in ${byFile.size} files` : ''}:`;
  type Line = { line: string; tests: number };
  /** Lines per file; `tests`: how many tests a line names (a file line alone names none). */
  const render = (cap: number): Line[][] =>
    [...byFile].map(([file, entries]) => {
      let prev = '';
      const items = entries.map((e) => {
        const short = e.names.map((n) => {
          const out = capName(prev ? shortenAgainst(n, prev) : n, cap);
          prev = n;
          return out;
        });
        return { text: short.length > 1 ? `${short.join(' · ')} (same error)` : short[0], tests: e.names.length };
      });
      if (!file) return items.map((i) => ({ line: `  ${i.text}`, tests: i.tests }));
      if (items.length === 1) return [{ line: `  ${file}: ${items[0].text}`, tests: items[0].tests }];
      return [{ line: `  ${file}:`, tests: 0 }, ...items.map((i) => ({ line: `    ${i.text}`, tests: i.tests }))];
    });
  const join = (lines: Line[][]) => [head, ...lines.flat().map((l) => l.line)].join('\n');
  let lines = render(OVERVIEW_NAME_CHARS[0]);
  for (const cap of OVERVIEW_NAME_CHARS.slice(1)) {
    if (estimateTokens(join(lines)) <= maxTokens) break;
    lines = render(cap);
  }
  if (estimateTokens(join(lines)) <= maxTokens) return join(lines);
  // Still too long: whole lines from the start, then how many tests were left out.
  const maxChars = tokensToChars(maxTokens) - 14;
  const out = [head];
  let used = head.length;
  let shown = 0;
  let lastWasFile = false;
  for (const { line, tests } of lines.flat()) {
    const text = capLine(line, 300);
    if (used + text.length + 1 > maxChars) {
      if (lastWasFile) out.pop(); // a file line without any of its tests says nothing
      out.push(`  +${total - shown} more`);
      return out.join('\n');
    }
    out.push(text);
    used += text.length + 1;
    lastWasFile = tests === 0;
    shown += tests;
  }
  return out.join('\n');
}

function capName(name: string, max: number): string {
  return name.length <= max ? name : `${name.slice(0, max - 1)}…`;
}

/**
 * Render blocks (merged by key) within `budget` tokens. When they all fit, every block is shown in full. Otherwise
 * a list of every failing test comes first (grouped by file, so a shared cause shows), then as many failures in
 * detail as the rest of the budget holds, in file order; a block longer than half of that room is cut. Blocks that
 * are not failing tests (compiler diagnostics) left out are named on a last `+N more` line.
 */
export function renderBlocks(blocks: Block[], budget: number, noun = 'failures'): string[] {
  const groups: { first: Block; others: string[] }[] = [];
  const byKey = new Map<string, number>();
  for (const b of blocks) {
    if (b.key !== undefined) {
      const idx = byKey.get(b.key);
      if (idx !== undefined) {
        groups[idx].others.push(b.title);
        continue;
      }
      byKey.set(b.key, groups.length);
    }
    groups.push({ first: b, others: [] });
  }
  if (!groups.length) return [];
  // failing tests in file order (stable: the tools already print them file by file, mostly)
  const isTest = (g: { first: Block }) => TEST_TITLE_RE.test(g.first.title);
  const fileRank = new Map<string, number>();
  for (const g of groups) if (isTest(g)) {
    const f = splitTestTitle(g.first.title).file;
    if (!fileRank.has(f)) fileRank.set(f, fileRank.size);
  }
  const order = groups.map((g, i) => ({ g, i, rank: isTest(g) ? fileRank.get(splitTestTitle(g.first.title).file)! : -1 }));
  const tests = order.filter((o) => o.rank >= 0).sort((a, b) => a.rank - b.rank || a.i - b.i);
  let k = 0;
  const sorted = order.map((o) => (o.rank >= 0 ? tests[k++].g : o.g));
  const full = sorted.map((g) => renderGroup(g.first, g.others));
  const sizes = full.map((t) => estimateTokens(t) + 1);
  if (sizes.reduce((a, b) => a + b, 0) <= budget) return full;

  const out: string[] = [];
  const testGroups = sorted.filter(isTest).map((g) => [g.first.title, ...g.others]);
  const testCount = testGroups.reduce((n, g) => n + g.length, 0);
  let left = budget;
  if (testCount > 1) {
    const overview = failureOverview(testGroups, Math.max(30, Math.floor(budget * OVERVIEW_SHARE)), noun);
    out.push(overview);
    left -= estimateTokens(overview) + 1;
  }
  const reserve = sorted.some((g) => !isTest(g)) ? Math.min(70, Math.floor(budget * 0.15)) : 0;
  const avail = Math.max(20, left - reserve);
  const perBlock = Math.max(60, Math.floor(avail * (sorted.length > 1 ? 0.5 : 1)));
  const skipped: { first: Block; others: string[] }[] = [];
  let used = 0;
  let details = 0;
  for (let i = 0; i < sorted.length; i++) {
    let text = full[i];
    let t = sizes[i];
    if (t > perBlock) {
      text = truncateLines(text, perBlock, (n) => `  … ${n} more lines`).text;
      t = estimateTokens(text) + 1;
    }
    if (used + t > avail) {
      if (details) {
        // a smaller failure further down may still fit: keep going
        skipped.push(sorted[i]);
        continue;
      }
      text = truncateLines(text, avail, (n) => `  … ${n} more lines`).text;
      t = estimateTokens(text) + 1;
    }
    out.push(text);
    used += t;
    details++;
  }
  // failing tests left out are already named in the overview; other blocks (diagnostics) are named here
  const rest = testCount > 1 ? skipped.filter((g) => !isTest(g)) : skipped;
  if (rest.length) {
    const names = rest.flatMap((g) => [g.first.title, ...g.others]).map((n) => n.replace(/\s+/g, ' ').trim());
    const shortNames = names.map((n, j) => (j === 0 ? n : shortenAgainst(n, names[0])));
    const room = tokensToChars(Math.max(20, left - used)) - 30;
    out.push(`+${shortNames.length} more ${noun}: ${joinWithin(shortNames, Math.max(40, Math.min(room, 600)))}`);
  }
  return out;
}

/** Verdict/head lines first, then blocks, then tail lines, all within `maxTokens`. */
export function layout(head: string[], blocks: Block[], maxTokens: number, noun = 'failures', tail: string[] = []): string {
  const headText = head.filter((l) => l !== undefined && l !== null).join('\n').trim();
  const tailText = tail.join('\n').trim();
  const fixed = estimateTokens(headText) + estimateTokens(tailText) + 2;
  const body = renderBlocks(blocks, Math.max(40, maxTokens - fixed), noun);
  return fit([headText, ...body, tailText].filter(Boolean).join('\n'), maxTokens);
}

// ---------------------------------------------------------------------------------------------------------------
// Compiler diagnostics

function pos(d: Diag): string {
  return d.line === undefined ? '' : d.col === undefined ? String(d.line) : `${d.line}:${d.col}`;
}

/**
 * Group diagnostics by file (first-seen order), merge identical messages within a file (positions listed),
 * hoist messages repeated across >= 3 locations in >= 2 files into one block, cap entries per file.
 */
export function diagBlocks(diags: Diag[], perFile = 8): Block[] {
  const sig = (d: Diag) => `${d.severity}|${d.code ?? ''}|${d.message}`;
  const stats = new Map<string, { n: number; files: Set<string> }>();
  for (const d of diags) {
    const s = stats.get(sig(d)) ?? { n: 0, files: new Set<string>() };
    s.n++;
    s.files.add(d.file);
    stats.set(sig(d), s);
  }
  const common = new Set([...stats].filter(([, s]) => s.n >= 3 && s.files.size >= 2).map(([k]) => k));
  // Locations of a hoisted message, grouped by file: `a.ts:3:1, 9:4; b.ts:7:2` (the path is not repeated).
  const locsBySig = new Map<string, Map<string, string[]>>();
  for (const d of diags) {
    const k = sig(d);
    if (!common.has(k)) continue;
    const byFile = locsBySig.get(k) ?? new Map<string, string[]>();
    const arr = byFile.get(d.file) ?? [];
    if (pos(d)) arr.push(pos(d));
    byFile.set(d.file, arr);
    locsBySig.set(k, byFile);
  }
  const blocks: Block[] = [];
  const commonDone = new Set<string>();
  for (const d of diags) {
    const k = sig(d);
    if (!common.has(k) || commonDone.has(k)) continue;
    commonDone.add(k);
    const locs = [...locsBySig.get(k)!].map(([file, positions]) => (positions.length ? `${file}:${positions.join(', ')}` : file));
    const s = stats.get(k)!;
    blocks.push({
      title: `${d.severity === 'warning' ? 'warning ' : ''}${d.code ? `${d.code} ` : ''}${d.message} (x${s.n} in ${s.files.size} files)`,
      lines: [`  at ${joinWithin(locs, 260, '; ')}`, ...(d.extra ?? []).slice(0, 3).map((e) => `  ${e.trim()}`)],
    });
  }
  const byFile = new Map<string, Diag[]>();
  for (const d of diags) {
    if (common.has(sig(d))) continue;
    const arr = byFile.get(d.file) ?? [];
    arr.push(d);
    byFile.set(d.file, arr);
  }
  for (const [file, ds] of byFile) {
    const merged = new Map<string, { d: Diag; positions: string[] }>();
    for (const d of ds) {
      const k = `${sig(d)}|${(d.extra ?? []).join('\n')}`;
      const m = merged.get(k);
      if (m) m.positions.push(pos(d));
      else merged.set(k, { d, positions: [pos(d)] });
    }
    // A file with a single diagnostic: one line, `path:line:col: message` (no per-file header)
    if (ds.length === 1) {
      const d = ds[0];
      const where = pos(d) ? `${file}:${pos(d)}` : file;
      const sev = d.severity === 'warning' ? 'warning ' : '';
      blocks.push({ title: `${where}: ${sev}${d.code ? `${d.code} ` : ''}${d.message}`.trimEnd(), lines: (d.extra ?? []).slice(0, 4).map((e) => `  ${e.trim()}`) });
      continue;
    }
    const errors = ds.filter((d) => d.severity === 'error').length;
    const warnings = ds.length - errors;
    const counts = [errors ? plural(errors, 'error') : '', warnings ? plural(warnings, 'warning') : ''].filter(Boolean).join(', ');
    const lines: string[] = [];
    let shown = 0;
    for (const { d, positions } of merged.values()) {
      if (shown >= perFile) break;
      const where = joinWithin(positions.filter(Boolean), 60);
      const sev = d.severity === 'warning' && errors ? '[warn] ' : '';
      lines.push(`  ${where ? `${where}: ` : ''}${sev}${d.code ? `${d.code} ` : ''}${d.message}`.trimEnd());
      for (const e of (d.extra ?? []).slice(0, 4)) lines.push(`    ${e.trim()}`);
      shown++;
    }
    if (merged.size > shown) lines.push(`  … +${merged.size - shown} more in this file`);
    blocks.push({ title: `${file}: ${counts}`, lines });
  }
  return blocks;
}

// ---------------------------------------------------------------------------------------------------------------
// Stack frames

const PY_FRAME_RE = /^\s*File "([^"]+)", line \d+/;
const AT_FRAME_RE = /^\s*at\s+\S/;
const JAVA_MORE_RE = /^\s*\.\.\. \d+ (?:more|common frames omitted)\s*$/;
const LIB_FRAME_RE = new RegExp(
  [
    String.raw`node_modules[\\/]`,
    String.raw`node:internal`,
    String.raw`\(internal[\\/]`,
    String.raw`\(node:`,
    String.raw`\(<anonymous>\)|^\s*at <anonymous>\s*$`,
    String.raw`site-packages[\\/]`,
    String.raw`dist-packages[\\/]`,
    String.raw`[\\/]lib[\\/]python\d`,
    String.raw`<frozen `,
    String.raw`^\s*File "<`,
    String.raw`[\\/]usr[\\/](?:local[\\/])?lib[\\/]`,
    String.raw`[\\/]go[\\/]src[\\/](?:runtime|testing|reflect|sync)[\\/]`,
    String.raw`[\\/]pkg[\\/]mod[\\/]`,
    String.raw`\.cargo[\\/]registry`,
    String.raw`[\\/]rustc[\\/][0-9a-f]{8,}`,
    String.raw`^\s*at\s+(?:app\/\/)?(?:java|javax|jdk|sun|com\.sun|org\.junit|junit|org\.opentest4j|org\.apache|org\.gradle|worker\.org\.gradle|org\.springframework|org\.mockito|org\.assertj|org\.hamcrest|kotlin|kotlinx|scala|org\.testng|net\.bytebuddy|com\.fasterxml|io\.netty|reactor|org\.hibernate|groovy|org\.codehaus|com\.intellij|org\.jetbrains|io\.mockk|io\.kotest|org\.spockframework|org\.scalatest|munit|org\.specs2|zio|cats\.effect|akka|org\.apache\.pekko|sbt)[.\/$]`,
    String.raw`java\.base[@\/]`,
    String.raw`^\s*at\s+(?:System|Microsoft|Xunit|NUnit|Castle|Moq|FluentAssertions)\.`,
    String.raw`^\s*at\s+(?:process\.processTicksAndRejections|new Promise|Promise\.|Generator\.next|async Promise\.all)`,
  ].join('|'),
);

export function isFrameLine(line: string): boolean {
  return AT_FRAME_RE.test(line) || PY_FRAME_RE.test(line) || JAVA_MORE_RE.test(line);
}

export function isLibraryFrame(line: string): boolean {
  return JAVA_MORE_RE.test(line) || LIB_FRAME_RE.test(line);
}

/**
 * Keep at most `maxRepo` in-repo frames per contiguous stack (the innermost ones: first frames for JS/Java/.NET,
 * last frames for Python tracebacks), dropping library/framework frames; a single `… N frames` line marks the cut.
 */
export function trimStack(lines: string[], maxRepo = 3, marker = true): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!isFrameLine(lines[i])) {
      out.push(lines[i++]);
      continue;
    }
    // Collect one contiguous stack; a Python frame owns its following, more indented, source line(s).
    const frames: { text: string[]; lib: boolean; py: boolean }[] = [];
    let indent = '';
    while (i < lines.length && isFrameLine(lines[i])) {
      const head = lines[i];
      if (!indent) indent = /^\s*/.exec(head)![0];
      const py = PY_FRAME_RE.test(head);
      const text = [head];
      i++;
      if (py) {
        const ind = /^\s*/.exec(head)![0].length;
        while (i < lines.length && lines[i].trim() && !isFrameLine(lines[i]) && /^\s*/.exec(lines[i])![0].length > ind && !/^\S/.test(lines[i])) {
          // Python 3.11+ underlines the failing expression with ^^^/~~~: pure noise for the model.
          if (!/^\s*[\^~]+\s*$/.test(lines[i])) text.push(lines[i]);
          i++;
        }
      }
      frames.push({ text, lib: isLibraryFrame(head), py });
    }
    const repo = frames.filter((f) => !f.lib);
    const python = frames.some((f) => f.py);
    const keep = new Set(python ? repo.slice(-maxRepo) : repo.slice(0, maxRepo));
    // Never return an empty stack: if everything is library code keep the innermost frame.
    if (!keep.size && frames.length) keep.add(python ? frames[frames.length - 1] : frames[0]);
    let dropped = 0;
    for (const f of frames) {
      if (keep.has(f)) out.push(...f.text);
      else dropped++;
    }
    if (dropped && marker) out.push(`${indent}… ${plural(dropped, 'frame')} omitted`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Near-duplicate collapsing

const ERRORISH_RE = /\b(?:error|errors|fail|failed|failure|exception|traceback|panic|fatal|warning)\b|✖|✗|×/i;

function shapeOf(line: string): string {
  return line
    .replace(/0x[0-9a-f]+|[0-9a-f]{7,40}\b/gi, '#')
    .replace(/\d+/g, '#')
    .replace(/(?:[A-Za-z]:)?(?:[\w.@~+-]*[\\/])+[\w.@+-]*/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Collapse runs (>= minRun) of lines that differ only in numbers/paths/hashes: keep first and last,
 * replace the middle with one marker. Lines that look like errors are never collapsed.
 */
export function collapseSimilar(lines: string[], minRun = 4): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || ERRORISH_RE.test(line)) {
      out.push(line);
      i++;
      continue;
    }
    const shape = shapeOf(line);
    let j = i + 1;
    while (j < lines.length && lines[j].trim() && !ERRORISH_RE.test(lines[j]) && shapeOf(lines[j]) === shape) j++;
    const run = j - i;
    if (run >= minRun && shape.length > 1) {
      const indent = /^\s*/.exec(line)![0];
      out.push(line, `${indent}… ${run - 2} similar lines`, lines[j - 1]);
    } else {
      for (let k = i; k < j; k++) out.push(lines[k]);
    }
    i = j;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Error-context extraction (generic filter and fallbacks)

export const ERROR_LINE_RE =
  /\b(?:errors?|err!|fail|failed|failures?|failing|exception|traceback|panic(?:ked)?|fatal|segmentation fault|core dumped|assertion|command not found|permission denied|no such file or directory|cannot find|could not|unable to|undefined reference)\b|✖|✗|^E\s{2,}/i;
const ZERO_COUNT_RE = /\b(?:0|no) (?:errors?|failures?|failed|failing)\b|\b(?:errors?|failures?|failed):? 0\b/i;

export function isErrorLine(line: string): boolean {
  return ERROR_LINE_RE.test(line) && !ZERO_COUNT_RE.test(line);
}

/**
 * Lines matching error words with +/-`context` lines, merged into ranges, joined with `--`, within budget.
 * The last `tailLines` non-empty lines (usually the verdict) are always kept. Returns undefined if nothing matched.
 */
export function errorContext(lines: string[], maxTokens: number, context = 2, tailLines = 3): string | undefined {
  const n = lines.length;
  const hits: number[] = [];
  for (let i = 0; i < n; i++) if (isErrorLine(lines[i])) hits.push(i);
  if (!hits.length) return undefined;
  const ranges: [number, number][] = [];
  for (const h of hits) {
    const s = Math.max(0, h - context);
    let e = Math.min(n - 1, h + context);
    if (/^\s*Traceback \(most recent call last\):/.test(lines[h])) {
      // Whole traceback (indented frames) up to the exception line, so in-repo frames are not cut off.
      let j = h + 1;
      while (j < n && (/^\s/.test(lines[j]) || !lines[j].trim())) j++;
      e = Math.max(e, Math.min(n - 1, j + 1));
    }
    while (e + 1 < n && isFrameLine(lines[e + 1])) e++;
    const last = ranges[ranges.length - 1];
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else ranges.push([s, e]);
  }
  // A short remainder after the last error (code frame, verdict) belongs to it; otherwise keep a tail of
  // final non-frame lines (the verdict).
  const remainder = lines.slice(ranges[ranges.length - 1][1] + 1).filter((l) => l.trim() && !isFrameLine(l)).length;
  if (remainder > 0 && remainder <= 10) ranges[ranges.length - 1][1] = n - 1;
  const lastEnd = ranges[ranges.length - 1][1];
  const tailIdx: number[] = [];
  for (let k = n - 1; k > lastEnd && tailIdx.length < tailLines; k--) {
    if (lines[k].trim() && !isFrameLine(lines[k])) tailIdx.unshift(k);
  }
  const tail = tailIdx.map((k) => lines[k]);
  const sections = ranges.map(([s, e]) => trimStack(lines.slice(s, e + 1)).map((l) => capLine(l)).join('\n'));
  const tailText = tail.map((l) => capLine(l)).join('\n');
  const budget = maxTokens - estimateTokens(tailText) - 4;
  const kept: string[] = [];
  let used = 0;
  let k = 0;
  for (; k < sections.length; k++) {
    const t = estimateTokens(sections[k]) + 1;
    if (used + t > budget) {
      if (!kept.length) {
        kept.push(truncateLines(sections[k], Math.max(30, budget)).text);
        k++;
      }
      break;
    }
    kept.push(sections[k]);
    used += t;
  }
  // Prefer showing the last error snippet too (often the real cause in build logs) if it fits.
  if (k < sections.length - 1) {
    const lastSec = sections[sections.length - 1];
    if (used + estimateTokens(lastSec) + 12 <= budget) {
      kept.push(`… ${sections.length - 1 - k} more error snippets …`, lastSec);
      k = sections.length;
    }
  }
  let body = kept.join('\n--\n');
  if (k < sections.length) body += `\n… +${sections.length - k} more error snippets`;
  return fit(tailText ? `${body}\n--\n${tailText}` : body, maxTokens);
}

/** `line (x37)` (see normalize.collapseRepeats) -> 37, else 1. */
export function repeatCount(line: string): number {
  const m = / \(x(\d+)\)$/.exec(line);
  return m ? Number(m[1]) : 1;
}

/** Lines that appear in `text` as the last match of `re`, or undefined. */
export function lastMatch(lines: string[], re: RegExp): RegExpExecArray | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = re.exec(lines[i]);
    if (m) return m;
  }
  return undefined;
}

/** Remove the common leading indentation of non-empty lines. */
export function dedent(lines: string[]): string[] {
  let min = Infinity;
  for (const l of lines) {
    if (!l.trim()) continue;
    const n = /^[ \t]*/.exec(l)![0].length;
    if (n < min) min = n;
  }
  if (!Number.isFinite(min) || min === 0) return lines;
  return lines.map((l) => l.slice(Math.min(min, /^[ \t]*/.exec(l)![0].length)));
}
