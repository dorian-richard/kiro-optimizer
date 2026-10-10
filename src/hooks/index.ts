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
// `--source` values within 2 s are processed once (see isDuplicate). Prompt events are matched on the prompt text
// alone: IDE 0.x legacy hooks carry no session id.
// Exit codes: only 0 and 2. In Kiro IDE 1.x a Stop hook that exits 1 means "continue the agent", so Stop always exits
// 0 (the launcher written by setup also maps every failure to a silent 0).

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { KoptConfig } from '../core/config.js';
import { findProjectRoot, indexPath, isUnsafeRoot, loadConfig, userDirFor } from '../core/config.js';
import { estimateTokens } from '../core/tokens.js';
import type { TelemetryEvent } from '../core/types.js';
import { kiroHomeDir } from '../kiro/paths.js';
import { appendPrivateFile, atomicWrite, mkdirPrivate, readJson, readTextFile, repoRelative, withFileLock } from '../telemetry/fsutil.js';
import { pruneTelemetry, record } from '../telemetry/record.js';
import { analyzeCommand, isReadOnlyCommand } from './commands.js';
import { governorFingerprint } from './fingerprint.js';
import { loadSession, newSession, pruneSessions, saveSession, sessionFile, sessionsDir, withSessionLock, type SessionState } from './session.js';
import { classifyTool, koptToolName, readRequests, writtenPaths } from './tools.js';

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
const REFRESH_THROTTLE_MS = 60_000;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|svgz)$/i;
/** Redirects to kopt_run per session: the first ones teach the model; more would only cost turns. */
export const MAX_REDIRECTS_PER_SESSION = 3;
/** IDE 0.x legacy hooks carry no chat id: a pause this long starts a new pseudo-session. */
export const LEGACY_SESSION_IDLE_MS = 30 * 60_000;

function sessionIdOf(e: HookEvent): string {
  const id = e.session_id ?? (e as { sessionId?: unknown }).sessionId ?? process.env.KIRO_SESSION_ID;
  return typeof id === 'string' && id ? id : `anon-${new Date().toISOString().slice(0, 10)}`;
}

/**
 * Session id for an IDE 0.x legacy hook event (no stdin, no chat id): one pseudo-session per workspace that ends
 * after LEGACY_SESSION_IDLE_MS without a prompt, so a new chat gets pointers that an earlier one received.
 */
export function legacySessionId(config: KoptConfig, now = Date.now()): string {
  const tag = createHash('sha1').update(config.root).digest('hex').slice(0, 8);
  const file = join(sessionsDir(config.userDir), `_legacy-${tag}.last.json`);
  return withFileLock(file + '.lock', () => {
    const last = readJson<{ id?: string; at?: number }>(file, {});
    const fresh = typeof last.id === 'string' && typeof last.at === 'number' && now - last.at < LEGACY_SESSION_IDLE_MS && now >= last.at;
    const id = fresh ? last.id! : `legacy-${tag}-${now.toString(36)}`;
    atomicWrite(file, JSON.stringify({ id, at: now }));
    return id;
  }, { timeoutMs: 150, staleMs: 2000, runUnlocked: true }) ?? `legacy-${tag}`;
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
    const dir = config?.userDir ?? userDirFor();
    mkdirPrivate(dir);
    const file = join(dir, 'hook-errors.log');
    try {
      if (statSync(file).size > 1_000_000) renameSync(file, file + '.1');
    } catch { /* first error */ }
    const name = (event as HookEvent | undefined)?.hook_event_name;
    const msg = err instanceof Error ? (err.stack ?? err.message).split('\n').slice(0, 4).join(' | ') : String(err);
    appendPrivateFile(file, `${new Date().toISOString()} ${String(name ?? '?')} ${msg}\n`);
  } catch {
    // nothing left to do
  }
}

/** The `kopt` entry of mcp.json (workspace config wins over user config), when present. */
export function koptMcpEntry(root: string): Record<string, any> | undefined {
  const home = kiroHomeDir();
  for (const file of [join(root, '.kiro', 'settings', 'mcp.json'), join(home, 'settings', 'mcp.json')]) {
    try {
      const cfg = JSON.parse(readTextFile(file));
      const s = cfg?.mcpServers?.kopt;
      if (s && typeof s === 'object' && !Array.isArray(s)) return s;
    } catch { /* missing or invalid */ }
  }
  return undefined;
}

