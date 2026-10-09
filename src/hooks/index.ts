// Session governor: Kiro command hooks (`kopt hook`, JSON event on stdin).
//
// Kiro semantics (docs/hooks/actions + IDE 0.12.318 extension.js N5()): exit 2 blocks PreToolUse /
// UserPromptSubmit / PreTaskExec and sends stderr to the model (one extra model turn); exit-0 stdout
// reaches the context only for SessionStart / UserPromptSubmit. Legacy IDE 0.x `.kiro.hook` runCommand hooks
// intercept the tool call whenever the hook produced output, so "allow" must be a silent exit 0 everywhere.
// Hooks cannot rewrite tool I/O. Every path here must be fast (one short-lived process per tool call) and must
// never break the user's flow: internal errors => silent exit 0 + <userDir>/hook-errors.log.
//
// Payloads normalized here (all verified 2026-10-09):
//  - IDE 1.x / CLI V3 (v1 hook files): stdin JSON {hook_event_name: PascalCase, session_id, cwd, tool_name,
//    tool_input, tool_response, prompt, file_path} (0.12 bundle D5(), shared harness).
//  - CLI 2.x agent hooks: stdin JSON with camelCase hook_event_name (agentSpawn, userPromptSubmit, preToolUse,
//    postToolUse, stop: the only triggers `kiro-cli agent validate` 2.28 accepts) + USER_PROMPT env.
//  - IDE 0.x `.kiro.hook` runCommand: NO stdin payload (the pipe is left open), env USER_PROMPT only: the prompt
//    (promptSubmit), JSON tool args (preToolUse) or {toolName, toolArgs, toolResult, toolSuccess} (postToolUse).
//    `kopt hook <event> --legacy` builds the event from it (see legacyEvent).
// When two hook formats are active for the same session (e.g. ~/.kiro/hooks/kopt.json plus a workspace copy,
// or CLI agent hooks plus V3 global hooks), the same event arrives twice: events tagged with different
// `--source` values within 2 s are processed once (see isDuplicate).

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { KoptConfig } from '../core/config.js';
import { findProjectRoot, indexPath, isUnsafeRoot, loadConfig } from '../core/config.js';
import { estimateTokens } from '../core/tokens.js';
import type { TelemetryEvent } from '../core/types.js';
import { kiroHomeDir } from '../kiro/paths.js';
import { readTextFile, repoRelative } from '../telemetry/fsutil.js';
import { record } from '../telemetry/record.js';
import { atomicWrite, readJson, withFileLock } from '../telemetry/fsutil.js';
import { analyzeCommand } from './commands.js';
import { loadSession, newSession, pruneSessions, saveSession, sessionFile, withSessionLock, type SessionState } from './session.js';
import { classifyTool, readRequests, writtenPaths } from './tools.js';

export interface HookEvent {
  hook_event_name: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: any;
  tool_response?: any;
  prompt?: string;
  /** Which hook configuration invoked kopt (`kopt hook --source <name>`): global | workspace | agent | legacy. */
  _kopt_source?: string;
  [k: string]: unknown;
}

export interface HookOutcome {
  exitCode: 0 | 2;
  stdout?: string;
  stderr?: string;
}

export type BlockReason = 'budget' | 'big-read' | 'verbose-cmd' | 'duplicate-run';

