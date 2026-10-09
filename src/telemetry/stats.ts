// Human-readable usage report over the local telemetry log.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KoptConfig } from '../core/config.js';
import type { TelemetryEvent } from '../core/types.js';
import { collectKiroCredits } from './credits.js';
import { dayFiles, record, telemetryDir } from './record.js';

function fmtTok(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 10_000) return Math.round(n / 1000) + 'k';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(Math.round(n));
}

function table(headers: string[], rows: (string | number)[][]): string[] {
  const cells = [headers, ...rows.map((r) => r.map(String))];
  const widths = headers.map((_, i) => Math.max(...cells.map((r) => (r[i] ?? '').length)));
  return cells.map((r) => r.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ').trimEnd());
}

/** Events of the last `days` UTC days (today included). */
export function loadEvents(config: KoptConfig, days: number): TelemetryEvent[] {
  const since = Date.now() - days * 86400_000;
  const firstDay = new Date(since).toISOString().slice(0, 10);
  const out: TelemetryEvent[] = [];
  for (const name of dayFiles(config)) {
    if (name.slice(0, 10) < firstDay) continue;
    let text: string;
    try { text = readFileSync(join(telemetryDir(config), name), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as TelemetryEvent;
        if (e && typeof e.ts === 'number' && e.ts >= since) out.push(e);
      } catch { /* torn line */ }
    }
  }
  return out;
}

/**
 * Report: kopt tool calls + tokens (savings only where an exact baseline exists), governor blocks,
 * context intake per tool observed through PostToolUse hooks, credits per day.
 * Collects new Kiro credit records first so the credit section is current.
 */
export function stats(config: KoptConfig, opts: { days?: number } = {}): string {
  const days = Math.max(1, Math.floor(opts.days ?? 7));
  try {
    for (const e of collectKiroCredits(config)) record(e, config);
  } catch { /* report what we have */ }
  const events = loadEvents(config, days);
  const lines: string[] = [];
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - (days - 1) * 86400_000).toISOString().slice(0, 10);
  lines.push(`kopt stats · ${from}..${to} (${days}d) · ${events.length} events`);
  if (!events.length) {
    lines.push('no telemetry yet: use Kiro with kopt installed (kopt setup), then re-run.');
    return lines.join('\n');
  }

  const repos = new Map<string, number>();
  for (const e of events) if (e.repo) repos.set(e.repo, (repos.get(e.repo) ?? 0) + 1);
  if (repos.size > 1) {
    lines.push('repos: ' + [...repos.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`).join(', '));
  }

  // kopt tools (events emitted by the MCP server)
  const tools = new Map<string, { calls: number; out: number; outB: number; base: number }>();
  for (const e of events) {
    if (e.kind !== 'tool' || !e.tool) continue;
    const t = tools.get(e.tool) ?? { calls: 0, out: 0, outB: 0, base: 0 };
    t.calls++;
    t.out += e.tokensOut ?? 0;
    if (typeof e.baselineTokens === 'number' && e.baselineTokens > 0) {
      t.base += e.baselineTokens;
      t.outB += e.tokensOut ?? 0;
    }
    tools.set(e.tool, t);
  }
  lines.push('');
  if (tools.size) {
    lines.push('kopt tools (tokens returned to the model; savings only where the raw alternative is exactly known)');
    const rows: (string | number)[][] = [];
    let calls = 0, out = 0, outB = 0, base = 0;
    for (const [name, t] of [...tools.entries()].sort((a, b) => b[1].out - a[1].out)) {
      rows.push([name, t.calls, fmtTok(t.out), fmtTok(t.out / t.calls), t.base ? fmtTok(t.base) : '-', t.base ? Math.round((1 - t.outB / t.base) * 100) + '%' : '-']);
      calls += t.calls; out += t.out; outB += t.outB; base += t.base;
    }
    rows.push(['total', calls, fmtTok(out), fmtTok(out / Math.max(1, calls)), base ? fmtTok(base) : '-', base ? Math.round((1 - outB / base) * 100) + '%' : '-']);
    lines.push(...table(['tool', 'calls', 'tok out', 'avg', 'baseline', 'saved'], rows));
  } else {
    lines.push('kopt tools: no calls recorded');
  }

  // governor
  const blocks = new Map<string, number>();
  for (const e of events) {
    if (e.kind === 'hook' && e.decision === 'block') {
      const r = String(e.meta?.reason ?? 'other');
      blocks.set(r, (blocks.get(r) ?? 0) + 1);
    }
  }
  lines.push('');
  lines.push(blocks.size
    ? 'governor blocks: ' + [...blocks.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`).join(' · ')
    : 'governor blocks: none');

  // sessions (Stop events carry the running tool-call count)
  const perSession = new Map<string, number>();
  for (const e of events) {
    if (e.kind === 'session' && e.session && typeof e.meta?.toolCalls === 'number') {
      perSession.set(e.session, Math.max(perSession.get(e.session) ?? 0, e.meta.toolCalls as number));
    }
  }
  if (perSession.size) {
    const v = [...perSession.values()];
    lines.push(`sessions: ${v.length} · tool calls/session avg ${Math.round(v.reduce((a, b) => a + b, 0) / v.length)}, max ${Math.max(...v)}`);
  }

  // context intake per tool, as observed by PostToolUse (built-in and MCP tools alike)
  const intake = new Map<string, { calls: number; tok: number }>();
  let intakeTotal = 0;
  for (const e of events) {
    if (e.kind !== 'hook' || e.decision === 'block' || !e.tool || typeof e.tokensOut !== 'number') continue;
    const t = intake.get(e.tool) ?? { calls: 0, tok: 0 };
    t.calls++;
    t.tok += e.tokensOut;
    intakeTotal += e.tokensOut;
    intake.set(e.tool, t);
  }
  if (intake.size) {
    lines.push('');
    lines.push('context intake by tool (PostToolUse; each token is re-billed on every later turn)');
    const sorted = [...intake.entries()].sort((a, b) => b[1].tok - a[1].tok);
    const rows = sorted.slice(0, 15).map(([name, t]) => [name, t.calls, fmtTok(t.tok), fmtTok(t.tok / t.calls), Math.round((t.tok / Math.max(1, intakeTotal)) * 100) + '%']);
    if (sorted.length > 15) {
      const rest = sorted.slice(15).reduce((a, [, t]) => ({ calls: a.calls + t.calls, tok: a.tok + t.tok }), { calls: 0, tok: 0 });
      rows.push([`(${sorted.length - 15} more)`, rest.calls, fmtTok(rest.tok), fmtTok(rest.tok / Math.max(1, rest.calls)), Math.round((rest.tok / Math.max(1, intakeTotal)) * 100) + '%']);
    }
    lines.push(...table(['tool', 'calls', 'tok in', 'avg', 'share'], rows));
  }

  // credits
  const credits = new Map<string, { credits: number; turns: number }>();
  for (const e of events) {
    if (e.kind !== 'credits' || typeof e.credits !== 'number') continue;
    const day = new Date(e.ts).toISOString().slice(0, 10);
    const c = credits.get(day) ?? { credits: 0, turns: 0 };
    c.credits += e.credits;
    c.turns++;
    credits.set(day, c);
  }
  lines.push('');
  if (credits.size) {
    lines.push('credits (collected from Kiro session files)');
    const rows = [...credits.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([d, c]) => [d, c.credits.toFixed(2), c.turns, (c.credits / c.turns).toFixed(3)]);
    const tot = [...credits.values()].reduce((a, c) => ({ credits: a.credits + c.credits, turns: a.turns + c.turns }), { credits: 0, turns: 0 });
    rows.push(['total', tot.credits.toFixed(2), tot.turns, (tot.credits / Math.max(1, tot.turns)).toFixed(3)]);
    lines.push(...table(['day', 'credits', 'turns', 'per turn'], rows));
  } else {
    lines.push('credits: none found (Kiro CLI ~/.kiro/sessions/cli/*.json or IDE 1.x ~/.kiro/sessions/*/*/messages.jsonl)');
  }
  return lines.join('\n');
}
