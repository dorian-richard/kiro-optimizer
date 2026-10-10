// node:test (`node --test`, or `npm test` running it): the TAP reporter (node's default when the output is not a
// terminal, as under kopt_run) and the spec / dot reporters. Success -> one summary line. Failure -> one block per
// failing test: its file and name (suites included), the error with the assertion diff, the expected / actual values
// when the message does not show them, the file:line of the failure and up to 3 in-repo frames. Passing tests,
// durations, the zero counters and suites that only failed through their subtests are dropped.

import { dedent, isLibraryFrame, layout, plural, type Block, type Filter, type FilterInput } from './common.js';

const MAX_MESSAGE_LINES = 16;
const COUNT_RE = /^(?:#|ℹ) (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) ([\d.]+)\s*$/;
const TAP_RESULT_RE = /^(\s*)(not ok|ok) \d+(?: -)?(?: (.*?))?(\s+#\s*(?:SKIP|TODO)\b.*)?$/i;
const TAP_SUBTEST_RE = /^(\s*)# Subtest: (.*)$/;
/** A suite (or a file) that failed only because of its subtests: their own blocks say why. */
const SUBTESTS_FAILED_RE = /^'?\d+ subtests? failed'?$/;
const VALUE_CHARS = 160;

/** `file:///x/y.js:3:9` / `file://src/y.js` (root made relative) -> `x/y.js:3:9`. */
function cleanPath(s: string): string {
  return s.replace(/file:\/\/(?:\/(?=[A-Za-z]:))?/g, '');
}

/** Frame line in kopt's `at fn (path:line:col)` form; the test runner's own wrapper names are dropped. */
function frame(raw: string): string {
  let t = cleanPath(raw.trim().replace(/^at\s+/, ''));
  t = t.replace(/^(?:async )?(?:TestContext|Test|Suite)\.<anonymous> \((.*)\)$/, '$1');
  return `at ${t}`;
}

/** `'test/a.test.js:12:3'` -> `test/a.test.js` and `12`. */
function location(raw: string | undefined): { file: string; line?: string } | undefined {
  if (!raw) return undefined;
  const m = /^(.*?):(\d+)(?::\d+)?$/.exec(cleanPath(unquote(raw)));
  return m ? { file: m[1], line: m[2] } : { file: cleanPath(unquote(raw)) };
}

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    try {
      return JSON.parse(t) as string;
    } catch {
      return t.slice(1, -1);
    }
  }
  return t;
}

interface YamlValue {
  scalar?: string;
  /** Block scalar (`|-`) or nested mapping / list lines, dedented. */
  lines?: string[];
}

/** The top-level keys of a TAP YAML diagnostic block (between `---` and `...`). */
function parseYaml(lines: string[]): Map<string, YamlValue> {
  const out = new Map<string, YamlValue>();
  const body = dedent(lines);
  for (let i = 0; i < body.length; i++) {
    const m = /^([A-Za-z_][\w]*):(?: (.*))?$/.exec(body[i]);
    if (!m) continue;
    const v = (m[2] ?? '').trim();
    if (v && !/^[|>][-+]?$/.test(v)) {
      out.set(m[1], { scalar: v === '~' ? 'null' : v });
      continue;
    }
    const nested: string[] = [];
    while (i + 1 < body.length && (body[i + 1] === '' || /^\s/.test(body[i + 1]))) nested.push(body[++i]);
    while (nested.length && !nested[nested.length - 1].trim()) nested.pop();
    out.set(m[1], { lines: dedent(nested) });
  }
  return out;
}