// Trigger names and aliases accepted by Kiro: v1 PascalCase, IDE 0.x `when.type` names (IDEListenableEvent in the
// 0.12 bundle: fileEdited, fileCreated, fileDeleted, userTriggered, promptSubmit, agentStop, preToolUse,
// postToolUse, preTaskExecution, postTaskExecution, sessionStart), the harness alias map x8 (SessionEnd,
// AfterFileEdit, agentSpawn...) and CLI 2.x agent names (agentSpawn, userPromptSubmit, preToolUse, postToolUse, stop).
const EVENT_ALIASES: Record<string, string> = {
  sessionstart: 'SessionStart', agentspawn: 'SessionStart',
  userpromptsubmit: 'UserPromptSubmit', promptsubmit: 'UserPromptSubmit',
  pretooluse: 'PreToolUse', posttooluse: 'PostToolUse',
  postfilesave: 'PostFileSave', fileedited: 'PostFileSave', afterfileedit: 'PostFileSave',
  postfilecreate: 'PostFileCreate', filecreated: 'PostFileCreate',
  postfiledelete: 'PostFileDelete', filedeleted: 'PostFileDelete',
  stop: 'Stop', agentstop: 'Stop', sessionend: 'Stop',
  pretaskexec: 'PreTaskExec', pretaskexecution: 'PreTaskExec',
  posttaskexec: 'PostTaskExec', posttaskexecution: 'PostTaskExec',
  usertriggered: 'Manual', manual: 'Manual',
};

export function canonicalEvent(name: unknown): string | undefined {
  return typeof name === 'string' ? EVENT_ALIASES[name.replace(/[^A-Za-z]/g, '').toLowerCase()] : undefined;
}

const SESSION_START_MAX = 250;
const SHIP_THROTTLE_MS = 60_000;
const REFRESH_THROTTLE_MS = 60_000;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|svgz)$/i;

function sessionIdOf(e: HookEvent): string {
  const id = e.session_id ?? (e as { sessionId?: unknown }).sessionId ?? process.env.KIRO_SESSION_ID;
  return typeof id === 'string' && id ? id : `anon-${new Date().toISOString().slice(0, 10)}`;
}

/** Repo-relative forward-slash path when inside root (case-insensitive where the filesystem is), else the absolute path. */
function displayPath(root: string, abs: string): string {
  return repoRelative(root, abs) || abs;
}

function fmtK(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n));
}

export function logHookError(config: KoptConfig | undefined, err: unknown, event?: unknown): void {
  try {
    const dir = config?.userDir ?? process.env.KOPT_HOME;
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'hook-errors.log');
    try {
      if (statSync(file).size > 1_000_000) renameSync(file, file + '.1');
    } catch { /* first error */ }
    const name = (event as HookEvent | undefined)?.hook_event_name;
    const msg = err instanceof Error ? (err.stack ?? err.message).split('\n').slice(0, 4).join(' | ') : String(err);
    appendFileSync(file, `${new Date().toISOString()} ${String(name ?? '?')} ${msg}\n`);
  } catch {
    // nothing left to do
  }
}

/** The enabled `kopt` MCP server entry (workspace config wins over user config), if any. */
export function koptMcpEntry(root: string): { command?: string; url?: string } | undefined {
  const home = kiroHomeDir();
  for (const file of [join(root, '.kiro', 'settings', 'mcp.json'), join(home, 'settings', 'mcp.json')]) {
    try {
      const cfg = JSON.parse(readTextFile(file));
      const s = cfg?.mcpServers?.kopt;
      if (s && typeof s === 'object') return s.disabled === true ? undefined : s;
    } catch { /* missing or invalid */ }
  }
  return undefined;
}

/** Is the kopt MCP server configured (and enabled) for this workspace or user-wide? */
export function koptMcpInstalled(root: string): boolean {
  return koptMcpEntry(root) !== undefined;
}

/** kopt_run can only execute the user's commands when the server runs locally (stdio). */
function koptRunAvailable(root: string): boolean {
  const e = koptMcpEntry(root);
  return !!e && typeof e.command === 'string' && !e.url;
}

/** Line count of a file, or undefined when it cannot exceed `threshold` / is not a text file. */
function bigFileLines(abs: string, threshold: number): { lines: number; bytes: number } | undefined {
  let st;
  try { st = statSync(abs); } catch { return undefined; }
  // a file with more than N lines has at least N bytes
  if (!st.isFile() || st.size <= threshold || IMAGE_EXT.test(abs)) return undefined;
  if (st.size > 64 * 1024 * 1024) return { lines: Math.round(st.size / 40), bytes: st.size };
  const buf = readFileSync(abs);
  if (buf.subarray(0, 8192).includes(0)) return undefined; // binary
  let lines = 0;
  for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) lines++;
  if (buf.length && buf[buf.length - 1] !== 10) lines++;
  return lines > threshold ? { lines, bytes: st.size } : undefined;
}

