import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { defaultConfig, type KoptConfig } from '../src/core/config.js';
import { canonicalEvent, DUPLICATE_WINDOW_MS, handleHook, isDuplicate, legacyEvent, responseText, type HookEvent } from '../src/hooks/index.js';
import { setFrontloadDeps, FRONTLOAD_HEADER } from '../src/hooks/frontload.js';
import { loadSession, pruneSessions, sessionFile } from '../src/hooks/session.js';
import { setSpawner } from '../src/hooks/spawn.js';
import { classifyTool, readRequests } from '../src/hooks/tools.js';
import { rmTree } from './helpers/fs.js';

let tmp: string;
let kiroHome: string;
const spawned: { argv: string[]; cwd: string }[] = [];
let prevKiroHome: string | undefined;

function makeConfig(name: string, over: (c: KoptConfig) => void = () => {}): KoptConfig {
  const root = join(tmp, name);
  mkdirSync(root, { recursive: true });
  const c = defaultConfig(root);
  c.userDir = join(root, '.user');
  c.dataDir = join(root, '.kopt');
  over(c);
  return c;
}

function installMcp(c: KoptConfig): void {
  mkdirSync(join(c.root, '.kiro', 'settings'), { recursive: true });
  writeFileSync(join(c.root, '.kiro', 'settings', 'mcp.json'), JSON.stringify({ mcpServers: { kopt: { command: 'node', args: [] } } }));
}

function bigFile(c: KoptConfig, rel: string, lines: number): string {
  const abs = join(c.root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, Array.from({ length: lines }, (_, i) => `const line${i} = ${i}; // padding padding`).join('\n') + '\n');
  return abs;
}

const pre = (c: KoptConfig, tool: string, input: unknown, session = 's1'): HookEvent => ({
  hook_event_name: 'PreToolUse', session_id: session, cwd: c.root, tool_name: tool, tool_input: input,
});

function telemetryLines(c: KoptConfig): any[] {
  const dir = join(c.userDir, 'telemetry');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith('.jsonl')).flatMap((n) => readFileSync(join(dir, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'kopt-hooks-'));
  process.env.KOPT_CACHE_DIR = join(tmp, 'cache'); // never the real user cache
  kiroHome = join(tmp, 'kiro-home');
  prevKiroHome = process.env.KOPT_KIRO_HOME;
  process.env.KOPT_KIRO_HOME = kiroHome; // never read the developer's real ~/.kiro
  setSpawner((argv, cwd) => { spawned.push({ argv, cwd }); });
});

afterAll(() => {
  setSpawner(undefined);
  if (prevKiroHome === undefined) delete process.env.KOPT_KIRO_HOME;
  else process.env.KOPT_KIRO_HOME = prevKiroHome;
  rmTree(tmp);
});

beforeEach(() => { spawned.length = 0; });
afterEach(() => { setFrontloadDeps(undefined); });

describe('event names and tool classes', () => {
  it('normalizes IDE PascalCase, CLI camelCase and legacy aliases', () => {
    expect(canonicalEvent('PreToolUse')).toBe('PreToolUse');
    expect(canonicalEvent('preToolUse')).toBe('PreToolUse');
    expect(canonicalEvent('agentSpawn')).toBe('SessionStart');
    expect(canonicalEvent('userPromptSubmit')).toBe('UserPromptSubmit');
    expect(canonicalEvent('fileEdited')).toBe('PostFileSave');
    expect(canonicalEvent('stop')).toBe('Stop');
    expect(canonicalEvent('nonsense')).toBeUndefined();
    expect(canonicalEvent(42)).toBeUndefined();
  });

  it('classifies verified Kiro tool names', () => {
    expect(classifyTool('read_file')).toBe('read');
    expect(classifyTool('fs_read')).toBe('read');
    expect(classifyTool('readFiles')).toBe('read');
    expect(classifyTool('execute_bash')).toBe('shell');
    expect(classifyTool('execute_pwsh')).toBe('shell');
    expect(classifyTool('shell')).toBe('shell');
    expect(classifyTool('str_replace')).toBe('write');
    expect(classifyTool('mcp_kopt_kopt_read')).toBe('kopt');
    expect(classifyTool('@kopt/kopt_run')).toBe('kopt');
    expect(classifyTool('read_code')).toBe('other');
    expect(classifyTool('grep_search')).toBe('other');
  });

  it('extracts whole vs ranged reads for every known input shape', () => {
    expect(readRequests({ path: 'a.ts' }, 800)).toEqual([{ path: 'a.ts', whole: true }]);
    expect(readRequests({ path: 'a.ts', offset: 100, limit: 50 }, 800)[0].whole).toBe(false);
    expect(readRequests({ path: 'a.ts', limit: 5000 }, 800)[0].whole).toBe(true);
    expect(readRequests({ path: 'a.ts', start_line: 1, end_line: -1 }, 800)[0].whole).toBe(true);
    expect(readRequests({ path: 'a.ts', start_line: 10, end_line: 60 }, 800)[0].whole).toBe(false);
    expect(readRequests({ paths: ['a', 'b'] }, 800).map((r) => r.whole)).toEqual([true, true]);
    expect(readRequests({ operations: [{ mode: 'Line', path: '/x/a' }, { mode: 'Directory', path: '/x' }] }, 800)).toEqual([{ path: '/x/a', whole: true }]);
    expect(readRequests({ operations: [{ mode: 'Line', path: '/x/a', start_line: 5, end_line: 20 }] }, 800)[0].whole).toBe(false);
    expect(readRequests(null, 800)).toEqual([]);
  });
});

