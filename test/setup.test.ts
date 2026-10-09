// kopt setup / uninstall / legacy IDE hooks / cache-dir data dir, all in temp HOMEs (never the real ~/.kiro, ~/.kopt,
// Kiro settings or npm prefix). The generated CLI 2.x agent is validated with the real kiro-cli when it is installed,
// in a temp HOME.

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, sep, win32 } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cacheRoot, defaultConfig, findProjectRoot, isUnsafeRoot, loadConfig, repoCacheKey, usesProjectDataDir } from '../src/core/config.js';
import { binPath, hookCommandLine, resolveKoptCommand, shellArg, type KoptCommand } from '../src/kiro/command.js';
import { detectCli, detectIde, hookPlan } from '../src/kiro/detect.js';
import { ensureLegacyWorkspaceHooks, legacyHookFiles, legacyHooksWanted, removeLegacyWorkspaceHooks } from '../src/kiro/legacy.js';
import { ideCandidates, kiroCliSettingsPath, kiroHomeDir, kiroUserSettingsPath, which, type HostEnv } from '../src/kiro/paths.js';
import { AUTO_APPROVE, defaultNpmRunner, globalInstall, setupUser } from '../src/kiro/setup.js';
import { uninstallKiro } from '../src/kiro/uninstall.js';
import { installKiro } from '../src/kiro/index.js';
import { childEnv, isInside, rmTree } from './helpers/fs.js';

let tmp: string;
const savedEnv: Record<string, string | undefined> = {};
const SHIM: KoptCommand = { shell: 'kopt', mcp: { command: 'kopt', args: ['mcp'] }, kind: 'shim' };
const run = () => 'kiro-cli 2.28.0\n';

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'kopt-setup-')));
  for (const k of ['KOPT_CACHE_DIR', 'KOPT_DATA_DIR', 'KOPT_HOME', 'KOPT_KIRO_HOME', 'KIRO_HOME', 'KOPT_LEGACY_WORKSPACE_HOOKS']) savedEnv[k] = process.env[k];
  process.env.KOPT_CACHE_DIR = join(tmp, 'cache');
  process.env.KOPT_HOME = join(tmp, 'kopt-home');
  delete process.env.KOPT_DATA_DIR;
  delete process.env.KOPT_KIRO_HOME;
  delete process.env.KIRO_HOME;
  delete process.env.KOPT_LEGACY_WORKSPACE_HOOKS;
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmTree(tmp);
});

interface Box {
  home: string;
  h: HostEnv;
  kiro: string;
}

/** A fake machine: temp HOME, optional Kiro IDE (package.json) and Kiro CLI (fake executable). */
function sandbox(name: string, o: { ide?: string; cli?: boolean; platform?: NodeJS.Platform; env?: Record<string, string> } = {}): Box {
  const base = join(tmp, name);
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  let ideList = '';
  if (o.ide) {
    const pkg = join(base, 'ide', 'resources', 'app', 'package.json');
    mkdirSync(dirname(pkg), { recursive: true });
    writeFileSync(pkg, JSON.stringify({ name: 'Kiro', version: o.ide }));
    ideList = pkg;
  }
  let cli = 'none';
  if (o.cli) {
    cli = join(base, 'bin', 'kiro-cli');
    mkdirSync(dirname(cli), { recursive: true });
    writeFileSync(cli, '#!/bin/sh\necho "kiro-cli 2.28.0"\n');
    chmodSync(cli, 0o755);
  }
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    KOPT_HOME: join(home, '.kopt'),
    KOPT_CACHE_DIR: join(base, 'cache'),
    KOPT_KIRO_IDE_PATHS: ideList,
    KOPT_KIRO_CLI: cli,
    ...o.env,
  };
  const h: HostEnv = { platform: o.platform ?? (process.platform === 'win32' ? 'win32' : process.platform), env, home };
  return { home, h, kiro: join(home, '.kiro') };
}

const read = (p: string) => readFileSync(p, 'utf8');
const json = (p: string) => JSON.parse(read(p));
const put = (p: string, s: string) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, s);
};

function gitRepo(name: string): string {
  const root = join(tmp, name);
  mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
  return root;
}