function blockEvent(config: KoptConfig, session: string, tool: string | undefined, reason: BlockReason): void {
  record({ ts: Date.now(), kind: 'hook', session, tool, decision: 'block', meta: { reason } }, config);
}

function block(s: SessionState, reason: BlockReason, stderr: string): HookOutcome {
  s.blocks[reason] = (s.blocks[reason] ?? 0) + 1;
  return { exitCode: 2, stderr };
}

function preToolUse(event: HookEvent, config: KoptConfig): HookOutcome {
  const sid = sessionIdOf(event);
  const tool = event.tool_name;
  const cls = classifyTool(tool);
  const g = config.governor;
  const root = config.root;
  let reason: BlockReason | undefined;
  const outcome = withSessionLock(config.userDir, sid, (): HookOutcome => {
    const s = loadSession(config.userDir, sid);
    s.toolCalls++;
    let out: HookOutcome = { exitCode: 0 };
    if (g.maxToolCallsPerSession > 0 && s.toolCalls - s.budgetFrom > g.maxToolCallsPerSession) {
      reason = 'budget';
      out = block(s, reason, `kopt governor: session tool-call budget (${g.maxToolCallsPerSession}) reached. Stop here: summarize what is done and what remains, and ask the user before continuing.`);
    } else if (cls === 'read' && g.bigFileLines > 0) {
      const base = typeof event.cwd === 'string' && event.cwd ? event.cwd : root;
      const msgs: string[] = [];
      for (const r of readRequests(event.tool_input, g.bigFileLines)) {
        if (!r.whole) continue;
        const abs = isAbsolute(r.path) ? r.path : resolve(base, r.path);
        const shown = displayPath(root, abs);
        if (s.deniedReads[shown]) continue; // the second identical attempt goes through (no deadlock)
        const big = bigFileLines(abs, g.bigFileLines);
        if (!big) continue;
        s.deniedReads[shown] = 1;
        const tok = big.bytes / (config.charsPerToken || 3);
        msgs.push(`${shown} has ${big.lines} lines (~${fmtK(tok)} tokens). Use kopt_outline path=${shown} or kopt_read ${shown}:<a>-<b>, or read with offset/limit.`);
      }
      if (msgs.length) {
        reason = 'big-read';
        out = block(s, reason, 'kopt: ' + msgs.join('\nkopt: '));
      }
    } else if (cls === 'shell') {
      const input = event.tool_input ?? {};
      const cmd = typeof input.command === 'string' ? input.command : Array.isArray(input.command) ? input.command.join(' ') : undefined;
      const info = cmd ? analyzeCommand(cmd) : undefined;
      if (info?.kind) {
        let cwdRel = '';
        if (typeof input.cwd === 'string' && input.cwd) {
          const abs = isAbsolute(input.cwd) ? input.cwd : resolve(root, input.cwd);
          const d = displayPath(root, abs);
          cwdRel = d === abs ? '' : d;
        }
        if (info.cdDir) cwdRel = cwdRel ? `${cwdRel}/${info.cdDir}` : info.cdDir;
        const key = `${cwdRel}|${info.key}`;
        if (g.enforceRunForVerbose && !s.redirected[key] && koptRunAvailable(root)) {
          s.redirected[key] = 1;
          reason = 'verbose-cmd';
          const q = info.core.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          const cwdPart = cwdRel && cwdRel !== '.' ? ` cwd="${cwdRel}"` : '';
          out = block(s, reason, `kopt: use kopt_run with command="${q}"${cwdPart}: same execution, returns only failures/errors (full log via kopt_expand).`);
        } else if (g.blockDuplicateRuns) {
          const prev = s.runs[key];
          if (prev && prev.writeSeq === s.writeSeq && prev.dupBlockedAt !== s.writeSeq) {
            prev.dupBlockedAt = s.writeSeq;
            reason = 'duplicate-run';
            out = block(s, reason, 'kopt governor: identical command already ran this session and no file changed since; reuse its result.');
          } else {
            s.runs[key] = { at: Date.now(), writeSeq: s.writeSeq, dupBlockedAt: prev?.writeSeq === s.writeSeq ? prev.dupBlockedAt : undefined };
          }
        }
      }
    }
    saveSession(config.userDir, s);
    return out;
  });
  if (reason) blockEvent(config, sid, tool, reason);
  return outcome;
}

