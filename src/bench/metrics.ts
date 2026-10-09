// Recall of gold items in a strategy's output, and aggregate statistics.

import type {
  BenchTask,
  KindAggregate,
  PairedComparison,
  RecallResult,
  StrategyAggregate,
  StrategyName,
  TaskKind,
  TaskStrategyResult,
} from './types.js';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Path mentioned as a whole path (not as a prefix/suffix of a longer path). */
export function mentionsPath(output: string, path: string): boolean {
  return new RegExp(`(?<![\\w./-])${escapeRegex(path)}(?![\\w/-]|\\.\\w)`).test(output);
}

/** Identifier mentioned as a whole word (case-sensitive: code identifiers are). */
export function mentionsName(output: string, name: string): boolean {
  return new RegExp(`(?<![\\w$])${escapeRegex(name)}(?![\\w$])`).test(output);
}

/** Identifiers of a line, annotations/decorators dropped (`@Override public void x()` -> [public, void, x]). */
export function identSeq(line: string): string[] {
  return [...line.replace(/@[\w.]+(\([^)]*\))?/g, ' ').matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]);
}

/**
 * Identifier sequence of a definition line up to and including the symbol name, e.g.
 * `    def rotate_token(request):` -> [def, rotate_token]. Undefined when the name is not on the line.
 */
export function defSignature(line: string, name: string): string[] | undefined {
  const seq = identSeq(line);
  // Ruby predicate/bang/setter methods (`valid?`, `revise!`, `name=`): the suffix is punctuation for identSeq
  const base = /^[A-Za-z_$][\w$]*[?!=]$/.test(name) ? name.slice(0, -1) : name;
  const i = seq.indexOf(base);
  return i < 0 ? undefined : seq.slice(0, i + 1);
}

function containsSeq(hay: string[], needle: string[]): boolean {
  if (!needle.length || needle.length > hay.length) return false;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** Pre-computed per-output data so that several gold symbols can be checked cheaply. */
export class OutputIndex {
  private seqs?: string[][];
  constructor(readonly text: string) {}

  /** True when some output line shows the definition line (same identifier sequence up to the name). */
  showsDefinition(sig: string[]): boolean {
    if (!sig.length) return false;
    const last = sig[sig.length - 1];
    if (!this.text.includes(last)) return false;
    this.seqs ??= this.text.split('\n').map(identSeq);
    return this.seqs.some((s) => containsSeq(s, sig));
  }
}

/**
 * @param defSigs gold symbol name -> definition signature (see defSignature); symbols without one fall back to
 *   name recall for defRecall.
 */
export function computeRecall(output: string, gold: BenchTask['gold'], defSigs: Map<string, string[]> = new Map()): RecallResult {
  const idx = new OutputIndex(output);
  const filesMissed = gold.files.filter((f) => !mentionsPath(output, f));
  const symbolsMissed = gold.symbols.filter((s) => !mentionsName(output, s.name)).map((s) => s.name);
  let defHits = 0;
  for (const s of gold.symbols) {
    const sig = defSigs.get(`${s.file}:${s.line}`);
    if (sig ? idx.showsDefinition(sig) : mentionsName(output, s.name)) defHits++;
  }
  const nf = gold.files.length;
  const ns = gold.symbols.length;
  return {
    fileRecall: nf ? (nf - filesMissed.length) / nf : 1,
    symbolRecall: ns ? (ns - symbolsMissed.length) / ns : 1,
    defRecall: ns ? defHits / ns : 1,
    filesMissed,
    symbolsMissed,
    found: filesMissed.length === 0 && symbolsMissed.length === 0,
  };
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Nearest-rank percentile (p in 0..100). */
export function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

export function geoMean(xs: number[]): number {
  const pos = xs.filter((x) => x > 0);
  if (!pos.length) return 0;
  return Math.exp(pos.reduce((a, x) => a + Math.log(x), 0) / pos.length);
}

export function aggregate(strategy: StrategyName, results: TaskStrategyResult[]): StrategyAggregate {
  const rs = results.filter((r) => r.strategy === strategy);
  const ran = rs.filter((r) => !r.skipped);
  // token statistics over completed attempts only (a crash returning 0 tokens must not look cheap)
  const tokens = ran.filter((r) => !r.error).map((r) => r.tokens);
  const found = ran.filter((r) => r.recall.found).length;
  const totalTokens = tokens.reduce((a, b) => a + b, 0);
  return {
    strategy,
    tasks: ran.length,
    skipped: rs.length - ran.length,
    errors: ran.filter((r) => r.error).length,
    medianTokens: median(tokens),
    meanTokens: Math.round(mean(tokens)),
    p90Tokens: percentile(tokens, 90),
    totalTokens,
    totalChars: ran.reduce((a, r) => a + r.chars, 0),
    meanToolCalls: mean(ran.map((r) => r.toolCalls)),
    meanFileRecall: mean(ran.map((r) => r.recall.fileRecall)),
    meanSymbolRecall: mean(ran.map((r) => r.recall.symbolRecall)),
    meanDefRecall: mean(ran.map((r) => r.recall.defRecall)),
    found,
    foundRate: ran.length ? found / ran.length : 0,
    tokensPerFound: found ? Math.round(totalTokens / found) : null,
  };
}

/** Pass-gated paired comparison of b against a (ratios are b/a: < 1 means b is cheaper). */
export function compare(a: StrategyName, b: StrategyName, results: TaskStrategyResult[]): PairedComparison {
  const byTask = new Map<string, { a?: TaskStrategyResult; b?: TaskStrategyResult }>();
  for (const r of results) {
    if (r.skipped || (r.strategy !== a && r.strategy !== b)) continue;
    const e = byTask.get(r.taskId) ?? {};
    if (r.strategy === a) e.a = r;
    else e.b = r;
    byTask.set(r.taskId, e);
  }
  const ratios: number[] = [];
  let nRun = 0;
  let onlyA = 0;
  let onlyB = 0;
  let bCheaper = 0;
  for (const { a: ra, b: rb } of byTask.values()) {
    if (!ra || !rb) continue;
    nRun++;
    const fa = ra.recall.found;
    const fb = rb.recall.found;
    if (fa && fb) {
      ratios.push(rb.tokens / Math.max(1, ra.tokens));
      if (rb.tokens < ra.tokens) bCheaper++;
    } else if (fa) onlyA++;
    else if (fb) onlyB++;
  }
  return {
    a,
    b,
    nRun,
    nBoth: ratios.length,
    onlyA,
    onlyB,
    medianRatio: ratios.length ? median(ratios) : null,
    geoMeanRatio: ratios.length ? geoMean(ratios) : null,
    bCheaper,
  };
}

export function aggregateByKind(results: TaskStrategyResult[], strategies: StrategyName[]): KindAggregate[] {
  const kinds: TaskKind[] = ['locate', 'explain', 'usage', 'impact'];
  const out: KindAggregate[] = [];
  for (const kind of kinds) {
    for (const strategy of strategies) {
      const rs = results.filter((r) => r.kind === kind && r.strategy === strategy && !r.skipped);
      if (!rs.length) continue;
      out.push({ kind, strategy, tasks: rs.length, found: rs.filter((r) => r.recall.found).length, medianTokens: median(rs.map((r) => r.tokens)) });
    }
  }
  return out;
}
