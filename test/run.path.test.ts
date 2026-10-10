// kopt_run under the minimal environment a Kiro started from the Dock may give its MCP servers (acceptance test of
// v0.2.0: `npm test` exited 127 with no hint). The command PATH adds the folder of kopt's Node, the login shell's
// PATH and common bin folders; a command that still is not found gets one line naming it and the PATH sources.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { defaultConfig } from '../src/core/config.js';
import { newToolContext } from '../src/core/context.js';
import { runCommand } from '../src/compress/index.js';
import { commandPath, execCapture, missingProgram, notFoundHint, nvmDefaultBin, readLoginShellPath } from '../src/compress/runner.js';
import { koptRunTurnedOff } from '../src/kiro/mcpentry.js';

const WIN = process.platform === 'win32';
const ROOT = resolve(__dirname, '..');
const CLI = join(ROOT, 'src', 'cli.ts');
const dirs: string[] = [];
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `kopt-${prefix}-`));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('commandPath', () => {
  const home = '/Users/dev';
  const present = new Set(['/opt/homebrew/bin', '/usr/local/bin', '/Users/dev/.local/bin', '/Users/dev/.nvm/versions/node/v22.23.3/bin']);
  const nvm = {
    readText: (p: string) => ({ '/Users/dev/.nvm/alias/default': 'lts/*\n', '/Users/dev/.nvm/alias/lts/*': 'lts/jod\n', '/Users/dev/.nvm/alias/lts/jod': 'v22.23.3\n' })[p],
    listDir: (p: string) => (p === '/Users/dev/.nvm/versions/node' ? ['v20.19.0', 'v22.23.3', 'v22.9.0'] : []),
  };

  it('server PATH, then kopt\'s Node folder, then the login shell PATH, then common folders, without duplicates', () => {
    const cp = commandPath({
      platform: 'darwin',
      env: { PATH: '/usr/bin:/bin:/usr/bin/' },
      execPath: '/Users/dev/.nvm/versions/node/v22.23.3/bin/node',
      login: { shell: '/bin/zsh', path: '/opt/homebrew/bin:/usr/bin:/Users/dev/.cargo/bin' },
      home,
      isDir: (p) => present.has(p),
      ...nvm,
    });
    expect(cp.path).toBe(
      ['/usr/bin', '/bin', '/Users/dev/.nvm/versions/node/v22.23.3/bin', '/opt/homebrew/bin', '/Users/dev/.cargo/bin', '/usr/local/bin', '/Users/dev/.local/bin'].join(':'),
    );
    expect(cp.sources).toEqual(["kopt's PATH", "kopt's Node folder", '/bin/zsh login PATH', '/usr/local/bin, /Users/dev/.local/bin']);
  });

  it('an empty PATH starts from the system folders; a login shell that gave nothing is named as such', () => {
    const cp = commandPath({ platform: 'linux', env: {}, execPath: '/opt/node/bin/node', login: { shell: '/bin/bash' }, home, isDir: () => false, readText: () => undefined, listDir: () => [] });
    expect(cp.path).toBe('/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/node/bin');
    expect(cp.sources).toEqual(['system folders (kopt got no PATH)', "kopt's Node folder", 'no /bin/bash login PATH (unreadable)']);
  });

  it('Windows keeps the inherited PATH', () => {
    expect(commandPath({ platform: 'win32', env: { PATH: 'C:\\Windows' } }).path).toBeUndefined();
  });

  it('nvm: the default alias is followed (lts/*, a major version) to an installed Node', () => {
    expect(nvmDefaultBin('/Users/dev/.nvm', nvm.readText, nvm.listDir)).toBe('/Users/dev/.nvm/versions/node/v22.23.3/bin');
    const major = (p: string) => (p.endsWith('/alias/default') ? '22' : undefined);
    expect(nvmDefaultBin('/n', major, () => ['v22.9.0', 'v22.10.1', 'v23.0.0'])).toBe('/n/versions/node/v22.10.1/bin');
    expect(nvmDefaultBin('/n', () => undefined, () => ['v22.9.0'])).toBeUndefined();
    expect(nvmDefaultBin('/n', (p) => (p.endsWith('default') ? '../../etc' : undefined), () => [])).toBeUndefined();
  });
});