describe('PreToolUse governor', () => {
  it('allows ordinary calls silently and counts them', async () => {
    const c = makeConfig('allow');
    for (let i = 0; i < 3; i++) {
      const out = await handleHook(pre(c, 'grep_search', { query: 'x' }), c);
      expect(out).toEqual({ exitCode: 0 });
    }
    expect(loadSession(c.userDir, 's1').toolCalls).toBe(3);
  });

  it('enforces the session tool-call budget and re-arms it on the next user prompt', async () => {
    const c = makeConfig('budget', (x) => { x.governor.maxToolCallsPerSession = 3; x.budgets.frontload = 0; });
    for (let i = 0; i < 3; i++) expect((await handleHook(pre(c, 'grep_search', {}), c)).exitCode).toBe(0);
    const blocked = await handleHook(pre(c, 'grep_search', {}), c);
    expect(blocked.exitCode).toBe(2);
    expect(blocked.stderr).toBe('kopt governor: session tool-call budget (3) reached. Stop here: summarize what is done and what remains, and ask the user before continuing.');
    expect(blocked.stdout).toBeUndefined();
    expect((await handleHook(pre(c, 'mcp_kopt_kopt_find', {}), c)).exitCode).toBe(2);
    await handleHook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: c.root, prompt: 'continue' }, c);
    expect((await handleHook(pre(c, 'grep_search', {}), c)).exitCode).toBe(0);
    const s = loadSession(c.userDir, 's1');
    expect(s.blocks.budget).toBe(2);
    expect(telemetryLines(c).filter((e) => e.decision === 'block' && e.meta.reason === 'budget')).toHaveLength(2);
  });

  it('blocks a whole-file read of a big file once, then lets the retry through', async () => {
    const c = makeConfig('bigread', (x) => { x.governor.bigFileLines = 100; });
    bigFile(c, 'src/Big.java', 3412);
    bigFile(c, 'src/small.ts', 50);
    const first = await handleHook(pre(c, 'read_file', { path: 'src/Big.java' }), c);
    expect(first.exitCode).toBe(2);
    expect(first.stderr).toMatch(/^kopt: src\/Big\.java is ~\d+k tokens \(3412 lines\)\. Use kopt_read src\/Big\.java mode=outline or kopt_read src\/Big\.java:<a>-<b>, or read with offset\/limit\.$/);
    expect((await handleHook(pre(c, 'read_file', { path: 'src/Big.java' }), c)).exitCode).toBe(0);
    // ranged reads and small files are never blocked
    expect((await handleHook(pre(c, 'read_file', { path: 'src/Big.java', offset: 10, limit: 40 }, 's2'), c)).exitCode).toBe(0);
    expect((await handleHook(pre(c, 'read_file', { path: 'src/small.ts' }, 's2'), c)).exitCode).toBe(0);
    // CLI 2.x shape with absolute path, other session
    const cli = await handleHook(pre(c, 'fs_read', { operations: [{ mode: 'Line', path: join(c.root, 'src/Big.java') }] }, 's3'), c);
    expect(cli.exitCode).toBe(2);
    expect(loadSession(c.userDir, 's1').blocks['big-read']).toBe(1);
  });

  it('decides big reads by estimated tokens, not lines: many short lines cost less than the block', async () => {
    const c = makeConfig('bigread-tokens');
    // 900 lines but ~8 KB (~2.7k tokens): a block (one more full-context request) would cost more than it saves
    const abs = join(c.root, 'src', 'short.py');
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, Array.from({ length: 900 }, (_, i) => `x${i} = ${i}`).join('\n') + '\n');
    expect((await handleHook(pre(c, 'read_file', { path: 'src/short.py' }), c)).exitCode).toBe(0);
    // 300 long lines, ~45 KB (~15k tokens): blocked although it is far below 800 lines
    const wide = join(c.root, 'src', 'wide.json');
    writeFileSync(wide, Array.from({ length: 300 }, (_, i) => `{"id": ${i}, "payload": "${'x'.repeat(140)}"},`).join('\n') + '\n');
    const r = await handleHook(pre(c, 'read_file', { path: 'src/wide.json' }), c);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/^kopt: src\/wide\.json is ~1\dk tokens \(300 lines\)/);
    // the threshold is configurable; 0 disables the rule
    const off = makeConfig('bigread-off', (x) => { x.governor.bigFileTokens = 0; });
    writeFileSync(join(off.root, 'w.json'), readFileSync(wide));
    expect((await handleHook(pre(off, 'read_file', { path: 'w.json' }), off)).exitCode).toBe(0);
  });

  it('redirects verbose test/build commands to kopt_run once per command when the MCP server is installed', async () => {
    const c = makeConfig('verbose');
    // not installed: no redirect
    expect((await handleHook(pre(c, 'execute_bash', { command: 'mvn -q test' }, 'n1'), c)).exitCode).toBe(0);
    installMcp(c);
    const out = await handleHook(pre(c, 'execute_bash', { command: 'cd api && npm test -- --watch=false', cwd: c.root }), c);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toBe('kopt: use kopt_run with command="npm test -- --watch=false" cwd="api": same execution, returns only failures/errors (full log via kopt_read <handle>).');
    // retry of the same command goes through
    expect((await handleHook(pre(c, 'execute_bash', { command: 'cd api && npm test -- --watch=false', cwd: c.root }), c)).exitCode).toBe(0);
    // non-verbose shell commands are never touched
    expect((await handleHook(pre(c, 'execute_bash', { command: 'git status' }), c)).exitCode).toBe(0);
    // disabled by config
    const c2 = makeConfig('verbose-off', (x) => { x.governor.enforceRunForVerbose = false; x.governor.blockDuplicateRuns = false; });
    installMcp(c2);
    expect((await handleHook(pre(c2, 'execute_bash', { command: 'pytest -x' }), c2)).exitCode).toBe(0);
  });

  it('blocks an identical test re-run when nothing was written since, and unblocks after a write', async () => {
    const c = makeConfig('dup'); // MCP not installed => no redirect, duplicate rule applies directly
    const run = () => handleHook(pre(c, 'execute_bash', { command: 'pytest  tests/test_api.py' }), c);
    expect((await run()).exitCode).toBe(0);
    const dup = await run();
    expect(dup.exitCode).toBe(2);
    expect(dup.stderr).toBe('kopt governor: identical command already ran this session and no file changed since; reuse its result (run it again to override).');
    expect((await run()).exitCode).toBe(0); // insisting is allowed (no deadlock)
    await handleHook({ hook_event_name: 'PostFileSave', session_id: 's1', cwd: c.root, file_path: join(c.root, 'app.py') }, c);
    expect((await run()).exitCode).toBe(0);
    expect((await run()).exitCode).toBe(2);
    // a write observed through PostToolUse (CLI 2.x has no file events) also counts
    await handleHook({ hook_event_name: 'postToolUse', session_id: 's1', cwd: c.root, tool_name: 'fs_write', tool_input: { path: 'app.py' }, tool_response: { success: true } }, c);
    expect((await run()).exitCode).toBe(0);
    expect(loadSession(c.userDir, 's1').blocks['duplicate-run']).toBe(2);
  });

  it('redirects only predictably verbose runs, never quiet, narrowed or long-running commands, at most 3 per session', async () => {
    const c = makeConfig('verbose-only', (x) => { x.governor.blockDuplicateRuns = false; });
    installMcp(c);
    for (const cmd of ['npx tsc --noEmit', 'go vet ./...', 'go build ./...', 'pytest tests/test_api.py', 'mvn -q test -Dtest=OrderTest', 'npm test -- src/a.test.ts',
      'npm run typecheck', 'mvn spring-boot:run', './gradlew bootRun', 'npm run dev', 'npm start', 'npm test -- --watch', 'tsc -w', 'ng serve', 'python manage.py runserver']) {
      expect((await handleHook(pre(c, 'execute_bash', { command: cmd }, 'q1'), c)).exitCode, cmd).toBe(0);
    }
    expect(loadSession(c.userDir, 'q1').blocks['verbose-cmd']).toBeUndefined();
    let blocked = 0;
    for (const cmd of ['mvn test', './gradlew build', 'npm test', 'pytest', 'cargo test']) {
      if ((await handleHook(pre(c, 'execute_bash', { command: cmd }, 'q2'), c)).exitCode === 2) blocked++;
    }
    expect(blocked).toBe(3); // the first redirects taught the model: no more turns spent on it
  });

  it('does not redirect when kopt_run is not callable (disabledTools, KOPT_DISABLE_RUN) and stops advertising it', async () => {
    for (const [name, entry] of [
      ['run-disabled-tools', { command: 'node', args: [], disabledTools: ['kopt_run'] }],
      ['run-disabled-env', { command: 'node', args: [], env: { KOPT_DISABLE_RUN: '1' } }],
    ] as const) {
      const c = makeConfig(name, (x) => { x.governor.blockDuplicateRuns = false; });
      mkdirSync(join(c.root, '.kiro', 'settings'), { recursive: true });
      writeFileSync(join(c.root, '.kiro', 'settings', 'mcp.json'), JSON.stringify({ mcpServers: { kopt: entry } }));
      expect((await handleHook(pre(c, 'execute_bash', { command: 'mvn test' }), c)).exitCode, name).toBe(0);
      mkdirSync(c.dataDir, { recursive: true });
      const start = await handleHook({ hook_event_name: 'SessionStart', session_id: 'adv', cwd: c.root }, c);
      expect(start.stdout, name).not.toContain('kopt_run');
    }
  });

  it('does not redirect to kopt_run when the kopt MCP server is disabled (it counts as absent)', async () => {
    const c = makeConfig('disabled-mcp', (x) => { x.governor.blockDuplicateRuns = false; });
    mkdirSync(join(c.root, '.kiro', 'settings'), { recursive: true });
    writeFileSync(join(c.root, '.kiro', 'settings', 'mcp.json'), JSON.stringify({ mcpServers: { kopt: { command: 'node', disabled: true } } }));
    expect((await handleHook(pre(c, 'execute_bash', { command: 'mvn test' }), c)).exitCode).toBe(0);
    expect(await handleHook({ hook_event_name: 'SessionStart', session_id: 'r2', cwd: c.root }, c)).toEqual({ exitCode: 0 });
  });

  it('never gates kopt tools themselves', async () => {
    const c = makeConfig('kopt-tools');
    installMcp(c);
    bigFile(c, 'big.ts', 2000);
    expect((await handleHook(pre(c, 'mcp_kopt_kopt_run', { command: 'npm test' }), c)).exitCode).toBe(0);
    expect((await handleHook(pre(c, '@kopt/kopt_read', { target: 'big.ts' }), c)).exitCode).toBe(0);
  });
});

