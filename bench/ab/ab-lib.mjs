#!/usr/bin/env node
// Online A/B helpers for kiro-cli runs (UNTESTED against a real kiro-cli: written from documented flags and
// third-party captures of undocumented stream/session fields). No dependencies: runs with plain `node`.
//
//   node ab-lib.mjs plan   --tasks <tasks.json> --arms "A B" --reps 3 --seed 42   -> TSV: idx task arm rep
//   node ab-lib.mjs prompt --tasks <tasks.json> --task <id>                     -> prompt text
//   node ab-lib.mjs parse  --tasks <tasks.json> --runs <dir> [--pass-ratio 0.6] -> CSV on stdout
//
// Run directory layout written by run-kiro-cli-ab.sh: <runs>/<task>/<arm>-<rep>/{stream.jsonl, stderr.log,
// exit_code, meta.json, stop-hook.json, sessions/**}.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------------------------------------
// Plan: every (task, arm, rep), tasks shuffled per repetition and arm order randomized per task, so that no
// arm systematically runs first (warm caches, time-of-day drift).

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(xs, rnd) {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function makePlan(taskIds, arms, reps, seed = 42) {
  const rnd = mulberry32(seed);
  const out = [];
  for (let rep = 1; rep <= reps; rep++) {
    for (const task of shuffle(taskIds, rnd)) {
      for (const arm of shuffle(arms, rnd)) out.push({ idx: out.length + 1, task, arm, rep });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Prompt: identical in every arm. The suffix asks for names so that answers can be graded mechanically.

export const PROMPT_SUFFIX =
  '\n\nAnswer in at most 12 lines. Name the exact files (repo-relative paths) and the classes/functions/methods involved.';

export function buildPrompt(task) {
  return task.question.trim() + PROMPT_SUFFIX;
}

// ---------------------------------------------------------------------------------------------------------
// Stream parsing. Schemas are undocumented; fields seen in third-party captures (kiro-cli 2.27):
//   V2: {"type":"metadata", ... "meteringUsage":[{"value":0.0387,"unit":"credit"}], "turnDurationMs":2215,
//        "contextUsagePercentage":12.3}
//   V3 (ACP-like): session/update notifications with update.sessionUpdate = agent_message_chunk | tool_call |
//        tool_call_update ...; session_info_update with _meta.kiro.promptTurnSummaries[{usage, unit, usedTools}].
// The parser walks every object generically so that small schema drifts do not silently zero the credits.

function* walk(node, parentKey) {
  if (node && typeof node === 'object') {
    yield [node, parentKey];
    if (Array.isArray(node)) for (const v of node) yield* walk(v, parentKey);
    else for (const [k, v] of Object.entries(node)) yield* walk(v, k);
  }
}

function num(x) {
  const n = typeof x === 'string' ? Number(x) : x;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

function sumCredits(list) {
  let s = 0;
  for (const m of list ?? []) {
    if (!m || typeof m !== 'object') continue;
    const unit = String(m.unit ?? m.unitPlural ?? 'credit').toLowerCase();
    const v = num(m.value ?? m.usage ?? m.amount);
    if (v !== undefined && unit.startsWith('credit')) s += v;
  }
  return s;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(textOf).join('');
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (content.content !== undefined) return textOf(content.content);
  }
  return '';
}

export function parseStream(text) {
  const res = {
    events: 0,
    badLines: 0,
    v2Credits: 0,
    v2MeteringEvents: 0,
    v3Credits: undefined,
    contextPctMax: undefined,
    turnDurationMs: undefined,
    toolCalls: 0,
    toolNames: {},
    answer: '',
    answerSource: '',
    interrupted: false,
  };
  const chunks = [];
  const fallback = [];
  const seenTools = new Set();
  let lastSummaries;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      res.badLines++;
      continue;
    }
    res.events++;
    for (const [obj] of walk(ev)) {
      if (Array.isArray(obj)) continue;
      if (Array.isArray(obj.meteringUsage)) {
        res.v2Credits += sumCredits(obj.meteringUsage);
        res.v2MeteringEvents++;
      }
      if (Array.isArray(obj.promptTurnSummaries)) lastSummaries = obj.promptTurnSummaries;
      const pct = num(obj.contextUsagePercentage ?? obj.context_usage_percentage);
      if (pct !== undefined) res.contextPctMax = Math.max(res.contextPctMax ?? 0, pct);
      const dur = num(obj.turnDurationMs);
      if (dur !== undefined) res.turnDurationMs = (res.turnDurationMs ?? 0) + dur;
      const kind = String(obj.sessionUpdate ?? obj.type ?? obj.kind ?? obj.event ?? '');
      if (/^(agent_message_chunk|assistant_message_chunk)$/i.test(kind)) {
        chunks.push(textOf(obj.content));
      } else if (/^(tool_call|toolUse|tool_use|ToolUse)$/i.test(kind)) {
        const id = obj.toolCallId ?? obj.toolUseId ?? obj.id ?? `${res.toolCalls}`;
        if (!seenTools.has(id)) {
          seenTools.add(id);
          res.toolCalls++;
          const name = String(obj.name ?? obj.toolName ?? obj.title ?? obj.kind ?? 'unknown').slice(0, 60);
          res.toolNames[name] = (res.toolNames[name] ?? 0) + 1;
        }
      } else if (/assistant|agent_message/i.test(kind) && !/tool/i.test(kind)) {
        const t = typeof obj.text === 'string' ? obj.text : typeof obj.content === 'string' ? obj.content : typeof obj.delta === 'string' ? obj.delta : '';
        if (t) fallback.push(t);
      }
      if (/interrupt/i.test(kind)) res.interrupted = true;
    }
  }
  if (lastSummaries) {
    res.v3Credits = sumCredits(lastSummaries.map((s) => ({ value: s?.usage, unit: s?.unit ?? 'credit' })));
    if (!res.toolCalls) {
      // no per-call events: fall back to the turn summaries' tool list
      for (const s of lastSummaries) {
        for (const t of s?.usedTools ?? []) {
          const name = String(t?.name ?? t);
          res.toolNames[name] = (res.toolNames[name] ?? 0) + 1;
          res.toolCalls++;
        }
      }
    }
  }
  if (chunks.length) {
    res.answer = chunks.join('');
    res.answerSource = 'stream:agent_message_chunk';
  } else if (fallback.length) {
    res.answer = fallback.join('');
    res.answerSource = 'stream:generic';
  }
  return res;
}

// ---------------------------------------------------------------------------------------------------------
// Session sidecars. V2: ~/.kiro/sessions/cli/<id>.json with user_turn_metadatas[] {metering_usage[],
// total_request_count, builtin_tool_uses, turn_duration, context_usage_percentage}. V3:
// ~/.kiro/sessions/<ws>/sess_<id>/session.json + messages.jsonl with usage_summary.promptTurnSummaries[].

export function parseSessionTexts(texts) {
  const res = { credits: undefined, requests: undefined, builtinToolUses: undefined, contextPctMax: undefined, turnDurationS: undefined, source: '' };
  let v2 = 0;
  let v2Found = false;
  let v3 = 0;
  let v3Found = false;
  for (const text of texts) {
    const docs = [];
    try {
      docs.push(JSON.parse(text));
    } catch {
      for (const line of text.split('\n')) {
        try {
          if (line.trim()) docs.push(JSON.parse(line));
        } catch {
          /* not JSON */
        }
      }
    }
    for (const doc of docs) {
      for (const [obj] of walk(doc)) {
        if (Array.isArray(obj)) continue;
        if (Array.isArray(obj.user_turn_metadatas)) {
          v2Found = true;
          for (const t of obj.user_turn_metadatas) {
            v2 += sumCredits(t?.metering_usage);
            const r = num(t?.total_request_count);
            if (r !== undefined) res.requests = (res.requests ?? 0) + r;
            const b = num(t?.builtin_tool_uses);
            if (b !== undefined) res.builtinToolUses = (res.builtinToolUses ?? 0) + b;
            const p = num(t?.context_usage_percentage);
            if (p !== undefined) res.contextPctMax = Math.max(res.contextPctMax ?? 0, p);
            const d = num(t?.turn_duration?.secs ?? t?.turn_duration);
            if (d !== undefined) res.turnDurationS = (res.turnDurationS ?? 0) + d;
          }
        }
        if (Array.isArray(obj.promptTurnSummaries)) {
          v3Found = true;
          // summaries may be repeated across records: keep the largest total seen
          v3 = Math.max(v3, sumCredits(obj.promptTurnSummaries.map((s) => ({ value: s?.usage, unit: s?.unit ?? 'credit' }))));
        }
      }
    }
  }
  if (v2Found) {
    res.credits = v2;
    res.source = 'sidecar:user_turn_metadatas';
  } else if (v3Found) {
    res.credits = v3;
    res.source = 'session:promptTurnSummaries';
  }
  return res;
}

/** Final answer captured by the Stop hook (`assistant_response`), if any. */
export function parseStopCapture(text) {
  for (const chunk of text.split('\n').filter(Boolean).reverse()) {
    try {
      const ev = JSON.parse(chunk);
      for (const [obj] of walk(ev)) {
        if (!Array.isArray(obj) && typeof obj.assistant_response === 'string') return obj.assistant_response;
      }
    } catch {
      /* ignore */
    }
  }
  try {
    const ev = JSON.parse(text);
    for (const [obj] of walk(ev)) if (!Array.isArray(obj) && typeof obj.assistant_response === 'string') return obj.assistant_response;
  } catch {
    /* ignore */
  }
  return '';
}

// ---------------------------------------------------------------------------------------------------------
// Grading: gold symbol names mentioned in the final answer (whole identifier, case-sensitive). Pre-registered
// rule: pass when at least ceil(passRatio * n) of the n gold symbols are named (default 0.6: 2/2, 2/3, 3/4).

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function gradeAnswer(answer, task, passRatio = 0.6) {
  const symbols = [...new Set(task.gold.symbols.map((s) => s.name))];
  const mentioned = symbols.filter((n) => new RegExp(`(?<![\\w$])${escapeRegex(n)}(?![\\w$])`).test(answer));
  const files = task.gold.files.filter((f) => answer.includes(f) || answer.includes(f.split('/').pop()));
  const need = Math.max(1, Math.ceil(passRatio * symbols.length));
  return {
    total: symbols.length,
    mentioned: mentioned.length,
    recall: symbols.length ? mentioned.length / symbols.length : 0,
    filesMentioned: files.length,
    pass: !!answer && mentioned.length >= need,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Run directories -> CSV rows.

function readIf(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...listFiles(p));
    else if (/\.jsonl?$/.test(name) && st.size < 200 * 1024 * 1024) out.push(p);
  }
  return out;
}

export const CSV_COLUMNS = [
  'task', 'kind', 'lang', 'arm', 'rep', 'idx', 'exit_code', 'wall_s', 'credits', 'credits_source', 'credits_stream_v2',
  'credits_stream_v3', 'credits_session', 'requests', 'tool_calls', 'builtin_tool_uses', 'kopt_calls', 'ctx_pct_max',
  'answer_chars', 'answer_source', 'gold_total', 'gold_mentioned', 'symbol_recall', 'files_mentioned', 'pass',
  'stream_events', 'stream_bad_lines', 'interrupted', 'model',
];

export function parseRunDir(dir, task, passRatio = 0.6) {
  const meta = (() => {
    try {
      return JSON.parse(readIf(join(dir, 'meta.json')) || '{}');
    } catch {
      return {};
    }
  })();
  const stream = parseStream(readIf(join(dir, 'stream.jsonl')));
  // sessions/ = copied from ~/.kiro/sessions; home/ = the isolated HOME of the run (default)
  const sessionFiles = [...listFiles(join(dir, 'sessions')), ...listFiles(join(dir, 'home', '.kiro', 'sessions'))];
  const session = parseSessionTexts(sessionFiles.map((p) => readFileSync(p, 'utf8')));
  const stop = parseStopCapture(readIf(join(dir, 'stop-hook.json')));
  const answer = stop || stream.answer;
  const answerSource = stop ? 'stop-hook' : stream.answerSource;
  // Sidecar first (per-request metering), then V3 turn summaries, then V2 stream metering.
  let credits;
  let source = '';
  if (session.credits !== undefined) [credits, source] = [session.credits, session.source];
  else if (stream.v3Credits !== undefined) [credits, source] = [stream.v3Credits, 'stream:promptTurnSummaries'];
  else if (stream.v2MeteringEvents) [credits, source] = [stream.v2Credits, 'stream:meteringUsage'];
  const g = gradeAnswer(answer, task, passRatio);
  const koptCalls = Object.entries(stream.toolNames).filter(([n]) => /kopt/i.test(n)).reduce((a, [, c]) => a + c, 0);
  const exit = readIf(join(dir, 'exit_code')).trim();
  return {
    task: task.id,
    kind: task.kind,
    lang: task.lang ?? '',
    arm: meta.arm ?? '',
    rep: meta.rep ?? '',
    idx: meta.idx ?? '',
    exit_code: exit === '' ? '' : Number(exit),
    wall_s: meta.start && meta.end ? meta.end - meta.start : '',
    credits: credits ?? '',
    credits_source: source,
    credits_stream_v2: stream.v2MeteringEvents ? round(stream.v2Credits) : '',
    credits_stream_v3: stream.v3Credits ?? '',
    credits_session: session.credits ?? '',
    requests: session.requests ?? '',
    tool_calls: stream.toolCalls || '',
    builtin_tool_uses: session.builtinToolUses ?? '',
    kopt_calls: koptCalls,
    ctx_pct_max: session.contextPctMax ?? stream.contextPctMax ?? '',
    answer_chars: answer.length,
    answer_source: answerSource,
    gold_total: g.total,
    gold_mentioned: g.mentioned,
    symbol_recall: round(g.recall),
    files_mentioned: g.filesMentioned,
    pass: g.pass ? 1 : 0,
    stream_events: stream.events,
    stream_bad_lines: stream.badLines,
    interrupted: stream.interrupted ? 1 : 0,
    model: meta.model ?? '',
  };
}

function round(x) {
  return Math.round(x * 10000) / 10000;
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows) {
  return [CSV_COLUMNS.join(','), ...rows.map((r) => CSV_COLUMNS.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n';
}

export function parseRuns(runsDir, tasks, passRatio = 0.6) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const rows = [];
  for (const taskId of readdirSync(runsDir).sort()) {
    const task = byId.get(taskId);
    const tdir = join(runsDir, taskId);
    if (!task || !statSync(tdir).isDirectory()) continue;
    for (const run of readdirSync(tdir).sort()) {
      const dir = join(tdir, run);
      if (statSync(dir).isDirectory() && existsSync(join(dir, 'meta.json'))) rows.push(parseRunDir(dir, task, passRatio));
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------------------
// CLI

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    else out._.push(a);
  }
  return out;
}

function loadTasks(path) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  return data.tasks;
}

function main(argv) {
  const a = args(argv);
  const cmd = a._[0];
  if (!a.tasks) throw new Error('--tasks <bench/tasks/<repo>.json> is required');
  const tasks = loadTasks(a.tasks);
  if (cmd === 'plan') {
    const only = a.only ? new Set(a.only.split(',')) : undefined;
    const ids = tasks.map((t) => t.id).filter((id) => !only || only.has(id));
    const plan = makePlan(ids, (a.arms ?? 'A B').split(/[ ,]+/).filter(Boolean), Number(a.reps ?? 3), Number(a.seed ?? 42));
    process.stdout.write(plan.map((p) => `${p.idx}\t${p.task}\t${p.arm}\t${p.rep}`).join('\n') + '\n');
  } else if (cmd === 'prompt') {
    const t = tasks.find((x) => x.id === a.task);
    if (!t) throw new Error(`unknown task ${a.task}`);
    process.stdout.write(buildPrompt(t));
  } else if (cmd === 'parse') {
    if (!a.runs) throw new Error('--runs <dir> is required');
    process.stdout.write(toCsv(parseRuns(a.runs, tasks, Number(a['pass-ratio'] ?? 0.6))));
  } else {
    throw new Error('usage: ab-lib.mjs plan|prompt|parse --tasks <file> ...');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`ab-lib: ${err.message}\n`);
    process.exitCode = 1;
  }
}
