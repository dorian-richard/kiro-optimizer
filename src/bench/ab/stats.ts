// Small, dependency-free statistics for the A/B report: medians, a two-stage (cluster) bootstrap over paired runs,
// and the exact sign test.

import { mulberry32 } from './plan.js';

export function median(xs: readonly number[]): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function mean(xs: readonly number[]): number | undefined {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined;
}

export function sum(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

export interface Pair {
  task: string;
  a: number;
  b: number;
}

/** Relative difference of totals over pairs: sum(B) / sum(A) - 1 (negative = B cheaper). */
export function relativeDiff(pairs: readonly Pair[]): number | undefined {
  const sa = sum(pairs.map((p) => p.a));
  return pairs.length && sa > 0 ? sum(pairs.map((p) => p.b)) / sa - 1 : undefined;
}

/**
 * Percentile CI of `stat` by a two-stage bootstrap: resample tasks with replacement, then the pairs within each
 * drawn task. Runs of one task are correlated (same question), so tasks are the primary resampling unit.
 */
export function clusterBootstrap(
  pairs: readonly Pair[],
  stat: (sample: Pair[]) => number | undefined,
  iterations = 10000,
  seed = 7,
  alpha = 0.05,
): [number | undefined, number | undefined] {
  const byTask = new Map<string, Pair[]>();
  for (const p of pairs) byTask.set(p.task, [...(byTask.get(p.task) ?? []), p]);
  const groups = [...byTask.values()];
  if (pairs.length < 2) return [undefined, undefined];
  const rnd = mulberry32(seed);
  const stats: number[] = [];
  for (let it = 0; it < iterations; it++) {
    const sample: Pair[] = [];
    for (let g = 0; g < groups.length; g++) {
      const grp = groups[Math.floor(rnd() * groups.length)];
      for (let k = 0; k < grp.length; k++) sample.push(grp[Math.floor(rnd() * grp.length)]);
    }
    const v = stat(sample);
    if (v !== undefined && Number.isFinite(v)) stats.push(v);
  }
  if (!stats.length) return [undefined, undefined];
  stats.sort((a, b) => a - b);
  const at = (q: number) => stats[Math.min(stats.length - 1, Math.max(0, Math.floor(q * stats.length)))];
  return [at(alpha / 2), at(1 - alpha / 2)];
}

/** Exact two-sided sign test: p-value of k "successes" among n non-tied pairs under p = 0.5. */
export function signTest(k: number, n: number): number | undefined {
  if (!n) return undefined;
  const logC = (r: number) => {
    let s = 0;
    for (let i = 1; i <= r; i++) s += Math.log(n - r + i) - Math.log(i);
    return s;
  };
  const extreme = Math.max(k, n - k);
  let tail = 0;
  for (let i = extreme; i <= n; i++) tail += Math.exp(logC(i) - n * Math.LN2);
  return Math.min(1, 2 * tail);
}
