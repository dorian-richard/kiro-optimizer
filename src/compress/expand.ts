// kopt_expand: read more of a stored command output by handle (line range and/or regex with context).

import type { ExpandParams } from '../core/api.js';
import type { ToolContext } from '../core/context.js';
import { estimateTokens, tokensToChars, truncateLines } from '../core/tokens.js';
import type { ToolResult } from '../core/types.js';
import { capLine } from './filters/common.js';
import { OutputStore } from './outputs.js';

const GREP_CONTEXT = 2;
/** Regex matching is limited to this prefix of each line (bounds pathological patterns on huge lines). */
const GREP_LINE_CHARS = 4000;

function oneLine(text: string, meta?: Record<string, unknown>): ToolResult {
  return { text, tokens: estimateTokens(text), meta };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

export function expandOutput(p: ExpandParams, ctx: ToolContext): ToolResult {
  ctx.ledger.tick();
  const cfg = ctx.config;
  const handle = String(p.handle ?? '').trim().replace(/^(?:kopt_expand\s+)?#?/, '');
  const maxTokens = Math.max(40, p.maxTokens ?? cfg.budgets.expand);
  const store = new OutputStore(cfg.dataDir);
  const log = store.readLog(handle);
  if (log === undefined) return oneLine(`unknown output handle ${handle || '(empty)'} (expired or never created) – re-run with kopt_run`, { found: false });
  touch(store, handle);
  const lines = log.split('\n');
  const n = lines.length;
  const start = clamp(p.startLine ?? 1, 1, n);
  const end = clamp(p.endLine ?? n, start, n);

  if (p.grep !== undefined && p.grep !== '') {
    let re: RegExp;
    try {
      re = new RegExp(p.grep, 'i');
    } catch (err) {
      return oneLine(`invalid grep regex /${p.grep}/: ${(err as Error).message}`);
    }
    const ranges: [number, number][] = [];
    let matches = 0;
    for (let i = start - 1; i < end; i++) {
      const line = lines[i];
      if (!re.test(line.length > GREP_LINE_CHARS ? line.slice(0, GREP_LINE_CHARS) : line)) continue;
      matches++;
      const s = Math.max(start - 1, i - GREP_CONTEXT);
      const e = Math.min(end - 1, i + GREP_CONTEXT);
      const last = ranges[ranges.length - 1];
      if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
      else ranges.push([s, e]);
    }
    if (!matches) return oneLine(`${handle} lines ${start}-${end} of ${n} · 0 matches for /${p.grep}/`, { matches: 0 });
    const sections = ranges.map(([s, e]) => [`-- ${s + 1}-${e + 1}`, ...lines.slice(s, e + 1).map((l) => capLine(l))].join('\n'));
    const headerFor = (a: number, b: number) => `${handle} lines ${a}-${b} of ${n} · ${matches} matches for /${p.grep}/`;
    const budget = maxTokens - estimateTokens(headerFor(n, n)) - 12;
    const kept: string[] = [];
    let used = 0;
    let k = 0;
    for (; k < sections.length; k++) {
      const t = estimateTokens(sections[k]) + 1;
      if (used + t > budget) {
        if (!kept.length) {
          kept.push(truncateLines(sections[k], budget, (c) => `… ${c} more lines`).text);
          k++;
        }
        break;
      }
      kept.push(sections[k]);
      used += t;
    }
    const lastShown = ranges[Math.max(0, k - 1)][1] + 1;
    const body = kept.join('\n');
    const more = k < ranges.length ? `\n… +${ranges.length - k} more match groups (startLine:${ranges[k][0] + 1})` : '';
    const text = `${headerFor(ranges[0][0] + 1, lastShown)}\n${body}${more}`;
    return { text, tokens: estimateTokens(text), meta: { matches, groups: ranges.length, shownGroups: k } };
  }

  const header = (b: number) => `${handle} lines ${start}-${b} of ${n}`;
  const budget = maxTokens - estimateTokens(header(n)) - 14;
  const slice = lines.slice(start - 1, end).map((l) => capLine(l));
  const full = slice.join('\n');
  let body = full;
  let shown = slice.length;
  if (estimateTokens(full) > budget) {
    const cut = truncateLines(full, budget, () => '');
    const kept = cut.text.split('\n');
    kept.pop(); // marker placeholder
    shown = Math.max(1, kept.length);
    // A single line larger than the budget is the one case where cutting inside a line is unavoidable.
    body = kept.length ? kept.join('\n') : `${slice[0].slice(0, Math.max(20, tokensToChars(budget)))}…`;
  }
  const lastLine = start + shown - 1;
  const more = lastLine < end ? `\n… ${end - lastLine} more lines (startLine:${lastLine + 1})` : '';
  const text = `${header(lastLine)}\n${body}${more}`;
  return { text, tokens: estimateTokens(text), meta: { lines: shown, total: n } };
}

function touch(store: OutputStore, handle: string): void {
  try {
    const idx = store.load();
    const e = idx.outputs[handle];
    if (!e) return;
    e.used = Date.now();
    store.save(idx);
  } catch {
    /* LRU bookkeeping is best effort */
  }
}
