// Collect per-turn Kiro credit usage from local session files (read-only, schema undocumented).
//
// Sources, parsed defensively:
//  1. Kiro CLI 2.x sidecars ~/.kiro/sessions/cli/<uuid>.json: `user_turn_metadatas[]` with
//     `metering_usage: [{value, unit: "credit"}]` (one entry per model request), `total_request_count`,
//     `builtin_tool_uses`, `turn_duration`, `context_usage_percentage`, `model_id`, `end_reason`.
//     Field names come from third-party parsers (kusage, codeburn) and the kiro-cli-chat 2.28 binary.
//  2. Unified harness (IDE 1.x / CLI V3): ~/.kiro/sessions/<workspaceHash>/<sessionId>/messages.jsonl,
//     lines `{id, timestamp, payload: {type: "usage_summary", promptTurnSummaries: [{usage, unit, usedTools}],
//     elapsedTime, status}}` (verified in Kiro IDE 0.12.318 extension.js SessionPersistence).
//  IDE 0.x (globalStorage/kiro.kiroagent/sessions/*.json) stores only contextUsagePercentage, no credits.
// Dedup: cursor <userDir>/telemetry/credits-cursor.json (turn count per CLI file, byte offset per jsonl).

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { KoptConfig } from '../core/config.js';
import type { TelemetryEvent } from '../core/types.js';
import { atomicWrite, readJson, withFileLock } from './fsutil.js';

interface Cursor {
  v: 1;
  /** CLI sidecar path -> { turns collected, mtimeMs, size } */
  cli: Record<string, { turns: number; mtimeMs: number; size: number }>;
  /** messages.jsonl path -> byte offset collected */
  jsonl: Record<string, number>;
  /** messages.jsonl path -> ids of usage_summary messages already collected (survives file rewrites) */
  ids: Record<string, string[]>;
}

/** Turns of a sidecar still being written are left for the next collection. */
const SETTLE_MS = 15_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;

export function kiroHome(): string {
  return process.env.KOPT_KIRO_HOME || join(homedir(), '.kiro');
}

function cursorPath(config: KoptConfig): string {
  return join(config.userDir, 'telemetry', 'credits-cursor.json');
}

const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x);
const num = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : typeof x === 'string' && x.trim() && Number.isFinite(Number(x)) ? Number(x) : undefined);

/** Sum `value`/`usage` of entries whose unit is credit(s) or missing. */
function sumCredits(entries: unknown): number {
  if (!Array.isArray(entries)) return num(entries) ?? 0;
  let total = 0;
  for (const e of entries) {
    if (!isObj(e)) { total += num(e) ?? 0; continue; }
    const unit = String(e.unit ?? e.unit_plural ?? 'credit').toLowerCase();
    if (!unit.startsWith('credit')) continue;
    total += num(e.value) ?? num(e.usage) ?? num(e.amount) ?? 0;
  }
  return total;
}

/** Rust Duration ({secs, nanos}), milliseconds, or seconds-as-float. */
function durationMs(d: unknown): number | undefined {
  if (isObj(d)) {
    const s = num(d.secs) ?? num(d.seconds);
    if (s !== undefined) return Math.round(s * 1000 + (num(d.nanos) ?? 0) / 1e6);
    return undefined;
  }
  const n = num(d);
  if (n === undefined) return undefined;
  return n < 10_000 && !Number.isInteger(n) ? Math.round(n * 1000) : Math.round(n);
}

function timeOf(x: Record<string, any>): number | undefined {
  for (const k of ['timestamp', 'end_timestamp', 'start_timestamp', 'request_start_timestamp_ms', 'created_at', 'time']) {
    const v = x[k];
    const n = num(v);
    if (n !== undefined) return n > 1e12 ? n : n > 1e9 ? n * 1000 : undefined;
    if (typeof v === 'string') {
      const t = Date.parse(v);
      if (Number.isFinite(t)) return t;
    }
  }
  return undefined;
}

