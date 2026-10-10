#!/usr/bin/env node
// Builds the benchmark documentation from the committed result files, so the Markdown page and the HTML page can
// never disagree with the data or with each other:
//
//   1. docs/BENCHMARKS.md: every table, chart and key number lives between generated markers and is rewritten from
//      the JSON files below (block markers `<!-- BEGIN generated:NAME -->` ... `<!-- END generated:NAME -->`,
//      inline values `<!--v:KEY-->...<!--/v-->`). The prose around them is written by hand.
//   2. README.md and docs/ARCHITECTURE.md: their marked numbers (inline values only) are rewritten the same way.
//   3. docs/benchmarks.html: the same Markdown as docs/BENCHMARKS.md, converted to one self-contained page (inline CSS, inline SVG charts,
//      light and dark themes, a data table next to every chart). No network, no dependencies.
//
// usage: node scripts/build-benchmarks-page.mjs           rewrite both files
//        node scripts/build-benchmarks-page.mjs --check   exit 1 when either file is out of date (writes nothing)
//
// Inputs (all committed): bench/results/summary.json and the per-repository bench/results/<repo>.json,
// bench/results/heldout/*.json, bench/results/agent-ab-final.json (and the run's wrapper logs in
// bench/agentab/logs/final, for its date), bench/results/compression.json, bench/results/scale-v02.json,
// bench/results/scale-elasticsearch.json.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MD_PATH = join(ROOT, 'docs', 'BENCHMARKS.md');
const HTML_PATH = join(ROOT, 'docs', 'benchmarks.html');
/** Other pages whose marked numbers (`<!--v:KEY-->...<!--/v-->`) are kept in sync with the same data. */
const VALUE_PAGES = ['README.md', 'docs/ARCHITECTURE.md', 'docs/COMMANDS.md', 'docs/HOW-IT-WORKS.md', 'docs/CONFIGURATION.md'];
const REPO_URL = 'https://github.com/dorian-richard/kiro-optimizer';
const BLOB = `${REPO_URL}/blob/main/`;
const CHECK = process.argv.includes('--check');

const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));

// ---------------------------------------------------------------------------------------------------------------
// Data

const S = readJson('bench/results/summary.json');
const AB = readJson('bench/results/agent-ab-final.json');
const C = readJson('bench/results/compression.json');
const SC = readJson('bench/results/scale-v02.json');
const SE = readJson('bench/results/scale-elasticsearch.json');
const PKG = readJson('package.json');

/** The final A/B run's wrapper logs (one JSONL line per tool call, with its UTC time): the JSON carries no date. */
const AB_LOGS = 'bench/agentab/logs/final';
/** The UTC time span of the tool calls logged in `dir`, e.g. `2026-10-09 (23:18-23:33 UTC)`. */
function logSpan(dir) {
  const times = [];
  for (const f of readdirSync(join(ROOT, dir)).filter((x) => x.endsWith('.jsonl'))) {
    for (const line of readFileSync(join(ROOT, dir, f), 'utf8').split('\n')) if (line.trim()) times.push(JSON.parse(line).ts);
  }
  if (!times.length) throw new Error(`${dir}: no logged tool call`);
  times.sort();
  const [lo, hi] = [times[0], times[times.length - 1]];
  const day = (t) => t.slice(0, 10), hm = (t) => t.slice(11, 16);
  return day(lo) === day(hi) ? `${day(lo)} (${hm(lo)}-${hm(hi)} UTC)` : `${day(lo)} ${hm(lo)} to ${day(hi)} ${hm(hi)} UTC`;
}

const HELDOUT_DIR = 'bench/results/heldout';
const heldoutFiles = readdirSync(join(ROOT, HELDOUT_DIR)).filter((f) => /^heldout-.*\.json$/.test(f)).sort();
const heldout = heldoutFiles.map((f) => ({ file: f, question: f.endsWith('-question.json'), data: readJson(`${HELDOUT_DIR}/${f}`) }));

const STRATS = ['kopt-pack', 'codegraph', 'kirograph', 'native-ranged', 'native-naive', 'kopt-hits+read'];
const NAME = {
  'kopt-pack': 'kopt (pack)',
  codegraph: 'CodeGraph',
  kirograph: 'KiroGraph',
  'native-ranged': 'native Kiro, ranged reads',
  'native-naive': 'native Kiro, whole files',
  'kopt-hits+read': 'kopt (hits + 2 reads)',
};
const LONG = {
  'kopt-pack': '**kopt**: one `kopt_find` call in pack mode',
  codegraph: 'CodeGraph 1.6.2: one `codegraph_explore` call',
  kirograph: 'KiroGraph 1.4.0: one `kirograph_context` call',
  'native-ranged': 'Native Kiro, disciplined: grep, then ±60 lines around the 4 best matches',
  'native-naive': 'Native Kiro, naive: grep, then the 3 most-hit files whole (2,000-line cap)',
  'kopt-hits+read': 'kopt: `kopt_find` hits, then `kopt_read` of the top 2',
};
const LANG = {
  java: 'Java', python: 'Python', typescript: 'TypeScript', javascript: 'JavaScript', c_sharp: 'C#', go: 'Go',
  kotlin: 'Kotlin', rust: 'Rust', php: 'PHP', ruby: 'Ruby', scala: 'Scala',
};
const total = (s) => S.totals.find((t) => t.strategy === s);
const rowStrat = (row, s) => row.strategies.find((x) => x.strategy === s);

// ---------------------------------------------------------------------------------------------------------------
// Formatting

const int = (n) => Math.round(n).toLocaleString('en-US');
const pct0 = (x) => `${Math.round(x * 100)}%`;
const pct1 = (x) => `${(x * 100).toFixed(1)}%`;
const rel = (x) => {
  const v = Math.round(x * 100);
  return v > 0 ? `+${v}%` : v < 0 ? `-${Math.abs(v)}%` : '0%';
};
const ci = (c) => `[${rel(c[0])}, ${rel(c[1])}]`;
const relCi = (m) => `${rel(m.totalRel)} ${ci(m.totalRelCI)}`;
const pval = (p) => (p < 0.001 ? 'p < 0.001' : p < 0.1 ? `p = ${p.toFixed(3)}` : `p = ${p.toFixed(2)}`);
const lowerIn = (m) => {
  const ties = m.n - m.bWins - m.aWins;
  return `${m.bWins}/${m.n}${ties ? ` (${ties} tie${ties > 1 ? 's' : ''})` : ''}`;
};
const date = (iso) => String(iso).slice(0, 10);
const kTok = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
const cell = (s) => String(s).replace(/\|/g, '\\|');

