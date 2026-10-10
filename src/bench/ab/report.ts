// `kopt bench ab report`: per task and overall, credits per arm, paired relative difference with a bootstrap 95% CI,
// sign test, correctness, kopt calls, and a plain-language verdict. Writes report.md, runs.csv, report.json.
//
// Pre-registered rules:
//  - only VALID runs are compared (exit 0, no error, credits > 0, an answer); invalid runs are listed, never dropped
//    silently;
//  - a pair = the same task and repetition in arm A and in the compared arm;
//  - main view: pairs both arms answered correctly (auto grade from the gold, or the manual_grade column); the
//    all-runs view is shown next to it;
//  - relative difference = sum(credits X) / sum(credits A) - 1 over the pairs; 95% CI by a two-stage bootstrap
//    (tasks, then pairs within a task), 10,000 resamples, fixed seed;
//  - decision rule: "worth rolling out" when the saving is >= 20%, the CI upper bound is below 0, the arm is cheaper
//    on more pairs than not, the evidence is large enough (5 tasks and 10 pairs, or a sign test below 0.05 over at
//    least 3 tasks), the arm's correctness is not lower than A's by more than one run, and it does not fail more
//    often than A (invalid runs that are the arm's own doing: timeouts, no answer, crashes, errors; they also count
//    as wrong answers in the correctness rule).

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BudgetTotals } from './budget.js';
import { clusterBootstrap, mean, median, relativeDiff, signTest, sum, type Pair } from './stats.js';
import { ARM_LABEL, OWN_FAULT_ERRORS, type Arm, type RunRecord } from './types.js';

export const SAVING_THRESHOLD = 0.2;
/** Evidence a conclusive verdict needs: MIN_TASKS tasks and MIN_PAIRS pairs, or a sign test below SIGN_ALPHA over MIN_TASKS_SIGN tasks. */
export const MIN_TASKS = 5;
export const MIN_PAIRS = 10;
export const SIGN_ALPHA = 0.05;
export const MIN_TASKS_SIGN = 3;

export interface ReportOptions {
  baseline?: Arm;
  bootstrap?: number;
  seed?: number;
  /** run id -> manual grade cell from a previous runs.csv */
  manualGrades?: Map<string, string>;
}

export function parseManualGrade(cell: string | undefined): boolean | undefined {
  const v = (cell ?? '').trim().toLowerCase();
  if (!v) return undefined;
  if (['1', 'y', 'yes', 'pass', 'passed', 'ok', 'true', 'correct', 'good'].includes(v)) return true;
  if (['0', 'n', 'no', 'fail', 'failed', 'false', 'wrong', 'incorrect', 'bad'].includes(v)) return false;
  return undefined;
}

/** Correctness of a VALID run: the manual grade first, else the automatic grade (undefined = not graded). */
export function correctness(r: RunRecord, manual?: Map<string, string>): boolean | undefined {
  const m = parseManualGrade(manual?.get(r.runId));
  if (m !== undefined) return m;
  return r.grade?.pass;
}

/** An invalid run that is the arm's own doing (timeout, no answer, crash, error): it counts as a wrong answer. */
export function ownFault(r: RunRecord): boolean {
  return !r.valid && !!r.errorKind && OWN_FAULT_ERRORS.has(r.errorKind);
}

export interface ArmSummary {
  arm: Arm;
  label: string;
  runs: number;
  valid: number;
  invalid: number;
  invalidReasons: Record<string, number>;
  creditsMedian?: number;
  creditsMean?: number;
  /** All credits measured for this arm, invalid runs included (what the campaign cost). */
  creditsSpent: number;
  /** Runs with a correctness value: graded valid runs, plus own-fault invalid runs of graded tasks (wrong). */
  graded: number;
  correct: number;
  correctRate?: number;
  /** Invalid runs that are the arm's own doing (timeouts, no answer, crashes, errors). */
  ownFaultInvalid: number;
  /** Runs that are valid or invalid by the arm's own doing (environment failures excluded). */
  attempted: number;
  wallMedianS?: number;
  toolCallsMedian?: number;
  requestsMedian?: number;
  koptCallsMedian?: number;
  koptZeroRuns: number;
}

export interface ViewResult {
  pairs: number;
  tasks: number;
  sumA: number;
  sumX: number;
  relDiff?: number;
  ci: [number | undefined, number | undefined];
  medianPairRelDiff?: number;
  xCheaper: number;
  aCheaper: number;
  ties: number;
  signP?: number;
}

export type VerdictCode =
  | 'worth_rolling_out'
  | 'promising'
  | 'mixed'
  | 'inconclusive'
  | 'no_saving'
  | 'costs_more'
  | 'correctness_drop'
  | 'reliability_drop'
  | 'insufficient_data';