describe.skipIf(WIN)('login shell PATH', () => {
  function fakeShell(body: string): string {
    const f = join(tempDir('shell'), 'fakesh');
    writeFileSync(f, `#!/bin/sh\n${body}\n`);
    chmodSync(f, 0o755);
    return f;
  }

  it('reads PATH between markers and ignores whatever the profile prints', async () => {
    const sh = fakeShell('echo "Welcome! motd noise"; echo "rc: warning" >&2; PATH=/fake/bin:/usr/bin; export PATH; eval "$2"');
    expect(await readLoginShellPath(sh)).toEqual({ shell: sh, path: '/fake/bin:/usr/bin' });
  });

  it('a shell that hangs or fails gives no PATH, within the timeout', async () => {
    const t0 = Date.now();
    const hang = fakeShell('sleep 30');
    expect(await readLoginShellPath(hang, 300)).toEqual({ shell: hang, path: undefined });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(await readLoginShellPath(fakeShell('exit 3'))).toEqual({ shell: expect.any(String), path: undefined });
    expect(await readLoginShellPath('/nonexistent/shell')).toEqual({ shell: '/nonexistent/shell' });
  });

  // Acceptance test of v0.2.1: a profile starting a background job (`cmd &`) that keeps stdout open made the read
  // wait for the timeout, report the PATH as unreadable, and kill the job with the shell's process group.
  it('a profile that leaves a background job on stdout: the PATH as soon as it is printed, the job left running', async () => {
    const pidFile = join(tempDir('bgjob'), 'bg.pid');
    const sh = fakeShell(`sh -c 'echo $$ > "${pidFile}"; exec sleep 30' &\nPATH=/bg/bin:/usr/bin; export PATH; eval "$2"`);
    const t0 = Date.now();
    expect(await readLoginShellPath(sh, 3000)).toEqual({ shell: sh, path: '/bg/bin:/usr/bin' });
    expect(Date.now() - t0).toBeLessThan(2000);
    let pid = 0;
    for (let i = 0; i < 100 && !pid; i++) {
      pid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8').trim()) || 0 : 0;
      if (!pid) await new Promise((r) => setTimeout(r, 20));
    }
    expect(pid).toBeGreaterThan(0);
    try {
      await new Promise((r) => setTimeout(r, 200));
      expect(() => process.kill(pid, 0)).not.toThrow(); // still running
    } finally {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  });
});

// The login shell runs the user's interactive profile (up to 3 s): only where kopt_run may need its PATH.
describe.skipIf(WIN)('the login shell starts only when kopt_run may need it', () => {
  const tsx = join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');
  /** A fake login shell that records each start. */
  function markerShell(): { sh: string; marker: string } {
    const dir = tempDir('markersh');
    const marker = join(dir, 'started');
    const sh = join(dir, 'fakesh');
    writeFileSync(sh, `#!/bin/sh\necho started >> "${marker}"\nPATH=/marker/bin:/usr/bin; export PATH; eval "$2"\n`);
    chmodSync(sh, 0o755);
    return { sh, marker };
  }
  function boxEnv(extra: Record<string, string>): Record<string, string> {
    const box = tempDir('loginsh-home');
    const e: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^KOPT_(LOGIN_PATH|DISABLE_RUN|SESSION|ROOT)$/.test(k)) e[k] = v;
    return { ...e, HOME: box, KOPT_HOME: join(box, '.kopt'), KOPT_CACHE_DIR: join(box, 'cache'), KOPT_KIRO_HOME: join(box, '.kiro'), KOPT_TELEMETRY: '0', ...extra };
  }
  function project(mcpEntry?: Record<string, unknown>): string {
    const repo = tempDir('loginsh-repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, 'README.md'), '# demo\n');
    if (mcpEntry) {
      mkdirSync(join(repo, '.kiro', 'settings'), { recursive: true });
      writeFileSync(join(repo, '.kiro', 'settings', 'mcp.json'), JSON.stringify({ mcpServers: { kopt: mcpEntry } }));
    }
    return repo;
  }

  it('kopt run (CLI): not started, the terminal PATH is the user\'s; KOPT_LOGIN_PATH=1 starts it', () => {
    const repo = project();
    const { sh, marker } = markerShell();
    const run = (extra: Record<string, string>) =>
      spawnSync(process.execPath, ['--no-warnings', '--import', tsx, CLI, 'run', '--root', repo, 'node', '-e', 'process.exit(0)'], {
        cwd: ROOT,
        env: boxEnv({ SHELL: sh, ...extra }),
        encoding: 'utf8',
        timeout: 60_000,
      });
    const r = run({});
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(run({ KOPT_LOGIN_PATH: '1' }).status).toBe(0);
    expect(existsSync(marker)).toBe(true);
  });

  it('kopt mcp: started at start-up, not when kopt_run is turned off (KOPT_DISABLE_RUN=1, disabledTools)', async () => {
    const serve = async (args: string[], cwd: string, extra: Record<string, string>) => {
      const { sh, marker } = markerShell();
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ['--no-warnings', '--import', tsx, CLI, 'mcp', ...args],
        cwd,
        env: boxEnv({ SHELL: sh, KOPT_INDEX_ON_START: '0', ...extra }),
        stderr: 'pipe',
      });
      const client = new Client({ name: 'test', version: '0' });
      await client.connect(transport);
      // answered once the project root is decided (the user-level server warms up then)
      await client.callTool({ name: 'kopt_expand', arguments: { handle: 'o0000000' } });
      return { client, marker };
    };
    const on = project();
    const off = project({ command: 'kopt', args: ['mcp'], disabledTools: ['kopt_run'] });
    const servers = await Promise.all([
      serve(['--root', on], ROOT, {}),
      serve([], on, {}),
      serve(['--root', on], ROOT, { KOPT_DISABLE_RUN: '1' }),
      serve([], off, {}),
    ]);
    try {
      for (const s of servers.slice(0, 2)) {
        for (let i = 0; i < 250 && !existsSync(s.marker); i++) await new Promise((r) => setTimeout(r, 20));
        expect(existsSync(s.marker)).toBe(true);
      }
      await new Promise((r) => setTimeout(r, 300));
      for (const s of servers.slice(2)) expect(existsSync(s.marker)).toBe(false);
    } finally {
      await Promise.all(servers.map((s) => s.client.close().catch(() => {})));
    }
  });

  it('koptRunTurnedOff: the server environment, then the kopt entry of mcp.json; no entry found counts as on', () => {
    expect(koptRunTurnedOff(project(), { KOPT_DISABLE_RUN: '1' })).toBe(true);
    expect(koptRunTurnedOff(project({ command: 'kopt', disabledTools: ['mcp_kopt_kopt_run'] }), {})).toBe(true);
    expect(koptRunTurnedOff(project({ command: 'kopt', env: { KOPT_DISABLE_RUN: '1' } }), {})).toBe(true);
    expect(koptRunTurnedOff(project({ command: 'kopt', disabled: true }), {})).toBe(true);
    expect(koptRunTurnedOff(project({ command: 'kopt', disabledTools: ['kopt_find'] }), {})).toBe(false);
  });
});