function mdTable(head, rows) {
  return [`| ${head.map(cell).join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// Derived numbers

function heldoutAgg(question, strategy) {
  let tasks = 0, found = 0, totalTokens = 0, sym = 0, file = 0, def = 0;
  const tokens = [];
  for (const h of heldout.filter((x) => x.question === question)) {
    for (const r of h.data.results.filter((x) => x.strategy === strategy)) {
      tasks++;
      tokens.push(r.tokens);
      totalTokens += r.tokens;
      if (r.recall.found) found++;
      sym += r.recall.symbolRecall;
      file += r.recall.fileRecall;
      def += r.recall.defRecall;
    }
  }
  tokens.sort((a, b) => a - b);
  const median = tokens.length ? (tokens.length % 2 ? tokens[(tokens.length - 1) / 2] : (tokens[tokens.length / 2 - 1] + tokens[tokens.length / 2]) / 2) : 0;
  return { tasks, found, median, perFound: found ? totalTokens / found : null, sym: sym / tasks, file: file / tasks, def: def / tasks };
}

function byKind() {
  const kinds = ['locate', 'explain', 'usage', 'impact'];
  const acc = {};
  for (const row of S.rows) for (const k of row.byKind) {
    const key = `${k.kind}|${k.strategy}`;
    acc[key] ??= { tasks: 0, found: 0 };
    acc[key].tasks += k.tasks;
    acc[key].found += k.found;
  }
  return { kinds, acc };
}

const repoResults = new Map();
/** The per-task results of one corpus repository (`bench/results/<repo>.json`), read once. */
const resultsOf = (repo) => {
  if (!repoResults.has(repo)) repoResults.set(repo, readJson(`bench/results/${repo}.json`).results);
  return repoResults.get(repo);
};

/** Tasks both strategies found, and the median of b/a tokens over them (from the per-repository result files). */
function pairRatio(a, b) {
  const ratios = [];
  for (const row of S.rows) {
    const by = new Map();
    for (const r of resultsOf(row.repo)) {
      if (!by.has(r.taskId)) by.set(r.taskId, {});
      by.get(r.taskId)[r.strategy] = r;
    }
    for (const v of by.values()) if (v[a]?.recall.found && v[b]?.recall.found) ratios.push(v[b].tokens / v[a].tokens);
  }
  ratios.sort((x, y) => x - y);
  const n = ratios.length;
  return { n, median: n % 2 ? ratios[(n - 1) / 2] : (ratios[n / 2 - 1] + ratios[n / 2]) / 2 };
}
const PAIR_CG = pairRatio('kopt-pack', 'codegraph');
const PAIR_NR = pairRatio('kopt-pack', 'native-ranged');

/** CodeGraph tasks whose one call returned at least `min` tokens: its output cap is 25,000 characters (~8,333 tokens). */
function codegraphNearCap(min = 8200) {
  let n = 0, tasks = 0;
  for (const row of S.rows) for (const r of resultsOf(row.repo)) {
    if (r.strategy !== 'codegraph') continue;
    tasks++;
    if (r.tokens >= min) n++;
  }
  return { n, tasks };
}
const CG_CAP = codegraphNearCap();

const EX = AB.analysis.explore;
const RN = AB.analysis.run;
const EXc = EX.cmp.all;
const RNc = RN.cmp.all;
const TT = AB.diagnosis.testTasks.summary;
const AUDIT = AB.diagnosis.transcriptAudit;
const KC = AB.diagnosis.koptCalls;
const prevRun = (id) => AB.prev.find((p) => p.run === id);
const R1 = prevRun('r1');
const R2 = prevRun('r2');
const POOL = AB.pooledAll.kinds;
const refsIncomplete = KC.flags.find((f) => f.refsIncomplete)?.refsIncomplete ?? [];
const refsTotal = Object.entries(KC.byStatus).filter(([k]) => k.startsWith('refs ')).reduce((s, [, v]) => s + v, 0);
const runFailing = KC.byStatus['run exit 1'] ?? 0;
const runPassing = KC.byStatus['run exit 0'] ?? 0;
const agents = AUDIT.agents;
const exTasks = EX.taskRows.length;
const rnTasks = RN.taskRows.length;
const reps = Math.round(EX.agg.A.runs / exTasks);
/**
 * Runs answered correctly, checked in both arms and under both graders (lenient and strict), with full symbol recall:
 * the prose says "every answer is correct in both arms", so the build fails when the data stops saying so.
 */
function correctInBothArms(an, label) {
  const { A, B } = an.agg;
  const all = (x) => x.foundStrict === x.runs && x.foundLenient === x.runs && x.symRecallStrict === 1 && x.symRecallLenient === 1;
  if (A.runs !== B.runs || !all(A) || !all(B)) {
    throw new Error(`agent-ab-final.json: not every ${label} answer is correct in both arms (A ${A.foundStrict}/${A.runs}, B ${B.foundStrict}/${B.runs} strict); fix the prose that says so`);
  }
  return `${B.runs}/${B.runs}`;
}
/** B/A session cost of one exploration task (measured, re-based), as in the per-task table. */
function exTaskRel(id) {
  const row = EX.taskRows.find(([a]) => a.task === id);
  if (!row) throw new Error(`agent-ab-final.json: no exploration task "${id}"`);
  const [a, b] = row;
  return rel(b.measuredRebased / a.measuredRebased - 1);
}
const ES = SC.repos.find((r) => r.id === 'elasticsearch');
const VS = SC.repos.find((r) => r.id === 'vscode');
const scaleCell = (tableId, rowLabel, col) => {
  const t = SC.tables.find((x) => x.id === tableId);
  const r = t.rows.find((x) => x.label === rowLabel);
  return r.values[t.columns.indexOf(col)];
};

// ---------------------------------------------------------------------------------------------------------------
// Inline values (`<!--v:KEY-->...<!--/v-->`)

const kp = total('kopt-pack');
const cg = total('codegraph');
const kg = total('kirograph');
const nr = total('native-ranged');
const nn = total('native-naive');
const hoK = heldoutAgg(false, 'kopt-pack');
const hoR = heldoutAgg(false, 'native-ranged');
const hoKq = heldoutAgg(true, 'kopt-pack');
const hoRq = heldoutAgg(true, 'native-ranged');

const VALUES = {
  'offline.tasks': String(kp.tasks),
  'offline.repos': String(S.rows.length),
  'offline.date': date(S.date),
  'kopt.found': `${kp.found}/${kp.tasks} (${pct0(kp.foundRate)})`,
  'kopt.median': int(kp.medianTokens),
  'kopt.perFound': int(kp.tokensPerFound),
  'kopt.sym': pct0(kp.meanSymbolRecall),
  'codegraph.found': `${cg.found}/${cg.tasks} (${pct0(cg.foundRate)})`,
  'codegraph.median': int(cg.medianTokens),
  'codegraph.perFound': int(cg.tokensPerFound),
  'codegraph.nearCap': `${CG_CAP.n} of ${CG_CAP.tasks}`,
  'kopt.def': pct0(kp.meanDefRecall),
  'codegraph.def': pct0(cg.meanDefRecall),
  'ranged.def': pct0(nr.meanDefRecall),
  'naive.def': pct0(nn.meanDefRecall),
  'kirograph.found': `${kg.found}/${kg.tasks} (${pct0(kg.foundRate)})`,
  'kirograph.perFound': int(kg.tokensPerFound),
  'ranged.found': `${nr.found}/${nr.tasks} (${pct0(nr.foundRate)})`,
  'ranged.median': int(nr.medianTokens),
  'ranged.perFound': int(nr.tokensPerFound),
  'naive.found': `${nn.found}/${nn.tasks} (${pct0(nn.foundRate)})`,
  'naive.median': int(nn.medianTokens),
  'ratio.medianRanged': `${(nr.medianTokens / kp.medianTokens).toFixed(1)}x`,
  'ratio.medianCodegraph': `${(cg.medianTokens / kp.medianTokens).toFixed(1)}x`,
  'misses': `${S.failureTotals.missed}/${S.failureTotals.tasks}`,
  'pair.codegraph.n': String(PAIR_CG.n),
  'pair.codegraph.ratio': `${PAIR_CG.median.toFixed(1)}x`,
  'pair.ranged.n': String(PAIR_NR.n),
  'pair.ranged.ratio': `${PAIR_NR.median.toFixed(1)}x`,
  'heldout.kopt': `${hoK.found}/${hoK.tasks} (${pct0(hoK.found / hoK.tasks)})`,
  'heldout.ranged': `${hoR.found}/${hoR.tasks} (${pct0(hoR.found / hoR.tasks)})`,
  'heldout.koptQ': `${hoKq.found}/${hoKq.tasks}`,
  'heldout.rangedQ': `${hoRq.found}/${hoRq.tasks}`,
  'ab.agents': String(agents),
  'ab.reps': String(reps),
  'ab.build': AB.diagnosis.build.final,
  'ab.toolCalls': int(AUDIT.wrappedToolCalls),
  'ab.koptCalls': String(KC.total),
  'ab.exTasks': String(exTasks),
  'ab.rnTasks': String(rnTasks),
  'ab.exRuns': correctInBothArms(EX, 'exploration'),
  'ab.rnRuns': correctInBothArms(RN, 'test-diagnosis'),
  'ab.mdUsage': exTaskRel('md-usage-cancel-transaction'),
  'ab.djUsage': exTaskRel('dj-usage-add-new-csrf-cookie'),
  'ab.lvLocate': exTaskRel('lv-locate-cache-flexible'),
  'ab.ex.primary': relCi(EXc.measuredRebased),
  'ab.ex.primaryLower': lowerIn(EXc.measuredRebased),
  'ab.ex.primaryP': pval(EXc.measuredRebased.signP),
  'ab.ex.read': relCi(EXc.read),
  'ab.ex.requests': relCi(EXc.measuredRequests),
  'ab.ex.calls': relCi(EXc.calls),
  'ab.rn.primary': relCi(RNc.measuredRebased),
  'ab.rn.read': relCi(RNc.read),
  'ab.rn.readSeen': relCi(RNc.readSeen),
  'ab.pooled.ex': relCi(POOL.explore.metrics.measuredRebased),
  'ab.pooled.exRead': relCi(POOL.explore.metrics.read),
  'ab.koptPrompt': `+${AB.koptPrompt.explore.tokens}`,
  'ab.koptPromptR2': `+${AB.diagnosis.promptOverheadPerRequest.r2.explore}`,
  'ab.koptPromptR1': `+${AB.diagnosis.promptOverheadPerRequest.r1.explore}`,
  'ab.refsIncomplete': `${refsIncomplete.length} of ${refsTotal}`,
  'ab.runFailing': String(runFailing),
  'ab.runPassing': String(runPassing),
  'ab.rawTest': kTok(RN.agg.B.rawTestTokens),
  'ab.koptTest': kTok(RN.agg.B.testRead),
  'ab.testReduction': rel(RN.agg.B.testRead / RN.agg.B.rawTestTokens - 1),
  'ab.aDelivered': kTok(AB.diagnosis.deliveredTokens.totals.A.delivered),
  'ab.aLogged': kTok(AB.diagnosis.deliveredTokens.totals.A.logged),
  'ab.adoptR2': String(AB.diagnosis.koptAdoption.explore.r2.koptCallsPerRun),
  'ab.adoptFinal': String(AB.diagnosis.koptAdoption.explore.final.koptCallsPerRun),
  'ab.driftA': relCi(R1.kinds.explore.metrics.measuredRebased.driftA),
  'compress.fixtures': String(C.totals.all.fixtures),
  'compress.generated': String(C.totals.generated.fixtures),
  'compress.real': String(C.totals.real.fixtures),
  'compress.raw': int(C.totals.all.rawTokens),
  'compress.out': int(C.totals.all.outTokens),
  'compress.reduction': pct1(C.totals.all.reduction),
  'compress.min': pct1(C.totals.all.minReduction),
  'scale.esIndexed': int(ES.indexedFiles),
  'scale.esTracked': int(ES.trackedFiles),
  'scale.vsIndexed': int(VS.indexedFiles),
  'scale.esFind': scaleCell('mcp-first-build', 'first kopt_find answer', 'elasticsearch after'),
  'scale.esRefs': scaleCell('mcp-first-build', 'first kopt_refs answer', 'elasticsearch after'),
  'scale.esIndex': scaleCell('cli-first-build', 'index on disk', 'elasticsearch after'),
  'scale.esRss': scaleCell('cli-first-build', 'peak memory (RSS)', 'elasticsearch after'),
  'scale.esCli': scaleCell('cli-first-build', 'wall time', 'elasticsearch after'),
  'scale.queryP50': `${SE.steps.queries.p50Ms} ms`,
  'version': PKG.version,
};

// ---------------------------------------------------------------------------------------------------------------
// Charts: Mermaid source for the Markdown, inline SVG for the HTML page

function mermaidBars(title, axis, labels, values, max) {
  return [
    '```mermaid',
    '%%{init: {"xyChart": {"showDataLabel": true}}}%%',
    'xychart-beta horizontal',
    `  title "${title}"`,
    `  x-axis [${labels.map((l) => `"${l}"`).join(', ')}]`,
    `  y-axis "${axis}" 0 --> ${max}`,
    `  bar [${values.join(', ')}]`,
    '```',
  ].join('\n');
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const niceMax = (v) => {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
};
/** Clean tick values from 0 to vmax: a 1 / 2 / 2.5 / 5 step giving about six intervals. */
function niceTicks(vmax) {
  const raw = vmax / 6;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => x >= raw);
  const ticks = [];
  for (let t = 0; t <= vmax + step * 1e-9; t += step) ticks.push(Number(t.toPrecision(12)));
  return ticks;
}
/** A bar path with a 4px rounded data end and a square baseline. */
function barPath(x0, y, w, h, r = 4) {
  if (w <= 0) return '';
  const rr = Math.min(r, w, h / 2);
  return `M${x0},${y}H${x0 + w - rr}Q${x0 + w},${y} ${x0 + w},${y + rr}V${y + h - rr}Q${x0 + w},${y + h} ${x0 + w - rr},${y + h}H${x0}Z`;
}

