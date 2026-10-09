#!/usr/bin/env node
// Paired, pass-gated analysis of the kiro-cli A/B runs (CSV from `ab-lib.mjs parse`). No dependencies.
//
//   node analyze.mjs runs.csv [--a A] [--b B] [--metric credits] [--boot 10000] [--seed 7]
//                             [--exclude-memorized] [--json out.json]
//
// Rules (pre-registered, after SDLBench): every attempt is kept (no best-of); per task and arm the median over
// repetitions; a task "passes" for an arm when >= half of its runs pass the grading; savings are compared ONLY
// on tasks passed by both arms; 95% CIs by bootstrap over tasks; a saving is claimed only when the CI of the
// mean paired difference is entirely below 0 AND arm B solves at least as many tasks as arm A minus one.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { mulberry32 } from './ab-lib.mjs';

export function readCsv(text) {
  const rows = [];
  const lines = [];
  // minimal RFC4180 parser (quoted cells may contain commas, quotes and newlines)
  let cell = '';
  let row = [];
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell);
      lines.push(row);
      row = [];
      cell = '';
    } else if (c !== '\r') cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    lines.push(row);
  }
  const [head, ...body] = lines.filter((l) => l.length > 1 || l[0]);
  for (const l of body) rows.push(Object.fromEntries(head.map((h, i) => [h, l[i] ?? ''])));
  return rows;
}

const toNum = (v) => (v === '' || v === undefined || v === null ? undefined : Number.isFinite(Number(v)) ? Number(v) : undefined);

export function median(xs) {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined;
}

/** Percentile bootstrap CI of `stat` over resampled `values` (resampling unit = task). */
export function bootstrapCI(values, stat, iterations = 10000, seed = 7, alpha = 0.05) {
  if (values.length < 2) return [undefined, undefined];
  const rnd = mulberry32(seed);
  const stats = [];
  for (let b = 0; b < iterations; b++) {
    const sample = Array.from({ length: values.length }, () => values[Math.floor(rnd() * values.length)]);
    const s = stat(sample);
    if (s !== undefined && Number.isFinite(s)) stats.push(s);
  }
  stats.sort((a, b) => a - b);
  const at = (p) => stats[Math.min(stats.length - 1, Math.max(0, Math.floor(p * stats.length)))];
  return [at(alpha / 2), at(1 - alpha / 2)];
}

/** Exact two-sided sign test p-value for `k` successes out of `n`. */
export function signTest(k, n) {
  if (!n) return undefined;
  const logC = (n2, r) => {
    let s = 0;
    for (let i = 1; i <= r; i++) s += Math.log(n2 - r + i) - Math.log(i);
    return s;
  };
  const tail = (lo) => {
    let p = 0;
    for (let i = lo; i <= n; i++) p += Math.exp(logC(n, i) - n * Math.LN2);
    return p;
  };
  const extreme = Math.max(k, n - k);
  return Math.min(1, 2 * tail(extreme));
}

export function analyze(rows, opts = {}) {
  const A = opts.a ?? 'A';
  const B = opts.b ?? 'B';
  const metric = opts.metric ?? 'credits';
  const iterations = opts.boot ?? 10000;
  const seed = opts.seed ?? 7;

  const byTask = new Map();
  for (const r of rows) {
    const t = byTask.get(r.task) ?? { task: r.task, kind: r.kind, arms: {} };
    (t.arms[r.arm] ??= []).push(r);
    byTask.set(r.task, t);
  }

  const memorized = [];
  if (rows.some((r) => r.arm === 'M')) {
    for (const t of byTask.values()) {
      const m = t.arms.M ?? [];
      if (m.length && m.filter((r) => r.pass === '1').length / m.length >= 0.5) memorized.push(t.task);
    }
  }

  const armSummary = (arm) => {
    const rs = rows.filter((r) => r.arm === arm);
    const passes = rs.filter((r) => r.pass === '1').length;
    const vals = rs.map((r) => toNum(r[metric])).filter((x) => x !== undefined);
    const total = vals.reduce((a, b) => a + b, 0);
    const tasksPassed = [...byTask.values()].filter((t) => {
      const x = t.arms[arm] ?? [];
      return x.length && x.filter((r) => r.pass === '1').length / x.length >= 0.5;
    }).length;
    return {
      arm,
      runs: rs.length,
      runsWithMetric: vals.length,
      passRate: rs.length ? passes / rs.length : undefined,
      tasksPassed,
      totalMetric: total,
      medianMetric: median(vals),
      costPerPassingRun: passes ? total / passes : undefined,
      medianRequests: median(rs.map((r) => toNum(r.requests)).filter((x) => x !== undefined)),
      medianToolCalls: median(rs.map((r) => toNum(r.tool_calls)).filter((x) => x !== undefined)),
      medianWallS: median(rs.map((r) => toNum(r.wall_s)).filter((x) => x !== undefined)),
      failedExits: rs.filter((r) => r.exit_code !== '' && r.exit_code !== '0').length,
    };
  };

  const perTask = [];
  for (const t of byTask.values()) {
    const a = t.arms[A] ?? [];
    const b = t.arms[B] ?? [];
    const rate = (x) => (x.length ? x.filter((r) => r.pass === '1').length / x.length : 0);
    const med = (x) => median(x.map((r) => toNum(r[metric])).filter((v) => v !== undefined));
    perTask.push({
      task: t.task,
      kind: t.kind,
      runsA: a.length,
      runsB: b.length,
      passA: rate(a),
      passB: rate(b),
      medA: med(a),
      medB: med(b),
      memorized: memorized.includes(t.task),
    });
  }
  perTask.sort((x, y) => (x.task < y.task ? -1 : 1));

  const joint = perTask.filter(
    (t) => t.passA >= 0.5 && t.passB >= 0.5 && t.medA !== undefined && t.medB !== undefined && !(opts.excludeMemorized && t.memorized),
  );
  const diffs = joint.map((t) => t.medB - t.medA);
  const logRatios = joint.filter((t) => t.medA > 0 && t.medB > 0).map((t) => Math.log(t.medB / t.medA));
  const bCheaper = diffs.filter((d) => d < 0).length;
  const nonZero = diffs.filter((d) => d !== 0).length;
  const meanCI = bootstrapCI(diffs, mean, iterations, seed);
  const medianCI = bootstrapCI(diffs, median, iterations, seed + 1);
  const ratioCI = bootstrapCI(logRatios, mean, iterations, seed + 2).map((x) => (x === undefined ? undefined : Math.exp(x)));
  const sa = armSummary(A);
  const sb = armSummary(B);
  const claim = meanCI[1] !== undefined && meanCI[1] < 0 && sb.tasksPassed >= sa.tasksPassed - 1;

  return {
    metric,
    arms: { A, B },
    summary: [sa, sb, ...(rows.some((r) => r.arm === 'M') ? [armSummary('M')] : [])],
    perTask,
    memorized,
    paired: {
      tasks: joint.length,
      medianDiff: median(diffs),
      meanDiff: mean(diffs),
      meanDiffCI: meanCI,
      medianDiffCI: medianCI,
      geoMeanRatio: logRatios.length ? Math.exp(mean(logRatios)) : undefined,
      geoMeanRatioCI: ratioCI,
      bCheaper,
      signTestP: signTest(bCheaper, nonZero),
    },
    claim,
  };
}

