// Per-arm isolation: a git worktree of the repo per arm, a KIRO_HOME per arm (agents, settings/cli.json, global
// mcp.json, V2 sessions), kopt installed only where the arm says so, and a snapshot of each prepared worktree so every
// run starts from exactly the same files.
//
// HOME / USERPROFILE are never changed: kiro-cli keeps its login under the user's home (macOS
// ~/Library/Application Support/kiro-cli/data.sqlite3), not under KIRO_HOME (verified with 2.28: with HOME and
// KIRO_HOME pointing to different directories, `whoami` opens the database under HOME, while `agent list`,
// `mcp list` and `settings` read and write KIRO_HOME only).

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';
import { repoCacheKey } from '../../core/config.js';
import { hookCommandLine, resolveKoptCommand, shellArg } from '../../kiro/command.js';
import { renderTemplate } from '../../kiro/setup.js';
import { bucketCandidates } from './parse.js';
import type { Arm, Engine } from './types.js';

// ---------------------------------------------------------------------------------------------------------
// git

let noHooksDir: string | undefined;

/**
 * Options of every git call the harness makes: the repository's own hooks (husky, lefthook, a post-checkout that
 * installs dependencies...) never run in the arms' worktrees (worktree add and every restore checkout would trigger
 * them), and Windows accepts paths longer than 260 characters (the output directory makes every path longer).
 * The empty hooks directory is private to this process (a shared fixed path could be planted with a hook).
 */
export function gitConfigArgs(): string[] {
  noHooksDir ??= mkdtempSync(join(tmpdir(), 'kopt-ab-nohooks-'));
  return ['-c', `core.hooksPath=${noHooksDir}`, ...(process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : [])];
}