/** Horizontal bars, one series. rows: {label, value, text, emphasis?}. */
function svgBars({ id, title, desc, rows, max, axisLabel, emphasis = true, format = int }) {
  const W = 720, labelW = 200, valueW = 150, top = 30, rowH = 30, barH = 16;
  const plotW = W - labelW - valueW - 16;
  const H = top + rows.length * rowH + 34;
  const x0 = labelW + 8;
  const vmax = max ?? niceMax(Math.max(...rows.map((r) => r.value)));
  const scale = (v) => (v / vmax) * plotW;
  const ticks = niceTicks(vmax);
  const parts = [];
  parts.push(`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="${id}-t ${id}-d" xmlns="http://www.w3.org/2000/svg">`);
  parts.push(`<title id="${id}-t">${esc(title)}</title><desc id="${id}-d">${esc(desc)}</desc>`);
  for (const t of ticks) {
    const x = x0 + scale(t);
    parts.push(`<line class="grid" x1="${x}" x2="${x}" y1="${top - 6}" y2="${top + rows.length * rowH}"/>`);
    parts.push(`<text class="tick" x="${x}" y="${top + rows.length * rowH + 16}" text-anchor="middle">${esc(format(t))}</text>`);
  }
  parts.push(`<text class="axis-label" x="${x0 + plotW / 2}" y="${H - 4}" text-anchor="middle">${esc(axisLabel)}</text>`);
  rows.forEach((r, i) => {
    const y = top + i * rowH + (rowH - barH) / 2;
    const cls = !emphasis ? 'bar s1' : r.emphasis ? 'bar s1' : 'bar muted';
    parts.push(`<g class="mark"><title>${esc(`${r.label}: ${r.text}`)}</title>`);
    parts.push(`<rect class="hit" x="0" y="${top + i * rowH}" width="${W}" height="${rowH}"/>`);
    parts.push(`<text class="label${r.emphasis && emphasis ? ' strong' : ''}" x="${labelW}" y="${y + barH / 2 + 4.5}" text-anchor="end">${esc(r.label)}</text>`);
    parts.push(`<path class="${cls}" d="${barPath(x0, y, Math.max(scale(r.value), 1.5), barH)}"/>`);
    parts.push(`<text class="value" x="${x0 + Math.max(scale(r.value), 1.5) + 6}" y="${y + barH / 2 + 4.5}">${esc(r.text)}</text>`);
    parts.push('</g>');
  });
  parts.push(`<line class="baseline" x1="${x0}" x2="${x0}" y1="${top - 6}" y2="${top + rows.length * rowH}"/>`);
  parts.push('</svg>');
  return parts.join('');
}