/** Depth-limited search for the first array under `key`. */
function findArray(x: unknown, key: string, depth = 0): unknown[] | undefined {
  if (depth > 6 || !x || typeof x !== 'object') return undefined;
  if (isObj(x) && Array.isArray(x[key])) return x[key];
  for (const v of Object.values(x as object)) {
    const r = findArray(v, key, depth + 1);
    if (r) return r;
  }
  return undefined;
}

function findString(x: unknown, keys: string[], depth = 0): string | undefined {
  if (depth > 3 || !isObj(x)) return undefined;
  for (const k of keys) if (typeof x[k] === 'string' && x[k]) return x[k];
  for (const v of Object.values(x)) {
    if (isObj(v)) {
      const r = findString(v, keys, depth + 1);
      if (r) return r;
    }
  }
  return undefined;
}

function collectCli(dir: string, cursor: Cursor, now: number): TelemetryEvent[] {
  const out: TelemetryEvent[] = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    let st;
    try { st = statSync(path); } catch { continue; }
    if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
    const prev = cursor.cli[path];
    if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) continue;
    let doc: unknown;
    try { doc = JSON.parse(readFileSync(path, 'utf8')); } catch { continue; }
    const turns = findArray(doc, 'user_turn_metadatas');
    if (!turns) {
      cursor.cli[path] = { turns: prev?.turns ?? 0, mtimeMs: st.mtimeMs, size: st.size };
      continue;
    }
    const settled = now - st.mtimeMs < SETTLE_MS ? Math.max(0, turns.length - 1) : turns.length;
    const from = Math.min(prev?.turns ?? 0, settled);
    const session = findString(doc, ['session_id', 'conversation_id', 'id']) ?? name.replace(/\.json$/, '');
    const cwd = findString(doc, ['cwd', 'workspace', 'working_directory']);
    for (let i = from; i < settled; i++) {
      const t = turns[i];
      if (!isObj(t)) continue;
      const credits = sumCredits(t.metering_usage ?? t.meteringUsage);
      const meta: Record<string, unknown> = { source: 'kiro-cli', turn: i };
      const model = t.model_id ?? t.modelId ?? t.model;
      if (typeof model === 'string') meta.model = model;
      const req = num(t.total_request_count) ?? (Array.isArray(t.metering_usage) ? t.metering_usage.length : undefined);
      if (req !== undefined) meta.requests = req;
      const tools = num(t.builtin_tool_uses) ?? (Array.isArray(t.builtin_tool_uses) ? t.builtin_tool_uses.length : undefined);
      if (tools !== undefined) meta.toolUses = tools;
      const ctx = num(t.context_usage_percentage);
      if (ctx !== undefined) meta.contextPct = Math.round(ctx * 10) / 10;
      if (typeof t.end_reason === 'string') meta.endReason = t.end_reason;
      const rate = num(t.rate_multiplier);
      if (rate !== undefined) meta.rateMultiplier = rate;
      const ev: TelemetryEvent = { ts: timeOf(t) ?? Math.round(st.mtimeMs), kind: 'credits', credits: Math.round(credits * 1e4) / 1e4, session, meta };
      const dur = durationMs(t.turn_duration);
      if (dur !== undefined) ev.durationMs = dur;
      if (cwd) ev.repo = basename(cwd);
      out.push(ev);
    }
    cursor.cli[path] = { turns: Math.max(prev?.turns ?? 0, settled), mtimeMs: st.mtimeMs, size: st.size };
  }
  return out;
}