export function git(args: string[], cwd: string, timeoutMs = 120_000): string {
  try {
    return execFileSync('git', [...gitConfigArgs(), ...args], { cwd, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${(e.stderr || e.message).toString().trim().split('\n').slice(-3).join(' | ')}`);
  }
}

export interface RepoInfo {
  root: string;
  head: string;
  dirty: string[];
}

export function repoInfo(path: string): RepoInfo {
  const root = git(['rev-parse', '--show-toplevel'], path).trim();
  const head = git(['rev-parse', 'HEAD'], path).trim();
  const dirty = parseStatus(git(['status', '--porcelain=v1', '-z', '--untracked-files=normal'], root)).map((e) => `${e.code} ${e.path}`);
  return { root, head, dirty };
}

export interface StatusEntry {
  code: string;
  path: string;
  /** Source path of a rename or copy (it is gone from the worktree or the index too). */
  orig?: string;
}

/** `git status --porcelain=v1 -z` entries (renames report the new path, and the old one in `orig`). */
export function parseStatus(out: string): StatusEntry[] {
  const parts = out.split('\0');
  const res: StatusEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length < 4) continue;
    const code = p.slice(0, 2);
    const e: StatusEntry = { code, path: p.slice(3) };
    if (code[0] === 'R' || code[0] === 'C') {
      i++; // the next part is the old path
      if (parts[i]) e.orig = parts[i];
    }
    res.push(e);
  }
  return res;
}

/** Commit the worktree's HEAD points to. */
export function worktreeHead(wt: string): string {
  return git(['rev-parse', 'HEAD'], wt).trim();
}

/** HEAD is on a branch (a run switched branches) rather than detached. */
function headIsSymbolic(wt: string): boolean {
  try {
    git(['symbolic-ref', '-q', 'HEAD'], wt);
    return true;
  } catch {
    return false;
  }
}

/**
 * Put a worktree's HEAD back on `head`, detached, with the index matching it; the files are left as they are (the
 * baseline restore deals with them). Undoes a commit or a branch switch made by a run's shell tool.
 */
export function resetHead(wt: string, head: string): void {
  git(['update-ref', '--no-deref', 'HEAD', head], wt);
  git(['reset', '-q', '--mixed', head], wt);
}

/** HEAD moved (a run committed, switched branches...): returns the commit it moved to, after resetting it. */
export function guardHead(wt: string, head: string): string | undefined {
  const cur = worktreeHead(wt);
  if (cur === head && !headIsSymbolic(wt)) return undefined;
  resetHead(wt, head);
  return cur;
}

export function ensureWorktree(repoRoot: string, wt: string, head: string, log?: (m: string) => void): void {
  if (existsSync(join(wt, '.git'))) {
    // the worktree is the harness's own: a run that committed or switched branches before the harness could reset
    // it (a killed campaign) is put back on the campaign's commit
    const moved = guardHead(wt, head);
    if (moved) log?.(`${wt}: HEAD was at ${moved.slice(0, 12)} (a commit or branch switch by a run), reset to ${head.slice(0, 12)}`);
    return;
  }
  if (existsSync(wt) && readdirSync(wt).length) throw new Error(`${wt} exists and is not a worktree: remove it`);
  mkdirSync(dirname(wt), { recursive: true });
  git(['worktree', 'add', '--detach', wt, head], repoRoot, 600_000);
}

export function removeWorktree(repoRoot: string, wt: string): void {
  if (!existsSync(wt)) return;
  try {
    git(['worktree', 'remove', '--force', wt], repoRoot);
  } catch {
    rmSync(wt, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    try {
      git(['worktree', 'prune'], repoRoot);
    } catch {
      // best effort
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Baseline snapshot and restore: after the arm is prepared, every modified or untracked file is copied aside; before
// and after each run, the worktree is put back to exactly that state.

export interface Baseline {
  /** repo-relative paths that differ from HEAD after preparation */
  paths: string[];
  /** paths deleted relative to HEAD in the baseline */
  deleted: string[];
}

function sameFile(a: string, b: string): boolean {
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    if (sa.size !== sb.size) return false;
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

/** Kiro configuration paths managed even when the repository's .gitignore hides them from `git status`. */
const KIRO_PATHS = ['.kiro', '.kiroignore', join('.vscode', 'settings.json')];

/** Untracked files under the Kiro configuration paths, ignored ones included (repo-relative, forward slashes). */
function untrackedKiroFiles(wt: string): string[] {
  const tracked = new Set(git(['ls-files', '-z', '--', ...KIRO_PATHS.map((p) => p.replace(/\\/g, '/'))], wt).split('\0').filter(Boolean));
  const out: string[] = [];
  for (const p of KIRO_PATHS) {
    const abs = join(wt, p);
    if (!existsSync(abs)) continue;
    const files = statSync(abs).isDirectory() ? walkFiles(abs) : [abs];
    for (const f of files) {
      const rel = relative(wt, f).split(/[\\/]/).join('/');
      if (!tracked.has(rel)) out.push(rel);
    }
  }
  return out;
}

export function snapshotBaseline(wt: string, store: string): Baseline {
  rmSync(store, { recursive: true, force: true });
  mkdirSync(store, { recursive: true });
  const entries = parseStatus(git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], wt));
  const b: Baseline = { paths: [], deleted: [] };
  const keep = (rel: string) => {
    const dst = join(store, 'files', rel);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(join(wt, rel), dst);
    b.paths.push(rel);
  };
  for (const e of entries) {
    const src = join(wt, e.path);
    if (existsSync(src) && statSync(src).isFile()) keep(e.path);
    else if (!existsSync(src)) b.deleted.push(e.path);
  }
  // Kiro files a .gitignore hides (many repos ignore .kiro/ or .vscode/)
  for (const rel of untrackedKiroFiles(wt)) if (!b.paths.includes(rel)) keep(rel);
  writeFileSync(join(store, 'baseline.json'), JSON.stringify(b, null, 2) + '\n');
  return b;
}

export function loadBaseline(store: string): Baseline | undefined {
  try {
    return JSON.parse(readFileSync(join(store, 'baseline.json'), 'utf8')) as Baseline;
  } catch {
    return undefined;
  }
}

/** Put the worktree back to its baseline. Returns the repo-relative paths that had changed. */
export function restoreBaseline(wt: string, store: string, b: Baseline): string[] {
  const changed = new Set<string>();
  const inBase = new Set(b.paths);
  const deletedInBase = new Set(b.deleted);
  const entries = parseStatus(git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], wt));
  const toRestore = new Set<string>();
  for (const e of entries) {
    for (const p of [e.path, e.orig]) {
      if (p === undefined || inBase.has(p) || deletedInBase.has(p)) continue;
      changed.add(p);
      if (e.code === '??' && p === e.path) rmSync(join(wt, p), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      else toRestore.add(p);
    }
  }
  // Tracked paths (in HEAD) are checked out from HEAD; paths HEAD does not have (staged additions, the new side of a
  // staged rename) are dropped from the index and the disk. Never the other way round: a failing checkout must not
  // delete a tracked file.
  // (literal pathspecs: a file named `*.py` or `[x]` must not be read as a pattern)
  const paths = [...toRestore];
  const inHead = paths.length ? new Set(git(['ls-tree', '-r', '-z', '--name-only', 'HEAD'], wt).split('\0').filter(Boolean)) : new Set<string>();
  for (let i = 0; i < paths.length; i += 100) {
    const chunk = paths.slice(i, i + 100);
    const tracked = chunk.filter((p) => inHead.has(p));
    const added = chunk.filter((p) => !inHead.has(p));
    if (tracked.length) {
      try {
        git(['--literal-pathspecs', 'checkout', 'HEAD', '--', ...tracked], wt);
      } catch {
        // one path at a time, so one bad path does not leave the others unrestored
        for (const p of tracked) {
          try {
            git(['--literal-pathspecs', 'checkout', 'HEAD', '--', p], wt);
          } catch {
            // left as is; reported in the run's dirty list
          }
        }
      }
    }
    for (const p of added) {
      try {
        git(['--literal-pathspecs', 'rm', '--cached', '-q', '-f', '--ignore-unmatch', '--', p], wt);
      } catch {
        // not in the index
      }
      rmSync(join(wt, p), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
  // untracked Kiro files that are not part of the baseline (ignored ones included): created by the run
  for (const rel of untrackedKiroFiles(wt)) {
    if (inBase.has(rel)) continue;
    changed.add(rel);
    rmSync(join(wt, rel), { force: true, maxRetries: 5, retryDelay: 100 });
  }
  for (const p of b.paths) {
    const saved = join(store, 'files', p);
    const cur = join(wt, p);
    if (!sameFile(saved, cur)) {
      changed.add(p);
      mkdirSync(dirname(cur), { recursive: true });
      copyFileSync(saved, cur);
    }
  }
  for (const p of b.deleted) {
    if (existsSync(join(wt, p))) {
      changed.add(p);
      rmSync(join(wt, p), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
  return [...changed];
}

/**
 * MCP servers committed in the repository's `.kiro/settings/mcp.json`: removed from every arm's worktree (arm B keeps
 * only kopt). Arm A's agent does not include that file, arm B's does (kopt init puts kopt there); a repository server
 * that needs a token would then only start in arm B, and `--require-mcp-startup` would fail every B run. Returns the
 * names removed.
 */
export function stripRepoMcpServers(wt: string, keep?: string): string[] {
  const p = join(wt, '.kiro', 'settings', 'mcp.json');
  const cfg = readJson<{ mcpServers?: Record<string, unknown> } & Record<string, unknown>>(p);
  if (!cfg || !cfg.mcpServers || typeof cfg.mcpServers !== 'object') return [];
  const removed = Object.keys(cfg.mcpServers).filter((n) => n !== keep);
  if (!removed.length) return [];
  cfg.mcpServers = Object.fromEntries(Object.entries(cfg.mcpServers).filter(([n]) => n === keep));
  writeJson(p, cfg);
  return removed;
}

// ---------------------------------------------------------------------------------------------------------
// Agents

export const AGENT_PROMPT =
  'You answer questions about the code in the current workspace. Explore the code with the tools you have, then answer. Do not modify any file.';

export const KOPT_READ_TOOLS = ['kopt_find', 'kopt_read', 'kopt_outline', 'kopt_refs', 'kopt_expand'];

export const TOOL_TAGS = ['read', 'write', 'shell'] as const;
export type ToolTag = (typeof TOOL_TAGS)[number];

/** Built-in tool names per engine for the tags of --tools (V2: 2.x names, `read` = fs_read only; V3: tags). */
export function builtinTools(engine: Engine, tags: readonly ToolTag[]): string[] {
  if (engine === 'v3') return [...tags];
  const out: string[] = [];
  for (const t of tags) {
    if (t === 'read') out.push('fs_read', 'grep', 'glob');
    else if (t === 'write') out.push('fs_write');
    else if (t === 'shell') out.push('execute_bash');
  }
  return out;
}

export function trustList(engine: Engine, tags: readonly ToolTag[], kopt: boolean): string {
  const base = builtinTools(engine, tags);
  // V2 accepts MCP tools as @server/tool (one entry per tool; kopt_run stays untrusted: it runs commands).
  // V3 trusts MCP tools through the agent's permission rules instead.
  return [...base, ...(kopt && engine === 'v2' ? KOPT_READ_TOOLS.map((t) => `@kopt/${t}`) : [])].join(',');
}

export function agentName(arm: Arm): string {
  return `abarm-${arm.toLowerCase()}`;
}

export interface AgentSpec {
  arm: Arm;
  engine: Engine;
  tags: readonly ToolTag[];
  /** V2 map-form hooks (arm B on V2). */
  hooks?: Record<string, unknown>;
  /** embedded MCP servers (arm C). */
  mcpServers?: Record<string, unknown>;
  includeMcpJson: boolean;
  kopt: boolean;
}

export function agentConfig(s: AgentSpec): Record<string, unknown> {
  const base = builtinTools(s.engine, s.tags);
  const capabilities = s.tags.map((t) => (t === 'read' ? 'fs_read' : t === 'write' ? 'fs_write' : 'shell'));
  const description =
    s.arm === 'A'
      ? 'A/B arm A (control): stock Kiro tools only.'
      : s.arm === 'B'
        ? 'A/B arm B: stock tools plus the kopt MCP server, hooks and steering.'
        : 'A/B arm C: stock tools plus the kopt MCP server only (no hooks, no steering).';
  return {
    name: agentName(s.arm),
    description,
    prompt: AGENT_PROMPT,
    tools: [...base, ...(s.kopt ? ['@kopt'] : [])],
    allowedTools: [...builtinTools('v2', s.tags), ...(s.kopt ? KOPT_READ_TOOLS.map((t) => `@kopt/${t}`) : [])],
    includeMcpJson: s.includeMcpJson,
    includePowers: false,
    ...(s.mcpServers ? { mcpServers: s.mcpServers } : {}),
    permissions: {
      rules: [
        ...capabilities.map((capability) => ({ capability, effect: 'allow' })),
        ...(s.kopt ? [{ capability: 'mcp', match: KOPT_READ_TOOLS.map((t) => `kopt/${t}`), effect: 'allow' }] : []),
      ],
    },
    ...(s.hooks ? { hooks: s.hooks } : {}),
  };
}

/**
 * Hook command prefix for the harness: the absolute Node and bin.js. Which shell Kiro runs hooks through on Windows
 * (cmd.exe or PowerShell) is not verified, and a quoted executable path (kopt setup's Windows form, written for
 * cmd.exe) is not a command in PowerShell. So on Windows the absolute path is used whenever it needs no quoting (no
 * space or special character), and a bare `node` otherwise: the harness puts the chosen Node first on the arms' PATH,
 * and both shells run either form as is.
 */
export function hookPrefix(nodePath: string, binJs: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  // a path cmd.exe and PowerShell both take unquoted: no space, quote, %, &, |, (, ), ;, `, $ ...
  const plain = (p: string) => /^[A-Za-z0-9_\\/.:=@+,-]+$/.test(p);
  if (platform === 'win32') return `${plain(nodePath) ? nodePath : 'node'} ${shellArg(binJs, platform)}`;
  return resolveKoptCommand({ force: 'node', bin: binJs, nodePath, h: { platform, env, home: '' } }).shell;
}

/** kopt's own Kiro CLI 2.x agent hooks (agentSpawn, userPromptSubmit, preToolUse, postToolUse, stop). */
export function koptAgentHooks(nodePath: string, binJs: string, env: NodeJS.ProcessEnv): Record<string, unknown> {
  const shell = hookPrefix(nodePath, binJs, env);
  return renderTemplate('agents/kopt.json', hookCommandLine({ shell, mcp: { command: nodePath, args: [binJs, 'mcp'] }, kind: 'node' }, 'agent')).hooks as Record<string, unknown>;
}

export function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, path);
}

export function readJson<T = unknown>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, '')) as T;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Environment

