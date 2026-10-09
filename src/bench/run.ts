// kopt bench: offline, reproducible proxy benchmark of exploration strategies (native Kiro tools vs kopt vs
// competitor tools whose outputs were recorded elsewhere). See bench/README.md for the methodology and limits.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfig, indexPath, type KoptConfig } from '../core/config.js';
import { setCharsPerToken, tokensToChars } from '../core/tokens.js';
import type { Store } from '../store/store.js';
import { competitorPath, competitorResult, loadCompetitors, type CompetitorFile } from './competitors.js';
import { KIRO_GREP_LIMITS } from './grep.js';
import { aggregate, aggregateByKind, compare, computeRecall } from './metrics.js';
import {
  NATIVE_DEFAULTS,
  koptHitsRead,
  koptPack,
  loadKoptModules,
  nativeNaive,
  nativeRanged,
  type KoptModules,
  type NativeOptions,
  type RetrievalModule,
} from './strategies.js';
import { goldDefSignatures } from './tasks.js';
import {
  ALL_STRATEGIES,
  EXTERNAL_STRATEGIES,
  type BenchInput,
  type BenchMeta,
  type BenchResult,
  type BenchTask,
  type BuiltinStrategy,
  type ExternalStrategy,
  type PairedComparison,
  type RepoMeta,
  type StrategyName,
  type StrategyOutput,
  type TaskStrategyResult,
} from './types.js';

/** Project root (this file is src/bench/run.ts or dist/bench/run.js). */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BENCH_DIR = join(PROJECT_ROOT, 'bench');
/** Default location of competitor result files (`<tool>-<repo>.jsonl`). */
export const COMPETITORS_DIR = join(BENCH_DIR, 'competitors', 'results');

export interface BenchOptions {
  /** Checkout to explore. */
  repoRoot: string;
  tasks: BenchTask[];
  repo?: RepoMeta;
  /** Default: the 4 built-in strategies plus every competitor with a results file for this repo. */
  strategies?: StrategyName[];
  /** Which task field feeds the strategies: the agent-derived `search` phrase (default), the raw `question`,
   *  or the identifier-free `natural` paraphrase (falls back to `question`). */
  input?: BenchInput;
  /** Results label (default: repo name, suffixed with `-question` / `-natural` for those inputs). */
  label?: string;
  native?: NativeOptions;
  /** Where the kopt index lives (default `bench/repos/.kopt-<repo>`; never inside the checkout). */
  indexDir?: string;
  rebuildIndex?: boolean;
  charsPerToken?: number;
  /** Keep full strategy outputs in the result (written to `<label>.raw.json`). */
  keepOutputs?: boolean;
  /** Directory of competitor result files (default bench/competitors/results). */
  competitorsDir?: string;
  /** Injected kopt modules (tests); default: dynamic import of ../retrieval and ../indexer. */
  modules?: KoptModules;
  onProgress?: (message: string) => void;
}

const KOPT_STRATEGIES: ReadonlySet<StrategyName> = new Set(['kopt-pack', 'kopt-hits+read']);
const EXTERNAL: ReadonlySet<StrategyName> = new Set(EXTERNAL_STRATEGIES);

export function isBuiltinStrategy(s: string): s is BuiltinStrategy {
  return (ALL_STRATEGIES as readonly string[]).includes(s);
}

export function isExternalStrategy(s: string): s is ExternalStrategy {
  return EXTERNAL.has(s as StrategyName);
}