function readTail(path: string, offset: number, size: number): string {
  const len = Math.min(size - offset, MAX_FILE_BYTES);
  const buf = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  try {
    let read = 0;
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, offset + read);
      if (n <= 0) break;
      read += n;
    }
    return buf.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function collectUnified(root: string, cursor: Cursor): TelemetryEvent[] {
  const out: TelemetryEvent[] = [];
  if (!existsSync(root)) return out;
  for (const ws of readdirSync(root)) {
    if (ws === 'cli') continue;
    const wsDir = join(root, ws);
    let sessions: string[];
    try {
      if (!statSync(wsDir).isDirectory()) continue;
      sessions = readdirSync(wsDir);
    } catch { continue; }
    for (const sid of sessions) {
      const file = join(wsDir, sid, 'messages.jsonl');
      let st;
      try { st = statSync(file); } catch { continue; }
      let offset = cursor.jsonl[file] ?? 0;
      if (st.size < offset) offset = 0; // rewritten (saveSession rewrites the whole file): re-scan
      if (st.size === offset) continue;
      let text: string;
      try { text = readTail(file, offset, st.size); } catch { continue; }
      const lastNl = text.lastIndexOf('\n');
      if (lastNl < 0) continue;
      const complete = text.slice(0, lastNl + 1);
      let repo: string | undefined;
      let repoLoaded = false;
      const seen = new Set(cursor.ids[file] ?? []);
      for (const line of complete.split('\n')) {
        if (!line.includes('usage_summary')) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        const p = isObj(msg?.payload) ? msg.payload : msg;
        if (!isObj(p) || p.type !== 'usage_summary') continue;
        const id = typeof msg?.id === 'string' ? msg.id : undefined;
        if (id) {
          if (seen.has(id)) continue;
          seen.add(id);
        }
        const summaries = Array.isArray(p.promptTurnSummaries) ? p.promptTurnSummaries : [];
        const credits = sumCredits(summaries);
        const used = new Set<string>();
        for (const s of summaries) if (isObj(s) && Array.isArray(s.usedTools)) for (const t of s.usedTools) used.add(String(t));
        if (!repoLoaded) {
          repoLoaded = true;
          try {
            const meta = JSON.parse(readFileSync(join(wsDir, sid, 'session.json'), 'utf8'));
            const wp = Array.isArray(meta?.workspacePaths) ? meta.workspacePaths[0] : undefined;
            if (typeof wp === 'string') repo = basename(wp);
          } catch { /* optional */ }
        }
        const ev: TelemetryEvent = {
          ts: timeOf(msg) ?? Math.round(st.mtimeMs),
          kind: 'credits',
          credits: Math.round(credits * 1e4) / 1e4,
          session: sid,
          meta: { source: 'kiro-unified', requests: summaries.length, tools: [...used].slice(0, 30), status: p.status },
        };
        const dur = num(p.elapsedTime);
        if (dur !== undefined) ev.durationMs = Math.round(dur);
        if (repo) ev.repo = repo;
        out.push(ev);
      }
      cursor.jsonl[file] = offset + Buffer.byteLength(complete, 'utf8');
      if (seen.size) cursor.ids[file] = [...seen].slice(-2000);
    }
  }
  return out;
}

/**
 * Credit events not collected before (advances the cursor: the caller must record them;
 * see `collectAndRecord` in telemetry/index.ts). Never throws.
 */
export function collectKiroCredits(config: KoptConfig): TelemetryEvent[] {
  try {
    const path = cursorPath(config);
    const events = withFileLock(path + '.lock', () => {
      const raw = readJson<Partial<Cursor>>(path, {});
      const cursor: Cursor = {
        v: 1,
        cli: isObj(raw.cli) ? (raw.cli as Cursor['cli']) : {},
        jsonl: isObj(raw.jsonl) ? (raw.jsonl as Cursor['jsonl']) : {},
        ids: isObj(raw.ids) ? (raw.ids as Cursor['ids']) : {},
      };
      const now = Date.now();
      const home = kiroHome();
      const found = [
        ...collectCli(join(home, 'sessions', 'cli'), cursor, now),
        ...collectUnified(join(home, 'sessions'), cursor),
      ];
      atomicWrite(path, JSON.stringify(cursor));
      return found;
    }, { timeoutMs: 2000, staleMs: 30_000, runUnlocked: false });
    return (events ?? []).sort((a, b) => a.ts - b.ts);
  } catch {
    return [];
  }
}
