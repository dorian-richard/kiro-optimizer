// Types of the offline benchmark (kopt bench). Task files live in bench/tasks/<repo>.json.

import type { Lang } from '../core/types.js';

export type TaskKind = 'locate' | 'explain' | 'usage' | 'impact';

export interface GoldSymbol {
  /** Simple name as written in code (case-sensitive), e.g. `rotate_token`, `ConfigurationClassParser`. */
  name: string;
  /** Repo-relative path of the definition. */
  file: string;
  /** 1-based line of the definition (the line that contains the name). */
  line: number;
  kind?: string;
}

export interface BenchTask {
  id: string;
  kind: TaskKind;
  /** Language of the prompt. Shipped task files are English only. */
  lang?: 'en';
  /** The developer prompt, verbatim. */
  question: string;
  /**
   * Optional English paraphrase that describes the behaviour without naming any identifier (tests
   * natural-language retrieval). Used with `--input natural`; falls back to `question`.
   */
  natural?: string;
  /**
   * The search phrase an agent would derive from the question (English identifiers/words).
   * Shared by every strategy so that they all receive the same information. Defaults to `question`.
   */
  search?: string;
  gold: { files: string[]; symbols: GoldSymbol[] };
  /** How the gold items were verified (who/what read the code). */
  verifiedBy: string;
}

export interface RepoMeta {
  name: string;
  url?: string;
  tag?: string;
  commit?: string;
  language?: string;
  /** Checkout path, relative to the project root (default `bench/repos/<name>`). */
  path?: string;
}

export interface TaskFile {
  repo: RepoMeta;
  notes?: string;
  tasks: BenchTask[];
}

/** Strategies computed by the bench itself. */
export type BuiltinStrategy = 'native-naive' | 'native-ranged' | 'kopt-pack' | 'kopt-hits+read';
/**
 * Competitor tools run elsewhere (Docker harness); their outputs are loaded from
 * `bench/competitors/results/<tool>-<repo>.jsonl` (see competitors.ts) and scored with the same metrics.
 */
export type ExternalStrategy = 'kirograph' | 'codegraph';
export type StrategyName = BuiltinStrategy | ExternalStrategy;

export const ALL_STRATEGIES: readonly BuiltinStrategy[] = ['native-naive', 'native-ranged', 'kopt-pack', 'kopt-hits+read'];
export const EXTERNAL_STRATEGIES: readonly ExternalStrategy[] = ['kirograph', 'codegraph'];

/** Which task field feeds the strategies. */
export type BenchInput = 'search' | 'question' | 'natural';

/** One emulated tool call and what it returned to the model. */
export interface ToolCallRecord {
  tool: string;
  args: string;
  chars: number;
  tokens: number;
}

export interface StrategyOutput {
  calls: ToolCallRecord[];
  /** Everything returned to the model, concatenated in call order. */
  text: string;
}

export interface RecallResult {
  fileRecall: number;
  symbolRecall: number;
  /** Share of gold symbols whose definition line (identifier sequence) was shown, stricter than name recall. */
  defRecall: number;
  filesMissed: string[];
  symbolsMissed: string[];
  /** All gold files AND all gold symbol names present in the output. */
  found: boolean;
}

export interface TaskStrategyResult {
  taskId: string;
  kind: TaskKind;
  strategy: StrategyName;
  /** Set when the strategy could not run at all (module missing). Excluded from aggregates. */
  skipped?: string;
  /** Set when the strategy crashed on this task. Counted as a failed attempt (found = false). */
  error?: string;
  tokens: number;
  chars: number;
  toolCalls: number;
  durationMs: number;
  recall: RecallResult;
  calls: ToolCallRecord[];
  /** Full output, only kept with `keepOutputs`. */
  output?: string;
}

export interface StrategyAggregate {
  strategy: StrategyName;
  /** Tasks attempted (errors included, skips excluded). */
  tasks: number;
  skipped: number;
  errors: number;
  medianTokens: number;
  meanTokens: number;
  p90Tokens: number;
  totalTokens: number;
  totalChars: number;
  meanToolCalls: number;
  meanFileRecall: number;
  meanSymbolRecall: number;
  meanDefRecall: number;
  found: number;
  foundRate: number;
  /** totalTokens / found (cost per solved task, failures included). null when nothing was found. */
  tokensPerFound: number | null;
}

