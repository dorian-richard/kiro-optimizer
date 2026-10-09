// Kiro surface detection: which Kiro IDE / Kiro CLI versions are installed, and which hook formats they read.
//
//  IDE 0.x   : hooks only from <workspace>/.kiro/hooks/*.kiro.hook (legacy `when`/`then` schema). Verified in the
//              0.12.318 bundle (kiro.kiro-agent/dist/extension.js, HookStorage._getHooksDirectories = workspace folders
//              only; the insider-only `v2Hooks` experiment also reads <cwd>/.kiro/hooks/*.json only).
//  IDE 1.x   : `.kiro/hooks/*.json` v1 schema, workspace + global `~/.kiro/hooks/` (kiro.dev/docs/configuration).
//  CLI 2.x   : hooks embedded in agent configs (object form); `chat.agentEngine` = v1 | v2 (default) | v3.
//  CLI V3    : `.kiro/hooks/*.json` + `~/.kiro/hooks/` (same harness as IDE 1.x); `--v3` or chat.agentEngine=v3.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathFor } from '../core/config.js';
import { cliCandidates, hostEnv, ideCandidates, isFile, kiroCliSettingsPath, readJsonFile, realpathOr, type HostEnv } from './paths.js';

export type Surface = 'ide' | 'cli';
export type SurfaceChoice = Surface | 'all';

export interface IdeInfo {
  version: string;
  major: number;
  /** package.json that gave the version. */
  path: string;
}

export interface CliInfo {
  version: string;
  major: number;
  path: string;
  /** Agent engine used by `kiro-cli chat` (chat.agentEngine, or the version's default). */
  engine: 'v1' | 'v2' | 'v3';
}

export interface Surfaces {
  ide?: IdeInfo;
  cli?: CliInfo;
}

const VERSION_RE = /(\d+)\.(\d+)\.(\d+)/;

function major(version: string): number {
  const m = VERSION_RE.exec(version);
  return m ? Number(m[1]) : 0;
}

export function detectIde(h: HostEnv = hostEnv()): IdeInfo | undefined {
  for (const pkg of ideCandidates(h)) {
    if (!isFile(pkg)) continue;
    const json = readJsonFile<{ name?: string; productName?: string; version?: string }>(pkg);
    const name = `${json?.name ?? ''} ${json?.productName ?? ''}`.toLowerCase();
    if (!json?.version || !VERSION_RE.test(json.version) || !name.includes('kiro')) continue;
    return { version: VERSION_RE.exec(json.version)![0], major: major(json.version), path: pkg };
  }
  return undefined;
}

export type VersionRunner = (exe: string) => string | undefined;

/** `<exe> --version` with a short timeout; stdin closed so nothing can prompt. */
export const runVersion: VersionRunner = (exe) => {
  try {
    return execFileSync(exe, ['--version'], {
      encoding: 'utf8',
      timeout: 8000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(exe),
    });
  } catch {
    return undefined;
  }
};

/** macOS app bundles ship `Contents/Resources/manifest.json` with the version (no process spawn needed). */
function bundleVersion(exe: string, h: HostEnv): string | undefined {
  if (h.platform !== 'darwin') return undefined;
  const p = pathFor(h.platform);
  const real = realpathOr(exe);
  const manifest = readJsonFile<{ version?: string }>(p.join(p.dirname(real), '..', 'Resources', 'manifest.json'));
  return manifest?.version && VERSION_RE.test(manifest.version) ? manifest.version : undefined;
}

export function cliEngine(version: string, h: HostEnv = hostEnv()): CliInfo['engine'] {
  const settings = readJsonFile<Record<string, unknown>>(kiroCliSettingsPath(h)) ?? {};
  const engine = settings['chat.agentEngine'];
  if (engine === 'v1' || engine === 'v2' || engine === 'v3') return engine;
  return major(version) >= 3 ? 'v3' : 'v2';
}

export function detectCli(h: HostEnv = hostEnv(), run: VersionRunner = runVersion): CliInfo | undefined {
  for (const exe of cliCandidates(h)) {
    const text = bundleVersion(exe, h) ?? run(exe);
    const m = text ? VERSION_RE.exec(text) : null;
    if (!m) continue;
    return { version: m[0], major: Number(m[1]), path: exe, engine: cliEngine(m[0], h) };
  }
  return undefined;
}

export function detectSurfaces(h: HostEnv = hostEnv(), o: { surface?: SurfaceChoice; run?: VersionRunner } = {}): Surfaces {
  const want = o.surface ?? 'all';
  return {
    ide: want === 'cli' ? undefined : detectIde(h),
    cli: want === 'ide' ? undefined : detectCli(h, o.run),
  };
}

/** Which hook formats to install for the detected (or forced) surfaces. */
export interface HookPlan {
  /** ~/.kiro/hooks/kopt.json (IDE 1.x, CLI V3). */
  globalV1: boolean;
  /** ~/.kiro/agents/kopt.json with embedded hooks + default agent (CLI 2.x). */
  cliAgent: boolean;
  /** Workspace `.kiro.hook` files written by the MCP server on first start (IDE 0.x). */
  legacyWorkspace: boolean;
}

export function hookPlan(s: Surfaces, forced?: SurfaceChoice): HookPlan {
  const ide = forced === 'ide' || forced === 'all' || !!s.ide;
  const cli = forced === 'cli' || forced === 'all' || !!s.cli;
  const ideMajor = s.ide?.major;
  const cliMajor = s.cli?.major;
  return {
    // IDE 1.x and CLI V3 read it; older surfaces ignore *.json files in ~/.kiro/hooks, so it also prepares an upgrade.
    globalV1: ide || cli,
    cliAgent: cli && (cliMajor === undefined || cliMajor < 3),
    legacyWorkspace: ide && ideMajor !== undefined && ideMajor < 1,
  };
}

/** Last detection result, cached for the MCP server (which must decide quickly and cannot see the IDE's env). */
export function surfacesCachePath(userDir: string): string {
  return pathFor().join(userDir, 'surfaces.json');
}

export function writeSurfacesCache(userDir: string, s: Surfaces): void {
  try {
    mkdirSync(userDir, { recursive: true });
    writeFileSync(surfacesCachePath(userDir), JSON.stringify({ ...s, at: Date.now() }, null, 2) + '\n');
  } catch {
    // a cache
  }
}

export function readSurfacesCache(userDir: string): (Surfaces & { at?: number }) | undefined {
  return readJsonFile<Surfaces & { at?: number }>(surfacesCachePath(userDir));
}

export function describeSurfaces(s: Surfaces): string {
  const parts: string[] = [];
  if (s.ide) parts.push(`Kiro IDE ${s.ide.version}`);
  if (s.cli) parts.push(`Kiro CLI ${s.cli.version}${s.cli.engine === 'v3' && s.cli.major < 3 ? ' (V3 engine)' : ''}`);
  return parts.join(' and ') || 'no Kiro install detected';
}
