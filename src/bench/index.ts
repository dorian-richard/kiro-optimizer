// kopt bench: offline, reproducible proxy benchmark of exploration strategies (native Kiro tools vs kopt),
// extraction-quality checks per language, and the multi-language corpus run. See bench/README.md.

import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { runAll } from './all.js';
import { findLangRepo, loadLangsFile } from './langs.js';
import { runQuality, writeQuality } from './quality.js';
import { renderMarkdown, writeResults } from './report.js';
import { BENCH_DIR, PROJECT_ROOT, gitHead, openKoptIndex, runBench } from './run.js';
import { loadTaskFile, verifyTasks } from './tasks.js';
import { ALL_STRATEGIES, EXTERNAL_STRATEGIES, type BenchInput, type LangId, type StrategyName } from './types.js';

export * from './types.js';
export { loadTaskFile, validateTaskFile, verifyTasks } from './tasks.js';
export { renderMarkdown, writeResults } from './report.js';
export { grepKeywords, nativeGrep, KIRO_GREP_LIMITS } from './grep.js';
export { nativeNaive, nativeRanged, koptPack, koptHitsRead, loadKoptModules, extractTargets } from './strategies.js';
export { computeRecall, aggregate, compare, median, mean } from './metrics.js';
export { runBench, openKoptIndex, taskInput, resolveStrategies, PROJECT_ROOT, BENCH_DIR, COMPETITORS_DIR, type BenchOptions, type OpenedIndex, type IndexInfo } from './run.js';
export { loadCompetitors, parseCompetitorJsonl, competitorResult, pickLine, type CompetitorLine, type CompetitorFile } from './competitors.js';
export { runQuality, writeQuality, renderQualityMarkdown, checkSymbol, countParseErrors, blankStringsAndComments, type QualityOptions } from './quality.js';
export { runAll, renderSummaryMarkdown, writeSummary, type AllOptions } from './all.js';
export { loadLangsFile, validateLangsFile, findLangRepo } from './langs.js';

// ---------------------------------------------------------------------------------------------------------
// CLI

const HELP = `kopt bench [<repo-name|tasks.json> ...] [options]
kopt bench quality <repo-name> ... [options]
kopt bench all [options]

Offline proxy benchmark: tokens returned to the model and recall of verified gold items,
for native Kiro exploration (grep_search + read_file) vs kopt (kopt_find / kopt_read) vs
competitor outputs recorded in bench/competitors/results/<tool>-<repo>.jsonl.

  (default)              run the strategies on bench/tasks/<repo>.json (all task files when none given)
  quality <repo> ...     index the repo and measure extraction quality per language
                         -> bench/results/quality-<repo>.{md,json}
  all                    every repo of bench/langs.json: verify + index + quality + strategies
                         -> bench/results/<repo>.{md,json}, quality-<repo>.*, summary.{md,json}

  --all                  run every bench/tasks/*.json (default command)
  --repo <path>          checkout to explore (default: bench/repos/<name>)
  --strategies <list>    comma list of ${[...ALL_STRATEGIES, ...EXTERNAL_STRATEGIES].join(', ')}
                         (default: the built-ins + competitors that have a results file)
  --input <search|question|natural>  feed the agent-derived search phrase (default), the raw prompt,
                         or the identifier-free paraphrase (falls back to the prompt)
  --tasks <ids>          comma list of task ids
  --only <names>         (all) comma list of repo names from bench/langs.json
  --label <name>         results file name (default: repo name)
  --out <dir>            output directory (default: bench/results)
  --index-dir <dir>      kopt index location (default: bench/repos/.kopt-<name>)
  --rebuild-index        delete and rebuild the kopt index first
  --competitors <dir>    competitor results directory (default: bench/competitors/results)
  --parse-sample <n>     (quality) files re-parsed per language (default 1000)
  --precision-sample <n> (quality) symbols checked per language (default 30)
  --no-quality           (all) skip the quality pass
  --clone                (all) clone missing checkouts at their pinned tag
  --langs <file>         (all) corpus file (default: bench/langs.json)
  --chars-per-token <n>  token estimate calibration (default 3.0)
  --raw                  also write <label>.raw.json with every output
  --verify               only check gold items against the checkout (exit code 1 on issues)
`;

function resolveTaskFile(arg: string): string {
  if (arg.endsWith('.json')) return isAbsolute(arg) ? arg : resolve(arg);
  return join(BENCH_DIR, 'tasks', `${arg}.json`);
}

