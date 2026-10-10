// kopt setup / uninstall / legacy IDE hooks / cache-dir data dir, all in temp HOMEs (never the real ~/.kiro, ~/.kopt,
// Kiro settings or npm prefix). The generated CLI 2.x agent is validated with the real kiro-cli when it is installed,
// in a temp HOME.

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, sep, win32 } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cacheRoot, defaultConfig, findProjectRoot, isUnsafeRoot, loadConfig, repoCacheKey, usesProjectDataDir } from '../src/core/config.js';
import { batchPath, binPath, commandProgram, dependsOnPath, hookCommandLine, isTransientPath, launcherPath, launcherScript, launcherShell, resolveKoptCommand, shellArg, stableNodePath, transientBinDir, type KoptCommand } from '../src/kiro/command.js';
import { detectCli, detectIde, hookPlan } from '../src/kiro/detect.js';
import { ensureLegacyWorkspaceHooks, legacyHookFiles, legacyHooksWanted, removeLegacyWorkspaceHooks } from '../src/kiro/legacy.js';
import { ideCandidates, kiroCliSettingsPath, kiroHomeDir, kiroUserSettingsPath, which, type HostEnv } from '../src/kiro/paths.js';
import { AUTO_APPROVE, defaultNpmRunner, globalInstall, MCP_TIMEOUTS, setupUser } from '../src/kiro/setup.js';
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
  it('writes absolute Node + bin.js for MCP and the private launcher for hooks: nothing depends on PATH', () => {
    const platform = process.platform;
    const win = platform === 'win32';
    const home = join(tmp, 'resolve-home');
    const h: HostEnv = { platform, env: { PATH: '', KOPT_HOME: join(home, '.kopt') }, home };
    const bin = win ? 'C:\\kopt\\dist\\bin.js' : '/opt/kopt/dist/bin.js';
    const node = win ? 'C:\\nodejs\\node.exe' : '/opt/node22/bin/node';
    // no launcher written yet: absolute node + bin.js in hooks too
    const direct = resolveKoptCommand({ h, bin, nodePath: node });
    expect(direct).toMatchObject({ kind: 'node', mcp: { command: node, args: [bin, 'mcp'] }, node, bin });
    expect(direct.shell).toBe(`${node} ${bin}`);
    // the launcher setup writes: hooks run it by absolute path, MCP stays node + bin.js (spawned without a shell)
    const launcher = launcherPath(h);
    expect(launcher).toBe(join(home, '.kopt', 'bin', win ? 'kopt.cmd' : 'kopt'));
    const viaLauncher = resolveKoptCommand({ h, bin, nodePath: node, force: 'launcher' });
    expect(viaLauncher).toMatchObject({ kind: 'launcher', launcher, mcp: { command: node, args: [bin, 'mcp'] } });
    expect(hookCommandLine(viaLauncher, 'global')).toBe(`${shellArg(launcher)} hook --source global`);
    // an existing launcher is picked up by runtime callers (the MCP server writing IDE 0.x workspace hooks)
    put(launcher, launcherScript(node, bin));
    expect(resolveKoptCommand({ h, bin, nodePath: node }).kind).toBe('launcher');
    // opt-outs: bare kopt (needs PATH; for teams committing kopt init files), or no launcher
    expect(resolveKoptCommand({ h, bin, nodePath: node, force: 'shim' })).toMatchObject({ kind: 'shim', shell: win ? 'kopt.cmd' : 'kopt' });
    expect(resolveKoptCommand({ h, bin, nodePath: node, force: 'node' }).kind).toBe('node');
    // the npx cache is never a stable location
    expect(isTransientPath(join(tmp, '_npx', 'abc', 'node_modules', 'kiro-optimizer', 'dist', 'bin.js'))).toBe(true);
    expect(isTransientPath(bin)).toBe(false);
    expect(which('kopt', { platform, env: { PATH: [join(tmp, '_npx', 'x'), '/nowhere'].join(win ? ';' : ':') }, home }, transientBinDir)).toBeUndefined();
  });

  it('quotes for sh and cmd.exe, and keeps plain paths bare (valid in sh, cmd.exe and PowerShell alike)', () => {
    expect(shellArg('/opt/my kopt/dist/bin.js', 'linux')).toBe("'/opt/my kopt/dist/bin.js'");
    expect(shellArg("/opt/it's/bin.js", 'linux')).toBe("'/opt/it'\\''s/bin.js'");
    expect(shellArg('/home/u/.kopt/bin/kopt', 'linux')).toBe('/home/u/.kopt/bin/kopt');
    expect(shellArg('~/x', 'linux')).toBe("'~/x'");
    expect(shellArg('C:\\Users\\u\\.kopt\\bin\\kopt.cmd', 'win32')).toBe('C:\\Users\\u\\.kopt\\bin\\kopt.cmd');
    expect(shellArg('C:\\PROGRA~1\\nodejs\\node.exe', 'win32')).toBe('C:\\PROGRA~1\\nodejs\\node.exe');
    expect(shellArg('C:\\Program Files\\nodejs\\node.exe', 'win32')).toBe('"C:\\Program Files\\nodejs\\node.exe"');
    expect(launcherShell('C:\\Users\\u\\.kopt\\bin\\kopt.cmd', 'win32')).toBe('C:\\Users\\u\\.kopt\\bin\\kopt.cmd');
    expect(commandProgram("'/opt/my kopt/node' x")).toBe('/opt/my kopt/node');
    expect(commandProgram('"C:\\Program Files\\node.exe" x')).toBe('C:\\Program Files\\node.exe');
    expect(dependsOnPath('kopt')).toBe(true);
    expect(dependsOnPath('kopt.cmd')).toBe(true);
    expect(dependsOnPath('/home/u/.kopt/bin/kopt')).toBe(false);
  });

  it('launcher scripts: absolute paths, and a hook never fails loudly (only exit 2 blocks)', () => {
    const sh = launcherScript('/opt/node 22/bin/node', "/opt/it's/dist/bin.js", 'linux');
    expect(sh).toMatch(/^#!\/bin\/sh\n/);
    expect(sh).toContain("node='/opt/node 22/bin/node'");
    expect(sh).toContain("bin='/opt/it'\\''s/dist/bin.js'");
    const cmd = launcherScript('C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\a%b\\kopt\\dist\\bin.js', 'win32');
    expect(cmd.split('\r\n')[0]).toBe('@echo off');
    expect(cmd).toContain('set "KOPT_NODE=C:\\Program Files\\nodejs\\node.exe"');
    expect(cmd).toContain('set "KOPT_BIN=C:\\Users\\a%%b\\kopt\\dist\\bin.js"'); // % doubled in a batch file
    expect(cmd).toContain('if "%ERRORLEVEL%"=="2" exit /b 2');
    expect(cmd).not.toMatch(/[^\r]\n/); // CRLF only
    // cmd.exe reads batch files in the OEM code page: a non-ASCII profile path is written through its variable
    const env = { USERPROFILE: 'C:\\Users\\Jérôme', APPDATA: 'C:\\Users\\Jérôme\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\Jérôme\\AppData\\Local' };
    const fr = launcherScript('C:\\Users\\Jérôme\\AppData\\Local\\fnm\\node.exe', 'C:\\Users\\Jérôme\\AppData\\Roaming\\npm\\node_modules\\kiro-optimizer\\dist\\bin.js', 'win32', env);
    expect(fr).toContain('set "KOPT_NODE=%LOCALAPPDATA%\\fnm\\node.exe"');
    expect(fr).toContain('set "KOPT_BIN=%APPDATA%\\npm\\node_modules\\kiro-optimizer\\dist\\bin.js"');
    expect(fr).not.toMatch(/[^\x00-\x7f]/);
    expect(batchPath('C:\\Users\\u\\.kopt\\x%y', { USERPROFILE: 'C:\\Users\\u' })).toBe('%USERPROFILE%\\.kopt\\x%%y');
  });

  it.skipIf(process.platform === 'win32')('the POSIX launcher runs with PATH=/usr/bin:/bin and maps hook failures to a silent exit 0', () => {
    const dir = join(tmp, 'launcher-run');
    const fake = join(dir, 'fake-bin.js');
    put(fake, "process.exit(Number(process.argv[3] ?? 0));\n");
    const launcher = join(dir, 'kopt');
    put(launcher, launcherScript(process.execPath, fake, process.platform));
    chmodSync(launcher, 0o755);
    const env = { PATH: '/usr/bin:/bin', HOME: dir };
    const code = (args: string[], f = launcher) => spawnSync(f, args, { env, encoding: 'utf8' }).status;
    expect(code(['hook', '0'])).toBe(0);
    expect(code(['hook', '2'])).toBe(2);
    expect(code(['hook', '1'])).toBe(0); // e.g. a Stop hook: exit 1 would mean "continue the agent" in Kiro IDE 1.x
    expect(code(['other', '1'])).toBe(1); // not a hook: the real exit code
    put(join(dir, 'gone'), launcherScript(join(dir, 'no-node'), fake, process.platform));
    chmodSync(join(dir, 'gone'), 0o755);
    const r = spawnSync(join(dir, 'gone'), ['hook'], { env, encoding: 'utf8' });
    expect([r.status, r.stdout, r.stderr]).toEqual([0, '', '']); // Node removed: silent allow
  });

  it('pins the stable Homebrew alias of a Cellar Node, else the running Node', () => {
    expect(stableNodePath('/usr/local/bin/node', 'linux')).toBe('/usr/local/bin/node');
    expect(stableNodePath(process.execPath)).toBeTruthy();
    // on another OS nothing is resolved on disk
    expect(stableNodePath('/opt/homebrew/Cellar/node@22/22.13.0/bin/node', process.platform === 'win32' ? 'linux' : 'win32')).toBe('/opt/homebrew/Cellar/node@22/22.13.0/bin/node');
  });

  it('computes bin.js inside a package', () => {
    if (process.platform === 'win32') expect(binPath('/opt/kopt', 'linux')).toBe('/opt/kopt/dist/bin.js');
    else expect(binPath('C:\\x\\kiro-optimizer', 'win32')).toBe(win32.join('C:\\x\\kiro-optimizer', 'dist', 'bin.js'));
    const pkg = join(tmp, 'binpkg');
    expect(binPath(pkg)).toBe(join(pkg, 'dist', 'cli.js'));
    put(join(pkg, 'dist', 'bin.js'), '#!/usr/bin/env node\n');
    expect(binPath(pkg)).toBe(join(pkg, 'dist', 'bin.js'));
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
    expect(mcp.mcpServers.kopt).toEqual({ command: 'kopt', args: ['mcp'], autoApprove: AUTO_APPROVE, ...MCP_TIMEOUTS });
    expect(mcp.mcpServers.kopt.autoApprove).not.toContain('kopt_run');

    const hooks = json(join(b.kiro, 'hooks', 'kopt.json'));
    expect(hooks.version).toBe('v1');
    expect(hooks.hooks.map((x: any) => x.trigger)).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostFileSave', 'PostFileCreate', 'PostFileDelete', 'Stop']);
    for (const x of hooks.hooks) expect(x.action).toEqual({ type: 'command', command: 'kopt hook --source global' });
    expect(hooks.hooks.find((x: any) => x.trigger === 'Stop').description).toContain('local usage log');

    const agent = json(join(b.kiro, 'agents', 'kopt.json'));
    expect(agent.name).toBe('kopt');
    expect(agent.includeMcpJson).toBe(true);
    expect(agent).not.toHaveProperty('useLegacyMcpJson'); // kiro-cli 2.28: duplicate-field error with includeMcpJson
    expect(Object.keys(agent.hooks)).toEqual(['agentSpawn', 'userPromptSubmit', 'preToolUse', 'postToolUse', 'stop']);
    for (const list of Object.values(agent.hooks) as any[]) expect(list[0].command).toBe('kopt hook --source agent');
    expect(agent.allowedTools).toEqual(AUTO_APPROVE.map((t) => `@kopt/${t}`));
    expect(agent.resources).toBeUndefined(); // global steering is inherited by default

    expect(json(kiroCliSettingsPath(b.h))).toEqual({ 'chat.defaultModel': 'auto', 'chat.defaultAgent': 'kopt' });
    const explorer = json(join(b.kiro, 'agents', 'kopt-explorer.json'));
    expect(explorer.tools).not.toContain('@kopt/kopt_run');
    // its prompt sends it to grep/glob for literal strings: on Kiro CLI 2.x they are separate tools from `read`
    expect(explorer.tools).toEqual(expect.arrayContaining(['read', 'grep', 'glob']));
    expect(explorer.allowedTools).toEqual(expect.arrayContaining(['read', 'grep', 'glob']));
    expect(read(join(b.kiro, 'steering', 'kopt.md'))).toMatch(/^---\ninclusion: always\n---\n/);
    expect(existsSync(join(b.kiro, 'steering', 'kopt-specs.md'))).toBe(true);
    // global ignore: build artifacts only (Kiro IDE denies reads AND writes of matched files in every project)
    const globalIgnore = read(join(b.kiro, 'settings', 'kiroignore'));
    expect(globalIgnore).toMatch(/# >>> kopt \(generated\)[\s\S]*\*\.min\.js[\s\S]*\*\.js\.map[\s\S]*# <<< kopt\n$/);
    for (const p of ['package-lock.json', 'yarn.lock', 'go.sum', '__snapshots__/', '*.snap']) expect(globalIgnore).not.toContain(p);
    const vs = read(ideSettings);
    expect(vs).toContain('// mine');
    expect(vs).toContain('"kiroAgent.agentIgnoreFiles": [".kiroignore"]');

    const again = await setupUser({ h: b.h, command: SHIM, runVersion: run, noInstallStep: true });
    expect(again.written).toEqual([]);
  });

  it('keeps a different Kiro CLI default agent unless --force, keeps user fields of the kopt server, and supports dry runs', async () => {
    const b = sandbox('setup-keep', { cli: true });
    put(kiroCliSettingsPath(b.h), JSON.stringify({ 'chat.defaultAgent': 'my-agent' }));
    put(join(b.kiro, 'settings', 'mcp.json'), JSON.stringify({ mcpServers: { kopt: { command: 'old-kopt', args: ['mcp'], env: { KOPT_DEBUG: '1' } } } }));
    const dry = await setupUser({ h: b.h, command: SHIM, runVersion: run, noInstallStep: true, dryRun: true });
    expect(dry.notes[0]).toMatch(/dry run/);
    expect(existsSync(join(b.kiro, 'hooks', 'kopt.json'))).toBe(false);

    const r = await setupUser({ h: b.h, command: SHIM, runVersion: run, noInstallStep: true });
    expect(json(kiroCliSettingsPath(b.h))['chat.defaultAgent']).toBe('my-agent');
    expect(r.notes.some((n) => n.includes('"my-agent"'))).toBe(true);
    expect(json(join(b.kiro, 'settings', 'mcp.json')).mcpServers.kopt).toEqual({ command: 'kopt', args: ['mcp'], env: { KOPT_DEBUG: '1' }, autoApprove: AUTO_APPROVE, ...MCP_TIMEOUTS });
    expect(existsSync(kiroUserSettingsPath(b.h))).toBe(false); // no IDE detected: IDE settings untouched

    // --force: default agent, and still the user's own fields of the kopt server (env, disabled, autoApprove)
    const mcpPath = join(b.kiro, 'settings', 'mcp.json');
    const edited = json(mcpPath);
    edited.mcpServers.kopt.autoApprove = ['kopt_find'];
    edited.mcpServers.kopt.disabledTools = ['kopt_run'];
    writeFileSync(mcpPath, JSON.stringify(edited));
    await setupUser({ h: b.h, command: SHIM, runVersion: run, noInstallStep: true, force: true });
    expect(json(kiroCliSettingsPath(b.h))['chat.defaultAgent']).toBe('kopt');
    expect(json(mcpPath).mcpServers.kopt).toEqual({ command: 'kopt', args: ['mcp'], env: { KOPT_DEBUG: '1' }, autoApprove: ['kopt_find'], ...MCP_TIMEOUTS, disabledTools: ['kopt_run'] });
  });

  it('by default writes the launcher, points every hook at it and the MCP server at absolute Node + bin.js', async () => {
    const b = sandbox('setup-launcher', { ide: '1.2.56', cli: true });
    const r = await setupUser({ h: b.h, runVersion: run, noInstallStep: true });
    expect(r.command.kind).toBe('launcher');
    const launcher = join(b.home, '.kopt', 'bin', process.platform === 'win32' ? 'kopt.cmd' : 'kopt');
    expect(r.command.launcher).toBe(launcher);
    expect(read(launcher)).toContain(r.command.bin!);
    if (process.platform !== 'win32') expect(lstatSync(launcher).mode & 0o777).toBe(0o755);
    const hooks = json(join(b.kiro, 'hooks', 'kopt.json'));
    for (const x of hooks.hooks) expect(x.action.command).toBe(`${shellArg(launcher)} hook --source global`);
    for (const list of Object.values(json(join(b.kiro, 'agents', 'kopt.json')).hooks) as any[]) expect(list[0].command).toBe(`${shellArg(launcher)} hook --source agent`);
    const entry = json(join(b.kiro, 'settings', 'mcp.json')).mcpServers.kopt;
    expect(entry.command).toBe(stableNodePath(process.execPath));
    expect(entry.args).toEqual([r.command.bin, 'mcp']);
    expect(r.notes.some((n) => /absolute paths/.test(n))).toBe(true);
    // re-running setup is idempotent; an upgrade (new paths) rewrites the launcher and the configs
    expect((await setupUser({ h: b.h, runVersion: run, noInstallStep: true })).written).toEqual([]);
    const moved = join(tmp, 'moved-kopt', 'dist', 'bin.js');
    put(moved, '// new place\n');
    const r2 = await setupUser({ h: { ...b.h, env: { ...b.h.env, KOPT_CLI: moved } }, runVersion: run, noInstallStep: true });
    expect(r2.written).toContain(launcher);
    expect(read(launcher)).toContain(moved);
    expect(json(join(b.kiro, 'settings', 'mcp.json')).mcpServers.kopt.args).toEqual([moved, 'mcp']);
    // private state is owner-only (POSIX)
    if (process.platform !== 'win32') {
      expect(lstatSync(join(b.home, '.kopt')).mode & 0o077).toBe(0);
      expect(lstatSync(join(b.home, '.kopt', 'setup-state.json')).mode & 0o077).toBe(0);
      expect(lstatSync(join(b.home, '.kopt', 'kiro-install.json')).mode & 0o077).toBe(0);
    }
  });

  it('never points Kiro into the npx cache: a private copy in ~/.kopt/runtime, or nothing written at all', async () => {
    const npxCopy = join(tmp, '_npx', 'cafe', 'node_modules', 'kiro-optimizer');
    put(join(npxCopy, 'package.json'), JSON.stringify({ name: 'kiro-optimizer', version: '0.1.0', bin: { kopt: 'dist/bin.js' }, files: ['dist', 'templates'] }));
    put(join(npxCopy, 'dist', 'bin.js'), '#!/usr/bin/env node\n');
    put(join(npxCopy, 'templates', 'x.json'), '{}');
    // npm stub: `pack` makes a tarball, `install -g` fails like EACCES on a system Node, unless --prefix is given
    const npm = (ok: boolean) => (args: string[]) => {
      if (args[0] === 'root') return { status: 0, stdout: join(tmp, 'sys-node', 'lib', 'node_modules') + '\n', stderr: '' };
      if (args[0] === 'pack') {
        const out = args[args.indexOf('--pack-destination') + 1];
        writeFileSync(join(out, 'kiro-optimizer-0.1.0.tgz'), 'tgz');
        return { status: 0, stdout: '[]', stderr: '' };
      }
      if (args[0] === 'install' && args.includes('--prefix') && ok) {
        const prefix = args[args.indexOf('--prefix') + 1];
        const pkg = process.platform === 'win32' ? join(prefix, 'node_modules', 'kiro-optimizer') : join(prefix, 'lib', 'node_modules', 'kiro-optimizer');
        put(join(pkg, 'dist', 'bin.js'), '// private copy\n');
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'npm ERR! code EACCES' };
    };
    const b = sandbox('setup-npx-ok', { ide: '1.2.56' });
    const r = await setupUser({ h: b.h, runVersion: run, pkgRoot: npxCopy, npm: npm(true) });
    expect(r.refused).toBeUndefined();
    expect(r.command.bin).toContain(join(b.home, '.kopt', 'runtime'));
    expect(r.install.detail).toMatch(/private copy/);
    const mcpText = read(join(b.kiro, 'settings', 'mcp.json'));
    expect(mcpText).not.toMatch(/_npx/);
    expect(read(r.command.launcher!)).not.toMatch(/_npx/);

    const bad = sandbox('setup-npx-fail', { ide: '1.2.56' });
    const refused = await setupUser({ h: bad.h, runVersion: run, pkgRoot: npxCopy, npm: npm(false) });
    expect(refused.refused).toMatch(/npx cache/);
    expect(refused.written).toEqual([]);
    expect(existsSync(bad.kiro)).toBe(false);
    expect(existsSync(join(bad.home, '.kopt', 'bin'))).toBe(false);
    // --no-global from npx: the same private copy (never the npx path)
    const ng = sandbox('setup-npx-noglobal', { ide: '1.2.56' });
    const r3 = await setupUser({ h: ng.h, runVersion: run, pkgRoot: npxCopy, npm: npm(true), global: false });
    expect(r3.command.bin).toContain(join(ng.home, '.kopt', 'runtime'));
  });

  it('removes the IDE 0.x workspace prompt hooks once the IDE is 1.x', async () => {
    const root = gitRepo('legacy-upgrade');
    const b = sandbox('setup-legacy-upgrade', { ide: '1.2.56' });
    const cfg = { ...loadConfig(root), userDir: join(b.home, '.kopt') };
    ensureLegacyWorkspaceHooks(root, cfg, { cmd: SHIM });
    const file = join(root, '.kiro', 'hooks', 'kopt-prompt.kiro.hook');
    expect(existsSync(file)).toBe(true);
    const r = await setupUser({ h: b.h, command: SHIM, runVersion: run, noInstallStep: true });
    expect(r.removed).toContain(file);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(b.home, '.kopt', 'legacy-hooks.json'))).toBe(false);
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

  // the real binary, for offline commands in a temporary HOME: only when the developer opts in with
  // KOPT_TEST_REAL_KIRO_CLI=1 (vitest.config.ts then sets KOPT_VITEST_REAL_KIRO_CLI); never found on PATH by itself
  const chat = [process.env.KOPT_VITEST_REAL_KIRO_CLI ?? ''].find((p) => p && existsSync(p));
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

  it('keeps and reports kopt files the user edited (removed with --force), and removes the launcher', async () => {
    const b = sandbox('uninstall-edited', { ide: '1.2.56', cli: true });
    await setupUser({ h: b.h, runVersion: run, noInstallStep: true });
    const steering = join(b.kiro, 'steering', 'kopt.md');
    writeFileSync(steering, read(steering) + '\n- my own team rule\n');
    const launcher = join(b.home, '.kopt', 'bin', process.platform === 'win32' ? 'kopt.cmd' : 'kopt');
    expect(existsSync(launcher)).toBe(true);
    const r = await uninstallKiro({ h: b.h, scope: 'user' });
    expect(read(steering)).toContain('my own team rule');
    expect(r.kept).toEqual([steering]);
    expect(r.notes.some((n) => n.includes('kept') && n.includes(steering))).toBe(true);
    expect(existsSync(join(b.kiro, 'hooks', 'kopt.json'))).toBe(false);
    expect(existsSync(launcher)).toBe(false);
    const forced = await uninstallKiro({ h: b.h, scope: 'user', force: true });
    expect(forced.removed).toContain(steering);
  });

  it('run from the home directory, never treats it as a project (~/.kopt and ~/.kiro stay)', async () => {
    const b = sandbox('uninstall-home', { ide: '1.2.56' });
    b.h.env.KOPT_HOME = join(b.home, '.kopt');
    await setupUser({ h: b.h, command: SHIM, runVersion: run, noInstallStep: true });
    put(join(b.home, '.kopt', 'config.json'), '{}');
    put(join(b.home, '.kopt', 'telemetry', '2026-10-09.jsonl'), '{}\n');
    const r = await uninstallKiro({ h: b.h, root: b.home, scope: 'workspace' });
    expect(r.removed).toEqual([]);
    expect(existsSync(join(b.home, '.kopt', 'config.json'))).toBe(true);
    expect(existsSync(join(b.home, '.kopt', 'telemetry'))).toBe(true);
    expect(existsSync(join(b.kiro, 'hooks', 'kopt.json'))).toBe(true);
    // scope all from home: the user-level files go, ~/.kopt data stays (only --purge deletes it)
    await uninstallKiro({ h: b.h, root: b.home });
    expect(existsSync(join(b.home, '.kopt', 'config.json'))).toBe(true);
    expect(existsSync(join(b.home, '.kopt', 'telemetry', '2026-10-09.jsonl'))).toBe(true);
  });

  it('deletes only kopt per-project folders in a shared KOPT_CACHE_DIR', async () => {
    const b = sandbox('uninstall-cache', { ide: '1.2.56' });
    const cache = join(tmp, 'shared-cache');
    b.h.env.KOPT_CACHE_DIR = cache;
    put(join(cache, 'api-1a2b3c4d', 'index.db'), '');
    put(join(cache, 'web-0f0f0f0f', 'outputs', 'o123456.log'), 'x');
    put(join(cache, 'other-tool', 'data.bin'), 'keep');
    put(join(cache, 'notes.txt'), 'keep');
    await uninstallKiro({ h: b.h, scope: 'user' });
    expect(existsSync(join(cache, 'api-1a2b3c4d'))).toBe(false);
    expect(existsSync(join(cache, 'web-0f0f0f0f'))).toBe(false);
    expect(read(join(cache, 'other-tool', 'data.bin'))).toBe('keep');
    expect(read(join(cache, 'notes.txt'))).toBe('keep');
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
      await installKiro({ root, scope: 'workspace' });
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

  it('notices an IDE that updated itself from 0.x to 1.x (the cached package.json is re-read)', async () => {
    const { currentIde } = await import('../src/kiro/legacy.js');
    const userDir = join(tmp, 'legacy-ide-update');
    const pkg = join(userDir, 'ide', 'package.json');
    put(pkg, JSON.stringify({ name: 'Kiro', version: '0.12.318' }));
    writeFileSync(join(userDir, 'surfaces.json'), JSON.stringify({ ide: { version: '0.12.318', major: 0, path: pkg }, at: Date.now() }));
    expect(currentIde(userDir)?.major).toBe(0);
    put(pkg, JSON.stringify({ name: 'Kiro', version: '1.2.56' }));
    expect(currentIde(userDir)).toMatchObject({ version: '1.2.56', major: 1 });
    // a cache with no IDE is re-detected once it is a day old
    const h: HostEnv = { platform: process.platform, env: { PATH: '', KOPT_KIRO_IDE_PATHS: pkg }, home: userDir };
    writeFileSync(join(userDir, 'surfaces.json'), JSON.stringify({ at: Date.now() - 2 * 86400_000 }));
    expect(currentIde(userDir, h)?.version).toBe('1.2.56');
  });

  it('is on by default only when the installed IDE is 0.x', () => {
    const root = gitRepo('legacy-wanted');
    const cfg = loadConfig(root);
    const userDir = join(tmp, 'legacy-user');
    mkdirSync(userDir, { recursive: true });
    const c = { ...cfg, userDir };
    const at = Date.now();
    writeFileSync(join(userDir, 'surfaces.json'), JSON.stringify({ ide: { version: '0.12.318', major: 0, path: '' }, at }));
    expect(legacyHooksWanted(c)).toBe(true);
    writeFileSync(join(userDir, 'surfaces.json'), JSON.stringify({ ide: { version: '1.2.56', major: 1, path: '' }, at }));
    expect(legacyHooksWanted(c)).toBe(false);
    expect(legacyHooksWanted({ ...c, kiro: { legacyWorkspaceHooks: 'on' } })).toBe(true);
    writeFileSync(join(userDir, 'surfaces.json'), JSON.stringify({ ide: { version: '0.12.318', major: 0, path: '' }, at }));
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