export interface Comparison {
  arm: Arm;
  allRuns: ViewResult;
  bothCorrect: ViewResult;
  mainView: 'bothCorrect' | 'allRuns';
  correctnessOk?: boolean;
  /** The arm does not fail (own-fault invalid runs) more often than the baseline, one run of slack. */
  reliabilityOk: boolean;
  /** The main view has enough evidence for a conclusive verdict. */
  conclusive: boolean;
  verdict: string;
  verdictCode: VerdictCode;
}

export interface TaskRow {
  task: string;
  kind: string;
  arms: Record<string, { runs: number; valid: number; median?: number; mean?: number; correct: number; graded: number; koptCalls?: number }>;
  relDiff: Record<string, number | undefined>;
}

export interface AbReport {
  generatedAt: string;
  baseline: Arm;
  arms: ArmSummary[];
  comparisons: Comparison[];
  tasks: TaskRow[];
  invalidRuns: Array<{ runId: string; arm: Arm; reason: string; detail?: string }>;
  /** Tasks none of whose valid runs has a correctness value (no gold, no manual grade): outside the main view. */
  ungradedTasks: string[];
  flaggedKoptRuns: string[];
  creditMismatches: string[];
  /** Runs that changed files of the worktree (reverted before the next run). */
  dirtyRuns: string[];
  graded: boolean;
  /** Credits Kiro reported for the runs of this report (smoke runs and invalid runs included). */
  totalSpent: number;
  /** What the campaign counted against --max-credits (estimates and archived attempts included), when known. */
  budget?: BudgetTotals;
  /** Notes about the report files themselves (an unreadable runs.csv, a locked file). */
  fileNotes: string[];
  meta?: Record<string, unknown>;
}

function view(pairs: Pair[], boot: number, seed: number): ViewResult {
  const rel = relativeDiff(pairs);
  const xCheaper = pairs.filter((p) => p.b < p.a).length;
  const aCheaper = pairs.filter((p) => p.b > p.a).length;
  return {
    pairs: pairs.length,
    tasks: new Set(pairs.map((p) => p.task)).size,
    sumA: sum(pairs.map((p) => p.a)),
    sumX: sum(pairs.map((p) => p.b)),
    relDiff: rel,
    ci: clusterBootstrap(pairs, relativeDiff, boot, seed),
    medianPairRelDiff: median(pairs.filter((p) => p.a > 0).map((p) => p.b / p.a - 1)),
    xCheaper,
    aCheaper,
    ties: pairs.length - xCheaper - aCheaper,
    signP: signTest(xCheaper, xCheaper + aCheaper),
  };
}

const pct = (x: number | undefined, digits = 0) => (x === undefined || !Number.isFinite(x) ? 'n/a' : `${(x * 100).toFixed(digits)}%`);
const signedPct = (x: number | undefined) => (x === undefined || !Number.isFinite(x) ? 'n/a' : `${x > 0 ? '+' : ''}${(x * 100).toFixed(1)}%`);
const f = (x: number | undefined, d = 3) => (x === undefined || !Number.isFinite(x) ? 'n/a' : x.toFixed(d));

/** Enough evidence for a conclusive verdict: MIN_TASKS tasks and MIN_PAIRS pairs, or a sign test below SIGN_ALPHA over MIN_TASKS_SIGN tasks. */
export function enoughEvidence(v: ViewResult): boolean {
  if (v.tasks >= MIN_TASKS && v.pairs >= MIN_PAIRS) return true;
  return v.tasks >= MIN_TASKS_SIGN && v.signP !== undefined && v.signP < SIGN_ALPHA;
}

const evidenceNote = (v: ViewResult) =>
  `${v.pairs} pair(s) over ${v.tasks} task(s) are not enough for a conclusive verdict (it needs ${MIN_TASKS} tasks and ${MIN_PAIRS} pairs, or a sign test below ${SIGN_ALPHA} over at least ${MIN_TASKS_SIGN} tasks; here p = ${f(v.signP, 3)})`;

