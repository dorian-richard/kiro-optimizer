// Fallback for unknown commands. Failure: error lines with +/-2 lines of context (stack frames trimmed).
// Success: near-duplicate collapsing, then head+tail.

import { truncateMiddle } from '../../core/tokens.js';
import { capLine, collapseSimilar, errorContext, fit, trimStack, type Filter, type FilterInput } from './common.js';

export function genericCompress(lines: string[], exitCode: number, maxTokens: number): string {
  if (exitCode !== 0) {
    const ctx = errorContext(lines, maxTokens);
    if (ctx !== undefined) return ctx;
  }
  const collapsed = collapseSimilar(trimStack(lines)).map((l) => capLine(l));
  // Tail-heavy: verdicts and the last error usually sit at the end.
  return fit(truncateMiddle(collapsed.join('\n'), maxTokens, 0.35).text, maxTokens);
}

export const generic: Filter = {
  name: 'generic',
  match: () => 1,
  compress: (inp: FilterInput) => genericCompress(inp.lines, inp.exitCode, inp.maxTokens),
};
