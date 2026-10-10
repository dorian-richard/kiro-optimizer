#!/usr/bin/env node
// Simulator of kiro-cli 2.28 (kiro-cli-chat) for testing `kopt bench ab` without a Kiro account. No dependencies.
// Emulates: --version, whoami [--format json], agent validate --path, agent list, mcp list, settings,
// chat --list-models --format json, and chat --no-interactive --output-format stream-json with the V2 and V3 stream
// formats reconstructed from the 2.28 binary (see bench/ab/README.md), session files (V2 <KIRO_HOME>/sessions/cli,
// V3 <HOME>/.kiro/sessions/<bucket>/sess_<id>), real hook execution (agent hooks, .kiro/hooks) and real MCP calls
// (it starts the MCP servers of the agent the way Kiro does, with a reduced environment, and calls kopt_find).
//
// It is a test double: answers are built from a grep of the workspace, credits from a formula. Nothing leaves the
// machine.
//
// Environment:
//   FAKE_KIRO_AUTH=builder-id|api-key|none   login state (default builder-id; api-key = logged in only with KIRO_API_KEY)
//   FAKE_KIRO_STATE_DIR=<dir>                calls.jsonl log, chat call counter, running markers
//   FAKE_KIRO_MODE=<m1,m2>                   failure modes for every chat run:
//        not-logged-in hang slow no-stream-credits no-session no-credits zero-credits quota malformed bad-model
//        mcp-fail deny-kopt fail-kopt crash dirty commit suspended
//        (suspended: the account was blocked by Kiro's anti-abuse checks; the stream, exit code and session file
//        are the ones a real kiro-cli 2.28 wrote for such an account, V2)
//   FAKE_KIRO_MODE_AT=<n>:<mode>[;...]       modes for the n-th chat run only (1-based, needs FAKE_KIRO_STATE_DIR)
//   FAKE_KIRO_MODE_FOR=<agent>:<mode>[;...]  modes for runs of one agent
//   FAKE_KIRO_DELAY_MS=<ms>                  duration of the "slow" mode (default 3000)
//   FAKE_KIRO_CREDITS=<n>                    base credits of a run (default 1.0)
//   FAKE_KIRO_KOPT_FACTOR=<f>                credit factor when kopt tools were used (default 0.7)
//   FAKE_KIRO_MODELS=<id:mult,...>           model list (default auto:1,claude-sonnet-4.5:1.3,qwen3-coder-next:0.05)
//   FAKE_KIRO_VERSION=<v>                    version string (default 2.28.0)
//   FAKE_KIRO_LOGOUT_AFTER=<n>               logged out once n chat runs happened (needs FAKE_KIRO_STATE_DIR)
//   FAKE_KIRO_USE_KOPT=0                     never call kopt tools, even when they are available
//   FAKE_KIRO_REQUEST_MS=<ms>                pause after each metered request (default 0), so a reader can react
//   FAKE_KIRO_VERSION_AFTER=<n>:<version>    --version reports <version> once n chat runs happened (an update)
// Tools the run is not trusted for (--trust-tools, the agent's allowedTools / permission rules, --trust-all-tools;
// read-only built-ins are trusted by default) are refused the way the 2.28 launcher does in a --no-interactive run.

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';

const argv = process.argv.slice(2);
const env = process.env;
const STATE = env.FAKE_KIRO_STATE_DIR;
const VERSION = env.FAKE_KIRO_VERSION || '2.28.0';
const userHome = () => (process.platform === 'win32' ? env.USERPROFILE : env.HOME) || homedir();
const kiroHome = () => env.KIRO_HOME || join(userHome(), '.kiro');

function logCall(extra = {}) {
  if (!STATE) return;
  mkdirSync(STATE, { recursive: true });
  const pick = (k) => (env[k] === undefined ? undefined : env[k]);
  appendFileSync(
    join(STATE, 'calls.jsonl'),
    JSON.stringify({
      ts: Date.now(),
      pid: process.pid,
      argv,
      cwd: process.cwd(),
      env: { HOME: pick('HOME'), USERPROFILE: pick('USERPROFILE'), KIRO_HOME: pick('KIRO_HOME'), KOPT_HOME: pick('KOPT_HOME'), KOPT_CACHE_DIR: pick('KOPT_CACHE_DIR'), KOPT_DATA_DIR: pick('KOPT_DATA_DIR'), KOPT_TELEMETRY: pick('KOPT_TELEMETRY'), KIRO_NO_AUTO_UPDATE: pick('KIRO_NO_AUTO_UPDATE'), KIRO_API_KEY: env.KIRO_API_KEY ? 'set' : undefined },
      ...extra,
    }) + '\n',
  );
}

const out = (s) => process.stdout.write(s);
const err = (s) => process.stderr.write(s);

function chatCount() {
  if (!STATE) return 0;
  const p = join(STATE, 'chat-counter');
  return Number(existsSync(p) ? readFileSync(p, 'utf8') : '0') || 0;
}

function loggedIn() {
  // the login "expires" after N chat runs
  if (env.FAKE_KIRO_LOGOUT_AFTER && chatCount() >= Number(env.FAKE_KIRO_LOGOUT_AFTER)) return undefined;
  const auth = env.FAKE_KIRO_AUTH || 'builder-id';
  if (env.KIRO_API_KEY && env.KIRO_API_KEY.trim()) return 'api-key';
  if (auth === 'builder-id') return 'builder-id';
  return undefined;
}

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''));
  } catch {
    return undefined;
  }
}