describe.skipIf(WIN)('minimal environment (Kiro started from the Dock)', () => {
  it('kopt run finds node and npm with PATH=/usr/bin:/bin', () => {
    const repo = tempDir('minpath');
    const box = tempDir('minpath-home');
    const env = {
      HOME: box,
      PATH: '/usr/bin:/bin',
      KOPT_HOME: join(box, '.kopt'),
      KOPT_CACHE_DIR: join(box, 'cache'),
      KOPT_KIRO_HOME: join(box, '.kiro'),
      KOPT_TELEMETRY: '0',
      TMPDIR: tmpdir(),
    };
    // tsx is loaded by absolute path: the minimal PATH is the point of the test
    const tsx = join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');
    const run = (...args: string[]) =>
      spawnSync(process.execPath, ['--no-warnings', '--import', tsx, CLI, 'run', '--root', repo, ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 });
    const node = run('node', '-e', 'process.exit(3)');
    expect(node.stdout).not.toMatch(/not found/);
    expect(node.status).toBe(3);
    const npm = run('npm', '--version');
    expect(npm.stdout, npm.stdout + npm.stderr).toMatch(/^exit 0\n\d+\.\d+\.\d+/);
    expect(npm.status).toBe(0);
  });

  it('execCapture adds the folder of kopt\'s Node to a minimal PATH (login shell PATH off)', async () => {
    const prev = { PATH: process.env.PATH, KOPT_LOGIN_PATH: process.env.KOPT_LOGIN_PATH };
    process.env.PATH = '/usr/bin:/bin';
    process.env.KOPT_LOGIN_PATH = '0';
    try {
      const r = await execCapture({ command: 'node -e "process.exit(4)"', cwd: tmpdir(), timeoutMs: 30_000 });
      expect(r.exitCode, r.output).toBe(4);
      expect(r.pathSources).toContain("kopt's Node folder");
    } finally {
      process.env.PATH = prev.PATH;
      if (prev.KOPT_LOGIN_PATH === undefined) delete process.env.KOPT_LOGIN_PATH;
      else process.env.KOPT_LOGIN_PATH = prev.KOPT_LOGIN_PATH;
    }
  });
});

