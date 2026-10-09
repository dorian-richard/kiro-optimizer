// Cross-platform test utilities for temp dirs and child-process environments.

import { realpathSync, rmSync } from 'node:fs';

/**
 * Remove a temp tree. Windows refuses to delete a file another process still has open (a detached background
 * `kopt index --refresh` started by a hook, an MCP server child that is still exiting) or a directory that is a
 * process's cwd: retry for a few seconds instead of failing the suite on cleanup.
 */
export function rmTree(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/**
 * `base` with `overrides` applied for a child process. Windows environment names are case-insensitive and a
 * runner's `NPM_CONFIG_PREFIX` would win over an added `npm_config_prefix` (Node passes both; the first in sort
 * order wins), so every spelling of an overridden name is dropped first.
 */
export function childEnv(base: NodeJS.ProcessEnv, overrides: Record<string, string>): NodeJS.ProcessEnv {
  const lower = new Set(Object.keys(overrides).map((k) => k.toLowerCase()));
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!lower.has(k.toLowerCase())) out[k] = v;
  return { ...out, ...overrides };
}

/** Canonical spelling of an existing path (Windows 8.3 short names expanded, symlinks resolved). */
function canonical(p: string): string {
  const real = realpathSync.native(p);
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

/** `child` is `parent` or inside it, whatever the spelling (separators, short names, case on Windows). */
export function isInside(child: string, parent: string): boolean {
  const c = canonical(child);
  const p = canonical(parent).replace(/[\\/]+$/, '');
  return c === p || c.startsWith(p + '/') || c.startsWith(p + '\\');
}