describe('robustness', () => {
  it('never throws and exits 0 silently on malformed input', async () => {
    const c = makeConfig('malformed');
    const bad: unknown[] = [
      null, undefined, 42, 'str', [], {}, { hook_event_name: 'PreToolUse' },
      { hook_event_name: 'PreToolUse', tool_name: 'read_file', tool_input: 'not-an-object' },
      { hook_event_name: 'PreToolUse', tool_name: 'read_file', tool_input: { path: 12 } },
      { hook_event_name: 'PreToolUse', tool_name: 'execute_bash', tool_input: { command: { nested: true } } },
      { hook_event_name: 'PreToolUse', tool_name: 'read_files', tool_input: { paths: [null, 3, '/does/not/exist'] } },
      { hook_event_name: 'PostToolUse', tool_name: 'x', tool_response: { a: [1, { b: null }] } },
      { hook_event_name: 'PostFileSave' },
      { hook_event_name: 'UserPromptSubmit', prompt: 12 },
      { hook_event_name: 'Stop', session_id: '../../etc/passwd' },
    ];
    for (const e of bad) {
      const out = await handleHook(e as HookEvent, c);
      expect(out.exitCode).toBe(0);
      expect(out.stdout ?? '').toBe('');
    }
    // the session id is sanitized into a safe file name
    expect(sessionFile(c.userDir, '../../etc/passwd')).toBe(join(c.userDir, 'sessions', '.._.._etc_passwd.json'));
  });

  it('logs internal errors to hook-errors.log and allows the call', async () => {
    const c = makeConfig('errors');
    // userDir is a file: every state write fails
    writeFileSync(join(c.root, 'blocker'), 'x');
    c.userDir = join(c.root, 'blocker', 'nested');
    const out = await handleHook(pre(c, 'read_file', { path: 'x' }), c);
    expect(out).toEqual({ exitCode: 0 });
    const c2 = makeConfig('errors2');
    mkdirSync(join(c2.userDir, 'sessions', 's1.json'), { recursive: true }); // state path is a directory
    expect(await handleHook(pre(c2, 'read_file', { path: 'x' }), c2)).toEqual({ exitCode: 0 });
    expect(readFileSync(join(c2.userDir, 'hook-errors.log'), 'utf8')).toMatch(/PreToolUse/);
  });

  it('prunes session files older than 7 days', () => {
    const c = makeConfig('prune');
    mkdirSync(join(c.userDir, 'sessions'), { recursive: true });
    const old = join(c.userDir, 'sessions', 'old.json');
    const fresh = join(c.userDir, 'sessions', 'fresh.json');
    writeFileSync(old, '{}');
    writeFileSync(fresh, '{}');
    const t = new Date(Date.now() - 8 * 86400_000);
    utimesSync(old, t, t);
    expect(pruneSessions(c.userDir)).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it('PreToolUse is fast when warm (< 50 ms, typically ~1 ms)', async () => {
    const c = makeConfig('perf');
    installMcp(c);
    bigFile(c, 'big.ts', 5000);
    for (let i = 0; i < 5; i++) await handleHook(pre(c, 'grep_search', {}, 'warm'), c);
    const cases: HookEvent[] = [
      pre(c, 'grep_search', { query: 'x' }, 'p'),
      pre(c, 'read_file', { path: 'big.ts' }, 'p'),
      pre(c, 'execute_bash', { command: 'npm test' }, 'p'),
      pre(c, 'read_file', { path: 'big.ts', offset: 1, limit: 20 }, 'p'),
    ];
    const times: number[] = [];
    for (let i = 0; i < 40; i++) {
      const t0 = performance.now();
      await handleHook(cases[i % cases.length], c);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const p50 = times[Math.floor(times.length / 2)];
    const p90 = times[Math.floor(times.length * 0.9)];
    // Typically ~1 ms; the bounds only catch real regressions, since shared CI runners add noise
    // (a p50 of 10.3 ms was seen on a GitHub Linux runner).
    expect(p50).toBeLessThan(25);
    expect(p90).toBeLessThan(50);
  });
});

describe('duplicate-run detection', () => {
  const run = (c: KoptConfig, command: string, session = 'u1') => handleHook(pre(c, 'execute_bash', { command }, session), c);
  const post = (c: KoptConfig, tool: string, input: unknown, session = 'u1') =>
    handleHook({ hook_event_name: 'PostToolUse', session_id: session, cwd: c.root, tool_name: tool, tool_input: input, tool_response: 'ok' }, c);

  it('counts shell commands that may write (sed -i, git checkout, npm install) and code-tool edits as changes, not readers', async () => {
    const c = makeConfig('dup-shell');
    expect((await run(c, 'pytest -q')).exitCode).toBe(0);
    await post(c, 'execute_bash', { command: 'ls -la && cat app.py | grep x && git status' });
    expect((await run(c, 'pytest -q')).exitCode).toBe(2); // readers change nothing
    for (const writer of ['sed -i s/a/b/ app.py', 'git checkout -- app.py', 'npm install', 'echo x > app.py']) {
      await post(c, 'execute_bash', { command: writer });
      expect((await run(c, 'pytest -q')).exitCode, writer).toBe(0);
      expect((await run(c, 'pytest -q')).exitCode, writer).toBe(2);
    }
    // kiro `code` tool (rename_symbol, format, pattern_rewrite) writes files
    await post(c, 'code', { operation: 'rename_symbol', file_path: 'app.py', old: 'a', new: 'b' });
    expect((await run(c, 'pytest -q')).exitCode).toBe(0);
  });

  it('a new user prompt always allows the next identical run ("run it again")', async () => {
    const c = makeConfig('dup-prompt', (x) => { x.budgets.frontload = 0; });
    expect((await run(c, 'go test ./...')).exitCode).toBe(0);
    await handleHook({ hook_event_name: 'UserPromptSubmit', session_id: 'u1', cwd: c.root, prompt: 'I fixed it myself, run the tests again' }, c);
    expect((await run(c, 'go test ./...')).exitCode).toBe(0);
  });

  it('sees edits the hooks never observed (user editor, another terminal) through the git workspace state', async () => {
    const c = makeConfig('dup-git');
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['init', '-q'], { cwd: c.root });
    writeFileSync(join(c.root, 'app.py'), 'x = 1\n');
    expect((await run(c, 'pytest -q')).exitCode).toBe(0);
    await post(c, 'execute_bash', { command: 'pytest -q' }); // state right after the run
    expect(Object.values(loadSession(c.userDir, 'u1').runs)[0].fp).toMatch(/^[0-9a-f]{40}$/);
    expect((await run(c, 'pytest -q')).exitCode).toBe(2); // nothing changed: blocked once
    expect((await run(c, 'pytest -q')).exitCode).toBe(0);
    await post(c, 'execute_bash', { command: 'pytest -q' });
    writeFileSync(join(c.root, 'app.py'), 'x = 2  # edited outside Kiro\n'); // no hook saw this
    expect((await run(c, 'pytest -q')).exitCode).toBe(0);
  });

  it('never treats watch modes or dev servers as test/build runs', async () => {
    const c = makeConfig('dup-watch');
    for (const cmd of ['npm run dev', 'npm run dev']) expect((await run(c, cmd)).exitCode).toBe(0);
    expect(loadSession(c.userDir, 'u1').runs).toEqual({});
  });
});

describe('PostToolUse and file events', () => {
  it('records the size of built-in tool responses without output', async () => {
    const c = makeConfig('post');
    const resp = { success: true, result: ['x'.repeat(3000)] };
    const out = await handleHook({ hook_event_name: 'PostToolUse', session_id: 's1', cwd: c.root, tool_name: 'read_file', tool_input: { path: 'a' }, tool_response: resp }, c);
    expect(out).toEqual({ exitCode: 0 });
    const ev = telemetryLines(c).find((e) => e.kind === 'hook' && e.tool === 'read_file');
    expect(ev.bytes).toBe(3000);
    expect(ev.tokensOut).toBe(1000);
    expect(ev.session).toBe('s1');
    expect(responseText('plain')).toBe('plain');
  });

  it('appends agent writes to <dataDir>/dirty when an index dir exists', async () => {
    const c = makeConfig('dirty');
    mkdirSync(c.dataDir, { recursive: true });
    await handleHook({ hook_event_name: 'PostFileCreate', session_id: 's1', cwd: c.root, file_path: join(c.root, 'src/new.ts') }, c);
    await handleHook({ hook_event_name: 'PostFileDelete', session_id: 's1', cwd: c.root, file_path: 'src/old.ts' }, c);
    await handleHook({ hook_event_name: 'PostFileSave', session_id: 's1', cwd: c.root, file_path: '/elsewhere/outside.ts' }, c);
    expect(readFileSync(join(c.dataDir, 'dirty'), 'utf8')).toBe('src/new.ts\nsrc/old.ts\n');
    const s = loadSession(c.userDir, 's1');
    expect(s.writeSeq).toBe(3);
    expect(s.lastWriteAt).toBeGreaterThan(0);
  });
});

describe('SessionStart and Stop', () => {
  it('prints a short status line and spawns a background refresh when an index exists', async () => {
    const c = makeConfig('start-noindex');
    installMcp(c);
    const none = await handleHook({ hook_event_name: 'SessionStart', session_id: 'a', cwd: c.root }, c);
    expect(none.stdout).toBe('kopt: index building in the background. Prefer kopt_find/kopt_read/kopt_refs over grep + whole-file reads; kopt_run for tests/builds.\n');
    expect(spawned).toHaveLength(0);

    const { Store } = await import('../src/store/store.js');
    const c2 = makeConfig('start-index');
    installMcp(c2);
    const store = Store.open(join(c2.dataDir, 'index.db'));
    store.setMeta('commit', '0123456789abcdef');
    // first build still running (the MCP server created index.db): no second indexer, no "0 symbols"
    const building = await handleHook({ hook_event_name: 'SessionStart', session_id: 'b0', cwd: c2.root }, c2);
    expect(building.stdout).toBe(none.stdout);
    expect(spawned).toHaveLength(0);
    store.setMeta('indexed_at', String(Date.now()));
    store.close();
    const out = await handleHook({ hook_event_name: 'SessionStart', session_id: 'b', cwd: c2.root }, c2);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe('kopt: index @0123456, 0 symbols. Prefer kopt_find/kopt_read/kopt_refs over grep + whole-file reads; kopt_run for tests/builds.\n');
    expect(out.stdout!.length).toBeLessThanOrEqual(251);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].argv.slice(-3)).toEqual(['index', '--refresh', '--if-idle']);
    expect(spawned[0].cwd).toBe(c2.root);
    // throttled: a second session start right after does not spawn again
    await handleHook({ hook_event_name: 'SessionStart', session_id: 'c', cwd: c2.root }, c2);
    expect(spawned).toHaveLength(1);
  });

  it('says nothing at SessionStart when the kopt MCP server is not configured', async () => {
    const c = makeConfig('start-nomcp');
    expect(await handleHook({ hook_event_name: 'SessionStart', session_id: 'a', cwd: c.root }, c)).toEqual({ exitCode: 0 });
  });

  it('Stop returns immediately, starts no process and drops telemetry day files older than 90 days', async () => {
    const c = makeConfig('stop');
    const dir = join(c.userDir, 'telemetry');
    mkdirSync(dir, { recursive: true });
    const old = new Date(Date.now() - 91 * 86400_000).toISOString().slice(0, 10) + '.jsonl';
    const kept = new Date(Date.now() - 89 * 86400_000).toISOString().slice(0, 10) + '.jsonl';
    for (const f of [old, kept]) writeFileSync(join(dir, f), '{"ts":1,"kind":"hook"}\n');
    const t0 = performance.now();
    const out = await handleHook({ hook_event_name: 'Stop', session_id: 's1', cwd: c.root }, c);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(out).toEqual({ exitCode: 0 });
    expect(spawned).toHaveLength(0);
    expect(existsSync(join(dir, old))).toBe(false);
    expect(existsSync(join(dir, kept))).toBe(true);
    await handleHook({ hook_event_name: 'Stop', session_id: 's1', cwd: c.root }, c);
    expect(telemetryLines(c).filter((e) => e.kind === 'session' && e.meta?.event === 'stop')).toHaveLength(2);
  });
});

