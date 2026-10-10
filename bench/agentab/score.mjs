#!/usr/bin/env node
// Scores an agent A/B run: what entered each agent's context (from the wrapper logs), a modeled session cost, and
// whether the final answer is right (from the answers the orchestrator saved).
//
// usage: node bench/agentab/score.mjs --prompts <prompts.json> [--prompts <more.json>] [--logs <dir>] [--answers <dir>]
//          [--base 8000] [--per-turn 150] [--out <file.md>]
//
// Answers: <answers>/<id>.md with id = <arm>-<task>, or <arm>-<task>-r<k> for repetition k of a run with several
// (default: bench/agentab/logs/<run>/answers). With repetitions, each task's pair compares the mean of its runs.
//
// Modeled cost (tokens billed over the session, Kiro bills every request on its whole context): request k (k = 0..n
// for n tool calls; request n writes the answer) costs base + prompt + k * perTurn + the outputs of calls 0..k-1.
// base = fixed system prompt and built-in tool schemas, prompt = the task prompt (arm B's includes kopt's steering,
// instructions and tool descriptions), perTurn = the model's own tool-call messages. It is a model, not credits.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHARS_PER_TOKEN = 3.0;
const tok = (s) => Math.ceil((s ?? '').length / CHARS_PER_TOKEN);

function parseArgs(argv) {
  const o = { prompts: [], logs: '', answers: '', base: 8000, perTurn: 150, out: '', seed: 7 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const v = argv[++i];
    if (k === 'prompts') o.prompts.push(resolve(v));
    else if (k in o) o[k] = typeof o[k] === 'number' ? Number(v) : resolve(v);
    else throw new Error(`unknown argument ${argv[i - 1]}`);
  }
  if (!o.prompts.length) throw new Error('--prompts <prompts.json> is required');
  return o;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasName = (text, name) => new RegExp(`(^|[^A-Za-z0-9_$])${escapeRe(name)}([^A-Za-z0-9_$]|$)`).test(text);
const hasFile = (text, file) => text.includes(file);

function grade(item, answer) {
  if (answer === undefined) return { answered: false };
  const g = item.gold;
  const fileHits = g.files.filter((f) => hasFile(answer, f)).length;
  if (item.kind === 'test') {
    // graded on the "ROOT CAUSE:" line when the answer has one (a file merely mentioned elsewhere does not count)
    const rc = /^\W*ROOT CAUSE:(.*)$/im.exec(answer);
    if (rc) answer = rc[1];
    const file = g.files[0];
    const names = [...g.symbols, ...(g.alsoAccept ?? [])];
    const lineRe = new RegExp(`${escapeRe(file)}:(\\d+)`, 'g');
    const lines = [...answer.matchAll(lineRe)].map((m) => Number(m[1]));
    const lineOk = lines.some((l) => Math.abs(l - g.line) <= 3);
    const nameOk = names.some((n) => hasName(answer, n));
    const found = hasFile(answer, file) && (nameOk || lineOk);
    return { answered: true, found, fileRecall: fileHits / g.files.length, symRecall: nameOk || lineOk ? 1 : 0, lineOk };
  }
  const symHits = g.symbols.filter((s) => hasName(answer, s)).length;
  return {
    answered: true,
    found: symHits === g.symbols.length && fileHits === g.files.length,
    fileRecall: fileHits / g.files.length,
    symRecall: symHits / g.symbols.length,
  };
}

function cost(calls, promptTokens, o) {
  let total = 0;
  let context = 0;
  for (let k = 0; k <= calls.length; k++) {
    total += o.base + promptTokens + k * o.perTurn + context;
    if (k < calls.length) context += calls[k].tokens;
  }
  return total;
}

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Paired bootstrap 95% CI of the mean of `diffs` (seeded). */
function bootstrap(diffs, seed, n = 10000) {
  if (diffs.length < 2) return [NaN, NaN];
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const means = [];
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < diffs.length; j++) s += diffs[Math.floor(rnd() * diffs.length)];
    means.push(s / diffs.length);
  }
  means.sort((x, y) => x - y);
  return [means[Math.floor(n * 0.025)], means[Math.floor(n * 0.975)]];
}

const o = parseArgs(process.argv.slice(2));
const docs = o.prompts.map((p) => JSON.parse(readFileSync(p, 'utf8')));
const run = docs[0].run;
const logs = o.logs || join(ROOT, 'bench', 'agentab', 'logs', run);
const answersDir = o.answers || join(logs, 'answers');
const rows = [];
for (const doc of docs) {
  for (const item of doc.items) {
    const rep = item.rep ?? 1;
    const logFile = join(logs, `${item.arm}-${item.repo}-${item.task}${rep > 1 ? `.r${rep}` : ''}.jsonl`);
    const calls = existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    const ansFile = join(answersDir, `${item.id}.md`);
    const answer = existsSync(ansFile) ? readFileSync(ansFile, 'utf8') : undefined;
    const promptTokens = tok(item.prompt);
    if (!calls.length && answer === undefined) continue; // not run (yet)
    rows.push({
      id: item.id, arm: item.arm, task: item.task, rep, kind: item.kind, repo: item.repo,
      calls: calls.length,
      kopt: calls.filter((c) => c.kopt).length,
      koptErrors: calls.filter((c) => c.kopt && c.exit !== 0 && !(c.koptSub === 'run' && c.exit === 1)).length,
      refused: calls.filter((c) => c.refused).length,
      blocked: calls.filter((c) => c.blocked).length,
      tests: calls.filter((c) => c.test).length,
      read: calls.reduce((s, c) => s + c.tokens, 0),
      testRead: calls.filter((c) => c.test).reduce((s, c) => s + c.tokens, 0),
      rawAvoided: calls.reduce((s, c) => s + (c.rawTokens ? Math.max(0, c.rawTokens - c.tokens) : 0), 0),
      promptTokens,
      answerTokens: tok(answer),
      cost: cost(calls, promptTokens, o) + tok(answer),
      ...grade(item, answer),
    });
  }
}

