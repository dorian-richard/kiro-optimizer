// Gradle (gradle / gradlew). Success -> `BUILD SUCCESSFUL in 34s · 12 actionable tasks…`. Failure -> javac/kotlinc
// errors grouped by file, failing tests (exception + repo frames), failed tasks and "What went wrong";
// `* Try:` advice, task lines and deprecation notices dropped.

import { runs } from '../command.js';
import { diagBlocks, joinWithin, layout, plural, type Block, type Diag, type Filter, type FilterInput } from './common.js';
import { digestJavaTrace, JAVAC_EXTRA_RE, JAVAC_RE, KOTLIN_OLD_RE, KOTLIN_RE } from './jvm.js';

const TASK_FAILED_RE = /^> Task (\S+) FAILED$/;
const BUILD_RE = /^BUILD (SUCCESSFUL|FAILED) in (.+)$/;
const ACTIONABLE_RE = /^\d+ actionable tasks?: .+$/;
const TEST_FAILED_RE = /^(\S.*?) > (.+?) FAILED$/;
const TEST_PASSED_RE = /^\S.*? > .+? PASSED$/;
const TESTS_SUMMARY_RE = /^\d+ tests? completed, \d+ failed(?:, \d+ skipped)?$/;

function compressGradle(inp: FilterInput): string | undefined {
  const { lines, exitCode, maxTokens } = inp;
  let build: string | undefined;
  let actionable: string | undefined;
  let testsSummary: string | undefined;
  let passed = 0;
  let warnings = 0;
  const failedTasks: string[] = [];
  const diags: Diag[] = [];
  const tests: Block[] = [];
  const wrong: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    if ((m = BUILD_RE.exec(line))) build = `BUILD ${m[1]} in ${m[2]}`;
    else if (ACTIONABLE_RE.test(line)) actionable = line.trim();
    else if ((m = TASK_FAILED_RE.exec(line))) failedTasks.push(m[1]);
    else if (TESTS_SUMMARY_RE.test(line)) testsSummary = line.trim();
    else if (TEST_PASSED_RE.test(line)) passed++;
    else if ((m = JAVAC_RE.exec(line))) {
      if (m[3] === 'warning') {
        warnings++;
        continue;
      }
      const extra: string[] = [];
      let j = i + 1;
      // javac prints: source line, caret line, then symbol:/location: details
      for (let k = 0; k < 2 && j < lines.length && !JAVAC_RE.test(lines[j]) && !JAVAC_EXTRA_RE.test(lines[j]) && /^\s/.test(lines[j]); k++) j++;
      while (j < lines.length && JAVAC_EXTRA_RE.test(lines[j])) extra.push(lines[j++].trim());
      i = j - 1;
      diags.push({ file: m[1], line: Number(m[2]), severity: 'error', message: m[4].trim(), extra });
    } else if ((m = KOTLIN_RE.exec(line)) || (m = KOTLIN_OLD_RE.exec(line))) {
      if (m[1] === 'w') warnings++;
      else diags.push({ file: m[2], line: Number(m[3]), col: Number(m[4]), severity: 'error', message: m[5].trim() });
    } else if ((m = TEST_FAILED_RE.exec(line)) && !line.startsWith('> Task')) {
      const body: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) body.push(lines[++i]);
      const d = digestJavaTrace(body);
      tests.push({ title: `FAILED ${m[1]} > ${m[2]}`, lines: d.lines, key: d.key });
    } else if (/^\* What went wrong:/.test(line)) {
      const sect: string[] = [];
      while (i + 1 < lines.length && !/^\* \w|^BUILD |^={10,}/.test(lines[i + 1])) {
        const t = lines[++i].trim();
        if (t) sect.push(t);
      }
      const text = sect.join(' ').replace(/\s*> /g, ' > ').trim();
      if (text && !wrong.includes(text)) wrong.push(text);
    }
  }
  if (!build && !diags.length && !tests.length && !wrong.length) return undefined;

  const parts = [build ?? `exit ${exitCode}`];
  if (actionable) parts.push(actionable);
  if (testsSummary) parts.push(testsSummary);
  else if (passed) parts.push(`${plural(passed, 'test')} passed`);
  if (failedTasks.length) parts.push(`failed tasks: ${joinWithin(failedTasks, 160)}`);
  if (warnings) parts.push(plural(warnings, 'warning'));
  const blocks: Block[] = [...diagBlocks(diags), ...tests];
  // "What went wrong" restates compile/test failures; show it only when it adds information.
  const informative = wrong.filter((w) => !(diags.length && /Compilation failed/i.test(w)) && !(tests.length && /There were failing tests/i.test(w)));
  if (informative.length) blocks.push({ title: 'What went wrong:', lines: informative.map((w) => `  ${w}`) });
  return layout([parts.join(' · ')], blocks, maxTokens, 'errors');
}

export const gradle: Filter = {
  name: 'gradle',
  match(cmd, sample) {
    if (runs(cmd, ['gradle', 'gradlew'])) return 90;
    if (/^BUILD (?:SUCCESSFUL|FAILED) in \S+/m.test(sample) || /^> Task :\S+/m.test(sample)) return 62;
    return 0;
  },
  compress: compressGradle,
};
