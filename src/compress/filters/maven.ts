// Maven (mvn / mvnw). Success -> `BUILD SUCCESS · Total time · Tests run: …`. Failure -> compiler errors grouped
// by file (deduplicated: maven prints them twice), failing tests with message + repo frames, the goal that
// failed, failed/skipped reactor modules and the `-rf` resume hint. Boilerplate ([Help 1], -X/-e advice) dropped.

import { runs } from '../command.js';
import { diagBlocks, joinWithin, layout, plural, type Block, type Diag, type Filter, type FilterInput } from './common.js';
import { digestJavaTrace, JAVAC_EXTRA_RE } from './jvm.js';

const LEVEL_RE = /^\[(INFO|WARNING|WARN|ERROR|DEBUG|FATAL)\]\s?(.*)$/;
const MVN_COMPILE_RE = /^(\S.*?\.(?:java|kt|kts|scala|groovy)):\[(\d+),(\d+)\] (.*)$/;
const MVN_KOTLIN_RE = /^(?:e: )?(?:file:\/\/)?(\/?\S.*?\.kts?):(?:\s*\(|)(\d+)(?:, |:)(\d+)\)?:? (.*)$/;
const TEST_HEAD_RE = /^(\S+?)(?:\s+--)?\s+Time elapsed: .*<<< (FAILURE|ERROR)!$/;
const RESULTS_TOTAL_RE = /^Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)$/;
const REACTOR_RE = /^(\S.*?) \.{2,}\s*(SUCCESS|FAILURE|SKIPPED)(?: \[.*\])?$/;
const BOILERPLATE_RE =
  /^(?:-> \[Help \d+\]|To see the full stack trace|Re-run Maven using|For more information about the errors|\[Help \d+\] http|After correcting the problems|Please refer to .*(?:surefire|failsafe)-reports|Please refer to dump files|COMPILATION ERROR :?|Failures:\s*$|Errors:\s*$|Tests run: .*Time elapsed|Help 1|\s*$)/;