describe('a command that is not found', () => {
  it('kopt_run adds one line naming the program and where the PATH came from', async () => {
    const root = tempDir('notfound');
    const cfg = defaultConfig(root);
    cfg.dataDir = join(root, '.kopt');
    const r = await runCommand({ command: 'definitely-not-a-command-kopt --flag' }, newToolContext(cfg));
    expect(r.meta?.exitCode).toBe(127);
    const last = r.text.split('\n').pop()!;
    expect(last).toMatch(/^kopt: "definitely-not-a-command-kopt" not found on kopt_run's PATH \(kopt's PATH[^)]*\); install it/);
    expect(r.text.split('\n').filter((l) => l.startsWith('kopt: '))).toHaveLength(1);
    expect(r.meta?.notFound).toBe(true);
  });

  it('names the program the shell reports (a tool missing inside an npm script, any shell)', () => {
    const cases: Array<[string, string]> = [
      ['bash: npm: command not found', 'npm'],
      ['/bin/bash: line 1: mvn: command not found', 'mvn'],
      ['sh: 1: jest: not found', 'jest'],
      ['zsh:1: command not found: gradle', 'gradle'],
      ['env: node: No such file or directory', 'node'],
      ["/usr/bin/env: 'python3': No such file or directory", 'python3'],
      ["npm: The term 'npm' is not recognized as a name of a cmdlet, function, script file, or executable program.", 'npm'],
      ["'pnpm' is not recognized as an internal or external command,", 'pnpm'],
    ];
    for (const [out, prog] of cases) expect(missingProgram('npm test', `> x\n${out}\n`), out).toBe(prog);
    expect(missingProgram('FOO=1 BAR=2 tool --x', '')).toBe('tool');
    expect(missingProgram("& 'C:\\x\\tool.exe' a", '')).toBe('C:\\x\\tool.exe');
  });

  it('only for 127 (and 9009 from cmd.exe on Windows), never for a timeout', () => {
    const res = { exitCode: 127, output: 'sh: 1: jest: not found', timedOut: false, pathSources: ["kopt's PATH", "kopt's Node folder"] };
    expect(notFoundHint('npm test', res, 'linux')).toBe(
      `kopt: "jest" not found on kopt_run's PATH (kopt's PATH + kopt's Node folder); install it, or add its folder to the "env" PATH of the kopt server (~/.kiro/settings/mcp.json)`,
    );
    expect(notFoundHint('npm test', { ...res, exitCode: 1 }, 'linux')).toBeUndefined();
    expect(notFoundHint('npm test', { ...res, timedOut: true }, 'linux')).toBeUndefined();
    expect(notFoundHint('npm test', { ...res, exitCode: 9009, output: "'npm' is not recognized as an internal or external command," }, 'win32')).toMatch(/^kopt: "npm" not found .*restart Kiro$/);
    expect(notFoundHint('npm test', { ...res, exitCode: 9009 }, 'linux')).toBeUndefined();
  });

  it.runIf(WIN)('Windows: cmd.exe exit 9009 gets the hint too', async () => {
    const prev = process.env.KOPT_SHELL;
    process.env.KOPT_SHELL = process.env.ComSpec || 'cmd.exe';
    try {
      const root = tempDir('notfound-cmd');
      const cfg = defaultConfig(root);
      cfg.dataDir = join(root, '.kopt');
      const r = await runCommand({ command: 'definitely-not-a-command-kopt' }, newToolContext(cfg));
      expect(r.meta?.exitCode).toBe(9009);
      expect(r.text).toMatch(/kopt: "definitely-not-a-command-kopt" not found on kopt_run's PATH/);
    } finally {
      if (prev === undefined) delete process.env.KOPT_SHELL;
      else process.env.KOPT_SHELL = prev;
    }
  });
});

