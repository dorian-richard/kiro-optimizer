// Machine-readable test and lint reports: Jest/Vitest `--json`, Mocha `--reporter json`, pytest-json-report,
// ESLint `-f json`, and `go test -json` event streams. The JSON is parsed and rendered like the text reporters
// (verdict, then each failure with its message and repo frames); a go event stream is turned back into the
// `go test` text and compressed by the go filter. Pretty-printed or minified JSON never reaches the model.

import { estimateTokens } from '../../core/tokens.js';
import type { CommandInfo } from '../command.js';
import { layout, trimStack, type Block, type Diag, type Filter, type FilterInput } from './common.js';
import { layoutEslint } from './eslint.js';
import { go } from './go.js';

const MAX_MESSAGE_LINES = 14;
const JSON_FLAG_RE = /^(?:--json|-json|--reporter[= ]json|--format[= ]json|-f[= ]?json|--json-report|--reporter=json|--outputFile=-)$/;

function hasJsonFlag(cmd: CommandInfo): boolean {
  return cmd.segments.some((s) => s.args.some((a, i) => JSON_FLAG_RE.test(a) || (/^(?:--reporter|--format|-f|-R)$/.test(a) && s.args[i + 1] === 'json')));
}

/** The JSON document in `lines` (banners before / after it are skipped), or undefined. */
function extractJson(lines: string[]): unknown {
  const start = lines.findIndex((l) => /^\s*[{[]/.test(l));
  if (start < 0) return undefined;
  let end = lines.length - 1;
  while (end > start && !/[}\]]\s*$/.test(lines[end])) end--;
  try {
    return JSON.parse(lines.slice(start, end + 1).join('\n'));
  } catch {
    return undefined;
  }
}

function messageLines(text: string): { msg: string[]; frames: string[] } {
  const msg: string[] = [];
  const frames: string[] = [];
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const l = raw.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
    if (!l.trim()) continue;
    if (/^\s*at\s/.test(l)) frames.push(`at ${l.trim().replace(/^at\s+/, '')}`);
    else msg.push(l.trim());
  }
  return { msg, frames };
}

function failureBlock(title: string, text: string): Block {
  const { msg, frames } = messageLines(text);
  const kept = msg.length > MAX_MESSAGE_LINES ? [...msg.slice(0, MAX_MESSAGE_LINES), `… ${msg.length - MAX_MESSAGE_LINES} more lines`] : msg;
  const trimmed = trimStack(frames, 3, false);
  return { title, lines: [...kept.map((l) => `  ${l}`), ...trimmed.map((f) => `  ${f}`)], key: `${msg.slice(0, 3).join('\n')}|${trimmed[0] ?? ''}` };
}

