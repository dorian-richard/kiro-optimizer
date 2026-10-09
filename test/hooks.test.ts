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
    expect(first.stderr).toMatch(/^kopt: src\/Big\.java has 3412 lines \(~\d+k tokens\)\. Use kopt_outline path=src\/Big\.java or kopt_read src\/Big\.java:<a>-<b>, or read with offset\/limit\.$/);
    expect((await handleHook(pre(c, 'read_file', { path: 'src/Big.java' }), c)).exitCode).toBe(0);
    // ranged reads and small files are never blocked
    expect((await handleHook(pre(c, 'read_file', { path: 'src/Big.java', offset: 10, limit: 40 }, 's2'), c)).exitCode).toBe(0);
    expect((await handleHook(pre(c, 'read_file', { path: 'src/small.ts' }, 's2'), c)).exitCode).toBe(0);
    // CLI 2.x shape with absolute path, other session
    const cli = await handleHook(pre(c, 'fs_read', { operations: [{ mode: 'Line', path: join(c.root, 'src/Big.java') }] }, 's3'), c);
    expect(cli.exitCode).toBe(2);
    expect(loadSession(c.userDir, 's1').blocks['big-read']).toBe(1);
  });

  it('redirects verbose test/build commands to kopt_run once per command when the MCP server is installed', async () => {
    const c = makeConfig('verbose');
    // not installed: no redirect
    expect((await handleHook(pre(c, 'execute_bash', { command: 'mvn -q test' }, 'n1'), c)).exitCode).toBe(0);
    installMcp(c);
    const out = await handleHook(pre(c, 'execute_bash', { command: 'cd api && npm test -- --watch=false', cwd: c.root }), c);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toBe('kopt: use kopt_run with command="npm test -- --watch=false" cwd="api": same execution, returns only failures/errors (full log via kopt_expand).');
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
    expect(dup.stderr).toBe('kopt governor: identical command already ran this session and no file changed since; reuse its result.');
    expect((await run()).exitCode).toBe(0); // insisting is allowed (no deadlock)
    await handleHook({ hook_event_name: 'PostFileSave', session_id: 's1', cwd: c.root, file_path: join(c.root, 'app.py') }, c);
    expect((await run()).exitCode).toBe(0);
    expect((await run()).exitCode).toBe(2);
    // a write observed through PostToolUse (CLI 2.x has no file events) also counts
    await handleHook({ hook_event_name: 'postToolUse', session_id: 's1', cwd: c.root, tool_name: 'fs_write', tool_input: { path: 'app.py' }, tool_response: { success: true } }, c);
    expect((await run()).exitCode).toBe(0);
    expect(loadSession(c.userDir, 's1').blocks['duplicate-run']).toBe(2);
  });

  it('does not redirect to kopt_run when kopt is a remote server (it cannot run local commands)', async () => {
    const c = makeConfig('remote-mcp', (x) => { x.governor.blockDuplicateRuns = false; });
    mkdirSync(join(c.root, '.kiro', 'settings'), { recursive: true });
    writeFileSync(join(c.root, '.kiro', 'settings', 'mcp.json'), JSON.stringify({ mcpServers: { kopt: { url: 'https://kopt.example.com/mcp' } } }));
    expect((await handleHook(pre(c, 'execute_bash', { command: 'mvn test' }), c)).exitCode).toBe(0);
    const start = await handleHook({ hook_event_name: 'SessionStart', session_id: 'r', cwd: c.root }, c);
    expect(start.stdout).toBe('kopt: central index. Prefer kopt_find/kopt_read/kopt_outline over grep + whole-file reads.\n');
    // a disabled server counts as absent
    writeFileSync(join(c.root, '.kiro', 'settings', 'mcp.json'), JSON.stringify({ mcpServers: { kopt: { command: 'node', disabled: true } } }));
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
    expect(p50).toBeLessThan(10);
    expect(p90).toBeLessThan(50);
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
    expect(none.stdout).toBe('kopt: index building in the background. Prefer kopt_find/kopt_read/kopt_outline over grep + whole-file reads; kopt_run for tests/builds.\n');
    expect(spawned).toHaveLength(0);

    const { Store } = await import('../src/store/store.js');
    const c2 = makeConfig('start-index');
    installMcp(c2);
    const store = Store.open(join(c2.dataDir, 'index.db'));
    store.setMeta('commit', '0123456789abcdef');
    store.close();
    const out = await handleHook({ hook_event_name: 'SessionStart', session_id: 'b', cwd: c2.root }, c2);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe('kopt: index @0123456, 0 symbols. Prefer kopt_find/kopt_read/kopt_outline over grep + whole-file reads; kopt_run for tests/builds.\n');
    expect(out.stdout!.length).toBeLessThanOrEqual(251);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].argv.slice(-2)).toEqual(['index', '--refresh']);
    expect(spawned[0].cwd).toBe(c2.root);
    // throttled: a second session start right after does not spawn again
    await handleHook({ hook_event_name: 'SessionStart', session_id: 'c', cwd: c2.root }, c2);
    expect(spawned).toHaveLength(1);
  });

  it('says nothing at SessionStart when the kopt MCP server is not configured', async () => {
    const c = makeConfig('start-nomcp');
    expect(await handleHook({ hook_event_name: 'SessionStart', session_id: 'a', cwd: c.root }, c)).toEqual({ exitCode: 0 });
  });

  it('Stop returns immediately and spawns `kopt telemetry ship` detached (throttled)', async () => {
    const c = makeConfig('stop');
    const t0 = performance.now();
    const out = await handleHook({ hook_event_name: 'Stop', session_id: 's1', cwd: c.root }, c);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(out).toEqual({ exitCode: 0 });
    expect(spawned.map((s) => s.argv.slice(-2))).toEqual([['telemetry', 'ship']]);
    await handleHook({ hook_event_name: 'Stop', session_id: 's1', cwd: c.root }, c);
    expect(spawned).toHaveLength(1);
    expect(telemetryLines(c).filter((e) => e.kind === 'session' && e.meta.event === 'stop')).toHaveLength(2);
  });
});

