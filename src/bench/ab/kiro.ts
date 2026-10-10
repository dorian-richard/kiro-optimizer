// Locating and calling kiro-cli for the A/B harness. Only offline subcommands are used here (--version, whoami,
// agent validate, mcp list) plus `chat --list-models` once the account is known to be logged in. A prompt is only
// ever sent by runner.ts, after the preflight passed.
//
// kiro-cli-chat is preferred over the `kiro-cli` launcher: the launcher looks for the chat binary under
// $HOME/.local/bin (verified with 2.28 in a temporary HOME), kiro-cli-chat accepts the same chat flags anywhere.

import { existsSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { which, type HostEnv } from '../../kiro/paths.js';
import { launcherFor, runProcess, type Launcher, type ProcResult } from './proc.js';

export interface KiroCli extends Launcher {
  /** How it was found (for the check report). */
  source: string;
}

function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** KIRO_CLI (or --kiro-cli) wins; then kiro-cli-chat (PATH, ~/.local/bin, the macOS app); then the kiro-cli launcher. */
export function resolveKiroCli(env: NodeJS.ProcessEnv, nodePath: string, explicit?: string): KiroCli | undefined {
  const over = explicit || env.KIRO_CLI;
  if (over) return { ...launcherFor(over, nodePath), source: explicit ? '--kiro-cli' : 'KIRO_CLI' };
  const h: HostEnv = { platform: process.platform, env, home: (process.platform === 'win32' ? env.USERPROFILE : env.HOME) || homedir() };
  const exe = process.platform === 'win32' ? '.exe' : '';
  const candidates: Array<[string | undefined, string]> = [
    [which('kiro-cli-chat', h), 'PATH'],
    [join(h.home, '.local', 'bin', `kiro-cli-chat${exe}`), '~/.local/bin'],
  ];
  if (process.platform === 'darwin') candidates.push(['/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli-chat', '/Applications']);
  if (process.platform === 'win32') {
    const local = env.LOCALAPPDATA || join(h.home, 'AppData', 'Local');
    candidates.push([join(local, 'Programs', 'kiro-cli', 'kiro-cli-chat.exe'), '%LOCALAPPDATA%'], [join(local, 'kiro-cli', 'kiro-cli-chat.exe'), '%LOCALAPPDATA%']);
  }
  for (const [p, source] of candidates) {
    if (p && existsSync(p)) return { ...launcherFor(realpathOr(p), nodePath), source: `kiro-cli-chat (${source})` };
  }
  const launcher = which('kiro-cli', h) ?? [join(h.home, '.local', 'bin', `kiro-cli${exe}`)].find((p) => existsSync(p));
  if (launcher) return { ...launcherFor(launcher, nodePath), source: 'kiro-cli launcher' };
  return undefined;
}

/**
 * Under the test runner (VITEST set), the only kiro-cli ever started is the simulator, or a copy of a script under the
 * OS temporary directory (a test fixture): never a real install. Even an offline command (whoami, agent validate) is a
 * call to the developer's kiro-cli, and some of its commands can start a browser login on their own.
 */
export function startableUnderTests(cli: Launcher, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!env.VITEST) return true;
  const target = cli.prefix[0] ?? cli.command;
  if (/fake-kiro-cli\.(mjs|cmd)$/i.test(target)) return true;
  const inside = (dir: string, p: string) => {
    const r = relative(dir, p);
    return !!r && !r.startsWith('..') && !isAbsolute(r);
  };
  const dirs = [tmpdir(), realpathOr(tmpdir())];
  return [target, realpathOr(target)].some((p) => dirs.some((d) => inside(d, p)));
}

export async function kiroCall(cli: Launcher, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<ProcResult> {
  if (!startableUnderTests(cli)) throw new Error(`refusing to start ${cli.display} under the test runner (VITEST is set): point KIRO_CLI at bench/ab/fake-kiro-cli.mjs`);
  return runProcess(cli, args, { cwd: o.cwd, env: o.env, timeoutMs: o.timeoutMs ?? 30_000 });
}

export function parseVersion(out: string): string | undefined {
  const m = /(\d+\.\d+\.\d+(?:[-+.][\w.]+)?)/.exec(out);
  return m?.[1];
}

export function versionAtLeast(v: string | undefined, min: [number, number, number]): boolean {
  const m = v ? /^(\d+)\.(\d+)\.(\d+)/.exec(v) : null;
  if (!m) return false;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) {
    if (parts[i] !== min[i]) return parts[i] > min[i];
  }
  return true;
}

export interface WhoAmI {
  loggedIn: boolean;
  method?: string;
  output: string;
  code: number | null;
}

/** `whoami` (exit 0 = authenticated). The account e-mail is never kept: only the login method. */
export function parseWhoami(r: ProcResult): WhoAmI {
  const text = `${r.stdout}\n${r.stderr}`;
  const loggedIn = r.code === 0 && !/not logged in/i.test(text);
  const method = /API key/i.test(text) ? 'API key' : /Builder ID/i.test(text) ? 'Builder ID' : /IAM Identity Center|Identity Center/i.test(text) ? 'IAM Identity Center' : /Logged in/i.test(text) ? 'logged in' : undefined;
  const redacted = text.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>').trim().split(/\r?\n/).slice(0, 3).join(' | ');
  return { loggedIn, method, output: redacted, code: r.code };
}

export interface ModelInfo {
  id: string;
  multiplier?: number;
}

/** `chat --list-models --format json`: the schema is not documented; collect every object with a model id. */
export function parseModelList(text: string): ModelInfo[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const out = new Map<string, ModelInfo>();
  const visit = (x: unknown) => {
    if (Array.isArray(x)) return x.forEach(visit);
    if (!x || typeof x !== 'object') return;
    const o = x as Record<string, unknown>;
    const id = o.modelId ?? o.model_id ?? o.id;
    if (typeof id === 'string' && id.trim()) {
      const m = Number(o.rateMultiplier ?? o.rate_multiplier ?? o.creditMultiplier ?? o.multiplier);
      out.set(id.trim(), { id: id.trim(), ...(Number.isFinite(m) && m > 0 ? { multiplier: m } : {}) });
    }
    for (const v of Object.values(o)) if (v && typeof v === 'object') visit(v);
  };
  visit(data);
  return [...out.values()];
}

export function cheapestModel(models: ModelInfo[]): ModelInfo | undefined {
  const priced = models.filter((m) => m.multiplier !== undefined && !/^auto$/i.test(m.id));
  return priced.sort((a, b) => a.multiplier! - b.multiplier! || a.id.localeCompare(b.id))[0];
}

/** `agent validate` always exits 0 in 2.28: problems only show on stderr (verified). */
export function validateOutputProblems(r: ProcResult): string | undefined {
  const err = r.stderr.replace(/\x1b\[[0-9;]*m/g, '').trim();
  if (r.code !== 0) return `exit ${r.code}${err ? `: ${err}` : ''}`;
  return err ? err.split(/\r?\n/).slice(0, 3).join(' | ') : undefined;
}

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}
