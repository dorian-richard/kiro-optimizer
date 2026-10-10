// Credit accounting of a campaign, shared by the runner (the --max-credits budget) and the report: what each run is
// counted for, measured or estimated, plus the attempts that were archived (runs a killed harness left behind, runs
// re-run by --resume, superseded smoke runs). The same function gives the console total and the report's.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { median } from './stats.js';
import type { Arm, ErrorKind, RunRecord } from './types.js';

/**
 * Failures that happen before kiro-cli sends anything to the model, or that the backend refuses outright (a blocked
 * account: 403, no metering in the session file, seen with 2.28): nothing is billed.
 */
export const FREE_ERRORS: ReadonlySet<ErrorKind> = new Set<ErrorKind>(['account_blocked', 'not_logged_in', 'agent_not_found', 'mcp_startup', 'spawn_failed']);

/** Typical cost of a run of `arm`: its measured runs (the larger of the recent maximum and the mean), else any arm's maximum, else the guess. */
export function estimateFor(records: readonly RunRecord[], arm: Arm, guess: number): number {
  const own = records.filter((r) => !r.smoke && r.arm === arm && r.credits !== undefined && r.valid).map((r) => r.credits!);
  if (own.length) return Math.max(...own.slice(-5), own.reduce((a, b) => a + b, 0) / own.length);
  const any = records.filter((r) => !r.smoke && r.credits !== undefined && r.valid).map((r) => r.credits!);
  if (any.length) return Math.max(...any);
  return guess;
}

/** Median wall time of the valid runs of an arm (ms), to scale the estimate of a run that ran until its timeout. */
export function typicalWallMs(records: readonly RunRecord[], arm: Arm): number | undefined {
  return median(records.filter((r) => !r.smoke && r.arm === arm && r.valid).map((r) => r.wallMs));
}

/**
 * What a run is counted for in the budget. Measured credits when Kiro reported them; a run that was cut short
 * (timeout, killed harness) is counted for at least the estimate, scaled by how much longer than a typical run it
 * went (a timeout is the longest kind of run, x1 to x5); a failure before any prompt is free.
 */
export function billed(r: RunRecord, estimate: number, typicalWall?: number): number {
  if (r.errorKind && FREE_ERRORS.has(r.errorKind)) return r.credits ?? 0;
  if (r.timedOut) {
    const scale = typicalWall && r.wallMs ? Math.min(5, Math.max(1, r.wallMs / typicalWall)) : 2;
    return Math.max(r.credits ?? 0, estimate * scale);
  }
  if (r.errorKind === 'aborted') return Math.max(r.credits ?? 0, estimate);
  if (r.credits !== undefined) return r.credits;
  return estimate;
}

export interface ArchivedAttempt {
  runId: string;
  at: string;
  credits: number;
  measured: boolean;
  /** why it was archived: aborted (a killed harness), retried (--resume), superseded (a forced smoke run) */
  reason?: string;
  errorKind?: string;
  archivedTo?: string;
}

export function readArchived(out: string): ArchivedAttempt[] {
  const p = join(out, 'aborted.jsonl');
  if (!existsSync(p)) return [];
  const rows: ArchivedAttempt[] = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as ArchivedAttempt;
      rows.push({ ...o, credits: Number(o.credits) || 0 });
    } catch {
      // a torn line: skip
    }
  }
  return rows;
}

/** Credits counted for the attempts archived in `<out>/aborted.jsonl`. */
export function abortedCredits(out: string): number {
  return readArchived(out).reduce((a, r) => a + r.credits, 0);
}

export interface BudgetTotals {
  /** What --max-credits is checked against: every current run (measured or estimated) plus archived attempts. */
  counted: number;
  /** Credits Kiro reported for the current runs (smoke runs included). */
  measured: number;
  /** Part of `counted` that comes from archived attempts. */
  archived: number;
  /** Part of `counted` that is an estimate (runs without a credit value, or cut short). */
  estimated: number;
}

export function budgetTotals(records: readonly RunRecord[], out: string, guess: number): BudgetTotals {
  let counted = 0;
  let measured = 0;
  let estimated = 0;
  for (const r of records) {
    const b = billed(r, estimateFor(records, r.arm, guess), typicalWallMs(records, r.arm));
    counted += b;
    measured += r.credits ?? 0;
    estimated += Math.max(0, b - (r.credits ?? 0));
  }
  const archived = abortedCredits(out);
  return { counted: counted + archived, measured, archived, estimated };
}
