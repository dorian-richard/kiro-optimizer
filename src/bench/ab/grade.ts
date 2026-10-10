// Automatic grading of a final answer against the task's gold (symbols and files the answer must name).
// Pre-registered rule: a symbol counts when the answer contains it as a whole identifier (case-sensitive), a file
// when the answer contains its repo-relative path (any slash direction) or its file name as a whole token. The
// answer passes when it names at least ceil(passRatio x n) of the n gold symbols AND of the n gold files (each list
// that is given), default passRatio 0.6 (2 of 2, 2 of 3, 3 of 4).

import type { AbGold, Grade } from './types.js';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function mentionsSymbol(answer: string, symbol: string): boolean {
  return new RegExp(`(?<![\\w$])${escapeRegex(symbol)}(?![\\w$])`).test(answer);
}

export function mentionsFile(answer: string, file: string): boolean {
  const a = answer.replace(/\\/g, '/');
  const f = file.replace(/\\/g, '/').replace(/^\.\//, '');
  if (a.includes(f)) return true;
  const base = f.split('/').pop() ?? f;
  if (!base) return false;
  return new RegExp(`(?<![\\w.$/-])${escapeRegex(base)}(?![\\w$-])`).test(a);
}

export function needed(n: number, passRatio: number): number {
  return n ? Math.max(1, Math.ceil(passRatio * n - 1e-9)) : 0;
}

export function gradeAnswer(answer: string, gold: AbGold | undefined, passRatio = 0.6): Grade | undefined {
  if (!gold) return undefined;
  const missingSymbols = gold.symbols.filter((s) => !mentionsSymbol(answer, s));
  const missingFiles = gold.files.filter((f) => !mentionsFile(answer, f));
  const symbolsFound = gold.symbols.length - missingSymbols.length;
  const filesFound = gold.files.length - missingFiles.length;
  const pass =
    answer.trim() !== '' && symbolsFound >= needed(gold.symbols.length, passRatio) && filesFound >= needed(gold.files.length, passRatio);
  return { pass, symbolsFound, symbolsTotal: gold.symbols.length, filesFound, filesTotal: gold.files.length, missingSymbols, missingFiles };
}
