// Where Kiro and kopt keep their files, per OS. Every function takes an optional `HostEnv` so tests can
// simulate another platform's layout (Windows paths on macOS, a temp HOME, ...) without touching the real one.
//
// Verified 2026-10-09:
//  - user config root `~/.kiro` (`KIRO_HOME` overrides it: kiro.dev/docs/configuration "Override the global
//    directory with KIRO_HOME"); `~/.kiro/settings/{mcp.json,cli.json,kiroignore}`, `~/.kiro/{hooks,steering,agents}`.
//  - Kiro IDE (VS Code fork, product.json nameShort "Kiro") user settings: macOS
//    `~/Library/Application Support/Kiro/User/settings.json` (exists on this machine), Linux
//    `$XDG_CONFIG_HOME/Kiro/User/settings.json`, Windows `%APPDATA%\Kiro\User\settings.json` (VS Code layout).
//  - Kiro IDE version: `resources/app/package.json` "version" (macOS `Kiro.app/Contents/Resources/app/package.json`
//    = 0.12.318 here). The `kiro` launcher resolves to `<app>/bin/code` (macOS) or `<install>/bin/kiro` (Linux/Windows).
//  - Kiro CLI: `~/.local/bin/kiro-cli` (install script; symlink into `/Applications/Kiro CLI.app` on macOS), Homebrew
//    `kiro-cli` cask, Windows PowerShell installer (location not documented: found through PATH).

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { pathFor } from '../core/config.js';
import { stripBom } from '../telemetry/fsutil.js';

export interface HostEnv {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
}

export function hostEnv(over: Partial<HostEnv> = {}): HostEnv {
  return { platform: over.platform ?? process.platform, env: over.env ?? process.env, home: over.home ?? homedir() };
}

/** `~/.kiro` (KOPT_KIRO_HOME, then Kiro's own KIRO_HOME, override it). */
export function kiroHomeDir(h: HostEnv = hostEnv()): string {
  return h.env.KOPT_KIRO_HOME || h.env.KIRO_HOME || pathFor(h.platform).join(h.home, '.kiro');
}

/** Kiro IDE user settings.json (VS Code layout under the "Kiro" product folder). */
export function kiroUserSettingsPath(h: HostEnv = hostEnv()): string {
  const p = pathFor(h.platform);
  if (h.env.KOPT_KIRO_USER_SETTINGS) return h.env.KOPT_KIRO_USER_SETTINGS;
  if (h.platform === 'darwin') return p.join(h.home, 'Library', 'Application Support', 'Kiro', 'User', 'settings.json');
  if (h.platform === 'win32') return p.join(h.env.APPDATA || p.join(h.home, 'AppData', 'Roaming'), 'Kiro', 'User', 'settings.json');
  return p.join(h.env.XDG_CONFIG_HOME || p.join(h.home, '.config'), 'Kiro', 'User', 'settings.json');
}

/** Kiro CLI settings file (flat dotted keys, e.g. "chat.defaultAgent"); verified with kiro-cli 2.28 in a temp HOME. */
export function kiroCliSettingsPath(h: HostEnv = hostEnv()): string {
  return pathFor(h.platform).join(kiroHomeDir(h), 'settings', 'cli.json');
}

const listSep = (h: HostEnv) => (h.platform === 'win32' ? ';' : ':');

function envList(h: HostEnv, name: string): string[] | undefined {
  const v = h.env[name];
  if (v === undefined) return undefined;
  return v.split(listSep(h)).filter(Boolean);
}

/**
 * Candidate `package.json` files of a Kiro IDE install (most likely first). `KOPT_KIRO_IDE_PATHS` (list of
 * package.json paths or install dirs) replaces the defaults, for tests and unusual installs.
 */