/** Set a variable, dropping other spellings of the name on Windows (case-insensitive environment). */
export function setEnv(env: NodeJS.ProcessEnv, key: string, value: string | undefined): void {
  if (process.platform === 'win32') for (const k of Object.keys(env)) if (k.toLowerCase() === key.toLowerCase() && k !== key) delete env[k];
  if (value === undefined) delete env[key];
  else env[key] = value;
}

export function getEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  if (process.platform !== 'win32') return env[key];
  const k = Object.keys(env).find((x) => x.toLowerCase() === key.toLowerCase());
  return k ? env[k] : undefined;
}

export interface EnvSpec {
  kiroHome: string;
  koptHome: string;
  cacheDir: string;
  /** kopt data dir of the arm's worktree (index): fixed, so a committed kopt.config.json `dataDir` cannot move it. */
  dataDir: string;
  nodePath: string;
  ideSettings: string;
}

/**
 * Environment of every kiro-cli and kopt process of an arm: the caller's environment minus every inherited KOPT_*
 * variable (a KOPT_TELEMETRY=0 or KOPT_HOOKS=0 would hide kopt's work, KOPT_ROOT / KOPT_DATA_DIR would redirect the
 * index), then KIRO_HOME and kopt's directories for this arm/run, and the chosen Node first on PATH (kopt's Windows
 * hook commands call a bare `node`). kopt's IDE 0.x legacy workspace hooks are turned off: they are not part of the
 * CLI treatment. HOME and USERPROFILE are kept: the login lives there.
 */