/** Grouped horizontal bars: groups {label, items: [{series, value, text}]}, series [{key, name}]. */
function svgGrouped({ id, title, desc, groups, series, max, axisLabel, format }) {
  const W = 720, labelW = 150, valueW = 70, legendH = 34, barH = 12, gap = 2, groupGap = 14;
  const groupH = series.length * (barH + gap) - gap + groupGap;
  const top = legendH + 8;
  const plotW = W - labelW - valueW - 16;
  const H = top + groups.length * groupH + 30;
  const x0 = labelW + 8;
  const scale = (v) => (v / max) * plotW;
  const parts = [];
  parts.push(`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="${id}-t ${id}-d" xmlns="http://www.w3.org/2000/svg">`);
  parts.push(`<title id="${id}-t">${esc(title)}</title><desc id="${id}-d">${esc(desc)}</desc>`);
  let lx = x0;
  series.forEach((s, i) => {
    parts.push(`<rect class="bar s${i + 1}" x="${lx}" y="10" width="12" height="12" rx="2"/>`);
    parts.push(`<text class="legend" x="${lx + 18}" y="20.5">${esc(s.name)}</text>`);
    lx += 18 + s.name.length * 7.4 + 28;
  });
  for (const t of niceTicks(max)) {
    const x = x0 + scale(t);
    parts.push(`<line class="grid" x1="${x}" x2="${x}" y1="${top - 4}" y2="${top + groups.length * groupH - groupGap}"/>`);
    parts.push(`<text class="tick" x="${x}" y="${top + groups.length * groupH - groupGap + 16}" text-anchor="middle">${esc(format(t))}</text>`);
  }
  parts.push(`<text class="axis-label" x="${x0 + plotW / 2}" y="${H - 2}" text-anchor="middle">${esc(axisLabel)}</text>`);
  groups.forEach((g, gi) => {
    const gy = top + gi * groupH;
    const mid = gy + (series.length * (barH + gap) - gap) / 2;
    parts.push(`<text class="label" x="${labelW}" y="${mid + 4.5}" text-anchor="end">${esc(g.label)}</text>`);
    g.items.forEach((it, si) => {
      const y = gy + si * (barH + gap);
      const w = Math.max(scale(it.value), 1.5);
      parts.push(`<g class="mark"><title>${esc(`${g.label}, ${series[si].name}: ${it.text}`)}</title>`);
      parts.push(`<rect class="hit" x="${x0}" y="${y - 1}" width="${plotW + valueW}" height="${barH + 2}"/>`);
      parts.push(`<path class="bar s${si + 1}" d="${barPath(x0, y, w, barH, 3)}"/>`);
      parts.push(`<text class="value small" x="${x0 + w + 5}" y="${y + barH - 2}">${esc(it.text)}</text>`);
      parts.push('</g>');
    });
  });
  parts.push(`<line class="baseline" x1="${x0}" x2="${x0}" y1="${top - 4}" y2="${top + groups.length * groupH - groupGap}"/>`);
  parts.push('</svg>');
  return parts.join('');
}

/** Dot and whisker: rows {label, m (cmp entry), primary?}; x = relative B/A - 1 with its 95% CI. */
function svgForest({ id, title, desc, rows }) {
  const W = 720, labelW = 190, valueW = 150, top = 40, rowH = 32;
  const lo = Math.min(-0.5, ...rows.map((r) => r.m.totalRelCI[0]));
  const hi = Math.max(0.2, ...rows.map((r) => r.m.totalRelCI[1]));
  const dmin = Math.floor(lo * 10) / 10, dmax = Math.ceil(hi * 10) / 10;
  const plotW = W - labelW - valueW - 24;
  const x0 = labelW + 12;
  const sx = (v) => x0 + ((v - dmin) / (dmax - dmin)) * plotW;
  const H = top + rows.length * rowH + 36;
  const parts = [];
  parts.push(`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="${id}-t ${id}-d" xmlns="http://www.w3.org/2000/svg">`);
  parts.push(`<title id="${id}-t">${esc(title)}</title><desc id="${id}-d">${esc(desc)}</desc>`);
  const step = dmax - dmin > 1.2 ? 0.4 : 0.2;
  for (let t = Math.ceil(dmin / step) * step; t <= dmax + 1e-9; t += step) {
    const x = sx(t);
    parts.push(`<line class="grid" x1="${x}" x2="${x}" y1="${top - 8}" y2="${top + rows.length * rowH}"/>`);
    parts.push(`<text class="tick" x="${x}" y="${top + rows.length * rowH + 16}" text-anchor="middle">${esc(rel(t))}</text>`);
  }
  parts.push(`<line class="zero" x1="${sx(0)}" x2="${sx(0)}" y1="${top - 8}" y2="${top + rows.length * rowH}"/>`);
  parts.push(`<circle class="dot" cx="${x0 + 5}" cy="14" r="5"/><text class="legend" x="${x0 + 16}" y="18.5">95% CI excludes 0</text>`);
  parts.push(`<circle class="dot open" cx="${x0 + 160}" cy="14" r="5"/><text class="legend" x="${x0 + 171}" y="18.5">95% CI includes 0</text>`);
  parts.push(`<text class="axis-label" x="${x0 + plotW / 2}" y="${H - 4}" text-anchor="middle">B vs A (kopt vs stock), relative difference with its 95% CI; left of 0 = kopt lower</text>`);
  rows.forEach((r, i) => {
    const cy = top + i * rowH + rowH / 2;
    const [a, b] = r.m.totalRelCI;
    const sig = b < 0 || a > 0;
    parts.push(`<g class="mark"><title>${esc(`${r.label}: ${relCi(r.m)}`)}</title>`);
    parts.push(`<rect class="hit" x="0" y="${top + i * rowH}" width="${W}" height="${rowH}"/>`);
    parts.push(`<text class="label${r.primary ? ' strong' : ''}" x="${labelW}" y="${cy + 4.5}" text-anchor="end">${esc(r.label)}</text>`);
    parts.push(`<line class="whisker" x1="${sx(a)}" x2="${sx(b)}" y1="${cy}" y2="${cy}"/>`);
    parts.push(`<circle class="${sig ? 'dot' : 'dot open'}" cx="${sx(r.m.totalRel)}" cy="${cy}" r="5"/>`);
    parts.push(`<text class="value${r.primary ? ' strong' : ''}" x="${W - valueW + 6}" y="${cy + 4.5}">${esc(relCi(r.m))}</text>`);
    parts.push('</g>');
  });
  parts.push('</svg>');
  return parts.join('');
}

// ---------------------------------------------------------------------------------------------------------------
// Blocks: { md, html? } (html defaults to the Markdown converted)

const order = STRATS;
const strategyRows = order.map((s) => ({ s, t: total(s) }));

const EX_ROWS = [
  ['measuredRebased', 'Measured session cost, re-based to a 12k prefix (primary)', true],
  ['cost12kKopt', 'Modeled cost: 12k prefix + kopt\'s measured prompt on every arm-B request'],
  ['cost12k', 'Modeled cost: 12k prefix + tokens read so far (v0.1 formula)'],
  ['read', 'Tokens read (tool output)'],
  ['measuredRequests', 'Model requests'],
  ['calls', 'Tool calls'],
  ['measuredContext', 'Measured input context, raw (agent harness prefix included)'],
];
const RN_ROWS = [
  ['measuredRebased', 'Measured session cost, re-based to a 12k prefix (primary)', true],
  ['cost12kKopt', 'Modeled cost: 12k prefix + kopt\'s prompt (wrapper count)'],
  ['read', 'Tokens read, as logged by the wrapper'],
  ['readSeen', 'Tokens read, as the agent received them'],
  ['measuredRequests', 'Model requests'],
  ['calls', 'Tool calls'],
];
/** A per-pass count: the mean over repetitions can end in .5, which must not be rounded away (37.5, not 38). */
const passCount = (x) => (Number.isInteger(x) ? int(x) : x.toFixed(1));
const sumNote = (key, m) => (key === 'measuredRequests' || key === 'calls' ? ` (${passCount(m.sumA)} vs ${passCount(m.sumB)} per pass)` : '');

function abTable(cmp, rows) {
  return mdTable(['Measure, B (kopt) vs A (stock), paired by task', 'B/A [95% CI]', 'B lower in', 'Sign test'], rows.map(([k, label, primary]) => {
    const m = cmp[k];
    const l = `${label}${sumNote(k, m)}`;
    return [primary ? `**${l}**` : l, primary ? `**${relCi(m)}**` : relCi(m), lowerIn(m), pval(m.signP)];
  }));
}

function earlierTable(kind) {
  const metrics = [['measuredRebased', 'measured session cost, re-based'], ['cost12kKopt', 'cost12k + kopt prompt'], ['read', 'tokens read'], ['measuredRequests', 'model requests'], ['calls', 'tool calls']];
  const head = ['Metric', 'r1: B/A', ...(kind === 'explore' ? ['r2: B/A'] : []), 'final: B/A', 'Arm A drift, final vs r1', 'Final B vs mean of both A runs (r1)'];
  return mdTable(head, metrics.map(([k, label]) => {
    const a = R1.kinds[kind].metrics[k];
    const b = kind === 'explore' ? R2.kinds.explore.metrics[k] : null;
    return [label, relCi(a.prevBvsA), ...(b ? [relCi(b.prevBvsA)] : []), relCi(a.curBvsA), relCi(a.driftA), relCi(a.curBvsPooledA)];
  }));
}