describe('data dir outside the repository', () => {
  it('computes the per-OS cache root (KOPT_CACHE_DIR overrides)', () => {
    expect(cacheRoot({ platform: 'darwin', env: {}, home: '/Users/u' })).toBe('/Users/u/Library/Caches/kopt');
    expect(cacheRoot({ platform: 'linux', env: {}, home: '/home/u' })).toBe('/home/u/.cache/kopt');
    expect(cacheRoot({ platform: 'linux', env: { XDG_CACHE_HOME: '/xdg' }, home: '/home/u' })).toBe('/xdg/kopt');
    expect(cacheRoot({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, home: 'C:\\Users\\u' })).toBe('C:\\Users\\u\\AppData\\Local\\kopt');
    expect(cacheRoot({ platform: 'win32', env: {}, home: 'C:\\Users\\u' })).toBe('C:\\Users\\u\\AppData\\Local\\kopt');
    expect(cacheRoot({ platform: 'linux', env: { KOPT_CACHE_DIR: '/c' }, home: '/home/u' })).toBe('/c');
  });

  it('keys the index by the canonical root and keeps nothing in the repo', () => {
    const root = gitRepo('cache-repo');
    const cfg = defaultConfig(root);
    expect(cfg.dataDir.startsWith(join(tmp, 'cache') + sep)).toBe(true);
    expect(cfg.dataDir).toMatch(/cache-repo-[0-9a-f]{8}$/);
    expect(usesProjectDataDir(cfg)).toBe(false);
    // a symlinked spelling of the same folder shares the index
    const link = join(tmp, 'cache-link');
    symlinkSync(root, link, 'junction'); // a junction on Windows (no privilege needed); the type is ignored elsewhere
    expect(defaultConfig(link).dataDir).toBe(cfg.dataDir);
    expect(repoCacheKey('C:\\Repos\\App', 'win32')).toBe(repoCacheKey('c:/repos/app', 'win32'));
    expect(existsSync(join(root, '.kopt'))).toBe(false);
  });

  it('keeps per-project mode when <root>/.kopt exists, and honours KOPT_DATA_DIR and config files', () => {
    const root = gitRepo('perproject');
    mkdirSync(join(root, '.kopt'));
    expect(defaultConfig(root).dataDir).toBe(join(root, '.kopt'));
    expect(usesProjectDataDir(defaultConfig(root))).toBe(true);
    const other = gitRepo('cfgfile');
    writeFileSync(join(other, 'kopt.config.json'), JSON.stringify({ dataDir: 'var/kopt' }));
    expect(loadConfig(other).dataDir).toBe(join(other, 'var', 'kopt'));
    process.env.KOPT_DATA_DIR = join(tmp, 'explicit');
    try {
      expect(loadConfig(other).dataDir).toBe(join(tmp, 'explicit'));
    } finally {
      delete process.env.KOPT_DATA_DIR;
    }
    // ~/.kopt is the user dir, never a project's data dir
    expect(defaultConfig(homedir()).dataDir).not.toBe(join(homedir(), '.kopt'));
  });

  it('finds the project root from a sub-folder and refuses home / filesystem roots', () => {
    const root = gitRepo('projroot');
    mkdirSync(join(root, 'src', 'deep'), { recursive: true });
    expect(findProjectRoot(join(root, 'src', 'deep'))).toBe(root);
    const fakeHome = join(tmp, 'fakehome');
    mkdirSync(join(fakeHome, '.git'), { recursive: true }); // a dotfiles repo in HOME
    mkdirSync(join(fakeHome, 'proj', 'x'), { recursive: true });
    expect(findProjectRoot(join(fakeHome, 'proj', 'x'), fakeHome)).toBe(join(fakeHome, 'proj', 'x'));
    expect(isUnsafeRoot(fakeHome, fakeHome)).toBe(true);
    expect(isUnsafeRoot('/', fakeHome)).toBe(true);
    expect(isUnsafeRoot(root, fakeHome)).toBe(false);
  });
});

