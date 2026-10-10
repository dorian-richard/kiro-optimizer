#!/usr/bin/env node
// Paired analysis of an agent A/B run (arm A = stock tools, arm B = the same plus kopt), from the wrapper logs and
// the answers the orchestrator collected. Complements score.mjs with:
//   - two graders: "lenient" (the orchestrator's: case-insensitive substring of answer + files + symbols, a file may
//     match by its basename) and "strict" (score.mjs: whole-word symbols, full paths, test tasks graded on the
//     ROOT CAUSE line);
//   - three session-cost measures:
//       cost12k  = sum over tool calls k=1..n of (prefix + tokens read by calls 1..k)          (v0.1 ab2 "cum")
//       costFull = sum over requests k=0..n of (prefix + arm prompt + tokens read by calls 1..k)  (adds the first
//                  request and the arm's prompt, i.e. kopt's steering/instructions/tool descriptions for arm B)
//       measured = what the agents' model really processed: sum over model requests of the input context
//                  (input + cache read + cache creation), from --usage (optional);
//   - paired B vs A comparisons with seeded bootstrap 95% CIs (ratio of totals and mean per-task relative change),
//     on all tasks and on the tasks both arms got right;
//   - kopt usage of arm B (calls per task, which commands, share of the tokens read);
//   - comparison with a previous run summary (--v01, format of ab2-summary.json);
//   - comparison with earlier runs of the same tasks (--prev, the .json this script wrote for each, repeatable):
//     drift of each arm between the runs, this run's B against the mean of both A runs, and both runs pooled (per
//     task, the mean of the runs of each arm); with several --prev, also every run pooled. --prev-kinds (after a
//     --prev, for that run) limits it to explore and/or run tasks (e.g. when one run of the test tasks is confounded);
//   - a sign test (exact two-sided binomial over the tasks that differ) next to every paired comparison;
//   - cost12kKopt: cost12k plus, on every arm-B call, kopt's measured fixed prompt (median first-request context of
//     arm B minus arm A, from --usage);
//   - --seen: the calls whose output the agent did not receive in full (the agent harness's Bash timeout or its own
//     output cap), with the tokens it did receive: adds "as delivered" variants of tokens read and cost12kKopt.
//
// usage: node bench/agentab/analyze.mjs --prompts <p.json> [--prompts <more.json>] --answers <answers.json>
//          [--logs <dir>] [--usage <usage.json>] [--v01 <ab2-summary.json>] [--prev <earlier-run.json>
//          [--prev-kinds explore,run]]... [--seen <seen.json>] [--prefix 12000] [--seed 7] [--boot 10000]
//          [--notes <analyst.md>] [--extra <diagnosis.json>] [--out <file.md>]
//
// seen.json:    { "<id>": [{ call, seenTokens, reason }] }   (call = 0-based index in the agent's wrapper log)
//
// answers.json: { "<id>": { answer, files, symbols, confidence } }   (id = "<arm>-<task>", as in the prompts file;
//               "<arm>-<task>-r<k>" for repetition k of a run with several)
//
// Repetitions (prompts.mjs --reps): every metric of a task is the mean of its runs for each arm, and the paired
// comparison bootstraps tasks; a task counts as found by an arm when every run of it found the answer. The report
// adds the run-to-run spread of each arm (the noise floor). The primary session-cost metric is the measured context
// re-based to a 12k prefix (closest to what Kiro bills), reported next to the modeled cost12k.
// usage.json:   { agents: { "<id>": { requests, contextTokens, outputTokens, firstRequestContext } } }
// --notes: the analyst's summary, inserted after the title; --extra: JSON stored under "diagnosis" in the .json.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHARS_PER_TOKEN = 3.0;
const tok = (s) => Math.ceil((s ?? '').length / CHARS_PER_TOKEN);

function parseArgs(argv) {
  const o = { prompts: [], prev: [], answers: '', logs: '', usage: '', v01: '', seen: '', notes: '', extra: '', prefix: 12000, seed: 7, boot: 10000, out: '' };
  const kinds = (v) => v.split(',').map((x) => x.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    const v = argv[++i];
    if (v === undefined) throw new Error(`missing value for ${argv[i - 1]}`);
    if (k === 'prompts') o.prompts.push(resolve(v));
    else if (k === 'prev') o.prev.push({ file: resolve(v), kinds: kinds('explore,run') });
    else if (k === 'prev-kinds') {
      if (!o.prev.length) throw new Error('--prev-kinds applies to the --prev before it');
      o.prev[o.prev.length - 1].kinds = kinds(v);
    } else if (k in o) o[k] = typeof o[k] === 'number' ? Number(v) : resolve(v);
    else throw new Error(`unknown argument ${argv[i - 1]}`);
  }
  if (!o.prompts.length || !o.answers) throw new Error('--prompts and --answers are required');
  return o;
}

// ---- graders ------------------------------------------------------------------------------------------------------
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasName = (text, name) => new RegExp(`(^|[^A-Za-z0-9_$])${escapeRe(name)}([^A-Za-z0-9_$]|$)`).test(text);

/** The orchestrator's grader (bench run of the v0.2 workflow), kept identical so the numbers match its grades. */
function gradeLenient(gold, a) {
  if (!a) return { found: false, sym: 0, file: 0 };
  const text = `${a.answer} ${(a.symbols ?? []).join(' ')} ${(a.files ?? []).join(' ')}`.toLowerCase();
  const syms = gold.symbols ?? [];
  const files = gold.files ?? [];
  const sym = syms.length ? syms.filter((n) => text.includes(String(n).toLowerCase())).length / syms.length : 1;
  const file = files.length
    ? files.filter((f) => text.includes(f.toLowerCase()) || text.includes(f.split('/').pop().toLowerCase())).length / files.length
    : 1;
  return { found: sym === 1 && file === 1, sym, file };
}