function flag(name) {
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}

// ---------------------------------------------------------------------------------------------------------
// agents

const V2_TRIGGERS = new Set(['agentSpawn', 'userPromptSubmit', 'preToolUse', 'postToolUse', 'stop']);

/** Problems the 2.28 validator reports (it prints them on stderr and exits 0). */
function validateAgent(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    return `Error: failed to read ${path}: ${e.message}`;
  }
  let a;
  try {
    a = JSON.parse(text);
  } catch (e) {
    return `Error: Json supplied at ${path} is invalid: ${e.message}`;
  }
  const bad = (why) => `Error: Json supplied at ${path} is invalid: ${why}`;
  if (a.tools !== undefined && !Array.isArray(a.tools)) return bad(`invalid type: string ${JSON.stringify(a.tools)}, expected a sequence at line 1 column 34`);
  if (a.allowedTools !== undefined && !Array.isArray(a.allowedTools)) return bad('invalid type: expected a sequence');
  if (a.hooks !== undefined && !Array.isArray(a.hooks)) {
    if (!a.hooks || typeof a.hooks !== 'object') return bad('data did not match any variant of untagged enum Repr');
    for (const [k, v] of Object.entries(a.hooks)) {
      if (!V2_TRIGGERS.has(k) || !Array.isArray(v)) return bad('data did not match any variant of untagged enum Repr at line 1 column 94');
      for (const h of v) if (!h || typeof h.command !== 'string') return bad('missing field `command`');
    }
  }
  if (a.mcpServers !== undefined && (typeof a.mcpServers !== 'object' || Array.isArray(a.mcpServers))) return bad('invalid type: expected a map');
  return undefined;
}

function agentDirs(engine) {
  const dirs = [join(process.cwd(), '.kiro', 'agents')];
  // V3 reads the OS home's ~/.kiro whatever KIRO_HOME says (2.28 engine source); V2 honours KIRO_HOME
  dirs.push(engine === 'v3' ? join(userHome(), '.kiro', 'agents') : join(kiroHome(), 'agents'));
  return dirs;
}

function listAgents(engine = 'v2') {
  const out = new Map();
  for (const d of agentDirs(engine).reverse()) {
    if (!existsSync(d)) continue;
    for (const n of readdirSync(d)) {
      if (!n.endsWith('.json')) continue;
      const a = readJson(join(d, n));
      if (a && !validateAgent(join(d, n))) out.set(a.name || n.replace(/\.json$/, ''), { ...a, _path: join(d, n), _scope: d.startsWith(process.cwd()) ? 'Workspace' : 'Global' });
    }
  }
  return out;
}

function mcpJson(path) {
  const j = readJson(path);
  return j && j.mcpServers && typeof j.mcpServers === 'object' ? j.mcpServers : {};
}

function agentServers(agent, engine) {
  const globalDir = engine === 'v3' ? join(userHome(), '.kiro') : kiroHome();
  const servers = {};
  if (!agent) {
    Object.assign(servers, mcpJson(join(globalDir, 'settings', 'mcp.json')), mcpJson(join(process.cwd(), '.kiro', 'settings', 'mcp.json')));
    return servers;
  }
  if (agent.includeMcpJson) Object.assign(servers, mcpJson(join(globalDir, 'settings', 'mcp.json')), mcpJson(join(process.cwd(), '.kiro', 'settings', 'mcp.json')));
  Object.assign(servers, agent.mcpServers || {});
  return servers;
}

// ---------------------------------------------------------------------------------------------------------
// commands other than chat

function cmdWhoami() {
  const who = loggedIn();
  const json = flag('--format') === 'json' || flag('-f') === 'json';
  if (!who) {
    out(json ? '{"account":null}\n' : 'Not logged in\n');
    return 1;
  }
  if (json) out(JSON.stringify({ account: who === 'api-key' ? { type: 'api-key' } : { type: 'builder-id', email: 'sim-user@example.invalid' } }) + '\n');
  else out(who === 'api-key' ? 'Authenticated with API key\n' : 'Logged in with Builder ID\nEmail: sim-user@example.invalid\n');
  return 0;
}

function cmdAgent() {
  const sub = argv[1];
  if (sub === 'validate') {
    const p = flag('--path') || flag('-p');
    if (!p) {
      err('error: the following required arguments were not provided:\n  --path <PATH>\n');
      return 2;
    }
    const problem = validateAgent(resolve(p));
    if (problem) err(`\x1b[38;5;9mError: \x1b[0m${problem.replace(/^Error: /, '')}\n`);
    return 0;
  }
  if (sub === 'list') {
    const lines = ['Workspace: ' + join(process.cwd(), '.kiro', 'agents'), 'Global:    ' + join(kiroHome(), 'agents'), '', '* kiro_default    (Built-in)    Default agent'];
    for (const [name, a] of listAgents()) lines.push(`  ${name.padEnd(15)} ${a._scope.padEnd(13)} ${a.description || ''}`);
    err(lines.join('\n') + '\n');
    return 0;
  }
  err(`error: unsupported agent subcommand ${sub}\n`);
  return 2;
}