describe('paths and surface detection per OS', () => {
  it('knows the Kiro user settings and install locations on macOS, Linux and Windows', () => {
    expect(kiroUserSettingsPath({ platform: 'darwin', env: {}, home: '/Users/u' })).toBe('/Users/u/Library/Application Support/Kiro/User/settings.json');
    expect(kiroUserSettingsPath({ platform: 'linux', env: {}, home: '/home/u' })).toBe('/home/u/.config/Kiro/User/settings.json');
    expect(kiroUserSettingsPath({ platform: 'linux', env: { XDG_CONFIG_HOME: '/cfg' }, home: '/home/u' })).toBe('/cfg/Kiro/User/settings.json');
    expect(kiroUserSettingsPath({ platform: 'win32', env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, home: 'C:\\Users\\u' })).toBe('C:\\Users\\u\\AppData\\Roaming\\Kiro\\User\\settings.json');
    expect(kiroHomeDir({ platform: 'win32', env: {}, home: 'C:\\Users\\u' })).toBe('C:\\Users\\u\\.kiro');
    expect(kiroHomeDir({ platform: 'linux', env: { KIRO_HOME: '/k' }, home: '/home/u' })).toBe('/k');
    expect(kiroCliSettingsPath({ platform: 'linux', env: {}, home: '/home/u' })).toBe('/home/u/.kiro/settings/cli.json');
    const win = ideCandidates({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', ProgramFiles: 'C:\\Program Files', PATH: '' }, home: 'C:\\Users\\u' });
    expect(win).toContain('C:\\Users\\u\\AppData\\Local\\Programs\\Kiro\\resources\\app\\package.json');
    expect(win).toContain('C:\\Program Files\\Kiro\\resources\\app\\package.json');
    expect(ideCandidates({ platform: 'darwin', env: { PATH: '' }, home: '/Users/u' })).toContain('/Applications/Kiro.app/Contents/Resources/app/package.json');
    expect(ideCandidates({ platform: 'linux', env: { PATH: '' }, home: '/home/u' })).toContain('/usr/share/kiro/resources/app/package.json');
  });

  it('detects the IDE version from package.json and the CLI version and engine', () => {
    const b = sandbox('detect', { ide: '0.12.318', cli: true });
    expect(detectIde(b.h)).toMatchObject({ version: '0.12.318', major: 0 });
    expect(detectCli(b.h, run)).toMatchObject({ version: '2.28.0', major: 2, engine: 'v2' });
    put(kiroCliSettingsPath(b.h), JSON.stringify({ 'chat.agentEngine': 'v3' }));
    expect(detectCli(b.h, run)?.engine).toBe('v3');
    expect(detectCli({ ...b.h, env: { ...b.h.env, KOPT_KIRO_CLI: 'none' } }, run)).toBeUndefined();
    expect(detectIde({ ...b.h, env: { ...b.h.env, KOPT_KIRO_IDE_PATHS: '' } })).toBeUndefined();
  });

  it('chooses hook formats per surface', () => {
    const ide0 = { ide: { version: '0.12.318', major: 0, path: '' } };
    const ide1 = { ide: { version: '1.2.56', major: 1, path: '' } };
    const cli2 = { cli: { version: '2.28.0', major: 2, path: '', engine: 'v2' as const } };
    const cli3 = { cli: { version: '3.0.1', major: 3, path: '', engine: 'v3' as const } };
    expect(hookPlan(ide0)).toEqual({ globalV1: true, cliAgent: false, legacyWorkspace: true });
    expect(hookPlan(ide1)).toEqual({ globalV1: true, cliAgent: false, legacyWorkspace: false });
    expect(hookPlan(cli2)).toEqual({ globalV1: true, cliAgent: true, legacyWorkspace: false });
    expect(hookPlan(cli3)).toEqual({ globalV1: true, cliAgent: false, legacyWorkspace: false });
    expect(hookPlan({ ...ide1, ...cli2 })).toEqual({ globalV1: true, cliAgent: true, legacyWorkspace: false });
    expect(hookPlan({}, 'cli')).toMatchObject({ cliAgent: true, legacyWorkspace: false });
    expect(hookPlan({}, 'all')).toMatchObject({ globalV1: true, cliAgent: true });
  });
});

describe('kopt command resolution', () => {
  it('uses the bare kopt shim when it is on PATH with Node >= 22.13, else node + bin.js', () => {
    // Real files on PATH, so the host's own platform is simulated: a Windows path (C:\...) cannot sit in a POSIX
    // PATH, whose separator is ':'. Both branches still run everywhere through the pure `force` cases below.
    const platform: NodeJS.Platform = process.platform === 'win32' ? 'win32' : 'linux';
    const win = platform === 'win32';
    const dir = join(tmp, 'shimbin');
    const npx = join(tmp, '_npx', 'abc', 'node_modules', '.bin');
    for (const d of [dir, npx]) {
      mkdirSync(d, { recursive: true });
      // what npm writes on each OS: `kopt` (sh) everywhere, plus `kopt.cmd` / `kopt.ps1` on Windows
      for (const f of win ? ['kopt', 'kopt.cmd', 'kopt.ps1'] : ['kopt']) writeFileSync(join(d, f), '#!/bin/sh\n');
      chmodSync(join(d, 'kopt'), 0o755);
    }
    const pathList = (...dirs: string[]) => dirs.join(win ? ';' : ':');
    const h = (path: string): HostEnv => ({ platform, env: { PATH: path }, home: win ? 'C:\\Users\\u' : '/home/u' });
    const bin = win ? 'C:\\kopt\\dist\\bin.js' : '/opt/kopt/dist/bin.js';
    const shim = resolveKoptCommand({ h: h(dir), bin, nodeVersion: 'v22.13.0' });
    if (win) {
      // hooks: kopt.cmd (PowerShell would pick kopt.ps1, blocked by the default execution policy);
      // MCP: node + bin.js (a native MCP client may not resolve .cmd shims)
      expect(shim).toMatchObject({ shell: 'kopt.cmd', mcp: { command: 'node', args: [bin, 'mcp'] }, kind: 'shim' });
      expect(hookCommandLine(shim, 'global')).toBe('kopt.cmd hook --source global');
    } else {
      expect(shim).toMatchObject({ shell: 'kopt', mcp: { command: 'kopt', args: ['mcp'] }, kind: 'shim' });
      expect(hookCommandLine(shim, 'global')).toBe('kopt hook --source global');
    }
    expect(shim.shimPath).toBe(join(dir, 'kopt'));
    // the npx cache disappears after the run: never configure it
    expect(resolveKoptCommand({ h: h(npx), bin, nodePath: '/usr/bin/node', nodeVersion: 'v22.13.0' }).kind).toBe('node');
    // a kopt whose node is too old falls back to an explicit node
    const spaced = win ? 'C:\\my kopt\\dist\\bin.js' : '/opt/my kopt/dist/bin.js';
    const old = resolveKoptCommand({ h: h(dir), bin: spaced, nodePath: '/usr/bin/node', nodeVersion: 'v20.17.0' });
    if (win) {
      expect(old).toMatchObject({ kind: 'node', mcp: { command: 'node', args: [spaced, 'mcp'] } });
      expect(old.shell).toBe(`node "${spaced}"`);
    } else {
      expect(old).toMatchObject({ kind: 'node', mcp: { command: '/usr/bin/node', args: [spaced, 'mcp'] } });
      expect(old.shell).toBe("/usr/bin/node '/opt/my kopt/dist/bin.js'");
    }
    expect(which('kopt', h(pathList(npx, dir)), (d) => d.includes('_npx'))).toBe(join(dir, 'kopt'));

    // POSIX and Windows command lines from any host (no PATH lookup)
    const posix = resolveKoptCommand({ h: { platform: 'linux', env: { PATH: '' }, home: '/home/u' }, bin: '/opt/my kopt/dist/bin.js', nodePath: '/usr/bin/node', force: 'node' });
    expect(posix.shell).toBe("/usr/bin/node '/opt/my kopt/dist/bin.js'");
    expect(resolveKoptCommand({ h: { platform: 'linux', env: { PATH: '' }, home: '/home/u' }, bin: '/opt/kopt/dist/bin.js', force: 'shim' })).toMatchObject({ shell: 'kopt', mcp: { command: 'kopt', args: ['mcp'] } });
    // Windows: bare `node` (valid in cmd.exe and PowerShell), MCP through node + bin.js (no .cmd shim for native clients)
    const winBin = 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\kiro-optimizer\\dist\\bin.js';
    const winNode = resolveKoptCommand({ h: { platform: 'win32', env: { PATH: '' }, home: 'C:\\Users\\u' }, bin: winBin, force: 'node' });
    expect(winNode.shell).toBe(`node "${winBin}"`);
    expect(winNode.mcp).toEqual({ command: 'node', args: [winBin, 'mcp'] });
    const winShim = resolveKoptCommand({ h: { platform: 'win32', env: { PATH: '' }, home: 'C:\\' }, bin: winBin, force: 'shim' });
    expect(winShim.mcp).toEqual({ command: 'node', args: [winBin, 'mcp'] });
    expect(winShim.shell).toBe('kopt.cmd'); // PowerShell would pick kopt.ps1, blocked by the default execution policy
    expect(shellArg('C:\\Program Files\\nodejs\\node.exe', 'win32')).toBe('"C:\\Program Files\\nodejs\\node.exe"');
    expect(binPath('C:\\x\\kiro-optimizer', 'win32')).toBe(win32.join('C:\\x\\kiro-optimizer', 'dist', 'bin.js'));
  });
});

describe('kopt setup (user level, temp HOME)', () => {
  it('writes every surface file once, merges shared files and is idempotent', async () => {
    const b = sandbox('setup-full', { ide: '1.2.56', cli: true });
    put(join(b.kiro, 'settings', 'mcp.json'), JSON.stringify({ mcpServers: { github: { url: 'https://api.github.com/mcp' } }, powers: { mcpServers: {} } }, null, 2));
    put(kiroCliSettingsPath(b.h), JSON.stringify({ 'chat.defaultModel': 'auto' }));
    const ideSettings = kiroUserSettingsPath(b.h);
    put(ideSettings, '{\n  // mine\n  "editor.tabSize": 2\n}\n');

    const r = await setupUser({ h: b.h, command: SHIM, runVersion: run, noInstallStep: true });
    expect(r.surfaces.ide?.version).toBe('1.2.56');
    expect(r.surfaces.cli?.version).toBe('2.28.0');

    const mcp = json(join(b.kiro, 'settings', 'mcp.json'));
    expect(mcp.mcpServers.github).toEqual({ url: 'https://api.github.com/mcp' });
    expect(mcp.powers).toEqual({ mcpServers: {} });
    expect(mcp.mcpServers.kopt).toEqual({ command: 'kopt', args: ['mcp'], autoApprove: AUTO_APPROVE });
    expect(mcp.mcpServers.kopt.autoApprove).not.toContain('kopt_run');

    const hooks = json(join(b.kiro, 'hooks', 'kopt.json'));
    expect(hooks.version).toBe('v1');
    expect(hooks.hooks.map((x: any) => x.trigger)).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostFileSave', 'PostFileCreate', 'PostFileDelete', 'Stop']);
    for (const x of hooks.hooks) expect(x.action).toEqual({ type: 'command', command: 'kopt hook --source global' });
    expect(hooks.hooks.find((x: any) => x.trigger === 'Stop').description).toContain('collects Kiro credit records');

    const agent = json(join(b.kiro, 'agents', 'kopt.json'));
    expect(agent.name).toBe('kopt');
    expect(agent.includeMcpJson).toBe(true);
    expect(agent).not.toHaveProperty('useLegacyMcpJson'); // kiro-cli 2.28: duplicate-field error with includeMcpJson
    expect(Object.keys(agent.hooks)).toEqual(['agentSpawn', 'userPromptSubmit', 'preToolUse', 'postToolUse', 'stop']);
    for (const list of Object.values(agent.hooks) as any[]) expect(list[0].command).toBe('kopt hook --source agent');
    expect(agent.allowedTools).toEqual(AUTO_APPROVE.map((t) => `@kopt/${t}`));
    expect(agent.resources).toBeUndefined(); // global steering is inherited by default

    expect(json(kiroCliSettingsPath(b.h))).toEqual({ 'chat.defaultModel': 'auto', 'chat.defaultAgent': 'kopt' });
    expect(json(join(b.kiro, 'agents', 'kopt-explorer.json')).tools).not.toContain('@kopt/kopt_run');
    expect(read(join(b.kiro, 'steering', 'kopt.md'))).toMatch(/^---\ninclusion: always\n---\n/);
    expect(existsSync(join(b.kiro, 'steering', 'kopt-specs.md'))).toBe(true);
    expect(read(join(b.kiro, 'settings', 'kiroignore'))).toMatch(/# >>> kopt \(generated\)[\s\S]*package-lock\.json[\s\S]*# <<< kopt\n$/);
    const vs = read(ideSettings);
    expect(vs).toContain('// mine');
    expect(vs).toContain('"kiroAgent.agentIgnoreFiles": [".kiroignore"]');

    const again = await setupUser({ h: b.h, command: SHIM, runVersion: run, noInstallStep: true });
    expect(again.written).toEqual([]);
  });

  it('keeps a different Kiro CLI default agent unless --force, keeps a remote kopt server, and supports dry runs', async () => {
    const b = sandbox('setup-keep', { cli: true });
    put(kiroCliSettingsPath(b.h), JSON.stringify({ 'chat.defaultAgent': 'my-agent' }));
    put(join(b.kiro, 'settings', 'mcp.json'), JSON.stringify({ mcpServers: { kopt: { url: 'https://kopt.example.com/mcp', oauth: { clientId: 'x' } } } }));
    const dry = await setupUser({ h: b.h, command: SHIM, runVersion: run, noInstallStep: true, dryRun: true });
    expect(dry.notes[0]).toMatch(/dry run/);
    expect(existsSync(join(b.kiro, 'hooks', 'kopt.json'))).toBe(false);

    const r = await setupUser({ h: b.h, command: SHIM, runVersion: run, noInstallStep: true });
    expect(json(kiroCliSettingsPath(b.h))['chat.defaultAgent']).toBe('my-agent');
    expect(r.notes.some((n) => n.includes('"my-agent"'))).toBe(true);
    expect(json(join(b.kiro, 'settings', 'mcp.json')).mcpServers.kopt.url).toBe('https://kopt.example.com/mcp');
    expect(existsSync(kiroUserSettingsPath(b.h))).toBe(false); // no IDE detected: IDE settings untouched

    await setupUser({ h: b.h, command: SHIM, runVersion: run, noInstallStep: true, force: true });
    expect(json(kiroCliSettingsPath(b.h))['chat.defaultAgent']).toBe('kopt');
    expect(json(join(b.kiro, 'settings', 'mcp.json')).mcpServers.kopt).toEqual({ command: 'kopt', args: ['mcp'], autoApprove: AUTO_APPROVE });
  });

  it('adds the global steering as an agent resource when the CLI does not inherit it', async () => {
    const b = sandbox('setup-resources', { cli: true });
    put(kiroCliSettingsPath(b.h), JSON.stringify({ 'chat.disableInheritingDefaultResources': true }));
    await setupUser({ h: b.h, command: SHIM, runVersion: run, noInstallStep: true });
    expect(json(join(b.kiro, 'agents', 'kopt.json')).resources).toEqual(['file://~/.kiro/steering/kopt.md']);
  });

  it('writes the Linux layout under XDG_CONFIG_HOME and uses KIRO_HOME', async () => {
    const b = sandbox('setup-linux', { ide: '1.0.0', platform: 'linux' });
    b.h.env.XDG_CONFIG_HOME = join(b.home, 'xdg');
    b.h.env.KIRO_HOME = join(b.home, 'kiro-profile');
    await setupUser({ h: b.h, command: SHIM, noInstallStep: true });
    expect(existsSync(join(b.home, 'kiro-profile', 'hooks', 'kopt.json'))).toBe(true);
    expect(existsSync(join(b.home, '.kiro'))).toBe(false);
    expect(json(join(b.home, 'xdg', 'Kiro', 'User', 'settings.json'))).toEqual({ 'kiroAgent.agentIgnoreFiles': ['.kiroignore'] });
  });

  it('configures every surface when nothing is detected', async () => {
    const b = sandbox('setup-nothing');
    const r = await setupUser({ h: b.h, command: SHIM, noInstallStep: true });
    expect(r.hooks).toMatchObject({ globalV1: true, cliAgent: true });
    expect(existsSync(join(b.kiro, 'agents', 'kopt.json'))).toBe(true);
    expect(r.notes.some((n) => /no Kiro install detected/.test(n))).toBe(true);
  });

  const chat = [join(homedir(), '.local', 'bin', 'kiro-cli-chat'), which('kiro-cli-chat') ?? ''].find((p) => p && existsSync(p));
  it.skipIf(!chat || process.platform === 'win32')('generates a CLI 2.x agent the real kiro-cli accepts and selects as default (temp HOME)', async () => {
    const b = sandbox('setup-realcli', { cli: true });
    await setupUser({ h: b.h, command: SHIM, runVersion: run, noInstallStep: true });
    const env = { PATH: process.env.PATH ?? '', HOME: b.home, XDG_CONFIG_HOME: join(b.home, '.config'), XDG_DATA_HOME: join(b.home, '.local', 'share'), XDG_STATE_HOME: join(b.home, '.local', 'state'), XDG_CACHE_HOME: join(b.home, '.cache') };
    const opts = { cwd: b.home, env, encoding: 'utf8' as const, timeout: 30_000, input: '' };
    const clean = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
    for (const f of ['kopt.json', 'kopt-explorer.json']) {
      const v = spawnSync(chat!, ['agent', 'validate', '--path', join(b.kiro, 'agents', f)], opts);
      expect(clean(`${v.stdout}${v.stderr}`), f).not.toMatch(/error|invalid/i);
    }
    const out = (args: string[]) => {
      const r = spawnSync(chat!, args, opts);
      return clean(`${r.stdout}${r.stderr}`);
    };
    const list = out(['agent', 'list']);
    expect(list).toMatch(/^\* kopt\s/m);
    const mcp = out(['mcp', 'list']);
    expect(mcp).toMatch(/kopt\s+kopt/);
  }, 60_000);
});

describe('kopt uninstall', () => {
  it('removes exactly what setup wrote, keeps everything else, and is idempotent', async () => {
    const b = sandbox('uninstall', { ide: '1.2.56', cli: true });
    put(join(b.kiro, 'settings', 'mcp.json'), JSON.stringify({ mcpServers: { github: { url: 'https://g' } } }));
    put(join(b.kiro, 'settings', 'kiroignore'), '# mine\n.env\n');
    put(join(b.kiro, 'steering', 'team.md'), '# team rules\n');
    put(join(b.kiro, 'hooks', 'lint.json'), '{"version":"v1","hooks":[]}');
    put(kiroCliSettingsPath(b.h), JSON.stringify({ 'chat.defaultModel': 'auto' }));
    put(kiroUserSettingsPath(b.h), JSON.stringify({ 'kiroAgent.agentIgnoreFiles': ['.gitignore'] }));
    await setupUser({ h: b.h, command: SHIM, runVersion: run, noInstallStep: true });
    mkdirSync(join(b.h.env.KOPT_CACHE_DIR!, 'repo-12345678'), { recursive: true });

    const r = await uninstallKiro({ h: b.h, scope: 'user' });
    expect(r.removed!.length).toBeGreaterThanOrEqual(6);
    expect(json(join(b.kiro, 'settings', 'mcp.json'))).toEqual({ mcpServers: { github: { url: 'https://g' } } });
    expect(read(join(b.kiro, 'settings', 'kiroignore'))).toBe('# mine\n.env\n');
    for (const rel of [['hooks', 'kopt.json'], ['agents', 'kopt.json'], ['agents', 'kopt-explorer.json'], ['steering', 'kopt.md'], ['steering', 'kopt-specs.md']]) {
      expect(existsSync(join(b.kiro, ...rel)), rel.join('/')).toBe(false);
    }
    expect(read(join(b.kiro, 'steering', 'team.md'))).toBe('# team rules\n');
    expect(existsSync(join(b.kiro, 'hooks', 'lint.json'))).toBe(true);
    expect(json(kiroCliSettingsPath(b.h))).toEqual({ 'chat.defaultModel': 'auto' });
    expect(json(kiroUserSettingsPath(b.h))).toEqual({ 'kiroAgent.agentIgnoreFiles': ['.gitignore'] });
    expect(existsSync(b.h.env.KOPT_CACHE_DIR!)).toBe(false);

    const again = await uninstallKiro({ h: b.h, scope: 'user' });
    expect(again.removed).toEqual([]);
    expect(again.written).toEqual([]);
  });

  it('returns a fresh HOME to its pre-setup state (files and folders setup created are removed again)', async () => {
    const b = sandbox('uninstall-fresh', { ide: '1.2.56', cli: true });
    const tree = (dir: string): string[] => {
      const out: string[] = [];
      const walk = (d: string, rel: string) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          out.push(rel + e.name + (e.isDirectory() ? '/' : ''));
          if (e.isDirectory()) walk(join(d, e.name), rel + e.name + '/');
        }
      };
      walk(dir, '');
      return out.sort();
    };
    expect(tree(b.home)).toEqual([]);
    await setupUser({ h: b.h, command: SHIM, runVersion: run, noInstallStep: true });
    expect(tree(b.home)).toContain('.kiro/settings/mcp.json');
    expect(existsSync(kiroUserSettingsPath(b.h))).toBe(true);
    const r = await uninstallKiro({ h: b.h, scope: 'user', purge: true });
    expect(tree(b.home)).toEqual([]);
    expect(r.written).toEqual([]);
    expect(r.removed).toContain(join(b.kiro, 'settings', 'mcp.json'));
  });

  it('keeps a shared file setup created once the user added their own content to it', async () => {
    const b = sandbox('uninstall-shared', { ide: '1.2.56', cli: true });
    await setupUser({ h: b.h, command: SHIM, runVersion: run, noInstallStep: true });
    const mcp = join(b.kiro, 'settings', 'mcp.json');
    const doc = json(mcp);
    doc.mcpServers.github = { url: 'https://g' };
    writeFileSync(mcp, JSON.stringify(doc));
    await uninstallKiro({ h: b.h, scope: 'user' });
    expect(json(mcp)).toEqual({ mcpServers: { github: { url: 'https://g' } } });
    expect(existsSync(join(b.kiro, 'hooks'))).toBe(false);
  });

  it('keeps the default agent when the user changed it, keeps a pre-existing .kiroignore setting, and --keep-index keeps caches', async () => {
    const b = sandbox('uninstall-keep', { ide: '1.2.56', cli: true });
    put(kiroUserSettingsPath(b.h), JSON.stringify({ 'kiroAgent.agentIgnoreFiles': ['.kiroignore'] }));
    await setupUser({ h: b.h, command: SHIM, runVersion: run, noInstallStep: true });
    put(kiroCliSettingsPath(b.h), JSON.stringify({ 'chat.defaultAgent': 'other' }));
    mkdirSync(b.h.env.KOPT_CACHE_DIR!, { recursive: true });
    await uninstallKiro({ h: b.h, scope: 'user', keepIndex: true });
    expect(json(kiroCliSettingsPath(b.h))).toEqual({ 'chat.defaultAgent': 'other' });
    expect(json(kiroUserSettingsPath(b.h))).toEqual({ 'kiroAgent.agentIgnoreFiles': ['.kiroignore'] });
    expect(existsSync(b.h.env.KOPT_CACHE_DIR!)).toBe(true);
  });

  it('reverts a per-project kopt init (workspace scope)', async () => {
    const root = gitRepo('ws-uninstall');
    mkdirSync(join(root, '.kopt'));
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
    writeFileSync(join(root, '.kiroignore'), '# mine\n.env\n');
    const prev = { KOPT_KIRO_HOME: process.env.KOPT_KIRO_HOME, KOPT_HOOK_COMMAND: process.env.KOPT_HOOK_COMMAND };
    process.env.KOPT_KIRO_HOME = join(tmp, 'ws-uninstall-kiro');
    process.env.KOPT_HOOK_COMMAND = 'shim';
    try {
      await installKiro({ root, mode: 'local', scope: 'workspace' });
      expect(read(join(root, '.gitignore'))).toBe('node_modules/\n.kopt/\n');
      expect(read(join(root, '.kiroignore'))).toContain('/.kopt/');
      const b = sandbox('ws-uninstall-box');
      b.h.env.KOPT_HOME = process.env.KOPT_HOME;
      await uninstallKiro({ h: b.h, root, scope: 'workspace' });
      expect(read(join(root, '.gitignore'))).toBe('node_modules/\n');
      expect(read(join(root, '.kiroignore'))).toBe('# mine\n.env\n');
      expect(existsSync(join(root, '.kiro'))).toBe(false);
      expect(existsSync(join(root, '.kopt'))).toBe(false);
      expect(existsSync(join(root, '.vscode'))).toBe(false);
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe('Kiro IDE 0.x legacy workspace hooks', () => {
  it('writes a valid 0.12 .kiro.hook, excludes it from git, keeps user edits, and is removed by uninstall', () => {
    const root = gitRepo('legacy-ws');
    execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', 'add', '-A'], { cwd: root });
    execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init'], { cwd: root });
    const cfg = loadConfig(root);
    const r = ensureLegacyWorkspaceHooks(root, cfg, { cmd: SHIM });
    const file = join(root, '.kiro', 'hooks', 'kopt-prompt.kiro.hook');
    expect(r.written).toEqual([file]);
    const hook = json(file);
    // HookSchema of the 0.12.318 bundle: name, version, when.type (IDEListenableEvent), then.type (HookActionEvent)
    expect(hook.name).toBeTruthy();
    expect(hook.version).toBe('1');
    expect(['fileEdited', 'fileCreated', 'fileDeleted', 'userTriggered', 'promptSubmit', 'agentStop', 'preToolUse', 'postToolUse', 'preTaskExecution', 'postTaskExecution', 'sessionStart']).toContain(hook.when.type);
    expect(hook.when.type).toBe('promptSubmit');
    expect(hook.then).toEqual({ type: 'runCommand', command: 'kopt hook promptSubmit --legacy --source legacy', timeout: 10 });
    expect(Object.keys(legacyHookFiles(SHIM))).toEqual(['kopt-prompt.kiro.hook']); // no pre/postToolUse: 0.x intercepts every matched tool
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })).toBe('');
    expect(ensureLegacyWorkspaceHooks(root, cfg, { cmd: SHIM }).written).toEqual([]);
    writeFileSync(file, read(file).replace('prompt pointers', 'my pointers'));
    expect(ensureLegacyWorkspaceHooks(root, cfg, { cmd: { ...SHIM, shell: 'kopt2' } }).written).toEqual([]);
    expect(read(file)).toContain('my pointers');

    expect(removeLegacyWorkspaceHooks(root)).toEqual([file]);
    expect(existsSync(join(root, '.kiro'))).toBe(false);
    expect(read(join(root, '.git', 'info', 'exclude'))).not.toContain('kopt');
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })).toBe('');
  });

  it('is on by default only when the installed IDE is 0.x', () => {
    const root = gitRepo('legacy-wanted');
    const cfg = loadConfig(root);
    const userDir = join(tmp, 'legacy-user');
    mkdirSync(userDir, { recursive: true });
    const c = { ...cfg, userDir };
    writeFileSync(join(userDir, 'surfaces.json'), JSON.stringify({ ide: { version: '0.12.318', major: 0, path: '' } }));
    expect(legacyHooksWanted(c)).toBe(true);
    writeFileSync(join(userDir, 'surfaces.json'), JSON.stringify({ ide: { version: '1.2.56', major: 1, path: '' } }));
    expect(legacyHooksWanted(c)).toBe(false);
    expect(legacyHooksWanted({ ...c, kiro: { legacyWorkspaceHooks: 'on' } })).toBe(true);
    writeFileSync(join(userDir, 'surfaces.json'), JSON.stringify({ ide: { version: '0.12.318', major: 0, path: '' } }));
    expect(legacyHooksWanted({ ...c, kiro: { legacyWorkspaceHooks: 'off' } })).toBe(false);
    process.env.KOPT_LEGACY_WORKSPACE_HOOKS = '0';
    try {
      expect(loadConfig(root).kiro?.legacyWorkspaceHooks).toBe('off');
    } finally {
      delete process.env.KOPT_LEGACY_WORKSPACE_HOOKS;
    }
  });

  it('never writes into a home directory', () => {
    const cfg = loadConfig(tmp);
    expect(ensureLegacyWorkspaceHooks(homedir(), cfg, { cmd: SHIM }).written).toEqual([]);
  });
});

