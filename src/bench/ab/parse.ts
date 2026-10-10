// Parsers for what one kiro-cli run leaves behind: the `--output-format stream-json` stdout, the session files
// (V2 sidecar `<KIRO_HOME>/sessions/cli/<uuid>.json`, V3 `~/.kiro/sessions/<bucket>/sess_<id>/messages.jsonl`) and
// kopt's own telemetry. The stream envelope of kiro-cli 2.28 is not documented: every parser walks every JSON object
// and keys on the ACP / Kiro field names (sessionUpdate, _meta.kiro.kind, promptTurnSummaries, meteringUsage,
// user_turn_metadatas, finalText), so a different envelope does not zero the measurements. Field provenance:
// bench/ab/README.md ("What was verified").

import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';
import type { ErrorKind } from './types.js';

type Obj = Record<string, unknown>;

/**
 * Every object of a JSON value, depth first. Tool inputs and outputs are not entered: they carry the user's data
 * (a file the agent read could hold anything, field names included), never Kiro's own records.
 */
function* walk(node: unknown): Generator<Obj> {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const v of node) yield* walk(v);
    return;
  }
  const o = node as Obj;
  yield o;
  // V3 session records of tool calls and results: their payload is the user's data
  if (o.type === 'tool_result' || o.type === 'tool_call') return;
  const toolEvent = o.sessionUpdate === 'tool_call' || o.sessionUpdate === 'tool_call_update';
  for (const [k, v] of Object.entries(o)) {
    if (!v || typeof v !== 'object') continue;
    if (k === 'rawInput' || k === 'rawOutput' || k === 'tool_input' || k === 'tool_response' || (toolEvent && k === 'content')) continue;
    yield* walk(v);
  }
}