/** Text the model receives from a tool response: all string leaves (bounded walk). */
export function responseText(resp: unknown): string {
  if (typeof resp === 'string') return resp;
  if (resp === null || resp === undefined) return '';
  const parts: string[] = [];
  let nodes = 0;
  const walk = (x: unknown, depth: number) => {
    if (++nodes > 20_000 || depth > 8) return;
    if (typeof x === 'string') parts.push(x);
    else if (Array.isArray(x)) for (const v of x) walk(v, depth + 1);
    else if (x && typeof x === 'object') for (const v of Object.values(x)) walk(v, depth + 1);
  };
  walk(resp, 0);
  return parts.join('\n');
}

/** Record a file write: bumps writeSeq (unblocks duplicate runs) and feeds <dataDir>/dirty. */
function markWrite(config: KoptConfig, sid: string, paths: string[], base: string): void {
  withSessionLock(config.userDir, sid, () => {
    const s = loadSession(config.userDir, sid);
    s.writeSeq++;
    s.lastWriteCall = s.toolCalls;
    s.lastWriteAt = Date.now();
    saveSession(config.userDir, s);
  });
  if (!paths.length || !existsSync(config.dataDir)) return;
  const rels: string[] = [];
  for (const p of paths) {
    const abs = isAbsolute(p) ? p : resolve(base, p);
    const rel = displayPath(config.root, abs);
    if (rel === abs || rel.startsWith('.git/') || rel.startsWith('.kopt/')) continue;
    rels.push(rel);
  }
  if (rels.length) appendFileSync(join(config.dataDir, 'dirty'), rels.join('\n') + '\n');
}

function postToolUse(event: HookEvent, config: KoptConfig): HookOutcome {
  const sid = sessionIdOf(event);
  const tool = event.tool_name;
  const cls = classifyTool(tool);
  const text = responseText(event.tool_response);
  const ev: TelemetryEvent = { ts: Date.now(), kind: 'hook', session: sid, tool, bytes: Buffer.byteLength(text, 'utf8'), tokensOut: estimateTokens(text) };
  if (cls === 'shell') {
    const cmd = event.tool_input?.command;
    const kind = typeof cmd === 'string' ? analyzeCommand(cmd).kind : undefined;
    if (kind) ev.meta = { cmd: kind };
  }
  record(ev, config);
  if (cls === 'write') {
    const base = typeof event.cwd === 'string' && event.cwd ? event.cwd : config.root;
    markWrite(config, sid, writtenPaths(event.tool_input), base);
  }
  return { exitCode: 0 };
}

function fileEvent(event: HookEvent, config: KoptConfig): HookOutcome {
  const p = event.file_path ?? event.filePath ?? event.path;
  const base = typeof event.cwd === 'string' && event.cwd ? event.cwd : config.root;
  markWrite(config, sessionIdOf(event), typeof p === 'string' && p ? [p] : [], base);
  return { exitCode: 0 };
}

function promptText(event: HookEvent): string {
  const p = event.prompt ?? event.user_prompt ?? process.env.USER_PROMPT;
  return typeof p === 'string' ? p : '';
}