function decide(c: Omit<Comparison, 'verdict' | 'verdictCode' | 'conclusive'>, graded: boolean, sx: ArmSummary, sa: ArmSummary, ungraded: string[]): Pick<Comparison, 'verdict' | 'verdictCode' | 'conclusive'> {
  const v = c[c.mainView];
  const label = `arm ${c.arm}`;
  const conclusive = enoughEvidence(v);
  if (c.correctnessOk === false) {
    const all = c.allRuns;
    return {
      conclusive,
      verdictCode: 'correctness_drop',
      verdict: `Not worth rolling out: ${label} answers correctly less often than stock Kiro (${sx.correct}/${sx.graded} vs ${sa.correct}/${sa.graded}, own-fault invalid runs counted as wrong; all valid runs: ${signedPct(all.relDiff)} credits over ${all.pairs} pairs).`,
    };
  }
  if (!c.reliabilityOk) {
    return {
      conclusive,
      verdictCode: 'reliability_drop',
      verdict: `Not worth rolling out: ${label} fails more often than stock Kiro (${sx.ownFaultInvalid} of ${sx.attempted} runs invalid by its own doing: timeouts, no answer, crashes or errors; stock Kiro ${sa.ownFaultInvalid} of ${sa.attempted}).`,
    };
  }
  const grading = graded
    ? ungraded.length && c.mainView === 'bothCorrect'
      ? ` ${ungraded.length} task(s) without a gold or a manual grade are not in this view: ${ungraded.join(', ')}.`
      : ''
    : ' Answers were not graded (no gold, no manual_grade): correctness is unknown, fill the manual_grade column of runs.csv and re-run `kopt bench ab report`.';
  if (v.pairs < 3 || v.relDiff === undefined) {
    return { conclusive: false, verdictCode: 'insufficient_data', verdict: `Insufficient data: ${v.pairs} usable pair(s) for ${label} (at least 3 are needed; add tasks or repetitions).${grading}` };
  }
  const saving = -v.relDiff;
  const [lo, hi] = v.ci;
  const range = `${signedPct(v.relDiff)} credits (95% CI ${signedPct(lo)} to ${signedPct(hi)}, ${v.pairs} pairs over ${v.tasks} task(s), cheaper on ${v.xCheaper}, dearer on ${v.aCheaper})`;
  if (lo !== undefined && lo > 0) {
    return conclusive
      ? { conclusive, verdictCode: 'costs_more', verdict: `Not worth rolling out: ${label} costs MORE than stock Kiro: ${range}.${grading}` }
      : { conclusive, verdictCode: 'inconclusive', verdict: `Not conclusive: ${label} cost more than stock Kiro on these runs (${range}), but ${evidenceNote(v)}.${grading}` };
  }
  if (saving >= SAVING_THRESHOLD) {
    // the total can come from one large task: the pairs must lean the same way
    const leaning = v.xCheaper >= v.aCheaper && (v.medianPairRelDiff ?? 0) < 0;
    if (!leaning) {
      return {
        conclusive: false,
        verdictCode: 'mixed',
        verdict: `Not conclusive: ${label} costs ${signedPct(v.relDiff)} in total, but it is cheaper on only ${v.xCheaper} of ${v.pairs} pairs (median per-pair difference ${signedPct(v.medianPairRelDiff)}): a few tasks carry the total. ${range}.${grading}`,
      };
    }
    if (hi !== undefined && hi < 0 && v.xCheaper > v.aCheaper && conclusive) {
      return { conclusive, verdictCode: 'worth_rolling_out', verdict: `Worth rolling out: ${label} saves ${pct(saving, 1)} of the credits at equal correctness: ${range}.${grading}` };
    }
    const why = [hi === undefined || hi >= 0 ? 'the 95% CI still includes no saving' : '', conclusive ? '' : evidenceNote(v)].filter(Boolean).join('; and ');
    return {
      conclusive: false,
      verdictCode: 'promising',
      verdict: `Promising but not conclusive: ${label} saves ${pct(saving, 1)} on these runs, but ${why}: ${range}. Run more repetitions or tasks.${grading}`,
    };
  }
  if (!conclusive) {
    return { conclusive, verdictCode: 'inconclusive', verdict: `Not conclusive: the saving is below ${pct(SAVING_THRESHOLD)} on these runs (${range}), and ${evidenceNote(v)}.${grading}` };
  }
  return { conclusive, verdictCode: 'no_saving', verdict: `Not worth rolling out: the saving is below ${pct(SAVING_THRESHOLD)}: ${range}.${grading}` };
}