type Obj = Record<string, any>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Jest / Vitest `--json` (Vitest's json reporter uses the same shape). */
function renderJest(doc: Obj, root: (p: string) => string): { head: string; blocks: Block[] } {
  const blocks: Block[] = [];
  for (const file of doc.testResults ?? []) {
    const name = root(String(file.name ?? file.testFilePath ?? ''));
    let any = false;
    for (const a of file.assertionResults ?? file.testResults ?? []) {
      if (a.status !== 'failed') continue;
      any = true;
      const title = [...(a.ancestorTitles ?? []), a.title].filter(Boolean).join(' › ');
      blocks.push(failureBlock(`FAIL ${name} › ${title}`, (a.failureMessages ?? []).join('\n')));
    }
    // suite-level failure (syntax error, failed import): no failed assertion, a message on the file
    if (!any && file.status === 'failed' && (file.message || file.failureMessage)) blocks.push(failureBlock(`FAIL ${name}`, String(file.message || file.failureMessage)));
  }
  const parts = [
    `Test Suites: ${[doc.numFailedTestSuites ? `${doc.numFailedTestSuites} failed` : '', `${doc.numPassedTestSuites ?? 0} passed`, `${doc.numTotalTestSuites ?? 0} total`].filter(Boolean).join(', ')}`,
    `Tests: ${[doc.numFailedTests ? `${doc.numFailedTests} failed` : '', doc.numPendingTests ? `${doc.numPendingTests} skipped` : '', `${doc.numPassedTests ?? 0} passed`, `${doc.numTotalTests ?? 0} total`].filter(Boolean).join(', ')}`,
  ];
  if (doc.snapshot && (doc.snapshot.unmatched || doc.snapshot.filesRemoved)) parts.push(`Snapshots: ${doc.snapshot.unmatched ?? 0} failed`);
  return { head: parts.join(' · '), blocks };
}

/** Mocha `--reporter json`. */
function renderMocha(doc: Obj, root: (p: string) => string): { head: string; blocks: Block[] } {
  const s = doc.stats ?? {};
  const blocks = (doc.failures ?? []).map((f: Obj) => {
    const err = f.err ?? {};
    const text = [err.message, err.actual !== undefined && err.expected !== undefined ? `expected ${JSON.stringify(err.expected)}, got ${JSON.stringify(err.actual)}` : '', err.stack ? String(err.stack).split('\n').filter((l: string) => /^\s*at\s/.test(l)).join('\n') : '']
      .filter(Boolean)
      .join('\n');
    return failureBlock(`FAIL ${f.file ? `${root(String(f.file))} › ` : ''}${f.fullTitle ?? f.title}`, text);
  });
  const head = [`${s.passes ?? 0} passing${s.duration !== undefined ? ` (${s.duration}ms)` : ''}`, s.pending ? `${s.pending} pending` : '', s.failures ? `${s.failures} failing` : ''].filter(Boolean).join(' · ');
  return { head, blocks };
}

/** pytest-json-report (`--json-report --json-report-file=-` or a report printed by the agent). */
function renderPytest(doc: Obj): { head: string; blocks: Block[] } {
  const s = doc.summary ?? {};
  const blocks: Block[] = [];
  for (const t of doc.tests ?? []) {
    if (t.outcome !== 'failed' && t.outcome !== 'error') continue;
    const phase = [t.setup, t.call, t.teardown].find((p: Obj | undefined) => p && (p.outcome === 'failed' || p.outcome === 'error')) ?? {};
    const crash = phase.crash ? `${phase.crash.path ?? ''}:${phase.crash.lineno ?? ''}: ${phase.crash.message ?? ''}` : '';
    const repr = typeof phase.longrepr === 'string' ? phase.longrepr.split('\n').filter((l: string) => /^E\s/.test(l)).join('\n') : '';
    blocks.push(failureBlock(`${t.outcome === 'error' ? 'ERROR' : 'FAILED'} ${t.nodeid}`, [repr || crash].filter(Boolean).join('\n')));
  }
  const order = ['failed', 'passed', 'skipped', 'xfailed', 'xpassed', 'error', 'errors'];
  const counts = order.filter((k) => s[k]).map((k) => `${s[k]} ${k}`);
  const dur = typeof doc.duration === 'number' ? ` in ${doc.duration.toFixed(2)}s` : '';
  return { head: `${counts.join(', ') || `${s.total ?? 0} tests`}${dur}`, blocks };
}

/** ESLint `-f json`: the same layout as its text formatters (errors by file, warnings counted by rule). */
function renderEslint(doc: Obj[], root: (p: string) => string, maxTokens: number): string {
  const diags: Diag[] = [];
  let fixable = 0;
  for (const f of doc) {
    fixable += (f.fixableErrorCount ?? 0) + (f.fixableWarningCount ?? 0);
    for (const m of f.messages ?? []) {
      const message = String(m.message ?? '').split('\n')[0];
      diags.push({ file: root(String(f.filePath)), line: m.line, col: m.column, severity: m.severity === 2 ? 'error' : 'warning', message: m.ruleId ? `${message} (${m.ruleId})` : message });
    }
  }
  if (!diags.length) return 'eslint: no problems';
  return layoutEslint(diags, maxTokens, undefined, fixable ? `${fixable} potentially fixable with the \`--fix\` option` : undefined);
}

/** `go test -json`: NDJSON events -> the text go test would have printed. */
function goEventsToText(lines: string[]): string[] | undefined {
  const out: string[] = [];
  let events = 0;
  for (const l of lines) {
    if (!/^\s*\{"(?:Time|Action)"/.test(l)) {
      // build errors are printed as plain text between events
      if (l.trim()) out.push(l);
      continue;
    }
    let e: Obj;
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    events++;
    if (typeof e.Output === 'string') for (const line of e.Output.replace(/\n$/, '').split('\n')) out.push(line);
  }
  return events ? out : undefined;
}

function compressJson(inp: FilterInput): string | undefined {
  const { lines, maxTokens } = inp;
  const goText = lines.some((l) => /^\s*\{"(?:Time|Action)":/.test(l)) ? goEventsToText(lines) : undefined;
  if (goText) return go.compress({ ...inp, lines: goText });
  const doc = extractJson(lines);
  if (doc === undefined) return undefined;
  const cwdRel = (p: string) => p.replace(/\\/g, '/');
  if (Array.isArray(doc) && doc.length && doc.every((f) => isObj(f) && 'filePath' in f && Array.isArray(f.messages))) return renderEslint(doc as Obj[], cwdRel, maxTokens);
  let r: { head: string; blocks: Block[] } | undefined;
  if (isObj(doc) && ('numTotalTests' in doc || 'testResults' in doc)) r = renderJest(doc, cwdRel);
  else if (isObj(doc) && isObj(doc.stats) && Array.isArray(doc.failures)) r = renderMocha(doc, cwdRel);
  else if (isObj(doc) && isObj(doc.summary) && Array.isArray(doc.tests)) r = renderPytest(doc);
  if (!r) return undefined;
  const text = layout([r.head], r.blocks, maxTokens, 'failures');
  return estimateTokens(text) ? text : undefined;
}

export const json: Filter = {
  name: 'json',
  match(cmd, sample) {
    // The report must be the output itself (after npm's `> script` banner), not JSON quoted inside text output.
    const first = sample.split('\n').find((l) => l.trim() && !/^> |^\s*npm (?:WARN|warn|notice) /.test(l)) ?? '';
    const looks = /^\s*[{[]/.test(first) && /"(?:numTotalTests|numFailedTests|testResults|stats|failures|filePath|messages|summary|nodeid|Action|Package)"/.test(sample);
    if (!looks) return 0;
    // above the runners' own command match (90): `jest --json` output is JSON, not jest text
    if (hasJsonFlag(cmd)) return 95;
    return 80;
  },
  compress: compressJson,
};
