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
const summary = { date: new Date().toISOString(), charsPerToken: 3, overview: [], repos: {} };
const head = [];
head.push('# Competitor benchmark: summary');
head.push('');
head.push(
  `Generated ${summary.date.slice(0, 10)} by \`node bench/competitors/score.mjs\` from \`bench/competitors/results/\`. ` +
    'One tool call per task (the first exploration step of an agent), scored with the `kopt bench` metrics ' +
    '(tokens = characters / 3, recall of the verified gold files and symbols). See `bench/competitors/README.md` ' +
    'for the protocol and the fairness notes. The `kopt bench` rows are copied from `bench/results/` and were measured ' +
    'on the host, not in the container.',
);
// per-repo sections; the cross-repo overview (input = search) is put in front of them at the end
const md = [];
/** overview rows: one per (repo, competitor label) for input = search, plus kopt bench reference rows */
const overview = [];
/** every scored result (input = search), task ids prefixed with the repo, for cross-repo paired comparisons */
const globalResults = [];

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
    const coverage = {};
    for (const m of repoMetas) {
      const file = join(RESULTS, `${m.label}-${repo}${field === 'search' ? '' : `-${field}`}.jsonl`);
      if (!existsSync(file)) continue;
      labels.push(m.label);
      const seen = new Set();
      let stale = 0;
      for (const rec of readJsonl(file)) {
        const t = byId.get(rec.taskId);
        if (!t) continue;
        // the task's input changed after the run (tasks file edited): still scored, but flagged
        const expected = field === 'search' ? t.search ?? t.question : t.question;
        if (rec.input !== undefined && rec.input !== expected) stale++;
        seen.add(rec.taskId);
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
      coverage[m.label] = { stale, missing: tasks.filter((t) => !seen.has(t.id)).map((t) => t.id) };
    }
    if (!labels.length) continue;

    // kopt bench reference (same tasks, same metrics), if present
    const refPath = join(ROOT, 'bench', 'results', `${repo}${field === 'search' ? '' : `-${field}`}.json`);
    const ref = existsSync(refPath) ? readJson(refPath) : null;
    // `kopt bench` also scores these competitor files itself (strategies kirograph, codegraph):
    // keep only its own strategies, so that no competitor row appears twice.
    const isCompetitor = (s) => /^(kirograph|codegraph)(-|$)/.test(s) || labels.includes(s);
    const refStrategies = ref ? (ref.meta?.strategies ?? []).filter((s) => !isCompetitor(s)) : [];
    const refResults = ref ? (ref.results ?? []).filter((r) => byId.has(r.taskId) && refStrategies.includes(r.strategy)) : [];
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
    repoOut.inputs[field] = { aggregates: aggs, paired: pairs, perTask, coverage };

    if (field === 'search') {
      for (const r of all) globalResults.push({ ...r, taskId: `${repo}/${r.taskId}` });
      for (const a of aggs) {
        const m = repoMetas.find((x) => x.label === a.strategy && a.source === 'container');
        if (a.source !== 'container' && a.strategy !== 'kopt-pack' && a.strategy !== 'native-ranged') continue;
        const perTaskTokens = results.filter((r) => r.strategy === a.strategy && !r.error).map((r) => r.tokens);
        const refTokens = refResults.filter((r) => r.strategy === a.strategy && !r.error && !r.skipped).map((r) => r.tokens);
        overview.push({
          repo,
          language: taskFile.repo?.language ?? '',
          strategy: a.strategy,
          source: a.source,
          indexMs: m ? (m.indexOk ? m.indexMs : null) : null,
          indexOk: m ? m.indexOk : null,
          indexSizeBytes: m ? m.indexSizeBytes : null,
          queryMsMedian: m ? m.inputs?.search?.queryMsMedian ?? null : null,
          tasks: a.tasks,
          found: a.found,
          errors: a.errors,
          medianTokens: a.medianTokens,
          p90Tokens: a.p90Tokens,
          meanFileRecall: a.meanFileRecall,
          meanSymbolRecall: a.meanSymbolRecall,
          meanDefRecall: a.meanDefRecall,
          tokensPerFound: a.tokensPerFound,
          stale: coverage[a.strategy]?.stale ?? 0,
          missing: coverage[a.strategy]?.missing?.length ?? 0,
          tokenList: a.source === 'container' ? perTaskTokens : refTokens,
        });
      }
    }

    md.push('');
    md.push(`### ${repo}, input = \`${field}\``);
    md.push('');
    for (const [label, c] of Object.entries(coverage)) {
      if (c.stale || c.missing.length) {
        md.push(
          `> ${label}: ${c.stale ? `${c.stale} result(s) were produced with an input that no longer matches the task file (re-run). ` : ''}` +
            `${c.missing.length ? `${c.missing.length} task(s) have no result: ${c.missing.join(', ')}.` : ''}`,
        );
        md.push('');
      }
    }
    md.push('| strategy | source | found | file recall | symbol recall | def recall | median tok | p90 tok | tokens / found task | calls |');
    md.push('|---|---|---|---|---|---|---|---|---|---|');
    for (const a of aggs) {
      md.push(
        `| ${a.strategy} | ${a.source} | ${a.found}/${a.tasks}${a.errors ? ` (${a.errors} err)` : ''} | ${pct(a.meanFileRecall)} | ${pct(a.meanSymbolRecall)} ` +
          `| ${pct(a.meanDefRecall)} | ${a.tasks > a.errors ? num(a.medianTokens) : '-'} | ${a.tasks > a.errors ? num(a.p90Tokens) : '-'} | ${num(a.tokensPerFound)} | ${a.meanToolCalls.toFixed(1)} |`,
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

// ---------------------------------------------------------------------------------------------
// cross-repo overview (input = search)

function medianOf(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const ov = [];
ov.push('| repo | tool | index time | index size | median query | found | file recall | symbol recall | def recall | median tok | p90 tok | tokens / found task | failures |');
ov.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of overview) {
  const isRef = r.source !== 'container';
  const fails = isRef ? '-' : `${r.errors}${r.missing ? ` (+${r.missing} missing)` : ''}${r.stale ? ` (${r.stale} stale)` : ''}`;
  ov.push(
    `| ${r.repo} | ${isRef ? `*${r.strategy}* (kopt bench)` : r.strategy} | ${isRef ? '-' : r.indexOk === false ? 'FAILED' : secs(r.indexMs)} ` +
      `| ${isRef ? '-' : mb(r.indexSizeBytes)} | ${r.queryMsMedian === null ? '-' : `${num(r.queryMsMedian)} ms`} ` +
      `| ${r.found}/${r.tasks} | ${pct(r.meanFileRecall)} | ${pct(r.meanSymbolRecall)} | ${pct(r.meanDefRecall)} ` +
      `| ${r.tasks > r.errors ? num(r.medianTokens) : '-'} | ${r.tasks > r.errors ? num(r.p90Tokens) : '-'} | ${num(r.tokensPerFound)} | ${fails} |`,
  );
}
// totals per strategy over every repo it ran on
const totals = [];
for (const strategy of [...new Set(overview.map((r) => r.strategy))]) {
  const rows = overview.filter((r) => r.strategy === strategy);
  const tasksN = rows.reduce((a, r) => a + r.tasks, 0);
  const foundN = rows.reduce((a, r) => a + r.found, 0);
  const toks = rows.flatMap((r) => r.tokenList);
  const totalTok = toks.reduce((a, b) => a + b, 0);
  totals.push({
    strategy,
    source: rows[0].source === 'container' ? 'container' : 'kopt bench',
    repos: rows.length,
    tasks: tasksN,
    found: foundN,
    errors: rows.reduce((a, r) => a + (r.errors ?? 0), 0),
    medianTokens: medianOf(toks),
    tokensPerFound: foundN ? Math.round(totalTok / foundN) : null,
    indexMsTotal: rows.every((r) => r.indexMs !== null) ? rows.reduce((a, r) => a + r.indexMs, 0) : null,
  });
}
totals.sort((x, y) => (x.source === 'container' ? 0 : 1) - (y.source === 'container' ? 0 : 1));
const tot = [];
tot.push('| tool | repos | found | median tok (all tasks) | tokens / found task | total index time | failures |');
tot.push('|---|---|---|---|---|---|---|');
for (const t of totals) {
  tot.push(
    `| ${t.source === 'container' ? t.strategy : `*${t.strategy}* (kopt bench)`} | ${t.repos} | ${t.found}/${t.tasks} | ${num(t.medianTokens)} ` +
      `| ${num(t.tokensPerFound)} | ${t.source === 'container' ? (t.indexMsTotal === null ? '-' : secs(t.indexMsTotal)) : '-'} | ${t.source === 'container' ? t.errors : '-'} |`,
  );
}
summary.overview = overview.map(({ tokenList, ...r }) => r);
summary.totals = totals;

// pass-gated pairs over every repo (tasks found by both; ratio b/a of tokens)
const containerLabels = [...new Set(overview.filter((r) => r.source === 'container').map((r) => r.strategy))];
const refLabels = [...new Set(overview.filter((r) => r.source !== 'container').map((r) => r.strategy))];
const globalPairs = [];
for (const b of containerLabels) for (const a of refLabels) globalPairs.push(compare(a, b, globalResults));
for (let i = 0; i < containerLabels.length; i++)
  for (let j = i + 1; j < containerLabels.length; j++) globalPairs.push(compare(containerLabels[i], containerLabels[j], globalResults));
summary.pairs = globalPairs;
const gp = [];
gp.push('Pass-gated pairs over all repos (tokens b / a on the tasks found by both; < 1 means b is cheaper):');
gp.push('');
gp.push('| a | b | tasks run by both | found by both | only a | only b | median b/a | geo-mean b/a |');
gp.push('|---|---|---|---|---|---|---|---|');
for (const p of globalPairs) gp.push(`| ${p.a} | ${p.b} | ${p.nRun} | ${p.nBoth} | ${p.onlyA} | ${p.onlyB} | ${ratio(p.medianRatio)} | ${ratio(p.geoMeanRatio)} |`);

const overviewMd = [
  `Input = \`search\`, one call per task, default arguments. Generated ${summary.date.slice(0, 10)} by \`node bench/competitors/score.mjs\`.`,
  '*Italic* rows are the `kopt bench` reference strategies (host run, same tasks and metrics) where `bench/results/<repo>.json` exists.',
  '',
  ...tot,
  '',
  ...gp,
  '',
  ...ov,
];

const out = [...head, '', '## Overview (input = `search`)', '', ...overviewMd, ...md];
writeFileSync(join(RESULTS, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
writeFileSync(join(RESULTS, 'summary.md'), out.join('\n'));

// README: replace the block between the markers with the overview
const readmePath = join(HERE, 'README.md');
const START = '<!-- results:start (generated by score.mjs) -->';
const END = '<!-- results:end -->';
if (existsSync(readmePath)) {
  const readme = readFileSync(readmePath, 'utf8');
  const i = readme.indexOf(START);
  const j = readme.indexOf(END);
  if (i >= 0 && j > i) {
    writeFileSync(readmePath, readme.slice(0, i + START.length) + '\n' + overviewMd.join('\n') + '\n' + readme.slice(j));
  }
}
process.stdout.write(`score: wrote ${join(RESULTS, 'summary.md')} (${repos.length} repo(s))\n`);
