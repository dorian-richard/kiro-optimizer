// sbt with ScalaTest / MUnit / specs2. Success -> `Tests: succeeded 118, failed 0... · Total time: 14 s`.
// Failure -> scalac errors grouped by file (Scala 2 `file:line:col: msg` and Scala 3 `-- [E007] ... file:line:col`),
// ScalaTest `*** FAILED ***` tests with message and repo frames, MUnit `==> X` failures, failed suites and tasks;
// `[info]` loading/compiling/resolving chatter and passing tests dropped.

import { runs } from '../command.js';
import { diagBlocks, joinWithin, layout, trimStack, type Block, type Diag, type Filter, type FilterInput } from './common.js';

const LEVEL_RE = /^\[(info|warn|error|success|debug)\]\s?(.*)$/;
const SCALAC2_RE = /^(\S.*?\.(?:scala|java|sc)):(\d+):(\d+): (.*)$/;
const SCALAC3_RE = /^-- (?:\[E\d+\] )?(.+?): (\S.*?\.(?:scala|sc)):(\d+):(\d+)(?: -*)?$/;
const SCALATEST_FAIL_RE = /^(\s*)- (.+?) \*\*\* FAILED \*\*\*(?: \([\d.]+ m?s(?:ec)?\))?$/;
const MUNIT_FAIL_RE = /^==> X (\S+)\s+[\d.]+s (.*)$/;
const SUITE_RE = /^([A-Z][\w$.]*(?:Spec|Suite|Test|Tests)):$/;
const SUMMARY_RE = /^(?:Tests: succeeded \d+, failed \d+.*|Total number of tests run: \d+|Passed: Total \d+.*|Failed: Total \d+.*|\*\*\* \d+ (?:TESTS?|SUITES?) (?:FAILED|ABORTED) \*\*\*|All tests passed\.|No tests were executed\.)$/;
const TOTAL_TIME_RE = /^Total time: ([^,]+),/;
const TASK_FAIL_RE = /^\(([^)]+)\) (\S.*)$/;