/** score.mjs's grader. */
function gradeStrict(item, a) {
  if (!a) return { found: false, sym: 0, file: 0 };
  let text = `${a.answer}\n${(a.files ?? []).join('\n')}\n${(a.symbols ?? []).join('\n')}`;
  const g = item.gold;
  if (item.kind === 'test') {
    const rc = /^\W*ROOT CAUSE:(.*)$/im.exec(a.answer);
    if (rc) text = rc[1];
    const file = g.files[0];
    const names = [...g.symbols, ...(g.alsoAccept ?? [])];
    const lines = [...text.matchAll(new RegExp(`${escapeRe(file)}:(\\d+)`, 'g'))].map((m) => Number(m[1]));
    const ok = names.some((n) => hasName(text, n)) || lines.some((l) => Math.abs(l - g.line) <= 3);
    return { found: text.includes(file) && ok, sym: ok ? 1 : 0, file: text.includes(file) ? 1 : 0 };
  }
  const sym = g.symbols.filter((s) => hasName(text, s)).length / g.symbols.length;
  const file = g.files.filter((f) => text.includes(f)).length / g.files.length;
  return { found: sym === 1 && file === 1, sym, file };
}

// ---- statistics ---------------------------------------------------------------------------------------------------
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : NaN);
function median(xs) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function quantiles(vals) {
  vals.sort((x, y) => x - y);
  return [vals[Math.floor(vals.length * 0.025)], vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.975))]];
}

/** Exact two-sided sign test: P(a split at least as uneven as wins/losses | p = 0.5), ties dropped. */
function signTest(wins, losses) {
  const n = wins + losses;
  if (!n) return 1;
  const k = Math.min(wins, losses);
  let tail = 0;
  let c = 1; // C(n, 0)
  for (let i = 0; i <= k; i++) {
    tail += c;
    c = (c * (n - i)) / (i + 1);
  }
  return Math.min(1, (2 * tail) / 2 ** n);
}

/** Paired comparison of B vs A on `key` (pairs = [[a, b], ...]); relative values are B/A - 1. */
function compare(pairs, key, o) {
  const A = pairs.map(([a]) => a[key]);
  const B = pairs.map(([, b]) => b[key]);
  const n = pairs.length;
  const out = { n, sumA: sum(A), sumB: sum(B), medianA: median(A), medianB: median(B) };
  if (!n) return out;
  const rel = pairs.map(([a, b]) => b[key] / Math.max(1, a[key]) - 1);
  out.totalRel = out.sumB / out.sumA - 1;
  out.meanRel = mean(rel);
  out.medianRel = median(rel);
  out.geoRatio = Math.exp(mean(pairs.map(([a, b]) => Math.log(Math.max(1, b[key]) / Math.max(1, a[key])))));
  out.bWins = pairs.filter(([a, b]) => b[key] < a[key]).length;
  out.aWins = pairs.filter(([a, b]) => b[key] > a[key]).length;
  out.signP = signTest(out.bWins, out.aWins);
  if (n >= 2) {
    const r = rng(o.seed);
    const tot = [];
    const mr = [];
    for (let i = 0; i < o.boot; i++) {
      let sa = 0;
      let sb = 0;
      let sr = 0;
      for (let j = 0; j < n; j++) {
        const p = Math.floor(r() * n);
        sa += A[p];
        sb += B[p];
        sr += rel[p];
      }
      tot.push(sb / sa - 1);
      mr.push(sr / n);
    }
    out.totalRelCI = quantiles(tot);
    out.meanRelCI = quantiles(mr);
  }
  return out;
}

// ---- load -----------------------------------------------------------------------------------------------------------
const o = parseArgs(process.argv.slice(2));
const docs = o.prompts.map((p) => JSON.parse(readFileSync(p, 'utf8')));
const run = docs[0].run;
const logs = o.logs || join(ROOT, 'bench', 'agentab', 'logs', run);
const answers = JSON.parse(readFileSync(o.answers, 'utf8'));
const usage = o.usage && existsSync(o.usage) ? JSON.parse(readFileSync(o.usage, 'utf8')).agents ?? {} : {};
const v01 = o.v01 && existsSync(o.v01) ? JSON.parse(readFileSync(o.v01, 'utf8')) : null;
const prevs = o.prev.filter((p) => existsSync(p.file)).map((p) => ({ ...p, data: JSON.parse(readFileSync(p.file, 'utf8')) }));
const seen = o.seen && existsSync(o.seen) ? JSON.parse(readFileSync(o.seen, 'utf8')) : null;

const rows = [];
for (const doc of docs) {
  for (const item of doc.items) {
    const rep = item.rep ?? 1;
    const logFile = join(logs, `${item.arm}-${item.repo}-${item.task}${rep > 1 ? `.r${rep}` : ''}.jsonl`);
    const calls = existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    const a = answers[item.id];
    if (!calls.length && !a) continue;
    const prompt = tok(item.prompt);
    let cum = 0;
    let cost12k = 0;
    let costFull = o.prefix + prompt; // request 0: before any tool output
    for (const c of calls) {
      cum += c.tokens;
      cost12k += o.prefix + cum;
      costFull += o.prefix + prompt + cum;
    }
    // as delivered: the tokens the agent really received for each call (--seen corrections, else the wrapper count)
    const fixes = new Map((seen?.[item.id] ?? []).map((s) => [s.call, s]));
    const seenTok = calls.map((c, i) => (fixes.has(i) ? fixes.get(i).seenTokens : c.tokens));
    let cumSeen = 0;
    let cost12kSeen = 0;
    for (const t of seenTok) {
      cumSeen += t;
      cost12kSeen += o.prefix + cumSeen;
    }
    const kopt = calls.filter((c) => c.kopt);
    const bySub = {};
    for (const c of kopt) bySub[c.koptSub ?? '?'] = (bySub[c.koptSub ?? '?'] ?? 0) + 1;
    const firstNative = calls.findIndex((c) => !c.kopt);
    const u = usage[item.id];
    rows.push({
      id: item.id,
      arm: item.arm,
      task: item.task,
      rep,
      repo: item.repo,
      kind: item.kind === 'test' ? 'run' : 'explore',
      taskKind: item.kind,
      calls: calls.length,
      koptCalls: kopt.length,
      koptBySub: bySub,
      koptErrors: kopt.filter((c) => c.exit !== 0 && !(c.koptSub === 'run' && c.exit === 1)).length,
      nativeCalls: calls.length - kopt.length,
      firstCallKopt: calls.length > 0 && !!calls[0].kopt,
      nativeAfterKopt: kopt.length ? calls.slice(calls.findIndex((c) => c.kopt)).filter((c) => !c.kopt).length : 0,
      firstNative,
      refused: calls.filter((c) => c.refused).length,
      blocked: calls.filter((c) => c.blocked).length,
      truncated: calls.filter((c) => c.truncated).length,
      read: sum(calls.map((c) => c.tokens)),
      koptRead: sum(kopt.map((c) => c.tokens)),
      nativeRead: sum(calls.filter((c) => !c.kopt).map((c) => c.tokens)),
      testCalls: calls.filter((c) => c.test).length,
      testRead: sum(calls.filter((c) => c.test).map((c) => c.tokens)),
      rawTestTokens: sum(calls.map((c) => c.rawTokens ?? 0)),
      maxCall: Math.max(0, ...calls.map((c) => c.tokens)),
      promptTokens: prompt,
      cost12k,
      costFull,
      readSeen: sum(seenTok),
      cost12kSeen,
      seenFixes: [...fixes.values()],
      cost12kKopt: null,
      cost12kKoptSeen: null,
      measuredRequests: u?.requests ?? null,
      measuredContext: u?.contextTokens ?? null,
      measuredOutput: u?.outputTokens ?? null,
      measuredFirst: u?.firstRequestContext ?? null,
      measuredRebased: null,
      answered: !!a,
      lenient: gradeLenient(item.gold, a),
      strict: gradeStrict(item, a),
      confidence: a?.confidence ?? null,
      commands: calls.map((c) => ({ cmd: c.cmd, tokens: c.tokens, kopt: !!c.kopt, sub: c.koptSub ?? null, exit: c.exit, test: !!c.test, rawTokens: c.rawTokens ?? null, refused: !!c.refused, blocked: !!c.blocked, truncated: !!c.truncated })),
      answer: a ?? null,
    });
  }
}