describe('global install (temp npm prefix)', () => {
  const npmOk = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' }).status === 0;

  it('skips with --no-global and leaves a development checkout alone', () => {
    const calls: string[][] = [];
    const npm = (args: string[]) => {
      calls.push(args);
      return { status: 0, stdout: join(tmp, 'nowhere', 'lib', 'node_modules') + '\n', stderr: '' };
    };
    expect(globalInstall({ want: false, npm }).action).toBe('skipped');
    const repoRoot = join(__dirname, '..');
    expect(globalInstall({ npm, pkgRoot: repoRoot }).action).toBe('not-needed');
    expect(calls.some((c) => c[0] === 'install')).toBe(false);
    expect(globalInstall({ npm, pkgRoot: join(tmp, '_npx', 'x', 'node_modules', 'kiro-optimizer'), dryRun: true }).detail).toMatch(/would run: npm pack github:dorian-richard\/kiro-optimizer && npm install -g/);
  });

  it.skipIf(!npmOk)('installs from an npx cache copy into the global prefix with real npm', () => {
    const pkg = join(tmp, 'fakepkg');
    put(join(pkg, 'package.json'), JSON.stringify({ name: 'kiro-optimizer', version: '0.1.0', bin: { kopt: 'dist/bin.js' } }));
    put(join(pkg, 'dist', 'bin.js'), '#!/usr/bin/env node\n');
    mkdirSync(join(pkg, 'templates'), { recursive: true });
    const prefix = join(tmp, 'npm-prefix');
    // childEnv: the runner's own NPM_CONFIG_PREFIX must not win (Windows env names are case-insensitive), or the
    // test would install into the machine's real global prefix
    const env = childEnv(process.env, { npm_config_prefix: prefix, npm_config_cache: join(tmp, 'npm-cache'), npm_config_update_notifier: 'false', npm_execpath: '' });
    const npxCopy = join(tmp, '_npx', 'abc', 'node_modules', 'kiro-optimizer');
    mkdirSync(npxCopy, { recursive: true });
    const r = globalInstall({ npm: defaultNpmRunner(env), spec: pkg, pkgRoot: npxCopy });
    expect(r.action, r.detail).toBe('installed');
    expect(r.bin && existsSync(r.bin)).toBe(true);
    // <prefix>/lib/node_modules on POSIX, <prefix>\node_modules on Windows; npm may print another spelling of the
    // same folder (8.3 short names, case)
    expect(isInside(r.bin!, prefix), `${r.bin} in ${prefix}`).toBe(true);
    // installed globally now: nothing more to do from there
    expect(globalInstall({ npm: defaultNpmRunner(env), pkgRoot: r.packageDir! }).action).toBe('not-needed');
  }, 120_000);

  it.skipIf(!npmOk)('packs a built npx copy as-is (no prepare, no symlink into the npx cache) and installs the tarball', () => {
    // `prepare` would fail here (no devDependencies in the npx cache): it must not run.
    const npxCopy = join(tmp, '_npx', 'def', 'node_modules', 'kiro-optimizer');
    put(join(npxCopy, 'package.json'), JSON.stringify({ name: 'kiro-optimizer', version: '0.1.0', bin: { kopt: 'dist/bin.js' }, files: ['dist', 'templates'], scripts: { prepare: 'exit 7' } }));
    put(join(npxCopy, 'dist', 'bin.js'), '#!/usr/bin/env node\n');
    put(join(npxCopy, 'templates', 'x.json'), '{}');
    const prefix = join(tmp, 'npm-prefix-2');
    const env = childEnv(process.env, { npm_config_prefix: prefix, npm_config_cache: join(tmp, 'npm-cache-2'), npm_config_update_notifier: 'false', npm_execpath: '' });
    const r = globalInstall({ npm: defaultNpmRunner(env), pkgRoot: npxCopy });
    expect(r.action, r.detail).toBe('installed');
    expect(r.detail).toMatch(/from the npx copy/);
    expect(isInside(r.packageDir!, prefix), `${r.packageDir} in ${prefix}`).toBe(true);
    // a real copy, not a link to the npx cache (which npm may purge)
    expect(lstatSync(r.packageDir!).isSymbolicLink()).toBe(false);
    expect(existsSync(join(r.packageDir!, 'templates', 'x.json'))).toBe(true);
  }, 120_000);
});