describe('UserPromptSubmit front-load', () => {
  const hit = (lines: string[], meta?: Record<string, unknown>) => ({ text: ['find "q" · 2 hits · ~40 tok', ...lines].join('\n'), tokens: 40, meta });

  function withIndex(name: string, over: (c: KoptConfig) => void = () => {}): KoptConfig {
    const c = makeConfig(name, over);
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

  it('measures term coverage with light stemming', async () => {
    const { stem, termCoverage, requiredCoverage } = await import('../src/hooks/frontload.js');
    expect(stem('orders')).toBe('order');
    expect(stem('applies')).toBe('apply');
    expect(stem('computation')).toBe('comput');
    expect(termCoverage(['refund', 'computation', 'orders'], 'src/billing/RefundCalculator.java #1 1-9 method computeRefund(Order o)')).toBe(3);
    expect(termCoverage(['refund', 'tax'], 'src/util/DateUtil.java #2 1-9 method parseDate')).toBe(0);
    expect(requiredCoverage(2)).toBe(2);
    expect(requiredCoverage(8)).toBe(3);
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

  it('stays silent when the top hit is weak, the prompt is too short, there is no index, or frontload is disabled', async () => {
    const c = withIndex('fl-weak');
    mock(() => hit(['#1 function parseDate  src/util/date.ts:1-20']));
    expect((await handleHook(prompt(c, 'fix the refund calculator rounding'), c)).stdout).toBeUndefined();
    expect((await handleHook(prompt(c, 'yes continue'), c)).stdout).toBeUndefined();
    // honours an explicit coverage reported by retrieval
    mock(() => hit(['#1 function parseDate  src/util/date.ts:1-20'], { topTermsMatched: 3 }));
    expect((await handleHook(prompt(c, 'fix the refund calculator rounding'), c)).stdout).toContain('#1');

    const noIndex = makeConfig('fl-noindex');
    mock(() => hit(['#3mv class RefundCalculator  src/RefundCalculator.java:1-9']));
    expect((await handleHook(prompt(noIndex, 'refund calculator rounding'), noIndex)).stdout).toBeUndefined();

    const off = withIndex('fl-off', (x) => { x.budgets.frontload = 0; });
    expect((await handleHook(prompt(off, 'refund calculator rounding'), off)).stdout).toBeUndefined();
  });

  it('skips when retrieval exceeds the time limit and survives a missing retrieval module', async () => {
    const c = withIndex('fl-slow');
    setFrontloadDeps({
      loadRetrieval: () => new Promise((r) => setTimeout(() => r({ find: () => hit(['#3mv class RefundCalculator  a.java:1-2']) }), 600)),
      openStore: async () => ({ store: {}, close: () => {} }),
      newContext: async () => ({}),
    });
    const t0 = performance.now();
    expect((await handleHook(prompt(c, 'refund calculator rounding'), c)).stdout).toBeUndefined();
    expect(performance.now() - t0).toBeLessThan(550);
    setFrontloadDeps({ loadRetrieval: () => Promise.reject(new Error('Cannot find module')) });
    expect(await handleHook(prompt(c, 'refund calculator rounding', 's9'), c)).toEqual({ exitCode: 0 });
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
    expect(await handleHook(prompt(c, 'refund calculator rounding', 'c1'), c)).toEqual({ exitCode: 0 });
    setFrontloadDeps({
      loadRetrieval: () => new Promise((r) => setTimeout(() => r({ find: () => hit(['#3mv class RefundCalculator  a.java:1-2']) }), 600)),
      openStore,
      newContext: async () => ({}),
    });
    expect((await handleHook(prompt(c, 'refund calculator rounding', 'c2'), c)).stdout).toBeUndefined();
    await new Promise((r) => setTimeout(r, 0));
    expect(opened).toBe(2);
    expect(closed).toBe(2);
  });

  it('works end-to-end with the real retrieval module on a tiny hand-built index', async () => {
    const spec = '../src/retrieval/index.js';
    const available = await import(spec).then(() => true, () => false);
    if (!available) return; // sibling module not built yet: covered by the mocked tests above
    const { Store } = await import('../src/store/store.js');
    const c = makeConfig('fl-real');
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
    process.env.USER_PROMPT = 'refund calculator rounding';
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
    const c = makeConfig('dedup-block', (x) => { x.governor.bigFileLines = 100; });
    bigFile(c, 'Big.java', 500);
    const ev = (source: string): HookEvent => ({ ...pre(c, 'read_file', { path: 'Big.java' }, 'd2'), _kopt_source: source });
    const first = await handleHook(ev('agent'), c);
    expect(first.exitCode).toBe(2);
    expect(await handleHook(ev('global'), c)).toEqual({ exitCode: 0 });
    expect(loadSession(c.userDir, 'd2').blocks['big-read']).toBe(1);
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