// Measured context re-based to a Kiro-sized prefix: the agents' harness prefix (system prompt + tool schemas, measured
// as arm A's first request minus A's prompt) is replaced by --prefix on every request. Arm B keeps its extra prompt.
const harness = {};
for (const kind of ['explore', 'run']) {
  const a = rows.filter((r) => r.kind === kind && r.arm === 'A' && r.measuredFirst !== null);
  if (!a.length) continue;
  harness[kind] = median(a.map((r) => r.measuredFirst)) - median(a.map((r) => r.promptTokens));
  for (const r of rows.filter((x) => x.kind === kind && x.measuredContext !== null)) {
    r.measuredRebased = r.measuredContext - r.measuredRequests * (harness[kind] - o.prefix);
  }
}

// kopt's measured fixed prompt (steering, command list) per request: median first-request context of arm B minus
// arm A (same harness, same task prompts otherwise); without usage data, the prompt difference in chars/3.
// cost12kKopt = cost12k with that prompt added to every arm-B call.
function koptPromptOf(rs, kind) {
  const sel = rs.filter((r) => r.kind === kind);
  const a = sel.filter((r) => r.arm === 'A');
  const b = sel.filter((r) => r.arm === 'B');
  if (!a.length || !b.length) return null;
  const measured = [...a, ...b].every((r) => r.measuredFirst !== null && r.measuredFirst !== undefined);
  return measured
    ? { tokens: median(b.map((r) => r.measuredFirst)) - median(a.map((r) => r.measuredFirst)), source: 'measured' }
    : { tokens: median(b.map((r) => r.promptTokens)) - median(a.map((r) => r.promptTokens)), source: 'chars/3' };
}
function withKoptCost(rs) {
  const kp = {};
  for (const kind of ['explore', 'run']) kp[kind] = koptPromptOf(rs, kind);
  for (const r of rs) {
    const extra = r.arm === 'B' ? kp[r.kind]?.tokens ?? 0 : 0;
    r.cost12kKopt = r.cost12k + r.calls * extra;
    if ('cost12kSeen' in r) r.cost12kKoptSeen = r.cost12kSeen + r.calls * extra;
  }
  return kp;
}
const koptPrompt = withKoptCost(rows);

