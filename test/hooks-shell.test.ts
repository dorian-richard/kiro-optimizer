// The hook command spawned the way Kiro spawns it (through a shell, JSON on stdin): the allow path must print
// nothing at all (any output intercepts the tool call in the IDE), node:sqlite's ExperimentalWarning must never
// leak, and IDE 0.x legacy invocations (stdin left open, data in USER_PROMPT) must not wait for stdin.

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, indexPath } from '../src/core/config.js';
import { Store } from '../src/store/store.js';

const ROOT = resolve(__dirname, '..');
const BIN = join(ROOT, 'src', 'bin.ts');
const TSX = pathToFileURL(join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
const q = (s: string) => (process.platform === 'win32' ? `"${s}"` : `'${s.replace(/'/g, `'\\''`)}'`);
const COMMAND = `${q(process.execPath)} --import ${q(TSX)} ${q(BIN)} hook --source global`;

let tmp: string;
let repo: string;
let env: NodeJS.ProcessEnv;

interface Run { code: number | null; stdout: string; stderr: string; ms: number }

function runShell(command: string, input: string | undefined, extraEnv: NodeJS.ProcessEnv = {}, keepStdinOpen = false): Promise<Run> {
  return new Promise((done) => {
    const t0 = Date.now();
    const child = spawn(command, { shell: true, cwd: repo, env: { ...env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => {
      child.stdin.destroy();
      done({ code, stdout, stderr, ms: Date.now() - t0 });
    });
    if (input !== undefined) child.stdin.write(input);
    if (!keepStdinOpen) child.stdin.end();
  });
}

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'kopt-hookshell-')));
  repo = join(tmp, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  writeFileSync(join(repo, 'Big.java'), Array.from({ length: 1500 }, (_, i) => `int f${i};`).join('\n') + '\n');
  const kiroHome = join(tmp, 'kiro');
  mkdirSync(join(kiroHome, 'settings'), { recursive: true });
  writeFileSync(join(kiroHome, 'settings', 'mcp.json'), JSON.stringify({ mcpServers: { kopt: { command: 'kopt', args: ['mcp'] } } }));
  env = {
    ...process.env,
    KOPT_HOME: join(tmp, 'kopt-home'),
    KOPT_CACHE_DIR: join(tmp, 'cache'),
    KOPT_KIRO_HOME: kiroHome,
    KOPT_TELEMETRY: '0',
    KOPT_ROOT: '',
    NODE_OPTIONS: '',
  };
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('kopt hook through a shell', () => {
  it('allow path: exit 0, empty stdout, empty stderr', async () => {
    for (const tool of ['grep_search', 'read_file', 'fs_read', 'execute_bash']) {
      const input = tool === 'read_file' ? { path: 'small.txt' } : tool === 'execute_bash' ? { command: 'git status' } : tool === 'fs_read' ? { operations: [{ mode: 'Directory', path: '.' }] } : { query: 'x' };
      const r = await runShell(COMMAND, JSON.stringify({ hook_event_name: 'PreToolUse', session_id: `allow-${tool}`, cwd: repo, tool_name: tool, tool_input: input }));
      expect({ tool, code: r.code, stdout: r.stdout, stderr: r.stderr }).toEqual({ tool, code: 0, stdout: '', stderr: '' });
    }
    // PostToolUse and file events are always silent too
    const post = await runShell(COMMAND, JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'p', cwd: repo, tool_name: 'read_file', tool_input: { path: 'a' }, tool_response: 'x'.repeat(5000) }));
    expect([post.code, post.stdout, post.stderr]).toEqual([0, '', '']);
  }, 60_000);

  it('block path: exit 2 with a one-line reason on stderr and nothing on stdout', async () => {
    const r = await runShell(COMMAND, JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'block', cwd: repo, tool_name: 'read_file', tool_input: { path: 'Big.java' } }));
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/^kopt: Big\.java has 1500 lines/);
    expect(r.stderr.trim().split('\n')).toHaveLength(1);
  }, 30_000);

  it('never leaks the node:sqlite ExperimentalWarning (SessionStart opens the index)', async () => {
    const prev = process.env.KOPT_CACHE_DIR;
    process.env.KOPT_CACHE_DIR = env.KOPT_CACHE_DIR;
    try {
      const store = Store.open(indexPath(loadConfig(repo)));
      store.setMeta('commit', 'abcdef0123456789');
      store.close();
    } finally {
      if (prev === undefined) delete process.env.KOPT_CACHE_DIR;
      else process.env.KOPT_CACHE_DIR = prev;
    }
    const r = await runShell(COMMAND, JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'start', cwd: repo }));
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^kopt: index @abcdef0/);
    expect(r.stderr).toBe('');
  }, 30_000);

  it('IDE 0.x legacy invocation: no stdin payload (pipe left open), data in USER_PROMPT, returns at once', async () => {
    const legacy = COMMAND.replace('hook --source global', 'hook promptSubmit --legacy --source legacy');
    const r = await runShell(legacy, undefined, { USER_PROMPT: 'yes' }, true);
    expect([r.code, r.stdout, r.stderr]).toEqual([0, '', '']);
    expect(r.ms).toBeLessThan(4000); // reading stdin would have waited 5 s for a pipe Kiro never closes
  }, 30_000);
});