/** Pass-gated comparison: only tasks found by BOTH strategies. */
export interface PairedComparison {
  a: StrategyName;
  b: StrategyName;
  /** Tasks run by both (not skipped). */
  nRun: number;
  /** Tasks found by both. */
  nBoth: number;
  onlyA: number;
  onlyB: number;
  /** Median of tokens(b)/tokens(a) over jointly found tasks. */
  medianRatio: number | null;
  geoMeanRatio: number | null;
  /** Tasks (jointly found) where b used fewer tokens than a. */
  bCheaper: number;
}

export interface KindAggregate {
  kind: TaskKind;
  strategy: StrategyName;
  tasks: number;
  found: number;
  medianTokens: number;
}

export interface BenchMeta {
  label: string;
  repo: RepoMeta;
  repoRoot: string;
  /** HEAD of the checkout actually measured. */
  headCommit?: string;
  date: string;
  input: BenchInput;
  charsPerToken: number;
  strategies: StrategyName[];
  grepLimits: { maxMatches: number; maxChars: number; maxLineChars: number };
  readLimits: { naiveTopFiles: number; naiveMaxLines: number; rangedMatches: number; rangedContext: number };
  koptBudgets?: { find: number; pack: number; read: number };
  index?: { built: boolean; durationMs: number; files?: number; symbols?: number; path: string };
  notes: string[];
  durationMs: number;
}

export interface BenchResult {
  meta: BenchMeta;
  results: TaskStrategyResult[];
  aggregates: StrategyAggregate[];
  paired: PairedComparison[];
  byKind: KindAggregate[];
}

// ---------------------------------------------------------------------------------------------------------
// Multi-language corpus (bench/langs.json)

/** Indexer language ids (mirrors `Lang` in core/types.ts). */
export type LangId = Lang;

export interface LangRepo {
  /** Short name: task file `bench/tasks/<name>.json`, checkout `bench/repos/<name>`. */
  name: string;
  /** Primary language measured in this repo (indexer language id). */
  language: LangId;
  /** Other indexer languages with a meaningful share of the code (reported, not headlined). */
  otherLanguages?: LangId[];
  url: string;
  /** Pinned release tag (cloned with `--depth 1 --branch <tag>`). */
  tag: string;
  /** Commit the tag pointed to when the gold items were written. */
  commit: string;
  license: string;
  /** Files and newline count of the primary language in `git ls-files` at the tag. */
  files: number;
  loc: number;
  /** Why this repository represents the language. */
  reason: string;
}

export interface LangsFile {
  version: 1;
  notes?: string;
  repos: LangRepo[];
}

// ---------------------------------------------------------------------------------------------------------
// Extraction quality (kopt bench quality <repo>) -> bench/results/quality-<repo>.{md,json}

export interface ParseErrorStats {
  /** Files re-parsed with web-tree-sitter (seeded random sample of the indexed files of this language). */
  sampledFiles: number;
  sampledLines: number;
  /** Files whose tree contains at least one ERROR or MISSING node. */
  filesWithErrors: number;
  /** Outermost ERROR nodes (nested ERROR nodes are not counted twice). */
  errorNodes: number;
  /** MISSING nodes inserted by error recovery. */
  missingNodes: number;
  /** filesWithErrors / sampledFiles. */
  errorFileRate: number;
  /** (errorNodes + missingNodes) per 1000 sampled lines. */
  errorsPerKloc: number;
  /** Files the parser gave up on (timeout) or that could not be read. */
  parseFailures: number;
  /** Files with the most error nodes (diagnostics). */
  worst: Array<{ path: string; errors: number; firstErrorLine: number }>;
}

export interface PrecisionChecks {
  /** (a) the name appears as a whole identifier on the declaration header lines. */
  name: boolean;
  /** (b1) the range starts at an annotation/decorator/doc line or a declaration-looking line. */
  start: boolean;
  /** (b2) the range ends at a plausible block end (balanced brackets, `end`, indentation). */
  end: boolean;
  /** (c) the stored signature's identifiers appear, in order, in the source of the range. */
  signature: boolean;
}

export interface PrecisionSample {
  id: number;
  path: string;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  checks: PrecisionChecks;
  ok: boolean;
  /** Why a check failed (empty when ok). */
  reasons: string[];
  firstLine: string;
  lastLine: string;
  signature: string;
}

export interface PrecisionStats {
  sampled: number;
  nameOk: number;
  startOk: number;
  endOk: number;
  signatureOk: number;
  /** All four checks pass. */
  allOk: number;
  rate: number;
  /** Failed samples only (passed ones are counted, not listed). */
  failures: PrecisionSample[];
}