describe('UserPromptSubmit front-load', () => {
  const hit = (lines: string[], meta?: Record<string, unknown>) => ({ text: ['find "q" · 2 hits · ~40 tok', ...lines].join('\n'), tokens: 40, meta });

  /** Prompt pointers are off by default (budgets.frontload 0): these tests turn them on. */
  function withIndex(name: string, over: (c: KoptConfig) => void = () => {}): KoptConfig {
    const c = makeConfig(name, (x) => {
      x.budgets.frontload = 200;
      over(x);
    });
    mkdirSync(c.dataDir, { recursive: true });
    writeFileSync(join(c.dataDir, 'index.db'), '');
    return c;
  }

  function mock(result: () => any) {
    const calls: any[] = [];
    setFrontloadDeps({
      loadRetrieval: async () => ({ find: (_s: unknown, p: any) => { calls.push(p); return result(); } }),
      openStore: async () => ({ store: {}, close: () => {} }),
      newContext: async () => ({}),
    });
    return calls;
  }

  const prompt = (c: KoptConfig, text: string, session = 's1'): HookEvent => ({ hook_event_name: 'UserPromptSubmit', session_id: session, cwd: c.root, prompt: text });

  it('emits pointers when the top hit covers >= 2 query terms, within budget, once per handle', async () => {
    const c = withIndex('fl-ok');
    const calls = mock(() => hit([
      '#3mv class RefundCalculator  src/billing/refund/RefundCalculator.java:12-140',
      '#3mw method RefundCalculator.compute  src/billing/refund/RefundCalculator.java:40-90',
    ]));
    const out = await handleHook(prompt(c, 'fix the refund calculator rounding'), c);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe(`${FRONTLOAD_HEADER}\n#3mv class RefundCalculator  src/billing/refund/RefundCalculator.java:12-140\n#3mw method RefundCalculator.compute  src/billing/refund/RefundCalculator.java:40-90\n`);
    expect(calls[0]).toMatchObject({ mode: 'hits' });
    expect(calls[0].maxTokens).toBeLessThanOrEqual(c.budgets.frontload);
    // same pointers are not injected twice in one session
    expect((await handleHook(prompt(c, 'fix the refund calculator rounding'), c)).stdout).toBeUndefined();
    // but are in a new session
    expect((await handleHook(prompt(c, 'fix the refund calculator rounding', 's2'), c)).stdout).toContain('#3mv');
  });

  it('never sends the also: lines of a find result as pointers', async () => {
    const c = withIndex('fl-also');
    mock(() => hit([
      'src/billing/refund/RefundCalculator.java',
      '  #3mv 12-140 class public class RefundCalculator',
      '  also: roundHalfEven L150 #3mz, toString L170 #3n0',
      'src/billing/refund/RefundPolicy.java',
      '  #3p1 5-40 class public class RefundPolicy',
    ]));
    const out = await handleHook(prompt(c, 'fix the refund calculator rounding'), c);
    expect(out.stdout).toBe(
      `${FRONTLOAD_HEADER}\nsrc/billing/refund/RefundCalculator.java\n  #3mv 12-140 class public class RefundCalculator\n` +
        'src/billing/refund/RefundPolicy.java\n  #3p1 5-40 class public class RefundPolicy\n',
    );
  });

  it('measures term coverage with light stemming', async () => {
    const { stem, termCoverage } = await import('../src/hooks/frontload.js');
    expect(stem('orders')).toBe('order');
    expect(stem('applies')).toBe('apply');
    expect(stem('computation')).toBe('comput');
    expect(termCoverage(['refund', 'computation', 'orders'], 'src/billing/RefundCalculator.java #1 1-9 method computeRefund(Order o)')).toBe(3);
    expect(termCoverage(['refund', 'tax'], 'src/util/DateUtil.java #2 1-9 method parseDate')).toBe(0);
  });

  it('reads what a prompt says about the code: named code, domain words, follow-ups', async () => {
    const { promptSignal, confidentHit } = await import('../src/hooks/frontload.js');
    // generic developer words and conversation are not evidence
    for (const p of ['write the commit message for these changes', 'revert the last change', 'fix the failing test', 'yes continue',
      'run the tests again', 'please add type hints to the new code', 'rename user_id to account_id in the file I have open', 'ok']) {
      const sig = promptSignal(p);
      expect(sig.followUp || (!sig.identifiers.length && sig.words.length < 2), p).toBe(true);
    }
    expect(promptSignal('where is the refund amount computed').words).toEqual(['refund', 'amount', 'computed']);
    expect(promptSignal('why does `getBean` return null for prototype scope?').identifiers).toEqual([['getbean']]);
    expect(promptSignal('OrderService.place throws on empty carts').identifiers).toEqual([['orderservice', 'place']]);
    expect(promptSignal('look at src/billing/refund_policy.ts first').identifiers).toContainEqual(['refundpolicy']);
    expect(promptSignal('How does Django decide which CSRF cookie to set?', ['django']).words).toEqual(['csrf', 'cookie']);
    // named code: the top hit must be it
    const named = promptSignal('why does getBean return null for prototype beans');
    expect(confidentHit(named, 'src/Factory.java #1 1-9 method Object getBean(String name)')).toBe(true);
    expect(confidentHit(named, 'src/Scope.java #2 1-9 class PrototypeScope')).toBe(false);
    // words: at least 2 covered, and 2/3 of them
    const words = promptSignal('fix the rounding in the refund calculator');
    expect(confidentHit(words, 'src/RefundCalculator.java #3 1-9 class RefundCalculator')).toBe(true);
    expect(confidentHit(promptSignal('add a changelog entry for the release'), 'gis/srs.py #4 1-9 function add_srs_entry')).toBe(false);
    expect(confidentHit(promptSignal('where are refund amounts rounded for partial captures'), 'src/Refund.java #5 1-9 class Refund')).toBe(false);
  });

  it('understands the grouped find layout (path line + indented pointers) and keeps budgets', async () => {
    const c = withIndex('fl-grouped', (x) => { x.budgets.frontload = 70; });
    mock(() => hit([
      'src/billing/refund/RefundCalculator.java',
      '  #3mv 12-140 class public class RefundCalculator',
      '  #3mw 40-90 method BigDecimal compute(Order order)',
      'src/billing/refund/RefundPolicy.java',
      '  #3n0 5-60 class public class RefundPolicy implements Policy with a long signature that does not fit',
    ]));
    const out = (await handleHook(prompt(c, 'fix the refund calculator rounding'), c)).stdout!;
    expect(out).toBe(`${FRONTLOAD_HEADER}\nsrc/billing/refund/RefundCalculator.java\n  #3mv 12-140 class public class RefundCalculator\n  #3mw 40-90 method BigDecimal compute(Order order)\n`);
    // second prompt in the session: only the not-yet-sent group is a candidate, with its path line
    c.budgets.frontload = 350;
    const again = (await handleHook(prompt(c, 'fix the refund calculator rounding'), c)).stdout!;
    expect(again).toBe(`${FRONTLOAD_HEADER}\nsrc/billing/refund/RefundPolicy.java\n  #3n0 5-60 class public class RefundPolicy implements Policy with a long signature that does not fit\n`);
  });

  it('stays silent when the top hit is weak, the prompt is a follow-up, there is no index, or frontload is disabled', async () => {
    const c = withIndex('fl-weak');
    const calls = mock(() => hit(['#1 function parseDate  src/util/date.ts:1-20']));
    expect((await handleHook(prompt(c, 'fix the refund calculator rounding'), c)).stdout).toBeUndefined();
    // follow-ups and generic prompts do not even query the index
    for (const p of ['yes continue', 'fix the failing test', 'write the commit message for these changes', 'revert the last change']) {
      expect((await handleHook(prompt(c, p), c)).stdout, p).toBeUndefined();
    }
    expect(calls).toHaveLength(1);
    // retrieval's own coverage count (generic words included) is not trusted
    mock(() => hit(['#1 function parseDate  src/util/date.ts:1-20'], { topTermsMatched: 3 }));
    expect((await handleHook(prompt(c, 'fix the refund calculator rounding'), c)).stdout).toBeUndefined();

    const noIndex = makeConfig('fl-noindex');
    mock(() => hit(['#3mv class RefundCalculator  src/RefundCalculator.java:1-9']));
    expect((await handleHook(prompt(noIndex, 'fix the rounding in the refund calculator'), noIndex)).stdout).toBeUndefined();

    const off = withIndex('fl-off', (x) => { x.budgets.frontload = 0; });
    expect((await handleHook(prompt(off, 'fix the rounding in the refund calculator'), off)).stdout).toBeUndefined();
  });

  it('is off by default; when on, caps pointers at 4', async () => {
    const c = withIndex('fl-cap');
    expect(defaultConfig(c.root).budgets.frontload).toBe(0);
    mock(() => hit(Array.from({ length: 8 }, (_, i) => `#a${i} method RefundCalculator.step${i}  src/billing/RefundCalculator.java:${i * 10 + 1}-${i * 10 + 9}`)));
    const out = (await handleHook(prompt(c, 'explain how the refund calculator works'), c)).stdout!;
    expect(out.trim().split('\n')).toHaveLength(1 + 4);
  });

  it('skips when retrieval exceeds the time limit and survives a missing retrieval module', async () => {
    const c = withIndex('fl-slow');
    setFrontloadDeps({
      loadRetrieval: () => new Promise((r) => setTimeout(() => r({ find: () => hit(['#3mv class RefundCalculator  a.java:1-2']) }), 600)),
      openStore: async () => ({ store: {}, close: () => {} }),
      newContext: async () => ({}),
    });
    const t0 = performance.now();
    expect((await handleHook(prompt(c, 'fix the rounding in the refund calculator'), c)).stdout).toBeUndefined();
    expect(performance.now() - t0).toBeLessThan(550);
    setFrontloadDeps({ loadRetrieval: () => Promise.reject(new Error('Cannot find module')) });
    expect(await handleHook(prompt(c, 'fix the rounding in the refund calculator', 's9'), c)).toEqual({ exitCode: 0 });
  });

  it('closes the index it opened when retrieval fails or is too slow (an open handle locks index.db on Windows)', async () => {
    const c = withIndex('fl-close');
    let opened = 0;
    let closed = 0;
    const openStore = async () => {
      opened++;
      return { store: {}, close: () => { closed++; } };
    };
    setFrontloadDeps({ loadRetrieval: () => Promise.reject(new Error('Cannot find module')), openStore, newContext: async () => ({}) });
    expect(await handleHook(prompt(c, 'fix the rounding in the refund calculator', 'c1'), c)).toEqual({ exitCode: 0 });
    setFrontloadDeps({
      loadRetrieval: () => new Promise((r) => setTimeout(() => r({ find: () => hit(['#3mv class RefundCalculator  a.java:1-2']) }), 600)),
      openStore,
      newContext: async () => ({}),
    });
    expect((await handleHook(prompt(c, 'fix the rounding in the refund calculator', 'c2'), c)).stdout).toBeUndefined();
    await new Promise((r) => setTimeout(r, 0));
    expect(opened).toBe(2);
    expect(closed).toBe(2);
  });

  it('works end-to-end with the real retrieval module on a tiny hand-built index', async () => {
    const spec = '../src/retrieval/index.js';
    const available = await import(spec).then(() => true, () => false);
    if (!available) return; // sibling module not built yet: covered by the mocked tests above
    const { Store } = await import('../src/store/store.js');
    const c = makeConfig('fl-real', (x) => { x.budgets.frontload = 200; });
    const store = Store.open(join(c.dataDir, 'index.db'));
    store.transaction(() => {
      const f = store.prepare('INSERT INTO files(id, path, lang, hash, size, line_count, rank) VALUES (?, ?, ?, ?, ?, ?, ?)');
      f.run(1, 'src/billing/refund/RefundCalculator.java', 'java', 'h1', 4000, 140, 0.5);
      f.run(2, 'src/util/DateUtil.java', 'java', 'h2', 900, 40, 0.1);
      const s = store.prepare(`INSERT INTO symbols(id, file_id, name, qname, kind, start_line, end_line, start_byte, end_byte, signature, exported, rank)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 1, ?)`);
      s.run(1, 1, 'RefundCalculator', 'com.acme.billing.RefundCalculator', 'class', 12, 140, 'public class RefundCalculator', 0.6);
      s.run(2, 1, 'computeRefund', 'com.acme.billing.RefundCalculator.computeRefund', 'method', 40, 90, 'BigDecimal computeRefund(Order order)', 0.4);
      s.run(3, 2, 'parseDate', 'com.acme.util.DateUtil.parseDate', 'method', 3, 20, 'static Date parseDate(String s)', 0.2);
      const fts = store.prepare('INSERT INTO symbols_fts(rowid, name_terms, sig_terms, path_terms, doc, body_terms) VALUES (?, ?, ?, ?, ?, ?)');
      fts.run(1, 'refundcalculator refund calculator', 'public class refundcalculator', 'src billing refund refundcalculator java', '', 'rounding');
      fts.run(2, 'computerefund compute refund', 'bigdecimal computerefund order', 'src billing refund refundcalculator java', '', 'rounding scale');
      fts.run(3, 'parsedate parse date', 'static date parsedate string', 'src util dateutil java', '', '');
    });
    store.close();
    setFrontloadDeps(undefined);
    const out = await handleHook(prompt(c, 'fix the rounding in the refund calculator'), c);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toMatch(new RegExp(`^${FRONTLOAD_HEADER.replace(/[()]/g, '\\$&')}\\n`));
    expect(out.stdout).toContain('RefundCalculator');
    expect(out.stdout).not.toContain('parseDate');
  });

  it('reads the prompt from USER_PROMPT when the payload has none (IDE legacy hooks)', async () => {
    const c = withIndex('fl-env');
    mock(() => hit(['#3mv class RefundCalculator  src/RefundCalculator.java:1-9']));
    process.env.USER_PROMPT = 'fix the rounding in the refund calculator';
    try {
      const out = await handleHook({ hook_event_name: 'UserPromptSubmit', session_id: 'e', cwd: c.root }, c);
      expect(out.stdout).toContain('#3mv');
    } finally {
      delete process.env.USER_PROMPT;
    }
  });
});