function num(x: unknown): number | undefined {
  const n = typeof x === 'string' && x.trim() !== '' ? Number(x) : x;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

function str(x: unknown): string | undefined {
  return typeof x === 'string' ? x : undefined;
}

function obj(x: unknown): Obj | undefined {
  return x && typeof x === 'object' && !Array.isArray(x) ? (x as Obj) : undefined;
}

/** Kiro's own credit filter: (unitPlural || unit) is "credit" or "credits". A missing unit counts as credits. */
export function isCreditUnit(m: Obj): boolean {
  const u = String(m.unitPlural ?? m.unit_plural ?? m.unit ?? 'credits').trim().toLowerCase();
  return u === 'credit' || u === 'credits';
}

/** Sum of the credit entries of a metering list ({value|usage, unit, unitPlural}). */
export function sumCredits(list: unknown): number | undefined {
  if (!Array.isArray(list)) return undefined;
  let s = 0;
  let any = false;
  for (const e of list) {
    const m = obj(e);
    if (!m || !isCreditUnit(m)) continue;
    const v = num(m.value ?? m.usage ?? m.amount);
    if (v === undefined) continue;
    s += v;
    any = true;
  }
  return any ? s : undefined;
}

const KOPT_TOOLS = '(?:find|read|outline|refs|expand|run)';
/** A tool NAME of the kopt server: `@kopt/kopt_find` (V2), `mcp_kopt_kopt_find` (V3) or the bare MCP tool name. */
const KOPT_NAME_RE = new RegExp(`^(?:@kopt/|mcp_kopt_)?kopt_${KOPT_TOOLS}$`);
/**
 * A tool call TITLE naming a kopt tool: only the qualified forms, at the start of the title. Free-text titles of other
 * tools ("Searching for kopt_find in src") must never count: they would turn a grep of the kopt repository into a
 * kopt call (and a control-arm run into a kopt leak).
 */
const KOPT_TITLE_RE = new RegExp(`^(?:@kopt/|mcp_kopt_)kopt_${KOPT_TOOLS}(?![\\w-])`);

export function isKoptToolName(name: string): boolean {
  return KOPT_NAME_RE.test(name.trim());
}

export function isKoptTitle(title: string): boolean {
  return KOPT_TITLE_RE.test(title.trim());
}

/** A stream tool call that names a kopt tool (by its name, or by a qualified title). */
export function isKoptCall(t: { name: string; title?: string }): boolean {
  return isKoptToolName(t.name) || (t.title !== undefined && isKoptTitle(t.title));
}

// ---------------------------------------------------------------------------------------------------------
// stream-json

export interface ToolCallInfo {
  id: string;
  name: string;
  title?: string;
  kind?: string;
  /** ACP status of the last update: pending, in_progress, completed, failed. */
  status?: string;
  /** failureReason / failure_reason / toolCallFailureReason, wherever Kiro puts it. */
  failureReason?: string;
  /** Error text of a failed call (Kiro's own message, never the tool's output of a successful call). */
  error?: string;
  /** kiro-cli asked for a permission for this call: in a non-interactive run that means it was not trusted. */
  permissionRequested?: boolean;
}

/** Kiro's wording of a refused tool call (not an OS error such as "Permission denied (os error 13)"). */
const DENIAL_TEXT = /\[denied\]|tool (?:use|call|permission)[^.\n]{0,60}(?:denied|rejected|refused)|(?:denied|rejected) by (?:the )?(?:user|policy|permission)|approval[^.\n]{0,40}not (?:supported|available)|not trusted/i;

/** The call was refused by Kiro's permission system (as opposed to failing while it ran). */
export function isDenied(t: ToolCallInfo): boolean {
  if (t.status === 'completed') return false;
  if (t.failureReason && /denied|rejected|refused|permission/i.test(t.failureReason)) return true;
  if (t.permissionRequested) return true;
  return t.status === 'failed' && !!t.error && DENIAL_TEXT.test(t.error);
}

/** Lines kiro-cli prints on stderr for every tool call it refused in a non-interactive run (2.28 launcher). */
export function stderrDenials(stderr: string): number {
  return stderr.split(/\r?\n/).filter((l) => /^\s*\[denied\]/i.test(l)).length;
}

export interface StreamSummary {
  lines: number;
  badLines: number;
  events: number;
  sessionId?: string;
  finalText?: string;
  finalTextTruncated?: boolean;
  /** agent_message_chunk text of the last turn (replayed chunks skipped). */
  lastTurnText: string;
  allChunksText: string;
  /** V3: sum over every turn_completion of its credit units (undefined when no summary was seen). */
  creditsTurnCompletion?: number;
  turnCompletions: number;
  /** V2: sum of `_kiro.dev/metadata` meteringUsage credit entries (undefined when none). */
  creditsMetering?: number;
  meteringEvents: number;
  requestIds: string[];
  toolCalls: ToolCallInfo[];
  usedTools: Record<string, number>;
  ctxPctMax?: number;
  turnStarts: number;
  stopReasons: string[];
  runFinished: boolean;
  runErrors: string[];
  displayErrors: string[];
  rateLimited: boolean;
  refusal: boolean;
  interrupted: boolean;
  deniedTools: number;
}

function toolName(u: Obj): string {
  const meta = obj(u._meta);
  const kiro = obj(meta?.kiro);
  const ident = obj(kiro?.mcpTool) ? obj(obj(kiro?.mcpTool)?.identity) : undefined;
  if (ident && str(ident.serverName) && str(ident.toolName)) return `@${ident.serverName}/${ident.toolName}`;
  const mcpServer = str(meta?.mcpServerName) ?? str(kiro?.mcpServerName);
  const mcpIdent = obj(meta?.mcpToolIdentity) ?? obj(kiro?.mcpToolIdentity);
  if (mcpServer && mcpIdent && str(mcpIdent.toolName)) return `@${mcpServer}/${mcpIdent.toolName}`;
  const explicit = str(kiro?.toolName) ?? str(meta?.toolName) ?? str(u.toolName) ?? str(u.name);
  if (explicit) return explicit;
  const title = str(u.title);
  if (title && /^@[\w.-]+\/[\w.-]+$/.test(title.trim())) return title.trim();
  if (title && /^[a-z][a-z0-9_]*$/.test(title.trim())) return title.trim();
  return str(u.kind) ? `kind:${u.kind}` : 'unknown';
}

/** Failure stages of the 2.28 launcher's runError record (strings of crates/chat-cli/src/launch/json_streaming.rs). */
const RUN_ERROR_STAGES = /^(load_session_unsupported|current_dir|new_session|resume_convert|resume_no_session|resume_lookup|load_session|initialize|prompt|error)$/i;

export function parseStream(text: string): StreamSummary {
  const s: StreamSummary = {
    lines: 0,
    badLines: 0,
    events: 0,
    lastTurnText: '',
    allChunksText: '',
    turnCompletions: 0,
    meteringEvents: 0,
    requestIds: [],
    toolCalls: [],
    usedTools: {},
    turnStarts: 0,
    stopReasons: [],
    runFinished: false,
    runErrors: [],
    displayErrors: [],
    rateLimited: false,
    refusal: false,
    interrupted: false,
    deniedTools: 0,
  };
  const tools = new Map<string, ToolCallInfo>();
  const completions = new Set<string>();
  const metering = new Set<string>();
  const requestIds = new Set<string>();
  let turnChunks: string[] = [];
  const allChunks: string[] = [];
  let creditsTc = 0;
  let creditsMeter = 0;
  /** runError payloads already recorded through their record (the 2.28 stream wraps them in `data`). */
  const errorPayloads = new Set<Obj>();

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    s.lines++;
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      s.badLines++;
      continue;
    }
    if (!ev || typeof ev !== 'object') {
      s.badLines++;
      continue;
    }
    s.events++;
    for (const o of walk(ev)) {
      if (!s.sessionId && typeof o.sessionId === 'string' && o.sessionId) s.sessionId = o.sessionId;
      const discr = String(o.type ?? o.event ?? o.kind ?? o.record ?? '');
      const method = str(o.method) ?? '';

      // final answer (runFinished.finalText)
      if (typeof o.finalText === 'string') {
        s.finalText = o.finalText;
        s.runFinished = true;
        if (o.finalTextTruncated === true) s.finalTextTruncated = true;
      } else if (/^runFinished$/i.test(discr)) s.runFinished = true;

      // run errors: an explicit runError record (its fields flat or in `data`, as the real 2.28 stream has them), or a
      // record with one of the launcher's failure stages; one entry per error
      if (/^runError$/i.test(discr)) {
        const data = obj(o.data);
        const d = data && (str(data.message) ?? str(data.error)) ? data : o;
        errorPayloads.add(d);
        s.runErrors.push(`${str(d.stage) ? `[${d.stage}] ` : ''}${str(d.message) ?? str(d.error) ?? JSON.stringify(o).slice(0, 300)}`);
      } else if (!errorPayloads.has(o) && typeof o.stage === 'string' && RUN_ERROR_STAGES.test(o.stage) && (typeof o.message === 'string' || typeof o.error === 'string')) {
        s.runErrors.push(`[${o.stage}] ${str(o.message) ?? str(o.error)}`);
      }
      if (/rate_limit/i.test(method)) {
        s.rateLimited = true;
        s.displayErrors.push(`${method}: ${JSON.stringify(o.params ?? {}).slice(0, 300)}`);
      }

      // ACP session updates (also accepted when an envelope flattens the discriminator into `type`)
      const su = str(o.sessionUpdate) ?? (/^(tool_call|tool_call_update|agent_message_chunk)$/.test(discr) ? discr : undefined);
      if (su === 'agent_message_chunk') {
        const kiro = obj(obj(o._meta)?.kiro);
        if (kiro?.replay === true) continue;
        if (kiro?.refusal) s.refusal = true;
        const c = obj(o.content);
        const t = typeof o.content === 'string' ? o.content : (str(c?.text) ?? '');
        if (t) {
          turnChunks.push(t);
          allChunks.push(t);
        }
      } else if (su === 'tool_call' || su === 'tool_call_update') {
        const id = str(o.toolCallId) ?? str(o.id);
        if (!id) continue;
        const kiro = obj(obj(o._meta)?.kiro);
        const name = toolName(o);
        const info: ToolCallInfo = tools.get(id) ?? { id, name };
        // a later update may name a tool the first event only categorized
        if ((info.name === 'unknown' || info.name.startsWith('kind:')) && name !== 'unknown' && !name.startsWith('kind:')) info.name = name;
        if (str(o.title)) info.title = str(o.title);
        if (str(o.kind)) info.kind = str(o.kind);
        if (str(o.status)) info.status = str(o.status);
        const meta = obj(o._meta);
        const fr = [kiro, meta, o].map((x) => str(x?.failureReason) ?? str(x?.failure_reason) ?? str(x?.toolCallFailureReason)).find(Boolean);
        if (fr) info.failureReason = fr;
        if (info.status === 'failed') {
          const e = str(kiro?.error) ?? str(meta?.error) ?? str(o.error) ?? (Array.isArray(o.content) ? textOf(o.content) : undefined);
          if (e) info.error = e.slice(0, 500);
        }
        tools.set(id, info);
      }
      // a permission request for a tool call (ACP session/request_permission): in a --no-interactive run the call
      // is refused
      if (/request_permission/i.test(method)) {
        const tc = obj(obj(o.params)?.toolCall);
        const id = str(tc?.toolCallId);
        if (id) {
          const info: ToolCallInfo = tools.get(id) ?? { id, name: tc ? toolName(tc) : 'unknown' };
          info.permissionRequested = true;
          tools.set(id, info);
        }
      }

      // Kiro session_info_update payloads (_meta.kiro.kind)
      const kind = str(o.kind);
      if (kind === 'turn_start') {
        s.turnStarts++;
        turnChunks = [];
      } else if (kind === 'turn_end') {
        const te = obj(o.turnEnd);
        const reason = str(te?.stopReason);
        if (reason) s.stopReasons.push(reason);
        if (reason === 'cancelled') s.interrupted = true;
      } else if (kind === 'display_error') {
        const de = obj(o.displayError);
        s.displayErrors.push(`${str(de?.errorType) ?? 'error'}: ${str(de?.message) ?? JSON.stringify(o).slice(0, 300)}`);
      } else if (kind === 'context_usage') {
        const p = num(o.usagePercentage) ?? num(obj(o.contextUsage)?.usagePercentage);
        if (p !== undefined) s.ctxPctMax = Math.max(s.ctxPctMax ?? 0, p);
      }
      if (/interrupt/i.test(discr) || /interrupt/i.test(kind ?? '')) s.interrupted = true;

      // V3 per-turn metering: turn_completion (one per prompt turn, NOT cumulative: sum them)
      if (Array.isArray(o.promptTurnSummaries)) {
        const key = JSON.stringify([o.requestIds ?? null, o.elapsedTime ?? null, o.executionId ?? null, o.promptTurnSummaries]);
        if (!completions.has(key)) {
          completions.add(key);
          s.turnCompletions++;
          const summaries = o.promptTurnSummaries as unknown[];
          const credits = sumCredits(summaries.map((x) => ({ ...(obj(x) ?? {}), value: obj(x)?.usage ?? obj(x)?.value })));
          if (credits !== undefined) creditsTc += credits;
          for (const x of summaries) {
            for (const t of (obj(x)?.usedTools as unknown[]) ?? []) {
              const n = typeof t === 'string' ? t : str(obj(t)?.name);
              if (n) s.usedTools[n] = (s.usedTools[n] ?? 0) + 1;
            }
          }
          if (Array.isArray(o.requestIds)) for (const r of o.requestIds) if (typeof r === 'string') requestIds.add(r);
          if (s.creditsTurnCompletion === undefined && credits !== undefined) s.creditsTurnCompletion = 0;
        }
      }
      const ctx = num(o.contextUsagePercentage);
      if (ctx !== undefined) s.ctxPctMax = Math.max(s.ctxPctMax ?? 0, ctx);

      // V2 per-turn metering: _kiro.dev/metadata params.meteringUsage
      if (Array.isArray(o.meteringUsage)) {
        const key = str(o.requestId) ? `r:${o.requestId}` : `n:${metering.size}:${JSON.stringify(o.meteringUsage)}:${o.turnDurationMs ?? ''}`;
        if (!metering.has(key)) {
          metering.add(key);
          const c = sumCredits(o.meteringUsage);
          if (c !== undefined) {
            creditsMeter += c;
            s.meteringEvents++;
          }
          if (str(o.requestId)) requestIds.add(String(o.requestId));
        }
      }
    }
  }
  if (s.turnCompletions && s.creditsTurnCompletion !== undefined) s.creditsTurnCompletion = round(creditsTc);
  if (s.meteringEvents) s.creditsMetering = round(creditsMeter);
  s.toolCalls = [...tools.values()];
  s.deniedTools = s.toolCalls.filter(isDenied).length;
  s.requestIds = [...requestIds];
  s.lastTurnText = turnChunks.join('');
  s.allChunksText = allChunks.join('');
  return s;
}

