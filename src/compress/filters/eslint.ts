// ESLint (stylish, compact and unix formatters). Errors grouped by file with a per-file cap; when errors exist,
// warnings are summarized by rule (counts) instead of listed.

import { runs } from '../command.js';
import { diagBlocks, joinWithin, layout, lastMatch, plural, type Diag, type Filter, type FilterInput } from './common.js';

const FILE_HEADER_RE = /^(?:[A-Za-z]:\\|\/|\.{0,2}\/?)?[^\s:]+\.[A-Za-z0-9]+$/;
const STYLISH_RE = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.*?)(?:\s{2,}(\S+))?\s*$/;
const UNIX_RE = /^(\S.*?):(\d+):(\d+): (.*?) \[(Error|Warning)(?:\/(\S+))?\]$/;
const COMPACT_RE = /^(\S.*?): line (\d+), col (\d+), (Error|Warning) - (.*?)(?: \((\S+)\))?$/;
const SUMMARY_RE = /^✖ \d+ problems? \(\d+ errors?, \d+ warnings?\)$/;
const FIXABLE_RE = /^\s*\d+ errors? and \d+ warnings? potentially fixable/;

function compressEslint(inp: FilterInput): string | undefined {
  const { lines, exitCode, maxTokens } = inp;
  const diags: Diag[] = [];
  let file: string | undefined;
  for (const line of lines) {
    let m: RegExpExecArray | null;
    if ((m = STYLISH_RE.exec(line)) && file) {
      const rule = m[5];
      diags.push({ file, line: Number(m[1]), col: Number(m[2]), severity: m[3] as 'error' | 'warning', code: undefined, message: rule ? `${m[4].trim()} (${rule})` : m[4].trim() });
    } else if ((m = UNIX_RE.exec(line))) {
      diags.push({ file: m[1], line: Number(m[2]), col: Number(m[3]), severity: m[5] === 'Error' ? 'error' : 'warning', message: m[6] ? `${m[4]} (${m[6]})` : m[4] });
    } else if ((m = COMPACT_RE.exec(line))) {
      diags.push({ file: m[1], line: Number(m[2]), col: Number(m[3]), severity: m[4] === 'Error' ? 'error' : 'warning', message: m[6] ? `${m[5]} (${m[6]})` : m[5] });
    } else if (FILE_HEADER_RE.test(line) && !/^\s/.test(line)) file = line.trim();
    else if (!line.trim()) file = undefined;
  }
  const summary = lastMatch(lines, SUMMARY_RE);
  const fixable = lines.find((l) => FIXABLE_RE.test(l));
  if (!diags.length && !summary) return exitCode === 0 ? 'eslint: no problems' : undefined;
  return layoutEslint(diags, maxTokens, summary?.[0], fixable?.trim());
}

/**
 * Problems (message ending with `(rule)`) -> summary line, errors grouped by file and, when there are errors,
 * warnings counted by rule instead of listed. Shared with the JSON formatter (`eslint -f json`).
 */
export function layoutEslint(diags: Diag[], maxTokens: number, summary?: string, fixable?: string): string {
  const errors = diags.filter((d) => d.severity === 'error');
  const warnings = diags.filter((d) => d.severity === 'warning');
  const head: string[] = [summary ?? `✖ ${plural(diags.length, 'problem')} (${plural(errors.length, 'error')}, ${plural(warnings.length, 'warning')})`];
  if (fixable) head.push(fixable);
  let shown = diags;
  if (errors.length && warnings.length) {
    const byRule = new Map<string, number>();
    for (const w of warnings) {
      const rule = /\(([^()]+)\)$/.exec(w.message)?.[1] ?? 'other';
      byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
    }
    head.push(`warnings by rule: ${joinWithin([...byRule].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`), 300)}`);
    shown = errors;
  }
  return layout(head, diagBlocks(shown, 10), maxTokens, 'files');
}

export const eslint: Filter = {
  name: 'eslint',
  match(cmd, sample) {
    if (runs(cmd, ['eslint']) || runs(cmd, ['next'], ['lint'])) return 90;
    if (/^✖ \d+ problems? \(\d+ errors?, \d+ warnings?\)$/m.test(sample)) return 66;
    return 0;
  },
  compress: compressEslint,
};