// ---- analysis -------------------------------------------------------------------------------------------------------
const hasSeen = rows.some((r) => r.seenFixes.length);
const SEEN_REASONS = { 'output-cap': "the agent harness cut the command's output", 'bash-timeout': "the call hit the agent harness's timeout and its output never reached the agent" };
const METRICS = [
  ['measuredRebased', `**session cost (primary): measured context re-based to a ${o.prefix / 1000}k prefix**`],
  ['cost12kKopt', `modeled session cost, ${o.prefix / 1000}k prefix + kopt's measured prompt on arm B`],
  ['cost12k', 'modeled session cost, 12k prefix (v0.1 formula)'],
  ['read', 'tokens read (tool outputs)'],
  ...(hasSeen
    ? [
        ['readSeen', 'tokens read, as delivered to the agent'],
        ['cost12kKoptSeen', `modeled cost, ${o.prefix / 1000}k + kopt prompt, as delivered`],
      ]
    : []),
  ['measuredRequests', 'model requests'],
  ['calls', 'tool calls'],
  ['costFull', 'modeled session cost incl. first request + arm prompt'],
  ['measuredContext', 'measured agent input context (sum over model requests)'],
];
const NUMERIC = ['read', 'readSeen', 'koptRead', 'nativeRead', 'testRead', 'rawTestTokens', 'cost12k', 'cost12kSeen', 'cost12kKopt', 'cost12kKoptSeen', 'costFull', 'measuredContext', 'measuredRebased', 'measuredRequests', 'calls', 'koptCalls'];
/** One row per (task, arm): the mean of its runs; found = every run found it. */
function taskRow(sel, task, arm) {
  const rs = sel.filter((r) => r.task === task && r.arm === arm);
  if (!rs.length) return undefined;
  const out = { task, arm, runs: rs.length, kind: rs[0].kind };
  for (const k of NUMERIC) out[k] = rs.some((r) => r[k] === null) ? null : mean(rs.map((r) => r[k]));
  for (const g of ['lenient', 'strict']) out[g] = { found: rs.every((r) => r[g].found), foundRuns: rs.filter((r) => r[g].found).length, sym: mean(rs.map((r) => r[g].sym)) };
  out.spread = {};
  for (const k of ['read', 'cost12k', 'measuredRebased']) {
    const v = rs.map((r) => r[k]).filter((x) => x !== null);
    out.spread[k] = v.length > 1 ? (Math.max(...v) - Math.min(...v)) / Math.max(1, mean(v)) : null;
  }
  return out;
}
const reps = Math.max(1, ...rows.map((r) => r.rep));
const analysis = {};
for (const kind of ['explore', 'run']) {
  const sel = rows.filter((r) => r.kind === kind);
  const tasks = [...new Set(sel.map((r) => r.task))];
  const pairs = tasks.map((t) => [taskRow(sel, t, 'A'), taskRow(sel, t, 'B')]).filter(([a, b]) => a && b);
  const agg = {};
  for (const arm of ['A', 'B']) {
    const r = sel.filter((x) => x.arm === arm);
    agg[arm] = {
      runs: r.length,
      foundLenient: r.filter((x) => x.lenient.found).length,
      foundStrict: r.filter((x) => x.strict.found).length,
      symRecallLenient: mean(r.map((x) => x.lenient.sym)),
      symRecallStrict: mean(r.map((x) => x.strict.sym)),
      calls: sum(r.map((x) => x.calls)),
      medianCalls: median(r.map((x) => x.calls)),
      koptCalls: sum(r.map((x) => x.koptCalls)),
      koptCallsPerTask: mean(r.map((x) => x.koptCalls)),
      tasksWithKopt: r.filter((x) => x.koptCalls > 0).length,
      tasksWithMoreThanOneKopt: r.filter((x) => x.koptCalls > 1).length,
      koptErrors: sum(r.map((x) => x.koptErrors)),
      koptBySub: r.reduce((acc, x) => {
        for (const [k, v] of Object.entries(x.koptBySub)) acc[k] = (acc[k] ?? 0) + v;
        return acc;
      }, {}),
      refused: sum(r.map((x) => x.refused)),
      blocked: sum(r.map((x) => x.blocked)),
      read: sum(r.map((x) => x.read)),
      medianRead: median(r.map((x) => x.read)),
      koptRead: sum(r.map((x) => x.koptRead)),
      nativeRead: sum(r.map((x) => x.nativeRead)),
      testRead: sum(r.map((x) => x.testRead)),
      rawTestTokens: sum(r.map((x) => x.rawTestTokens)),
      cost12k: sum(r.map((x) => x.cost12k)),
      cost12kKopt: sum(r.map((x) => x.cost12kKopt)),
      readSeen: sum(r.map((x) => x.readSeen)),
      cost12kKoptSeen: sum(r.map((x) => x.cost12kKoptSeen)),
      seenFixes: sum(r.map((x) => x.seenFixes.length)),
      costFull: sum(r.map((x) => x.costFull)),
      measuredContext: r.every((x) => x.measuredContext !== null) ? sum(r.map((x) => x.measuredContext)) : null,
      measuredRequests: r.every((x) => x.measuredRequests !== null) ? sum(r.map((x) => x.measuredRequests)) : null,
      measuredOutput: r.every((x) => x.measuredOutput !== null) ? sum(r.map((x) => x.measuredOutput)) : null,
      measuredRebased: r.every((x) => x.measuredRebased !== null) ? sum(r.map((x) => x.measuredRebased)) : null,
      nativeCallsAfterKopt: sum(r.map((x) => x.nativeAfterKopt)),
      firstCallKopt: r.filter((x) => x.firstCallKopt).length,
      promptTokens: median(r.map((x) => x.promptTokens)),
    };
  }
  const sets = {
    all: pairs,
    bothFoundLenient: pairs.filter(([a, b]) => a.lenient.found && b.lenient.found),
    bothFoundStrict: pairs.filter(([a, b]) => a.strict.found && b.strict.found),
  };
  const cmp = {};
  for (const [name, ps] of Object.entries(sets)) {
    cmp[name] = { tasks: ps.map(([a]) => a.task) };
    for (const [key] of METRICS) {
      if (ps.some(([a, b]) => a[key] === null || b[key] === null)) continue;
      cmp[name][key] = compare(ps, key, o);
    }
  }
  // run-to-run noise: per task and arm, (max - min) / mean over its runs, averaged over tasks
  const noise = {};
  if (reps > 1) {
    for (const arm of ['A', 'B']) {
      noise[arm] = {};
      for (const k of ['read', 'cost12k', 'measuredRebased']) {
        const v = pairs.map((p) => p[arm === 'A' ? 0 : 1].spread[k]).filter((x) => x !== null);
        noise[arm][k] = v.length ? mean(v) : null;
      }
    }
  }
  analysis[kind] = { agg, cmp, pairs: pairs.map(([a]) => a.task), taskRows: pairs, noise };
}