describe('normalization across Kiro surfaces', () => {
  it('maps every event spelling (v1 PascalCase, CLI 2.x camelCase, IDE 0.x when.type, harness aliases)', () => {
    const table: Record<string, string | undefined> = {
      // IDE 1.x / CLI V3 (v1 hook files)
      SessionStart: 'SessionStart', UserPromptSubmit: 'UserPromptSubmit', PreToolUse: 'PreToolUse', PostToolUse: 'PostToolUse',
      PostFileSave: 'PostFileSave', PostFileCreate: 'PostFileCreate', PostFileDelete: 'PostFileDelete', Stop: 'Stop',
      PreTaskExec: 'PreTaskExec', PostTaskExec: 'PostTaskExec', Manual: 'Manual',
      // CLI 2.x agent hooks (the triggers kiro-cli 2.28 `agent validate` accepts)
      agentSpawn: 'SessionStart', userPromptSubmit: 'UserPromptSubmit', preToolUse: 'PreToolUse', postToolUse: 'PostToolUse', stop: 'Stop',
      // IDE 0.x .kiro.hook when.type (IDEListenableEvent)
      promptSubmit: 'UserPromptSubmit', agentStop: 'Stop', fileEdited: 'PostFileSave', fileCreated: 'PostFileCreate', fileDeleted: 'PostFileDelete',
      preTaskExecution: 'PreTaskExec', postTaskExecution: 'PostTaskExec', sessionStart: 'SessionStart', userTriggered: 'Manual',
      // harness alias map
      SessionEnd: 'Stop', AfterFileEdit: 'PostFileSave',
      'pre-tool-use': 'PreToolUse', nonsense: undefined,
    };
    for (const [raw, want] of Object.entries(table)) expect(canonicalEvent(raw), raw).toBe(want);
  });

  it('classifies tool names of IDE 0.12 / 1.x, CLI 2.x (fs_*, execute_*) and CLI V3 / 2.28 short names', () => {
    const table: Record<string, string> = {
      read_file: 'read', read_files: 'read', fs_read: 'read', read: 'read', readFile: 'read',
      execute_bash: 'shell', execute_pwsh: 'shell', execute_cmd: 'shell', shell: 'shell', executeBash: 'shell',
      fs_write: 'write', fs_append: 'write', str_replace: 'write', edit_code: 'write', delete_file: 'write', write: 'write',
      semantic_rename: 'write', smart_relocate: 'write',
      read_code: 'other', grep_search: 'other', file_search: 'other', list_directory: 'other', glob: 'other', grep: 'other', web_fetch: 'other', use_aws: 'other',
      mcp_kopt_kopt_find: 'kopt', '@kopt/kopt_read': 'kopt', kopt_outline: 'kopt',
    };
    for (const [name, cls] of Object.entries(table)) expect(classifyTool(name), name).toBe(cls);
  });

  it('reads every read-tool input shape (offset/limit, start/end, CLI 2.28 operations, read_files arrays)', () => {
    // kiro-cli 2.28 fs_read schema: operations[{mode: Line|Directory|Image, path, offset?, limit?}]
    expect(readRequests({ operations: [{ mode: 'Line', path: 'a', offset: 10, limit: 50 }] }, 800)[0].whole).toBe(false);
    expect(readRequests({ operations: [{ mode: 'Line', path: 'a', limit: 5000 }] }, 800)[0].whole).toBe(true);
    expect(readRequests({ operations: [{ mode: 'Image', image_paths: ['x.png'] }, { path: 'b' }] }, 800)).toEqual([{ path: 'b', whole: true }]);
    expect(readRequests({ files: [{ path: 'a', start_line: 1, end_line: 20 }, 'b'] }, 800)).toEqual([{ path: 'a', whole: false }, { path: 'b', whole: true }]);
    expect(readRequests({ file_path: 'c', startLine: 5, endLine: 9 }, 800)).toEqual([{ path: 'c', whole: false }]);
  });

  it('builds events for IDE 0.x legacy invocations from USER_PROMPT', () => {
    const cwd = '/ws';
    expect(legacyEvent('promptSubmit', { USER_PROMPT: 'fix the refund' }, cwd)).toEqual({ hook_event_name: 'promptSubmit', cwd, prompt: 'fix the refund' });
    expect(legacyEvent('preToolUse', { USER_PROMPT: JSON.stringify({ path: 'src/a.ts' }) }, cwd)).toEqual({ hook_event_name: 'preToolUse', cwd, tool_input: { path: 'src/a.ts' } });
    expect(legacyEvent('postToolUse', { USER_PROMPT: JSON.stringify({ toolName: 'read_file', toolArgs: { path: 'a' }, toolResult: 'x', toolSuccess: true }) }, cwd))
      .toEqual({ hook_event_name: 'postToolUse', cwd, tool_name: 'read_file', tool_input: { path: 'a' }, tool_response: 'x' });
    expect(legacyEvent('preToolUse', { USER_PROMPT: 'not json' }, cwd)).toEqual({ hook_event_name: 'preToolUse', cwd });
  });
});

