// .NET (dotnet build/test/restore/publish, msbuild). Success -> `Build succeeded · N warnings (by code)` +
// `Passed!` lines. Failure -> MSBuild errors grouped by file (deduplicated: MSBuild repeats them in the
// summary), failing tests with message + repo frames, `Failed!` lines. Restore/output-path chatter dropped.

import { runs } from '../command.js';
import { diagBlocks, joinWithin, layout, plural, trimStack, type Block, type Diag, type Filter, type FilterInput } from './common.js';

const DIAG_RE = /^\s*(.+?)\((\d+)(?:,(\d+))?(?:,\d+,\d+)?\)\s*: (error|warning) ([A-Za-z]+\d+)\s*: (.*?)(?: \[[^\]]+\])?$/;
const NOFILE_DIAG_RE = /^\s*(?:(\S[^:]*?) : )?(error|warning) ([A-Za-z]+\d+)\s*: (.*?)(?: \[[^\]]+\])?$/;
const VERDICT_RE = /^\s*(Build succeeded|Build FAILED)\.?\s*$/;
const COUNT_RE = /^\s*(\d+) (Warning|Error)\(s\)\s*$/;
const ELAPSED_RE = /^\s*Time Elapsed (\S+)\s*$/;
const TEST_SUMMARY_RE = /^\s*(Passed|Failed)!\s+-\s+Failed:\s+(\d+), Passed:\s+(\d+), Skipped:\s+(\d+), Total:\s+(\d+)(?:, Duration: ([^-]+?))?(?:\s+-\s+(.+))?\s*$/;
const TEST_FAILED_RE = /^\s*Failed (\S.*?) \[[^\]]*\]\s*$/;
const TEST_END_RE = /^\s*(?:(?:Passed|Failed|Skipped) \S.*? \[[^\]]*\]\s*$|(?:Passed|Failed)!\s+-|Results File:|Total tests:|Test Run (?:Failed|Successful)\.|A total of \d+ test)/;

function compressDotnet(inp: FilterInput): string | undefined {
  const { lines, exitCode, maxTokens } = inp;
  let verdict: string | undefined;
  let elapsed: string | undefined;
  const counts: Record<string, number> = {};
  const errors: Diag[] = [];
  const seen = new Set<string>();
  const warnCodes = new Map<string, number>();
  const testLines: string[] = [];
  const tests: Block[] = [];
  let legacyRun: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    if ((m = VERDICT_RE.exec(line))) verdict = m[1];
    else if ((m = COUNT_RE.exec(line))) counts[m[2]] = Number(m[1]);
    else if ((m = ELAPSED_RE.exec(line))) elapsed = m[1];
    else if ((m = TEST_SUMMARY_RE.exec(line))) {
      testLines.push(`${m[1]}! Failed: ${m[2]}, Passed: ${m[3]}, Skipped: ${m[4]}, Total: ${m[5]}${m[6] ? `, ${m[6].trim()}` : ''}${m[7] ? ` - ${m[7].trim()}` : ''}`);
    } else if ((m = /^\s*Test Run (Failed|Successful)\.\s*$/.exec(line))) legacyRun = `Test Run ${m[1]}`;
    else if ((m = TEST_FAILED_RE.exec(line))) {
      const body: string[] = [];
      while (i + 1 < lines.length && !TEST_END_RE.test(lines[i + 1])) body.push(lines[++i]);
      tests.push(digestTest(m[1], body));
    } else if ((m = DIAG_RE.exec(line))) {
      const d: Diag = { file: m[1].trim(), line: Number(m[2]), col: m[3] ? Number(m[3]) : undefined, severity: m[4] as 'error' | 'warning', code: m[5], message: m[6].trim() };
      record(d);
    } else if ((m = NOFILE_DIAG_RE.exec(line))) {
      record({ file: m[1]?.trim() || '(build)', severity: m[2] as 'error' | 'warning', code: m[3], message: m[4].trim() });
    }
  }

  function record(d: Diag) {
    const k = `${d.file}|${d.line}|${d.col}|${d.code}|${d.message}`;
    if (seen.has(k)) return;
    seen.add(k);
    if (d.severity === 'warning') warnCodes.set(d.code ?? '?', (warnCodes.get(d.code ?? '?') ?? 0) + 1);
    else errors.push(d);
  }

  if (!verdict && !testLines.length && !errors.length && !tests.length && !legacyRun) return undefined;
  const parts: string[] = [];
  if (verdict) parts.push(verdict);
  else if (!testLines.length) parts.push(legacyRun ?? `exit ${exitCode}`);
  const nWarn = [...warnCodes.values()].reduce((a, b) => a + b, 0) || counts.Warning || 0;
  if (verdict) parts.push(`${plural(errors.length || counts.Error || 0, 'error')}, ${plural(nWarn, 'warning')}`);
  else if (nWarn) parts.push(plural(nWarn, 'warning'));
  if (warnCodes.size) {
    const byCode = [...warnCodes].sort((a, b) => b[1] - a[1]).map(([c, n]) => (n > 1 ? `${c} x${n}` : c));
    parts[parts.length - 1] += ` (${joinWithin(byCode, 120)})`;
  }
  if (elapsed) parts.push(elapsed);
  const head = [parts.join(' · '), ...testLines];
  return layout(head, [...diagBlocks(errors), ...tests], maxTokens, 'errors');
}

function digestTest(name: string, body: string[]): Block {
  const out: string[] = [];
  let mode: 'msg' | 'stack' | 'skip' = 'msg';
  const msg: string[] = [];
  const stack: string[] = [];
  for (const raw of body) {
    const t = raw.trim();
    if (!t) continue;
    if (/^Error Message:$/.test(t)) {
      mode = 'msg';
      continue;
    }
    if (/^Stack Trace:$/.test(t)) {
      mode = 'stack';
      continue;
    }
    if (/^Standard (?:Output|Error) Messages:$/.test(t)) {
      mode = 'skip';
      continue;
    }
    if (mode === 'skip') continue;
    if (mode === 'stack' || /^at\s/.test(t)) stack.push(`at ${t.replace(/^at\s+/, '').replace(/:line (\d+)$/, ':$1')}`);
    else msg.push(t);
  }
  out.push(...msg.slice(0, 10).map((l) => `  ${l}`));
  if (msg.length > 10) out.push(`  … ${msg.length - 10} more lines`);
  const frames = trimStack(stack, 3, false);
  out.push(...frames.map((l) => `  ${l}`));
  const firstRepo = frames[0] ?? '';
  return { title: `FAILED ${name}`, lines: out, key: `${msg.slice(0, 3).join('\n')}|${firstRepo}` };
}

export const dotnet: Filter = {
  name: 'dotnet',
  match(cmd, sample) {
    if (runs(cmd, ['dotnet'], ['build', 'test', 'restore', 'publish', 'pack', 'msbuild', 'vstest', 'clean']) || runs(cmd, ['msbuild', 'xbuild'])) return 90;
    if (/^\s*(?:Build succeeded\.|Build FAILED\.)\s*$/m.test(sample) || /: (?:error|warning) (?:CS|MSB|NU|NETSDK)\d{4}/.test(sample)) return 62;
    if (/^\s*(?:Passed|Failed)!\s+- Failed:/m.test(sample)) return 62;
    return 0;
  },
  compress: compressDotnet,
};