/** A YAML value on one line: `'open'`, `5`, `{ id: 8, lines: 1, status: 'shipped' }`, `[1, 2]`. */
function inline(v: YamlValue | undefined): string | undefined {
  if (!v) return undefined;
  if (v.scalar !== undefined) return v.scalar;
  const ls = (v.lines ?? []).filter((l) => l.trim());
  if (!ls.length) return undefined;
  const top = ls.filter((l) => !/^\s/.test(l));
  const text = top.every((l) => l.startsWith('- '))
    ? `[${top.map((l) => l.slice(2).trim()).join(', ')}]`
    : `{ ${ls.map((l) => l.trim()).join(', ')} }`;
  return text.length > VALUE_CHARS ? `${text.slice(0, VALUE_CHARS - 1)}…` : text;
}

/** Message lines without blank lines and without the `[ERR_ASSERTION]` code. */
function messageLines(lines: string[]): string[] {
  const out = lines.map((l) => cleanPath(l.replace(/^(\w*Error) \[ERR_\w+\]:/, '$1:')).trimEnd()).filter((l) => l.trim());
  return out.length > MAX_MESSAGE_LINES ? [...out.slice(0, MAX_MESSAGE_LINES), `… ${out.length - MAX_MESSAGE_LINES} more lines`] : out;
}

/** The message shows a `+ actual - expected` diff of the values. */
const hasDiff = (msg: string[]) => msg.some((l) => /^[+-] /.test(l.trim()) && !/^\+ actual - expected$/.test(l.trim()));

/** `expected: 5 · actual: 4` when the message does not already show the values (or they are short scalars). */
function valuesLine(msg: string[], expected: string | undefined, actual: string | undefined, assertion: boolean): string | undefined {
  if (!assertion || (expected === undefined && actual === undefined)) return undefined;
  const e = expected ?? 'undefined';
  const a = actual ?? 'undefined';
  const scalar = (x: string) => !x.startsWith('{') && !x.startsWith('[');
  if (hasDiff(msg) && !(scalar(e) && scalar(a))) return undefined;
  return `expected: ${e} · actual: ${a}`;
}

function block(title: string, msg: string[], values: string | undefined, frames: string[], at: string | undefined): Block {
  const kept = frames.map(frame).filter((f) => !isLibraryFrame(f) && /:\d+/.test(f)).slice(0, 3);
  // no frame in the repo (a timeout, a file that did not load): the test's own location
  const where = kept.length ? kept : at ? [`at ${at}`] : [];
  return {
    title,
    lines: [...msg.map((l) => `  ${l}`), ...(values ? [`  ${values}`] : []), ...where.map((f) => `  ${f}`)],
    key: `${msg.slice(0, 4).join('\n')}|${where[0] ?? ''}`,
  };
}

/** `FAIL test/a.test.js > suite > name`, like kopt's other test filters (a file-level failure: `FAIL test/a.test.js`). */
function testTitle(file: string | undefined, names: string[]): string {
  const own = names.filter((n) => n && !(file && (n === file || file.endsWith(`/${n}`) || n.endsWith(`/${file}`))));
  return `FAIL ${[file, ...own].filter(Boolean).join(' > ')}`;
}

// ---------------------------------------------------------------------------------------------------------------
// TAP

function tapBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  const stack: string[] = [];
  /** `# ...` lines a test file wrote to stderr before failing to load (a SyntaxError and its code frame). */
  let stderr: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const sub = TAP_SUBTEST_RE.exec(line);
    if (sub) {
      const depth = Math.floor(sub[1].length / 4);
      stack.length = depth;
      stack[depth] = sub[2].trim();
      continue;
    }
    const r = TAP_RESULT_RE.exec(line);
    if (!r) {
      if (/^# /.test(line) && !COUNT_RE.test(line)) stderr.push(line.slice(2));
      continue;
    }
    const depth = Math.floor(r[1].length / 4);
    const yaml: string[] = [];
    if (/^\s*---\s*$/.test(lines[i + 1] ?? '')) {
      let j = i + 2;
      for (; j < lines.length && !/^\s*\.\.\.\s*$/.test(lines[j]); j++) yaml.push(lines[j]);
      i = j;
    }
    if (r[2].toLowerCase() === 'ok' || r[4]) {
      stderr = [];
      continue;
    }
    const y = parseYaml(yaml);
    const error = y.get('error');
    const errorText = error?.scalar !== undefined ? [unquote(error.scalar)] : (error?.lines ?? []);
    if (y.get('failureType')?.scalar === "'subtestsFailed'" || (errorText.length === 1 && SUBTESTS_FAILED_RE.test(errorText[0]))) {
      stderr = [];
      continue;
    }
    const name = (r[3] ?? '').trim();
    const loc = location(y.get('location')?.scalar);
    const errName = y.get('name')?.scalar ? unquote(y.get('name')!.scalar!) : undefined;
    let msg = [...errorText];
    if (errName && msg.length && !msg[0].startsWith(errName)) msg[0] = `${errName}: ${msg[0]}`;
    // a file that did not load: what it printed says why ("test failed" says nothing)
    if (stderr.length && y.has('exitCode')) msg = [...msg.filter((l) => l !== 'test failed'), ...stderr.filter((l) => !/^Node\.js v\d/.test(l))];
    stderr = [];
    const frames = [...(y.get('stack')?.lines ?? []), ...(y.get('at')?.scalar ? [unquote(y.get('at')!.scalar!)] : [])];
    const fromMsg = msg.filter((l) => /^\s*at\s/.test(l));
    msg = messageLines(msg.filter((l) => !/^\s*at\s/.test(l)));
    const ancestors = stack.slice(0, depth).filter((s, k) => !(k === 0 && loc && (s === loc.file || s.endsWith(`/${loc.file}`))));
    const assertion = y.has('operator') || errName === 'AssertionError';
    const values = valuesLine(msg, inline(y.get('expected')), inline(y.get('actual')), assertion);
    blocks.push(block(testTitle(loc?.file, [...ancestors, name]), msg, values, [...frames, ...fromMsg], loc?.line ? `${loc.file}:${loc.line}` : loc?.file));
  }
  return blocks;
}

// ---------------------------------------------------------------------------------------------------------------
// spec / dot

/** Suites of each test name in the spec tree (`▶ suite` / indented `✖ name (1.2ms)`), by name. */
function specSuites(lines: string[], end: number): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const stack: string[] = [];
  for (let i = 0; i < end; i++) {
    const m = /^(\s*)(▶|✖|✔|﹣|⚠)\s+(.*?)(?:\s+\([\d.]+m?s\))?(?:\s+#.*)?$/.exec(lines[i]);
    if (!m) continue;
    const depth = Math.floor(m[1].length / 2);
    stack.length = depth;
    if (m[2] === '▶') stack[depth] = m[3];
    else if (m[2] === '✖' && !out.has(m[3])) out.set(m[3], stack.slice(0, depth).filter(Boolean));
  }
  return out;
}

const SPEC_LINE_RE = /^\s*(?:▶|✖|✔|﹣|⚠|ℹ) /;