describe('duplicate events from two active hook formats', () => {
  it('handles an event once when it arrives from another source within 2 s, but processes real repeats', async () => {
    const c = makeConfig('dedup');
    const ev = (source: string, session = 'd1'): HookEvent => ({ ...pre(c, 'grep_search', { query: 'x' }, session), _kopt_source: source });
    expect(await handleHook(ev('global'), c)).toEqual({ exitCode: 0 });
    expect(await handleHook(ev('workspace'), c)).toEqual({ exitCode: 0 }); // same call seen by the workspace hook file
    expect(loadSession(c.userDir, 'd1').toolCalls).toBe(1);
    await handleHook(ev('global'), c); // the agent really called it again
    expect(loadSession(c.userDir, 'd1').toolCalls).toBe(2);
    // window: after 2 s a different source is a new event again
    const later = Date.now() + DUPLICATE_WINDOW_MS + 10;
    expect(isDuplicate(ev('agent'), 'PreToolUse', c, later)).toBe(false);
    // events without a source (direct calls, old installs) are never deduplicated
    expect(isDuplicate(pre(c, 'grep_search', { query: 'x' }, 'd1'), 'PreToolUse', c)).toBe(false);
  });

  it('a duplicate of a blocked call stays silent (the first copy already blocked it)', async () => {
    const c = makeConfig('dedup-block', (x) => { x.governor.bigFileLines = 100; x.governor.bigFileTokens = 1000; });
    bigFile(c, 'Big.java', 500);
    const ev = (source: string): HookEvent => ({ ...pre(c, 'read_file', { path: 'Big.java' }, 'd2'), _kopt_source: source });
    const first = await handleHook(ev('agent'), c);
    expect(first.exitCode).toBe(2);
    expect(await handleHook(ev('global'), c)).toEqual({ exitCode: 0 });
    expect(loadSession(c.userDir, 'd2').blocks['big-read']).toBe(1);
  });
});

