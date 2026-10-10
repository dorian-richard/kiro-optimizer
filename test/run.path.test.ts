// kopt_run under the minimal environment a Kiro started from the Dock may give its MCP servers (acceptance test of
// v0.2.0: `npm test` exited 127 with no hint). The command PATH adds the folder of kopt's Node, the login shell's
// PATH and common bin folders; a command that still is not found gets one line naming it and the PATH sources.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/core/config.js';
import { newToolContext } from '../src/core/context.js';
import { runCommand } from '../src/compress/index.js';
import { commandPath, execCapture, missingProgram, notFoundHint, nvmDefaultBin, readLoginShellPath } from '../src/compress/runner.js';

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