function specBlocks(lines: string[]): Block[] {
  const start = lines.findIndex((l) => /^(?:✖ failing tests:|Failed tests:)\s*$/.test(l.trim()));
  const blocks: Block[] = [];
  if (start < 0) return blocks;
  const suites = specSuites(lines, start);
  // What a test file that did not load printed (above the results): shown in place of its "test failed".
  const first = lines.findIndex((l) => SPEC_LINE_RE.test(l));
  const preamble = lines.slice(0, Math.max(0, first)).filter((l) => l.trim() && !/^> |^Node\.js v\d/.test(l));
  let loc: { file: string; line?: string } | undefined;
  for (let i = start + 1; i < lines.length; i++) {
    const at = /^test at (.+)$/.exec(lines[i].trim());
    if (at) {
      loc = location(at[1]);
      continue;
    }
    const t = /^✖ (.*?)(?: \([\d.]+m?s\))?$/.exec(lines[i]);
    if (!t) continue;
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length && (/^\s/.test(lines[j]) || !lines[j].trim()) && !/^test at /.test(lines[j].trim()); j++) body.push(lines[j]);
    i = j - 1;
    const text = dedent(body);
    const msg: string[] = [];
    const frames: string[] = [];
    let expected: string | undefined;
    let actual: string | undefined;
    let inObject = false;
    for (const l of text) {
      const tl = l.trim();
      if (/^at\s/.test(tl)) {
        frames.push(tl.replace(/\s*\{$/, ''));
        if (/\{$/.test(tl)) inObject = true;
        continue;
      }
      if (inObject) {
        const kv = /^(expected|actual): (.*?),?$/.exec(tl);
        if (kv) kv[1] === 'expected' ? (expected = kv[2]) : (actual = kv[2]);
        if (tl === '}') inObject = false;
        continue;
      }
      msg.push(l);
    }
    let message = messageLines(msg);
    if (message.length === 1) message = [unquote(message[0])];
    if (message.length === 1 && SUBTESTS_FAILED_RE.test(message[0].trim())) {
      loc = undefined;
      continue;
    }
    if (message.length === 1 && message[0] === 'test failed' && preamble.length) {
      frames.push(...preamble.filter((l) => /^\s*at\s/.test(l)).map((l) => l.trim()));
      message = messageLines(preamble.filter((l) => !/^\s*at\s/.test(l)));
    }
    const assertion = /^AssertionError\b/.test(message[0] ?? '');
    const values = valuesLine(message, expected, actual, assertion);
    blocks.push(block(testTitle(loc?.file, [...(suites.get(t[1]) ?? []), t[1]]), message, values, frames, loc?.line ? `${loc.file}:${loc.line}` : loc?.file));
    loc = undefined;
  }
  return blocks;
}

// ---------------------------------------------------------------------------------------------------------------

function verdict(counts: Map<string, string>, failed: number): string {
  const n = (k: string) => Number(counts.get(k) ?? 0);
  if (!counts.size) return failed ? `${failed} failed` : 'no test results';
  const parts = [`${n('fail') ? `${n('fail')} failed, ` : ''}${n('pass')} passed`];
  for (const k of ['cancelled', 'skipped', 'todo']) if (n(k)) parts.push(`${n(k)} ${k}`);
  const of = `${plural(n('tests'), 'test')}${n('suites') ? `, ${plural(n('suites'), 'suite')}` : ''}`;
  const ms = Number(counts.get('duration_ms'));
  const time = Number.isFinite(ms) && counts.has('duration_ms') ? ` in ${ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`}` : '';
  return `${parts.join(', ')} (${of})${time}`;
}

function compressNodeTest(inp: FilterInput): string | undefined {
  const { lines, maxTokens } = inp;
  const counts = new Map<string, string>();
  for (const l of lines) {
    const m = COUNT_RE.exec(l);
    if (m) counts.set(m[1], m[2]);
  }
  const tap = lines.some((l) => /^TAP version \d+/.test(l));
  const blocks = tap ? tapBlocks(lines) : specBlocks(lines);
  if (!counts.size && !blocks.length) return undefined;
  // failed with nothing this filter understands (a crash before the results): the generic filter shows the error
  if (inp.exitCode !== 0 && !blocks.length && !Number(counts.get('fail') ?? 0) && !Number(counts.get('cancelled') ?? 0)) return undefined;
  return layout([verdict(counts, blocks.length)], blocks, maxTokens, 'failures');
}

export const nodeTest: Filter = {
  name: 'node-test',
  match(cmd, sample) {
    if (cmd.segments.some((s) => s.program === 'node' && s.args.some((a) => a === '--test' || a.startsWith('--test-reporter')))) return 90;
    if (/^TAP version \d+$/m.test(sample) && /^# (?:pass|fail) \d+$/m.test(sample)) return 70;
    if (/^ℹ tests \d+$/m.test(sample) && /^ℹ (?:pass|fail) \d+$/m.test(sample)) return 70;
    return 0;
  },
  compress: compressNodeTest,
};