function pooledTable() {
  const metrics = [['measuredRebased', 'measured session cost, re-based'], ['cost12kKopt', 'cost12k + kopt prompt'], ['cost12k', 'cost12k'], ['read', 'tokens read'], ['measuredRequests', 'model requests'], ['calls', 'tool calls']];
  const rows = [];
  for (const kind of ['explore', 'run']) {
    const p = POOL[kind];
    for (const [k, label] of metrics) {
      const m = p.metrics[k];
      if (!m) continue;
      rows.push([kind === 'explore' ? `exploration (${p.tasks.length})` : `test diagnosis (${p.tasks.length})`, p.runs.join(' + '), String(p.repsPerArm), label, relCi(m), lowerIn(m), pval(m.signP)]);
    }
  }
  return mdTable(['Tasks', 'Runs', 'Runs per arm and task', 'Metric', 'Pooled B/A [95% CI]', 'B lower in', 'Sign test'], rows);
}

function taskTable(an) {
  return mdTable(['Task', 'A: calls', 'B: calls (kopt)', 'A: tokens read', 'B: tokens read', 'A: session cost', 'B: session cost', 'B/A session cost'], an.taskRows.map(([a, b]) => [
    `\`${a.task}\``,
    String(a.calls), `${b.calls} (${b.koptCalls})`,
    int(a.read), int(b.read),
    int(a.measuredRebased), int(b.measuredRebased),
    rel(b.measuredRebased / a.measuredRebased - 1),
  ]));
}

function testAdjustedTable() {
  const n = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
  const row = (label, calls, read, cost) => [label, `${rel(calls.rel)} ${ci(calls.ci95)} (${n(calls.A)} vs ${n(calls.B)})`, `${rel(read.rel)} ${ci(read.ci95)}`, `${rel(cost.rel)} ${ci(cost.ci95)}`, `${read.bLower}/${rnTasks}`];
  return mdTable(['Calls counted (same rules for both arms)', 'Tool calls (A vs B)', 'Tokens received', 'Modeled cost, as received', 'B lower in (tokens received)'], [
    row('every call', TT['all.calls'], TT['all.readSeen'], TT['all.cost12kKoptSeen']),
    row('flaky-test chasing and harness timeouts removed', TT['adjusted.calls'], TT['adjusted.readSeen'], TT['adjusted.cost12kKoptSeen']),
    row('up to the first call that shows the injected bug line', TT['adjustedToFirstSight.calls'], TT['adjustedToFirstSight.readSeen'], TT['adjustedToFirstSight.cost12kKoptSeen']),
  ]);
}

function scaleTables() {
  const out = [];
  for (const t of SC.tables) {
    out.push(`**${t.title}**`, '', mdTable(['', ...t.columns.map((c) => c.replace(/^vscode/, 'VS Code'))], t.rows.map((r) => [r.label, ...r.values])));
    if (t.notes.length) out.push('', ...t.notes.map((n) => `- ${n}`));
    out.push('');
  }
  return out.join('\n').trim();
}

