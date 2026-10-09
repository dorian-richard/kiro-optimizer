#!/usr/bin/env node
// Scores the competitor outputs (results/<label>-<repo>[-question].jsonl) with the SAME metrics as
// `kopt bench` (dist/bench/metrics.js: file/symbol/definition recall, found, tokens = chars/3) and
// writes results/summary.json + results/summary.md, next to the kopt-bench reference numbers from
// bench/results/<repo>[-question].json when they exist.
//
//   node bench/competitors/score.mjs            (run `npm run build` first: it imports dist/bench)
//
// Runs on the host: it only reads text files, it never executes competitor code.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const RESULTS = join(HERE, 'results');

async function loadDist(rel) {
  const p = join(ROOT, 'dist', rel);
  if (!existsSync(p)) {
    process.stderr.write(`score: ${p} is missing, run \`npm run build\` at the repo root first\n`);
    process.exit(1);
  }
  return import(pathToFileURL(p).href);
}

const { computeRecall, aggregate, compare } = await loadDist('bench/metrics.js');
const { goldDefSignatures } = await loadDist('bench/tasks.js');
const { estimateTokens } = await loadDist('core/tokens.js');

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const readJsonl = (p) =>
  readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

const pct = (x) => (x === null || x === undefined ? '-' : `${Math.round(x * 100)} %`);
const num = (x) => (x === null || x === undefined ? '-' : Math.round(x).toLocaleString('en-US'));
const ratio = (x) => (x === null || x === undefined ? '-' : x.toFixed(2));
const mb = (b) => (b ? `${(b / 1e6).toFixed(0)} MB` : '-');
const secs = (ms) => (ms === null || ms === undefined ? '-' : `${(ms / 1000).toFixed(1)} s`);

// ---------------------------------------------------------------------------------------------

const metas = readdirSync(RESULTS)
  .filter((f) => f.endsWith('.meta.json'))
  .map((f) => readJson(join(RESULTS, f)));
if (!metas.length) {
  process.stderr.write('score: no results/*.meta.json yet, run bench/competitors/run.sh first\n');
  process.exit(1);
}

const repos = [...new Set(metas.map((m) => m.repo?.name).filter(Boolean))].sort();
const summary = { date: new Date().toISOString(), charsPerToken: 3, repos: {} };
const md = [];
md.push('# Competitor benchmark: summary');
md.push('');
md.push(
  `Generated ${summary.date.slice(0, 10)} by \`node bench/competitors/score.mjs\` from \`bench/competitors/results/\`. ` +
    'One tool call per task (the first exploration step of an agent), scored with the `kopt bench` metrics ' +
    '(tokens = characters / 3, recall of the verified gold files and symbols). See `bench/competitors/README.md` ' +
    'for the protocol and the fairness notes. The `kopt bench` rows are copied from `bench/results/` and were measured ' +
    'on the host, not in the container.',
);