/**
 * Credits of a run as its stream arrives, line by line, with the same rules and de-duplication as parseStream (V2
 * `meteringUsage` once per request, every V3 `turn_completion`). Used to kill a run whose metered credits reach the
 * budget. `maxStep` is the largest single increment seen (the cost of one request, a guess of the next one).
 */
export class LiveMeter {
  credits = 0;
  maxStep = 0;
  events = 0;
  /** The last increment was a per-request metering event (V2): more requests may follow in the same run. */
  lastFromRequest = false;
  private seen = new Set<string>();
  private buf = '';

  /** Feed a chunk of stdout; returns the credits added by the complete lines in it. */
  feed(chunk: string): number {
    this.buf += chunk;
    let added = 0;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      added += this.line(line);
    }
    return added;
  }

  line(line: string): number {
    if (!line.trim()) return 0;
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      return 0;
    }
    let added = 0;
    for (const o of walk(ev)) {
      if (Array.isArray(o.meteringUsage)) {
        const key = str(o.requestId) ? `r:${o.requestId}` : `n:${this.seen.size}:${JSON.stringify(o.meteringUsage)}:${o.turnDurationMs ?? ''}`;
        if (this.seen.has(key)) continue;
        this.seen.add(key);
        const c = sumCredits(o.meteringUsage);
        if (c !== undefined && c > 0) {
          added += c;
          this.maxStep = Math.max(this.maxStep, c);
          this.lastFromRequest = true;
        }
      }
      if (Array.isArray(o.promptTurnSummaries)) {
        const key = `t:${JSON.stringify([o.requestIds ?? null, o.elapsedTime ?? null, o.executionId ?? null, o.promptTurnSummaries])}`;
        if (this.seen.has(key)) continue;
        this.seen.add(key);
        const c = sumCredits((o.promptTurnSummaries as unknown[]).map((x) => ({ ...(obj(x) ?? {}), value: obj(x)?.usage ?? obj(x)?.value })));
        if (c !== undefined && c > 0) {
          added += c;
          this.maxStep = Math.max(this.maxStep, c);
          // a V3 turn summary arrives when the turn is over: nothing is left to stop in this run
          this.lastFromRequest = false;
        }
      }
    }
    if (added) {
      this.credits = round(this.credits + added);
      this.events++;
    }
    return added;
  }
}

