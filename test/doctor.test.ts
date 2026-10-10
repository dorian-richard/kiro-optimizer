// kopt doctor in a temp HOME: the hook command is run like Kiro runs it (shell, JSON on stdin) and the MCP server
// like Kiro starts it (SDK stdio transport, SDK default environment); a noisy hook command is reported.

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { KoptCommand } from '../src/kiro/command.js';
import { formatChecks, runDoctor } from '../src/kiro/doctor.js';
import type { HostEnv } from '../src/kiro/paths.js';
import { setupUser } from '../src/kiro/setup.js';

const ROOT = resolve(__dirname, '..');
const BIN = join(ROOT, 'src', 'bin.ts');
const TSX = pathToFileURL(join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
const q = (s: string) => (process.platform === 'win32' ? `"${s}"` : `'${s}'`);
const CMD: KoptCommand = {
  shell: `${q(process.execPath)} --import ${q(TSX)} ${q(BIN)}`,
  mcp: { command: process.execPath, args: ['--import', TSX, BIN, 'mcp'] },
  kind: 'node',
};

let tmp: string;
let prevCache: string | undefined;

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'kopt-doctor-test-')));
  prevCache = process.env.KOPT_CACHE_DIR;
  process.env.KOPT_CACHE_DIR = join(tmp, 'cache');
});

afterAll(() => {
  if (prevCache === undefined) delete process.env.KOPT_CACHE_DIR;
  else process.env.KOPT_CACHE_DIR = prevCache;
  rmSync(tmp, { recursive: true, force: true });
});

function box(name: string): { h: HostEnv; repo: string; home: string } {
  const home = join(tmp, name, 'home');
  const repo = join(tmp, name, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(home, { recursive: true });
  const ide = join(tmp, name, 'ide', 'resources', 'app', 'package.json');
  mkdirSync(dirname(ide), { recursive: true });
  writeFileSync(ide, JSON.stringify({ name: 'Kiro', version: '1.2.56' }));
  const cli = join(tmp, name, 'bin', 'kiro-cli');
  mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(cli, '#!/bin/sh\necho "kiro-cli 2.28.0"\n');
  chmodSync(cli, 0o755);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    KOPT_HOME: join(home, '.kopt'),
    KOPT_CACHE_DIR: join(tmp, 'cache'),
    KOPT_KIRO_IDE_PATHS: ide,
    KOPT_KIRO_CLI: cli,
    SystemRoot: process.env.SystemRoot,
    ComSpec: process.env.ComSpec,
  };
  return { h: { platform: process.platform, env, home }, repo, home };
}