const kindAgg = byKind();
const BLOCKS = {
  headline: () => mdTable(['Strategy (one exploration step)', 'Found (of ' + kp.tasks + ')', 'Median tokens per task', 'Tokens per found task', 'Mean symbol recall', 'Mean file recall', 'Mean definition recall'],
    strategyRows.map(({ s, t }) => [LONG[s], s === 'kopt-pack' ? `**${t.found} (${pct0(t.foundRate)})**` : `${t.found} (${pct0(t.foundRate)})`, int(t.medianTokens), int(t.tokensPerFound), pct0(t.meanSymbolRecall), pct0(t.meanFileRecall), pct0(t.meanDefRecall)])),
  'chart-found': {
    md: () => mermaidBars(`Tasks found, of ${kp.tasks} (higher is better)`, 'tasks found', order.map((s) => NAME[s]), order.map((s) => total(s).found), kp.tasks),
    svg: () => svgBars({ id: 'c-found', title: `Tasks found, of ${kp.tasks} (higher is better)`, desc: 'Horizontal bars: tasks whose gold files and symbols all appear in one exploration step, per strategy.', axisLabel: `tasks found, of ${kp.tasks}`, max: kp.tasks, format: int, rows: order.map((s) => ({ label: NAME[s], value: total(s).found, text: `${total(s).found} (${pct0(total(s).foundRate)})`, emphasis: s === 'kopt-pack' })) }),
  },
  'chart-median': {
    md: () => mermaidBars('Median tokens per task (lower is better)', 'tokens', order.map((s) => NAME[s]), order.map((s) => Math.round(total(s).medianTokens)), niceMax(nn.medianTokens)),
    svg: () => svgBars({ id: 'c-median', title: 'Median tokens returned per task (lower is better)', desc: 'Horizontal bars: median tokens one exploration step returns to the model, per strategy.', axisLabel: 'median tokens per task (characters / 3)', format: int, rows: order.map((s) => ({ label: NAME[s], value: total(s).medianTokens, text: int(total(s).medianTokens), emphasis: s === 'kopt-pack' })) }),
  },
  'chart-perfound': {
    md: () => mermaidBars('Tokens per found task, failures included (lower is better)', 'tokens', order.map((s) => NAME[s]), order.map((s) => Math.round(total(s).tokensPerFound)), niceMax(Math.max(...order.map((s) => total(s).tokensPerFound)))),
    svg: () => svgBars({ id: 'c-perfound', title: 'Tokens per found task, failures included (lower is better)', desc: 'Horizontal bars: all tokens a strategy returned over the corpus divided by the tasks it found.', axisLabel: 'tokens per found task', format: int, rows: order.map((s) => ({ label: NAME[s], value: total(s).tokensPerFound, text: int(total(s).tokensPerFound), emphasis: s === 'kopt-pack' })) }),
  },
  'per-language-found': () => {
    const cols = ['kopt-pack', 'codegraph', 'kirograph', 'native-ranged', 'native-naive'];
    const rows = S.rows.map((r) => {
      const vals = cols.map((s) => rowStrat(r, s).found);
      const best = Math.max(...vals);
      return [LANG[r.language] ?? r.language, `${r.repo}@${r.tag}`, String(r.tasks), ...vals.map((v) => (v === best ? `**${v}**` : String(v)))];
    });
    rows.push(['**all**', `${S.rows.length} repositories`, String(kp.tasks), ...cols.map((s) => `**${total(s).found}**`)]);
    return mdTable(['Language', 'Repository', 'Tasks', 'kopt (pack)', 'CodeGraph', 'KiroGraph', 'native ranged', 'native whole files'], rows);
  },
  'chart-lang': {
    md: () => '',
    svg: () => {
      const series = [{ key: 'kopt-pack', name: 'kopt (pack)' }, { key: 'codegraph', name: 'CodeGraph' }, { key: 'native-ranged', name: 'native Kiro, ranged reads' }];
      return svgGrouped({
        id: 'c-lang', title: 'Share of tasks found, per language', desc: 'Grouped horizontal bars, one group per language: share of tasks found by kopt (pack), CodeGraph and native ranged reads.',
        axisLabel: 'share of the repository\'s tasks found', max: 1, format: pct0, series,
        groups: S.rows.map((r) => ({ label: `${LANG[r.language]} (${r.repo})`, items: series.map((x) => { const v = rowStrat(r, x.key); return { value: v.found / v.tasks, text: `${v.found}/${v.tasks}` }; }) })),
      });
    },
  },
  'per-language-tokens': () => {
    const cols = ['kopt-pack', 'codegraph', 'kirograph', 'native-ranged', 'native-naive'];
    const rows = S.rows.map((r) => [LANG[r.language] ?? r.language, r.repo, ...cols.map((s) => int(rowStrat(r, s).medianTokens)), int(rowStrat(r, 'kopt-pack').tokensPerFound), pct0(rowStrat(r, 'kopt-pack').meanSymbolRecall)]);
    rows.push(['**all**', '', ...cols.map((s) => `**${int(total(s).medianTokens)}**`), `**${int(kp.tokensPerFound)}**`, `**${pct0(kp.meanSymbolRecall)}**`]);
    return mdTable(['Language', 'Repository', 'kopt median', 'CodeGraph median', 'KiroGraph median', 'native ranged median', 'native whole-file median', 'kopt tokens per found task', 'kopt symbol recall'], rows);
  },
  'by-kind': () => {
    const cols = ['kopt-pack', 'codegraph', 'kirograph', 'native-ranged', 'native-naive'];
    return mdTable(['Task kind', 'Tasks', ...cols.map((s) => NAME[s])], kindAgg.kinds.map((k) => {
      const t = kindAgg.acc[`${k}|kopt-pack`].tasks;
      return [k, String(t), ...cols.map((s) => `${kindAgg.acc[`${k}|${s}`].found} (${pct0(kindAgg.acc[`${k}|${s}`].found / t)})`)];
    }));
  },
  misses: () => {
    const label = { ranking: 'ranked out of the pack, or the words of the question do not match the code', 'unresolved-refs': 'unresolved references (a caller or callee the index could not link)', extraction: 'extraction gap (the parser missed the declaration)', 'budget-format': 'shown, but over the token budget or without its path', 'multi-step': 'needs a second step (`kopt_refs` or a read)' };
    return mdTable(['Primary cause of a kopt (pack) miss', 'Tasks'], Object.entries(S.failureTotals.byCause).map(([k, v]) => [label[k] ?? k, String(v)]).concat([['**all misses**', `**${S.failureTotals.missed} of ${S.failureTotals.tasks}**`]]));
  },
  'index-quality': () => mdTable(['Language', 'Repository', 'KLOC', 'Files indexed', 'Symbols', 'Index build', 'References resolved, of in-repo names', 'Precision sample'],
    S.rows.map((r) => [LANG[r.language], r.repo, int(r.loc / 1000), int(r.index.files), int(r.index.symbols), `${(r.index.durationMs / 1000).toFixed(1)} s`, pct0(r.quality.resolvedOfCandidates), `${pct0(r.quality.precisionRate)} (n=${r.quality.precisionSampled})`])),
  heldout: () => {
    const rows = [];
    for (const [q, label] of [[false, 'search phrase'], [true, 'raw question']]) {
      for (const s of ['kopt-pack', 'kopt-hits+read', 'native-ranged', 'native-naive']) {
        const a = heldoutAgg(q, s);
        if (!a.tasks) continue;
        rows.push([label, s === 'kopt-pack' ? `**${NAME[s]}**` : NAME[s], s === 'kopt-pack' ? `**${a.found}/${a.tasks} (${pct0(a.found / a.tasks)})**` : `${a.found}/${a.tasks} (${pct0(a.found / a.tasks)})`, int(a.median), a.perFound == null ? 'n/a' : int(a.perFound), `${pct0(a.sym)} / ${pct0(a.file)} / ${pct0(a.def)}`]);
      }
    }
    return mdTable(['Input', 'Strategy', 'Found', 'Median tokens', 'Tokens per found task', 'Symbol / file / definition recall'], rows);
  },
  'compression-totals': () => {
    const label = { all: 'all fixtures', exit0: 'exit 0 (passing runs, git)', exitNonZero: 'exit non-zero (failures)', real: 'real runs', generated: 'generated fixtures' };
    return mdTable(['Set', 'Fixtures', 'Raw tokens', 'kopt tokens', 'Reduction (total)', 'Median reduction', 'Smallest reduction'],
      Object.entries(C.totals).map(([k, t]) => [label[k] ?? k, String(t.fixtures), int(t.rawTokens), int(t.outTokens), pct1(t.reduction), pct1(t.medianReduction), pct1(t.minReduction)]));
  },
  'compression-family': () => mdTable(['Tool family', 'Fixtures', 'Raw tokens', 'kopt tokens', 'Reduction', 'Smallest reduction'],
    C.byFamily.map((f) => [f.family, String(f.fixtures), int(f.rawTokens), int(f.outTokens), pct1(f.reduction), pct1(f.minReduction)])),
  'chart-compress': {
    md: () => mermaidBars('kopt_run filters: tokens removed, per tool family (%)', 'reduction %', C.byFamily.map((f) => f.family), C.byFamily.map((f) => Number((f.reduction * 100).toFixed(1))), 100),
    svg: () => svgBars({ id: 'c-compress', title: 'kopt_run filters: share of the raw output removed, per tool family', desc: 'Horizontal bars: total reduction of the committed fixtures of each tool family at the default 900-token budget.', axisLabel: 'share of the raw output removed', max: 1, emphasis: false, format: pct0, rows: C.byFamily.map((f) => ({ label: f.family, value: f.reduction, text: `${pct1(f.reduction)} (${int(f.rawTokens)} → ${int(f.outTokens)})` })) }),
  },
  'compression-smallest': () => mdTable(['Fixture', 'Command', 'Origin', 'Raw tokens', 'kopt tokens', 'Reduction'],
    [...C.rows].sort((a, b) => a.reduction - b.reduction).slice(0, 6).map((r) => [r.fixture, `\`${r.command}\``, r.origin, int(r.rawTokens), int(r.outTokens), pct1(r.reduction)])),
  'ab-explore': () => abTable(EXc, EX_ROWS),
  'chart-ab-explore': {
    md: () => '',
    svg: () => svgForest({ id: 'c-abx', title: `Exploration, ${exTasks} tasks: kopt (B) vs stock (A)`, desc: 'Dot and whisker chart: relative difference of each measure with its 95% bootstrap confidence interval; a filled dot means the interval excludes zero.', rows: EX_ROWS.slice(0, 6).map(([k, , primary], i) => ({ label: ['Session cost (primary)', 'Modeled cost + kopt prompt', 'Modeled cost (v0.1)', 'Tokens read', 'Model requests', 'Tool calls'][i], m: EXc[k], primary })) }),
  },
  'ab-test': () => abTable(RNc, RN_ROWS),
  'chart-ab-test': {
    md: () => '',
    svg: () => svgForest({ id: 'c-abt', title: `Test diagnosis, ${rnTasks} tasks: kopt (B) vs stock (A)`, desc: 'Dot and whisker chart: relative difference of each measure with its 95% bootstrap confidence interval; a filled dot means the interval excludes zero.', rows: RN_ROWS.map(([k, , primary], i) => ({ label: ['Session cost (primary)', 'Modeled cost + kopt prompt', 'Tokens read, logged', 'Tokens read, received', 'Model requests', 'Tool calls'][i], m: RNc[k], primary })) }),
  },
  'ab-test-adjusted': () => testAdjustedTable(),
  'ab-earlier-explore': () => earlierTable('explore'),
  'ab-earlier-run': () => earlierTable('run'),
  'ab-pooled': () => pooledTable(),
  'ab-tasks-explore': () => taskTable(EX),
  'ab-tasks-run': () => taskTable(RN),
  'ab-blockers': () => {
    const title = {
      'kopt-adoption': 'kopt use halved with the shorter prompt',
      'flaky-suite-under-load': 'Timing-dependent tests in kopt\'s own suite fail under load',
      'rerun-one-liner': 'A repeated `kopt run` after a timeout answers only "same as run X"',
      'ts-rust-receivers': '`kopt refs` misses calls on TypeScript and Rust receivers',
      'text-check-comments': 'The completeness check counts mentions in comments',
      'callers-by-sed': 'Agents read callers with `sed` after a complete `kopt refs` answer',
      measurement: 'Measurement',
    };
    return AB.diagnosis.blockers.map((b, i) => `${i + 1}. **${title[b.id] ?? b.id}.** ${b.evidence.replace(/ -> /g, ' → ')}. Proposed fix: ${b.fix}.`).join('\n');
  },
  'scale-v02': () => scaleTables(),
  'scale-recheck': () => mdTable(['Step (round-2 build, `bench/scale/run.mjs`)', 'Result'], [
    ['first build: `kopt_find` answers from the index', `${SE.steps.firstBuild.searchableS} s`],
    ['first build: `kopt_refs` answers (references resolved)', `${SE.steps.firstBuild.refsReadyS} s`],
    ['query latency on the built index (11 calls)', `median ${SE.steps.queries.p50Ms} ms, max ${SE.steps.queries.maxMs} ms`],
    ['`kopt index` typed during the server\'s first build', `waits, then catches up: exit ${SE.steps.concurrentIndex.exit} after ${SE.steps.concurrentIndex.seconds} s`],
  ]),
  'scale-quality': () => [...SC.quality.map((q) => `- ${q}`), ...SC.caveats.map((q) => `- ${q}`)].join('\n'),
  sources: () => mdTable(['Data', 'File', 'Date', 'Build or tool versions'], [
    ['Offline retrieval, 11 languages', '[`bench/results/summary.json`](../bench/results/summary.json)', date(S.date), `round-3 build, ${S.environment.node}, ${S.environment.platform}; competitors: KiroGraph 1.4.0, CodeGraph 1.6.2`],
    ['Held-out tasks', '[`bench/results/heldout/`](../bench/results/heldout/)', date(heldout[0].data.meta.date), 'round-2 build (not re-run in round 3)'],
    ['Real-agent A/B', '[`bench/results/agent-ab-final.json`](../bench/results/agent-ab-final.json)', logSpan(AB_LOGS), `kopt ${AB.diagnosis.build.final}; ${AB.diagnosis.sources.agentHarness.split(';')[0]}`],
    ['Command-output compression', '[`bench/results/compression.json`](../bench/results/compression.json)', C.date, `fixtures of \`test/fixtures/compress\`, ${C.node}`],
    ['Big-repository scale', '[`bench/results/scale-v02.json`](../bench/results/scale-v02.json)', SC.date, `before ${SC.builds.before}, after ${SC.builds.after}`],
    ['Big-repository re-check', '[`bench/results/scale-elasticsearch.json`](../bench/results/scale-elasticsearch.json)', '2026-10-09', `round-2 build, ${SE.node}, ${SE.platform}`],
  ]),
};