// v0.1 comparison (same explore tasks)
let v01cmp = null;
if (v01) {
  const byTask = (arr) => Object.fromEntries(arr.map((x) => [x.task, x]));
  const vA = byTask(v01.A);
  const vB = byTask(v01.B);
  const ex = rows.filter((r) => r.kind === 'explore');
  const tasks = [...new Set(ex.map((r) => r.task))].filter((t) => vA[t] && vB[t]);
  const per = tasks.map((t) => {
    const a = taskRow(ex, t, 'A');
    const b = taskRow(ex, t, 'B');
    return {
      task: t,
      v01: { A: { read: vA[t].read, cum: vA[t].cum, calls: vA[t].calls, found: vA[t].found }, B: { read: vB[t].read, cum: vB[t].cum, calls: vB[t].calls, kopt: vB[t].kopt, found: vB[t].found } },
      r: { A: { read: a.read, cum: a.cost12k, calls: a.calls, found: a.lenient.found }, B: { read: b.read, cum: b.cost12k, calls: b.calls, kopt: b.koptCalls, found: b.lenient.found } },
    };
  });
  const tot = (side, arm, k) => sum(per.map((p) => p[side][arm][k]));
  const mk = (side) => ({
    A: { read: tot(side, 'A', 'read'), cum: tot(side, 'A', 'cum'), calls: tot(side, 'A', 'calls'), found: per.filter((p) => p[side].A.found).length },
    B: { read: tot(side, 'B', 'read'), cum: tot(side, 'B', 'cum'), calls: tot(side, 'B', 'calls'), kopt: tot(side, 'B', 'kopt'), found: per.filter((p) => p[side].B.found).length },
  });
  const pairOf = (sideA, armA, sideB, armB, k) => per.map((p) => [{ v: p[sideA][armA][k] }, { v: p[sideB][armB][k] }]);
  v01cmp = {
    tasks: tasks.length,
    v01: mk('v01'),
    r: mk('r'),
    // run-to-run drift of the same arm (A is unchanged stock tooling: its drift is the noise floor)
    driftA_read: compare(pairOf('v01', 'A', 'r', 'A', 'read'), 'v', o),
    driftA_cum: compare(pairOf('v01', 'A', 'r', 'A', 'cum'), 'v', o),
    driftB_read: compare(pairOf('v01', 'B', 'r', 'B', 'read'), 'v', o),
    v01_BvsA_read: compare(pairOf('v01', 'A', 'v01', 'B', 'read'), 'v', o),
    v01_BvsA_cum: compare(pairOf('v01', 'A', 'v01', 'B', 'cum'), 'v', o),
    r_BvsA_read: compare(pairOf('r', 'A', 'r', 'B', 'read'), 'v', o),
    r_BvsA_cum: compare(pairOf('r', 'A', 'r', 'B', 'cum'), 'v', o),
    // B of this run against the pooled A of both runs (halves the baseline noise)
    r_BvsPooledA_read: compare(per.map((p) => [{ v: (p.v01.A.read + p.r.A.read) / 2 }, { v: p.r.B.read }]), 'v', o),
    per,
  };
}

// earlier run of the same tasks (--prev): arm drift between the runs, B against the pooled A, both runs pooled
const PREV_METRICS = [
  ['measuredRebased', 'session cost: measured, re-based'],
  ['cost12kKopt', 'modeled cost12k + kopt prompt'],
  ['cost12k', 'modeled cost12k'],
  ['read', 'tokens read'],
  ['measuredRequests', 'model requests'],
  ['calls', 'tool calls'],
];
const isNum = (x) => x !== null && x !== undefined && Number.isFinite(x);
/** Per task and arm, the mean of each PREV_METRICS key over the given repetition rows (null when one lacks it). */
function meanRow(rs) {
  if (!rs.length) return undefined;
  const out = {};
  for (const [k] of PREV_METRICS) out[k] = rs.every((r) => isNum(r[k])) ? mean(rs.map((r) => r[k])) : null;
  return out;
}
const prevcmps = [];
for (const p of prevs) {
  const prev = p.data;
  const prevRowsAll = (prev.rows ?? []).map((r) => ({ ...r }));
  const prevKoptPrompt = withKoptCost(prevRowsAll);
  const prevcmp = { run: prev.run, file: relative(ROOT, p.file), kinds: {}, koptPrompt: prevKoptPrompt };
  for (const kind of p.kinds) {
    const cur = analysis[kind]?.taskRows ?? [];
    const prevRows = prevRowsAll.filter((r) => r.kind === kind);
    const pRow = (task, arm) => meanRow(prevRows.filter((r) => r.task === task && r.arm === arm));
    const per = cur
      .map(([a, b]) => ({ task: a.task, cur: { A: a, B: b }, prev: { A: pRow(a.task, 'A'), B: pRow(a.task, 'B') } }))
      .filter((x) => x.prev.A && x.prev.B);
    if (!per.length) continue;
    const metrics = {};
    for (const [k] of PREV_METRICS) {
      if (per.some((x) => [x.cur.A, x.cur.B, x.prev.A, x.prev.B].some((y) => !isNum(y[k])))) continue;
      const pr = (f) => per.map((x) => f(x).map((v) => ({ v })));
      metrics[k] = {
        prevBvsA: compare(pr((x) => [x.prev.A[k], x.prev.B[k]]), 'v', o),
        curBvsA: compare(pr((x) => [x.cur.A[k], x.cur.B[k]]), 'v', o),
        driftA: compare(pr((x) => [x.prev.A[k], x.cur.A[k]]), 'v', o),
        driftB: compare(pr((x) => [x.prev.B[k], x.cur.B[k]]), 'v', o),
        curBvsPooledA: compare(pr((x) => [(x.prev.A[k] + x.cur.A[k]) / 2, x.cur.B[k]]), 'v', o),
        pooledBvsA: compare(pr((x) => [(x.prev.A[k] + x.cur.A[k]) / 2, (x.prev.B[k] + x.cur.B[k]) / 2]), 'v', o),
      };
    }
    prevcmp.kinds[kind] = { tasks: per.map((x) => x.task), metrics };
  }
  prevcmps.push(prevcmp);
}
// every run pooled: per task and arm, the mean over all repetitions of this run and of each earlier run given
let pooledAll = null;
if (prevs.length > 1) {
  pooledAll = { runs: [...prevs.map((p) => p.data.run), run], kinds: {} };
  for (const kind of ['explore', 'run']) {
    const included = prevs.filter((p) => p.kinds.includes(kind));
    if (included.length < 1) continue;
    const prevRows = included.flatMap((p) => {
      const rs = (p.data.rows ?? []).map((r) => ({ ...r }));
      withKoptCost(rs);
      return rs.filter((r) => r.kind === kind);
    });
    const curRows = rows.filter((r) => r.kind === kind);
    const tasks = [...new Set(curRows.map((r) => r.task))];
    const per = tasks
      .map((t) => {
        const sel = (arm) => [...prevRows, ...curRows].filter((r) => r.task === t && r.arm === arm);
        return { task: t, A: meanRow(sel('A')), B: meanRow(sel('B')), reps: { A: sel('A').length, B: sel('B').length } };
      })
      .filter((x) => x.A && x.B);
    const metrics = {};
    for (const [k] of PREV_METRICS) {
      if (per.some((x) => !isNum(x.A[k]) || !isNum(x.B[k]))) continue;
      metrics[k] = compare(per.map((x) => [{ v: x.A[k] }, { v: x.B[k] }]), 'v', o);
    }
    pooledAll.kinds[kind] = { runs: [...included.map((p) => p.data.run), run], tasks: per.map((x) => x.task), repsPerArm: median(per.map((x) => x.reps.A)), metrics };
  }
}