export function armEnv(base: NodeJS.ProcessEnv, s: EnvSpec): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!/^KOPT_/i.test(k) && v !== undefined) env[k] = v;
  setEnv(env, 'KIRO_HOME', s.kiroHome);
  setEnv(env, 'KOPT_HOME', s.koptHome);
  setEnv(env, 'KOPT_CACHE_DIR', s.cacheDir);
  setEnv(env, 'KOPT_KIRO_HOME', s.kiroHome);
  setEnv(env, 'KOPT_KIRO_USER_SETTINGS', s.ideSettings);
  setEnv(env, 'KOPT_DATA_DIR', s.dataDir);
  // kopt's telemetry is the proof of kopt usage: a committed kopt.config.json with telemetry off must not hide it
  setEnv(env, 'KOPT_TELEMETRY', '1');
  // IDE 0.x workspace hooks are not part of the CLI treatment (and would edit the repo's .git/info/exclude)
  setEnv(env, 'KOPT_LEGACY_WORKSPACE_HOOKS', '0');
  // no self-update in the middle of a campaign (app.disableAutoupdates is also set in every arm's cli.json)
  setEnv(env, 'KIRO_NO_AUTO_UPDATE', '1');
  setEnv(env, 'PATH', [dirname(s.nodePath), getEnv(env, 'PATH') ?? ''].filter(Boolean).join(delimiter));
  setEnv(env, 'NO_COLOR', '1');
  setEnv(env, 'KIRO_LOG_NO_COLOR', '1');
  return env;
}

