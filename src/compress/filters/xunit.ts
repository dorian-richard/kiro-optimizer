// .NET test runners outside the VSTest console format (handled by the dotnet filter): the xUnit console runner
// (`Name [FAIL]` blocks, `=== TEST EXECUTION SUMMARY ===`), NUnit 3 console (`Errors, Failures and Warnings`,
// `Test Run Summary`) and Microsoft.Testing.Platform (`failed Name (12ms)`, `Test run summary:`). Per failing test:
// the assertion message and up to 3 in-repo frames (System./Xunit./NUnit. frames dropped).

import { runs } from '../command.js';
import { layout, trimStack, type Block, type Filter, type FilterInput } from './common.js';

const XUNIT_FAIL_RE = /^(\s*)(?:\[xUnit\.net [\d:.]+\]\s+)?(\S.*?) \[FAIL\]$/;
const XUNIT_SUMMARY_RE = /^\s*(\S+)\s+Total: (\d+), Errors: (\d+), Failed: (\d+), Skipped: (\d+)(?:, Not Run: \d+)?, Time: (\S+)$/;
const NUNIT_ENTRY_RE = /^(\d+)\) (Failed|Error|Invalid|Warning) : (\S.*)$/;
const NUNIT_RESULT_RE = /^\s*Overall result: (\w+)/;
const NUNIT_COUNT_RE = /^\s*(Test Count: \d+, Passed: \d+, Failed: \d+.*)$/;
const NUNIT_DURATION_RE = /^\s*Duration: ([\d.]+ seconds)$/;
const MTP_FAIL_RE = /^\s*(failed|error) (\S.*?) \((?:[\d.]+\s*m?s|\d+m \d+s|[\dhms .]+)\)$/;
const MTP_SUMMARY_RE = /^\s*Test run summary: (Passed!|Failed!|Zero tests ran|Aborted!)(?: - (.*))?$/;
const MTP_COUNT_RE = /^\s{2,}(total|failed|succeeded|skipped|duration): (.+)$/;
const MAX_MESSAGE_LINES = 10;

/** Message + frames of one failing test; frames `at X in path:line N` / `path(28,0): at X` normalized. */
export function digestDotnetFailure(title: string, body: string[]): Block {
  const msg: string[] = [];
  const stack: string[] = [];
  let inStack = false;
  for (const raw of body) {
    const t = raw.trim();
    if (!t) continue;
    if (/^Stack Trace:$/.test(t)) {
      inStack = true;
      continue;
    }
    if (/^(?:Output|Standard Output Messages|Standard Error Messages):$/.test(t)) break;
    const xunitFrame = /^(\S.*?)\((\d+),\d+\): at (.*)$/.exec(t);
    if (xunitFrame) {
      stack.push(`at ${xunitFrame[3]} in ${xunitFrame[1]}:${xunitFrame[2]}`);
      inStack = true;
      continue;
    }
    if (/^at\s/.test(t) || (inStack && /^\S+\.\S+\(.*\)/.test(t))) {
      stack.push(`at ${t.replace(/^at\s+/, '').replace(/:line (\d+)$/, ':$1')}`);
      inStack = true;
      continue;
    }
    if (!inStack) msg.push(t);
  }
  const kept = msg.length > MAX_MESSAGE_LINES ? [...msg.slice(0, MAX_MESSAGE_LINES), `… ${msg.length - MAX_MESSAGE_LINES} more lines`] : msg;
  const frames = trimStack(stack, 3, false);
  return { title, lines: [...kept.map((l) => `  ${l}`), ...frames.map((f) => `  ${f}`)], key: `${msg.slice(0, 3).join('\n')}|${frames[0] ?? ''}` };
}