describe('kopt doctor', () => {
  it('passes every check after setup: silent allow path, exit-2 block path, MCP server with 4 tools', async () => {
    const b = box('healthy');
    await setupUser({ h: b.h, command: CMD, noInstallStep: true, runVersion: () => 'kiro-cli 2.28.0' });
    const report = await runDoctor({ h: b.h, cwd: b.repo, runVersion: () => 'kiro-cli 2.28.0', validateWithCli: false, timeoutMs: 30_000 });
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    const text = formatChecks(report.checks);
    for (const id of ['node', 'ide', 'cli', 'mcp.json', 'hooks', 'agent', 'default-agent', 'steering', 'kiroignore', 'ide-settings', 'hook-allow', 'hook-block', 'hook-stop', 'mcp', 'hook-command']) {
      expect(byId[id]?.status, `${id}\n${text}`).toBe('ok');
    }
    expect(byId['hook-allow'].message).toMatch(/exit 0, no output/);
    // run like a Kiro started from the Dock / Start menu: no shell-profile PATH
    expect(byId['hook-allow'].message).toMatch(process.platform === 'win32' ? /system PATH only/ : /PATH=\/usr\/bin:\/bin/);
    expect(byId.mcp.message).toMatch(/lists 4 tools/);
    expect(byId.index.status).toBe('warn'); // nothing indexed yet for the repo
    expect(text.split('\n')).toHaveLength(report.checks.length); // one line per check
    expect(report.ok).toBe(true);
  }, 90_000);

  it('reports a hook command that prints on the allow path (it would intercept tools in Kiro) and a missing MCP entry', async () => {
    const b = box('noisy');
    await setupUser({ h: b.h, command: CMD, noInstallStep: true, runVersion: () => 'kiro-cli 2.28.0' });
    const hooksFile = join(b.home, '.kiro', 'hooks', 'kopt.json');
    const hooks = JSON.parse(readFileSync(hooksFile, 'utf8'));
    for (const x of hooks.hooks) x.action.command = 'echo hello';
    writeFileSync(hooksFile, JSON.stringify(hooks));
    writeFileSync(join(b.home, '.kiro', 'settings', 'mcp.json'), JSON.stringify({ mcpServers: {} }));
    const report = await runDoctor({ h: b.h, cwd: b.repo, runVersion: () => 'kiro-cli 2.28.0', validateWithCli: false, timeoutMs: 30_000 });
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    expect(byId['hook-allow'].status).toBe('fail');
    // reported as printed: cmd.exe's echo ends the line with CRLF
    expect(byId['hook-allow'].message).toMatch(/stdout "hello(\\r)?\\n"/);
    expect(byId['hook-allow'].fix).toMatch(/intercepts tool calls/);
    expect(byId['hook-block'].status).toBe('fail');
    expect(byId['mcp.json'].status).toBe('fail');
    expect(byId['mcp.json'].fix).toBe('run kopt setup');
    expect(report.ok).toBe(false);
  }, 90_000);

  it('reports the index size on disk, and a build that failed after the last good one', async () => {
    const b = box('index-state');
    const { Store } = await import('../src/store/store.js');
    const { indexPath, loadConfig } = await import('../src/core/config.js');
    const cfg = loadConfig(b.repo);
    const store = Store.open(indexPath(cfg));
    store.setMeta('indexed_at', String(Date.now() - 60_000));
    store.close();
    const index = async () => (await runDoctor({ h: b.h, cwd: b.repo, runVersion: () => 'kiro-cli 2.28.0', skipProcesses: true })).checks.find((c) => c.id === 'index')!;
    const ok = await index();
    expect(ok.status).toBe('ok');
    expect(ok.message).toMatch(/^index: 0 files, 0 symbols, updated .* ago, \d+ MB on disk \(/);
    writeFileSync(join(cfg.dataDir, 'last-error.json'), JSON.stringify({ at: Date.now(), message: 'Maximum call stack size exceeded', attempts: 2 }));
    const failed = await index();
    expect(failed.status).toBe('fail');
    expect(failed.message).toMatch(/^index: the last build failed .* ago: Maximum call stack size exceeded/);
    expect(failed.fix).toMatch(/kopt index/);
  });

  it('quick mode starts no process', async () => {
    const b = box('quick');
    const report = await runDoctor({ h: b.h, cwd: b.repo, runVersion: () => 'kiro-cli 2.28.0', skipProcesses: true });
    expect(report.checks.find((c) => c.id === 'hook-allow')).toBeUndefined();
    expect(report.checks.find((c) => c.id === 'mcp.json')?.status).toBe('fail'); // setup never ran here
  });

  it('fails commands that need PATH (bare kopt) and a Stop hook that exits non-zero, with the minimal environment', async () => {
    const b = box('path-dependent');
    // the old setup form: bare `kopt` everywhere (works in a terminal with nvm, not in a Dock-started Kiro)
    const shim: KoptCommand = { shell: 'kopt', mcp: { command: 'kopt', args: ['mcp'] }, kind: 'shim' };
    await setupUser({ h: b.h, command: shim, noInstallStep: true, runVersion: () => 'kiro-cli 2.28.0' });
    const hooksFile = join(b.home, '.kiro', 'hooks', 'kopt.json');
    const report = await runDoctor({ h: b.h, cwd: b.repo, runVersion: () => 'kiro-cli 2.28.0', validateWithCli: false, timeoutMs: 30_000 });
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    expect(byId['hook-command'].status).toBe('fail');
    expect(byId['hook-command'].message).toMatch(/looked up on PATH/);
    expect(byId['mcp-command'].status).toBe('fail');
    expect(byId['hook-allow'].status).toBe('fail');
    expect(byId.mcp.status).toBe('fail');
    expect(report.ok).toBe(false);

    // a Stop hook that exits 1 would make Kiro IDE 1.x continue the agent, turn after turn
    await setupUser({ h: b.h, command: CMD, noInstallStep: true, runVersion: () => 'kiro-cli 2.28.0' });
    const hooks = JSON.parse(readFileSync(hooksFile, 'utf8'));
    hooks.hooks.find((x: any) => x.trigger === 'Stop').action.command = 'exit 1';
    writeFileSync(hooksFile, JSON.stringify(hooks));
    const stop = (await runDoctor({ h: b.h, cwd: b.repo, runVersion: () => 'kiro-cli 2.28.0', validateWithCli: false, timeoutMs: 30_000 })).checks.find((c) => c.id === 'hook-stop' && /global/.test(c.message));
    expect(stop?.status).toBe('fail');
    expect(stop?.message).toMatch(/continue the agent/);
  }, 120_000);
});