/** Variables kopt processes started by Kiro need (MCP servers may only receive the entry's `env`). */
export function koptProcessEnv(s: EnvSpec): Record<string, string> {
  return {
    KOPT_HOME: s.koptHome,
    KOPT_CACHE_DIR: s.cacheDir,
    KOPT_DATA_DIR: s.dataDir,
    KOPT_TELEMETRY: '1',
    KOPT_KIRO_HOME: s.kiroHome,
    KOPT_KIRO_USER_SETTINGS: s.ideSettings,
    KOPT_LEGACY_WORKSPACE_HOOKS: '0',
  };
}

// ---------------------------------------------------------------------------------------------------------
// kopt-free verification of the control arm

function walkFiles(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 6 || !existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (name === 'sessions' || name === 'logs' || name === 'cache') continue;
      walkFiles(p, out, depth + 1);
    } else if (st.isFile() && st.size < 2 * 1024 * 1024) out.push(p);
  }
  return out;
}

function mentionsKopt(path: string): boolean {
  if (/kopt/i.test(path.split(/[\\/]/).pop() ?? '')) return true;
  try {
    return /\bkopt\b|kopt_(find|read|outline|refs|expand|run)|@kopt/i.test(readFileSync(path, 'utf8'));
  } catch {
    return false;
  }
}

