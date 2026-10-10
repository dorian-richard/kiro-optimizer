// Markdown + JSON output of a benchmark run.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BenchResult, StrategyName, TaskStrategyResult } from './types.js';
import { writePortable } from './portable.js';

const pct = (x: number) => `${Math.round(x * 100)}%`;
const num = (x: number) => Math.round(x).toLocaleString('en-US');
const ratio = (x: number | null) => (x === null ? 'n/a' : `${x.toFixed(2)}×`);

function table(head: string[], rows: string[][]): string {
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

function cell(r: TaskStrategyResult | undefined): string {
  if (!r) return '';
  if (r.skipped) return 'skipped';
  if (r.error) return `ERROR (${r.error.slice(0, 60)})`;
  const missed = [...r.recall.filesMissed.map((f) => f.split('/').pop()), ...r.recall.symbolsMissed];
  const shown = missed.slice(0, 4).join(', ') + (missed.length > 4 ? `, +${missed.length - 4}` : '');
  const miss = r.recall.found ? '' : ` (miss ${shown})`;
  return `${num(r.tokens)} ${r.recall.found ? 'OK' : 'NO'}${miss}`;
}

export function renderMarkdown(res: BenchResult): string {
  const m = res.meta;
  const out: string[] = [];
  out.push(`# kopt bench: ${m.label}`);
  out.push('');
  out.push(
    `Repo \`${m.repo.name}\`${m.repo.tag ? ` @ \`${m.repo.tag}\`` : ''}${m.headCommit ? ` (\`${m.headCommit.slice(0, 12)}\`)` : ''} · ` +
      `${res.results.length ? new Set(res.results.map((r) => r.taskId)).size : 0} tasks · input = \`${m.input}\` · ` +
      `${m.charsPerToken} chars/token · ${m.date}`,
  );
  out.push('');
  out.push('> Offline proxy: tokens = estimated tokens of tool outputs returned to the model for ONE exploration step.');
  out.push('> It is not a credit measurement. Savings must be confirmed by the online A/B (bench/ab) before being claimed.');
  out.push('');

  const skipped = res.aggregates.filter((a) => a.skipped && !a.tasks);
  if (skipped.length) {
    const reasons = [...new Set(res.results.filter((r) => r.skipped).map((r) => r.skipped))];
    out.push(`Skipped strategies: ${skipped.map((a) => a.strategy).join(', ')} — ${reasons.join('; ')}`);
    out.push('');
  }

  out.push('## Summary per strategy');
  out.push('');
  out.push(
    table(
      ['strategy', 'tasks', 'found', 'file recall', 'symbol recall', 'def recall', 'median tok', 'mean tok', 'p90 tok', 'tok / found task', 'calls'],
      res.aggregates
        .filter((a) => a.tasks)
        .map((a) => [
          a.strategy,
          a.errors ? `${a.tasks} (${a.errors} errors)` : String(a.tasks),
          `${a.found} (${pct(a.foundRate)})`,
          pct(a.meanFileRecall),
          pct(a.meanSymbolRecall),
          pct(a.meanDefRecall),
          num(a.medianTokens),
          num(a.meanTokens),
          num(a.p90Tokens),
          a.tokensPerFound === null ? 'n/a' : num(a.tokensPerFound),
          a.meanToolCalls.toFixed(1),
        ]),
    ),
  );
  out.push('');
  out.push('`found` = every gold file path AND every gold symbol name appears in the output. `def recall` = the definition line');
  out.push('of the gold symbol was shown (stricter). `tok / found task` = all tokens spent (failures included) / tasks found.');
  out.push('');

  const paired = res.paired.filter((p) => p.nRun);
  if (paired.length) {
    out.push('## Pass-gated pairs (only tasks found by both)');
    out.push('');
    out.push(
      table(
        ['b vs a', 'tasks run', 'found by both', 'only a', 'only b', 'median b/a', 'geomean b/a', 'b cheaper'],
        paired.map((p) => [
          `${p.b} vs ${p.a}`,
          String(p.nRun),
          String(p.nBoth),
          String(p.onlyA),
          String(p.onlyB),
          ratio(p.medianRatio),
          ratio(p.geoMeanRatio),
          `${p.bCheaper}/${p.nBoth}`,
        ]),
      ),
    );
    out.push('');
  }

  if (res.byKind.length) {
    out.push('## By task kind');
    out.push('');
    out.push(table(['kind', 'strategy', 'tasks', 'found', 'median tok'], res.byKind.map((k) => [k.kind, k.strategy, String(k.tasks), String(k.found), num(k.medianTokens)])));
    out.push('');
  }

  out.push('## Per task (tokens, found)');
  out.push('');
  const strategies = m.strategies;
  const ids = [...new Set(res.results.map((r) => r.taskId))];
  const get = (id: string, s: StrategyName) => res.results.find((r) => r.taskId === id && r.strategy === s);
  out.push(
    table(
      ['task', 'kind', ...strategies],
      ids.map((id) => [id, get(id, strategies[0])?.kind ?? '', ...strategies.map((s) => cell(get(id, s)))]),
    ),
  );
  out.push('');

  out.push('## Settings');
  out.push('');
  out.push(
    `- grep_search emulation: ${m.grepLimits.maxMatches} matches / ${num(m.grepLimits.maxChars)} chars, lines cut at ${m.grepLimits.maxLineChars} chars; ` +
      'pattern = most selective keywords while the total stays under the match cap; files ordered by distinct keywords, non-test first, match count (generous to native).',
  );
  out.push(`- native-naive: top ${m.readLimits.naiveTopFiles} files by visible match count, whole file capped at ${m.readLimits.naiveMaxLines} lines.`);
  out.push(`- native-ranged: ±${m.readLimits.rangedContext} lines around the best ${m.readLimits.rangedMatches} matches (overlaps merged).`);
  if (m.koptBudgets) out.push(`- kopt budgets: find ${m.koptBudgets.find}, pack ${m.koptBudgets.pack}, read ${m.koptBudgets.read} tokens.`);
  if (m.index) out.push(`- index: ${m.index.built ? `built in ${num(m.index.durationMs)} ms` : 'reused'}${m.index.files !== undefined ? `, ${num(m.index.files)} files, ${num(m.index.symbols ?? 0)} symbols` : ''}.`);
  for (const n of m.notes) out.push(`- ${n}`);
  out.push(`- run duration: ${num(m.durationMs)} ms.`);
  out.push('');
  return out.join('\n');
}

/** Writes `<label>.md` and `<label>.json` (+ `<label>.raw.json` with full outputs when present). */
export function writeResults(res: BenchResult, outDir: string): string[] {
  mkdirSync(outDir, { recursive: true });
  const safe = res.meta.label.replace(/[^\w.-]+/g, '_');
  const md = join(outDir, `${safe}.md`);
  const json = join(outDir, `${safe}.json`);
  writePortable(md, renderMarkdown(res));
  const slim = { ...res, results: res.results.map(({ output: _o, ...r }) => r) };
  writePortable(json, JSON.stringify(slim, null, 2) + '\n');
  const written = [md, json];
  if (res.results.some((r) => r.output !== undefined)) {
    const raw = join(outDir, `${safe}.raw.json`);
    writeFileSync(raw, JSON.stringify(res.results.map((r) => ({ taskId: r.taskId, strategy: r.strategy, output: r.output })), null, 1) + '\n');
    written.push(raw);
  }
  return written;
}