export function ideCandidates(h: HostEnv = hostEnv()): string[] {
  const p = pathFor(h.platform);
  const over = envList(h, 'KOPT_KIRO_IDE_PATHS');
  if (over) return over.map((x) => (x.endsWith('.json') ? x : p.join(x, 'resources', 'app', 'package.json')));
  const out: string[] = [];
  if (h.platform === 'darwin') {
    for (const base of ['/Applications', p.join(h.home, 'Applications')]) out.push(p.join(base, 'Kiro.app', 'Contents', 'Resources', 'app', 'package.json'));
  } else if (h.platform === 'win32') {
    const local = h.env.LOCALAPPDATA || p.join(h.home, 'AppData', 'Local');
    out.push(p.join(local, 'Programs', 'Kiro', 'resources', 'app', 'package.json'));
    for (const pf of [h.env.ProgramFiles, h.env['ProgramFiles(x86)']]) if (pf) out.push(p.join(pf, 'Kiro', 'resources', 'app', 'package.json'));
  } else {
    for (const dir of ['/usr/share/kiro', '/opt/Kiro', '/opt/kiro', p.join(h.home, '.local', 'share', 'kiro'), '/snap/kiro/current/usr/share/kiro']) {
      out.push(p.join(dir, 'resources', 'app', 'package.json'));
    }
  }
  // the `kiro` launcher: <app>/bin/code (macOS) or <install>/bin/kiro (Linux, Windows kiro.cmd)
  const launcher = which('kiro', h);
  if (launcher) {
    const real = realpathOr(launcher);
    const binDir = p.dirname(real);
    out.push(p.join(binDir, '..', 'package.json'), p.join(binDir, '..', 'resources', 'app', 'package.json'));
  }
  return [...new Set(out)];
}

/** Candidate Kiro CLI executables. `KOPT_KIRO_CLI` (a path, or `none`) replaces the search. */
export function cliCandidates(h: HostEnv = hostEnv()): string[] {
  const p = pathFor(h.platform);
  const over = h.env.KOPT_KIRO_CLI;
  if (over) return over === 'none' ? [] : [over];
  const out: string[] = [];
  const onPath = which('kiro-cli', h);
  if (onPath) out.push(onPath);
  if (h.platform === 'win32') {
    const local = h.env.LOCALAPPDATA || p.join(h.home, 'AppData', 'Local');
    out.push(p.join(h.home, '.local', 'bin', 'kiro-cli.exe'), p.join(local, 'Programs', 'kiro-cli', 'kiro-cli.exe'), p.join(local, 'kiro-cli', 'kiro-cli.exe'));
  } else {
    out.push(p.join(h.home, '.local', 'bin', 'kiro-cli'), '/opt/homebrew/bin/kiro-cli', '/usr/local/bin/kiro-cli', '/usr/bin/kiro-cli');
  }
  return [...new Set(out)].filter((c) => isFile(c));
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Path entries of a (possibly simulated) environment. */
export function pathEntries(h: HostEnv = hostEnv()): string[] {
  const raw = h.env.PATH ?? h.env.Path ?? h.env.path ?? '';
  return raw.split(listSep(h)).filter(Boolean);
}

/** `which`: first executable named `cmd` on PATH (PATHEXT on Windows). `skip` filters out directories. */
export function which(cmd: string, h: HostEnv = hostEnv(), skip?: (dir: string) => boolean): string | undefined {
  const p = pathFor(h.platform);
  const exts = h.platform === 'win32' ? ['', ...(h.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase())] : [''];
  for (const dir of pathEntries(h)) {
    if (skip?.(dir)) continue;
    for (const ext of exts) {
      const full = p.join(dir, cmd + ext);
      if (isFile(full)) return full;
    }
  }
  return undefined;
}

/** npm's temporary `npx` install cache (…/_npx/<hash>/…): binaries there disappear after the run. */
export function isNpxCachePath(path: string): boolean {
  return /[\\/]_npx[\\/]/.test(path);
}

export function readJsonFile<T = unknown>(path: string): T | undefined {
  try {
    return JSON.parse(stripBom(readFileSync(path, 'utf8'))) as T;
  } catch {
    return undefined;
  }
}

export function exists(path: string): boolean {
  return existsSync(path);
}
