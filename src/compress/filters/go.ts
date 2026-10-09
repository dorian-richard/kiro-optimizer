// go test / go build / go vet. Success -> `ok: 23 packages (5 cached) · 4 without tests`. Failure -> each
// `--- FAIL` test with its own log lines, panics with repo frames only, build errors grouped by file,
// FAIL package lines. `=== RUN`/`--- PASS` noise dropped.

import { runs } from '../command.js';
import { diagBlocks, layout, plural, type Block, type Diag, type Filter, type FilterInput } from './common.js';

const OK_RE = /^ok\s+(\S+)\s+(?:\(cached\)|[\d.]+s)(.*)$/;
const NOTEST_RE = /^\?\s+(\S+)\s+\[no test files\]$/;
const PKG_FAIL_RE = /^FAIL\s+(\S+)\s+(.*)$/;
const RUN_RE = /^\s*=== (RUN|CONT|PAUSE|NAME)\s+(\S+)/;
const RESULT_RE = /^(\s*)--- (FAIL|PASS|SKIP): (\S+) \(([\d.]+s)\)$/;
const BUILD_ERR_RE = /^(?:vet: )?(\S+\.go):(\d+)(?::(\d+))?: (.*)$/;
const GO_LIB_RE = /[\\/]go[\\/]src[\\/]|[\\/]pkg[\\/]mod[\\/]|^\s*(?:testing|runtime|reflect|sync|created by testing)\b|^runtime\.|^testing\.|^panic\(/;

function digestPanic(lines: string[], start: number): { block: Block; end: number } {
  const head: string[] = [];
  let i = start;
  for (; i < lines.length && !/^goroutine \d+ \[/.test(lines[i]); i++) {
    if (lines[i].trim()) head.push(lines[i].trim());
    if (head.length > 6) break;
  }
  const frames: string[] = [];
  let firstRepo = '';
  for (i = i + 1; i < lines.length; i += 2) {
    const fn = lines[i];
    const loc = lines[i + 1];
    if (!fn || !loc || !/^\t/.test(loc) || /^\S+\s+\S+\s+[\d.]+s$/.test(fn)) break;
    const file = loc.trim().replace(/ \+0x[0-9a-f]+$/, '');
    if (GO_LIB_RE.test(file) || GO_LIB_RE.test(fn)) continue;
    const name = fn.replace(/\([^()]*\)$/, '').replace(/^.*\//, '');
    if (!firstRepo) firstRepo = file;
    if (frames.length < 3) frames.push(`  ${file} ${name}`);
  }
  // skip the remaining goroutine dump
  while (i < lines.length && !/^(FAIL|ok|exit status|---|===)\b/.test(lines[i])) i++;
  return { block: { title: head[0] ?? 'panic', lines: [...head.slice(1).map((h) => `  ${h}`), ...frames], key: `${head[0]}|${firstRepo}` }, end: i - 1 };
}

function compressGo(inp: FilterInput): string | undefined {
  const { lines, exitCode, maxTokens } = inp;
  let ok = 0;
  let cached = 0;
  let noTests = 0;
  let passed = 0;
  const failedPkgs: string[] = [];
  const logs = new Map<string, string[]>();
  const blocks: Block[] = [];
  const failedNames: string[] = [];
  const diags: Diag[] = [];
  let current: string | undefined;
  let afterFail: string | undefined;
  const other: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    if ((m = OK_RE.exec(line))) {
      ok++;
      if (line.includes('(cached)')) cached++;
      current = afterFail = undefined;
    } else if (NOTEST_RE.test(line)) noTests++;
    else if ((m = PKG_FAIL_RE.exec(line))) {
      failedPkgs.push(`${m[1]} ${m[2]}`.trim());
      current = afterFail = undefined;
    } else if ((m = RUN_RE.exec(line))) {
      current = m[2];
      afterFail = undefined;
    } else if ((m = RESULT_RE.exec(line))) {
      const name = m[3];
      if (m[2] === 'PASS') {
        passed++;
        logs.delete(name);
        afterFail = undefined;
      } else if (m[2] === 'FAIL') {
        failedNames.push(name);
        afterFail = name;
      } else afterFail = undefined;
    } else if (/^panic: /.test(line)) {
      const p = digestPanic(lines, i);
      blocks.push(p.block);
      i = p.end;
      current = afterFail = undefined;
    } else if ((m = BUILD_ERR_RE.exec(line)) && !/^\s/.test(line)) {
      diags.push({ file: m[1], line: Number(m[2]), col: m[3] ? Number(m[3]) : undefined, severity: 'error', message: m[4].trim() });
    } else if (/^\s{4,}\S/.test(line) || /^\s+\S+\.go:\d+:/.test(line)) {
      // test log line: belongs to the test that just failed (non -v) or the running one (-v)
      const owner = afterFail ?? current;
      if (owner) {
        const arr = logs.get(owner) ?? [];
        if (arr.length < 40) arr.push(line.trim());
        logs.set(owner, arr);
      }
    } else if (/^(?:# \S+|FAIL|PASS|exit status \d+)$/.test(line.trim()) || !line.trim()) {
      continue;
    } else if (exitCode !== 0) other.push(line);
  }

  // Subtest failures also fail their parents; keep the parent only if it has its own output.
  const names = failedNames.filter((n) => !failedNames.some((o) => o.startsWith(`${n}/`)) || (logs.get(n)?.length ?? 0) > 0);
  const testBlocks: Block[] = [...new Set(names)].map((n) => {
    const l = logs.get(n) ?? [];
    return { title: `--- FAIL: ${n}`, lines: l.slice(0, 12).map((x) => `  ${x}`), key: l.length ? l.join('\n').replace(/\b\w+_test\.go:\d+/g, '') + n.split('/')[0] : undefined };
  });

  if (!ok && !failedPkgs.length && !testBlocks.length && !blocks.length && !diags.length && !passed) return undefined;
  const parts: string[] = [];
  if (failedPkgs.length) parts.push(`FAIL: ${plural(failedPkgs.length, 'package')}`);
  if (ok) parts.push(`ok: ${plural(ok, 'package')}${cached ? ` (${cached} cached)` : ''}`);
  if (noTests) parts.push(`${noTests} without tests`);
  if (passed) parts.push(`${plural(passed, 'test')} passed`);
  const leafFailures = new Set(failedNames.filter((n) => !failedNames.some((o) => o.startsWith(`${n}/`))));
  if (leafFailures.size) parts.push(`${plural(leafFailures.size, 'test')} failed`);
  if (!parts.length) parts.push(exitCode === 0 ? 'ok' : `exit ${exitCode}`);
  const head = [parts.join(' · '), ...failedPkgs.slice(0, 8).map((p) => `FAIL ${p}`)];
  if (failedPkgs.length > 8) head.push(`… +${failedPkgs.length - 8} more failed packages`);
  const all: Block[] = [...diagBlocks(diags), ...testBlocks, ...blocks];
  if (!all.length && other.length) all.push({ title: 'output', lines: other.slice(0, 20) });
  return layout(head, all, maxTokens, 'failures');
}

export const go: Filter = {
  name: 'go',
  match(cmd, sample) {
    if (runs(cmd, ['go', 'gotestsum'], ['test', 'build', 'vet', 'install', 'generate'])) return 90;
    if (/^(?:ok|FAIL)\s+\S+\s+(?:[\d.]+s|\(cached\)|\[build failed\])/m.test(sample) || /^--- FAIL: \S+ \(/m.test(sample)) return 62;
    return 0;
  },
  compress: compressGo,
};
