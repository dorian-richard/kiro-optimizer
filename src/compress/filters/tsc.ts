// TypeScript compiler (tsc, vue-tsc, tsc -b). Errors grouped by file, identical messages merged, per-file cap;
// pretty-mode code frames and the trailing "Errors  Files" table dropped.

import { runs } from '../command.js';
import { diagBlocks, layout, lastMatch, plural, type Diag, type Filter, type FilterInput } from './common.js';

const PLAIN_RE = /^(\S.*?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/;
const PRETTY_RE = /^(\S.*?):(\d+):(\d+) - (error|warning) (TS\d+): (.*)$/;
const FOUND_RE = /^Found (\d+) errors?(?: in (?:(\d+) files|.+))?\.?$/;

export function parseTscDiagnostics(lines: string[]): Diag[] {
  const diags: Diag[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = PLAIN_RE.exec(lines[i]) ?? PRETTY_RE.exec(lines[i]);
    if (!m) continue;
    const message = [m[6].trim()];
    // Message continuation (elaboration chain) is indented; pretty mode then prints a blank + code frame.
    while (i + 1 < lines.length && /^ {2,}\S/.test(lines[i + 1]) && !/^\s*\d+\s{2,}/.test(lines[i + 1]) && message.length < 4) {
      message.push(lines[++i].trim());
    }
    diags.push({ file: m[1], line: Number(m[2]), col: Number(m[3]), severity: m[4] as 'error' | 'warning', code: m[5], message: message.join(' ') });
  }
  return diags;
}

function compressTsc(inp: FilterInput): string | undefined {
  const { lines, exitCode, maxTokens } = inp;
  const diags = parseTscDiagnostics(lines);
  const found = lastMatch(lines, FOUND_RE);
  if (!diags.length && !found) return exitCode === 0 ? 'tsc: no errors' : undefined;
  const files = new Set(diags.map((d) => d.file)).size;
  const errors = diags.filter((d) => d.severity === 'error').length;
  const head = found ? found[0] : `${plural(errors, 'error')} in ${plural(files, 'file')}`;
  return layout([head], diagBlocks(diags, 10), maxTokens, 'files');
}

export const tsc: Filter = {
  name: 'tsc',
  match(cmd, sample) {
    if (runs(cmd, ['tsc', 'vue-tsc', 'tsgo', 'tspc'])) return 90;
    if (/(?:\(\d+,\d+\): |:\d+:\d+ - )error TS\d+: /.test(sample)) return 66;
    return 0;
  },
  compress: compressTsc,
};