export function analyzeRuns(all: RunRecord[], arms: Arm[], o: ReportOptions = {}): AbReport {
  const baseline = o.baseline ?? 'A';
  const boot = o.bootstrap ?? 10000;
  const seed = o.seed ?? 7;
  const manual = o.manualGrades;
  const records = all.filter((r) => !r.smoke);
  const correct = (r: RunRecord) => correctness(r, manual);
  const graded = records.some((r) => r.valid && correct(r) !== undefined);
  const gradedTask = new Set(records.filter((r) => correct(r) !== undefined).map((r) => r.task));
  /** Correctness for the correctness rule: valid runs as graded; own-fault invalid runs of a graded task are wrong. */
  const outcome = (r: RunRecord): boolean | undefined => {
    const m = parseManualGrade(manual?.get(r.runId));
    if (m !== undefined) return m;
    if (r.valid) return r.grade?.pass;
    return ownFault(r) && (r.grade !== undefined || gradedTask.has(r.task)) ? false : undefined;
  };

  const armSummaries: ArmSummary[] = arms.map((arm) => {
    const rs = records.filter((r) => r.arm === arm);
    const valid = rs.filter((r) => r.valid);
    const credits = valid.map((r) => r.credits!).filter((x) => x !== undefined);
    const gradedRuns = rs.filter((r) => outcome(r) !== undefined);
    const reasons: Record<string, number> = {};
    for (const r of rs.filter((x) => !x.valid)) reasons[r.invalidReason ?? 'unknown'] = (reasons[r.invalidReason ?? 'unknown'] ?? 0) + 1;
    const kopt = arm !== baseline && valid.some((r) => r.koptCalls > 0 || r.koptFlag);
    const own = rs.filter(ownFault).length;
    return {
      arm,
      label: ARM_LABEL[arm],
      runs: rs.length,
      valid: valid.length,
      invalid: rs.length - valid.length,
      invalidReasons: reasons,
      creditsMedian: median(credits),
      creditsMean: mean(credits),
      creditsSpent: sum(rs.map((r) => r.credits ?? 0)),
      graded: gradedRuns.length,
      correct: gradedRuns.filter((r) => outcome(r)).length,
      correctRate: gradedRuns.length ? gradedRuns.filter((r) => outcome(r)).length / gradedRuns.length : undefined,
      ownFaultInvalid: own,
      attempted: valid.length + own,
      wallMedianS: median(valid.map((r) => r.wallMs / 1000)),
      toolCallsMedian: median(valid.map((r) => r.toolCalls)),
      requestsMedian: median(valid.map((r) => r.requests).filter((x): x is number => x !== undefined)),
      koptCallsMedian: kopt || arm !== baseline ? median(valid.map((r) => r.koptCalls)) : undefined,
      koptZeroRuns: arm === baseline ? 0 : valid.filter((r) => r.koptCalls === 0).length,
    };
  });

  const ungradedTasks = [...new Set(records.map((r) => r.task))].filter((t) => !records.some((r) => r.task === t && r.valid && correct(r) !== undefined)).sort();
  const key = (r: RunRecord) => `${r.task}\u0000${r.rep}`;
  const baseRuns = new Map(records.filter((r) => r.arm === baseline && r.valid).map((r) => [key(r), r]));
  const comparisons: Comparison[] = [];
  for (const arm of arms.filter((a) => a !== baseline)) {
    const pairsAll: Pair[] = [];
    const pairsCorrect: Pair[] = [];
    for (const r of records.filter((x) => x.arm === arm && x.valid)) {
      const a = baseRuns.get(key(r));
      if (!a || a.credits === undefined || r.credits === undefined) continue;
      const p = { task: r.task, a: a.credits, b: r.credits };
      pairsAll.push(p);
      if (correct(a) === true && correct(r) === true) pairsCorrect.push(p);
    }
    const sa = armSummaries.find((s) => s.arm === baseline)!;
    const sx = armSummaries.find((s) => s.arm === arm)!;
    let correctnessOk: boolean | undefined;
    if (sa.graded && sx.graded) {
      const slack = 1 / Math.max(sa.graded, sx.graded);
      correctnessOk = (sx.correctRate ?? 0) >= (sa.correctRate ?? 0) - slack - 1e-9;
    }
    // invalid runs of the arm's own doing must not be more frequent than in the baseline (one run of slack)
    const rate = (s: ArmSummary) => (s.attempted ? s.ownFaultInvalid / s.attempted : 0);
    const reliabilityOk = rate(sx) <= rate(sa) + 1 / Math.max(1, sa.attempted, sx.attempted) + 1e-9;
    const base = {
      arm,
      allRuns: view(pairsAll, boot, seed),
      bothCorrect: view(pairsCorrect, boot, seed + 1),
      mainView: (graded ? 'bothCorrect' : 'allRuns') as Comparison['mainView'],
      correctnessOk,
      reliabilityOk,
    };
    comparisons.push({ ...base, ...decide(base, graded, sx, sa, ungradedTasks) });
  }

  const taskIds = [...new Set(records.map((r) => r.task))].sort();
  const tasks: TaskRow[] = taskIds.map((task) => {
    const rs = records.filter((r) => r.task === task);
    const row: TaskRow = { task, kind: rs[0]?.kind ?? '', arms: {}, relDiff: {} };
    for (const arm of arms) {
      const ar = rs.filter((r) => r.arm === arm);
      const valid = ar.filter((r) => r.valid);
      const cr = valid.map((r) => r.credits!).filter((x) => x !== undefined);
      const g = valid.filter((r) => correct(r) !== undefined);
      row.arms[arm] = {
        runs: ar.length,
        valid: valid.length,
        median: median(cr),
        mean: mean(cr),
        correct: g.filter((r) => correct(r)).length,
        graded: g.length,
        ...(arm !== baseline ? { koptCalls: mean(valid.map((r) => r.koptCalls)) } : {}),
      };
    }
    const ma = row.arms[baseline]?.median;
    for (const arm of arms.filter((a) => a !== baseline)) {
      const mx = row.arms[arm]?.median;
      row.relDiff[arm] = ma && mx !== undefined ? mx / ma - 1 : undefined;
    }
    return row;
  });

  return {
    generatedAt: new Date().toISOString(),
    baseline,
    arms: armSummaries,
    comparisons,
    tasks,
    invalidRuns: records.filter((r) => !r.valid).map((r) => ({ runId: r.runId, arm: r.arm, reason: r.invalidReason ?? 'unknown', detail: r.errorDetail })),
    ungradedTasks: graded ? ungradedTasks : [],
    flaggedKoptRuns: records.filter((r) => r.koptFlag).map((r) => r.runId),
    creditMismatches: records.filter((r) => r.creditsMismatch).map((r) => r.runId),
    dirtyRuns: records.filter((r) => r.dirtyAfter).map((r) => r.runId),
    graded,
    totalSpent: sum(all.map((r) => r.credits ?? 0)),
    fileNotes: [],
  };
}

