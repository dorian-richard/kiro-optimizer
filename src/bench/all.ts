// kopt bench all: every repository of bench/langs.json -> verify + index + quality + strategies, then
// bench/results/summary.{md,json} (schema documented in types.ts, BenchSummary).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { aggregate } from './metrics.js';
import { loadLangsFile } from './langs.js';
import { runQuality, writeQuality } from './quality.js';
import { writeResults } from './report.js';
import { BENCH_DIR, PROJECT_ROOT, gitHead, openKoptIndex, runBench } from './run.js';
import { loadTaskFile, verifyTasks } from './tasks.js';
import {
  ALL_STRATEGIES,
  EXTERNAL_STRATEGIES,
  type BenchInput,
  type BenchSummary,
  type LangRepo,
  type StrategyAggregate,
  type StrategyName,
  type SummaryRow,
  type SummaryStrategyCell,
  type TaskStrategyResult,
} from './types.js';

export interface AllOptions {
  /** Default bench/langs.json. */
  langsPath?: string;
  /** Restrict to these repo names. */
  only?: string[];
  input?: BenchInput;
  strategies?: StrategyName[];
  competitorsDir?: string;
  /** Default bench/results. */
  outDir?: string;
  rebuildIndex?: boolean;
  /** Clone missing checkouts (`git clone --depth 1 --branch <tag>`). */
  clone?: boolean;
  /** Run the extraction-quality pass (default true). */
  quality?: boolean;
  parseSample?: number;
  precisionSample?: number;
  charsPerToken?: number;
  keepOutputs?: boolean;
  onProgress?: (m: string) => void;
}