describe('IDE 0.x legacy sessions and prompt dedup', () => {
  it('gives legacy hook events (no chat id) a pseudo-session that ends after 30 idle minutes', async () => {
    const { legacySessionId, LEGACY_SESSION_IDLE_MS } = await import('../src/hooks/index.js');
    const c = makeConfig('legacy-session');
    const t0 = Date.now();
    const a = legacySessionId(c, t0);
    expect(legacySessionId(c, t0 + 60_000)).toBe(a);
    const b = legacySessionId(c, t0 + 60_000 + LEGACY_SESSION_IDLE_MS + 1);
    expect(b).not.toBe(a);
    expect(b).toMatch(/^legacy-[0-9a-f]{8}-/);
  });

  it('a new chat in IDE 0.x gets pointers again (no day-long anon session), and a prompt seen by two hook formats is handled once', async () => {
    const c = makeConfig('legacy-pointers', (x) => { x.budgets.frontload = 200; });
    mkdirSync(c.dataDir, { recursive: true });
    writeFileSync(join(c.dataDir, 'index.db'), '');
    setFrontloadDeps({
      loadRetrieval: async () => ({ find: () => ({ text: 'find · 1 hit\n#3mv class RefundCalculator  src/RefundCalculator.java:1-9', tokens: 20 }) }),
      openStore: async () => ({ store: {}, close: () => {} }),
      newContext: async () => ({}),
    });
    const legacy = (prompt: string): HookEvent => ({ hook_event_name: 'promptSubmit', cwd: c.root, prompt, _kopt_source: 'legacy' });
    expect((await handleHook(legacy('fix the rounding in the refund calculator'), c)).stdout).toContain('#3mv');
    // the same prompt delivered by the v1 global hook too (IDE 1.x still runs legacy hooks it finds): once
    expect((await handleHook({ hook_event_name: 'UserPromptSubmit', session_id: 'v1-chat', cwd: c.root, prompt: 'fix the rounding in the refund calculator', _kopt_source: 'global' }, c)).stdout).toBeUndefined();
    // a later chat (after the idle window): the pointer is sent again
    const { legacySessionId, LEGACY_SESSION_IDLE_MS } = await import('../src/hooks/index.js');
    legacySessionId(c, Date.now() - 2 * LEGACY_SESSION_IDLE_MS); // simulate an old pseudo-session
    const later = join(c.userDir, 'sessions');
    for (const f of readdirSync(later).filter((n) => n.startsWith('_legacy-'))) {
      const p = join(later, f);
      if (f.endsWith('.json')) writeFileSync(p, JSON.stringify({ id: 'legacy-old', at: Date.now() - 2 * LEGACY_SESSION_IDLE_MS }));
    }
    await new Promise((r) => setTimeout(r, DUPLICATE_WINDOW_MS + 50));
    expect((await handleHook(legacy('fix the rounding in the refund calculator'), c)).stdout).toContain('#3mv');
  }, 10_000);
});

