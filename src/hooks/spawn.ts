// Detached background `kopt <subcommand>` processes started from hooks.
//
// Kiro IDE runs hook commands with `spawn(command, { shell: true, detached: !win32 })` (0.12 bundle: /bin/sh -c on
// POSIX, cmd.exe /d /s /c on Windows) and waits for the stdio pipes to close (and kills the whole process group
// on timeout). A background child must therefore get its own process group and must not inherit stdio, or it
// would hold the hook open / be killed with it.
// On Windows, `detached` keeps the child out of this process's kill-on-close job object (libuv assigns every
// non-detached child to one) and gives it no console; `windowsHide` keeps a console window from flashing.
// The command is `process.execPath` + the kopt entry script, so nothing depends on PATH or on npm's
// shell shims (`kopt.cmd`, `kopt.ps1`, `#!/usr/bin/env` lines).

import { spawn, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type Spawner = (argv: string[], cwd: string) => void;

/** Locate the package root (directory holding package.json + templates/), from src/ or dist/. */
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'templates'))) return dir;
    dir = dirname(dir);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/**
 * `--import` value that registers tsx in a child Node process. Always an absolute file:// URL: a bare `tsx`
 * would resolve from the child's cwd (the user's repo, which has no tsx), and a Windows path such as
 * `C:\...\loader.mjs` would be read as a URL with scheme `c:`.
 */
export function tsxImportUrl(root = packageRoot()): string {
  const local = join(root, 'node_modules', 'tsx', 'dist', 'loader.mjs');
  if (existsSync(local)) return pathToFileURL(local).href;
  try {
    // hoisted installs: resolve from this module
    return pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  } catch {
    return pathToFileURL(local).href;
  }
}

const ENTRY_JS = /^(?:bin|cli)\.[cm]?js$/;
const ENTRY_TS = /^(?:bin|cli)\.[cm]?ts$/;

/**
 * Absolute command line that runs the kopt CLI: [node, flags..., entry]. Prefers the built entry (dist/bin.js,
 * then dist/cli.js); falls back to the TypeScript sources through the tsx loader (dev checkouts).
 */
export function koptInvocation(): string[] {
  const node = process.execPath;
  const flags = ['--no-warnings=ExperimentalWarning'];
  const env = process.env.KOPT_CLI;
  const argv1 = process.argv[1];
  const root = packageRoot();
  // built JS first: a hook resolved to the .ts entry would pay the tsx compile on every tool call
  const candidates = [
    env,
    argv1 && ENTRY_JS.test(basename(argv1)) ? argv1 : undefined,
    join(root, 'dist', 'bin.js'),
    join(root, 'dist', 'cli.js'),
    argv1 && ENTRY_TS.test(basename(argv1)) ? argv1 : undefined,
    join(root, 'src', 'bin.ts'),
    join(root, 'src', 'cli.ts'),
  ];
  const cli = candidates.find((c): c is string => !!c && existsSync(c)) ?? join(root, 'dist', 'cli.js');
  if (/\.[cm]?ts$/.test(cli)) return [node, ...flags, '--import', tsxImportUrl(root), resolve(cli)];
  return [node, ...flags, resolve(cli)];
}

/** Options of every background spawn (exported for tests). */
export function backgroundSpawnOptions(cwd: string): SpawnOptions {
  return {
    cwd,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, KOPT_BACKGROUND: '1' },
  };
}

const defaultSpawner: Spawner = (argv, cwd) => {
  const child = spawn(argv[0], argv.slice(1), backgroundSpawnOptions(cwd));
  child.on('error', () => { /* best effort */ });
  child.unref();
};

let spawner: Spawner = defaultSpawner;

/** Test hook: replace the process spawner (returns the previous one). */
export function setSpawner(s: Spawner | undefined): Spawner {
  const prev = spawner;
  spawner = s ?? defaultSpawner;
  return prev;
}

/** Start `kopt <args>` detached in `cwd`; never throws, never waits. */
export function spawnKopt(args: string[], cwd: string): void {
  try {
    spawner([...koptInvocation(), ...args], cwd);
  } catch {
    // background work is optional
  }
}