function positiveInt(v: string | undefined, flag: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${flag} must be a non-negative integer`);
  return n;
}

export async function runBenchCli(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      all: { type: 'boolean' },
      repo: { type: 'string' },
      strategies: { type: 'string' },
      input: { type: 'string' },
      tasks: { type: 'string' },
      only: { type: 'string' },
      label: { type: 'string' },
      out: { type: 'string' },
      'index-dir': { type: 'string' },
      'rebuild-index': { type: 'boolean' },
      competitors: { type: 'string' },
      'parse-sample': { type: 'string' },
      'precision-sample': { type: 'string' },
      'no-quality': { type: 'boolean' },
      clone: { type: 'boolean' },
      langs: { type: 'string' },
      'chars-per-token': { type: 'string' },
      raw: { type: 'boolean' },
      verify: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (values.input && !['search', 'question', 'natural'].includes(values.input)) throw new Error('--input must be search, question or natural');
  const input = values.input as BenchInput | undefined;
  const strategies = values.strategies ? (values.strategies.split(',').map((s) => s.trim()).filter(Boolean) as StrategyName[]) : undefined;
  const log = (m: string) => process.stderr.write(`kopt bench: ${m}\n`);
  const outDir = resolve(values.out ?? join(BENCH_DIR, 'results'));
  const charsPerToken = values['chars-per-token'] ? Number(values['chars-per-token']) : undefined;
  const parseSample = positiveInt(values['parse-sample'], '--parse-sample');
  const precisionSample = positiveInt(values['precision-sample'], '--precision-sample');
  const sub = positionals[0];

  if (sub === 'all') {
    const { summary, written } = await runAll({
      langsPath: values.langs,
      only: values.only ? values.only.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
      input,
      strategies,
      competitorsDir: values.competitors,
      outDir,
      rebuildIndex: values['rebuild-index'],
      clone: values.clone,
      quality: !values['no-quality'],
      parseSample,
      precisionSample,
      charsPerToken,
      keepOutputs: values.raw,
      onProgress: log,
    });
    const { renderSummaryMarkdown } = await import('./all.js');
    const md = renderSummaryMarkdown(summary);
    process.stdout.write(md.split('\n## Found by task kind')[0].trimEnd() + '\n\n' + written.filter((w) => /summary/.test(w)).map((w) => `wrote ${w}`).join('\n') + '\n');
    if (summary.rows.some((r) => !r.ok || r.verifyIssues)) process.exitCode = 1;
    return;
  }

  if (sub === 'quality') {
    const names = positionals.slice(1);
    if (!names.length) throw new Error('usage: kopt bench quality <repo-name> ...');
    if (values.repo && names.length > 1) throw new Error('--repo needs exactly one repo name');
    const langsPath = resolve(values.langs ?? join(BENCH_DIR, 'langs.json'));
    const langs = existsSync(langsPath) ? loadLangsFile(langsPath) : undefined;
    for (const name of names) {
      const lr = langs ? findLangRepo(langs, name) : undefined;
      const taskPath = join(BENCH_DIR, 'tasks', `${name}.json`);
      const tf = existsSync(taskPath) ? loadTaskFile(taskPath) : undefined;
      const repoRoot = resolve(values.repo ?? join(PROJECT_ROOT, tf?.repo.path ?? join('bench', 'repos', name)));
      if (!existsSync(repoRoot)) throw new Error(`checkout missing: ${repoRoot}${lr ? `\n  clone it with: git clone --depth 1 --branch ${lr.tag} ${lr.url} ${repoRoot}` : ''}`);
      const opened = await openKoptIndex(repoRoot, name, { indexDir: values['index-dir'], rebuildIndex: values['rebuild-index'], needRetrieval: false, onProgress: log });
      if (!opened.store || !opened.index) throw new Error(opened.skip ?? 'index unavailable');
      try {
        const q = await runQuality({
          repo: name,
          repoRoot,
          store: opened.store,
          language: lr?.language ?? (tf?.repo.language as LangId | undefined),
          index: opened.index,
          headCommit: gitHead(repoRoot),
          parseSample,
          precisionSample,
          onProgress: log,
        });
        const written = writeQuality(q, outDir);
        const { renderQualityMarkdown } = await import('./quality.js');
        process.stdout.write(renderQualityMarkdown(q).split('\n## ').slice(0, 2).join('\n## ').trimEnd() + '\n\n' + written.map((w) => `wrote ${w}`).join('\n') + '\n');
      } finally {
        opened.store.close();
      }
    }
    return;
  }

  let files = positionals.map(resolveTaskFile);
  if (values.all || !files.length) {
    const dir = join(BENCH_DIR, 'tasks');
    files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => join(dir, f)) : [];
  }
  if (!files.length) throw new Error('no task files found (bench/tasks/*.json)');
  if (values.repo && files.length > 1) throw new Error('--repo needs exactly one task file');
  const only = values.tasks ? new Set(values.tasks.split(',').map((s) => s.trim())) : undefined;

  for (const file of files) {
    if (!existsSync(file)) throw new Error(`task file not found: ${file}`);
    const tf = loadTaskFile(file);
    const repoRoot = resolve(values.repo ?? join(PROJECT_ROOT, tf.repo.path ?? join('bench', 'repos', tf.repo.name)));
    if (!existsSync(repoRoot)) {
      throw new Error(
        `checkout missing: ${repoRoot}\n  clone it with: git clone --depth 1 --branch ${tf.repo.tag ?? '<tag>'} ${tf.repo.url ?? '<url>'} ${repoRoot}`,
      );
    }
    const tasks = only ? tf.tasks.filter((t) => only.has(t.id)) : tf.tasks;

    if (values.verify) {
      const issues = verifyTasks(repoRoot, tasks);
      const head = gitHead(repoRoot);
      if (tf.repo.commit && head && head !== tf.repo.commit) issues.push({ taskId: '-', message: `HEAD ${head} != pinned ${tf.repo.commit}` });
      process.stdout.write(`${tf.repo.name}: ${tasks.length} tasks, ${issues.length} issue(s)\n`);
      for (const i of issues) process.stdout.write(`  ${i.taskId}: ${i.message}\n`);
      if (issues.length) process.exitCode = 1;
      continue;
    }

    const res = await runBench({
      repoRoot,
      tasks,
      repo: tf.repo,
      strategies,
      input,
      label: files.length > 1 ? undefined : values.label,
      indexDir: values['index-dir'],
      rebuildIndex: values['rebuild-index'],
      charsPerToken,
      keepOutputs: values.raw,
      competitorsDir: values.competitors,
      onProgress: log,
    });
    const written = writeResults(res, outDir);
    const md = renderMarkdown(res);
    const summary = md.split('\n## Per task')[0];
    process.stdout.write(summary.trimEnd() + '\n\n' + written.map((w) => `wrote ${w}`).join('\n') + '\n');
  }
}