function cmdMcp() {
  if (argv[1] !== 'list') {
    err('error: only `mcp list` is simulated\n');
    return 2;
  }
  const lines = ['', '🤖 default:', '', '  kiro_default'];
  const def = agentServers(undefined, 'v2');
  if (!Object.keys(def).length) lines.push('    (empty)');
  for (const [n, s] of Object.entries(def)) lines.push(`    • ${n.padEnd(12)} ${s.command}`);
  lines.push('', '📄 workspace:', '');
  for (const [name, a] of listAgents()) {
    lines.push(`  ${name}`);
    const servers = agentServers(a, 'v2');
    if (!Object.keys(servers).length) lines.push('    (empty)');
    for (const [n, s] of Object.entries(servers)) lines.push(`    • ${n.padEnd(12)} ${s.command}${a.mcpServers && a.mcpServers[n] ? '' : ' [legacy]'}`);
  }
  err(lines.join('\n') + '\n\n');
  return 0;
}

function cmdSettings() {
  const p = join(kiroHome(), 'settings', 'cli.json');
  const cur = readJson(p) || {};
  const args = argv.slice(1).filter((a) => !a.startsWith('-'));
  if (args[0] === 'list') {
    out(JSON.stringify(cur, null, 2) + '\n');
    return 0;
  }
  if (args.length === 1) {
    if (!(args[0] in cur)) {
      err(`error: No value associated with ${args[0]}\n`);
      return 1;
    }
    out(`${JSON.stringify(cur[args[0]])} (global)\n`);
    return 0;
  }
  if (args.length === 2) {
    cur[args[0]] = args[1];
    mkdirSync(join(kiroHome(), 'settings'), { recursive: true });
    writeFileSync(p, JSON.stringify(cur, null, 2) + '\n');
    return 0;
  }
  err('error: usage: settings <key> [value] | settings list\n');
  return 2;
}

function models() {
  return (env.FAKE_KIRO_MODELS || 'auto:1,claude-sonnet-4.5:1.3,qwen3-coder-next:0.05').split(',').map((x) => {
    const [id, m] = x.split(':');
    return { modelId: id, modelName: id, rateMultiplier: Number(m || 1) };
  });
}

// ---------------------------------------------------------------------------------------------------------
// chat

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function chatCounter() {
  if (!STATE) return 1;
  mkdirSync(STATE, { recursive: true });
  const p = join(STATE, 'chat-counter');
  const n = (Number(existsSync(p) ? readFileSync(p, 'utf8') : '0') || 0) + 1;
  writeFileSync(p, String(n));
  return n;
}

function modesFor(n, agent) {
  const modes = new Set((env.FAKE_KIRO_MODE || '').split(',').map((s) => s.trim()).filter(Boolean));
  for (const part of (env.FAKE_KIRO_MODE_AT || '').split(';')) {
    const [k, m] = part.split(':');
    if (Number(k) === n && m) for (const x of m.split(',')) modes.add(x.trim());
  }
  for (const part of (env.FAKE_KIRO_MODE_FOR || '').split(';')) {
    const [a, m] = part.split(':');
    if (a === agent && m) for (const x of m.split(',')) modes.add(x.trim());
  }
  return modes;
}

/** Kiro starts MCP servers with the MCP SDK's default environment plus the entry's env (not its own environment). */
function mcpEnv(entryEnv) {
  const keys = process.platform === 'win32'
    ? ['APPDATA', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'PATH', 'PROCESSOR_ARCHITECTURE', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERNAME', 'USERPROFILE', 'PROGRAMFILES']
    : ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER'];
  const e = {};
  for (const k of keys) {
    const real = Object.keys(env).find((x) => x.toUpperCase() === k);
    if (real && env[real] !== undefined) e[k] = env[real];
  }
  return { ...e, ...(entryEnv || {}) };
}

class McpClient {
  constructor(name, entry) {
    this.name = name;
    this.entry = entry;
    this.buf = '';
    this.pending = new Map();
    this.id = 0;
    this.stderr = '';
  }
  start(timeoutMs = 20000) {
    return new Promise((resolveStart, rejectStart) => {
      try {
        this.child = spawn(this.entry.command, this.entry.args || [], { cwd: process.cwd(), env: mcpEnv(this.entry.env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } catch (e) {
        return rejectStart(e);
      }
      this.child.on('error', (e) => rejectStart(e));
      this.child.stderr.on('data', (c) => (this.stderr += c));
      this.child.stdout.on('data', (c) => {
        this.buf += c;
        let i;
        while ((i = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, i).trim();
          this.buf = this.buf.slice(i + 1);
          if (!line) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message || 'MCP error'));
            else p.resolve(msg.result);
          } else if (msg.id !== undefined && msg.method) {
            // server -> client request (roots/list...): answer empty
            this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: msg.method === 'roots/list' ? { roots: [] } : {} }) + '\n');
          }
        }
      });
      this.child.on('exit', (code) => {
        for (const p of this.pending.values()) p.reject(new Error(`MCP server exited (${code}): ${this.stderr.trim().slice(-300)}`));
        this.pending.clear();
      });
      const timer = setTimeout(() => rejectStart(new Error(`MCP server ${this.name} did not initialize within ${timeoutMs} ms`)), timeoutMs);
      this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-kiro-cli', version: VERSION } })
        .then(() => {
          this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
          return this.request('tools/list', {});
        })
        .then((r) => {
          clearTimeout(timer);
          this.tools = (r && r.tools ? r.tools : []).map((t) => t.name);
          resolveStart(this.tools);
        })
        .catch((e) => {
          clearTimeout(timer);
          rejectStart(e);
        });
    });
  }
  request(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async call(tool, args, timeoutMs = 30000) {
    let timer;
    const timeout = new Promise((res) => (timer = setTimeout(() => res({ isError: true, content: [{ type: 'text', text: 'timeout' }] }), timeoutMs)));
    const r = await Promise.race([this.request('tools/call', { name: tool, arguments: args }), timeout]);
    clearTimeout(timer);
    return (r && r.content ? r.content : []).map((c) => c.text || '').join('\n');
  }
  stop() {
    try {
      this.child.stdin.end();
      this.child.kill();
    } catch {
      // gone
    }
  }
}