export function round(x: number, digits = 6): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

// ---------------------------------------------------------------------------------------------------------
// Session files

export interface SessionSummary {
  files: number;
  credits?: number;
  source?: 'v2-sidecar' | 'v3-usage-summary' | 'v2-event-log';
  turns?: number;
  requests?: number;
  builtinToolUses?: number;
  ctxPctMax?: number;
  toolCalls: number;
  toolNames: Record<string, number>;
  usedTools: Record<string, number>;
  lastAssistantText?: string;
}

function parseDocs(text: string): unknown[] {
  try {
    return [JSON.parse(text)];
  } catch {
    const out: unknown[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // not JSON
      }
    }
    return out;
  }
}

function textOf(x: unknown): string {
  if (typeof x === 'string') return x;
  if (Array.isArray(x)) return x.map(textOf).join('');
  const o = obj(x);
  if (!o) return '';
  if (typeof o.text === 'string') return o.text;
  if (o.content !== undefined) return textOf(o.content);
  return '';
}

/** `files` = [path, text] of every session file copied into the run directory. */
export function parseSessionFiles(files: Array<[string, string]>): SessionSummary {
  const s: SessionSummary = { files: files.length, toolCalls: 0, toolNames: {}, usedTools: {} };
  let v2 = 0;
  let v2Found = false;
  let v3 = 0;
  let v3Found = false;
  let v2log = 0;
  let v2logFound = false;
  const usageIds = new Set<string>();
  const toolIds = new Set<string>();
  for (const [path, text] of files) {
    const isJsonl = /\.jsonl$/i.test(path);
    for (const doc of parseDocs(text)) {
      for (const o of walk(doc)) {
        // V2 sidecar: conversation_metadata.user_turn_metadatas[]
        if (!isJsonl && Array.isArray(o.user_turn_metadatas)) {
          v2Found = true;
          for (const t of o.user_turn_metadatas as unknown[]) {
            const turn = obj(t);
            if (!turn) continue;
            s.turns = (s.turns ?? 0) + 1;
            const c = sumCredits(turn.metering_usage ?? turn.meteringUsage);
            if (c !== undefined) v2 += c;
            const r = num(turn.total_request_count);
            if (r !== undefined) s.requests = (s.requests ?? 0) + r;
            const b = num(turn.builtin_tool_uses);
            if (b !== undefined) s.builtinToolUses = (s.builtinToolUses ?? 0) + b;
            const p = num(turn.final_context_usage_percentage) ?? num(turn.context_usage_percentage);
            if (p !== undefined) s.ctxPctMax = Math.max(s.ctxPctMax ?? 0, p);
          }
          continue;
        }
        // V3 messages.jsonl usage_summary (same data as the stream's turn_completion; one per execution)
        if (o.type === 'usage_summary' && Array.isArray(o.promptTurnSummaries)) {
          const id = str(o.executionId) ?? JSON.stringify(o.promptTurnSummaries) + String(o.elapsedTime ?? '');
          if (usageIds.has(id)) continue;
          usageIds.add(id);
          v3Found = true;
          s.turns = (s.turns ?? 0) + 1;
          const summaries = o.promptTurnSummaries as unknown[];
          const c = sumCredits(summaries.map((x) => ({ ...(obj(x) ?? {}), value: obj(x)?.usage ?? obj(x)?.value })));
          if (c !== undefined) v3 += c;
          if (Array.isArray(o.requestIds)) s.requests = (s.requests ?? 0) + o.requestIds.length;
          for (const x of summaries) {
            for (const t of (obj(x)?.usedTools as unknown[]) ?? []) {
              const n = typeof t === 'string' ? t : str(obj(t)?.name);
              if (n) s.usedTools[n] = (s.usedTools[n] ?? 0) + 1;
            }
          }
          continue;
        }
        // V3 messages.jsonl tool_call records
        if (o.type === 'tool_call') {
          const id = str(o.toolCallId) ?? str(o.toolUseId) ?? str(o.id) ?? `${toolIds.size}`;
          if (!toolIds.has(id)) {
            toolIds.add(id);
            s.toolCalls++;
            const n = str(o.name) ?? str(o.toolName) ?? str(o.title) ?? 'unknown';
            s.toolNames[n] = (s.toolNames[n] ?? 0) + 1;
          }
        }
        if (o.type === 'assistant') {
          const t = textOf(o.content ?? o.text ?? o.message);
          if (t.trim()) s.lastAssistantText = t;
        }
        // V2 event log (.jsonl) metering, only used when the sidecar has none
        if (isJsonl && Array.isArray(o.metering_usage ?? o.meteringUsage)) {
          const c = sumCredits(o.metering_usage ?? o.meteringUsage);
          if (c !== undefined) {
            v2log += c;
            v2logFound = true;
          }
        }
      }
    }
  }
  if (v2Found) [s.credits, s.source] = [round(v2), 'v2-sidecar'];
  else if (v3Found) [s.credits, s.source] = [round(v3), 'v3-usage-summary'];
  else if (v2logFound) [s.credits, s.source] = [round(v2log), 'v2-event-log'];
  return s;
}