/** Kiro configuration the control arm could see that mentions kopt (empty = kopt-free). */
export function koptTracesForControl(o: { wt: string; kiroHome: string; cacheDir: string; engine: Engine; userHome: string }): string[] {
  const out: string[] = [];
  for (const f of walkFiles(join(o.wt, '.kiro'))) if (mentionsKopt(f)) out.push(`${f} (workspace Kiro config mentions kopt)`);
  const ki = join(o.wt, '.kiroignore');
  if (existsSync(ki) && /kopt/i.test(readFileSync(ki, 'utf8'))) out.push(`${ki} (kopt .kiroignore block)`);
  for (const f of walkFiles(o.kiroHome)) if (mentionsKopt(f)) out.push(`${f} (arm KIRO_HOME mentions kopt)`);
  if (existsSync(join(o.cacheDir, repoCacheKey(o.wt)))) out.push(`${join(o.cacheDir, repoCacheKey(o.wt))} (a kopt index of the control worktree)`);
  if (o.engine === 'v3') {
    for (const f of userKiroConfigFiles(o.userHome)) {
      if (mentionsKopt(f)) out.push(`${f} (the V3 engine reads ~/.kiro whatever KIRO_HOME says: run \`kopt uninstall --user\`, or use --engine v2)`);
    }
  }
  return out;
}

/**
 * The user's own ~/.kiro files the V3 engine loads in every workspace (hooks, steering, agents, skills, MCP servers,
 * settings, permission rules). `subs` limits the directories walked (V2 checks: steering only).
 */
export function userKiroConfigFiles(userHome: string, subs: readonly string[] = ['hooks', 'steering', 'agents', 'skills']): string[] {
  const kh = join(userHome, '.kiro');
  const out: string[] = [];
  for (const sub of subs) {
    const d = join(kh, sub);
    if (!existsSync(d)) continue;
    for (const f of walkFiles(d)) out.push(f);
  }
  if (subs.length < 4) return out;
  for (const f of ['mcp.json', 'cli.json', 'kiroignore', 'permissions.yaml']) if (existsSync(join(kh, 'settings', f))) out.push(join(kh, 'settings', f));
  for (const f of workspacePermissionFiles(kh)) out.push(f);
  return out;
}

/** ~/.kiro/workspace-roots/<hash>/permissions.yaml (per-workspace permission rules kept outside the repository). */
function workspacePermissionFiles(kiroDir: string): string[] {
  const d = join(kiroDir, 'workspace-roots');
  if (!existsSync(d)) return [];
  const out: string[] = [];
  for (const n of readdirSync(d)) {
    const f = join(d, n, 'permissions.yaml');
    if (existsSync(f)) out.push(f);
  }
  return out;
}