// ---------------------------------------------------------------------------------------------------------------
// Rewrite the Markdown

const BLOCK_RE = /<!-- BEGIN generated:([\w-]+) -->\n([\s\S]*?)<!-- END generated:\1 -->/g;
const VALUE_RE = /<!--v:([\w.]+)-->([\s\S]*?)<!--\/v-->/g;

function blockMd(name) {
  const b = BLOCKS[name];
  if (!b) throw new Error(`docs/BENCHMARKS.md: unknown generated block "${name}"`);
  return typeof b === 'function' ? b() : b.md();
}

const mdSource = readFileSync(MD_PATH, 'utf8');
const used = new Set();
let md = mdSource.replace(BLOCK_RE, (_, name) => {
  used.add(name);
  const body = blockMd(name);
  return `<!-- BEGIN generated:${name} -->\n${body ? body + '\n' : ''}<!-- END generated:${name} -->`;
});
const fillValues = (text, file) => text.replace(VALUE_RE, (_, key) => {
  if (!(key in VALUES)) throw new Error(`${file}: unknown value "${key}"`);
  return `<!--v:${key}-->${VALUES[key]}<!--/v-->`;
});
md = fillValues(md, 'docs/BENCHMARKS.md');
const valuePages = VALUE_PAGES.map((rel) => {
  const path = join(ROOT, rel);
  const before = readFileSync(path, 'utf8');
  return { rel, path, before, after: fillValues(before, rel) };
});
const unused = Object.keys(BLOCKS).filter((k) => !used.has(k));
if (unused.length) process.stderr.write(`note: blocks not used in docs/BENCHMARKS.md: ${unused.join(', ')}\n`);

// ---------------------------------------------------------------------------------------------------------------
// Markdown -> HTML (the subset docs/BENCHMARKS.md uses)

function slug(text) {
  return text.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N} _-]/gu, '').trim().replace(/ /g, '-');
}