// ---- report ---------------------------------------------------------------------------------------------------------
const fmt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : 'n/a');
const pct = (x, signed = true) => (Number.isFinite(x) ? `${signed && x > 0 ? '+' : ''}${Math.round(x * 100)}%` : 'n/a');
const ci = (c) => (c ? `[${pct(c[0])}, ${pct(c[1])}]` : 'n/a');
const pfmt = (p) => (Number.isFinite(p) ? (p < 0.001 ? 'p<0.001' : `p=${p < 0.1 ? p.toFixed(3) : p.toFixed(2)}`) : 'n/a');
const verdict = (c) => (!c ? '' : c[1] < 0 ? 'B lower (CI below 0)' : c[0] > 0 ? 'B higher (CI above 0)' : 'not significant');

const md = [];
md.push(`# Agent A/B run \`${run}\`: paired analysis`, '');
if (o.notes && existsSync(o.notes)) md.push(readFileSync(o.notes, 'utf8').trim(), '');
md.push('## Method', '');
md.push(`Tables generated by \`bench/agentab/analyze.mjs\` from the wrapper logs (\`bench/agentab/logs/${run}\`), the agents' answers and their`);
md.push(`measured token usage. Tokens read = characters of tool output / 3 (wrapper count). ${reps > 1 ? `${reps} interleaved runs per arm and task; a task's value is the mean of its runs, and it counts as found when every run found it.` : 'One run per arm and task.'} Graders: **lenient** =`);
md.push('the orchestrator\'s (case-insensitive substring, a file may match by basename); **strict** = score.mjs (whole-word symbols, full');
md.push('paths, test tasks graded on the ROOT CAUSE line). Cost measures:', '');
md.push(`- **cost12k** (the v0.1 formula, as in ab2-summary.json "cum"): sum over tool calls of (${fmt(o.prefix)}-token fixed prefix + all tokens read so far). One call = one request; same prefix for both arms, so kopt's own prompt overhead is ignored.`);
md.push(`- **cost12k + kopt prompt** (cost12kKopt): cost12k with kopt's measured fixed prompt added to every arm-B call: ${Object.entries(koptPrompt).filter(([, v]) => v).map(([k, v]) => `${k} +${fmt(v.tokens)} tokens per call (${v.source === 'measured' ? 'median first-request context of arm B minus arm A' : 'prompt difference, chars/3'})`).join(', ')}. Same 12k prefix for both arms otherwise.`);
md.push(`- **costFull**: sum over model requests 0..n of (${fmt(o.prefix)} + the arm's prompt + tokens read so far). Arm B's prompt carries kopt's steering, server instructions and command descriptions (median ${fmt(analysis.explore.agg.B.promptTokens)} tokens vs ${fmt(analysis.explore.agg.A.promptTokens)} for A, chars/3).`);
md.push('- **measured**: input context the agents\' model really processed, summed over its requests (input + cache read + cache creation tokens, from the agent transcripts; parallel tool calls share one request). Its fixed prefix is the agent harness\'s (about 34k tokens), which dilutes relative differences.');
md.push(`- **measured, re-based**: the same with the harness prefix (${Object.entries(harness).map(([k, v]) => `${k} ${fmt(v)}`).join(', ')} tokens, from arm A's first request) replaced by ${fmt(o.prefix)} tokens on every request; arm B keeps its extra prompt. The closest proxy here to what Kiro would bill.`);
if (hasSeen) md.push(`- **as delivered**: tokens read and cost12k + kopt prompt counted with what the agent really received for ${sum(rows.map((r) => r.seenFixes.length))} calls whose output it did not get in full (${[...new Set(rows.flatMap((r) => r.seenFixes.map((f) => f.reason)))].map((x) => SEEN_REASONS[x] ?? x).join('; ')}; --seen). The wrapper count models Kiro's shell (2,000 lines / 100k characters).`);
md.push('- **sign test**: exact two-sided binomial test of "B lower" against "B higher" over the tasks that differ (ties dropped).', '');

const sameTasks = (x, y) => x.tasks.length === y.tasks.length && x.tasks.every((t, i) => t === y.tasks[i]);
for (const kind of ['explore', 'run']) {
  const { agg, cmp } = analysis[kind];
  const n = analysis[kind].pairs.length;
  if (!n) continue;
  const title = kind === 'explore' ? `Exploration tasks (${n})` : `Test-run diagnosis tasks (${n})`;
  md.push(`## ${title}`, '');
  const prim = cmp.all.measuredRebased;
  const c12 = cmp.all.cost12k;
  const rd = cmp.all.read;
  if (prim?.n || c12?.n) {
    md.push(`**Session cost, B vs A** (primary, measured context re-based to a ${o.prefix / 1000}k prefix): ${prim?.n ? `${pct(prim.totalRel)} ${ci(prim.totalRelCI)}, ${verdict(prim.totalRelCI)}, B lower in ${prim.bWins}/${prim.n} tasks (sign test ${pfmt(prim.signP)})` : 'n/a (no usage data)'}; modeled cost12k + kopt prompt: ${cmp.all.cost12kKopt?.n ? `${pct(cmp.all.cost12kKopt.totalRel)} ${ci(cmp.all.cost12kKopt.totalRelCI)}` : 'n/a'}; modeled cost12k: ${c12?.n ? `${pct(c12.totalRel)} ${ci(c12.totalRelCI)}` : 'n/a'}; tokens read: ${rd?.n ? `${pct(rd.totalRel)} ${ci(rd.totalRelCI)}` : 'n/a'}.`, '');
  }
  md.push(`| arm | found (lenient / strict) | symbol recall (lenient / strict) | tool calls (median) | model requests | kopt calls (tasks >1) | tokens read | of which kopt | test output | cost12k | cost12k + kopt prompt | costFull | measured | measured, re-based |${hasSeen ? ' read, as delivered |' : ''}`);
  md.push(`|---|---|---|---|---|---|---|---|---|---|---|---|---|---|${hasSeen ? '---|' : ''}`);
  for (const arm of ['A', 'B']) {
    const g = agg[arm];
    md.push(`| ${arm} | ${g.foundLenient}/${g.runs} / ${g.foundStrict}/${g.runs} | ${pct(g.symRecallLenient, false)} / ${pct(g.symRecallStrict, false)} | ${g.calls} (${g.medianCalls}) | ${fmt(g.measuredRequests)} | ${g.koptCalls} (${g.tasksWithMoreThanOneKopt}) | ${fmt(g.read)} | ${fmt(g.koptRead)} | ${fmt(g.testRead)} | ${fmt(g.cost12k)} | ${fmt(g.cost12kKopt)} | ${fmt(g.costFull)} | ${fmt(g.measuredContext)} | ${fmt(g.measuredRebased)} |${hasSeen ? ` ${fmt(g.readSeen)} |` : ''}`);
  }
  md.push('');
  const sets = [['all', 'all tasks']];
  for (const [set, label] of [['bothFoundLenient', 'both found (lenient)'], ['bothFoundStrict', 'both found (strict)']]) {
    if (sameTasks(cmp[set], cmp.all)) md.push(`- ${label}: the same ${cmp.all.tasks.length} tasks as "all tasks" (both arms answered every task correctly), so the pass-gated comparison is identical.`);
    else sets.push([set, label]);
  }
  md.push('', 'Paired B vs A (relative = B/A - 1; 95% CI from 10,000 seeded bootstrap resamples of tasks):', '');
  md.push('| task set | metric | n | A total | B total | B/A total | 95% CI | mean per-task | 95% CI | median per-task | B lower / higher (sign test) | verdict (total) |');
  md.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const [set, label] of sets) {
    for (const [key, mlabel] of METRICS) {
      const c = cmp[set][key];
      if (!c || !c.n) continue;
      md.push(`| ${label} | ${mlabel} | ${c.n} | ${fmt(c.sumA)} | ${fmt(c.sumB)} | ${pct(c.totalRel)} | ${ci(c.totalRelCI)} | ${pct(c.meanRel)} | ${ci(c.meanRelCI)} | ${pct(c.medianRel)} | ${c.bWins} / ${c.aWins} (${pfmt(c.signP)}) | ${verdict(c.totalRelCI)} |`);
    }
  }
  md.push('');
  if (reps > 1) {
    const nz = analysis[kind].noise;
    md.push(`Run-to-run spread ((max - min) / mean over the ${reps} runs of a task, mean over tasks): arm A read ${pct(nz.A.read, false)}, cost12k ${pct(nz.A.cost12k, false)}, re-based ${pct(nz.A.measuredRebased, false)}; arm B read ${pct(nz.B.read, false)}, cost12k ${pct(nz.B.cost12k, false)}, re-based ${pct(nz.B.measuredRebased, false)}.`, '');
  }
  md.push(`Per task${reps > 1 ? ' (mean of the runs; found = runs that found it)' : ''}:`, '');
  md.push('| task | arm | found (len/strict) | sym | calls | requests | kopt | read | kopt read | test out | raw test out | cost12k | cost12k + kopt prompt | measured, re-based | B/A read | B/A cost12k + kopt | B/A re-based |');
  md.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  const foundCell = (r, g) => (reps > 1 ? `${r[g].foundRuns}/${r.runs}` : r[g].found ? 'yes' : 'no');
  for (const [a, b] of analysis[kind].taskRows) {
    for (const r of [a, b]) {
      const rel = r.arm === 'B' ? [pct(b.read / a.read - 1), pct(b.cost12kKopt / a.cost12kKopt - 1), a.measuredRebased ? pct(b.measuredRebased / a.measuredRebased - 1) : 'n/a'] : ['', '', ''];
      md.push(`| ${a.task} | ${r.arm} | ${foundCell(r, 'lenient')}${reps > 1 ? ' · ' : '/'}${foundCell(r, 'strict')} | ${pct(r.lenient.sym, false)} | ${fmt(r.calls)} | ${fmt(r.measuredRequests)} | ${fmt(r.koptCalls)} | ${fmt(r.read)} | ${fmt(r.koptRead)} | ${fmt(r.testRead)} | ${fmt(r.rawTestTokens)} | ${fmt(r.cost12k)} | ${fmt(r.cost12kKopt)} | ${fmt(r.measuredRebased)} | ${rel[0]} | ${rel[1]} | ${rel[2]} |`);
    }
  }
  md.push('');
  // kopt usage of arm B
  const bRows = analysis[kind].pairs.flatMap((t) => rows.filter((r) => r.task === t && r.arm === 'B').sort((x, y) => x.rep - y.rep));
  const g = agg.B;
  md.push(`kopt usage (arm B): ${g.koptCalls} kopt calls in ${g.runs} ${reps > 1 ? 'runs' : 'tasks'} (${(g.koptCallsPerTask ?? 0).toFixed(1)} per task; ${g.tasksWithMoreThanOneKopt}/${g.runs} tasks with more than one; first call was kopt in ${g.firstCallKopt}/${g.runs}); by command: ${Object.entries(g.koptBySub).map(([k, v]) => `${k} ${v}`).join(', ')}; kopt errors: ${g.koptErrors}; governor blocks: ${g.blocked}. kopt output = ${pct(g.koptRead / Math.max(1, g.read), false)} of B's tokens read; ${fmt(g.calls - g.koptCalls)} native calls (${fmt(g.nativeRead)} tokens), ${g.nativeCallsAfterKopt} of them after a kopt call.`, '');
  md.push('| task | kopt calls | kopt commands, in order | native calls after the first kopt call (tokens) |');
  md.push('|---|---|---|---|');
  for (const r of bRows) {
    const seq = r.commands.filter((c) => c.kopt).map((c) => c.sub).join(' > ') || '-';
    const firstK = r.commands.findIndex((c) => c.kopt);
    const after = firstK < 0 ? [] : r.commands.slice(firstK).filter((c) => !c.kopt);
    md.push(`| ${r.task}${reps > 1 ? ` (run ${r.rep})` : ''} | ${r.koptCalls} | ${seq} | ${after.length} (${fmt(sum(after.map((c) => c.tokens)))}) |`);
  }
  md.push('');
}