function toolVersion(): string {
  try {
    return String(JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')).version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
}

export function summaryCell(a: StrategyAggregate): SummaryStrategyCell {
  return {
    strategy: a.strategy,
    tasks: a.tasks,
    found: a.found,
    foundRate: a.foundRate,
    medianTokens: a.medianTokens,
    meanTokens: a.meanTokens,
    tokensPerFound: a.tokensPerFound,
    meanFileRecall: a.meanFileRecall,
    meanSymbolRecall: a.meanSymbolRecall,
    meanDefRecall: a.meanDefRecall,
    skipped: a.skipped,
  };
}

function cloneRepo(r: LangRepo, root: string, log: (m: string) => void): void {
  log(`${r.name}: cloning ${r.url} @ ${r.tag}`);
  const res = spawnSync('git', ['-c', 'advice.detachedHead=false', 'clone', '--quiet', '--depth', '1', '--branch', r.tag, '--single-branch', r.url, root], {
    stdio: ['ignore', 'ignore', 'pipe'],
    encoding: 'utf8',
    timeout: 30 * 60_000,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (res.status !== 0) throw new Error(`git clone failed: ${(res.stderr || res.error?.message || '').trim().slice(0, 300)}`);
}

const rel = (p: string) => relative(PROJECT_ROOT, p).split('\\').join('/');

export async function runAll(o: AllOptions = {}): Promise<{ summary: BenchSummary; written: string[] }> {
  const log = o.onProgress ?? (() => {});
  const langsPath = resolve(o.langsPath ?? join(BENCH_DIR, 'langs.json'));
  const langs = loadLangsFile(langsPath);
  const outDir = resolve(o.outDir ?? join(BENCH_DIR, 'results'));
  const input = o.input ?? 'search';
  const repos = o.only?.length ? langs.repos.filter((r) => o.only!.includes(r.name)) : langs.repos;
  if (o.only?.length) for (const n of o.only) if (!langs.repos.some((r) => r.name === n)) throw new Error(`${n} is not in ${langsPath}`);
  const rows: SummaryRow[] = [];
  const pooled: TaskStrategyResult[] = [];
  const notes: string[] = [];
  const seen = new Set<StrategyName>();
  const written: string[] = [];

  for (const r of repos) {
    const t0 = Date.now();
    const row: SummaryRow = {
      repo: r.name, language: r.language, tag: r.tag, commit: r.commit, loc: r.loc, ok: false, verifyIssues: 0, tasks: 0,
      index: null, quality: null, strategies: [], byKind: [], files: {}, durationMs: 0,
    };
    rows.push(row);
    const repoRoot = join(BENCH_DIR, 'repos', r.name);
    try {
      if (!existsSync(repoRoot)) {
        if (!o.clone) throw new Error(`checkout missing: ${rel(repoRoot)} (run with --clone, or: git clone --depth 1 --branch ${r.tag} ${r.url} ${rel(repoRoot)})`);
        mkdirSync(join(BENCH_DIR, 'repos'), { recursive: true });
        cloneRepo(r, repoRoot, log);
      }
      const head = gitHead(repoRoot);
      if (head && head !== r.commit) notes.push(`${r.name}: checkout HEAD ${head.slice(0, 12)} differs from the pinned commit ${r.commit.slice(0, 12)}`);
      const taskPath = join(BENCH_DIR, 'tasks', `${r.name}.json`);
      if (!existsSync(taskPath)) throw new Error(`task file missing: ${rel(taskPath)}`);
      const tf = loadTaskFile(taskPath);
      row.tasks = tf.tasks.length;
      const issues = verifyTasks(repoRoot, tf.tasks);
      row.verifyIssues = issues.length;
      if (issues.length) notes.push(`${r.name}: ${issues.length} gold item(s) fail verification (first: ${issues[0].taskId}: ${issues[0].message})`);

      log(`${r.name}: index`);
      const opened = await openKoptIndex(repoRoot, r.name, { rebuildIndex: o.rebuildIndex, needRetrieval: false, onProgress: log });
      if (opened.skip || !opened.store || !opened.index) {
        notes.push(`${r.name}: no kopt index (${opened.skip ?? 'unknown'})`);
      } else {
        const ix = opened.index;
        row.index = { built: ix.built, durationMs: ix.durationMs, files: ix.files, symbols: ix.symbols, refs: ix.refs };
        try {
          if (o.quality !== false) {
            log(`${r.name}: quality`);
            const q = await runQuality({
              repo: r.name,
              repoRoot,
              store: opened.store,
              language: r.language,
              index: ix,
              headCommit: head,
              parseSample: o.parseSample,
              precisionSample: o.precisionSample,
              onProgress: log,
            });
            const qw = writeQuality(q, outDir);
            written.push(...qw);
            row.files.quality = rel(qw[0]);
            const p = q.langs.find((l) => l.lang === r.language);
            row.quality = {
              filesIndexed: q.files.indexed,
              filesSkipped: q.files.skipped,
              parseErrorFileRate: p?.parse.errorFileRate ?? 0,
              parseErrorsPerKloc: p?.parse.errorsPerKloc ?? 0,
              symbolsPerKloc: p?.symbolsPerKloc ?? 0,
              resolvedRate: p?.resolvedRate ?? 0,
              resolvedOfCandidates: p?.resolvedOfCandidates ?? 0,
              precisionRate: p?.precision.rate ?? 0,
              precisionSampled: p?.precision.sampled ?? 0,
            };
          }
        } finally {
          opened.store.close();
        }
      }

      log(`${r.name}: strategies`);
      const res = await runBench({
        repoRoot,
        tasks: tf.tasks,
        repo: tf.repo,
        strategies: o.strategies,
        input,
        competitorsDir: o.competitorsDir,
        charsPerToken: o.charsPerToken,
        keepOutputs: o.keepOutputs,
        onProgress: log,
      });
      const bw = writeResults(res, outDir);
      written.push(...bw);
      row.files.bench = rel(bw[0]);
      for (const s of res.meta.strategies) seen.add(s);
      row.strategies = res.aggregates.map(summaryCell);
      row.byKind = res.byKind.map((k) => ({ kind: k.kind, strategy: k.strategy, tasks: k.tasks, found: k.found }));
      pooled.push(...res.results);
      row.ok = true;
    } catch (err) {
      row.error = (err as Error).message.split('\n')[0];
      log(`${r.name}: FAILED: ${row.error}`);
    }
    row.durationMs = Date.now() - t0;
  }

  const order: StrategyName[] = [...ALL_STRATEGIES, ...EXTERNAL_STRATEGIES];
  const strategies = order.filter((s) => seen.has(s));
  const summary: BenchSummary = {
    schema: 'kopt-bench-summary/1',
    date: new Date().toISOString(),
    input,
    strategies,
    environment: { node: process.version, platform: `${process.platform}-${process.arch}`, toolVersion: toolVersion() },
    rows,
    totals: strategies.map((s) => summaryCell(aggregate(s, pooled))),
    notes,
  };
  written.push(...writeSummary(summary, outDir));
  return { summary, written };
}

// ---------------------------------------------------------------------------------------------------------
// Rendering

const pct = (x: number) => `${Math.round(x * 100)}%`;
const pct1 = (x: number) => `${(x * 100).toFixed(1)}%`;
const num = (x: number) => Math.round(x).toLocaleString('en-US');
const secs = (ms: number | null) => (ms === null ? 'n/a' : `${(ms / 1000).toFixed(1)} s`);

function table(head: string[], rows: string[][]): string {
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

function cellOf(row: SummaryRow, s: StrategyName): SummaryStrategyCell | undefined {
  return row.strategies.find((c) => c.strategy === s && c.tasks > 0);
}

export function renderSummaryMarkdown(s: BenchSummary): string {
  const out: string[] = [];
  const okRows = s.rows.filter((r) => r.ok);
  out.push('# kopt bench: multi-language summary');
  out.push('');
  out.push(`${s.rows.length} repositories (${okRows.length} measured) · input = \`${s.input}\` · ${s.date} · node ${s.environment.node} · ${s.environment.platform}`);
  out.push('');
  out.push('> Offline proxy: tokens = estimated tokens of the tool outputs returned to the model for ONE exploration step.');
  out.push('> It is not a credit measurement; savings must be confirmed by the online A/B (bench/ab).');
  out.push('');

  out.push('## Index and extraction quality');
  out.push('');
  out.push(
    table(
      ['language', 'repo', 'KLOC', 'files indexed (skipped)', 'index time', 'symbols', 'symbols/KLOC', 'files with parse errors', 'refs resolved', 'resolved of in-repo names', 'precision sample', 'gold issues'],
      s.rows.map((r) => [
        r.language,
        `${r.repo}@${r.tag}`,
        (r.loc / 1000).toFixed(0),
        r.quality ? `${num(r.quality.filesIndexed)} (${num(r.quality.filesSkipped)})` : r.index ? num(r.index.files) : 'n/a',
        r.index ? secs(r.index.durationMs) : 'n/a',
        r.index ? num(r.index.symbols) : 'n/a',
        r.quality ? r.quality.symbolsPerKloc.toFixed(1) : 'n/a',
        r.quality ? pct1(r.quality.parseErrorFileRate) : 'n/a',
        r.quality ? pct(r.quality.resolvedRate) : 'n/a',
        r.quality ? pct(r.quality.resolvedOfCandidates) : 'n/a',
        r.quality ? `${pct(r.quality.precisionRate)} (n=${r.quality.precisionSampled})` : 'n/a',
        r.ok ? String(r.verifyIssues) : `FAILED: ${r.error ?? ''}`,
      ]),
    ),
  );
  out.push('');
  out.push('Quality columns are for the primary language of each repo; see `quality-<repo>.md` for every language and the failed samples.');
  out.push('');

  const strat = s.strategies;
  const metric = (title: string, f: (c: SummaryStrategyCell, r: SummaryRow) => string, total: (c: SummaryStrategyCell) => string) => {
    out.push(`## ${title}`);
    out.push('');
    const rows = okRows.map((r) => [r.language, r.repo, String(r.tasks), ...strat.map((st) => {
      const c = cellOf(r, st);
      return c ? f(c, r) : '-';
    })]);
    rows.push(['**all**', '', String(okRows.reduce((a, r) => a + r.tasks, 0)), ...strat.map((st) => {
      const c = s.totals.find((t) => t.strategy === st && t.tasks > 0);
      return c ? `**${total(c)}**` : '-';
    })]);
    out.push(table(['language', 'repo', 'tasks', ...strat], rows));
    out.push('');
  };
  metric('Tasks found per strategy', (c) => `${c.found}/${c.tasks}`, (c) => `${c.found}/${c.tasks} (${pct(c.foundRate)})`);
  metric('Median tokens per task', (c) => num(c.medianTokens), (c) => num(c.medianTokens));
  metric('Tokens per found task (failures included)', (c) => (c.tokensPerFound === null ? 'n/a' : num(c.tokensPerFound)), (c) => (c.tokensPerFound === null ? 'n/a' : num(c.tokensPerFound)));
  metric('Mean symbol recall', (c) => pct(c.meanSymbolRecall), (c) => pct(c.meanSymbolRecall));

  const kinds = ['locate', 'explain', 'usage', 'impact'] as const;
  const focus = strat.filter((x) => x === 'kopt-pack' || x === 'native-ranged' || x === 'kirograph' || x === 'codegraph');
  if (focus.length) {
    out.push('## Found by task kind');
    out.push('');
    out.push(
      table(
        ['language', 'repo', ...focus.flatMap((f) => kinds.map((k) => `${f} ${k}`))],
        okRows.map((r) => [
          r.language,
          r.repo,
          ...focus.flatMap((f) =>
            kinds.map((k) => {
              const c = r.byKind.find((b) => b.kind === k && b.strategy === f);
              return c ? `${c.found}/${c.tasks}` : '-';
            }),
          ),
        ]),
      ),
    );
    out.push('');
  }

  out.push('## Notes');
  out.push('');
  out.push('- `found` = every gold file path and every gold symbol name appears in the output. Gold items are verified by');
  out.push('  reading the code (`verifiedBy` in each task) and re-checked mechanically (`kopt bench <repo> --verify`).');
  out.push('- Competitor strategies (kirograph, codegraph) appear only when `bench/competitors/results/<tool>-<repo>.jsonl` exists.');
  for (const n of s.notes) out.push(`- ${n}`);
  for (const r of s.rows.filter((x) => !x.ok)) out.push(`- ${r.repo}: FAILED: ${r.error}`);
  out.push('');
  out.push('Per-repo details: ' + s.rows.filter((r) => r.files.bench || r.files.quality).map((r) => [r.files.bench, r.files.quality].filter(Boolean).map((f) => `\`${f}\``).join(', ')).join('; ') + '.');
  out.push('');
  return out.join('\n');
}

export function writeSummary(s: BenchSummary, outDir: string): string[] {
  mkdirSync(outDir, { recursive: true });
  const md = join(outDir, s.input === 'search' ? 'summary.md' : `summary-${s.input}.md`);
  const json = join(outDir, s.input === 'search' ? 'summary.json' : `summary-${s.input}.json`);
  writeFileSync(md, renderSummaryMarkdown(s));
  writeFileSync(json, JSON.stringify(s, null, 2) + '\n');
  return [md, json];
}