for (const repo of repos) {
  const taskPath = join(ROOT, 'bench', 'tasks', `${repo}.json`);
  if (!existsSync(taskPath)) continue;
  const taskFile = readJson(taskPath);
  const tasks = taskFile.tasks;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const checkout = join(ROOT, 'bench', 'repos', repo);
  const defSigs = existsSync(checkout) ? goldDefSignatures(checkout, tasks) : new Map();
  const repoOut = { inputs: {} };
  summary.repos[repo] = repoOut;

  md.push('');
  md.push(`## ${repo}`);
  md.push('');
  md.push(`${taskFile.repo?.language ?? ''} · ${taskFile.repo?.tag ?? ''} · ${tasks.length} tasks`);

  // index/cost table (one row per competitor label)
  const repoMetas = metas.filter((m) => m.repo?.name === repo).sort((a, b) => a.label.localeCompare(b.label));
  md.push('');
  md.push('| tool | version | mode | index time | index size | fixed overhead per request | median query | errors |');
  md.push('|---|---|---|---|---|---|---|---|');
  for (const m of repoMetas) {
    const fixed = m.surface ? m.surface.toolsEstTokens + m.surface.instructionsEstTokens : null;
    const q = m.inputs?.search?.queryMsMedian ?? Object.values(m.inputs ?? {})[0]?.queryMsMedian;
    md.push(
      `| ${m.label} | ${m.version ?? '-'} | ${m.mode} | ${m.indexOk ? secs(m.indexMs) : 'FAILED'} | ${mb(m.indexSizeBytes)}` +
        `${m.modelBytes ? ` (+ ${mb(m.modelBytes)} model)` : ''} | ${fixed === null ? '-' : `${num(fixed)} tok (${m.surface.toolCount} tools)`} ` +
        `| ${q === null || q === undefined ? '-' : `${num(q)} ms`} | ${m.errors?.length ?? 0} |`,
    );
  }

  for (const field of ['search', 'question']) {
    const results = [];
    const labels = [];
    for (const m of repoMetas) {
      const file = join(RESULTS, `${m.label}-${repo}${field === 'search' ? '' : `-${field}`}.jsonl`);
      if (!existsSync(file)) continue;
      labels.push(m.label);
      for (const rec of readJsonl(file)) {
        const t = byId.get(rec.taskId);
        if (!t) continue;
        const output = rec.output ?? '';
        results.push({
          taskId: rec.taskId,
          kind: t.kind,
          strategy: m.label,
          tokens: estimateTokens(output),
          chars: output.length,
          toolCalls: rec.toolCalls ?? 1,
          durationMs: rec.queryMs ?? 0,
          recall: computeRecall(output, t.gold, defSigs),
          error: rec.error ?? (rec.isError ? 'isError' : undefined),
          skipped: false,
        });
      }
    }
    if (!labels.length) continue;

    // kopt bench reference (same tasks, same metrics), if present
    const refPath = join(ROOT, 'bench', 'results', `${repo}${field === 'search' ? '' : `-${field}`}.json`);
    const ref = existsSync(refPath) ? readJson(refPath) : null;
    const refStrategies = ref ? ref.meta?.strategies ?? [] : [];
    const refResults = ref ? (ref.results ?? []).filter((r) => byId.has(r.taskId)) : [];
    const all = [...results, ...refResults];

    const aggs = [...labels.map((l) => ({ source: 'container', ...aggregate(l, results) }))];
    for (const s of refStrategies) aggs.push({ source: `kopt bench ${ref.meta?.date?.slice(0, 10) ?? ''}`.trim(), ...aggregate(s, refResults) });

    const pairs = [];
    for (const l of labels) {
      for (const base of ['kopt-pack', 'native-ranged']) {
        if (refStrategies.includes(base)) pairs.push(compare(base, l, all));
      }
    }

    const perTask = tasks.map((t) => {
      const row = { taskId: t.id, kind: t.kind };
      for (const r of all.filter((x) => x.taskId === t.id)) {
        row[r.strategy] = { found: r.recall.found, tokens: r.tokens, fileRecall: r.recall.fileRecall, symbolRecall: r.recall.symbolRecall };
      }
      return row;
    });
    repoOut.inputs[field] = { aggregates: aggs, paired: pairs, perTask };

    md.push('');
    md.push(`### ${repo}, input = \`${field}\``);
    md.push('');
    md.push('| strategy | source | found | file recall | symbol recall | def recall | median tok | p90 tok | tokens / found task | calls |');
    md.push('|---|---|---|---|---|---|---|---|---|---|');
    for (const a of aggs) {
      md.push(
        `| ${a.strategy} | ${a.source} | ${a.found}/${a.tasks}${a.errors ? ` (${a.errors} err)` : ''} | ${pct(a.meanFileRecall)} | ${pct(a.meanSymbolRecall)} ` +
          `| ${pct(a.meanDefRecall)} | ${num(a.medianTokens)} | ${num(a.p90Tokens)} | ${num(a.tokensPerFound)} | ${a.meanToolCalls.toFixed(1)} |`,
      );
    }
    if (pairs.length) {
      md.push('');
      md.push('Pass-gated pairs (tokens b / a over tasks found by both; < 1 means b is cheaper):');
      md.push('');
      md.push('| a | b | found by both | only a | only b | median b/a | geo-mean b/a |');
      md.push('|---|---|---|---|---|---|---|');
      for (const p of pairs) {
        md.push(`| ${p.a} | ${p.b} | ${p.nBoth}/${p.nRun} | ${p.onlyA} | ${p.onlyB} | ${ratio(p.medianRatio)} | ${ratio(p.geoMeanRatio)} |`);
      }
    }
    const cols = [...labels, ...refStrategies.filter((s) => s === 'kopt-pack' || s === 'native-ranged')];
    md.push('');
    md.push(`| task | kind | ${cols.join(' | ')} |`);
    md.push(`|---|---|${cols.map(() => '---').join('|')}|`);
    for (const row of perTask) {
      const cells = cols.map((c) => (row[c] ? `${row[c].found ? 'found' : 'miss'} ${num(row[c].tokens)}` : '-'));
      md.push(`| ${row.taskId} | ${row.kind} | ${cells.join(' | ')} |`);
    }
  }
}

md.push('');
md.push('Cells of the per-task tables: `found`/`miss` (all gold files and symbol names present) and the estimated tokens returned by the single call.');
md.push('');
writeFileSync(join(RESULTS, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
writeFileSync(join(RESULTS, 'summary.md'), md.join('\n'));
process.stdout.write(`score: wrote ${join(RESULTS, 'summary.md')} (${repos.length} repo(s))\n`);