const f = (x, d = 3) => (x === undefined || x === null || Number.isNaN(x) ? 'n/a' : Number(x).toFixed(d));
const pct = (x) => (x === undefined ? 'n/a' : `${Math.round(x * 100)}%`);

export function renderReport(res) {
  const { A, B } = res.arms;
  const p = res.paired;
  const out = [];
  out.push(`# kiro-cli A/B: ${B} vs ${A} (metric: ${res.metric})`, '');
  out.push('| arm | runs | pass rate | tasks passed | total | median / run | cost / passing run | median requests | median tool calls | median wall s | failed exits |');
  out.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const s of res.summary) {
    out.push(`| ${s.arm} | ${s.runs} | ${pct(s.passRate)} | ${s.tasksPassed} | ${f(s.totalMetric, 2)} | ${f(s.medianMetric)} | ${f(s.costPerPassingRun)} | ${f(s.medianRequests, 1)} | ${f(s.medianToolCalls, 1)} | ${f(s.medianWallS, 0)} | ${s.failedExits} |`);
  }
  out.push('', `## Pass-gated paired comparison (${p.tasks} tasks passed by both arms)`, '');
  out.push(`- median difference ${B} − ${A}: ${f(p.medianDiff)} (95% CI ${f(p.medianDiffCI[0])} .. ${f(p.medianDiffCI[1])})`);
  out.push(`- mean difference ${B} − ${A}: ${f(p.meanDiff)} (95% CI ${f(p.meanDiffCI[0])} .. ${f(p.meanDiffCI[1])})`);
  out.push(`- geometric mean ratio ${B}/${A}: ${f(p.geoMeanRatio)} (95% CI ${f(p.geoMeanRatioCI[0])} .. ${f(p.geoMeanRatioCI[1])})`);
  out.push(`- ${B} cheaper on ${p.bCheaper}/${p.tasks} tasks (sign test p = ${f(p.signTestP)})`);
  if (res.memorized.length) out.push(`- answerable without tools (memory probe arm M passed): ${res.memorized.join(', ')}`);
  out.push('', res.claim
    ? `**Verdict: ${B} uses fewer ${res.metric} than ${A} (CI excludes 0, success non-inferior).**`
    : `**Verdict: no saving can be claimed from these runs.**`);
  out.push('', '## Per task (median over repetitions)', '', `| task | kind | pass ${A} | pass ${B} | ${A} | ${B} | memorized |`, '|---|---|---|---|---|---|---|');
  for (const t of res.perTask) out.push(`| ${t.task} | ${t.kind} | ${pct(t.passA)} | ${pct(t.passB)} | ${f(t.medA)} | ${f(t.medB)} | ${t.memorized ? 'yes' : ''} |`);
  return out.join('\n') + '\n';
}

function main(argv) {
  const opts = {};
  let file;
  let json;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--a') opts.a = argv[++i];
    else if (a === '--b') opts.b = argv[++i];
    else if (a === '--metric') opts.metric = argv[++i];
    else if (a === '--boot') opts.boot = Number(argv[++i]);
    else if (a === '--seed') opts.seed = Number(argv[++i]);
    else if (a === '--exclude-memorized') opts.excludeMemorized = true;
    else if (a === '--json') json = argv[++i];
    else file = a;
  }
  if (!file) throw new Error('usage: analyze.mjs runs.csv [--a A] [--b B] [--metric credits] [--json out.json]');
  const res = analyze(readCsv(readFileSync(file, 'utf8')), opts);
  if (json) writeFileSync(json, JSON.stringify(res, null, 2) + '\n');
  process.stdout.write(renderReport(res));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`analyze: ${err.message}\n`);
    process.exitCode = 1;
  }
}
