// Bazel / Bazelisk (build, test). Success -> `Build completed successfully · Executed 20 out of 20 tests: 20 tests
// pass · Elapsed time: 12.3s`. Failure -> each `ERROR:` with the compiler diagnostics printed under it, failed /
// timed-out / flaky test targets with the failing part of their test log (--test_output=errors); loading,
// analysis and `[1,234 / 2,345]` progress lines, `INFO: From ...` action output and passing targets dropped.

import { runs } from '../command.js';
import { errorContext, joinWithin, layout, lastMatch, type Block, type Filter, type FilterInput } from './common.js';

const ERROR_RE = /^ERROR: (?:(\S+?):(\d+):(\d+): )?(.*)$/;
const TARGET_RE = /^(\/\/\S+|@\S+\/\/\S+)\s+(PASSED|FAILED|TIMEOUT|FLAKY|NO STATUS|FAILED TO BUILD|INCOMPLETE|SKIPPED)(?: in (.+))?$/;
const EXECUTED_RE = /^Executed \d+ out of \d+ tests?: .*$/;
const BUILD_DONE_RE = /^INFO: Build completed successfully, (\d+) total actions?$|^(FAILED: Build did NOT complete successfully.*|ERROR: Build did NOT complete successfully.*)$/;
const ELAPSED_RE = /^INFO: Elapsed time: ([\d.]+s)/;
const TEST_OUTPUT_RE = /^=+ Test output for (\S+):$/;
const NOISE_RE = /^(?:\[[\d,]+ \/ [\d,]+\] |Loading:|Analyzing:|INFO: (?:Invocation ID|Analyzed|Found|Streaming build results|Reading|Current date|Using|Options provided|Starting local|From )|Computing main repo mapping|DEBUG: |Target \/\/\S+ up-to-date:|\s+bazel-(?:bin|out)\/)/;

function shortenError(msg: string): string {
  return msg
    .replace(/ \(remaining \d+ arguments? skipped\)$/, '')
    .replace(/(: error executing \w+ command) \(from target [^)]+\) .*$/, '$1')
    .replace(/^(.{0,300}).*$/, '$1');
}

function compressBazel(inp: FilterInput): string | undefined {
  const { lines, maxTokens, exitCode } = inp;
  const blocks: Block[] = [];
  const targets: { name: string; status: string; time?: string }[] = [];
  const testOutputs = new Map<string, string[]>();
  let passed = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    if ((m = TEST_OUTPUT_RE.exec(line))) {
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length && !/^={20,}$/.test(lines[j]) && !TEST_OUTPUT_RE.test(lines[j]); j++) body.push(lines[j]);
      i = j;
      testOutputs.set(m[1], body);
    } else if ((m = TARGET_RE.exec(line))) {
      if (m[2] === 'PASSED') passed++;
      else targets.push({ name: m[1], status: m[2], time: m[3] });
      // the indented test.log path(s) that follow
      while (i + 1 < lines.length && /^\s+\S+test(?:\.log|_attempts)/.test(lines[i + 1])) i++;
    } else if ((m = ERROR_RE.exec(line)) && !BUILD_DONE_RE.test(line)) {
      const where = m[1] ? `${m[1]}:${m[2]}` : '';
      const detail: string[] = [];
      let j = i + 1;
      for (; j < lines.length && !/^(?:ERROR|INFO|WARNING|FAILED|Target |\[\d)/.test(lines[j]) && !TARGET_RE.test(lines[j]) && !EXECUTED_RE.test(lines[j]); j++) {
        if (lines[j].trim()) detail.push(lines[j]);
      }
      i = j - 1;
      const diag = detail.length ? errorContext(detail, 220, 1, 0) ?? detail.slice(0, 8).join('\n') : '';
      blocks.push({
        title: `ERROR ${where ? `${where}: ` : ''}${shortenError(m[4])}`,
        lines: diag ? diag.split('\n').map((l) => `  ${l}`) : [],
        key: `${shortenError(m[4]).replace(/\/\/\S+/g, '')}|${diag}`,
      });
    }
  }
  for (const t of targets) {
    // the failing part of the test log: no blank lines, no runner banner or `..E.` progress
    const out = testOutputs.get(t.name)?.filter((l) => l.trim() && !/^\s*[.EFIS]+\s*$/.test(l) && !/^(?:JUnit\d? Test Runner|Time: [\d.,]+)$/.test(l.trim()));
    const body = out ? errorContext(out, 260, 2, 2) ?? out.slice(-8).join('\n') : '';
    blocks.push({ title: `${t.status} ${t.name}${t.time ? ` in ${t.time}` : ''}`, lines: body ? body.split('\n').map((l) => `  ${l}`) : [] });
  }
  const executed = lastMatch(lines, EXECUTED_RE);
  const done = lastMatch(lines, BUILD_DONE_RE);
  const elapsed = lastMatch(lines, ELAPSED_RE);
  if (!executed && !done && !blocks.length) return undefined;
  const head = [
    done ? (done[1] ? `Build completed successfully, ${done[1]} total actions` : done[2].replace(/^(?:FAILED|ERROR): /, '')) : `exit ${exitCode}`,
    executed?.[0],
    passed && targets.length && !executed ? `${passed} targets passed` : undefined,
    elapsed ? `Elapsed time: ${elapsed[1]}` : undefined,
  ].filter(Boolean);
  const warnings = lines.filter((l) => /^WARNING: /.test(l) && !NOISE_RE.test(l)).length;
  if (warnings) head.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);
  return layout([head.join(' · ')], blocks, maxTokens, 'errors', targets.length > 6 ? [`failed targets: ${joinWithin(targets.map((t) => t.name), 300)}`] : []);
}

export const bazel: Filter = {
  name: 'bazel',
  match(cmd, sample) {
    if (runs(cmd, ['bazel', 'bazelisk', 'blaze'])) return 90;
    if (/^(?:INFO: Elapsed time: |INFO: Build completed successfully|FAILED: Build did NOT complete successfully|Executed \d+ out of \d+ tests?: )/m.test(sample)) return 66;
    return 0;
  },
  compress: compressBazel,
};