export function gitHead(root: string): string | undefined {
  const r = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

/** The text a strategy receives for a task. */
export function taskInput(task: BenchTask, input: BenchInput): string {
  if (input === 'question') return task.question;
  if (input === 'natural') return task.natural ?? task.question;
  return task.search ?? task.question;
}

// ---------------------------------------------------------------------------------------------------------
// kopt index (shared by the strategies, `bench quality` and `bench all`)

export interface IndexInfo {
  built: boolean;
  /** Build duration; for a reused index, the duration recorded when it was built (null when unknown). */
  durationMs: number | null;
  files: number;
  symbols: number;
  refs: number;
  path: string;
}

export interface OpenedIndex {
  store?: Store;
  retrieval?: RetrievalModule;
  config: KoptConfig;
  skip?: string;
  index?: IndexInfo;
}

const SIDECAR = 'bench-index.json';

interface Sidecar {
  commit?: string;
  durationMs: number;
  files: number;
  symbols: number;
  refs: number;
  date: string;
}

function readSidecar(dataDir: string): Sidecar | undefined {
  try {
    return JSON.parse(readFileSync(join(dataDir, SIDECAR), 'utf8')) as Sidecar;
  } catch {
    return undefined;
  }
}

/**
 * Opens (and builds or refreshes when needed) the kopt index of a checkout. The index lives outside the checkout
 * (`bench/repos/.kopt-<repo>` by default). A `bench-index.json` sidecar records the build time so that a reused
 * index still reports how long it took to build.
 */
export async function openKoptIndex(
  repoRoot: string,
  repoName: string,
  opts: { indexDir?: string; rebuildIndex?: boolean; modules?: KoptModules; needRetrieval?: boolean; onProgress?: (m: string) => void } = {},
): Promise<OpenedIndex> {
  const log = opts.onProgress ?? (() => {});
  const config = defaultConfig(repoRoot);
  config.dataDir = resolve(opts.indexDir ?? join(BENCH_DIR, 'repos', `.kopt-${repoName}`));
  const modules = opts.modules ?? (await loadKoptModules());
  if (opts.needRetrieval !== false && !modules.retrieval) {
    return { config, skip: `kopt retrieval module unavailable (${modules.errors.join('; ') || 'not built'})` };
  }
  const dbPath = indexPath(config);
  if (opts.rebuildIndex) {
    for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
    rmSync(join(config.dataDir, SIDECAR), { force: true });
  }
  const { Store } = await import('../store/store.js');
  const store = Store.open(dbPath, { root: config.root });
  const head = gitHead(config.root);
  const indexed = store.getMeta('commit');
  const empty = store.counts().files === 0;
  const stale = !empty && !!head && !!indexed && indexed !== head;
  const info = (built: boolean, durationMs: number | null): IndexInfo => {
    const c = store.counts();
    return { built, durationMs, files: c.files, symbols: c.symbols, refs: c.refs, path: dbPath };
  };
  if (empty || stale) {
    if (!modules.indexer) {
      store.close();
      return {
        config,
        skip: empty
          ? `no index at ${dbPath} and kopt indexer module unavailable (${modules.errors.join('; ')})`
          : `index at ${dbPath} is for ${indexed!.slice(0, 12)}, checkout is ${head!.slice(0, 12)}; rebuild needs the indexer module`,
      };
    }
    const t0 = Date.now();
    if (stale) {
      // checkout moved since the index was built: refresh so that kopt is not measured on stale data
      log(`index is stale (${indexed!.slice(0, 12)} != ${head!.slice(0, 12)}): refreshing`);
      if (modules.indexer.refreshIndex) await modules.indexer.refreshIndex(store, { config, repoName });
      else await modules.indexer.indexRepo(store, { config, repoName });
    } else {
      log(`indexing ${config.root} -> ${dbPath}`);
      let last = 0;
      await modules.indexer.indexRepo(store, {
        config,
        repoName,
        onProgress: (done, total) => {
          if (Date.now() - last > 2000) {
            last = Date.now();
            log(`  indexed ${done}/${total}`);
          }
        },
      });
    }
    const index = info(true, Date.now() - t0);
    if (empty) {
      const sc: Sidecar = { commit: head, durationMs: index.durationMs!, files: index.files, symbols: index.symbols, refs: index.refs, date: new Date().toISOString() };
      try {
        writeFileSync(join(config.dataDir, SIDECAR), JSON.stringify(sc, null, 2) + '\n');
      } catch {
        /* the sidecar is informative only */
      }
    }
    return { config, store, retrieval: modules.retrieval, index };
  }
  const sc = readSidecar(config.dataDir);
  return { config, store, retrieval: modules.retrieval, index: info(false, sc && (!sc.commit || sc.commit === indexed) ? sc.durationMs : null) };
}

function emptyRecall(task: BenchTask) {
  return { fileRecall: 0, symbolRecall: 0, defRecall: 0, filesMissed: [...task.gold.files], symbolsMissed: task.gold.symbols.map((s) => s.name), found: false };
}

/** Strategies to run: explicit list, or the built-ins plus every competitor that has results for this repo. */
export function resolveStrategies(requested: StrategyName[] | undefined, competitors: CompetitorFile[]): StrategyName[] {
  const out = requested?.length ? [...requested] : [...ALL_STRATEGIES, ...competitors.map((c) => c.tool)];
  for (const s of out) {
    if (!isBuiltinStrategy(s) && !isExternalStrategy(s)) {
      throw new Error(`unknown strategy ${s} (expected ${[...ALL_STRATEGIES, ...EXTERNAL_STRATEGIES].join(', ')})`);
    }
  }
  return [...new Set(out)];
}

export async function runBench(opts: BenchOptions): Promise<BenchResult> {
  const started = Date.now();
  const log = opts.onProgress ?? (() => {});
  const repoRoot = resolve(opts.repoRoot);
  const repo: RepoMeta = opts.repo ?? { name: basename(repoRoot) };
  const input = opts.input ?? 'search';
  const competitorsDir = resolve(opts.competitorsDir ?? COMPETITORS_DIR);
  const competitors = loadCompetitors(competitorsDir, repo.name);
  const strategies = resolveStrategies(opts.strategies, competitors);
  if (opts.charsPerToken) setCharsPerToken(opts.charsPerToken);
  const charsPerToken = tokensToChars(1000) / 1000;
  const native = { ...NATIVE_DEFAULTS, ...opts.native, grepLimits: opts.native?.grepLimits ?? KIRO_GREP_LIMITS, grepCache: new Map() };
  const defSigs = goldDefSignatures(repoRoot, opts.tasks);
  const notes: string[] = [];

  let kopt: OpenedIndex | undefined;
  if (strategies.some((s) => KOPT_STRATEGIES.has(s))) {
    try {
      kopt = await openKoptIndex(repoRoot, repo.name, { indexDir: opts.indexDir, rebuildIndex: opts.rebuildIndex, modules: opts.modules, onProgress: log });
    } catch (err) {
      kopt = { config: defaultConfig(repoRoot), skip: `kopt setup failed: ${(err as Error).message}` };
    }
    if (kopt.skip) {
      log(`kopt strategies skipped: ${kopt.skip}`);
      notes.push(`kopt strategies skipped: ${kopt.skip}`);
    }
  }
  const competitorFor = new Map<StrategyName, CompetitorFile>(competitors.map((c) => [c.tool, c]));
  for (const c of competitors) {
    if (strategies.includes(c.tool)) {
      notes.push(`${c.tool}: outputs loaded from ${c.path}${c.invalid.length ? ` (${c.invalid.length} invalid lines ignored: ${c.invalid.slice(0, 3).join('; ')})` : ''}`);
    }
  }
  const mismatches = new Map<StrategyName, number>();

  const results: TaskStrategyResult[] = [];
  try {
    for (const task of opts.tasks) {
      const text = taskInput(task, input);
      for (const strategy of strategies) {
        const base = { taskId: task.id, kind: task.kind, strategy };
        if (isExternalStrategy(strategy)) {
          const file = competitorFor.get(strategy);
          if (!file) {
            const why = `no ${strategy} results file (${competitorPath(competitorsDir, strategy, repo.name)})`;
            results.push({ ...base, skipped: why, tokens: 0, chars: 0, toolCalls: 0, durationMs: 0, recall: emptyRecall(task), calls: [] });
            continue;
          }
          const { result, mismatch } = competitorResult(file, task, text, defSigs, opts.keepOutputs);
          if (mismatch) mismatches.set(strategy, (mismatches.get(strategy) ?? 0) + 1);
          results.push(result);
          continue;
        }
        if (KOPT_STRATEGIES.has(strategy) && (!kopt?.store || !kopt.retrieval)) {
          results.push({ ...base, skipped: kopt?.skip ?? 'kopt unavailable', tokens: 0, chars: 0, toolCalls: 0, durationMs: 0, recall: emptyRecall(task), calls: [] });
          continue;
        }
        const t0 = performance.now();
        let out: StrategyOutput;
        try {
          switch (strategy) {
            case 'native-naive':
              out = nativeNaive(repoRoot, text, native);
              break;
            case 'native-ranged':
              out = nativeRanged(repoRoot, text, native);
              break;
            case 'kopt-pack':
              out = koptPack(kopt!.store!, kopt!.retrieval!, kopt!.config, text);
              break;
            case 'kopt-hits+read':
              out = koptHitsRead(kopt!.store!, kopt!.retrieval!, kopt!.config, text);
              break;
            default:
              throw new Error(`unhandled strategy ${strategy}`);
          }
        } catch (err) {
          // a crash is a failed attempt, not a skip: it stays in the denominators
          const error = (err as Error).message.split('\n')[0];
          log(`${task.id} ${strategy}: error: ${error}`);
          results.push({ ...base, error, tokens: 0, chars: 0, toolCalls: 0, durationMs: Math.round(performance.now() - t0), recall: emptyRecall(task), calls: [] });
          continue;
        }
        const durationMs = Math.round(performance.now() - t0);
        const recall = computeRecall(out.text, task.gold, defSigs);
        results.push({
          ...base,
          tokens: out.calls.reduce((a, c) => a + c.tokens, 0),
          chars: out.calls.reduce((a, c) => a + c.chars, 0),
          toolCalls: out.calls.length,
          durationMs,
          recall,
          calls: out.calls,
          ...(opts.keepOutputs ? { output: out.text } : {}),
        });
      }
      log(`${task.id}: ${strategies.map((s) => {
        const r = results.find((x) => x.taskId === task.id && x.strategy === s)!;
        return r.skipped ? `${s}=skip` : r.error ? `${s}=error` : `${s}=${r.tokens}tok/${r.recall.found ? 'found' : 'miss'}`;
      }).join(' ')}`);
    }
  } finally {
    kopt?.store?.close();
  }
  for (const [s, n] of mismatches) notes.push(`${s}: ${n} task(s) scored from a result line whose input differs from the bench input (${input})`);

  const paired: PairedComparison[] = [];
  const natives = strategies.filter((s) => s === 'native-naive' || s === 'native-ranged');
  const kopts = strategies.filter((s) => KOPT_STRATEGIES.has(s));
  const externals = strategies.filter((s) => isExternalStrategy(s));
  for (const b of kopts) for (const a of natives) paired.push(compare(a, b, results));
  for (const b of kopts) for (const a of externals) paired.push(compare(a, b, results));
  for (const b of externals) if (natives.includes('native-ranged')) paired.push(compare('native-ranged', b, results));
  if (natives.includes('native-naive') && natives.includes('native-ranged')) paired.push(compare('native-naive', 'native-ranged', results));

  const label = opts.label ?? `${repo.name}${input === 'search' ? '' : `-${input}`}`;
  const meta: BenchMeta = {
    label,
    repo,
    repoRoot,
    headCommit: gitHead(repoRoot),
    date: new Date().toISOString(),
    input,
    charsPerToken,
    strategies,
    grepLimits: native.grepLimits,
    readLimits: {
      naiveTopFiles: native.naiveTopFiles,
      naiveMaxLines: native.naiveMaxLines,
      rangedMatches: native.rangedMatches,
      rangedContext: native.rangedContext,
    },
    koptBudgets: kopt && !kopt.skip ? { find: kopt.config.budgets.find, pack: kopt.config.budgets.pack, read: kopt.config.budgets.read } : undefined,
    index: kopt?.index ? { built: kopt.index.built, durationMs: kopt.index.built ? kopt.index.durationMs ?? 0 : 0, files: kopt.index.files, symbols: kopt.index.symbols, path: kopt.index.path } : undefined,
    notes,
    durationMs: Date.now() - started,
  };
  if (repo.commit && meta.headCommit && repo.commit !== meta.headCommit) {
    notes.push(`WARNING: checkout HEAD ${meta.headCommit.slice(0, 12)} differs from the pinned commit ${repo.commit.slice(0, 12)}; gold items may be stale`);
  }
  return {
    meta,
    results,
    aggregates: strategies.map((s) => aggregate(s, results)),
    paired,
    byKind: aggregateByKind(results, strategies),
  };
}

/** Checkout path of a repo: `repo.path` (project-relative) or `bench/repos/<name>`. */
export function checkoutPath(repo: RepoMeta): string {
  return resolve(PROJECT_ROOT, repo.path ?? join('bench', 'repos', repo.name));
}

export function checkoutExists(root: string): boolean {
  return existsSync(root);
}
