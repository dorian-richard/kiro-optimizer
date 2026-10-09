// How Kiro should start kopt: the hook command line (run by Kiro through a shell) and the MCP stdio entry.
//
// Preferred: the bare `kopt` shim npm puts on PATH. It works unchanged in sh, cmd.exe and PowerShell, survives Node
// upgrades, and never embeds a user-specific absolute path. Fallback (kopt not on PATH, or the `node` it would run is
// older than 22.13): an explicit Node binary + the absolute path of kopt's bin.js.
//
// Windows hooks use `kopt.cmd`: PowerShell resolves a bare `kopt` to npm's kopt.ps1 shim, which the default
// execution policy (Restricted) refuses to run; a .cmd file runs in both cmd.exe and PowerShell.
// Windows MCP entry: `node <abs bin.js>` even when the shim exists. The IDE spawns MCP servers through cross-spawn
// (verified in the 0.12 bundle: StdioClientTransport -> import_cross_spawn), which resolves `kopt.cmd`, but a native
// (Rust) MCP client such as the Kiro CLI may not resolve `.cmd` shims; `node.exe` resolves everywhere.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { pathFor } from '../core/config.js';
import { packageRoot } from '../hooks/spawn.js';
import { hostEnv, isNpxCachePath, which, type HostEnv } from './paths.js';

export const MIN_NODE = [22, 13] as const;

export interface KoptCommand {
  /** Shell command prefix for hooks, e.g. `kopt` or `'/usr/bin/node' '/x/dist/bin.js'`. */
  shell: string;
  /** MCP stdio server entry (without autoApprove). */
  mcp: { command: string; args: string[] };
  /** `shim` = bare kopt on PATH; `node` = explicit Node binary + bin.js. */
  kind: 'shim' | 'node';
  /** Absolute path of the kopt shim used, when kind = shim. */
  shimPath?: string;
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
function transientBinDir(dir: string): boolean {
  return isNpxCachePath(dir + '/') || /[\\/]node_modules[\\/]\.bin$/.test(dir);
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

/** Quote one argument for the shell Kiro uses for hook commands (sh on POSIX, cmd/PowerShell on Windows). */
export function shellArg(arg: string, platform: NodeJS.Platform = process.platform): string {
  if (/^[A-Za-z0-9_\/.:=@%+,-]+$/.test(arg)) return arg;
  if (platform === 'win32') return `"${arg.replace(/"/g, '\\"')}"`;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export interface ResolveOptions {
  h?: HostEnv;
  /** kopt's bin.js to use in the fallback (default: this package's). */
  bin?: string;
  /** Node binary for the POSIX fallback (default: the running one). */
  nodePath?: string;
  /** Skip PATH detection (tests, `--node`). */
  force?: 'shim' | 'node';
  /** Version of the PATH `node` (injected by tests; default: probed). */
  nodeVersion?: string;
}

export function resolveKoptCommand(o: ResolveOptions = {}): KoptCommand {
  const h = o.h ?? hostEnv();
  const bin = o.bin ?? binPath(undefined, h.platform);
  const shimPath = o.force === 'node' ? undefined : which('kopt', h, transientBinDir);
  const shimUsable = o.force === 'shim' || (!!shimPath && nodeVersionOk(o.nodeVersion ?? pathNodeVersion(h)));
  if (shimUsable) {
    return {
      shell: h.platform === 'win32' ? 'kopt.cmd' : 'kopt',
      mcp: h.platform === 'win32' ? { command: 'node', args: [bin, 'mcp'] } : { command: 'kopt', args: ['mcp'] },
      kind: 'shim',
      shimPath,
    };
  }
  // Windows: a bare `node` keeps the line valid in both cmd.exe and PowerShell (a quoted exe path is not).
  const node = h.platform === 'win32' ? 'node' : (o.nodePath ?? process.execPath);
  return {
    shell: [node, bin].map((a) => shellArg(a, h.platform)).join(' '),
    mcp: { command: node, args: [bin, 'mcp'] },
    kind: 'node',
  };
}

/** Hook command line for one hook source (`global`, `workspace`, `agent`, `legacy`). */
export function hookCommandLine(cmd: KoptCommand, source: string, extra: string[] = []): string {
  return [cmd.shell, 'hook', ...extra, '--source', source].join(' ');
}
