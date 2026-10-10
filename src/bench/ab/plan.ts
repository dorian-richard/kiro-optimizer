// Seeded, counterbalanced run order. Blocks = (task, repetition) pairs, tasks shuffled per repetition. Inside a
// block every arm runs once; the arm order rotates from block to block and reverses every full cycle (a Latin
// square): with two arms A B | B A | B A | A B ..., so slow drift (time of day, backend load, warm caches) hits every
// arm equally and no arm always runs first.

import type { Arm, PlanItem } from './types.js';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(xs: readonly T[], rnd: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Order of the arms in block `k`: rotation k mod n of `base`, reversed on odd cycles. */
export function armOrder(base: readonly Arm[], k: number): Arm[] {
  const n = base.length;
  if (n <= 1) return [...base];
  const r = k % n;
  const rotated = [...base.slice(r), ...base.slice(0, r)];
  return Math.floor(k / n) % 2 === 1 ? rotated.reverse() : rotated;
}

export function runIdOf(task: string, arm: Arm, rep: number): string {
  return `${task}__${arm}__r${rep}`;
}

export function makePlan(taskIds: readonly string[], arms: readonly Arm[], reps: number, seed: number): PlanItem[] {
  const rnd = mulberry32(seed);
  const base = shuffle(arms, rnd);
  const out: PlanItem[] = [];
  let k = 0;
  for (let rep = 1; rep <= reps; rep++) {
    for (const task of shuffle(taskIds, rnd)) {
      armOrder(base, k).forEach((arm, order) => out.push({ idx: out.length + 1, runId: runIdOf(task, arm, rep), task, arm, rep, order }));
      k++;
    }
  }
  return out;
}