function runHook(command, payload, timeoutMs = 10000) {
  return new Promise((res) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(command, { shell: true, cwd: process.cwd(), env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      return res({ code: null, stdout, stderr: e.message });
    }
    const timer = setTimeout(() => {
      child.kill();
      res({ code: null, stdout, stderr: 'timeout' });
    }, timeoutMs);
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', () => {});
    child.on('close', (code) => {
      clearTimeout(timer);
      res({ code, stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

const V3_TRIGGER = { agentSpawn: 'SessionStart', userPromptSubmit: 'UserPromptSubmit', preToolUse: 'PreToolUse', postToolUse: 'PostToolUse', stop: 'Stop' };

/** Hooks of the run: {event -> [command]} with event names of the engine. */
function collectHooks(agent, engine) {
  const hooks = {};
  const add = (ev, cmd, timeoutMs) => (hooks[ev] ||= []).push({ cmd, timeoutMs });
  const fromMap = (map, toV3) => {
    for (const [k, list] of Object.entries(map || {})) {
      for (const h of list || []) add(toV3 ? V3_TRIGGER[k] || k : k, h.command, h.timeout_ms || 10000);
    }
  };
  if (engine === 'v2') {
    fromMap(agent && !Array.isArray(agent.hooks) ? agent.hooks : {}, false);
    return hooks;
  }
  if (agent && agent.hooks && !Array.isArray(agent.hooks)) fromMap(agent.hooks, true);
  for (const dir of [join(process.cwd(), '.kiro', 'hooks'), join(userHome(), '.kiro', 'hooks')]) {
    if (!existsSync(dir)) continue;
    for (const n of readdirSync(dir)) {
      if (!n.endsWith('.json')) continue;
      const f = readJson(join(dir, n));
      for (const h of (f && f.hooks) || []) if (h.action && h.action.type === 'command') add(h.trigger, h.action.command, (h.timeout || 10) * 1000);
    }
  }
  return hooks;
}

function walkFiles(dir, out = [], depth = 0) {
  if (depth > 8 || out.length > 400) return out;
  for (const n of readdirSync(dir)) {
    if (n === '.git' || n === 'node_modules' || n === '.kiro' || n === '.kopt') continue;
    const p = join(dir, n);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkFiles(p, out, depth + 1);
    else if (st.size < 512 * 1024) out.push(p);
  }
  return out;
}

/** "Model": grep the workspace for the identifiers of the prompt. */
function exploreWorkspace(prompt) {
  const words = [...new Set((prompt.match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) || []).filter((w) => /[a-z][A-Z]|_|^[A-Z][a-z]+[A-Z]/.test(w) || w.length > 7))].slice(0, 8);
  const hits = [];
  for (const f of walkFiles(process.cwd())) {
    let text;
    try {
      text = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const w of words) if (new RegExp(`\\b${w}\\b`).test(text)) hits.push({ word: w, file: relative(process.cwd(), f).replace(/\\/g, '/') });
  }
  return { words, hits };
}

function bucket(cwd) {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 16);
}

async function cmdChat() {
  if (argv.includes('--list-models')) {
    if (!loggedIn()) {
      // what 2.28 did in a logged-out temporary HOME: start a browser login on its own
      err('Opening auth portal and logging in...\nerror: simulator: refusing to log in\n');
      return 1;
    }
    out(JSON.stringify({ models: models(), defaultModel: 'auto' }) + '\n');
    return 0;
  }
  // the login is checked before this run is counted (FAKE_KIRO_LOGOUT_AFTER counts finished chat runs)
  const wasLoggedIn = loggedIn();
  const n = chatCounter();
  const engineFlag = flag('--agent-engine') || (argv.includes('--v3') ? 'v3' : argv.includes('--v2') ? 'v2' : argv.includes('--v1') ? 'v1' : 'v2');
  const engine = engineFlag;
  const agentName = flag('--agent');
  const modes = modesFor(n, agentName);
  const stream = flag('--output-format') === 'stream-json';
  if (!argv.includes('--no-interactive') && !stream) {
    err('error: the simulator only runs --no-interactive sessions\n');
    return 2;
  }
  if (engine === 'v1' && stream) {
    err('error: --output-format stream-json is not supported on the v1 engine. Pass --agent-engine v2 (or v3).\n');
    return 1;
  }
  if (!wasLoggedIn || modes.has('not-logged-in')) {
    err('error: Not logged in. Set the KIRO_API_KEY environment variable or run `kiro-cli login` first.\n');
    return 1;
  }
  // positional prompt = last argument that is not a flag value
  const valueFlags = new Set(['--agent-engine', '--agent', '--model', '--effort', '--output-format', '--resume-id', '--mode', '-w', '--wrap', '-f', '--format']);
  let prompt;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (valueFlags.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith('-')) continue;
    prompt = a;
  }
  if (!prompt || !prompt.trim()) {
    err('error: Input must be supplied when running in non-interactive mode\n');
    return 1;
  }
  let agent;
  if (agentName && agentName !== 'kiro_default') {
    agent = listAgents(engine).get(agentName);
    if (!agent) {
      err(`error: agent '${agentName}' not found\n`);
      return 4;
    }
  }
  if (STATE) writeFileSync(join(STATE, `running-${process.pid}`), String(n));
  try {
    return await chatRun({ n, engine, agent, agentName: agentName || 'kiro_default', modes, prompt });
  } finally {
    if (STATE) rmSync(join(STATE, `running-${process.pid}`), { force: true });
  }
}

/**
 * A request from an account Kiro's anti-abuse checks suspended, as recorded with the real kiro-cli 2.28 (V2 engine):
 * this stream on stdout (records wrapped in `data`), nothing on stderr, exit 1, a session file without metering.
 */
function suspendedRun({ sessionId, engine, agentName, emit, flush, lines }) {
  lines.length = 0;
  const reasoning = { support: 'unavailable', effortLevels: [] };
  emit({ type: 'runStarted', data: { payloadSchema: 'acp', acpProtocolVersion: 1, engine } });
  emit({ type: 'metadata', data: { sessionId, contextUsagePercentage: 3.588, reasoning } });
  emit({ type: 'metadata', data: { sessionId, contextUsagePercentage: 0.519, reasoning } });
  emit({ type: 'metadata', data: { sessionId, turnDurationMs: 399, reasoning } });
  emit({
    type: 'runError',
    data: {
      sessionId,
      stage: 'prompt',
      message:
        'Internal error (code -32603): Encountered an error in the response stream: Your User ID is temporarily suspended. We detected unusual user activity and locked it as a security precaution. ' +
        'To restore access, please contact our support team to verify your identity: https://support.aws.amazon.com/#/contacts/kiro (request_id: 00000000-0000-4000-8000-000000000000)',
    },
  });
  flush();
  if (engine === 'v2') {
    const dir = join(kiroHome(), 'sessions', 'cli');
    mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(
      join(dir, `${sessionId}.json`),
      JSON.stringify({
        session_id: sessionId,
        cwd: process.cwd(),
        created_at: now,
        updated_at: now,
        title: null,
        session_created_reason: 'subagent',
        session_state: { version: 'v1', conversation_metadata: { user_turn_metadatas: [], last_context_usage: null, user_turn_start_request: null, last_request: null }, agent_name: agentName },
      }, null, 2),
    );
    writeFileSync(join(dir, `${sessionId}.jsonl`), '');
  }
  return 1;
}

/** Tools trusted for this run: --trust-all-tools, --trust-tools, the agent's allowedTools (V2) or permission rules (V3). */
function trustOf(agent, engine) {
  const list = (flag('--trust-tools') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const all = argv.includes('--trust-all-tools') || argv.includes('-a');
  return (tool) => {
    if (all) return true;
    // read-only built-ins are trusted in the working directory by default (Kiro docs)
    if (tool.builtinRead) return true;
    if (list.includes(tool.trustName) || list.includes(tool.tag)) return true;
    if (engine === 'v2') return !!(agent && Array.isArray(agent.allowedTools) && agent.allowedTools.includes(tool.trustName));
    const rules = (agent && agent.permissions && agent.permissions.rules) || [];
    return rules.some((r) => r.effect === 'allow' && (r.capability === tool.tag || (r.capability === 'mcp' && Array.isArray(r.match) && r.match.includes(tool.mcpMatch))));
  };
}

async function chatRun({ n, engine, agent, agentName, modes, prompt }) {
  const sessionId = engine === 'v3' ? `sess_${randomUUID()}` : randomUUID();
  const lines = [];
  const emit = (o) => lines.push(JSON.stringify(o));
  const update = (u) => emit({ type: 'sessionUpdate', sessionId, update: u });
  const info = (kiro) => update({ sessionUpdate: 'session_info_update', _meta: { kiro } });
  const flush = () => {
    if (lines.length) out(lines.splice(0).join('\n') + '\n');
  };
  // like kiro-cli, keep going when the reader of stdout is gone (a killed harness): only the stream is lost
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});
  emit({ type: 'runStarted', payloadSchema: 'acp', acpProtocolVersion: 1, sessionId });
  if (modes.has('suspended')) return suspendedRun({ sessionId, engine, agentName, emit, flush, lines });

  // model
  const model = flag('--model') || 'auto';
  const known = models().some((m) => m.modelId === model) && !modes.has('bad-model');
  if (!known) {
    if (engine === 'v3') err(`[warn] failed to set model '${model}': InvalidModelId; continuing with the default model\n`);
    else {
      emit({ type: 'runError', sessionId, stage: 'new_session', message: `ValidationException: InvalidModelId: ${model}` });
      flush();
      err(`error: InvalidModelId: ${model}\n`);
      return 1;
    }
  }

  // MCP servers: every enabled server of the agent's configuration starts (--require-mcp-startup requires all of
  // them), whatever the agent's `tools` make visible
  const servers = agentServers(agent, engine);
  const tools = (agent && agent.tools) || ['*'];
  const clients = [];
  for (const [name, entry] of Object.entries(servers)) {
    if (!entry || entry.disabled) continue;
    const c = new McpClient(name, entry);
    try {
      if (modes.has('mcp-fail')) throw new Error('simulated MCP startup failure');
      await c.start();
      c.visible = tools.includes('*') || tools.includes('@mcp') || tools.includes(`@${name}`) || tools.some((t) => t.startsWith(`@${name}/`));
      clients.push(c);
    } catch (e) {
      c.stop();
      if (argv.includes('--require-mcp-startup')) {
        flush();
        err(`error: MCP server '${name}' failed to start: ${e.message}\n`);
        for (const x of clients) x.stop();
        return 3;
      }
      err(`[warn] MCP server '${name}' failed to start: ${e.message}\n`);
    }
  }
  const kopt = clients.find((c) => c.visible && c.tools && c.tools.includes('kopt_find'));

  const hooks = collectHooks(agent, engine);
  const ev = (v2, v3) => (engine === 'v2' ? v2 : v3);
  const fire = async (event, payload) => {
    const res = [];
    for (const h of hooks[event] || []) res.push(await runHook(h.cmd, { hook_event_name: event, session_id: sessionId, cwd: process.cwd(), ...payload }, h.timeoutMs));
    return res;
  };

  await fire(ev('agentSpawn', 'SessionStart'), {});
  await fire(ev('userPromptSubmit', 'UserPromptSubmit'), { prompt });
  info({ kind: 'turn_start', turnStart: true });

  // the "model" acts on the workspace (failure modes that change files or commit)
  if (modes.has('dirty') || modes.has('commit')) mutateWorkspace(modes);

  const smoke = /reply with the single word OK/i.test(prompt);
  const trusted = trustOf(agent, engine);
  const usedTools = [];
  let toolCount = 0;

  // credits: decided up front, metered per request as the run goes (V2 streams one _kiro.dev/metadata per request)
  const hash = createHash('sha1').update(`${prompt}|${n}|${agentName}`).digest();
  const jitter = 1 + ((hash[0] / 255) - 0.5) / 10;
  const base = Number(env.FAKE_KIRO_CREDITS || '1');
  const quota = modes.has('quota');
  const zero = modes.has('zero-credits');
  const noStreamCredits = modes.has('no-stream-credits') || modes.has('no-credits') || quota;
  const noSession = modes.has('no-session') || modes.has('no-credits') || quota;
  const requestMs = Number(env.FAKE_KIRO_REQUEST_MS || '0');
  const per = [];
  const requestIds = [];
  let plannedTotal = 0;
  let plannedRequests = 1;
  const meter = async (last) => {
    const i = per.length;
    const spent = per.reduce((a, b) => a + b, 0);
    let v = last ? Math.max(0, plannedTotal - spent) : plannedTotal / plannedRequests;
    v = zero ? 0 : Math.round(v * 10000) / 10000;
    per.push(v);
    requestIds.push(`req-${n}-${i + 1}`);
    if (!noStreamCredits && engine === 'v2') {
      emit({ type: 'extNotification', method: '_kiro.dev/metadata', params: { sessionId, requestId: requestIds[i], contextUsagePercentage: 3 + i, meteringUsage: [{ value: v, unit: 'credit', unitPlural: 'credits' }], turnDurationMs: 400 } });
    }
    flush();
    if (requestMs && !last) await sleep(requestMs);
  };

  const toolCall = async (t, input, exec) => {
    toolCount++;
    const id = `tooluse_${toolCount}`;
    update({ sessionUpdate: 'tool_call', toolCallId: id, title: t.title, kind: t.kind, status: 'pending', rawInput: input });
    const deny = () => {
      // what the 2.28 launcher does in a --no-interactive run: refuse, print [denied], fail the call
      err('[denied] tool permission approval is not supported in non-interactive mode. Use --trust-all-tools to auto-approve.\n');
      update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'failed', _meta: { kiro: { toolCallFailureReason: 'permission_denied' } } });
      return '';
    };
    if (!trusted(t) || (modes.has('deny-kopt') && t.kopt)) return deny();
    const pre = await fire(ev('preToolUse', 'PreToolUse'), { tool_name: t.hookName, tool_input: input });
    if (pre.some((r) => r.code === 2)) {
      update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'Blocked by a preToolUse hook' } }] });
      return '';
    }
    if (modes.has('fail-kopt') && t.kopt) {
      update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'failed', _meta: { kiro: { error: 'MCP error -32000: Connection closed' } } });
      return '';
    }
    const result = await exec();
    usedTools.push(engine === 'v3' ? (t.kopt ? `mcp_kopt_${t.tool}` : t.hookName) : t.hookName);
    update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', rawOutput: { chars: result.length } });
    await fire(ev('postToolUse', 'PostToolUse'), { tool_name: t.hookName, tool_input: input, tool_response: { success: true, result: [result.slice(0, 2000)] } });
    return result;
  };
  const koptTool = (tool) => ({ title: `@kopt/${tool}`, kind: 'other', hookName: engine === 'v3' ? `mcp_kopt_${tool}` : `@kopt/${tool}`, trustName: `@kopt/${tool}`, mcpMatch: `kopt/${tool}`, tag: '@kopt', kopt: true, tool });
  const builtin = (name) =>
    name === 'grep'
      ? { title: engine === 'v3' ? 'Searching for patterns' : 'grep', kind: 'search', hookName: ev('grep', 'grep_search'), trustName: 'grep', tag: 'read', builtinRead: true }
      : { title: engine === 'v3' ? 'Reading a file' : 'fs_read', kind: 'read', hookName: ev('fs_read', 'read_file'), trustName: 'fs_read', tag: 'read', builtinRead: true };

  let answer;
  let koptText = '';
  let explore = { words: [], hits: [] };
  if (smoke) {
    // the smoke prompts ask for exactly one tool call
    plannedTotal = zero ? 0 : Math.round(0.03 * jitter * 10000) / 10000;
    plannedRequests = 2;
    const file = (/"([^"]+)"/.exec(prompt) || [])[1];
    if (/kopt_read/.test(prompt)) {
      const args = { target: file || '.', mode: 'outline', maxTokens: 200 };
      if (kopt) await toolCall(koptTool('kopt_read'), args, () => kopt.call('kopt_read', args));
    } else if (/kopt_outline/.test(prompt)) {
      if (kopt) await toolCall(koptTool('kopt_outline'), { path: file, maxTokens: 200 }, () => kopt.call('kopt_outline', { ...(file ? { path: file } : {}), maxTokens: 200 }));
    } else {
      await toolCall(builtin('fs_read'), { path: file }, async () => {
        try {
          return readFileSync(join(process.cwd(), file || '.'), 'utf8').split('\n').slice(0, 20).join('\n');
        } catch {
          return '';
        }
      });
    }
    if (toolCount) await meter(false);
    answer = 'OK';
  } else {
    explore = exploreWorkspace(prompt);
    const useKopt = kopt && process.env.FAKE_KIRO_USE_KOPT !== '0';
    plannedTotal = Math.round(base * (useKopt && !modes.has('fail-kopt') && !modes.has('deny-kopt') ? Number(env.FAKE_KIRO_KOPT_FACTOR || '0.7') : 1) * jitter * 10000) / 10000;
    plannedRequests = useKopt ? 2 : explore.hits.length ? 3 : 2;
    if (useKopt) {
      koptText = await toolCall(koptTool('kopt_find'), { query: prompt.slice(0, 300) }, () => kopt.call('kopt_find', { query: prompt.slice(0, 300) }));
      await meter(false);
    }
    if (!koptText) {
      await toolCall(builtin('grep'), { pattern: explore.words.join('|') }, async () => explore.hits.map((h) => `${h.file}: ${h.word}`).join('\n'));
      await meter(false);
      const first = explore.hits[0];
      if (first) {
        const text = await toolCall(builtin('fs_read'), { path: first.file }, async () => {
          try {
            return readFileSync(join(process.cwd(), first.file), 'utf8');
          } catch {
            return '';
          }
        });
        await meter(false);
        for (const m of text.matchAll(/^\s*(?:def|class|function|func|fn)\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) explore.hits.push({ word: m[1], file: first.file });
      }
    }
    const seen = new Set();
    const parts = ['Here is what I found in the workspace:'];
    for (const h of explore.hits) {
      const key = `${h.word}@${h.file}`;
      if (seen.has(key)) continue;
      seen.add(key);
      parts.push(`- \`${h.word}\` in \`${h.file}\``);
    }
    if (koptText) parts.push('', 'From kopt:', ...koptText.split('\n').slice(0, 12));
    if (parts.length === 1) parts.push('Nothing relevant was found.');
    answer = parts.join('\n');
  }
  for (const c of clients) c.stop();
  info({ kind: 'context_usage', contextUsage: { usagePercentage: 3 + toolCount * 2.5 }, usagePercentage: 3 + toolCount * 2.5 });

  // the final request writes the answer
  if (quota) {
    info({ kind: 'display_error', displayError: { message: 'Request quota exceeded. Please wait a moment and try again. MonthlyLimitReached', errorType: 'MonthlyLimitReached' } });
  } else {
    await meter(true);
  }
  for (const piece of answer.match(/[\s\S]{1,80}/g) || []) update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: piece } });
  const total = Math.round(per.reduce((a, b) => a + b, 0) * 10000) / 10000;
  if (!quota && !noStreamCredits && engine === 'v3') {
    info({ kind: 'turn_completion', promptTurnSummaries: [{ unit: 'credit', unitPlural: 'credits', usage: total, usedTools: [...new Set(usedTools)] }], elapsedTime: 1200 + toolCount * 300, status: 'success', requestIds });
  }
  info({ kind: 'turn_end', turnEnd: { stopReason: quota ? 'error' : 'end_turn' } });
  if (modes.has('malformed')) {
    lines.splice(0, 0, 'this is not json', '{"type":"sessionUpdate","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"te');
  }

  if (modes.has('slow')) {
    flush();
    await sleep(Number(env.FAKE_KIRO_DELAY_MS || '3000'));
  }
  if (modes.has('hang')) {
    flush();
    await sleep(3600_000);
  }
  if (modes.has('crash')) {
    flush();
    err('thread main panicked at crates/chat-cli/src/launch.rs: simulated crash\n');
    return 101;
  }
  await fire(ev('stop', 'Stop'), engine === 'v2' ? { assistant_response: answer } : {});
  if (quota) {
    emit({ type: 'runError', sessionId, stage: 'prompt', message: 'MonthlyLimitReached: you have reached the limit of your plan. The limits reset on the 1st.' });
    flush();
    err('error: Request quota exceeded\n');
    return 1;
  }
  emit({ type: 'runFinished', sessionId, finalText: answer, finalTextTruncated: false, stopReason: 'end_turn' });
  flush();

  // session files
  const requests = per.length;
  if (!noSession) {
    const now = new Date().toISOString();
    if (engine === 'v2') {
      const dir = join(kiroHome(), 'sessions', 'cli');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${sessionId}.json`),
        JSON.stringify({
          agent_name: agentName,
          created_at: now,
          updated_at: now,
          session_state: {
            version: 'v1',
            conversation_metadata: {
              user_turn_metadatas: [
                {
                  loop_id: 'l1',
                  total_request_count: requests,
                  builtin_tool_uses: koptText ? 0 : toolCount,
                  turn_duration: { secs: 2, nanos: 0 },
                  end_reason: 'UserTurnEnd',
                  input_token_count: 0,
                  output_token_count: 0,
                  final_context_usage_percentage: 3 + toolCount * 2.5,
                  metering_usage: per.map((v) => ({ value: v, unit: 'credit', unit_plural: 'credits' })),
                },
              ],
            },
          },
        }),
      );
      writeFileSync(join(dir, `${sessionId}.jsonl`), JSON.stringify({ kind: 'UserMessage', text: prompt.slice(0, 200) }) + '\n');
    } else {
      const dir = join(userHome(), '.kiro', 'sessions', bucket(process.cwd()), sessionId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'session.json'), JSON.stringify({ id: sessionId, workspacePaths: [process.cwd()], title: prompt.slice(0, 40), status: 'idle' }));
      const recs = [
        { id: `${sessionId}-u`, timestamp: now, payload: { type: 'user', content: [{ type: 'text', text: prompt }] } },
        ...usedTools.map((t, i) => ({ id: `tc-${i}`, timestamp: now, payload: { type: 'tool_call', toolCallId: `tooluse_${i + 1}`, name: t } })),
        { id: `${sessionId}-a`, timestamp: now, payload: { type: 'assistant', content: [{ type: 'text', text: answer }] } },
        { id: `exec_${n}-usage`, timestamp: now, payload: { type: 'usage_summary', promptTurnSummaries: [{ unit: 'credit', unitPlural: 'credits', usage: total, usedTools: [...new Set(usedTools)] }], elapsedTime: 1500, status: 'success', executionId: `exec_${n}`, requestIds } },
      ];
      writeFileSync(join(dir, 'messages.jsonl'), recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
    }
  }
  return 0;
}

/** Failure modes `dirty` (edit, delete, stage, create files) and `commit` (commit in the worktree), like a shell tool would. */
function mutateWorkspace(modes) {
  const cwd = process.cwd();
  const g = (...a) => spawnSync('git', ['-c', 'core.hooksPath=', ...a], { cwd, stdio: 'ignore' });
  const tracked = (spawnSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8' }).stdout || '').split('\0').filter((f) => f && !f.startsWith('.kiro/') && existsSync(join(cwd, f)));
  if (modes.has('dirty') && tracked.length >= 2) {
    appendFileSync(join(cwd, tracked[0]), '\n# edited by the run\n');
    rmSync(join(cwd, tracked[1]), { force: true });
    writeFileSync(join(cwd, 'staged by run.txt'), 'staged\n');
    g('add', '--', 'staged by run.txt');
    mkdirSync(join(cwd, 'scratch', 'a'), { recursive: true });
    writeFileSync(join(cwd, 'scratch', 'a', 'b.txt'), 'x');
  }
  if (modes.has('commit')) {
    writeFileSync(join(cwd, 'committed by run.txt'), 'c\n');
    g('add', '-A');
    g('-c', 'user.email=sim@example.invalid', '-c', 'user.name=sim', 'commit', '-q', '-m', 'commit by the agent');
  }
}

// ---------------------------------------------------------------------------------------------------------

async function main() {
  const first = argv.find((a) => !a.startsWith('-'));
  if (argv[0] === '--version' || argv[0] === '-V') {
    const [after, v] = (env.FAKE_KIRO_VERSION_AFTER || '').split(':');
    out(`kiro-cli ${after && v && chatCount() >= Number(after) ? v : VERSION}\n`);
    return 0;
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    out('kiro-cli simulator for kopt bench ab tests (bench/ab/fake-kiro-cli.mjs)\n');
    return 0;
  }
  logCall();
  switch (first) {
    case 'whoami':
      return cmdWhoami();
    case 'agent':
      return cmdAgent();
    case 'mcp':
      return cmdMcp();
    case 'settings':
      return cmdSettings();
    case 'chat':
      return cmdChat();
    default:
      err(`error: unrecognized subcommand '${first ?? ''}' (simulator)\n`);
      return 2;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    err(`simulator crashed: ${e && e.stack ? e.stack : e}\n`);
    process.exitCode = 70;
  },
);