// ---------------------------------------------------------------------------------------------------------
// kopt telemetry (<KOPT_HOME>/telemetry/<day>.jsonl)

export interface TelemetrySummary {
  toolCalls: number;
  byTool: Record<string, number>;
  hookEvents: number;
  sessionEvents: number;
  lines: number;
}

export function parseTelemetry(texts: string[]): TelemetrySummary {
  const t: TelemetrySummary = { toolCalls: 0, byTool: {}, hookEvents: 0, sessionEvents: 0, lines: 0 };
  for (const text of texts) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let e: Obj | undefined;
      try {
        e = obj(JSON.parse(line));
      } catch {
        continue;
      }
      if (!e) continue;
      t.lines++;
      if (e.kind === 'tool') {
        t.toolCalls++;
        const n = str(e.tool) ?? 'unknown';
        t.byTool[n] = (t.byTool[n] ?? 0) + 1;
      } else if (e.kind === 'hook') t.hookEvents++;
      else if (e.kind === 'session') t.sessionEvents++;
    }
  }
  return t;
}

// ---------------------------------------------------------------------------------------------------------
// Failure classification

const PATTERNS: Array<[ErrorKind, RegExp]> = [
  // before auth_expired: the suspension also comes as an AccessDeniedException (403)
  ['account_blocked', /temporarily suspended|unusual user activity|locked it as a security precaution|(?:User ID|account) (?:is|has been) (?:temporarily )?(?:suspended|locked|disabled|banned)/i],
  ['not_logged_in', /not logged in|You are not logged in|Login now\?|Opening auth portal|run `?kiro-cli login`?/i],
  ['auth_expired', /Authentication expired|Authentication failed|session may have expired|AccessDeniedException|AccessDenied\b/i],
  ['quota', /quota exceeded|MonthlyLimitReached|MONTHLY_REQUEST_COUNT|OVERAGE_REQUEST_LIMIT_EXCEEDED|ServiceQuotaExceeded|limits reset|out of credits|credit limit/i],
  ['model_unavailable', /failed to set model|InvalidModelId|invalid model|model .* (?:not available|unavailable|not found)/i],
  ['throttled', /ThrottlingException|\bThrottling\b|INSUFFICIENT_MODEL_CAPACITY|ModelOverloaded|having trouble responding|rate limit/i],
];