async function userPromptSubmit(event: HookEvent, config: KoptConfig): Promise<HookOutcome> {
  const sid = sessionIdOf(event);
  const max = config.governor.maxToolCallsPerSession;
  let sent: string[] = [];
  withSessionLock(config.userDir, sid, () => {
    const s = loadSession(config.userDir, sid);
    sent = [...s.frontSent];
    // The budget stop asks the agent to check with the user: a new user prompt re-arms the budget.
    if (max > 0 && s.toolCalls - s.budgetFrom >= max) {
      s.budgetFrom = s.toolCalls;
      saveSession(config.userDir, s);
    }
  });
  if (isUnsafeRoot(config.root)) return { exitCode: 0 };
  const before = sent.length;
  const { frontload } = await import('./frontload.js');
  const out = await frontload(promptText(event), config, { session: sid, alreadySent: sent });
  if (!out) return { exitCode: 0 };
  const added = sent.slice(before);
  withSessionLock(config.userDir, sid, () => {
    const s = loadSession(config.userDir, sid);
    s.frontSent.push(...added);
    saveSession(config.userDir, s);
  });
  record({ ts: Date.now(), kind: 'hook', session: sid, tool: 'frontload', decision: 'inject', tokensOut: estimateTokens(out), bytes: Buffer.byteLength(out) }, config);
  return { exitCode: 0, stdout: out + '\n' };
}

/** Touch a marker file; false when it was touched less than `ms` ago (throttling background work). */
function throttle(path: string, ms: number): boolean {
  try {
    if (Date.now() - statSync(path).mtimeMs < ms) return false;
    const now = new Date();
    utimesSync(path, now, now);
    return true;
  } catch {
    try {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, '');
      return true;
    } catch {
      return false;
    }
  }
}

async function indexSummary(config: KoptConfig): Promise<{ commit?: string; symbols?: number } | undefined> {
  if (!existsSync(indexPath(config))) return undefined;
  const spec = '../store/store.js';
  const { Store } = await import(spec);
  const store = Store.open(indexPath(config), { root: config.root, readonly: true });
  try {
    const commit = store.getMeta('commit') as string | undefined;
    const row = store.prepare('SELECT count(*) AS n FROM symbols').get() as { n: number } | undefined;
    return { commit, symbols: row?.n };
  } finally {
    store.close();
  }
}

async function sessionStart(event: HookEvent, config: KoptConfig): Promise<HookOutcome> {
  const sid = sessionIdOf(event);
  try { pruneSessions(config.userDir); } catch { /* best effort */ }
  withSessionLock(config.userDir, sid, () => saveSession(config.userDir, { ...newSession(sid), ...pickPersistent(loadSession(config.userDir, sid)) }));
  record({ ts: Date.now(), kind: 'session', session: sid, meta: { event: 'start' } }, config);
  if (isUnsafeRoot(config.root)) return { exitCode: 0 }; // home dir or filesystem root: not a project
  const entry = koptMcpEntry(config.root);
  if (!entry) return { exitCode: 0 };
  let info: { commit?: string; symbols?: number } | undefined;
  try { info = await indexSummary(config); } catch (err) { logHookError(config, err, event); }
  const remote = typeof entry.url === 'string' && !entry.command;
  const advice = remote
    ? 'Prefer kopt_find/kopt_read/kopt_outline over grep + whole-file reads.'
    : 'Prefer kopt_find/kopt_read/kopt_outline over grep + whole-file reads; kopt_run for tests/builds.';
  let line: string;
  if (remote && !info) {
    line = `kopt: central index. ${advice}`;
  } else if (info) {
    const at = info.commit ? ` @${info.commit.slice(0, 7)}` : '';
    const n = typeof info.symbols === 'number' ? `, ${info.symbols} symbols` : '';
    line = `kopt: index${at}${n}. ${advice}`;
    if (throttle(join(config.dataDir, '.refresh-spawned'), REFRESH_THROTTLE_MS)) (await import('./spawn.js')).spawnKopt(['index', '--refresh'], config.root);
  } else {
    line = `kopt: index building in the background. ${advice}`;
  }
  return { exitCode: 0, stdout: line.slice(0, SESSION_START_MAX) + '\n' };
}

/** A repeated SessionStart for the same id (resume) keeps its counters. */
function pickPersistent(s: SessionState): Partial<SessionState> {
  return s.toolCalls > 0 ? s : {};
}