function compressMaven(inp: FilterInput): string | undefined {
  const { lines, exitCode, maxTokens } = inp;
  let verdict: string | undefined;
  let total: string | undefined;
  const sums = [0, 0, 0, 0];
  let sawTotals = false;
  const diags: Diag[] = [];
  const diagSeen = new Set<string>();
  const testBlocks: Block[] = [];
  const resultItems: string[] = [];
  const goals: string[] = [];
  const others: string[] = [];
  const modules: { name: string; status: string }[] = [];
  let warnings = 0;
  let resume: string | undefined;
  let resultsKind: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const lm = LEVEL_RE.exec(lines[i]);
    const level = lm ? lm[1] : '';
    const msg = lm ? lm[2] : lines[i];
    if (level === 'WARNING' || level === 'WARN') {
      if (msg.trim()) warnings++;
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^BUILD (SUCCESS|FAILURE)$/.exec(msg))) verdict = `BUILD ${m[1]}`;
    else if ((m = /^Total time:\s+(.+)$/.exec(msg))) total = m[1].trim();
    else if ((m = RESULTS_TOTAL_RE.exec(msg))) {
      sawTotals = true;
      for (let k = 0; k < 4; k++) sums[k] += Number(m[k + 1]);
    } else if ((m = REACTOR_RE.exec(msg))) modules.push({ name: m[1].trim(), status: m[2] });
    else if ((m = TEST_HEAD_RE.exec(msg))) {
      // surefire 2.x prints the head without a level prefix
      const body: string[] = [];
      while (i + 1 < lines.length && lines[i + 1].trim() && !LEVEL_RE.test(lines[i + 1])) body.push(lines[++i]);
      const d = digestJavaTrace(body);
      testBlocks.push({ title: `${m[2] === 'ERROR' ? 'ERROR' : 'FAILED'} ${m[1]}`, lines: d.lines, key: d.key });
    } else if (level !== 'ERROR' && level !== 'FATAL') continue;
    else if ((m = MVN_COMPILE_RE.exec(msg)) || (m = MVN_KOTLIN_RE.exec(msg))) {
      const extra: string[] = [];
      while (i + 1 < lines.length) {
        const next = LEVEL_RE.exec(lines[i + 1]);
        const nmsg = next ? next[2] : lines[i + 1];
        if ((next && next[1] !== 'ERROR') || !JAVAC_EXTRA_RE.test(nmsg)) break;
        extra.push(nmsg.trim());
        i++;
      }
      const k = `${m[1]}|${m[2]}|${m[3]}|${m[4]}`;
      if (!diagSeen.has(k)) {
        diagSeen.add(k);
        diags.push({ file: m[1], line: Number(m[2]), col: Number(m[3]), severity: 'error', message: m[4].trim(), extra });
      }
    } else if (/^(Failures|Errors|Flakes):\s*$/.test(msg)) resultsKind = msg.trim().replace(':', '');
    else if (resultsKind && /^\s{2}\S/.test(msg)) resultItems.push(`${resultsKind === 'Errors' ? 'ERROR' : 'FAILED'} ${msg.trim()}`);
    else if ((m = /^Failed to execute goal (.*)$/.exec(msg))) {
      resultsKind = undefined;
      const g = `Failed to execute goal ${m[1].replace(/^org\.apache\.maven\.plugins:/, '').replace(/(: Compilation failure)(?:: Compilation failure)?:?\s*$/, '$1')}`;
      if (!goals.includes(g)) goals.push(g);
    } else if ((m = /mvn <args> (-rf \S+)/.exec(msg))) resume = m[1];
    else if (!BOILERPLATE_RE.test(msg) && !RESULTS_TOTAL_RE.test(msg.replace(/^\s+/, ''))) {
      resultsKind = undefined;
      const t = msg.trim();
      if (diags.some((d) => t.includes(d.message) && t.includes(d.file))) continue;
      if (!others.includes(t)) others.push(t);
    }
  }
  if (!verdict && !diags.length && !testBlocks.length && !goals.length) return undefined;

  const head: string[] = [];
  const parts = [verdict ?? `exit ${exitCode}`];
  if (total) parts.push(`Total time: ${total}`);
  if (sawTotals) parts.push(`Tests run: ${sums[0]}, Failures: ${sums[1]}, Errors: ${sums[2]}, Skipped: ${sums[3]}`);
  if (modules.length > 1) {
    const failed = modules.filter((m) => m.status === 'FAILURE').map((m) => m.name);
    const skipped = modules.filter((m) => m.status === 'SKIPPED').map((m) => m.name);
    parts.push(plural(modules.length, 'module'));
    if (failed.length) parts.push(`failed: ${joinWithin(failed, 160)}`);
    if (skipped.length) parts.push(`skipped: ${joinWithin(skipped, 120)}`);
  }
  if (warnings) parts.push(plural(warnings, 'warning'));
  head.push(parts.join(' · '));

  const blocks: Block[] = [...diagBlocks(diags)];
  if (testBlocks.length) blocks.push(...testBlocks);
  else for (const r of resultItems) blocks.push({ title: r, lines: [] });
  const tail: string[] = [];
  if (verdict !== 'BUILD SUCCESS') {
    // Goal/other errors are context: shown after the specific failures, never instead of them.
    const extra = [...others.slice(0, 6).map((o) => o), ...goals];
    if (extra.length) blocks.push({ title: extra[0], lines: extra.slice(1).map((e) => e) });
    if (resume) tail.push(`resume with: mvn <args> ${resume}`);
  }
  return layout(head, blocks, maxTokens, 'errors', tail);
}

export const maven: Filter = {
  name: 'maven',
  match(cmd, sample) {
    if (runs(cmd, ['mvn', 'mvnw', 'mvnd'])) return 90;
    if (/^\[INFO\] (?:BUILD (?:SUCCESS|FAILURE)|Scanning for projects\.\.\.)/m.test(sample)) return 65;
    return 0;
  },
  compress: compressMaven,
};
