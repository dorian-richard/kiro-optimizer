// How Kiro should start kopt: the hook command line (run by Kiro through a shell) and the MCP stdio entry.
//
// Kiro IDE started from the macOS Dock or the Windows Start menu does not get the PATH of the user's shell profile
// (nvm, volta, fnm, asdf, Homebrew set it there), and a GUI app that re-reads the login shell gets nvm's *default*
// version, not the one setup ran with. So nothing kopt writes into Kiro's configuration depends on PATH:
//
//  - MCP entry: `{ command: <absolute Node >= 22.13>, args: [<absolute dist/bin.js>, "mcp"] }`. Kiro spawns it without
//    a shell, so paths with spaces need no quoting, and a native client (the Rust Kiro CLI) never has to resolve a
//    `.cmd` shim.
//  - Hooks: the absolute path of a private launcher, `~/.kopt/bin/kopt` (POSIX sh script) or `%USERPROFILE%\.kopt\bin\
//    kopt.cmd` (Windows), which holds the absolute Node and bin.js paths. A bare path with no quotes runs unchanged in
//    sh, cmd.exe and PowerShell (a quoted first token would need PowerShell's `&` call operator, which cmd.exe
//    rejects). For `kopt hook` the launcher also turns every failure into a silent exit 0 (only exit 2 blocks): a
//    missing Node or package must never print into a Kiro session, and in IDE 1.x a Stop hook that exits 1 means
//    "continue the agent", in a loop. On Windows, a launcher path with spaces is replaced by its 8.3 short form when
//    the volume has one, else quoted for cmd.exe (what Kiro IDE runs hooks with).
//  - Node: the running Node (setup refuses Node < 22.13), through its Homebrew `opt/<formula>` alias when it lives in
//    a versioned Cellar folder (which `brew upgrade` deletes). Re-running `kopt setup` rewrites every path.
//
// `KOPT_HOOK_COMMAND=shim` keeps the old portable form (bare `kopt` / `kopt.cmd`, which needs kopt on Kiro's PATH),
// for teams that commit `kopt init` files; `KOPT_HOOK_COMMAND=node` skips the launcher (absolute node + bin.js).

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { pathFor, userDirFor } from '../core/config.js';
import { packageRoot } from '../hooks/spawn.js';
import { hostEnv, isFile, isNpxCachePath, realpathOr, which, type HostEnv } from './paths.js';

export const MIN_NODE = [22, 13] as const;

export interface KoptCommand {
  /** Shell command prefix for hooks: the launcher path, `'/abs/node' '/abs/bin.js'`, or `kopt` (shim, opt-in). */
  shell: string;
  /** MCP stdio server entry (without autoApprove). */
  mcp: { command: string; args: string[] };
  /** `launcher` = private launcher (default), `node` = explicit Node + bin.js, `shim` = bare kopt on PATH. */
  kind: 'launcher' | 'node' | 'shim';
  /** Absolute path of the kopt shim used, when kind = shim. */
  shimPath?: string;
  /** Absolute Node binary and kopt entry (launcher and node kinds). */
  node?: string;
  bin?: string;
  /** Absolute launcher path (launcher kind). */
  launcher?: string;
}

export function nodeVersionOk(version: string | undefined): boolean {
  const m = version ? /v?(\d+)\.(\d+)/.exec(version) : null;
  if (!m) return false;
  const [maj, min] = [Number(m[1]), Number(m[2])];
  return maj > MIN_NODE[0] || (maj === MIN_NODE[0] && min >= MIN_NODE[1]);
}

/** kopt's executable entry (dist/bin.js) inside a package directory. */
export function binPath(pkgRoot: string = packageRoot(), platform: NodeJS.Platform = process.platform): string {
  const p = pathFor(platform);
  const bin = p.join(pkgRoot, 'dist', 'bin.js');
  return existsSync(bin) || platform !== process.platform ? bin : p.join(pkgRoot, 'dist', 'cli.js');
}

/** Directories whose `kopt` must not be used in persistent config (npx cache, project-local node_modules/.bin). */
export function transientBinDir(dir: string): boolean {
  return isNpxCachePath(dir + '/') || /[\\/]node_modules[\\/]\.bin$/.test(dir);
}

/** A path npm deletes on its own (the npx cache): never written into Kiro's configuration. */
export function isTransientPath(path: string | undefined): boolean {
  return !!path && isNpxCachePath(path);
}