if (v01cmp) {
  const v = v01cmp;
  md.push('## Against v0.1 (ab2, same 15 exploration tasks)', '');
  md.push('v0.1 numbers come from `ab2-summary.json` (same wrapper count, same cost12k formula, same lenient grader).', '');
  md.push('| run | A found | B found | A read | B read | B/A read | A cost12k | B cost12k | B/A cost12k | A calls | B calls | B kopt calls |');
  md.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const [label, s] of [['v0.1 (ab2)', v.v01], [`v0.2 (${run})`, v.r]]) {
    md.push(`| ${label} | ${s.A.found}/${v.tasks} | ${s.B.found}/${v.tasks} | ${fmt(s.A.read)} | ${fmt(s.B.read)} | ${pct(s.B.read / s.A.read - 1)} | ${fmt(s.A.cum)} | ${fmt(s.B.cum)} | ${pct(s.B.cum / s.A.cum - 1)} | ${s.A.calls} | ${s.B.calls} | ${s.B.kopt} |`);
  }
  md.push('');
  md.push('| paired comparison (15 tasks) | B/A total | 95% CI | mean per-task | 95% CI |');
  md.push('|---|---|---|---|---|');
  for (const [label, c] of [
    ['v0.1: B vs A, tokens read', v.v01_BvsA_read],
    ['v0.1: B vs A, cost12k', v.v01_BvsA_cum],
    [`${run}: B vs A, tokens read`, v.r_BvsA_read],
    [`${run}: B vs A, cost12k`, v.r_BvsA_cum],
    [`${run} B vs mean of both A runs, tokens read`, v.r_BvsPooledA_read],
    [`noise floor: A(${run}) vs A(v0.1), tokens read`, v.driftA_read],
    [`noise floor: A(${run}) vs A(v0.1), cost12k`, v.driftA_cum],
    [`B(${run}) vs B(v0.1), tokens read`, v.driftB_read],
  ]) {
    md.push(`| ${label} | ${pct(c.totalRel)} | ${ci(c.totalRelCI)} | ${pct(c.meanRel)} | ${ci(c.meanRelCI)} |`);
  }
  md.push('');
}