/** Failures and summary lines of xUnit console, NUnit console and Microsoft.Testing.Platform output. */
export function parseDotnetRunners(lines: string[]): { head: string[]; blocks: Block[] } {
  const head: string[] = [];
  const blocks: Block[] = [];
  const mtp: Record<string, string> = {};
  let mtpVerdict: string | undefined;
  let nunitResult: string | undefined;
  let nunitCount: string | undefined;
  let nunitDuration: string | undefined;
  let inNunitList = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    if ((m = XUNIT_FAIL_RE.exec(line))) {
      const indent = m[1].length;
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length && (lines[j].length - lines[j].trimStart().length > indent || !lines[j].trim()) && !XUNIT_FAIL_RE.test(lines[j]); j++) {
        body.push(lines[j].replace(/^\s*\[xUnit\.net [\d:.]+\]/, ''));
      }
      i = j - 1;
      blocks.push(digestDotnetFailure(`FAILED ${m[2].trim()}`, body));
    } else if ((m = XUNIT_SUMMARY_RE.exec(line))) {
      head.push(`${m[1]}: Total ${m[2]}, Errors ${m[3]}, Failed ${m[4]}, Skipped ${m[5]}, ${m[6]}`);
    } else if (/^Errors, Failures and Warnings$/.test(line.trim())) {
      inNunitList = true;
    } else if (inNunitList && (m = NUNIT_ENTRY_RE.exec(line.trim()))) {
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length && !NUNIT_ENTRY_RE.test(lines[j].trim()) && !/^(?:Run Settings|Test Run Summary)$/.test(lines[j].trim()); j++) body.push(lines[j]);
      i = j - 1;
      if (m[2] !== 'Warning') blocks.push(digestDotnetFailure(`${m[2] === 'Error' ? 'ERROR' : 'FAILED'} ${m[3].trim()}`, body));
    } else if (/^(?:Run Settings|Test Run Summary)$/.test(line.trim())) {
      inNunitList = false;
    } else if ((m = NUNIT_RESULT_RE.exec(line))) nunitResult = m[1];
    else if ((m = NUNIT_COUNT_RE.exec(line))) nunitCount = m[1];
    else if ((m = NUNIT_DURATION_RE.exec(line)) && nunitResult) nunitDuration = m[1];
    else if ((m = MTP_FAIL_RE.exec(line))) {
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length && /^\s{2,}\S/.test(lines[j]) && !MTP_FAIL_RE.test(lines[j]) && !MTP_COUNT_RE.test(lines[j]); j++) body.push(lines[j]);
      i = j - 1;
      blocks.push(digestDotnetFailure(`${m[1] === 'error' ? 'ERROR' : 'FAILED'} ${m[2].trim()}`, body));
    } else if ((m = MTP_SUMMARY_RE.exec(line))) {
      mtpVerdict = m[1];
    } else if (mtpVerdict && (m = MTP_COUNT_RE.exec(line))) {
      mtp[m[1]] = m[2].trim();
    }
  }
  if (nunitResult || nunitCount) head.push([nunitResult ? `Overall result: ${nunitResult}` : '', nunitCount ?? '', nunitDuration ?? ''].filter(Boolean).join(' · '));
  if (mtpVerdict) {
    const counts = ['total', 'failed', 'succeeded', 'skipped', 'duration'].filter((k) => mtp[k]).map((k) => `${k}: ${mtp[k]}`);
    head.push([`Test run summary: ${mtpVerdict}`, ...counts].join(' · '));
  }
  return { head, blocks };
}

function compressXunit(inp: FilterInput): string | undefined {
  const { head, blocks } = parseDotnetRunners(inp.lines);
  if (!head.length && !blocks.length) return undefined;
  return layout([head.join('\n') || `exit ${inp.exitCode}`], blocks, inp.maxTokens, 'failures');
}

export const xunit: Filter = {
  name: 'xunit',
  match(cmd, sample) {
    if (runs(cmd, ['xunit.console', 'xunit.console.x86', 'nunit3-console', 'nunit-console', 'nunit3-console.exe'])) return 90;
    if (/^=== TEST EXECUTION SUMMARY ===$|^Test Run Summary$|^\s*Test run summary: (?:Passed|Failed)!/m.test(sample)) return 64;
    return 0;
  },
  compress: compressXunit,
};