/** The `node` a `#!/usr/bin/env node` shim would run, and its version. */
export function pathNodeVersion(h: HostEnv = hostEnv()): string | undefined {
  const node = which('node', h);
  if (!node) return undefined;
  if (h.platform !== process.platform) return undefined;
  try {
    return execFileSync(node, ['--version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Node binary to write into Kiro's configuration: `execPath` (the running Node, already a real path), except in a
 * Homebrew Cellar (`<prefix>/Cellar/<formula>/<version>/bin/node`, deleted by `brew upgrade`), where the stable
 * `<prefix>/opt/<formula>/bin/node` alias is used when it points to the same binary.
 */
export function stableNodePath(execPath: string = process.execPath, platform: NodeJS.Platform = process.platform): string {
  const p = pathFor(platform);
  const real = platform === process.platform ? realpathOr(execPath) : execPath;
  const m = /^(.*)[\\/]Cellar[\\/]([^\\/]+)[\\/][^\\/]+[\\/]bin[\\/]node$/.exec(real);
  if (m && platform === process.platform) {
    const opt = p.join(m[1], 'opt', m[2], 'bin', 'node');
    if (isFile(opt) && realpathOr(opt) === real) return opt;
  }
  return execPath;
}

/** Quote one argument for the shell Kiro uses for hook commands (sh on POSIX, cmd.exe on Windows). */
export function shellArg(arg: string, platform: NodeJS.Platform = process.platform): string {
  if (/^[A-Za-z0-9_\/.:=@%+,~\\-]+$/.test(arg) && !(platform !== 'win32' && arg.startsWith('~'))) {
    // POSIX: a backslash is an escape character; Windows paths are full of them and they are literal in cmd.exe
    if (platform === 'win32' || !arg.includes('\\')) return arg;
  }
  if (platform === 'win32') return `"${arg.replace(/"/g, '\\"')}"`;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** `<userDir>/bin/kopt` (POSIX) or `<userDir>\bin\kopt.cmd` (Windows): the private launcher hooks run. */
export function launcherPath(h: HostEnv = hostEnv()): string {
  const p = pathFor(h.platform);
  return p.join(userDirFor({ platform: h.platform, env: h.env, home: h.home }), 'bin', h.platform === 'win32' ? 'kopt.cmd' : 'kopt');
}

/**
 * A path as written in a batch file. cmd.exe reads .cmd files in the OEM code page, so a non-ASCII path (a profile
 * folder such as C:\Users\Jérôme) would be garbled: a prefix under %LOCALAPPDATA%, %APPDATA% or %USERPROFILE% is
 * written as that variable (expanded by cmd.exe at run time, in Unicode), any other non-ASCII path in its 8.3 short
 * form when the volume has one. `%` is doubled (a literal percent sign in a batch file).
 */
export function batchPath(path: string, env: NodeJS.ProcessEnv = process.env): string {
  const literal = (s: string) => s.replace(/%/g, '%%');
  for (const name of ['LOCALAPPDATA', 'APPDATA', 'USERPROFILE']) {
    const base = (env[name] ?? '').replace(/[\\/]+$/, '');
    if (base && path.length > base.length && path.slice(0, base.length).toLowerCase() === base.toLowerCase() && /[\\/]/.test(path[base.length])) {
      return `%${name}%${literal(path.slice(base.length))}`;
    }
  }
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7f]/.test(path)) return literal(windowsShortPath(path) ?? path);
  return literal(path);
}

/**
 * Launcher script: runs `<node> <bin.js> <args>`. For `kopt hook ...` it never fails loudly: a missing Node or
 * package is a silent exit 0, and any exit code other than 2 (block) becomes 0.
 */
export function launcherScript(node: string, bin: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === 'win32') {
    // batch: paths through batchPath (code page, `%`); quotes are not allowed in Windows paths. CRLF line endings
    // (cmd.exe misreads labels in LF-only files).
    const v = (s: string) => batchPath(s, env);
    return [
      '@echo off',
      'rem kopt launcher written by `kopt setup`: absolute Node and kopt paths, so Kiro needs nothing on PATH.',
      'rem Re-run `kopt setup` after moving or upgrading Node or kopt.',
      'setlocal',
      `set "KOPT_NODE=${v(node)}"`,
      `set "KOPT_BIN=${v(bin)}"`,
      'if /i "%~1"=="hook" goto hook',
      '"%KOPT_NODE%" "%KOPT_BIN%" %*',
      'exit /b %ERRORLEVEL%',
      ':hook',
      'rem a hook never fails loudly: exit 2 blocks the tool call, anything else is a silent allow',
      'if not exist "%KOPT_NODE%" exit /b 0',
      'if not exist "%KOPT_BIN%" exit /b 0',
      '"%KOPT_NODE%" "%KOPT_BIN%" %*',
      'if "%ERRORLEVEL%"=="2" exit /b 2',
      'exit /b 0',
      '',
    ].join('\r\n');
  }
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return [
    '#!/bin/sh',
    '# kopt launcher written by `kopt setup`: absolute Node and kopt paths, so Kiro needs nothing on PATH.',
    '# Re-run `kopt setup` after moving or upgrading Node or kopt.',
    `node=${q(node)}`,
    `bin=${q(bin)}`,
    'if [ "$1" = hook ]; then',
    '  # a hook never fails loudly: exit 2 blocks the tool call, anything else is a silent allow',
    '  [ -x "$node" ] && [ -f "$bin" ] || exit 0',
    '  "$node" "$bin" "$@"',
    '  [ "$?" -eq 2 ] && exit 2',
    '  exit 0',
    'fi',
    'exec "$node" "$bin" "$@"',
    '',
  ].join('\n');
}

/** Windows 8.3 short form of an existing path (no spaces), or undefined when the volume has none. */
export function windowsShortPath(path: string): string | undefined {
  if (process.platform !== 'win32' || !existsSync(path)) return undefined;
  try {
    const r = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"for %I in ("${path}") do @echo %~sI"`], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
    const out = (r.stdout ?? '').trim();
    return r.status === 0 && out && !/\s/.test(out) && existsSync(out) ? out : undefined;
  } catch {
    return undefined;
  }
}

/** Launcher path as written in a hook command: bare when possible (valid in sh, cmd.exe and PowerShell). */
export function launcherShell(path: string, platform: NodeJS.Platform = process.platform): string {
  const bare = shellArg(path, platform);
  if (bare === path || platform !== 'win32') return bare;
  return windowsShortPath(path) ?? bare;
}

export interface ResolveOptions {
  h?: HostEnv;
  /** kopt's bin.js (default: this package's). */
  bin?: string;
  /** Node binary (default: the running one, see stableNodePath). */
  nodePath?: string;
  /** `shim` = bare kopt (needs PATH), `node` = no launcher, `launcher` = launcher even if not written yet. */
  force?: 'shim' | 'node' | 'launcher';
  /** Version of the PATH `node` (shim form; injected by tests). */
  nodeVersion?: string;
  /** Launcher path (default: launcherPath(h), used when the file exists or `force` is `launcher`). */
  launcher?: string;
}

export function resolveKoptCommand(o: ResolveOptions = {}): KoptCommand {
  const h = o.h ?? hostEnv();
  const win = h.platform === 'win32';
  const bin = o.bin ?? binPath(undefined, h.platform);
  const node = o.nodePath ?? stableNodePath(process.execPath, h.platform);
  const mcp = { command: node, args: [bin, 'mcp'] };
  if (o.force === 'shim') {
    const shimPath = which('kopt', h, transientBinDir);
    // Windows hooks use kopt.cmd: PowerShell resolves a bare `kopt` to npm's kopt.ps1, which the default execution
    // policy refuses to run. The MCP entry stays node + bin.js (a native MCP client may not resolve .cmd shims).
    return { shell: win ? 'kopt.cmd' : 'kopt', mcp: win ? mcp : { command: 'kopt', args: ['mcp'] }, kind: 'shim', shimPath, node, bin };
  }
  const launcher = o.launcher ?? launcherPath(h);
  if (o.force !== 'node' && (o.force === 'launcher' || (h.platform === process.platform && isFile(launcher)))) {
    return { shell: launcherShell(launcher, h.platform), mcp, kind: 'launcher', node, bin, launcher };
  }
  return { shell: [node, bin].map((a) => shellArg(a, h.platform)).join(' '), mcp, kind: 'node', node, bin };
}

/** Hook command line for one hook source (`global`, `workspace`, `agent`, `legacy`). */
export function hookCommandLine(cmd: KoptCommand, source: string, extra: string[] = []): string {
  return [cmd.shell, 'hook', ...extra, '--source', source].join(' ');
}

/** First token of a hook command line (the program), unquoted. */
export function commandProgram(line: string): string {
  const t = line.trim();
  const m = /^"([^"]*)"|^'([^']*)'|^(\S+)/.exec(t);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : '';
}

/** True when a configured command needs PATH to start (bare `kopt`, `kopt.cmd`, `node`). */
export function dependsOnPath(program: string): boolean {
  return !!program && !/[\\/]/.test(program);
}