/** Names only (never values) of what the user's ~/.kiro adds to BOTH arms on V3. */
export function userKiroInventory(userHome: string): string[] {
  const kh = join(userHome, '.kiro');
  const out: string[] = [];
  const names = (sub: string) => (existsSync(join(kh, sub)) ? readdirSync(join(kh, sub)).filter((n) => !n.startsWith('.')) : []);
  const hooks = names('hooks');
  const steering = names('steering');
  const agents = names('agents');
  const skills = names('skills');
  if (hooks.length) out.push(`hooks: ${hooks.join(', ')}`);
  if (steering.length) out.push(`steering: ${steering.join(', ')}`);
  if (agents.length) out.push(`agents: ${agents.join(', ')}`);
  if (skills.length) out.push(`skills: ${skills.join(', ')}`);
  const mcp = readJson<{ mcpServers?: Record<string, unknown> }>(join(kh, 'settings', 'mcp.json'));
  const servers = Object.keys(mcp?.mcpServers ?? {});
  if (servers.length) out.push(`MCP servers: ${servers.join(', ')}`);
  if (existsSync(join(kh, 'settings', 'permissions.yaml'))) out.push('permission rules: settings/permissions.yaml');
  const ws = workspacePermissionFiles(kh);
  if (ws.length) out.push(`per-workspace permission rules: ${ws.length} workspace-roots/*/permissions.yaml (they only apply to their own workspace)`);
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Session files of one run

function newerThan(p: string, t: number): boolean {
  try {
    return statSync(p).mtimeMs >= t - 2000;
  } catch {
    return false;
  }
}

function copyTree(src: string, dst: string): void {
  const st = statSync(src);
  if (st.isDirectory()) {
    mkdirSync(dst, { recursive: true });
    for (const n of readdirSync(src)) copyTree(join(src, n), join(dst, n));
  } else if (st.isFile()) {
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  }
}

interface SessionLocation {
  /** V2 sidecar directory (<KIRO_HOME>/sessions/cli) */
  v2dir: string;
  /** V3 bucket directories, with whether their session dirs are moved (harness-owned) or copied (user's home) */
  v3: Array<{ dir: string; move: boolean }>;
}

export interface SessionPlaces {
  kiroHome: string;
  /** Home directories the V3 engine may resolve (Windows: %USERPROFILE% and the profile folder can differ). */
  userHomes: string[];
  wt: string;
  wtReal?: string;
}

function sessionLocations(o: SessionPlaces): SessionLocation {
  const buckets = [...bucketCandidates(o.wt, o.wtReal), '_global'];
  const v3: SessionLocation['v3'] = [];
  const roots: Array<[string, boolean]> = [...new Set(o.userHomes)].map((h) => [join(h, '.kiro', 'sessions'), false]);
  roots.push([join(o.kiroHome, 'sessions'), true]);
  for (const [root, move] of roots) {
    for (const b of buckets) v3.push({ dir: join(root, b), move });
  }
  return { v2dir: join(o.kiroHome, 'sessions', 'cli'), v3 };
}

/** V3 session bucket directories under the user's home that belong to a worktree of the harness (for `clean`). */
export function worktreeSessionDirs(o: SessionPlaces): string[] {
  const buckets = bucketCandidates(o.wt, o.wtReal);
  return [...new Set(o.userHomes)].flatMap((h) => buckets.map((b) => join(h, '.kiro', 'sessions', b))).filter((d) => existsSync(d));
}

function entries(dir: string): string[] {
  try {
    return readdirSync(dir).map((n) => join(dir, n));
  } catch {
    return [];
  }
}

/** Session files and directories that exist before a run (they are never attributed to it). */
export function sessionSnapshot(o: SessionPlaces): Set<string> {
  const loc = sessionLocations(o);
  return new Set([...entries(loc.v2dir), ...loc.v3.flatMap((b) => entries(b.dir))]);
}

/**
 * Copy the session files a run wrote into `dest`: entries that did not exist before the run (`before`), or that carry
 * the run's own session id (from the stream). V2: <KIRO_HOME>/sessions/cli/<uuid>.json(l) (moved, so the arm's home
 * stays clean). V3: <home>/.kiro/sessions/<bucket>/<sess_id>/ (the V3 engine uses the OS home, not KIRO_HOME; copied,
 * the user's own directory is left as is), plus the same layout under KIRO_HOME in case a later version honours it.
 */
export function collectSessions(o: SessionPlaces & { startMs: number; sessionId?: string; before: Set<string>; dest: string }): string[] {
  const got: string[] = [];
  mkdirSync(o.dest, { recursive: true });
  const loc = sessionLocations(o);
  const isNew = (p: string) => !o.before.has(p) && newerThan(p, o.startMs);
  for (const p of entries(loc.v2dir)) {
    const n = p.slice(loc.v2dir.length + 1);
    if (!/\.(json|jsonl)$/i.test(n)) continue;
    if (!((o.sessionId && n.startsWith(o.sessionId)) || isNew(p))) continue;
    const d = join(o.dest, 'v2', n);
    mkdirSync(dirname(d), { recursive: true });
    try {
      renameSync(p, d);
    } catch {
      copyFileSync(p, d);
    }
    got.push(d);
  }
  for (const b of loc.v3) {
    for (const p of entries(b.dir)) {
      let isDir = false;
      try {
        isDir = statSync(p).isDirectory();
      } catch {
        continue;
      }
      const n = p.slice(b.dir.length + 1);
      if (!isDir || !n.startsWith('sess_')) continue;
      if (!((o.sessionId && n === o.sessionId) || isNew(p))) continue;
      const d = join(o.dest, 'v3', n);
      copyTree(p, d);
      if (b.move) rmSync(p, { recursive: true, force: true });
      got.push(d);
    }
  }
  return got;
}

export function listFilesRel(dir: string): string[] {
  return walkFiles(dir).map((f) => relative(dir, f));
}