export function classifyText(text: string): ErrorKind | undefined {
  for (const [kind, re] of PATTERNS) if (re.test(text)) return kind;
  return undefined;
}

/** Tools the harness never trusts in headless runs: their denial is the expected outcome, not a setup error. */
const UNTRUSTED_BY_DESIGN = /kopt_run|execute_bash|execute_pwsh|execute_cmd|\bshell\b|fs_write|str_replace|delete_file|\bwrite\b|kind:(execute|edit|delete|move)/i;

export interface Classification {
  errorKind?: ErrorKind;
  detail?: string;
}

/** Failure of a run from its exit, stderr and stream (undefined errorKind = no failure seen). */
export function classifyRun(o: {
  exitCode: number | null;
  timedOut: boolean;
  spawnError?: string;
  stderr: string;
  stream: StreamSummary;
  /** The harness stopped before the run finished (killed, crashed, closed terminal). */
  aborted?: boolean;
  /** The harness killed the run: its metered credits reached the budget. */
  budgetKill?: string;
}): Classification {
  const tail = (t: string) => t.trim().split(/\r?\n/).slice(-3).join(' | ').slice(0, 400);
  if (o.spawnError) return { errorKind: 'spawn_failed', detail: o.spawnError };
  if (o.aborted) return { errorKind: 'aborted', detail: 'the harness stopped before this run finished' };
  if (o.budgetKill) return { errorKind: 'budget_exceeded', detail: o.budgetKill };
  if (o.timedOut) return { errorKind: 'timeout', detail: 'killed after the per-run timeout' };
  const streamErrors = [...o.stream.runErrors, ...o.stream.displayErrors].join('\n');
  const fromText = classifyText(`${o.stderr}\n${streamErrors}`);
  // auth / quota / model problems first: they explain a non-zero exit better than the code does
  if (fromText && fromText !== 'throttled') return { errorKind: fromText, detail: tail(streamErrors || o.stderr) };
  if (o.exitCode === 3) return { errorKind: 'mcp_startup', detail: tail(o.stderr) || 'exit 3: an MCP server failed to start (--require-mcp-startup)' };
  if (o.exitCode === 4) return { errorKind: 'agent_not_found', detail: tail(o.stderr) || 'exit 4: agent not found' };
  // Tools left untrusted on purpose (kopt_run runs commands; write/shell only exist with --tools) may be denied: the
  // model then carries on. A denied read-only tool means the trust settings are wrong for every run.
  const byDesign = (t: ToolCallInfo) => UNTRUSTED_BY_DESIGN.test(`${t.name} ${t.title ?? ''}`);
  const denied = o.stream.toolCalls.filter(isDenied);
  const unexpected = denied.filter((t) => !byDesign(t));
  if (unexpected.length) {
    return { errorKind: 'tool_denied', detail: `${unexpected.length} tool call(s) denied (${[...new Set(unexpected.map((t) => t.name))].join(', ')}): the trust settings do not cover a read-only tool the agent used` };
  }
  // "[denied]" lines on stderr that no stream event explains (failed calls of tools left untrusted on purpose account
  // for theirs): blame the failed calls of read-only tools
  const byDesignFailed = o.stream.toolCalls.filter((t) => t.status === 'failed' && !denied.includes(t) && byDesign(t)).length;
  const extra = stderrDenials(o.stderr) - denied.length - byDesignFailed;
  if (extra > 0) {
    const failed = o.stream.toolCalls.filter((t) => t.status === 'failed' && !denied.includes(t) && !byDesign(t));
    if (failed.length) {
      return { errorKind: 'tool_denied', detail: `${extra} tool permission denial(s) on stderr; failed read-only tool call(s): ${[...new Set(failed.map((t) => t.name))].join(', ')}` };
    }
  }
  if (fromText === 'throttled') return { errorKind: 'throttled', detail: tail(streamErrors || o.stderr) };
  if (o.stream.runErrors.length) return { errorKind: 'run_error', detail: tail(o.stream.runErrors.join('\n')) };
  if (o.stream.displayErrors.length) return { errorKind: 'display_error', detail: tail(o.stream.displayErrors.join('\n')) };
  if (o.exitCode !== 0) return { errorKind: 'exit_nonzero', detail: `exit ${o.exitCode}${o.stderr.trim() ? `: ${tail(o.stderr)}` : ''}` };
  return {};
}