export function renderReportMarkdown(rep: AbReport): string {
  const out: string[] = [];
  const meta = rep.meta ?? {};
  out.push('# kopt online A/B: real Kiro credits', '');
  const facts = [
    meta.repo ? `repo \`${meta.repo}\`${meta.commit ? ` @ ${String(meta.commit).slice(0, 12)}` : ''}` : undefined,
    meta.model ? `model \`${meta.model}\`` : undefined,
    meta.engine ? `engine ${meta.engine}` : undefined,
    meta.kiroVersion ? `${meta.kiroVersion}` : undefined,
    meta.reps ? `${meta.reps} repetition(s)` : undefined,
    `${pct(SAVING_THRESHOLD)} saving threshold`,
  ].filter(Boolean);
  out.push(facts.join(' · '), '');
  out.push('## Verdict', '');
  for (const c of rep.comparisons) out.push(`- **${c.verdict}**`);
  if (!rep.comparisons.length) out.push('- Only one arm: nothing to compare.');
  out.push('');
  out.push(
    'Decision rule (fixed before the runs): an arm is worth rolling out when it saves at least 20% of the credits on ' +
      'pairs both arms answered correctly, the 95% CI of that saving excludes 0, it is cheaper on more pairs than not, ' +
      `the evidence is large enough (${MIN_TASKS} tasks and ${MIN_PAIRS} pairs, or a sign test below ${SIGN_ALPHA} over at least ${MIN_TASKS_SIGN} tasks), ` +
      "its correctness is not lower than stock Kiro's by more than one run, and it does not fail more often (timeouts, " +
      'no answer, crashes and errors count as wrong answers and as failures). Negative differences mean fewer credits than arm A.',
    '',
  );

  out.push('## Arms', '');
  out.push('| arm | runs | valid | own-fault invalid | median credits | mean credits | credits spent | correct | median wall s | median tool calls | median kopt calls | runs with 0 kopt calls |');
  out.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const s of rep.arms) {
    out.push(
      `| ${s.arm}: ${s.label} | ${s.runs} | ${s.valid} | ${s.ownFaultInvalid} | ${f(s.creditsMedian)} | ${f(s.creditsMean)} | ${f(s.creditsSpent, 2)} | ${s.graded ? `${s.correct}/${s.graded} (${pct(s.correctRate)})` : 'not graded'} | ${f(s.wallMedianS, 0)} | ${f(s.toolCallsMedian, 1)} | ${s.arm === rep.baseline ? '-' : f(s.koptCallsMedian, 1)} | ${s.arm === rep.baseline ? '-' : s.koptZeroRuns} |`,
    );
  }
  out.push('');

  for (const c of rep.comparisons) {
    out.push(`## Arm ${c.arm} vs arm ${rep.baseline}`, '');
    out.push('| view | pairs | tasks | credits A | credits ' + c.arm + ' | relative difference | 95% CI | median per-pair difference | ' + c.arm + ' cheaper / A cheaper / ties | sign test p |');
    out.push('|---|---|---|---|---|---|---|---|---|---|');
    for (const [name, v] of [['both answered correctly', c.bothCorrect], ['all valid runs', c.allRuns]] as const) {
      out.push(
        `| ${name}${(name === 'both answered correctly') === (c.mainView === 'bothCorrect') ? ' (main)' : ''} | ${v.pairs} | ${v.tasks} | ${f(v.sumA, 2)} | ${f(v.sumX, 2)} | ${signedPct(v.relDiff)} | ${signedPct(v.ci[0])} .. ${signedPct(v.ci[1])} | ${signedPct(v.medianPairRelDiff)} | ${v.xCheaper} / ${v.aCheaper} / ${v.ties} | ${f(v.signP, 3)} |`,
      );
    }
    out.push('');
  }

  out.push('## Per task (valid runs)', '');
  const arms = rep.arms.map((s) => s.arm);
  out.push(`| task | kind | ${arms.map((a) => `${a} median credits | ${a} correct`).join(' | ')} | ${arms.filter((a) => a !== rep.baseline).map((a) => `${a} vs ${rep.baseline} | ${a} kopt calls/run`).join(' | ')} |`);
  out.push(`|---|---|${arms.map(() => '---|---|').join('')}${arms.filter((a) => a !== rep.baseline).map(() => '---|---|').join('')}`);
  for (const t of rep.tasks) {
    const cells = arms.map((a) => {
      const x = t.arms[a];
      return `${f(x?.median)} (${x?.valid ?? 0}/${x?.runs ?? 0}) | ${x?.graded ? `${x.correct}/${x.graded}` : '-'}`;
    });
    const rel = arms.filter((a) => a !== rep.baseline).map((a) => `${signedPct(t.relDiff[a])} | ${f(t.arms[a]?.koptCalls, 1)}`);
    out.push(`| ${t.task} | ${t.kind || '-'} | ${cells.join(' | ')} | ${rel.join(' | ')} |`);
  }
  out.push('');

  out.push('## Data quality', '');
  const b = rep.budget;
  out.push(
    b
      ? `- Credits: ${f(b.counted, 3)} counted against --max-credits, the same total the console prints: ${f(b.measured, 3)} measured by Kiro on the runs of this report (smoke runs and invalid runs included), ${f(b.estimated, 3)} estimated for runs Kiro reported no credit for or that were cut short, ${f(b.archived, 3)} for archived attempts (aborted, retried or superseded runs: aborted.jsonl, attempts/).`
      : `- Credits measured by Kiro on these runs (smoke runs and invalid runs included): ${f(rep.totalSpent, 3)}.`,
  );
  for (const n of rep.fileNotes) out.push(`- ${n}`);
  if (rep.ungradedTasks.length) {
    out.push(`- ${rep.ungradedTasks.length} task(s) have no gold and no manual grade, so they are left out of the main view (both answered correctly): ${rep.ungradedTasks.map((t) => `\`${t}\``).join(', ')}. Grade their runs in the manual_grade column of runs.csv (1 = correct, 0 = wrong), then re-run \`kopt bench ab report\`.`);
  }
  if (rep.invalidRuns.length) {
    out.push(`- ${rep.invalidRuns.length} invalid run(s), excluded from the comparison:`);
    for (const r of rep.invalidRuns) out.push(`  - \`${r.runId}\` (arm ${r.arm}): ${r.reason}${r.detail ? `: ${r.detail.replace(/\|/g, '/')}` : ''}`);
  } else out.push('- No invalid run.');
  if (rep.flaggedKoptRuns.length) out.push(`- ${rep.flaggedKoptRuns.length} kopt-arm run(s) never called a kopt tool: ${rep.flaggedKoptRuns.map((r) => `\`${r}\``).join(', ')}.`);
  if (rep.creditMismatches.length) out.push(`- Stream and session credits differ by more than 5% in: ${rep.creditMismatches.map((r) => `\`${r}\``).join(', ')} (the session value is used).`);
  if (rep.dirtyRuns.length) out.push(`- ${rep.dirtyRuns.length} run(s) changed files of their worktree (reverted before the next run; see exit.json): ${rep.dirtyRuns.map((r) => `\`${r}\``).join(', ')}.`);
  if (!rep.graded) out.push('- No answer is graded: give tasks a `gold`, or fill the `manual_grade` column of runs.csv (1 = correct, 0 = wrong) and re-run `kopt bench ab report`.');
  out.push('');
  out.push('## How to read this', '');
  out.push(
    '- Credits vary from run to run even with the same prompt and model (sampling, tool choices, backend routing). ' +
      'A single pair proves nothing; the CI shows how much the result could move with other runs of the same tasks.',
    '- A wide CI that crosses 0 means "not enough evidence", not "no effect": add repetitions (`--reps`) or tasks.',
    '- A saving on runs both arms got right is the honest number: a cheap wrong answer is not a saving.',
  );
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------------------
// CSV

export const CSV_COLUMNS = [
  'run_id', 'task', 'kind', 'arm', 'rep', 'order', 'smoke', 'engine', 'model', 'started_at', 'status', 'invalid_reason', 'error_kind',
  'error_detail', 'exit_code', 'timed_out', 'wall_s', 'credits', 'credits_source', 'credits_stream', 'credits_session', 'credits_mismatch',
  'turns', 'requests', 'tool_calls', 'tools_by_name', 'kopt_calls', 'kopt_calls_stream', 'kopt_calls_telemetry', 'kopt_hook_events',
  'kopt_flag', 'ctx_pct_max', 'answer_chars', 'answer_source', 'auto_grade', 'gold_symbols', 'gold_files', 'missing', 'manual_grade',
  'answer_file', 'dirty_after', 'warnings',
] as const;

function cell(v: unknown): string {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function recordToRow(r: RunRecord, manual?: Map<string, string>): Record<(typeof CSV_COLUMNS)[number], unknown> {
  return {
    run_id: r.runId,
    task: r.task,
    kind: r.kind,
    arm: r.arm,
    rep: r.rep,
    order: r.order,
    smoke: r.smoke ? 1 : 0,
    engine: r.engine,
    model: r.model,
    started_at: r.startedAt,
    status: r.valid ? 'valid' : 'invalid',
    invalid_reason: r.invalidReason,
    error_kind: r.errorKind,
    error_detail: r.errorDetail,
    exit_code: r.exitCode,
    timed_out: r.timedOut ? 1 : 0,
    wall_s: (r.wallMs / 1000).toFixed(1),
    credits: r.credits,
    credits_source: r.creditsSource,
    credits_stream: r.creditsStream,
    credits_session: r.creditsSession,
    credits_mismatch: r.creditsMismatch ? 1 : 0,
    turns: r.turns,
    requests: r.requests,
    tool_calls: r.toolCalls,
    tools_by_name: Object.entries(r.toolsByName).map(([k, v]) => `${k}:${v}`).join(' '),
    kopt_calls: r.koptCalls,
    kopt_calls_stream: r.koptCallsStream,
    kopt_calls_telemetry: r.koptCallsTelemetry,
    kopt_hook_events: r.koptHookEvents,
    kopt_flag: r.koptFlag,
    ctx_pct_max: r.ctxPctMax,
    answer_chars: r.answerChars,
    answer_source: r.answerSource,
    auto_grade: r.grade ? (r.grade.pass ? 'pass' : 'fail') : '',
    gold_symbols: r.grade ? `${r.grade.symbolsFound}/${r.grade.symbolsTotal}` : '',
    gold_files: r.grade ? `${r.grade.filesFound}/${r.grade.filesTotal}` : '',
    missing: r.grade ? [...r.grade.missingSymbols, ...r.grade.missingFiles].join(' ') : '',
    manual_grade: manual?.get(r.runId) ?? '',
    answer_file: r.smoke ? `smoke/${r.arm}/answer.md` : `runs/${r.runId}/answer.md`,
    dirty_after: r.dirtyAfter ? 1 : 0,
    warnings: r.warnings.join(' | '),
  };
}

export function toCsv(records: RunRecord[], manual?: Map<string, string>): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of records) {
    const row = recordToRow(r, manual);
    lines.push(CSV_COLUMNS.map((c) => cell(row[c])).join(','));
  }
  return lines.join('\n') + '\n';
}

/**
 * Delimiter of a CSV text: an Excel `sep=X` first line, else whichever of `,` `;` and tab is most frequent outside
 * quotes in the header line (Excel saves CSV with `;` in locales that use a decimal comma).
 */
export function detectDelimiter(text: string): string {
  const t = text.replace(/^\uFEFF/, '');
  const first = t.split(/\r?\n/, 1)[0] ?? '';
  const sep = /^sep=(.)\s*$/i.exec(first);
  if (sep) return sep[1];
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let q = false;
  for (const ch of first) {
    if (ch === '"') q = !q;
    else if (!q && ch in counts) counts[ch]++;
  }
  const [best, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return n > 0 ? best : ',';
}

/** RFC 4180 reader (quoted cells may hold delimiters, quotes and newlines); the delimiter is detected by default. */
export function readCsv(text: string, delimiter?: string): Array<Record<string, string>> {
  const d = delimiter ?? detectDelimiter(text);
  text = text.replace(/^\uFEFF/, '').replace(/^sep=.\s*\r?\n/i, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let c = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        c += '"';
        i++;
      } else if (ch === '"') q = false;
      else c += ch;
    } else if (ch === '"') q = true;
    else if (ch === d) {
      row.push(c);
      c = '';
    } else if (ch === '\n') {
      row.push(c);
      rows.push(row);
      row = [];
      c = '';
    } else if (ch !== '\r') c += ch;
  }
  if (c || row.length) {
    row.push(c);
    rows.push(row);
  }
  const [head, ...body] = rows.filter((r) => r.length > 1 || r[0]);
  if (!head) return [];
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.replace(/^﻿/, ''), r[i] ?? ''])));
}

export interface CsvGrades {
  /** run id -> manual_grade cell (non-empty cells only) */
  grades: Map<string, string>;
  /** run ids the file lists (its manual_grade column is authoritative for them, blank = no grade) */
  rows: Set<string>;
  /** the file has run_id and manual_grade columns */
  readable: boolean;
}

/** manual_grade cells of an existing runs.csv, whatever delimiter it was saved with. */
export function readCsvGrades(csvPath: string): CsvGrades {
  const out: CsvGrades = { grades: new Map(), rows: new Set(), readable: false };
  if (!existsSync(csvPath)) return out;
  try {
    const rows = readCsv(readFileSync(csvPath, 'utf8'));
    if (!rows.length || !('run_id' in rows[0]) || !('manual_grade' in rows[0])) return out;
    out.readable = true;
    for (const r of rows) {
      if (!r.run_id) continue;
      out.rows.add(r.run_id);
      if (r.manual_grade?.trim()) out.grades.set(r.run_id, r.manual_grade.trim());
    }
  } catch {
    // unreadable
  }
  return out;
}

/** manual_grade cells of an existing runs.csv (kept when the report is regenerated). */
export function readManualGrades(csvPath: string): Map<string, string> {
  return readCsvGrades(csvPath).grades;
}

const GRADES_FILE = 'manual-grades.json';

/**
 * Manual grades, kept in two places: runs.csv (where people type them) and manual-grades.json (a copy the harness
 * owns). runs.csv wins for the runs it lists; when it cannot be read (saved by a spreadsheet in an unexpected shape),
 * the copy keeps every grade.
 */
export function mergeManualGrades(outDir: string, notes: string[]): Map<string, string> {
  const csvPath = join(outDir, 'runs.csv');
  const storePath = join(outDir, GRADES_FILE);
  let stored: Record<string, string> = {};
  try {
    stored = existsSync(storePath) ? (JSON.parse(readFileSync(storePath, 'utf8')) as Record<string, string>) : {};
  } catch {
    stored = {};
  }
  const grades = new Map(Object.entries(stored).filter(([, v]) => typeof v === 'string' && v.trim()));
  const csv = readCsvGrades(csvPath);
  if (csv.readable) {
    for (const id of csv.rows) {
      const g = csv.grades.get(id);
      if (g) grades.set(id, g);
      else grades.delete(id);
    }
  } else if (existsSync(csvPath)) {
    notes.push(`runs.csv could not be read (no run_id and manual_grade columns); the manual grades come from ${GRADES_FILE}, and the old file is kept as runs.csv.bak`);
  }
  try {
    if (grades.size || existsSync(storePath)) writeFileSync(storePath, JSON.stringify(Object.fromEntries([...grades].sort()), null, 2) + '\n');
  } catch (err) {
    notes.push(`could not save ${GRADES_FILE}: ${(err as Error).message}`);
  }
  return grades;
}

/** Write a report file; a file held open by another program (Excel on Windows: EBUSY) is written next to it instead. */
function writeFileOrAside(path: string, text: string, notes: string[]): string {
  try {
    writeFileSync(path, text);
    return path;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES') throw err;
    const aside = path.replace(/(\.\w+)$/, `-${new Date().toISOString().replace(/[:.]/g, '-')}$1`);
    writeFileSync(aside, text);
    notes.push(`${path} is open in another program (${code}): this version was written to ${aside}`);
    return aside;
  }
}

export function writeReport(outDir: string, records: RunRecord[], arms: Arm[], meta: Record<string, unknown>, o: ReportOptions = {}): { report: AbReport; files: string[]; notes: string[] } {
  const notes: string[] = [];
  const csvPath = join(outDir, 'runs.csv');
  const manual = o.manualGrades ?? mergeManualGrades(outDir, notes);
  const report = analyzeRuns(records, arms, { ...o, manualGrades: manual });
  report.meta = meta;
  if (meta.budget && typeof meta.budget === 'object') report.budget = meta.budget as BudgetTotals;
  const ordered = [...records].sort((a, b) => Number(b.smoke) - Number(a.smoke) || a.idx - b.idx);
  // the previous runs.csv (possibly edited by hand) is kept as runs.csv.bak
  if (existsSync(csvPath)) {
    try {
      copyFileSync(csvPath, `${csvPath}.bak`);
    } catch {
      // best effort
    }
  }
  const csvFile = writeFileOrAside(csvPath, toCsv(ordered, manual), notes);
  report.fileNotes = notes;
  const jsonFile = writeFileOrAside(join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n', notes);
  const mdFile = writeFileOrAside(join(outDir, 'report.md'), renderReportMarkdown(report), notes);
  return { report, files: [mdFile, csvFile, jsonFile], notes };
}