for (const prevcmp of prevcmps) {
  if (!Object.keys(prevcmp.kinds).length) continue;
  md.push(`## Against an earlier run (\`${prevcmp.run}\`, same tasks)`, '');
  md.push(`Paired over tasks (relative = later/earlier - 1 for drift, B/A - 1 otherwise; 95% CI from ${o.boot.toLocaleString('en-US')} seeded bootstrap resamples of tasks). Arm A is the same stock tooling in both runs, so its drift is the run-to-run noise. "Pooled" = per task, the mean of the two runs' values of each arm (each run's value is the mean of its repetitions).${prevcmp.koptPrompt ? ` kopt's measured prompt in \`${prevcmp.run}\`: ${Object.entries(prevcmp.koptPrompt).filter(([, v]) => v).map(([k, v]) => `${k} +${fmt(v.tokens)}`).join(', ')} tokens per call.` : ''}`, '');
  md.push(`| tasks | metric | ${prevcmp.run}: B/A | ${run}: B/A | drift A (${run} vs ${prevcmp.run}) | drift B | ${run} B vs mean of both A runs | pooled ${prevcmp.run}+${run}: B/A |`);
  md.push('|---|---|---|---|---|---|---|---|');
  const cell = (c) => `${pct(c.totalRel)} ${ci(c.totalRelCI)}`;
  for (const [kind, k] of Object.entries(prevcmp.kinds)) {
    for (const [key, label] of PREV_METRICS) {
      const m = k.metrics[key];
      if (!m) continue;
      md.push(`| ${kind} (${k.tasks.length}) | ${label} | ${cell(m.prevBvsA)} | ${cell(m.curBvsA)} | ${cell(m.driftA)} | ${cell(m.driftB)} | ${cell(m.curBvsPooledA)} | ${cell(m.pooledBvsA)} |`);
    }
  }
  md.push('');
}

if (pooledAll && Object.keys(pooledAll.kinds).length) {
  md.push(`## Every run pooled (${pooledAll.runs.map((r) => `\`${r}\``).join(', ')})`, '');
  md.push('Per task and arm, the mean over every repetition of these runs (different kopt builds: the pooled figure averages them), then paired over tasks as above.', '');
  md.push('| tasks | runs | repetitions per arm | metric | pooled B/A total | 95% CI | mean per-task | 95% CI | B lower / higher (sign test) |');
  md.push('|---|---|---|---|---|---|---|---|---|');
  for (const [kind, k] of Object.entries(pooledAll.kinds)) {
    for (const [key, label] of PREV_METRICS) {
      const c = k.metrics[key];
      if (!c) continue;
      md.push(`| ${kind} (${k.tasks.length}) | ${k.runs.join(' + ')} | ${k.repsPerArm} | ${label} | ${pct(c.totalRel)} | ${ci(c.totalRelCI)} | ${pct(c.meanRel)} | ${ci(c.meanRelCI)} | ${c.bWins} / ${c.aWins} (${pfmt(c.signP)}) |`);
    }
  }
  md.push('');
}

const diagnosis = o.extra && existsSync(o.extra) ? JSON.parse(readFileSync(o.extra, 'utf8')) : undefined;
const result = { run, generatedBy: 'bench/agentab/analyze.mjs', model: { prefix: o.prefix, charsPerToken: CHARS_PER_TOKEN, bootstrap: o.boot, seed: o.seed, harnessPrefix: harness }, analysis, koptPrompt, v01: v01cmp, prev: prevcmps.length === 1 ? prevcmps[0] : prevcmps, pooledAll, diagnosis, rows };
const text = md.join('\n') + '\n';
if (o.out) {
  writeFileSync(o.out, text);
  writeFileSync(o.out.replace(/\.md$/, '') + '.json', JSON.stringify(result, null, 2) + '\n');
}
process.stdout.write(text);