/** stderr warnings kiro-cli prints and then continues (the run is kept, the warning is recorded). */
export function stderrWarnings(stderr: string): string[] {
  const out: string[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    if (/\[warn\]|warning:/i.test(line)) out.push(line.trim().slice(0, 300));
  }
  return out.slice(0, 10);
}

// ---------------------------------------------------------------------------------------------------------
// V3 session location

/**
 * V3 session bucket of a workspace: first 16 hex chars of sha256 of the absolute cwd string, as the V3 engine
 * computes it (verified against the engine log of kiro-cli 2.28). `_global` without a workspace.
 */
export function v3Bucket(cwd: string | undefined): string {
  if (!cwd) return '_global';
  return createHash('sha256').update(cwd).digest('hex').slice(0, 16);
}

/**
 * Spellings of a workspace path the engine may have hashed (as given, resolved, real path; on Windows also the
 * `\\?\` verbatim form a Rust `canonicalize` returns, and the plain form of a verbatim path).
 */
export function bucketCandidates(cwd: string, real: string | undefined, platform: NodeJS.Platform = process.platform): string[] {
  const p = platform === 'win32' ? win32 : posix;
  const forms = new Set<string>([cwd, platform === 'win32' && /^\\\\\?\\/.test(cwd) ? cwd : p.resolve(cwd)]);
  if (real) forms.add(real);
  const trimmed = [...forms].map((f) => (f.length > 1 && !/^[A-Za-z]:\\$/.test(f) ? f.replace(/[\\/]+$/, '') : f));
  const all = new Set(trimmed);
  if (platform === 'win32') {
    for (const f of trimmed) {
      if (f.startsWith('\\\\?\\UNC\\')) all.add(`\\\\${f.slice(8)}`);
      else if (f.startsWith('\\\\?\\')) all.add(f.slice(4));
      else if (f.startsWith('\\\\')) all.add(`\\\\?\\UNC\\${f.slice(2)}`);
      else if (/^[A-Za-z]:\\/.test(f)) all.add(`\\\\?\\${f}`);
    }
  }
  return [...new Set([...all].map((f) => v3Bucket(f)))];
}