export interface LangQuality {
  lang: LangId;
  files: number;
  lines: number;
  symbols: number;
  symbolsPerKloc: number;
  /** Symbols per kind, with the per-KLOC density. */
  byKind: Record<string, { count: number; perKloc: number }>;
  refs: number;
  refsResolved: number;
  /** refsResolved / refs (external library refs count as unresolved, so 100% is not the goal). */
  resolvedRate: number;
  /** Refs whose name is defined somewhere in the repo (an in-repo target is plausible). */
  refsWithCandidate: number;
  /** refsResolved / refsWithCandidate: the resolver's coverage where it could have resolved. */
  resolvedOfCandidates: number;
  refsByKind: Record<string, { total: number; resolved: number }>;
  parse: ParseErrorStats;
  precision: PrecisionStats;
}

export interface QualityReport {
  repo: string;
  /** Primary language (from bench/langs.json) when known. */
  language?: LangId;
  repoRoot: string;
  headCommit?: string;
  date: string;
  index: { built: boolean; durationMs: number | null; path: string; files: number; symbols: number; refs: number };
  files: {
    indexed: number;
    skipped: number;
    skippedByReason: Record<string, number>;
    indexedByLang: Record<string, number>;
  };
  /** One entry per indexed language, primary language first, then by file count. */
  langs: LangQuality[];
  settings: { parseSamplePerLang: number; precisionSamplePerLang: number; seed: string };
  durationMs: number;
}

// ---------------------------------------------------------------------------------------------------------
// Corpus summary (kopt bench all) -> bench/results/summary.{md,json}
//
// summary.json is the input of the report generators (docs/BENCHMARKS.md, HTML page). Its shape:
//   BenchSummary {
//     schema: 'kopt-bench-summary/1'        // bump on breaking changes
//     date, input, strategies[]             // strategies = column order of the tables
//     environment: { node, platform, toolVersion }
//     rows: SummaryRow[]                    // one per repo of bench/langs.json, in file order
//     totals: SummaryStrategyCell[]         // pooled over every task of every repo that ran
//     notes: string[]
//   }
// Every number is raw (rates in 0..1, tokens as integers, durations in ms); formatting is the generator's job.
// `null` means "not measured" (e.g. no index time for a reused index without a recorded build).

export interface SummaryStrategyCell {
  strategy: StrategyName;
  /** Tasks attempted (skips excluded). 0 when the strategy did not run on this repo. */
  tasks: number;
  found: number;
  foundRate: number;
  medianTokens: number;
  meanTokens: number;
  /** All tokens spent (failures included) / tasks found; null when nothing was found. */
  tokensPerFound: number | null;
  meanFileRecall: number;
  meanSymbolRecall: number;
  meanDefRecall: number;
  /** Tasks skipped (module missing, no competitor result line). */
  skipped: number;
}

export interface SummaryKindCell {
  kind: TaskKind;
  strategy: StrategyName;
  tasks: number;
  found: number;
}

export interface SummaryRow {
  repo: string;
  language: LangId;
  tag: string;
  commit: string;
  /** Primary-language LOC from bench/langs.json. */
  loc: number;
  /** False when the repo could not be benchmarked (see `error`). */
  ok: boolean;
  error?: string;
  /** Gold items failing `--verify` (should be 0). */
  verifyIssues: number;
  tasks: number;
  index: { built: boolean; durationMs: number | null; files: number; symbols: number; refs: number } | null;
  quality: {
    filesIndexed: number;
    filesSkipped: number;
    /** Primary language only. */
    parseErrorFileRate: number;
    parseErrorsPerKloc: number;
    symbolsPerKloc: number;
    resolvedRate: number;
    resolvedOfCandidates: number;
    precisionRate: number;
    precisionSampled: number;
  } | null;
  strategies: SummaryStrategyCell[];
  byKind: SummaryKindCell[];
  /** Repo-relative paths of the detailed result files. */
  files: { bench?: string; quality?: string };
  durationMs: number;
}

export interface BenchSummary {
  schema: 'kopt-bench-summary/1';
  date: string;
  input: BenchInput;
  strategies: StrategyName[];
  environment: { node: string; platform: string; toolVersion: string };
  rows: SummaryRow[];
  totals: SummaryStrategyCell[];
  notes: string[];
}