const fmt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : 'n/a');
const pct = (x) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : 'n/a');
const out = [];
out.push(`# Agent A/B run \`${run}\``, '');
out.push(`Model: base ${o.base} tok + prompt + ${o.perTurn} tok/turn + previous tool outputs, per request (see score.mjs). Tokens = chars/3.`, '');
for (const kind of [...new Set(rows.map((r) => (r.kind === 'test' ? 'test' : 'explore')))]) {
  const sel = rows.filter((r) => (r.kind === 'test') === (kind === 'test'));
  out.push(`## ${kind === 'test' ? 'Test-run diagnosis tasks' : 'Exploration tasks'}`, '');
  out.push(`${sel.length} runs with a log or an answer; aggregates cover those runs only.`, '');
  out.push('| arm | runs | answered | found | symbol recall | median calls | kopt calls (errors) | governor blocks | refused | median read tok | total read tok | test output tok | total modeled tok |');
  out.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const arm of ['A', 'B']) {
    const r = sel.filter((x) => x.arm === arm);
    const ans = r.filter((x) => x.answered);
    out.push(`| ${arm} | ${r.length} | ${ans.length} | ${ans.filter((x) => x.found).length} | ${pct(ans.reduce((s, x) => s + x.symRecall, 0) / ans.length)} | ${median(r.map((x) => x.calls))} | ${r.reduce((s, x) => s + x.kopt, 0)} (${r.reduce((s, x) => s + x.koptErrors, 0)}) | ${r.reduce((s, x) => s + x.blocked, 0)} | ${r.reduce((s, x) => s + x.refused, 0)} | ${fmt(median(r.map((x) => x.read)))} | ${fmt(r.reduce((s, x) => s + x.read, 0))} | ${fmt(r.reduce((s, x) => s + x.testRead, 0))} | ${fmt(r.reduce((s, x) => s + x.cost, 0))} |`);
  }
  // pass-gated pairs: per task, the mean of its runs of each arm, when every run of both arms found the answer
  const tasks = [...new Set(sel.map((r) => r.task))];
  const meanOf = (rs) =>
    rs.length ? { found: rs.every((x) => x.found), read: rs.reduce((s, x) => s + x.read, 0) / rs.length, cost: rs.reduce((s, x) => s + x.cost, 0) / rs.length, calls: rs.reduce((s, x) => s + x.calls, 0) / rs.length } : undefined;
  const pairs = tasks
    .map((t) => [meanOf(sel.filter((r) => r.task === t && r.arm === 'A')), meanOf(sel.filter((r) => r.task === t && r.arm === 'B'))])
    .filter(([a, b]) => a && b && a.found && b.found);
  out.push('');
  if (pairs.length) {
    for (const [label, key] of [['read tokens', 'read'], ['modeled session tokens', 'cost'], ['tool calls', 'calls']]) {
      const diffs = pairs.map(([a, b]) => b[key] - a[key]);
      const [lo, hi] = bootstrap(diffs, o.seed);
      const sumA = pairs.reduce((s, [a]) => s + a[key], 0);
      const sumB = pairs.reduce((s, [, b]) => s + b[key], 0);
      const geo = Math.exp(pairs.reduce((s, [a, b]) => s + Math.log(Math.max(1, b[key]) / Math.max(1, a[key])), 0) / pairs.length);
      out.push(`- ${label}, ${pairs.length} tasks found by both arms: B/A total ${(sumB / sumA).toFixed(2)} (${pct(sumB / sumA - 1)}), geometric mean ratio ${geo.toFixed(2)}, mean B-A ${fmt(diffs.reduce((s, d) => s + d, 0) / diffs.length)} [95% CI ${fmt(lo)}, ${fmt(hi)}]${hi < 0 ? ' — saving' : lo > 0 ? ' — B costs more' : ' — not significant'}`);
    }
  } else out.push('- no task found by both arms yet');
  out.push('', '| task | arm | run | found | sym | calls | kopt | blocked | read tok | test tok | raw test tok avoided | modeled tok |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const t of tasks) {
    for (const arm of ['A', 'B']) {
      for (const r of sel.filter((x) => x.task === t && x.arm === arm).sort((x, y) => x.rep - y.rep)) {
        out.push(`| ${t} | ${arm} | ${r.rep} | ${r.answered ? (r.found ? 'yes' : 'no') : '-'} | ${r.answered ? pct(r.symRecall) : '-'} | ${r.calls} | ${r.kopt} | ${r.blocked} | ${fmt(r.read)} | ${fmt(r.testRead)} | ${fmt(r.rawAvoided)} | ${fmt(r.cost)} |`);
      }
    }
  }
  out.push('');
}
const md = out.join('\n');
if (o.out) {
  writeFileSync(o.out, md + '\n');
  writeFileSync(o.out.replace(/\.md$/, '') + '.json', JSON.stringify({ run, model: { base: o.base, perTurn: o.perTurn, charsPerToken: CHARS_PER_TOKEN }, rows }, null, 2) + '\n');
}
process.stdout.write(md + '\n');