async function stop(event: HookEvent, config: KoptConfig): Promise<HookOutcome> {
  const sid = sessionIdOf(event);
  const s = loadSession(config.userDir, sid);
  record({ ts: Date.now(), kind: 'session', session: sid, meta: { event: 'stop', toolCalls: s.toolCalls, blocks: s.blocks } }, config);
  if (config.telemetry.enabled && throttle(join(config.userDir, 'telemetry', '.last-ship'), SHIP_THROTTLE_MS)) {
    (await import('./spawn.js')).spawnKopt(['telemetry', 'ship'], config.root);
  }
  return { exitCode: 0 };
}

export const DUPLICATE_WINDOW_MS = 2000;

/** Stable JSON (sorted keys) for hashing payloads. */
function stableJson(x: unknown, depth = 0): string {
  if (depth > 6 || x === null || typeof x !== 'object') return JSON.stringify(x) ?? 'null';
  if (Array.isArray(x)) return `[${x.map((v) => stableJson(v, depth + 1)).join(',')}]`;
  return `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${stableJson((x as Record<string, unknown>)[k], depth + 1)}`).join(',')}}`;
}

/** Identity of an event for de-duplication: session + event + tool + input. */
export function eventKey(event: HookEvent, name: string): string {
  const subject = event.tool_input ?? event.prompt ?? event.file_path ?? event.filePath ?? '';
  return createHash('sha1').update(`${sessionIdOf(event)}|${name}|${event.tool_name ?? ''}|${stableJson(subject)}`).digest('hex').slice(0, 16);
}

interface RecentEntry { k: string; t: number; s: string }

/**
 * True when the same event (session, event, tool, input) was already received from ANOTHER hook source within
 * DUPLICATE_WINDOW_MS, i.e. two hook formats are active and both fired for one tool call. Repeats from the same
 * source are real repeats (the agent retried) and are processed. Events without a source are never deduplicated.
 */
export function isDuplicate(event: HookEvent, name: string, config: KoptConfig, now = Date.now()): boolean {
  const source = typeof event._kopt_source === 'string' && event._kopt_source ? event._kopt_source : undefined;
  if (!source) return false;
  const key = eventKey(event, name);
  const file = sessionFile(config.userDir, sessionIdOf(event)).replace(/\.json$/, '.recent.json');
  return withFileLock(file + '.lock', () => {
    const recent = readJson<{ e?: RecentEntry[] }>(file, {}).e ?? [];
    const live = recent.filter((r) => r && now - r.t < 10_000 && now >= r.t - 1000);
    if (live.some((r) => r.k === key && r.s !== source && now - r.t < DUPLICATE_WINDOW_MS)) return true;
    const next = live.filter((r) => !(r.k === key && r.s === source));
    next.push({ k: key, t: now, s: source });
    atomicWrite(file, JSON.stringify({ e: next.slice(-64) }));
    return false;
  }, { timeoutMs: 150, staleMs: 2000, runUnlocked: true }) ?? false;
}

/**
 * Event for an IDE 0.x `.kiro.hook` runCommand invocation (`kopt hook <when.type> --legacy`): Kiro passes no
 * stdin payload, only USER_PROMPT (the prompt, the JSON tool args, or the JSON {toolName, toolArgs, toolResult,
 * toolSuccess} of postToolUse), and runs the command in the workspace folder.
 */
export function legacyEvent(name: string, env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): HookEvent {
  const event: HookEvent = { hook_event_name: name, cwd };
  const raw = env.USER_PROMPT ?? '';
  const canonical = canonicalEvent(name);
  const parsed = (): any => {
    try {
      return raw.trim() ? JSON.parse(raw) : undefined;
    } catch {
      return undefined;
    }
  };
  if (canonical === 'UserPromptSubmit') event.prompt = raw;
  else if (canonical === 'PreToolUse') {
    const input = parsed();
    if (input && typeof input === 'object') event.tool_input = input;
  } else if (canonical === 'PostToolUse') {
    const p = parsed();
    if (p && typeof p === 'object') {
      if (typeof p.toolName === 'string') event.tool_name = p.toolName;
      event.tool_input = p.toolArgs;
      event.tool_response = p.toolResult;
    }
  }
  return event;
}

/** Dispatch one hook event. Never throws; errors => silent exit 0 + hook-errors.log. */
export async function handleHook(event: HookEvent, config: KoptConfig): Promise<HookOutcome> {
  try {
    if (!event || typeof event !== 'object') return { exitCode: 0 };
    const name = canonicalEvent(event.hook_event_name);
    if (!name || name === 'Manual') return { exitCode: 0 };
    if (isDuplicate(event, name, config)) return { exitCode: 0 };
    switch (name) {
      case 'PreToolUse': return preToolUse(event, config);
      case 'PostToolUse': return postToolUse(event, config);
      case 'UserPromptSubmit': return await userPromptSubmit(event, config);
      case 'SessionStart': return await sessionStart(event, config);
      case 'PostFileSave':
      case 'PostFileCreate':
      case 'PostFileDelete': return fileEvent(event, config);
      case 'Stop': return await stop(event, config);
      default: return { exitCode: 0 };
    }
  } catch (err) {
    logHookError(config, err, event);
    return { exitCode: 0 };
  }
}

function readStdin(timeoutMs: number): Promise<string> {
  return new Promise((resolveText) => {
    const stdin = process.stdin;
    if (stdin.isTTY) return resolveText('');
    const chunks: Buffer[] = [];
    const done = () => { clearTimeout(timer); stdin.removeAllListeners('data'); stdin.pause(); resolveText(Buffer.concat(chunks).toString('utf8')); };
    const timer = setTimeout(done, timeoutMs);
    stdin.on('data', (c: Buffer) => chunks.push(c));
    stdin.once('end', done);
    stdin.once('error', done);
  });
}

function writeOut(stream: NodeJS.WriteStream, text: string): Promise<void> {
  return new Promise((r) => {
    try { stream.write(text, () => r()); } catch { r(); }
  });
}

/**
 * Entry point for `kopt hook [EventName]`: reads the event from stdin, writes stdout/stderr and
 * returns the exit code (the CLI should exit with it). `argv[0]` names the event when the payload
 * lacks `hook_event_name`. Set KOPT_HOOKS=0 to disable all hooks.
 */
export async function runHookCli(argv: string[] = []): Promise<number> {
  let config: KoptConfig | undefined;
  let event: HookEvent | undefined;
  try {
    let name: string | undefined;
    let source: string | undefined;
    let legacy = false;
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--legacy') legacy = true;
      else if (argv[i] === '--source') source = argv[++i];
      else if (!argv[i].startsWith('-') && !name) name = argv[i];
    }
    if (legacy && name) {
      event = legacyEvent(name);
    } else {
      const raw = await readStdin(2000);
      let parsed: any = {};
      try { parsed = raw.trim() ? JSON.parse(raw) : {}; } catch { parsed = {}; }
      event = (parsed && typeof parsed === 'object' ? parsed : {}) as HookEvent;
    }
    if (!event.hook_event_name && name) event.hook_event_name = name;
    if (source) event._kopt_source = source;
    if (process.env.KOPT_HOOKS === '0') return 0;
    const cwd = typeof event.cwd === 'string' && event.cwd && existsSync(event.cwd) ? event.cwd : process.cwd();
    config = loadConfig(process.env.KOPT_ROOT || findProjectRoot(cwd));
    const out = await handleHook(event, config);
    if (out.stdout) await writeOut(process.stdout, out.stdout);
    if (out.stderr) await writeOut(process.stderr, out.stderr.endsWith('\n') ? out.stderr : out.stderr + '\n');
    return out.exitCode;
  } catch (err) {
    logHookError(config, err, event);
    return 0;
  }
}

/** Internals exposed for tests. */
export const _internal = { bigFileLines, sessionIdOf, displayPath };