function compressSbt(inp: FilterInput): string | undefined {
  const { maxTokens, exitCode } = inp;
  // Drop the level prefix but remember errors (scalac continuation lines carry no position).
  const lines = inp.lines.map((l) => {
    const m = LEVEL_RE.exec(l);
    return m ? m[2] : l;
  });
  const summary: string[] = [];
  let total: string | undefined;
  let success: boolean | undefined;
  const diags: Diag[] = [];
  const seen = new Set<string>();
  const tests: Block[] = [];
  const failedSuites: string[] = [];
  const failedTasks: string[] = [];
  let warnings = 0;
  let suite = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const raw = inp.lines[i];
    let m: RegExpExecArray | null;
    if ((m = SUITE_RE.exec(line))) suite = m[1];
    else if (SUMMARY_RE.test(line.trim())) {
      if (!summary.includes(line.trim())) summary.push(line.trim());
    } else if ((m = TOTAL_TIME_RE.exec(line))) {
      total = m[1];
      success = /^\[success\]/.test(raw);
    } else if ((m = SCALAC2_RE.exec(line))) {
      const severity = /^\[warn\]/.test(raw) || /^warning: /.test(m[4]) ? 'warning' : 'error';
      if (severity === 'warning') {
        warnings++;
        continue;
      }
      const extra: string[] = [];
      let j = i + 1;
      // `found   : String` / `required: Int` / `symbol:` details, then the source line and the caret
      for (; j < lines.length && j < i + 6 && !SCALAC2_RE.test(lines[j]) && /^\s/.test(lines[j]); j++) {
        const t = lines[j].trim();
        if (/^(?:found|required|symbol|location|where|possible cause)\b/i.test(t)) extra.push(t);
      }
      i = j - 1;
      record({ file: m[1], line: Number(m[2]), col: Number(m[3]), severity: 'error', message: m[4].replace(/^error: /, '').trim(), extra });
    } else if ((m = SCALAC3_RE.exec(line))) {
      // Scala 3: header, code frame (`22 |  code`, `   |  ^^^`), then the message lines (`   |  Found: ...`)
      const msg: string[] = [];
      let j = i + 1;
      for (; j < lines.length && /^\s*\d*\s*\|/.test(lines[j]); j++) {
        const body = lines[j].replace(/^\s*\d*\s*\|/, '').trim();
        if (/^\d+\s*\|/.test(lines[j].trim()) || !body || /^[\^~]+$/.test(body) || /^longer explanation available/i.test(body)) continue;
        msg.push(body);
      }
      i = j - 1;
      const severity = /^\[warn\]/.test(raw) || /warning/i.test(m[1]) ? 'warning' : 'error';
      if (severity === 'warning') {
        warnings++;
        continue;
      }
      record({ file: m[2], line: Number(m[3]), col: Number(m[4]), severity, message: msg[0] ?? m[1], extra: msg.slice(1, 4) });
    } else if ((m = SCALATEST_FAIL_RE.exec(line))) {
      const indent = m[1].length;
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length && lines[j].length - lines[j].trimStart().length > indent && !SCALATEST_FAIL_RE.test(lines[j]); j++) body.push(lines[j]);
      i = j - 1;
      tests.push(digestTest(`FAILED ${suite ? `${suite} › ` : ''}${m[2]}`, body));
    } else if ((m = MUNIT_FAIL_RE.exec(line))) {
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length && /^\s/.test(lines[j]) && !MUNIT_FAIL_RE.test(lines[j]); j++) body.push(lines[j]);
      i = j - 1;
      tests.push(digestTest(`FAILED ${m[1]}`, [m[2], ...body]));
    } else if (/^Failed tests:$/.test(line.trim()) || /^Error during tests:$/.test(line.trim())) {
      for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) failedSuites.push(lines[j].trim());
    } else if ((m = TASK_FAIL_RE.exec(line)) && /^\[error\]/.test(raw)) {
      failedTasks.push(`${m[1]}: ${m[2].replace(/^sbt\.\w+Exception: /, '')}`);
    }
  }

  function record(d: Diag) {
    const k = `${d.file}|${d.line}|${d.col}|${d.message}`;
    if (seen.has(k)) return;
    seen.add(k);
    diags.push(d);
  }

  if (!summary.length && total === undefined && !diags.length && !tests.length && !failedTasks.length) return undefined;
  const head: string[] = [];
  const verdictParts = [...summary.filter((s) => !/^Total number of tests run/.test(s) || summary.length === 1)];
  if (total !== undefined) verdictParts.push(`${success && !verdictParts.length ? 'success · ' : ''}Total time: ${total}`);
  else if (!verdictParts.length) verdictParts.push(`exit ${exitCode}`);
  head.push(verdictParts.join(' · '));
  if (diags.length) head.push(`${diags.length} compile error${diags.length === 1 ? '' : 's'}${warnings ? `, ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}`);
  if (failedSuites.length) head.push(`failed suites: ${joinWithin(failedSuites, 240)}`);
  // `(Test / test) Tests unsuccessful` only repeats the failing tests listed below
  const tasks = tests.length ? failedTasks.filter((t) => !/Tests unsuccessful/.test(t)) : failedTasks;
  if (tasks.length) head.push(`failed: ${joinWithin(tasks, 240, '; ')}`);
  return layout(head, [...diagBlocks(diags), ...tests], maxTokens, 'failures');
}

function digestTest(title: string, body: string[]): Block {
  const cleaned = body.filter((l) => l.trim() && !/^\s*\.\.\.\s*$/.test(l)).map((l) => l.replace(/^(\s*)at\s+/, '$1at '));
  const trimmed = trimStack(cleaned, 3, false);
  const msg = trimmed.filter((l) => !/^\s*at\s/.test(l)).slice(0, 10).map((l) => `  ${l.trim()}`);
  const frames = trimmed.filter((l) => /^\s*at\s/.test(l)).map((l) => `  ${l.trim()}`);
  return { title, lines: [...msg, ...frames], key: `${msg.slice(0, 2).join('\n').replace(/\s*\(\S+\.scala:\d+\)$/, '')}|${frames[0] ?? ''}` };
}

export const sbt: Filter = {
  name: 'sbt',
  match(cmd, sample) {
    if (runs(cmd, ['sbt', 'sbtn'])) return 90;
    if (/^\[info\] (?:Run completed in|Total number of tests run:)|^\[(?:success|error)\] Total time: /m.test(sample)) return 68;
    return 0;
  },
  compress: compressSbt,
};