describe('private files (POSIX)', () => {
  it.skipIf(process.platform === 'win32')('writes session state, usage logs and error logs owner-only', async () => {
    const c = makeConfig('private');
    await handleHook(pre(c, 'grep_search', { query: 'x' }, 'p1'), c);
    await handleHook({ hook_event_name: 'PostToolUse', session_id: 'p1', cwd: c.root, tool_name: 'read_file', tool_input: { path: 'a' }, tool_response: 'x' }, c);
    const { logHookError } = await import('../src/hooks/index.js');
    logHookError(c, new Error('boom'));
    const { statSync } = await import('node:fs');
    const mode = (p: string) => statSync(p).mode & 0o777;
    expect(mode(c.userDir)).toBe(0o700);
    expect(mode(sessionFile(c.userDir, 'p1'))).toBe(0o600);
    const tel = join(c.userDir, 'telemetry');
    expect(mode(tel)).toBe(0o700);
    for (const f of readdirSync(tel)) expect(mode(join(tel, f))).toBe(0o600);
    expect(mode(join(c.userDir, 'hook-errors.log'))).toBe(0o600);
  });
});

describe('home directory and filesystem root are never projects', () => {
  it('stays silent at SessionStart and UserPromptSubmit when the root is unsafe', async () => {
    const { homedir } = await import('node:os');
    const c = defaultConfig(homedir());
    c.userDir = join(tmp, 'home-user');
    c.dataDir = join(tmp, 'home-data');
    expect(await handleHook({ hook_event_name: 'SessionStart', session_id: 'h', cwd: homedir() }, c)).toEqual({ exitCode: 0 });
    expect((await handleHook({ hook_event_name: 'UserPromptSubmit', session_id: 'h', cwd: homedir(), prompt: 'refund calculator rounding' }, c)).stdout).toBeUndefined();
  });
});
