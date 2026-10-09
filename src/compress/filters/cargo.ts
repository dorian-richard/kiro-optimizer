// Cargo (build/check/test/clippy/run). Success -> `Finished …` + aggregated `test result` + warning count.
// Failure -> rustc diagnostics (message, --> location, the labelled source line, notes) and failing tests'
// panic messages; Compiling/Downloading lines and passing `test x ... ok` lines dropped.

import { runs } from '../command.js';
import { estimateTokens } from '../../core/tokens.js';
import { fit, joinWithin, layout, plural, type Block, type Filter, type FilterInput } from './common.js';
import { genericCompress } from './generic.js';

const DIAG_HEAD_RE = /^(error|warning)(?:\[(\w+)\])?: (.*)$/;
const ARROW_RE = /^\s*--> (\S+)$/;
const TEST_RESULT_RE = /^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out(?:; finished in ([\d.]+s))?$/;
const STDOUT_HEAD_RE = /^---- (\S+) stdout ----$/;
const FINISHED_RE = /^\s*Finished .* target\(s\) in \S+$/;
const SUMMARY_LINE_RE = /^(?:error: could not compile|warning: `[^`]+` \(.+\) generated|error: test failed|error: \d+ target failed|error: aborting due to)/;

function digestDiag(lines: string[], start: number): { block: Block; end: number; severity: string; message: string } {
  const head = DIAG_HEAD_RE.exec(lines[start])!;
  const body: string[] = [];
  let loc = '';
  let i = start + 1;
  let sourceKept = 0;
  for (; i < lines.length && lines[i].trim() !== ''; i++) {
    const l = lines[i];
    const a = ARROW_RE.exec(l);
    if (a) {
      if (!loc) loc = a[1];
      continue;
    }
    if (/^\s*\d+\s*\|/.test(l) && sourceKept < 2) {
      body.push(`  ${l.trim()}`);
      sourceKept++;
    } else if (/^\s*\|\s*[\^\-~]+\s*\S/.test(l) && sourceKept <= 2) {
      // caret line with a label (`^^^ not found in this scope`): keep the label only
      body.push(`  ${l.trim().replace(/^\|\s*/, '')}`);
    } else if (/^\s*= (?:note|help):/.test(l) || /^help:/.test(l)) {
      if (body.filter((b) => /^\s*(?:= )?(?:note|help):/.test(b)).length < 2) body.push(`  ${l.trim()}`);
    }
  }
  const title = `${head[1]}${head[2] ? `[${head[2]}]` : ''}: ${head[3]}${loc ? ` --> ${loc}` : ''}`;
  return { block: { title, lines: body, key: `${head[1]}|${head[2] ?? ''}|${head[3]}|${loc}` }, end: i, severity: head[1], message: head[3] };
}

function compressCargo(inp: FilterInput): string | undefined {
  const { command, lines, exitCode, maxTokens } = inp;
  const clippy = command.segments.some((s) => s.program === 'cargo' && s.args.includes('clippy'));
  const errors: Block[] = [];
  const warnings: Block[] = [];
  const warnMsgs = new Map<string, number>();
  const tests: Block[] = [];
  const failedNames: string[] = [];
  const summaries: string[] = [];
  const sums = [0, 0, 0];
  let suites = 0;
  let anyFailed = false;
  let time = 0;
  let finished: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    if (DIAG_HEAD_RE.test(line) && !SUMMARY_LINE_RE.test(line)) {
      const d = digestDiag(lines, i);
      if (d.severity === 'error') errors.push(d.block);
      else {
        warnings.push(d.block);
        warnMsgs.set(d.message, (warnMsgs.get(d.message) ?? 0) + 1);
      }
      i = d.end;
    } else if (SUMMARY_LINE_RE.test(line)) {
      if (!summaries.includes(line.trim())) summaries.push(line.trim());
    } else if ((m = TEST_RESULT_RE.exec(line))) {
      suites++;
      if (m[1] === 'FAILED') anyFailed = true;
      sums[0] += Number(m[2]);
      sums[1] += Number(m[3]);
      sums[2] += Number(m[4]);
      if (m[7]) time += parseFloat(m[7]);
    } else if ((m = STDOUT_HEAD_RE.exec(line))) {
      const body: string[] = [];
      for (i = i + 1; i < lines.length && !STDOUT_HEAD_RE.test(lines[i]) && !/^(?:failures|successes):$/.test(lines[i]); i++) {
        const l = lines[i];
        if (!l.trim() || /^note: run with `RUST_BACKTRACE/.test(l)) continue;
        if (/^\s+\d+: /.test(l) || /^\s+at \//.test(l)) {
          // backtrace: keep repo frames only
          if (/\/rustc\/|\.cargo\/registry|library\/(?:std|core|alloc|test)\//.test(l) || /^\s+\d+: (?:std|core|alloc|test|rust_begin_unwind)::/.test(l)) continue;
        }
        if (body.length < 14) body.push(`  ${l.trim()}`);
      }
      i--;
      tests.push({ title: `FAILED ${m[1]}`, lines: body, key: body.filter((b) => !/panicked at/.test(b)).join('\n') + body.find((b) => /panicked at/.test(b))?.replace(/^.*panicked at /, '') });
    } else if ((m = /^test (\S+) \.\.\. FAILED$/.exec(line))) failedNames.push(m[1]);
    else if (FINISHED_RE.test(line)) finished = line.trim();
  }
  if (!errors.length && !tests.length && !suites && !finished && !warnings.length && !summaries.length) return undefined;

  const parts: string[] = [];
  if (suites) {
    parts.push(`test result: ${anyFailed ? 'FAILED' : 'ok'}. ${sums[0]} passed; ${sums[1]} failed; ${sums[2]} ignored${suites > 1 ? ` (${suites} suites)` : ''}${time ? ` in ${time.toFixed(2)}s` : ''}`);
  } else if (finished) parts.push(finished);
  else if (!errors.length) parts.push(exitCode === 0 ? 'ok' : `exit ${exitCode}`);
  if (errors.length) parts.unshift(plural(errors.length, 'error'));
  if (warnings.length && !clippy) {
    const top = [...warnMsgs].sort((a, b) => b[1] - a[1]).map(([w, n]) => (n > 1 ? `${w} x${n}` : w));
    parts.push(`${plural(warnings.length, 'warning')}: ${joinWithin(top, 200, '; ')}`);
  }
  const head = [parts.join(' · ')];
  // `cargo run`: once the build succeeded, the program's own output is what matters.
  const runIdx = lines.findIndex((l) => /^\s*Running `/.test(l));
  if (runIdx >= 0 && !errors.length && command.segments.some((s) => s.program === 'cargo' && (s.args.includes('run') || s.args.includes('r')))) {
    const headText = head.join('\n');
    const program = genericCompress(lines.slice(runIdx + 1), exitCode, Math.max(40, maxTokens - estimateTokens(headText) - 2));
    return fit(`${headText}\n${program}`, maxTokens);
  }
  const blocks = [...errors, ...(clippy ? warnings : []), ...tests];
  // `test x ... FAILED` without a stdout block (e.g. should_panic mismatch)
  for (const n of failedNames) if (!tests.some((t) => t.title === `FAILED ${n}`)) blocks.push({ title: `FAILED ${n}`, lines: [] });
  const tail = exitCode !== 0 ? summaries.filter((s) => s.startsWith('error')).slice(0, 2) : [];
  return layout(head, blocks, maxTokens, clippy ? 'diagnostics' : 'errors', tail);
}

export const cargo: Filter = {
  name: 'cargo',
  match(cmd, sample) {
    if (runs(cmd, ['cargo'], ['build', 'b', 'check', 'c', 'test', 't', 'clippy', 'run', 'r', 'nextest', 'bench', 'doc'])) return 90;
    if (/^\s+Compiling \S+ v\d/m.test(sample) || /^error\[E\d{4}\]: /m.test(sample) || /^test result: (?:ok|FAILED)\. /m.test(sample)) return 62;
    return 0;
  },
  compress: compressCargo,
};