/** Is the kopt MCP server configured and enabled? */
export function koptMcpInstalled(root: string): boolean {
  const s = koptMcpEntry(root);
  return !!s && s.disabled !== true;
}

/**
 * Can the agent call kopt_run? The server registers it unless its entry disables it (`disabledTools` lists it, or
 * env KOPT_DISABLE_RUN=1). Redirecting to a tool the model cannot call would cost two requests for nothing.
 */
export function koptRunAvailable(root: string): boolean {
  const s = koptMcpEntry(root);
  if (!s || s.disabled === true) return false;
  const disabled = Array.isArray(s.disabledTools) ? s.disabledTools.map(String) : [];
  if (disabled.some((t: string) => koptToolName(t) === 'kopt_run' || t === '*')) return false;
  const env = s.env && typeof s.env === 'object' ? s.env : {};
  if (String(env.KOPT_DISABLE_RUN ?? '') === '1') return false;
  return true;
}

/**
 * Size of a text file whose whole-file read would cost more than `minTokens` (estimated from its bytes), else
 * undefined (small, binary, an image, missing).
 */
function bigFile(abs: string, minTokens: number, charsPerToken: number): { lines: number; bytes: number; tokens: number } | undefined {
  let st;
  try { st = statSync(abs); } catch { return undefined; }
  const tokens = st.size / (charsPerToken || 3);
  if (!st.isFile() || tokens <= minTokens || IMAGE_EXT.test(abs)) return undefined;
  if (st.size > 64 * 1024 * 1024) return { lines: Math.round(st.size / 40), bytes: st.size, tokens };
  const buf = readFileSync(abs);
  if (buf.subarray(0, 8192).includes(0)) return undefined; // binary
  let lines = 0;
  for (let i = buf.indexOf(10); i !== -1; i = buf.indexOf(10, i + 1)) lines++;
  if (buf.length && buf[buf.length - 1] !== 10) lines++;
  return { lines, bytes: st.size, tokens };
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
    } else if (cls === 'read' && g.bigFileLines > 0 && (g.bigFileTokens ?? 8000) > 0) {
      const base = typeof event.cwd === 'string' && event.cwd ? event.cwd : root;
      const msgs: string[] = [];
      for (const r of readRequests(event.tool_input, g.bigFileLines)) {
        if (!r.whole) continue;
        const abs = isAbsolute(r.path) ? r.path : resolve(base, r.path);
        const shown = displayPath(root, abs);
        if (s.deniedReads[shown]) continue; // the second identical attempt goes through (no deadlock)
        const big = bigFile(abs, g.bigFileTokens ?? 8000, config.charsPerToken);
        if (!big) continue;
        s.deniedReads[shown] = 1;
        msgs.push(`${shown} is ~${fmtK(big.tokens)} tokens (${big.lines} lines). Use kopt_read ${shown} mode=outline or kopt_read ${shown}:<a>-<b>, or read with offset/limit.`);
      }
      if (msgs.length) {
        reason = 'big-read';
        out = block(s, reason, 'kopt: ' + msgs.join('\nkopt: '));
      }
    } else if (cls === 'shell') {
      const run = shellRun(event, root);
      if (run?.info.kind) {
        const { info, key, cwdRel } = run;
        const redirects = Object.keys(s.redirected).length;
        if (g.enforceRunForVerbose && info.verbose && !s.redirected[key] && redirects < MAX_REDIRECTS_PER_SESSION && koptRunAvailable(root)) {
          s.redirected[key] = 1;
          reason = 'verbose-cmd';
          const q = info.core.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          const cwdPart = cwdRel && cwdRel !== '.' ? ` cwd="${cwdRel}"` : '';
          out = block(s, reason, `kopt: use kopt_run with command="${q}"${cwdPart}: same execution, returns only failures/errors (full log via kopt_read <handle>).`);
        } else if (g.blockDuplicateRuns) {
          const prev = s.runs[key];
          const sameState = !!prev && prev.writeSeq === s.writeSeq && (prev.promptSeq ?? 0) === s.promptSeq && prev.dupBlockedAt !== s.writeSeq;
          // writes the hooks did not see (shell, the user's editor, git checkout): compare the workspace itself
          const unchanged = sameState && (prev!.fp === undefined || governorFingerprint(root, ownDirs(config)) === prev!.fp);
          if (unchanged) {
            prev!.dupBlockedAt = s.writeSeq;
            reason = 'duplicate-run';
            out = block(s, reason, 'kopt governor: identical command already ran this session and no file changed since; reuse its result (run it again to override).');
          } else {
            s.runs[key] = { at: Date.now(), writeSeq: s.writeSeq, promptSeq: s.promptSeq, dupBlockedAt: sameState ? prev!.dupBlockedAt : undefined };
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

/** kopt's own folders, whose changes never count as workspace changes. */
function ownDirs(config: KoptConfig): string[] {
  return [config.dataDir, config.userDir, join(config.root, '.kopt')];
}

/** The shell command of a tool call, its classification and its identity (working directory + command). */
function shellRun(event: HookEvent, root: string): { info: ReturnType<typeof analyzeCommand>; key: string; cwdRel: string } | undefined {
  const input = event.tool_input ?? {};
  const cmd = typeof input.command === 'string' ? input.command : Array.isArray(input.command) ? input.command.join(' ') : undefined;
  if (!cmd) return undefined;
  const info = analyzeCommand(cmd);
  let cwdRel = '';
  if (typeof input.cwd === 'string' && input.cwd) {
    const abs = isAbsolute(input.cwd) ? input.cwd : resolve(root, input.cwd);
    const d = displayPath(root, abs);
    cwdRel = d === abs ? '' : d;
  }
  if (info.cdDir) cwdRel = cwdRel ? `${cwdRel}/${info.cdDir}` : info.cdDir;
  return { info, key: `${cwdRel}|${info.key}`, cwdRel };
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
  if (rels.length) appendPrivateFile(join(config.dataDir, 'dirty'), rels.join('\n') + '\n');
}

function postToolUse(event: HookEvent, config: KoptConfig): HookOutcome {
  const sid = sessionIdOf(event);
  const tool = event.tool_name;
  const cls = classifyTool(tool);
  const text = responseText(event.tool_response);
  const ev: TelemetryEvent = { ts: Date.now(), kind: 'hook', session: sid, tool, bytes: Buffer.byteLength(text, 'utf8'), tokensOut: estimateTokens(text) };
  const base = typeof event.cwd === 'string' && event.cwd ? event.cwd : config.root;
  const run = cls === 'shell' || (cls === 'kopt' && koptToolName(tool) === 'kopt_run') ? shellRun(event, config.root) : undefined;
  if (run?.info.kind) ev.meta = { cmd: run.info.kind };
  record(ev, config);
  if (cls === 'write') {
    markWrite(config, sid, writtenPaths(event.tool_input), base);
  } else if (run && !run.info.kind && !isReadOnlyCommand(run.info.command)) {
    // sed -i, git checkout / stash, npm install, codegen, formatters...: the workspace may have changed
    markWrite(config, sid, [], base);
  } else if (run?.info.kind && cls === 'shell' && config.governor.blockDuplicateRuns) {
    // state right after the run: an identical re-run is a duplicate only if nothing changed since
    const fp = governorFingerprint(config.root, ownDirs(config));
    withSessionLock(config.userDir, sid, () => {
      const s = loadSession(config.userDir, sid);
      const r = s.runs[run.key];
      if (r) {
        r.fp = fp;
        saveSession(config.userDir, s);
      }
    });
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
    if (max > 0 && s.toolCalls - s.budgetFrom >= max) s.budgetFrom = s.toolCalls;
    // "run it again" from the user is never a duplicate run
    s.promptSeq++;
    saveSession(config.userDir, s);
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

/** Undefined when there is no index yet or its first build has not completed (a build is running or was cut short). */
async function indexSummary(config: KoptConfig): Promise<{ commit?: string; symbols?: number } | undefined> {
  if (!existsSync(indexPath(config))) return undefined;
  const spec = '../store/store.js';
  const { Store } = await import(spec);
  const store = Store.open(indexPath(config), { root: config.root, readonly: true });
  try {
    if (!store.getMeta('indexed_at')) return undefined;
    const commit = store.getMeta('commit') as string | undefined;
    // the indexer records the count at the end of each pass (counting 500k+ rows costs a few dozen ms)
    const recorded = Number(store.getMeta('symbol_count'));
    const symbols = Number.isFinite(recorded) && recorded > 0 ? recorded : (store.prepare('SELECT count(*) AS n FROM symbols').get() as { n: number } | undefined)?.n;
    return { commit, symbols };
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
  if (!koptMcpInstalled(config.root)) return { exitCode: 0 };
  let info: { commit?: string; symbols?: number } | undefined;
  try { info = await indexSummary(config); } catch (err) { logHookError(config, err, event); }
  const advice = `Prefer kopt_find/kopt_read/kopt_refs over grep + whole-file reads${koptRunAvailable(config.root) ? '; kopt_run for tests/builds' : ''}.`;
  let line: string;
  if (info) {
    const at = info.commit ? ` @${info.commit.slice(0, 7)}` : '';
    const n = typeof info.symbols === 'number' ? `, ${info.symbols} symbols` : '';
    line = `kopt: index${at}${n}. ${advice}`;
    if (throttle(join(config.dataDir, '.refresh-spawned'), REFRESH_THROTTLE_MS)) (await import('./spawn.js')).spawnKopt(['index', '--refresh', '--if-idle'], config.root);
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
  // Local retention only (one directory listing). Kiro credits are collected on demand by kopt stats / kopt credits.
  pruneTelemetry(config);
  return { exitCode: 0 };
}

export const DUPLICATE_WINDOW_MS = 2000;

/** Stable JSON (sorted keys) for hashing payloads. */
function stableJson(x: unknown, depth = 0): string {
  if (depth > 6 || x === null || typeof x !== 'object') return JSON.stringify(x) ?? 'null';
  if (Array.isArray(x)) return `[${x.map((v) => stableJson(v, depth + 1)).join(',')}]`;
  return `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${stableJson((x as Record<string, unknown>)[k], depth + 1)}`).join(',')}}`;
}

/**
 * Identity of an event for de-duplication: session + event + tool + input. A prompt is identified by its text alone:
 * IDE 0.x legacy prompt hooks (still run by IDE 1.x in workspaces that have them) carry no session id.
 */
export function eventKey(event: HookEvent, name: string): string {
  if (name === 'UserPromptSubmit') return createHash('sha1').update(`prompt|${promptText(event)}`).digest('hex').slice(0, 16);
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
  const file = name === 'UserPromptSubmit'
    ? join(sessionsDir(config.userDir), '_prompts.recent.json')
    : sessionFile(config.userDir, sessionIdOf(event)).replace(/\.json$/, '.recent.json');
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
    if (event._kopt_source === 'legacy' && !event.session_id && !(event as { sessionId?: unknown }).sessionId && !process.env.KIRO_SESSION_ID) {
      event.session_id = legacySessionId(config);
    }
    if (isDuplicate(event, name, config)) return { exitCode: 0 };
    switch (name) {
      case 'PreToolUse': return preToolUse(event, config);
      case 'PostToolUse': return postToolUse(event, config);
      case 'UserPromptSubmit': return await userPromptSubmit(event, config);
      case 'SessionStart': return await sessionStart(event, config);
      case 'PostFileSave':
      case 'PostFileCreate':
      case 'PostFileDelete': return fileEvent(event, config);
      case 'Stop': return { ...(await stop(event, config)), exitCode: 0 }; // exit 1 would mean "continue the agent" in IDE 1.x
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
    config = loadConfig(process.env.KOPT_ROOT || findProjectRoot(cwd), { onWarning: hookWarningSink() });
    const out = await handleHook(event, config);
    if (out.stdout) await writeOut(process.stdout, out.stdout);
    if (out.stderr) await writeOut(process.stderr, out.stderr.endsWith('\n') ? out.stderr : out.stderr + '\n');
    return out.exitCode;
  } catch (err) {
    logHookError(config, err, event);
    return 0;
  }
}

/**
 * Where a hook's warnings go (an invalid config file, for example): <userDir>/hook-errors.log, never stdout/stderr,
 * because any output on the allow path intercepts the tool call in Kiro.
 */
export function hookWarningSink(): (message: string) => void {
  return (message) => logHookError(undefined, message);
}

/** Internals exposed for tests. */
export const _internal = { bigFile, sessionIdOf, displayPath };