function linkTarget(url) {
  if (/^(https?:|mailto:|#)/.test(url)) return url;
  if (/^benchmarks\.html(#|$)/.test(url)) return url;
  const [path, hash] = url.split('#');
  const p = posix.normalize(posix.join('docs', path));
  return `${BLOB}${p}${hash ? `#${hash}` : ''}`;
}

function inline(text) {
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(`<code>${esc(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => `<a href="${esc(linkTarget(u.replace(/&amp;/g, '&')))}">${t}</a>`);
  s = s.replace(/&lt;(https?:\/\/[^&\s]+)&gt;/g, (_, u) => `<a href="${u}">${u}</a>`);
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*(\S(?:.*?\S)?)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
  return s;
}

function splitRow(line) {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let cur = '', code = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '\\' && inner[i + 1] === '|') { cur += '|'; i++; continue; }
    if (ch === '`') code = !code;
    if (ch === '|' && !code) { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

const LIST_RE = /^(\s*)([-*]|\d+\.)\s+(.*)$/;

function parseList(lines, start, indent) {
  const ordered = /\d/.test(LIST_RE.exec(lines[start])[2]);
  const items = [];
  let i = start;
  while (i < lines.length) {
    const m = LIST_RE.exec(lines[i]);
    if (!m || m[1].length !== indent) break;
    const contentIndent = indent + m[2].length + 1;
    let text = m[3];
    const children = [];
    i++;
    while (i < lines.length && lines[i].trim() !== '') {
      const n = LIST_RE.exec(lines[i]);
      if (n && n[1].length >= contentIndent - 1 && n[1].length > indent) {
        const sub = parseList(lines, i, n[1].length);
        children.push(sub.html);
        i = sub.next;
        continue;
      }
      if (n && n[1].length <= indent) break;
      if (/^\s+\S/.test(lines[i]) && !n) { text += ' ' + lines[i].trim(); i++; continue; }
      break;
    }
    // a blank line followed by an indented continuation or a nested list stays in the item
    if (i < lines.length && lines[i].trim() === '' && i + 1 < lines.length) {
      const n = LIST_RE.exec(lines[i + 1]);
      if (n && n[1].length === indent) i++;
    }
    items.push(`<li>${inline(text)}${children.join('')}</li>`);
  }
  const tag = ordered ? 'ol' : 'ul';
  return { html: `<${tag}>${items.join('')}</${tag}>`, next: i };
}

function mdToHtml(src, charts) {
  const lines = src.split('\n');
  const out = [];
  const toc = [];
  let i = 0;
  const isBlockStart = (l) => /^(#{1,6} |```|\||>|@@CHART:)/.test(l) || LIST_RE.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }
    let m;
    if ((m = /^@@CHART:([\w-]+)@@$/.exec(line.trim()))) {
      out.push(charts[m[1]] ?? '');
      i++;
      continue;
    }
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const body = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
      i++;
      out.push(`<pre><code${lang ? ` class="language-${esc(lang)}"` : ''}>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    if ((m = /^(#{1,6}) (.*)$/.exec(line))) {
      const level = m[1].length;
      const id = slug(m[2]);
      if (level === 2) toc.push({ id, text: m[2] });
      out.push(`<h${level} id="${id}">${inline(m[2])}${level > 1 ? ` <a class="anchor" href="#${id}" aria-label="Link to this section">#</a>` : ''}</h${level}>`);
      i++;
      continue;
    }
    if (line.startsWith('|')) {
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(splitRow(lines[i++]));
      const numeric = head.map((_, c) => rows.length > 0 && rows.every((r) => /^(\*\*)?[-+]?[\d,.]+[%skKMGB ]*(\*\*)?$|^(\*\*)?[-+]?\d[\d,.]*%? \[/.test(r[c] ?? '') || /^(\*\*)?\d+\/\d+/.test(r[c] ?? '') || (r[c] ?? '') === ''));
      out.push(`<div class="table-wrap" tabindex="0"><table><thead><tr>${head.map((h, c) => `<th scope="col"${numeric[c] ? ' class="num"' : ''}>${inline(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((d, c) => `<td${numeric[c] ? ' class="num"' : ''}>${inline(d)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (line.startsWith('>')) {
      const body = [];
      while (i < lines.length && lines[i].startsWith('>')) body.push(lines[i++].replace(/^> ?/, ''));
      out.push(`<blockquote>${mdToHtml(body.join('\n'), charts).html}</blockquote>`);
      continue;
    }
    if (LIST_RE.test(line)) {
      const l = parseList(lines, i, LIST_RE.exec(line)[1].length);
      out.push(l.html);
      i = l.next;
      continue;
    }
    const para = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i])) para.push(lines[i++].trim());
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return { html: out.join('\n'), toc };
}

// Chart blocks become placeholders in the HTML source; every other generated block is converted as Markdown.
const charts = {};
let htmlSrc = md.replace(BLOCK_RE, (_, name, body) => {
  const b = BLOCKS[name];
  if (b && typeof b === 'object' && b.svg) {
    charts[name] = `<figure class="chart-fig">${b.svg()}</figure>`;
    return `@@CHART:${name}@@`;
  }
  return body;
});
htmlSrc = htmlSrc.replace(/<!--[\s\S]*?-->/g, '');
const titleLine = /^# (.*)$/m.exec(htmlSrc);
const pageTitle = titleLine ? titleLine[1] : 'kopt benchmarks';
const body = mdToHtml(htmlSrc, charts);

const CSS = `
:root{color-scheme:light;--page:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink-2:#52514e;--muted:#6f6d68;--grid:#e1e0d9;--axis:#c3c2b7;--border:rgba(11,11,11,.10);--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--bar-muted:#a3a19a;--link:#1c5cab;--code-bg:#f0efec;--row:#f4f3ef}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])){color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;--ink:#ffffff;--ink-2:#c3c2b7;--muted:#a3a19a;--grid:#2c2c2a;--axis:#383835;--border:rgba(255,255,255,.10);--s1:#3987e5;--s2:#d95926;--s3:#199e70;--bar-muted:#6f6d68;--link:#86b6ef;--code-bg:#262624;--row:#222220}}
:root[data-theme="dark"]{color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;--ink:#ffffff;--ink-2:#c3c2b7;--muted:#a3a19a;--grid:#2c2c2a;--axis:#383835;--border:rgba(255,255,255,.10);--s1:#3987e5;--s2:#d95926;--s3:#199e70;--bar-muted:#6f6d68;--link:#86b6ef;--code-bg:#262624;--row:#222220}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--page);color:var(--ink);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:980px;margin:0 auto;padding:24px 16px 64px}
header.top{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;border-bottom:1px solid var(--border);padding-bottom:12px;margin-bottom:8px}
header.top a{color:var(--ink-2);text-decoration:none;font-weight:600}
header.top nav{display:flex;gap:16px;flex-wrap:wrap;font-size:14px}
button.theme{font:inherit;font-size:13px;color:var(--ink);background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:4px 10px;cursor:pointer}
h1{font-size:2rem;line-height:1.2;margin:24px 0 8px}
h2{font-size:1.45rem;margin:40px 0 8px;padding-top:8px;border-top:1px solid var(--border)}
h3{font-size:1.15rem;margin:28px 0 6px}
h4{font-size:1rem;margin:20px 0 4px}
.anchor{visibility:hidden;color:var(--muted);text-decoration:none;margin-left:6px;font-weight:400}
h2:hover .anchor,h3:hover .anchor,h4:hover .anchor{visibility:visible}
p,li{color:var(--ink)}
a{color:var(--link)}
code{font:0.88em/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--code-bg);padding:1px 4px;border-radius:4px;overflow-wrap:anywhere}
pre{background:var(--code-bg);padding:12px 14px;border-radius:8px;overflow-x:auto}
pre code{background:none;padding:0;overflow-wrap:normal}
blockquote{margin:16px 0;padding:8px 16px;border-left:3px solid var(--s1);background:var(--surface);color:var(--ink-2)}
blockquote p{color:var(--ink-2);margin:6px 0}
.table-wrap{overflow-x:auto;margin:12px 0 20px;border:1px solid var(--border);border-radius:8px;background:var(--surface)}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{padding:7px 10px;text-align:left;vertical-align:top;border-bottom:1px solid var(--grid)}
th{font-weight:600;color:var(--ink-2);background:var(--surface);position:sticky;top:0}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
tbody tr:nth-child(even){background:var(--row)}
tbody tr:last-child td{border-bottom:0}
figure.chart-fig{margin:16px 0 4px;padding:12px 8px 4px;background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow-x:auto}
svg.chart{display:block;width:100%;min-width:520px;height:auto;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
svg .grid{stroke:var(--grid);stroke-width:1}
svg .baseline{stroke:var(--axis);stroke-width:1}
svg .zero{stroke:var(--ink-2);stroke-width:1}
svg .tick,svg .axis-label{fill:var(--muted);font-size:11px}
svg .label{fill:var(--ink-2);font-size:13px}
svg .legend{fill:var(--ink-2);font-size:12.5px}
svg .value{fill:var(--ink);font-size:12.5px;font-variant-numeric:tabular-nums}
svg .value.small{font-size:11px}
svg .strong{font-weight:700;fill:var(--ink)}
svg .bar.s1{fill:var(--s1)} svg .bar.s2{fill:var(--s2)} svg .bar.s3{fill:var(--s3)} svg .bar.muted{fill:var(--bar-muted)}
svg .whisker{stroke:var(--s1);stroke-width:2;stroke-linecap:round}
svg .dot{fill:var(--s1);stroke:var(--surface);stroke-width:2}
svg .dot.open{fill:var(--surface);stroke:var(--s1);stroke-width:2}
svg .hit{fill:transparent}
svg .mark:hover .bar{opacity:.82}
svg .mark:hover .hit{fill:var(--row)}
footer{margin-top:48px;padding-top:12px;border-top:1px solid var(--border);color:var(--muted);font-size:13px}
@media (max-width:640px){h1{font-size:1.6rem}table{font-size:13px}}
@media (forced-colors:active){svg .bar,svg .dot{fill:CanvasText}svg .whisker{stroke:CanvasText}}
`.trim();

const SCRIPT = `(function(){var r=document.documentElement,b=document.getElementById('theme');function label(){var t=r.getAttribute('data-theme');b.textContent=t==='dark'?'Theme: dark':t==='light'?'Theme: light':'Theme: auto';}try{var s=localStorage.getItem('kopt-theme');if(s==='light'||s==='dark')r.setAttribute('data-theme',s);}catch(e){}label();b.addEventListener('click',function(){var t=r.getAttribute('data-theme');var n=t==='light'?'dark':t==='dark'?null:'light';if(n)r.setAttribute('data-theme',n);else r.removeAttribute('data-theme');try{if(n)localStorage.setItem('kopt-theme',n);else localStorage.removeItem('kopt-theme');}catch(e){}label();});})();`;

const description = `kopt benchmarks: offline retrieval on ${kp.tasks} tasks in ${S.rows.length} languages against CodeGraph, KiroGraph and native Kiro, a real-agent A/B with confidence intervals, command-output compression and big-repository scale. Generated from the committed result files.`;
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(pageTitle)}</title>
<meta name="description" content="${esc(description)}">
<meta name="generator" content="scripts/build-benchmarks-page.mjs">
<style>
${CSS}
</style>
</head>
<body>
<div class="wrap">
<header class="top">
<a href="${REPO_URL}">kiro-optimizer (kopt)</a>
<nav aria-label="Sections">${body.toc.filter((t) => !/^(Reproduce|Data sources|Method)/.test(t.text)).map((t) => `<a href="#${t.id}">${inline(t.text.split(':')[0])}</a>`).join('')}</nav>
<button class="theme" id="theme" type="button">Theme: auto</button>
</header>
<main>
${body.html}
</main>
<footer>
<p>Generated by <code>scripts/build-benchmarks-page.mjs</code> (<code>npm run bench:page</code>) from the result files committed in <a href="${REPO_URL}/tree/main/bench/results">bench/results</a>. The same numbers, as Markdown: <a href="${BLOB}docs/BENCHMARKS.md">docs/BENCHMARKS.md</a>. kopt is MIT-licensed and runs entirely on the developer's machine.</p>
</footer>
</div>
<script>${SCRIPT}</script>
</body>
</html>
`;

// ---------------------------------------------------------------------------------------------------------------
// Write or check

const stale = [];
if (md !== mdSource) stale.push('docs/BENCHMARKS.md');
for (const v of valuePages) if (v.after !== v.before) stale.push(v.rel);
const oldHtml = existsSync(HTML_PATH) ? readFileSync(HTML_PATH, 'utf8') : '';
if (html !== oldHtml) stale.push('docs/benchmarks.html');
if (CHECK) {
  if (stale.length) {
    process.stderr.write(`out of date: ${stale.join(', ')}; run npm run bench:page\n`);
    process.exit(1);
  }
  console.log(`docs/BENCHMARKS.md, docs/benchmarks.html and the numbers of ${VALUE_PAGES.join(', ')} are up to date`);
} else {
  if (md !== mdSource) writeFileSync(MD_PATH, md);
  for (const v of valuePages) if (v.after !== v.before) writeFileSync(v.path, v.after);
  if (html !== oldHtml) writeFileSync(HTML_PATH, html);
  console.log(stale.length ? `wrote ${stale.join(', ')}` : 'everything was already up to date');
}
