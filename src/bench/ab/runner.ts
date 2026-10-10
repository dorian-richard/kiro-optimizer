// `kopt bench ab`: the online A/B campaign. Sequence: harness setup -> arm preparation (worktrees, KIRO_HOMEs, kopt
// install + prebuilt index) -> preflight (kiro-cli, login, agents, kopt checks; no credit spent) -> smoke run (one
// tiny prompt per arm with exactly one tool call, must yield credits everywhere and prove the tools are trusted) ->
// planned runs under the --max-credits budget -> report.
// Every run is a fresh `kiro-cli chat --no-interactive` process; results are written per run, so an interrupted
// campaign resumes where it stopped (--resume).

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { cacheRoot, repoCacheKey } from '../../core/config.js';
import { languageForPath } from '../../indexer/languages.js';
import { binPath, nodeVersionOk } from '../../kiro/command.js';
import { runHookCommand } from '../../kiro/doctor.js';
import { Store } from '../../store/store.js';
import { billed, budgetTotals, estimateFor, readArchived, typicalWallMs, type ArchivedAttempt } from './budget.js';
import { cheapestModel, kiroCall, parseModelList, parseVersion, parseWhoami, resolveKiroCli, stripAnsi, validateOutputProblems, versionAtLeast, type KiroCli, type ModelInfo } from './kiro.js';
import { isKoptCall, LiveMeter, parseStream } from './parse.js';
import { makePlan } from './plan.js';
import { activeChild, isCmdShim, killPidTree, killTree, processAlive, processCommand, runProcess, type Launcher } from './proc.js';
import { answerText, buildRecord, isFatal, type ExitInfo, type StartedMeta } from './record.js';
import { writeReport } from './report.js';
import { buildPrompt, DEFAULT_PROMPT_SUFFIX, loadAbTasks, smokePrompt } from './tasks.js';
import { ACCOUNT_BLOCKED_ADVICE, KOPT_ARMS, RETRY_ON_RESUME, type AbTask, type AbTaskFile, type Arm, type Engine, type PlanItem, type RunRecord } from './types.js';
import {
  agentConfig,
  agentName,
  armEnv,
  collectSessions,
  ensureWorktree,
  git,
  guardHead,
  hookPrefix,
  koptAgentHooks,
  koptProcessEnv,
  koptTracesForControl,
  loadBaseline,
  readJson,
  removeWorktree,
  repoInfo,
  restoreBaseline,
  sessionSnapshot,
  setEnv,
  snapshotBaseline,
  stripRepoMcpServers,
  trustList,
  userKiroConfigFiles,
  userKiroInventory,
  worktreeSessionDirs,
  writeJson,
  type EnvSpec,
  type RepoInfo,
  type SessionPlaces,
  type ToolTag,
} from './workspace.js';

export const DEFAULT_MODEL = 'claude-sonnet-4.5';
export const MIN_KIRO_VERSION: [number, number, number] = [2, 28, 0];

/** Smoke runs are budgeted at this many credits each (at most): one tool call and a one-word answer on the cheapest model. */
export const SMOKE_ESTIMATE = 0.5;

export interface AbOptions {
  repo: string;
  tasksFile?: string;
  out?: string;
  arms: Arm[];
  reps: number;
  model: string;
  smokeModel?: string;
  effort?: string;
  engine: Engine;
  maxCredits?: number;
  /** Kill a single run whose metered credits would reach this (optional). */
  maxRunCredits?: number;
  creditsPerRun: number;
  timeoutS: number;
  seed: number;
  resume: boolean;
  /**
   * Smoke run before the campaign (or with --check): one tiny prompt per arm. Opt-in (--smoke): every headless request
   * counts against the account, and the first real run of each arm already stops the campaign on the same errors.
   */
  smoke: boolean;
  tools: ToolTag[];
  passRatio?: number;
  promptSuffix: string;
  kiroCli?: string;
  node?: string;
  maxConsecutiveFailures: number;
  settings: Record<string, unknown>;
  only?: string[];
  /**
   * Read the account's model list (`kiro-cli chat --list-models`, a request to Kiro) in the preflight. Opt-in
   * (--list-models): the preflight otherwise makes no network call of its own beyond what `whoami` does.
   */
  listModels: boolean;
  /** The user confirms Kiro support restored an account that a run of this campaign found blocked. */
  accountRestored?: boolean;
  indexTimeoutS: number;
  env?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
}

export function defaultOptions(over: Partial<AbOptions> & { repo: string }): AbOptions {
  return {
    arms: ['A', 'B'],
    reps: 2,
    model: DEFAULT_MODEL,
    engine: 'v2',
    creditsPerRun: 2,
    timeoutS: 600,
    seed: 42,
    resume: false,
    smoke: false,
    tools: ['read'],
    promptSuffix: DEFAULT_PROMPT_SUFFIX,
    maxConsecutiveFailures: 3,
    settings: {},
    listModels: false,
    indexTimeoutS: 1800,
    ...over,
  };
}

export interface ArmCtx {
  arm: Arm;
  dir: string;
  wt: string;
  wtReal: string;
  kiroHome: string;
  /** kopt data dir (index) of this arm's worktree, under the harness's kopt cache. */
  dataDir: string;
  agentName: string;
  agentPath: string;
  trust: string;
  requireMcp: boolean;
  kopt: boolean;
  store: string;
  ideSettings: string;
  /** Harness-managed files rewritten before each run (not counted as run changes). */
  managed: string[];
  /** MCP servers of the repository's own .kiro/settings/mcp.json removed from this arm's worktree. */
  removedMcpServers: string[];
  /** Size of the kopt index of a kopt arm. */
  index?: { files: number; symbols: number; ms?: number };
}

export interface Harness {
  o: AbOptions;
  env: NodeJS.ProcessEnv;
  log: (msg: string) => void;
  out: string;
  repo: RepoInfo;
  tasks?: AbTaskFile & { sha256: string };
  taskById: Map<string, AbTask>;
  passRatio: number;
  node: { path: string; version: string };
  koptBin: string;
  kiro?: KiroCli;
  kiroVersion?: string;
  /** The home directory kiro-cli resolves (messages, the V3 checks). */
  userHome: string;
  /** Every spelling of it the V3 engine may use (Windows: %USERPROFILE% and the profile folder). */
  userHomes: string[];
  cacheDir: string;
  arms: Map<Arm, ArmCtx>;
  /** Small indexed file the smoke prompts use. */
  smokeFile?: string;
}

export interface Check {
  id: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
  fix?: string;
}

export class AbError extends Error {}

// ---------------------------------------------------------------------------------------------------------
// setup

function nodeVersionOf(path: string): string | undefined {
  if (path === process.execPath) return process.version;
  try {
    return execFileSync(path, ['-p', 'process.version'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
  } catch {
    return undefined;
  }
}

function realOr(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

export function isInsidePath(child: string, parent: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const rel = relative(norm(realOr(parent)), norm(realOr(child)));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function defaultOutDir(repoRoot: string): string {
  return join(dirname(repoRoot), `${basename(repoRoot)}-kopt-ab`);
}

/**
 * Home directories kiro-cli may resolve. POSIX: $HOME. Windows: %USERPROFILE% (what Node reports) and the profile
 * folder of the account (what a Rust `home_dir` may report); they differ when USERPROFILE was changed.
 */
export function userHomesOf(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'win32') return [env.HOME || homedir()];
  let profile: string | undefined;
  try {
    profile = userInfo().homedir;
  } catch {
    profile = undefined;
  }
  const homes = [env.USERPROFILE, profile, homedir()].filter((x): x is string => !!x);
  return [...new Set(homes.map((h) => resolve(h)))];
}

export function setupHarness(o: AbOptions): Harness {
  const env = o.env ?? process.env;
  const log = o.log ?? ((m: string) => process.stderr.write(`kopt bench ab: ${m}\n`));
  if (!existsSync(o.repo)) throw new AbError(`--repo ${o.repo} does not exist`);
  let repo: RepoInfo;
  try {
    repo = repoInfo(resolve(o.repo));
  } catch (err) {
    throw new AbError(`--repo ${o.repo} is not a git repository with at least one commit (${(err as Error).message})`);
  }
  const out = resolve(o.out ?? defaultOutDir(repo.root));
  if (isInsidePath(out, repo.root)) throw new AbError(`--out ${out} is inside the repository: choose a directory outside ${repo.root}`);
  const nodePath = o.node ? resolve(o.node) : process.execPath;
  const nodeVersion = nodeVersionOf(nodePath);
  if (!nodeVersion || !nodeVersionOk(nodeVersion)) {
    throw new AbError(`kopt needs Node.js >= 22.13; ${nodePath} is ${nodeVersion ?? 'not runnable'} (pass --node <absolute path of a Node >= 22.13>)`);
  }
  const koptBin = binPath();
  let tasks: (AbTaskFile & { sha256: string }) | undefined;
  if (o.tasksFile) tasks = loadAbTasks(resolve(o.tasksFile));
  if (tasks && o.only?.length) {
    const unknown = o.only.filter((id) => !tasks!.tasks.some((t) => t.id === id));
    if (unknown.length) throw new AbError(`--only: unknown task id(s) ${unknown.join(', ')}`);
  }
  const userHomes = userHomesOf(env);
  return {
    o,
    env,
    log,
    out,
    repo,
    tasks,
    taskById: new Map((tasks?.tasks ?? []).map((t) => [t.id, t])),
    passRatio: o.passRatio ?? tasks?.passRatio ?? 0.6,
    node: { path: nodePath, version: nodeVersion },
    koptBin,
    kiro: resolveKiroCli(env, nodePath, o.kiroCli),
    userHome: userHomes[0],
    userHomes,
    cacheDir: join(out, 'kopt-cache'),
    arms: new Map(),
  };
}

// ---------------------------------------------------------------------------------------------------------
// lock: one harness process per output directory

const LOCK_FILE = 'lock.json';

interface LockInfo {
  pid: number;
  host: string;
  what: string;
  at: string;
}

/**
 * Take `<out>/lock.json` for this process. A live holder on this machine is refused (two harness processes would
 * re-prepare, restore and run in the same worktrees); a holder that is gone is replaced. Returns the release function.
 */
export function acquireLock(out: string, what: string): () => void {
  mkdirSync(out, { recursive: true });
  const p = join(out, LOCK_FILE);
  const mine: LockInfo = { pid: process.pid, host: hostname(), what, at: new Date().toISOString() };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(p, JSON.stringify(mine) + '\n', { flag: 'wx' });
      return () => {
        if (readJson<LockInfo>(p)?.pid === process.pid) rmSync(p, { force: true });
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const cur = readJson<LockInfo>(p);
      if (cur && cur.host === mine.host && cur.pid !== process.pid && processAlive(cur.pid)) {
        throw new AbError(`${out} is in use by another kopt bench ab (${cur.what}, pid ${cur.pid}, since ${cur.at}): wait for it to finish, or stop it first`);
      }
      if (cur && cur.host !== mine.host) {
        throw new AbError(`${out} is locked by a kopt bench ab on host ${cur.host} (pid ${cur.pid}, ${cur.what}): delete ${p} if that process is gone`);
      }
      rmSync(p, { force: true }); // stale: the holder is gone
    }
  }
  throw new AbError(`cannot lock ${out}`);
}

// ---------------------------------------------------------------------------------------------------------
// arms

function envSpec(h: Harness, ctx: ArmCtx, koptHome: string): EnvSpec {
  return { kiroHome: ctx.kiroHome, koptHome, cacheDir: h.cacheDir, dataDir: ctx.dataDir, nodePath: h.node.path, ideSettings: ctx.ideSettings };
}

function places(h: Harness, ctx: ArmCtx): SessionPlaces {
  return { kiroHome: ctx.kiroHome, userHomes: h.userHomes, wt: ctx.wt, wtReal: ctx.wtReal };
}

function koptLauncher(h: Harness): Launcher {
  return { command: h.node.path, prefix: [h.koptBin], display: `${h.node.path} ${h.koptBin}` };
}

async function koptCmd(h: Harness, ctx: ArmCtx, args: string[], timeoutMs: number, extraEnv: Record<string, string> = {}): Promise<string> {
  const env = armEnv(h.env, envSpec(h, ctx, join(ctx.dir, 'kopt-setup-home')));
  for (const [k, v] of Object.entries(extraEnv)) setEnv(env, k, v);
  const r = await runProcess(koptLauncher(h), args, { cwd: ctx.wt, env, timeoutMs });
  if (r.code !== 0) {
    throw new AbError(`kopt ${args.join(' ')} failed for arm ${ctx.arm} (exit ${r.code ?? r.spawnError ?? (r.timedOut ? 'timeout' : '?')}): ${(r.stderr || r.stdout).trim().split('\n').slice(-4).join(' | ')}`);
  }
  return r.stdout;
}

export function armCtx(h: Harness, arm: Arm): ArmCtx {
  const dir = join(h.out, 'arms', arm);
  const wt = join(dir, 'repo');
  const kopt = KOPT_ARMS.has(arm);
  const name = agentName(arm);
  return {
    arm,
    dir,
    wt,
    wtReal: realOr(wt),
    kiroHome: join(dir, 'kiro-home'),
    dataDir: join(h.cacheDir, repoCacheKey(wt)),
    agentName: name,
    agentPath: join(wt, '.kiro', 'agents', `${name}.json`),
    trust: trustList(h.o.engine, h.o.tools, kopt),
    requireMcp: kopt,
    kopt,
    store: join(dir, 'baseline'),
    ideSettings: join(dir, 'kiro-ide-settings.json'),
    managed: arm === 'B' ? ['.kiro/settings/mcp.json'] : arm === 'C' ? [`.kiro/agents/${name}.json`] : [],
    removedMcpServers: [],
  };
}

function writeAgent(h: Harness, ctx: ArmCtx, koptHome: string): void {
  const spec = envSpec(h, ctx, koptHome);
  const cfg = agentConfig({
    arm: ctx.arm,
    engine: h.o.engine,
    tags: h.o.tools,
    kopt: ctx.kopt,
    includeMcpJson: ctx.arm === 'B',
    // V2 runs only the hooks embedded in the selected agent; V3 loads the workspace .kiro/hooks written by kopt init
    hooks: ctx.arm === 'B' && h.o.engine === 'v2' ? koptAgentHooks(h.node.path, h.koptBin, h.env) : undefined,
    mcpServers: ctx.arm === 'C' ? { kopt: { command: h.node.path, args: [h.koptBin, 'mcp', '--root', ctx.wt], env: koptProcessEnv(spec) } } : undefined,
  });
  writeJson(ctx.agentPath, cfg);
}

/** Point arm B's kopt MCP entry at `koptHome` (MCP servers may only receive the entry's env, not Kiro's). */
function setKoptMcpEnv(h: Harness, ctx: ArmCtx, koptHome: string): void {
  const p = join(ctx.wt, '.kiro', 'settings', 'mcp.json');
  const cfg = readJson<{ mcpServers?: Record<string, { env?: Record<string, string> }> }>(p);
  if (!cfg?.mcpServers?.kopt) throw new AbError(`${p} has no kopt server: re-run without --resume, or delete ${ctx.dir}`);
  cfg.mcpServers.kopt.env = { ...(cfg.mcpServers.kopt.env ?? {}), ...koptProcessEnv(envSpec(h, ctx, koptHome)) };
  writeJson(p, cfg);
}

/** Point the kopt MCP server of a kopt arm at this run's KOPT_HOME. */
function configureRun(h: Harness, ctx: ArmCtx, koptHome: string): void {
  if (ctx.arm === 'B') setKoptMcpEnv(h, ctx, koptHome);
  else if (ctx.arm === 'C') writeAgent(h, ctx, koptHome);
}

function prepFingerprint(h: Harness, arm: Arm): string {
  return JSON.stringify({ v: 2, arm, engine: h.o.engine, tools: h.o.tools, head: h.repo.head, node: h.node.path, bin: h.koptBin, settings: h.o.settings });
}

/** Settings written to every arm's cli.json: the user's --setting values, and no self-update during the campaign. */
function armSettings(h: Harness): Record<string, unknown> {
  return { 'app.disableAutoupdates': true, ...h.o.settings };
}

/** Windows: kopt init writes hooks with a bare `node`; use the absolute Node when it needs no quoting (V3 hooks file). */
function fixWindowsHookFile(h: Harness, file: string): void {
  if (process.platform !== 'win32') return;
  const prefix = hookPrefix(h.node.path, h.koptBin, h.env);
  if (prefix.startsWith('node ')) return;
  const doc = readJson<{ hooks?: Array<{ action?: { command?: string } }> }>(file);
  if (!doc?.hooks) return;
  for (const hk of doc.hooks) {
    const c = hk.action?.command;
    if (c && /^node\s+("[^"]*"|\S+)/.test(c)) hk.action!.command = c.replace(/^node\s+("[^"]*"|\S+)/, prefix);
  }
  writeJson(file, doc);
}

/** Files and symbols of a kopt index (read-only). */
function indexStats(dataDir: string): { files: number; symbols: number } | undefined {
  const p = join(dataDir, 'index.db');
  if (!existsSync(p)) return undefined;
  let s: Store | undefined;
  try {
    s = Store.open(p, { readonly: true });
    const c = s.counts();
    return { files: c.files, symbols: c.symbols };
  } catch {
    return undefined;
  } finally {
    s?.close();
  }
}

/** Worktree + KIRO_HOME + kopt install of one arm. Idempotent: a prepared arm with the same fingerprint is reused. */
export async function prepareArm(h: Harness, arm: Arm): Promise<ArmCtx> {
  const ctx = armCtx(h, arm);
  h.arms.set(arm, ctx);
  mkdirSync(ctx.dir, { recursive: true });
  ensureWorktree(h.repo.root, ctx.wt, h.repo.head, h.log);
  ctx.wtReal = realOr(ctx.wt);
  ctx.dataDir = join(h.cacheDir, repoCacheKey(ctx.wt));
  const fp = prepFingerprint(h, arm);
  const prepared = readJson<{ fingerprint: string; removedMcpServers?: string[]; index?: ArmCtx['index'] }>(join(ctx.dir, 'prepared.json'));
  const baseline = loadBaseline(ctx.store);
  if (prepared?.fingerprint === fp && baseline) {
    restoreBaseline(ctx.wt, ctx.store, baseline);
    ctx.removedMcpServers = prepared.removedMcpServers ?? [];
    ctx.index = prepared.index;
    return ctx;
  }
  h.log(`arm ${arm}: preparing ${ctx.wt}`);
  rmSync(join(ctx.dir, 'prepared.json'), { force: true });
  git(['checkout', '-q', '--force', 'HEAD', '--', '.'], ctx.wt);
  git(['clean', '-q', '-f', '-d'], ctx.wt);
  rmSync(ctx.kiroHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  writeJson(join(ctx.kiroHome, 'settings', 'cli.json'), armSettings(h));
  if (arm === 'B') {
    await koptCmd(h, ctx, ['init', '--root', ctx.wt, '--force'], 120_000, { KOPT_HOOK_COMMAND: 'node', KOPT_CLI: h.koptBin });
    if (h.o.engine === 'v3') fixWindowsHookFile(h, join(ctx.wt, '.kiro', 'hooks', 'kopt.json'));
  }
  // MCP servers committed in the repository load in no arm (arm B keeps kopt only)
  ctx.removedMcpServers = stripRepoMcpServers(ctx.wt, arm === 'B' ? 'kopt' : undefined);
  // arm B's kopt entry carries the kopt environment from the start: an MCP server started before the first run
  // (the preflight's tool listing, `kiro-cli mcp list`) must never index into the user's own cache
  if (arm === 'B') setKoptMcpEnv(h, ctx, join(ctx.dir, 'kopt-setup-home'));
  if (ctx.kopt) {
    const t0 = Date.now();
    h.log(`arm ${arm}: building the kopt index (once; not charged to the runs)`);
    await koptCmd(h, ctx, ['index', '--root', ctx.wt], h.o.indexTimeoutS * 1000);
    const st = indexStats(ctx.dataDir);
    ctx.index = { files: st?.files ?? 0, symbols: st?.symbols ?? 0, ms: Date.now() - t0 };
  }
  writeAgent(h, ctx, join(ctx.dir, 'kopt-setup-home'));
  snapshotBaseline(ctx.wt, ctx.store);
  writeJson(join(ctx.dir, 'prepared.json'), { fingerprint: fp, at: new Date().toISOString(), index: ctx.index, removedMcpServers: ctx.removedMcpServers });
  return ctx;
}

// ---------------------------------------------------------------------------------------------------------
// preflight

async function mcpListsTools(h: Harness, ctx: ArmCtx, entry: { command: string; args?: string[]; env?: Record<string, string> }, timeoutMs = 30_000): Promise<{ tools?: string[]; error?: string }> {
  const [{ Client }, { StdioClientTransport, DEFAULT_INHERITED_ENV_VARS }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
  ]);
  const checkHome = join(ctx.dir, 'check-home');
  const base = armEnv(h.env, envSpec(h, ctx, checkHome));
  const inherited: Record<string, string> = {};
  for (const k of DEFAULT_INHERITED_ENV_VARS) {
    const v = base[k];
    if (v !== undefined && !v.startsWith('()')) inherited[k] = v;
  }
  // the arm's kopt variables always win: without KOPT_CACHE_DIR / KOPT_DATA_DIR the server would build an index in
  // the user's own cache
  const env = { ...inherited, ...(entry.env ?? {}), ...koptProcessEnv(envSpec(h, ctx, checkHome)) };
  const transport = new StdioClientTransport({ command: entry.command, args: entry.args ?? [], env, cwd: ctx.wt, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', (c) => (stderr += String(c)));
  const client = new Client({ name: 'kopt-bench-ab', version: '0' });
  let timer: NodeJS.Timeout | undefined;
  try {
    const run = (async () => {
      await client.connect(transport);
      return client.listTools();
    })();
    const timeout = new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs)));
    const { tools } = await Promise.race([run, timeout]);
    return { tools: tools.map((t) => t.name) };
  } catch (err) {
    return { error: `${(err as Error).message}${stderr.trim() ? ` (${stderr.trim().split('\n').slice(-2).join(' | ')})` : ''}` };
  } finally {
    if (timer) clearTimeout(timer);
    await client.close().catch(() => {});
  }
}

function koptHookCommand(h: Harness, ctx: ArmCtx): string | undefined {
  if (h.o.engine === 'v2') {
    const a = readJson<{ hooks?: Record<string, Array<{ command?: string }>> }>(ctx.agentPath);
    return a?.hooks?.preToolUse?.[0]?.command;
  }
  const f = readJson<{ hooks?: Array<{ trigger?: string; action?: { command?: string } }> }>(join(ctx.wt, '.kiro', 'hooks', 'kopt.json'));
  return f?.hooks?.find((x) => x.trigger === 'PreToolUse')?.action?.command;
}

/** Agents listed by `mcp list` with the servers under each (stderr, verified format of 2.28). */
export function parseMcpList(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let cur: string | undefined;
  for (const raw of stripAnsi(text).split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const indent = raw.length - raw.trimStart().length;
    const t = raw.trim();
    if (indent === 2 && !/^[•\-*]/.test(t)) {
      cur = t.split(/\s+/)[0];
      out.set(cur, []);
    } else if (cur && indent >= 4 && /^[•\-*]/.test(t)) {
      out.get(cur)!.push(t.replace(/^[•\-*]\s*/, '').split(/\s+/)[0]);
    } else if (indent === 0) cur = undefined;
  }
  return out;
}

/** The kiro-cli the harness talks to is the test simulator (bench/ab/fake-kiro-cli.mjs). */
export function isSimulator(k: Launcher | undefined): boolean {
  return !!k && [k.command, ...k.prefix, k.display].some((p) => /fake-kiro-cli\.(mjs|cmd)$/i.test(p));
}

/** Under the test runner, never send anything to a real (possibly logged-in) kiro-cli. */
function refuseRealKiroUnderTests(h: Harness, what: string): void {
  if (process.env.VITEST && !isSimulator(h.kiro)) {
    throw new AbError(`refusing to ${what} with a real kiro-cli under the test runner (VITEST is set): point KIRO_CLI at bench/ab/fake-kiro-cli.mjs`);
  }
}

/** Small file the smoke prompts use: from the kopt index (a file kopt can outline), else a small tracked text file. */
function pickSmokeFile(h: Harness): string | undefined {
  for (const ctx of h.arms.values()) {
    if (!ctx.kopt) continue;
    const p = join(ctx.dataDir, 'index.db');
    if (!existsSync(p)) continue;
    let s: Store | undefined;
    try {
      s = Store.open(p, { readonly: true });
      const pick = (min: number, max: number) =>
        (s!.prepare('SELECT f.path AS path FROM files f WHERE f.lang IS NOT NULL AND f.size BETWEEN ? AND ? AND EXISTS (SELECT 1 FROM symbols y WHERE y.file_id = f.id) ORDER BY f.size ASC, f.path ASC LIMIT 1').get(min, max) as { path?: string } | undefined)?.path;
      const f = pick(200, 8000) ?? pick(1, 64_000);
      if (f) return f;
    } catch {
      // fall through
    } finally {
      s?.close();
    }
  }
  try {
    const files = git(['ls-files', '-z'], h.repo.root).split('\0').filter(Boolean);
    const sized = files
      .filter((f) => languageForPath(f) !== undefined)
      .map((f) => {
        try {
          return { f, size: readFileSync(join(h.repo.root, f)).length };
        } catch {
          return { f, size: -1 };
        }
      })
      .filter((x) => x.size > 0 && x.size <= 64_000)
      .sort((a, b) => a.size - b.size || a.f.localeCompare(b.f));
    return (sized.find((x) => x.size >= 200) ?? sized[0])?.f;
  } catch {
    return undefined;
  }
}

/** Gold files missing at HEAD and gold symbols that appear nowhere in the code (whole word), per task. */
export function checkGold(repoRoot: string, tasks: readonly AbTask[]): string[] {
  const problems: string[] = [];
  let files: Set<string>;
  try {
    files = new Set(git(['ls-files', '-z'], repoRoot).split('\0').filter(Boolean));
  } catch {
    return problems;
  }
  for (const t of tasks) {
    if (!t.gold) continue;
    const missing = t.gold.files.filter((f) => !files.has(f));
    const unknown = t.gold.symbols.filter((sym) => {
      try {
        git(['grep', '-q', '-w', '-F', '-e', sym, 'HEAD', '--'], repoRoot);
        return false;
      } catch {
        return true;
      }
    });
    if (missing.length) problems.push(`task ${t.id}: file(s) not in the repository: ${missing.join(', ')}`);
    if (unknown.length) problems.push(`task ${t.id}: symbol(s) found nowhere in the code: ${unknown.join(', ')}`);
  }
  return problems;
}

/** `kopt.config.json` committed at the repository root: what it changes in the kopt arms. */
function committedKoptConfig(wt: string): string | undefined {
  const p = join(wt, 'kopt.config.json');
  if (!existsSync(p)) return undefined;
  const cfg = readJson<Record<string, unknown>>(p);
  if (!cfg) return `${p} is not valid JSON (kopt ignores it)`;
  const keys = Object.keys(cfg);
  const overridden = keys.filter((k) => ['dataDir', 'userDir'].includes(k) || (k === 'telemetry' && (cfg.telemetry as { enabled?: unknown })?.enabled === false));
  return (
    `the repository commits kopt.config.json (${keys.join(', ') || 'empty'}): it applies to the kopt arms as part of the treatment` +
    (overridden.length ? `; ${overridden.join(', ')} ${overridden.length > 1 ? 'are' : 'is'} overridden by the harness (index location, telemetry: the measurement needs them)` : '')
  );
}

export interface PreflightResult {
  checks: Check[];
  ok: boolean;
  models?: ModelInfo[];
  smokeModel: string;
  estimate: { runs: number; smokeRuns: number; credits: number };
}

export async function preflight(h: Harness, o: { forRun: boolean }): Promise<PreflightResult> {
  const checks: Check[] = [];
  const add = (c: Check) => {
    checks.push(c);
    const tag = c.status === 'ok' ? 'ok  ' : c.status === 'warn' ? 'WARN' : 'FAIL';
    h.log(`${tag} ${c.message}${c.fix ? `\n       fix: ${c.fix}` : ''}`);
  };
  add({ id: 'node', status: 'ok', message: `Node for kopt: ${h.node.path} (${h.node.version})` });
  add({ id: 'kopt', status: existsSync(h.koptBin) ? 'ok' : 'fail', message: `kopt: ${h.koptBin}`, fix: existsSync(h.koptBin) ? undefined : 'run npm run build (or reinstall kiro-optimizer)' });
  add({
    id: 'repo',
    status: h.repo.dirty.length ? 'warn' : 'ok',
    message: `repo ${h.repo.root} at ${h.repo.head.slice(0, 12)}${h.repo.dirty.length ? `: ${h.repo.dirty.length} uncommitted change(s) are NOT part of the A/B (each arm is a worktree of HEAD)` : ', clean'}`,
  });
  add({ id: 'out', status: 'ok', message: `output: ${h.out}` });
  if (h.tasks) {
    const shown = h.o.only?.length ? h.tasks.tasks.filter((t) => h.o.only!.includes(t.id)) : h.tasks.tasks;
    const graded = shown.filter((t) => t.gold).length;
    const enough = shown.length >= 5;
    add({
      id: 'tasks',
      status: shown.length < 3 ? 'warn' : 'ok',
      message:
        `tasks: ${shown.length} (${graded} graded automatically from gold, ${shown.length - graded} for manual grading)` +
        (enough ? '' : `; a conclusive verdict needs 5 tasks and 10 pairs, or a sign test below 0.05 over at least 3 tasks`),
    });
    const goldProblems = checkGold(h.repo.root, shown);
    add({
      id: 'tasks-gold',
      status: goldProblems.length ? 'warn' : 'ok',
      message: goldProblems.length
        ? `gold that does not match HEAD (the automatic grade would fail every arm on it): ${goldProblems.join('; ')}`
        : graded
          ? `the gold files of the ${graded} graded task(s) exist at HEAD and their symbols appear in the code`
          : 'no task has a gold',
    });
    if (graded < shown.length) {
      add({
        id: 'tasks-ungraded',
        status: 'warn',
        message: `task(s) without a gold: ${shown.filter((t) => !t.gold).map((t) => t.id).join(', ')}: they stay out of the main view of the report until you grade their runs (manual_grade column of runs.csv)`,
      });
    }
  } else if (o.forRun) add({ id: 'tasks', status: 'fail', message: 'no --tasks file', fix: `pass --tasks <file.json|yaml> (template: ${join(dirname(dirname(h.koptBin)), 'bench', 'ab', 'tasks.example.json')})` });
  if (h.o.tools.some((t) => t !== 'read')) {
    add({
      id: 'tools-risk',
      status: 'warn',
      message:
        `--tools ${h.o.tools.join(',')}: every arm trusts ${h.o.tools.filter((t) => t !== 'read').map((t) => (t === 'write' ? 'fs_write' : 'execute_bash')).join(' and ')} without asking, with YOUR home directory and credentials ` +
        '(HOME is not replaced: the login lives there). A shell tool can also commit, switch branches or stash in the shared repository; the harness resets the worktree HEAD after every run',
    });
  }
  if (process.platform === 'win32' && h.userHomes.length > 1) {
    add({ id: 'home', status: 'warn', message: `%USERPROFILE% and the account's profile folder differ (${h.userHomes.join(' vs ')}): V3 session files and ~/.kiro are looked up under both` });
  }

  // kiro-cli
  if (!h.kiro) {
    add({ id: 'kiro-cli', status: 'fail', message: 'kiro-cli not found', fix: 'install Kiro CLI (https://kiro.dev/docs/cli), or set KIRO_CLI to its path' });
  } else {
    const v = await kiroCall(h.kiro, ['--version'], { cwd: h.repo.root, env: { ...h.env } });
    h.kiroVersion = parseVersion(`${v.stdout} ${v.stderr}`);
    const okVersion = versionAtLeast(h.kiroVersion, MIN_KIRO_VERSION);
    add({
      id: 'kiro-cli',
      status: v.code === 0 && h.kiroVersion ? (okVersion ? 'ok' : 'warn') : 'fail',
      message: `kiro-cli ${h.kiroVersion ?? '(version unknown)'}: ${h.kiro.display} [${h.kiro.source}], engine ${h.o.engine}${okVersion ? '' : ` (the harness was built against 2.28; older versions may not have --output-format stream-json)`}`,
      fix: v.code === 0 ? undefined : `${h.kiro.display} --version failed: ${(v.stderr || v.spawnError || '').trim().slice(0, 200)}`,
    });
    if (process.platform === 'win32' && isCmdShim(h.kiro)) {
      add({ id: 'kiro-cli-shim', status: 'fail', message: `${h.kiro.display} is a .cmd shim: cmd.exe cannot pass a multi-line prompt to it`, fix: 'point --kiro-cli (or KIRO_CLI) at kiro-cli-chat.exe' });
    }
    const autoupdate = armSettings(h)['app.disableAutoupdates'];
    add({
      id: 'autoupdate',
      status: autoupdate === true ? 'ok' : 'warn',
      message: autoupdate === true ? 'kiro-cli self-update is off in every arm (app.disableAutoupdates, KIRO_NO_AUTO_UPDATE); a version change stops the campaign' : '--setting app.disableAutoupdates is not true: kiro-cli may update itself during the campaign (the version is checked before every run)',
    });
  }

  // arms
  for (const arm of h.o.arms) {
    try {
      const ctx = await prepareArm(h, arm);
      add({ id: `arm-${arm}`, status: 'ok', message: `arm ${arm}: worktree ${ctx.wt}, KIRO_HOME ${ctx.kiroHome}` });
      if (ctx.index) {
        add({
          id: `index-${arm}`,
          status: ctx.index.symbols > 0 ? 'ok' : 'fail',
          message: `arm ${arm}: kopt index of ${ctx.index.files} file(s), ${ctx.index.symbols} symbol(s)${ctx.index.ms !== undefined ? ` (built in ${(ctx.index.ms / 1000).toFixed(0)} s)` : ''}, ${ctx.dataDir}`,
          fix: ctx.index.symbols > 0 ? undefined : "kopt found no symbol in this repository: check that kopt supports its languages (`kopt index --root <repo>` prints what it indexed)",
        });
      }
      if (ctx.removedMcpServers.length) {
        add({
          id: `repo-mcp-${arm}`,
          status: 'warn',
          message: `arm ${arm}: the repository's .kiro/settings/mcp.json declares MCP server(s) ${ctx.removedMcpServers.join(', ')}: removed from this arm's worktree (no arm loads them; they could need credentials and fail --require-mcp-startup)`,
        });
      }
      if (ctx.kopt) {
        const note = committedKoptConfig(ctx.wt);
        if (note) add({ id: `kopt-config-${arm}`, status: 'warn', message: `arm ${arm}: ${note}` });
      }
    } catch (err) {
      add({ id: `arm-${arm}`, status: 'fail', message: `arm ${arm}: ${(err as Error).message}` });
    }
  }
  const ctxA = h.arms.get('A');
  if (ctxA) {
    const traces = [...new Set(h.userHomes.flatMap((home) => koptTracesForControl({ wt: ctxA.wt, kiroHome: ctxA.kiroHome, cacheDir: h.cacheDir, engine: h.o.engine, userHome: home })))];
    add({
      id: 'control-kopt-free',
      status: traces.length ? 'fail' : 'ok',
      message: traces.length ? `arm A can see kopt:\n       - ${traces.join('\n       - ')}` : 'arm A is kopt-free (no kopt MCP entry, hook, steering, agent or index visible to it)',
      fix: traces.length ? 'remove these files (the control arm must be stock Kiro)' : undefined,
    });
  }
  if (h.o.engine === 'v3') {
    const inv = [...new Set(h.userHomes.flatMap((home) => userKiroInventory(home)))];
    add({
      id: 'v3-leakage',
      status: inv.length ? 'warn' : 'ok',
      message: inv.length
        ? `V3 reads ${join(h.userHome, '.kiro')} whatever KIRO_HOME says; it adds to BOTH arms: ${inv.join('; ')}`
        : `V3 reads ${join(h.userHome, '.kiro')} whatever KIRO_HOME says: nothing there that would load in the arms`,
      fix: inv.length ? 'acceptable when it is the same for both arms; use --engine v2 for full isolation' : undefined,
    });
  } else {
    // V2 custom agents inherit default resources (steering); whether V2 reads ~/.kiro/steering when KIRO_HOME is set
    // is not verified
    const steering = h.userHomes.flatMap((home) => userKiroConfigFiles(home, ['steering']));
    const kopt = steering.filter((f) => /kopt/i.test(basename(f)) || /\bkopt\b|kopt_(find|read|outline|refs|expand|run)|@kopt/i.test(readFileSafe(f)));
    if (kopt.length) {
      add({
        id: 'v2-global-steering',
        status: 'warn',
        message: `${kopt.join(', ')} mention${kopt.length > 1 ? '' : 's'} kopt: V2 custom agents inherit global steering, and whether V2 still reads ~/.kiro/steering with KIRO_HOME set is not verified; arm A could see it`,
        fix: 'move it away during the campaign (kopt uninstall --user removes kopt\'s user-level files), or check `/context show` in a kiro-cli chat with KIRO_HOME set',
      });
    } else if (steering.length) {
      add({ id: 'v2-global-steering', status: 'ok', message: `global steering in ~/.kiro/steering (${steering.length} file(s), no kopt) may load in every arm alike` });
    }
  }

  // kiro-cli checks, in the exact run environment. The login is read once (`whoami` in the first arm's environment:
  // KIRO_HOME does not move it, and every run reads it again in its own environment before its chat call). Without a
  // login no other kiro-cli command runs, so nothing in the preflight can start a browser login. `agent validate` and
  // `mcp list` are local (verified with 2.28, network blocked); no `chat` command runs unless --list-models asks.
  let loggedIn = false;
  const armList = [...h.arms.values()];
  if (h.kiro && armList.length) {
    const first = armList[0];
    const who = parseWhoami(await kiroCall(h.kiro, ['whoami'], { cwd: first.wt, env: armEnv(h.env, envSpec(h, first, join(first.dir, 'check-home'))) }));
    loggedIn = who.loggedIn;
    add({
      id: 'login',
      status: who.loggedIn ? 'ok' : 'fail',
      message: who.loggedIn ? `kiro-cli is logged in (${who.method ?? 'credentials found'}) in the run environment of arm ${first.arm}` : `kiro-cli is NOT logged in in the run environment of arm ${first.arm}: ${who.output}`,
      fix: who.loggedIn
        ? undefined
        : 'log in yourself, in a terminal: `kiro-cli login` (it opens your browser; Builder ID, GitHub or Google), check with `kiro-cli whoami`, then re-run with --check. ' +
          'A Kiro Pro, Pro+, Pro Max or Power subscription can use an API key instead: export KIRO_API_KEY=<key>. The harness never logs in for you.',
    });
    if (!loggedIn) {
      add({ id: 'kiro-cli-checks', status: 'warn', message: 'agent and MCP checks of kiro-cli skipped: no kiro-cli command runs without a login (they run once you are logged in)' });
    }
  }
  if (h.kiro && loggedIn) {
    for (const ctx of armList) {
      const env = armEnv(h.env, envSpec(h, ctx, join(ctx.dir, 'check-home')));
      const val = await kiroCall(h.kiro, ['agent', 'validate', '--path', ctx.agentPath], { cwd: ctx.wt, env });
      const problem = validateOutputProblems(val);
      add({ id: `agent-${ctx.arm}`, status: problem ? 'fail' : 'ok', message: `arm ${ctx.arm} agent ${ctx.agentName}: ${problem ?? 'valid JSON shape (kiro-cli agent validate; tool names and trust are only proven by a run: the smoke run with --smoke, else the first planned run)'}` });
      const list = await kiroCall(h.kiro, ['mcp', 'list'], { cwd: ctx.wt, env });
      const servers = parseMcpList(`${list.stdout}\n${list.stderr}`).get(ctx.agentName);
      const v3note = h.o.engine === 'v3' ? ` (kiro-cli's view of KIRO_HOME; the V3 engine also loads ${join(h.userHome, '.kiro', 'settings', 'mcp.json')}, see the V3 check)` : '';
      if (servers === undefined) {
        add({ id: `mcp-list-${ctx.arm}`, status: 'warn', message: `arm ${ctx.arm}: \`kiro-cli mcp list\` does not list agent ${ctx.agentName} (cannot confirm its MCP servers)` });
      } else {
        const hasKopt = servers.includes('kopt');
        const good = hasKopt === ctx.kopt;
        add({
          id: `mcp-list-${ctx.arm}`,
          status: good ? 'ok' : 'fail',
          message: `arm ${ctx.arm}: kiro-cli sees MCP servers [${servers.join(', ') || 'none'}] for ${ctx.agentName}${good ? '' : ctx.kopt ? ' (kopt missing)' : ' (kopt must not be there)'}${v3note}`,
        });
      }
    }
  }

  // kopt doctor-like checks inside the kopt arms
  for (const ctx of h.arms.values()) {
    if (!ctx.kopt) continue;
    if (ctx.arm === 'B') {
      const cmd = koptHookCommand(h, ctx);
      if (!cmd) add({ id: 'hook-B', status: 'fail', message: 'arm B: no kopt PreToolUse hook found' });
      else {
        const env = armEnv(h.env, envSpec(h, ctx, join(ctx.dir, 'check-home')));
        const event = h.o.engine === 'v2'
          ? { hook_event_name: 'preToolUse', session_id: 'kopt-ab-check', cwd: ctx.wt, tool_name: 'grep', tool_input: { pattern: 'kopt' } }
          : { hook_event_name: 'PreToolUse', session_id: 'kopt-ab-check', cwd: ctx.wt, tool_name: 'grep_search', tool_input: { query: 'kopt' } };
        const r = await runHookCommand(cmd, event, { cwd: ctx.wt, env, timeoutMs: 20_000 });
        const silent = r.code === 0 && !r.stdout.trim() && !r.stderr.trim();
        add({
          id: 'hook-B',
          status: silent ? 'ok' : 'fail',
          message: silent ? `arm B: kopt hook allow path is silent (exit 0, ${r.ms} ms${process.platform === 'win32' ? ', through cmd.exe' : ''})` : `arm B: kopt hook allow path: exit ${r.code ?? r.error}, stdout ${JSON.stringify(r.stdout.slice(0, 120))}, stderr ${JSON.stringify(r.stderr.slice(0, 160))}`,
          fix: silent ? undefined : `run the hook command by hand: ${cmd}`,
        });
        if (process.platform === 'win32') {
          // Kiro may run hooks through PowerShell rather than cmd.exe (not verified)
          const ps = await runPowerShellHook(cmd, event, ctx.wt, env);
          add({
            id: 'hook-B-powershell',
            status: ps.ok ? 'ok' : 'warn',
            message: ps.ok ? 'arm B: the kopt hook also runs through PowerShell' : `arm B: the kopt hook fails through PowerShell (${ps.detail}); fine if Kiro runs hooks through cmd.exe (the smoke run shows it)`,
          });
        }
      }
    }
    const entry =
      ctx.arm === 'B'
        ? readJson<{ mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> }>(join(ctx.wt, '.kiro', 'settings', 'mcp.json'))?.mcpServers?.kopt
        : readJson<{ mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> }>(ctx.agentPath)?.mcpServers?.kopt;
    if (!entry) add({ id: `mcp-${ctx.arm}`, status: 'fail', message: `arm ${ctx.arm}: no kopt MCP entry` });
    else {
      const r = await mcpListsTools(h, ctx, entry);
      const ok = !!r.tools && ['kopt_find', 'kopt_read', 'kopt_refs'].every((t) => r.tools!.includes(t));
      add({
        id: `mcp-${ctx.arm}`,
        status: ok ? 'ok' : 'fail',
        message: ok ? `arm ${ctx.arm}: kopt MCP server starts and lists ${r.tools!.length} tools` : `arm ${ctx.arm}: kopt MCP server: ${r.error ?? `tools ${r.tools?.join(', ')}`}`,
        fix: ok ? undefined : `start it by hand: ${[entry.command, ...(entry.args ?? [])].join(' ')}`,
      });
    }
  }
  h.smokeFile = pickSmokeFile(h);
  if (h.o.smoke) {
    add({
      id: 'smoke-file',
      status: 'ok',
      message: h.smokeFile ? `smoke prompts: one read of ${h.smokeFile} (arm A), one kopt_read outline of it (kopt arms)` : 'smoke prompts: no small source file found, the smoke reads the directory listing',
    });
  }

  // models: opt-in (--list-models is a request to Kiro), and only once logged in (a chat subcommand without
  // credentials can start a browser login)
  let models: ModelInfo[] | undefined;
  let smokeModel = h.o.smokeModel ?? h.o.model;
  if (!h.o.listModels) {
    add({
      id: 'model',
      status: 'ok',
      message: `model ${h.o.model}: not checked against your account's model list (--list-models reads it: one \`kiro-cli chat --list-models\` request to Kiro); a model your plan does not have stops the campaign at its first run (model_unavailable)`,
    });
  } else if (h.kiro && loggedIn && process.env.VITEST && !isSimulator(h.kiro)) {
    add({ id: 'models', status: 'warn', message: 'the model list is not read under the test runner with a real kiro-cli' });
  } else if (h.kiro && loggedIn) {
    const ctx = [...h.arms.values()][0];
    const env = ctx ? armEnv(h.env, envSpec(h, ctx, join(ctx.dir, 'check-home'))) : h.env;
    const r = await kiroCall(h.kiro, ['chat', '--list-models', '--format', 'json'], { cwd: ctx?.wt ?? h.repo.root, env, timeoutMs: 60_000 });
    models = r.code === 0 ? parseModelList(r.stdout) : [];
    if (!models.length) {
      add({ id: 'models', status: 'warn', message: `could not read the model list (kiro-cli chat --list-models exit ${r.code}); model ids are not checked` });
    } else {
      const has = models.some((m) => m.id === h.o.model);
      add({
        id: 'model',
        status: has ? 'ok' : 'fail',
        message: has ? `model ${h.o.model} is available to this account` : `model ${h.o.model} is not in this account's model list: ${models.map((m) => `${m.id}${m.multiplier !== undefined ? ` (x${m.multiplier})` : ''}`).join(', ')}`,
        fix: has ? undefined : 'pass --model <one of the ids above> (pin a model: Auto routes to different models from run to run)',
      });
      if (!h.o.smokeModel) {
        const cheap = cheapestModel(models);
        if (cheap) smokeModel = cheap.id;
      } else if (!models.some((m) => m.id === h.o.smokeModel)) {
        add({ id: 'smoke-model', status: 'fail', message: `--smoke-model ${h.o.smokeModel} is not in the model list` });
      }
    }
  }
  if (/^auto$/i.test(h.o.model)) add({ id: 'model-auto', status: 'warn', message: 'model Auto routes requests to different models from run to run: the comparison is noisier; pin a model with --model' });

  // cost
  const nTasks = h.tasks ? (h.o.only?.length ? h.o.only.length : h.tasks.tasks.length) : 0;
  const runs = nTasks * h.o.arms.length * h.o.reps;
  const smokeRuns = h.o.smoke ? h.o.arms.length : 0;
  const smokeEst = smokeRuns * Math.min(SMOKE_ESTIMATE, h.o.creditsPerRun);
  const block = h.o.arms.length * h.o.creditsPerRun;
  const credits = runs * h.o.creditsPerRun + smokeEst;
  const cap = h.o.maxCredits;
  const capNote =
    cap === undefined
      ? ''
      : credits > cap
        ? `; above --max-credits ${cap}: the budget stops the campaign after about ${Math.max(0, Math.floor((cap - smokeEst) / block))} task block(s) of ${h.o.arms.length} runs`
        : ` (budget --max-credits ${cap})`;
  const tooSmall = o.forRun && cap !== undefined && cap < smokeEst + block;
  const cheapest = models?.length ? cheapestModel(models)?.id : undefined;
  add({
    id: 'cost',
    status: o.forRun && cap === undefined ? 'fail' : tooSmall ? 'fail' : 'ok',
    message:
      `estimate: ${runs} runs (${nTasks} tasks x ${h.o.arms.length} arms x ${h.o.reps} reps) + ${smokeRuns} smoke run(s) on ${smokeModel} ~ ${credits.toFixed(1)} credits at ${h.o.creditsPerRun} credits/run (--credits-per-run, a guess until real runs are measured)${capNote}` +
      (tooSmall ? `; --max-credits ${cap} cannot pay for ${smokeRuns ? 'the smoke runs plus ' : ''}one task in every arm (~${(smokeEst + block).toFixed(2)})` : ''),
    fix:
      o.forRun && cap === undefined
        ? 'pass --max-credits <N>: the budget is required for a real run'
        : tooSmall
          ? `raise --max-credits, or lower --credits-per-run if you measured a cheaper run. First probe: --only <one task id> --reps 1 --model ${cheapest ?? "<your plan's cheapest model>"} --timeout 120 --max-credits <2 x one pair>`
          : undefined,
  });
  return { checks, ok: !checks.some((c) => c.status === 'fail'), models, smokeModel, estimate: { runs, smokeRuns, credits } };
}

function readFileSafe(p: string): string {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

/** Windows only: the hook command through PowerShell, the event piped in (code reading only: not verified on Windows). */
async function runPowerShellHook(cmd: string, event: unknown, cwd: string, env: NodeJS.ProcessEnv): Promise<{ ok: boolean; detail: string }> {
  const json = JSON.stringify(event).replace(/'/g, "''");
  const r = await runProcess({ command: 'powershell.exe', prefix: [], display: 'powershell.exe' }, ['-NoProfile', '-NonInteractive', '-Command', `'${json}' | ${cmd}`], { cwd, env, timeoutMs: 30_000 });
  return { ok: r.code === 0 && !r.stdout.trim() && !r.stderr.trim(), detail: `exit ${r.code ?? r.spawnError}, ${r.stderr.trim().slice(0, 160)}` };
}

// ---------------------------------------------------------------------------------------------------------
// one run

let interrupted = false;

export function requestInterrupt(): void {
  interrupted = true;
  const c = activeChild();
  if (c) killTree(c, 'SIGTERM');
}

export class Interrupted extends Error {}

/** kiro-cli lost its login between runs: no chat call is made (a logged-out chat can start a browser login). */
export class LoginLost extends Error {}

/** kiro-cli changed version during the campaign (an update): results would mix two versions. */
export class VersionChanged extends Error {}

/** Checked right before every run, in the run's environment: the login, and the kiro-cli version. */
async function runGuard(h: Harness, ctx: ArmCtx, env: NodeJS.ProcessEnv): Promise<void> {
  const who = parseWhoami(await kiroCall(h.kiro!, ['whoami'], { cwd: ctx.wt, env }));
  if (!who.loggedIn) throw new LoginLost(`kiro-cli is no longer logged in (whoami: ${who.output}): run \`kiro-cli login\`, then the same command with --resume`);
  if (h.kiroVersion) {
    const v = await kiroCall(h.kiro!, ['--version'], { cwd: ctx.wt, env });
    const now = parseVersion(`${v.stdout} ${v.stderr}`);
    if (now && now !== h.kiroVersion) {
      throw new VersionChanged(`kiro-cli changed from ${h.kiroVersion} to ${now} during the campaign (an update?): results would mix two versions; start a new campaign in another --out`);
    }
  }
}

export interface RunLimit {
  /** Kill the run when its metered credits reach this (remaining budget, or --max-run-credits). */
  limit?: number;
  /** What the limit is (for the record). */
  what?: string;
  /** Expected cost of the run: a run past 1.5x of it is a runaway, stopped before a request that would cross the limit. */
  estimate?: number;
}

/** A run past this multiple of its estimate is a runaway: it is stopped before a next request would cross the limit. */
export const RUNAWAY_FACTOR = 1.5;

export async function executeRun(
  h: Harness,
  ctx: ArmCtx,
  meta: Omit<StartedMeta, 'startedAt' | 'startMs' | 'koptArm' | 'engine'>,
  prompt: string,
  runDir: string,
  lim: RunLimit = {},
): Promise<RunRecord> {
  if (!h.kiro) throw new AbError('kiro-cli not found');
  refuseRealKiroUnderTests(h, 'send a prompt');
  const baseline = loadBaseline(ctx.store);
  if (!baseline) throw new AbError(`arm ${ctx.arm} is not prepared (no baseline)`);
  guardHead(ctx.wt, h.repo.head);
  restoreBaseline(ctx.wt, ctx.store, baseline);
  // the login (and the version) is checked again right before every run, in the run's environment
  await runGuard(h, ctx, armEnv(h.env, envSpec(h, ctx, join(ctx.dir, 'check-home'))));
  rmSync(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  mkdirSync(runDir, { recursive: true });
  const koptHome = join(runDir, 'kopt-home');
  mkdirSync(koptHome, { recursive: true });
  const startMs = Date.now();
  const started: StartedMeta = { ...meta, engine: h.o.engine, startedAt: new Date(startMs).toISOString(), startMs, koptArm: ctx.kopt, timeoutS: h.o.timeoutS, ...(h.kiroVersion ? { kiroVersion: h.kiroVersion } : {}) };
  writeJson(join(runDir, 'started.json'), started);
  configureRun(h, ctx, koptHome);
  const env = armEnv(h.env, envSpec(h, ctx, koptHome));
  setEnv(env, 'KIRO_CHAT_LOG_FILE', join(runDir, 'kiro-chat.log'));
  const args = [
    'chat',
    '--no-interactive',
    '--agent-engine',
    h.o.engine,
    '--agent',
    ctx.agentName,
    '--model',
    meta.model,
    ...(h.o.effort ? ['--effort', h.o.effort] : []),
    '--output-format',
    'stream-json',
    `--trust-tools=${ctx.trust}`,
    ...(ctx.requireMcp ? ['--require-mcp-startup'] : []),
    prompt,
  ];
  const before = sessionSnapshot(places(h, ctx));
  writeJson(join(runDir, 'command.json'), { command: h.kiro.command, args: [...h.kiro.prefix, ...args], cwd: ctx.wt, KIRO_HOME: ctx.kiroHome, KOPT_HOME: koptHome, KOPT_CACHE_DIR: h.cacheDir, KOPT_DATA_DIR: ctx.dataDir, ...(lim.limit !== undefined ? { creditLimit: lim.limit } : {}) });
  // the live meter: Kiro bills per request; when the stream reports per-request metering (V2), a run whose next
  // request would likely cross the budget is stopped before it is sent
  const meter = new LiveMeter();
  const limit = lim.limit;
  const res = await runProcess(h.kiro, args, {
    cwd: ctx.wt,
    env,
    timeoutMs: h.o.timeoutS * 1000,
    stdoutFile: join(runDir, 'stream.jsonl'),
    stderrFile: join(runDir, 'stderr.log'),
    reapWindows: true,
    onSpawn: (pid) => writeJson(join(runDir, 'child.json'), { pid, startMs, command: h.kiro!.command, prefix: h.kiro!.prefix }),
    watchStdout: (chunk) => {
      const added = meter.feed(chunk);
      if (!added || limit === undefined) return undefined;
      const why = lim.what ? ` (${lim.what})` : '';
      // the limit is reached: whatever comes next is over budget
      if (meter.credits >= limit - 1e-9) return `metered credits ${meter.credits} reached the limit of this run, ${round3(limit)}${why}`;
      // a runaway run (well past its expected cost) is stopped before a next request would cross the limit; a run
      // within its estimate is left to finish (its last request is usually the answer)
      if (meter.lastFromRequest && lim.estimate !== undefined && meter.credits >= RUNAWAY_FACTOR * lim.estimate && meter.credits + meter.maxStep > limit) {
        return `metered credits ${meter.credits} (over ${RUNAWAY_FACTOR}x the expected ${round3(lim.estimate)}) + about ${round3(meter.maxStep)} for a next request would exceed the limit of this run, ${round3(limit)}${why}`;
      }
      return undefined;
    },
  });
  if (interrupted) throw new Interrupted('interrupted');
  let sessionId: string | undefined;
  try {
    sessionId = /"sessionId"\s*:\s*"([^"]+)"/.exec(readFileSync(join(runDir, 'stream.jsonl'), 'utf8').slice(0, 20000))?.[1];
  } catch {
    // no stream
  }
  collectSessions({ ...places(h, ctx), startMs, sessionId, before, dest: join(runDir, 'session') });
  // a shell tool may have committed or switched branches: HEAD goes back to the campaign's commit first
  const headMoved = guardHead(ctx.wt, h.repo.head);
  // Kiro's own workspace caches are reverted too, but they are not changes made by the agent
  const changed = restoreBaseline(ctx.wt, ctx.store, baseline).filter((p) => !ctx.managed.includes(p) && !/^\.kiro\/(cache|logs|sessions)\//.test(p));
  const exit: ExitInfo = {
    code: res.code,
    signal: res.signal,
    timedOut: res.timedOut,
    ms: res.ms,
    ...(res.spawnError ? { spawnError: res.spawnError } : {}),
    ...(res.killedFor ? { budgetKill: res.killedFor } : {}),
    ...(meter.credits ? { metered: meter.credits } : {}),
    ...(headMoved ? { headMoved } : {}),
    dirtyAfter: changed,
  };
  writeJson(join(runDir, 'exit.json'), exit);
  if (headMoved) h.log(`  ${meta.runId}: the run moved the worktree HEAD to ${headMoved.slice(0, 12)} (commit or branch switch): reset to ${h.repo.head.slice(0, 12)}`);
  const record = buildRecord(runDir, started, exit, h.taskById.get(meta.task), h.passRatio);
  writeFileSync(join(runDir, 'answer.md'), answerText(runDir));
  writeJson(join(runDir, 'record.json'), record);
  return record;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

// ---------------------------------------------------------------------------------------------------------
// campaign

function campaignFingerprint(h: Harness): Record<string, unknown> {
  return {
    repo: h.repo.root,
    head: h.repo.head,
    tasksSha256: h.tasks?.sha256,
    only: h.o.only ?? null,
    arms: h.o.arms,
    reps: h.o.reps,
    model: h.o.model,
    effort: h.o.effort ?? null,
    engine: h.o.engine,
    seed: h.o.seed,
    tools: h.o.tools,
    promptSuffix: h.o.promptSuffix,
    settings: h.o.settings,
    passRatio: h.passRatio,
  };
}

export function loadRecords(out: string): RunRecord[] {
  const recs: RunRecord[] = [];
  for (const sub of ['runs', 'smoke']) {
    const d = join(out, sub);
    if (!existsSync(d)) continue;
    for (const n of readdirSync(d).sort()) {
      const r = readJson<RunRecord>(join(d, n, 'record.json'));
      if (r) recs.push(r);
    }
  }
  return recs;
}

export interface CampaignResult {
  status: 'completed' | 'stopped' | 'preflight_failed' | 'smoke_failed';
  stopReason?: string;
  records: RunRecord[];
  spent: number;
  reportFiles: string[];
  verdicts: string[];
}

function describeFailure(r: RunRecord, runDir: string): string {
  const stream = existsSync(join(runDir, 'stream.jsonl')) ? readFileSync(join(runDir, 'stream.jsonl'), 'utf8') : '';
  const stderr = existsSync(join(runDir, 'stderr.log')) ? readFileSync(join(runDir, 'stderr.log'), 'utf8') : '';
  const tools = parseStream(stream).toolCalls;
  const lines = [
    `arm ${r.arm}: ${r.invalidReason ?? 'ok'}${r.errorDetail ? `: ${r.errorDetail}` : ''}`,
    `  exit ${r.exitCode ?? (r.timedOut ? 'timeout' : 'none')}, ${r.streamLines} stream line(s) (${r.streamBadLines} malformed), session files ${existsSync(join(runDir, 'session')) ? 'collected' : 'none'}`,
    `  credits: stream ${r.creditsStream ?? 'none'}, session ${r.creditsSession ?? 'none'}; answer ${r.answerChars} chars (${r.answerSource || 'none'}); kopt hook events ${r.koptHookEvents}, kopt tool calls: telemetry ${r.koptCallsTelemetry}, stream ${r.koptCallsStream}${r.koptCallsFailed ? `, failed ${r.koptCallsFailed}` : ''}`,
    `  tool calls in the stream: ${tools.length ? tools.map((t) => `${t.title ?? t.name} [${t.status ?? 'no status'}${t.failureReason ? `, ${t.failureReason}` : ''}${t.permissionRequested ? ', permission requested' : ''}]`).join('; ') : 'none'}`,
  ];
  if (stderr.trim()) lines.push(`  stderr (last lines): ${stderr.trim().split(/\r?\n/).slice(-5).join(' | ').slice(0, 600)}`);
  if (!r.streamLines && !stream.trim()) lines.push('  the stream is empty: kiro-cli printed nothing on stdout (check stderr.log and kiro-chat.log)');
  lines.push(`  files: ${runDir}`);
  if (r.errorKind === 'account_blocked') lines.push(`  ${ACCOUNT_BLOCKED_ADVICE}`);
  return lines.join('\n');
}

/** Run limit of the next run: what is left of --max-credits, and --max-run-credits. */
function runLimit(h: Harness, spent: number, estimate: number): RunLimit {
  const left = h.o.maxCredits !== undefined ? h.o.maxCredits - spent : undefined;
  const per = h.o.maxRunCredits;
  if (left === undefined && per === undefined) return { estimate };
  if (per !== undefined && (left === undefined || per <= left)) return { limit: per, what: '--max-run-credits', estimate };
  return { limit: Math.max(0, left!), what: `what is left of --max-credits ${h.o.maxCredits}`, estimate };
}

/** Smoke checks of one arm: the run is usable, the arm's one tool call completed, kopt served it (kopt arms). */
export function smokeProblems(h: Harness, ctx: ArmCtx, r: RunRecord, runDir: string): { problems: string[]; notes: string[] } {
  const problems: string[] = [];
  const notes: string[] = [];
  if (r.errorKind === 'zero_credits') notes.push('Kiro metered the smoke run at 0 credits: the metering is there and parsed (the amount rounded to 0)');
  else if (!r.valid) problems.push(r.invalidReason ?? 'invalid');
  const tools = parseStream(readFileSafe(join(runDir, 'stream.jsonl'))).toolCalls;
  const completed = tools.filter((t) => t.status === 'completed');
  if (ctx.kopt) {
    if (!completed.some(isKoptCall)) {
      const kopt = tools.filter(isKoptCall);
      problems.push(
        kopt.length
          ? `the kopt tool call did not complete (${kopt.map((t) => `${t.title ?? t.name}: ${t.status ?? 'no status'}${t.failureReason ? ` ${t.failureReason}` : ''}`).join(', ')}): check the --trust-tools names and the agent's allowedTools/permissions`
          : 'no kopt tool call in the stream: the kopt tools are not visible to the agent, or the model did not call kopt_read',
      );
    }
    if (r.koptCallsTelemetry === 0) problems.push(`kopt's telemetry in ${join(runDir, 'kopt-home')} has no tool line: the kopt MCP server did not serve the call, or did not get the run's KOPT_HOME`);
  } else if (!completed.some((t) => !isKoptCall(t))) {
    problems.push(
      tools.length
        ? `the built-in tool call did not complete (${tools.map((t) => `${t.title ?? t.name}: ${t.status ?? 'no status'}`).join(', ')}): check the --trust-tools names (${ctx.trust})`
        : 'no tool call in the stream: the model did not call the read tool the smoke prompt asked for',
    );
  }
  if (ctx.arm === 'B' && (r.valid || r.errorKind === 'zero_credits') && r.koptHookEvents === 0) {
    problems.push(`the kopt hooks left no trace in this run's KOPT_HOME (${join(runDir, 'kopt-home')}): Kiro did not run them, or ran them without the run's environment`);
  }
  return { problems, notes };
}

export async function runSmoke(h: Harness, smokeModel: string, spentBefore: number): Promise<{ ok: boolean; records: RunRecord[]; diagnosis: string[] }> {
  const out: RunRecord[] = [];
  const diagnosis: string[] = [];
  let spent = spentBefore;
  const est = Math.min(SMOKE_ESTIMATE, h.o.creditsPerRun);
  // all arms or none: a smoke that can only pay for some arms proves nothing
  if (h.o.maxCredits !== undefined && spent + est * h.o.arms.length > h.o.maxCredits) {
    diagnosis.push(`not run: the smoke runs need about ${(est * h.o.arms.length).toFixed(2)} credits and ${spent.toFixed(3)} of --max-credits ${h.o.maxCredits} are spent`);
    return { ok: false, records: out, diagnosis };
  }
  h.log(`smoke: one tiny prompt with one tool call per arm on ${smokeModel} (${h.o.arms.join(', ')})`);
  for (const arm of h.o.arms) {
    const ctx = h.arms.get(arm)!;
    const runDir = join(h.out, 'smoke', arm);
    const previous = readJson<RunRecord>(join(runDir, 'record.json'));
    if (previous) {
      // a forced re-run replaces an earlier smoke run: keep its cost in the budget
      archiveAttempt(h, runDir, `smoke__${arm}`, { credits: billed(previous, est), measured: previous.credits !== undefined, reason: 'superseded', errorKind: previous.errorKind });
    }
    let r: RunRecord;
    try {
      r = await executeRun(h, ctx, { runId: `smoke__${arm}`, idx: 0, task: 'smoke', kind: 'smoke', arm, rep: 0, order: 0, smoke: true, model: smokeModel }, smokePrompt(ctx.kopt ? 'kopt' : 'builtin', h.smokeFile), runDir, runLimit(h, spent, est));
    } catch (err) {
      if (!(err instanceof LoginLost) && !(err instanceof VersionChanged)) throw err;
      diagnosis.push(`arm ${arm}: ${err.message}`);
      break;
    }
    out.push(r);
    spent += billed(r, est);
    const { problems, notes } = smokeProblems(h, ctx, r, runDir);
    h.log(`smoke arm ${arm}: ${problems.length ? `FAILED (${problems.join('; ')})` : `ok, ${r.credits ?? 0} credits (${r.creditsSource ?? 'metered 0'}), ${r.wallMs} ms`}${notes.length ? `; ${notes.join('; ')}` : ''}`);
    if (problems.length) {
      diagnosis.push(`${problems.join('; ')}\n${describeFailure(r, runDir)}`);
      // stop at the first anomaly: no further credit is spent
      break;
    }
  }
  const ok = !diagnosis.length && out.length === h.o.arms.length;
  writeJson(join(h.out, 'smoke', 'result.json'), { ok, at: new Date().toISOString(), model: smokeModel, file: h.smokeFile, runs: out.map((r) => ({ arm: r.arm, valid: r.valid, credits: r.credits, source: r.creditsSource, reason: r.invalidReason })) });
  return { ok, records: out, diagnosis };
}

function writeState(h: Harness, state: Record<string, unknown>): void {
  writeJson(join(h.out, 'state.json'), { ...state, updatedAt: new Date().toISOString() });
}

export function reportMeta(h: Harness): Record<string, unknown> {
  return { repo: h.repo.root, commit: h.repo.head, model: h.o.model, engine: h.o.engine, kiroVersion: h.kiroVersion ? `kiro-cli ${h.kiroVersion}` : undefined, reps: h.o.reps, arms: h.o.arms, out: h.out };
}

/** Move a run directory to `<out>/attempts/<runId>/<n>` and count its credits in aborted.jsonl. */
function archiveAttempt(h: Harness, dir: string, runId: string, a: Omit<ArchivedAttempt, 'runId' | 'at' | 'archivedTo'>): void {
  let dest: string | undefined;
  if (existsSync(dir)) {
    const base = join(h.out, 'attempts', runId);
    mkdirSync(base, { recursive: true });
    let n = 1;
    while (existsSync(join(base, String(n)))) n++;
    dest = join(base, String(n));
    try {
      renameSync(dir, dest);
    } catch {
      dest = undefined;
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
  appendFileSync(join(h.out, 'aborted.jsonl'), JSON.stringify({ runId, at: new Date().toISOString(), ...a, ...(dest ? { archivedTo: relative(h.out, dest) } : {}) }) + '\n');
}

function unfinishedRunDirs(out: string): string[] {
  const dirs: string[] = [];
  for (const sub of ['runs', 'smoke']) {
    const d = join(out, sub);
    if (!existsSync(d)) continue;
    for (const n of readdirSync(d)) {
      const dir = join(d, n);
      if (existsSync(join(dir, 'started.json')) && !existsSync(join(dir, 'record.json'))) dirs.push(dir);
    }
  }
  return dirs;
}

/**
 * Runs a previous harness process left behind (it was killed, or its terminal closed): a kiro-cli still running
 * there is stopped (it would keep spending, and it runs in a worktree the new process restores), and the session
 * files it wrote are collected into its run directory so that the run can be billed at what it measured.
 */
export async function reapOrphans(h: Harness): Promise<void> {
  for (const dir of unfinishedRunDirs(h.out)) {
    const child = readJson<{ pid: number; command: string; prefix?: string[] }>(join(dir, 'child.json'));
    if (child && processAlive(child.pid)) {
      const cmd = processCommand(child.pid);
      const names = [child.command, ...(child.prefix ?? [])].map((p) => basename(p).replace(/\.exe$/i, ''));
      if (cmd && names.every((n) => cmd.includes(n))) {
        h.log(`${basename(dir)}: kiro-cli (pid ${child.pid}) from a previous harness process is still running: stopping it`);
        killPidTree(child.pid, 'SIGTERM');
        const t0 = Date.now();
        while (processAlive(child.pid) && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 200));
        if (processAlive(child.pid)) killPidTree(child.pid, 'SIGKILL');
      }
    }
    const started = readJson<StartedMeta>(join(dir, 'started.json'));
    if (!started) continue;
    const ctx = armCtx(h, started.arm);
    let sessionId: string | undefined;
    try {
      sessionId = /"sessionId"\s*:\s*"([^"]+)"/.exec(readFileSync(join(dir, 'stream.jsonl'), 'utf8').slice(0, 20000))?.[1];
    } catch {
      // no stream
    }
    collectSessions({ ...places(h, ctx), startMs: started.startMs, sessionId, before: new Set(), dest: join(dir, 'session') });
  }
}

/** Bill and archive the runs a previous process left unfinished (after reapOrphans collected their session files). */
function sweepAborted(h: Harness, records: RunRecord[]): void {
  for (const dir of unfinishedRunDirs(h.out)) {
    const started = readJson<StartedMeta>(join(dir, 'started.json'));
    if (!started) continue;
    const r = buildRecord(dir, started, readJson<ExitInfo>(join(dir, 'exit.json')), h.taskById.get(started.task), h.passRatio);
    // kiro-cli was started (child.json): the run is billed at what it measured, at least the estimate
    const spawned = existsSync(join(dir, 'child.json'));
    const credits = spawned ? billed(r, estimateFor(records, started.arm, h.o.creditsPerRun), typicalWallMs(records, started.arm)) : (r.credits ?? 0);
    h.log(`${started.runId}: left unfinished by a previous process: counted for ${credits.toFixed(3)} credits (${r.credits !== undefined ? 'measured' : spawned ? 'estimated' : 'kiro-cli never started'}), run again`);
    archiveAttempt(h, dir, started.runId, { credits, measured: r.credits !== undefined, reason: 'aborted', errorKind: r.errorKind });
  }
}

/** --resume: runs that failed for reasons outside the arm are archived (credits kept) and run again. */
function retryFailed(h: Harness, records: RunRecord[]): RunRecord[] {
  const keep: RunRecord[] = [];
  for (const r of records) {
    const timeoutRaised = r.errorKind === 'timeout' && r.timeoutS !== undefined && h.o.timeoutS > r.timeoutS;
    if (r.smoke || !r.errorKind || !(RETRY_ON_RESUME.has(r.errorKind) || timeoutRaised)) {
      keep.push(r);
      continue;
    }
    const credits = billed(r, estimateFor(records, r.arm, h.o.creditsPerRun), typicalWallMs(records, r.arm));
    archiveAttempt(h, join(h.out, 'runs', r.runId), r.runId, { credits, measured: r.credits !== undefined, reason: 'retried', errorKind: r.errorKind });
    h.log(`resume: ${r.runId} failed with ${r.errorKind}${timeoutRaised ? ` (--timeout raised from ${r.timeoutS} s)` : ''}: archived, its ${credits.toFixed(3)} credits still count, it runs again`);
  }
  return keep;
}

const ACCOUNT_RESTORED_FILE = 'account-restored.json';

/**
 * No prompt goes to an account Kiro blocked during this campaign (a run of this --out failed with account_blocked)
 * until the user says Kiro support restored it (--account-restored, recorded in <out>/account-restored.json).
 */
function guardBlockedAccount(h: Harness, o: AbOptions): void {
  const ack = readJson<{ at: string }>(join(h.out, ACCOUNT_RESTORED_FILE));
  const since = ack ? Date.parse(ack.at) : Number.NEGATIVE_INFINITY;
  const blocked = loadRecords(h.out).filter((r) => r.errorKind === 'account_blocked' && !(Date.parse(r.startedAt) <= since));
  if (!blocked.length) return;
  const where = blocked.map((r) => `${r.runId} (${r.startedAt})`).join(', ');
  if (!o.accountRestored) throw new AbError(`Kiro refused ${where} in ${h.out}: the account was blocked. ${ACCOUNT_BLOCKED_ADVICE}`);
  writeJson(join(h.out, ACCOUNT_RESTORED_FILE), { at: new Date().toISOString(), runs: blocked.map((r) => r.runId) });
  h.log(`--account-restored: Kiro blocked the account on ${where}; you confirmed that Kiro support restored it`);
}

export async function runCampaign(o: AbOptions): Promise<CampaignResult> {
  interrupted = false;
  const h = setupHarness(o);
  if (!h.tasks) throw new AbError('--tasks <file> is required');
  const release = acquireLock(h.out, 'campaign');
  try {
    return await campaign(h, o);
  } finally {
    release();
  }
}

async function campaign(h: Harness, o: AbOptions): Promise<CampaignResult> {
  const cfgPath = join(h.out, 'config.json');
  const fp = campaignFingerprint(h);
  const existing = readJson<{ fingerprint: Record<string, unknown>; kiroVersion?: string; createdAt?: string }>(cfgPath);
  if (existing && !o.resume) throw new AbError(`${h.out} already holds a campaign: add --resume to continue it, or choose another --out`);
  if (o.resume && existing) {
    const diffs = Object.keys(fp).filter((k) => JSON.stringify(fp[k]) !== JSON.stringify(existing.fingerprint[k]));
    if (diffs.length) throw new AbError(`--resume with different settings (${diffs.join(', ')}): use the original options, or another --out`);
  }
  // nothing is sent to an account Kiro blocked during this campaign until support restored it
  guardBlockedAccount(h, o);
  // a kiro-cli a killed harness left running is stopped before anything touches its worktree
  await reapOrphans(h);

  const pre = await preflight(h, { forRun: true });
  if (!pre.ok) return { status: 'preflight_failed', records: [], spent: 0, reportFiles: [], verdicts: [] };
  if (existing?.kiroVersion && h.kiroVersion && existing.kiroVersion !== h.kiroVersion) {
    throw new AbError(`kiro-cli is ${h.kiroVersion} now, the campaign in ${h.out} ran with ${existing.kiroVersion}: results would mix two versions; start a new campaign in another --out`);
  }
  writeJson(cfgPath, {
    fingerprint: fp,
    options: { ...fp, maxCredits: o.maxCredits, maxRunCredits: o.maxRunCredits, timeoutS: o.timeoutS, creditsPerRun: o.creditsPerRun },
    kiroVersion: existing?.kiroVersion ?? h.kiroVersion,
    node: h.node,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  });

  let records = loadRecords(h.out);
  sweepAborted(h, records);
  records = retryFailed(h, records);
  const spentOf = () => budgetTotals(records, h.out, o.creditsPerRun).counted;

  // plan
  const planPath = join(h.out, 'plan.json');
  let plan = readJson<PlanItem[]>(planPath);
  if (!plan) {
    const ids = h.tasks!.tasks.map((t) => t.id).filter((id) => !o.only?.length || o.only.includes(id));
    plan = makePlan(ids, o.arms, o.reps, o.seed);
    writeJson(planPath, plan);
  }
  const done = new Set(records.filter((r) => !r.smoke).map((r) => r.runId));
  const todo = plan.filter((p) => !done.has(p.runId));
  const blockOf = (p: PlanItem) => `${p.task}\u0000${p.rep}`;
  /** Estimated cost of what is left of the block of `item` (itself included). */
  const blockCost = (item: PlanItem) => todo.filter((p) => blockOf(p) === blockOf(item) && !done.has(p.runId)).reduce((a, p) => a + estimateFor(records, p.arm, o.creditsPerRun), 0);

  // smoke: opt-in (--smoke), once per output directory, before the first planned run
  const smokeDone = readJson<{ ok: boolean }>(join(h.out, 'smoke', 'result.json'))?.ok === true;
  if (o.smoke && smokeDone) h.log('smoke: it already passed in this output directory, not run again');
  else if (!o.smoke && todo.length && !records.some((r) => !r.smoke)) {
    h.log('no smoke run (opt-in: --smoke): the first planned run of each arm is its first headless request; the campaign stops at the first fatal error');
  }
  if (o.smoke && !smokeDone) {
    // the smoke is only worth paying for when the budget also covers the first task block after it
    const smokeCost = Math.min(SMOKE_ESTIMATE, o.creditsPerRun) * o.arms.length;
    const first = todo[0];
    if (o.maxCredits !== undefined && first && spentOf() + smokeCost + blockCost(first) > o.maxCredits) {
      const reason = `credit budget: ${spentOf().toFixed(3)} spent + about ${smokeCost.toFixed(2)} for the smoke runs + about ${blockCost(first).toFixed(2)} for the first task in every arm would exceed --max-credits ${o.maxCredits} (raise it, or lower --credits-per-run if you measured a cheaper run)`;
      writeState(h, { status: 'stopped', stopReason: reason });
      h.log(reason);
      return { status: 'stopped', stopReason: reason, records, spent: spentOf(), reportFiles: [], verdicts: [] };
    }
    const prior = records.filter((r) => !r.smoke);
    const s = await runSmoke(h, pre.smokeModel, spentOf());
    records = [...prior, ...s.records];
    if (!s.ok) {
      writeState(h, { status: 'smoke_failed', diagnosis: s.diagnosis });
      h.log(`smoke run failed, nothing else was run:\n${s.diagnosis.join('\n')}`);
      return { status: 'smoke_failed', stopReason: s.diagnosis.join('\n'), records, spent: spentOf(), reportFiles: [], verdicts: [] };
    }
  }

  h.log(`${plan.length} planned runs, ${plan.length - todo.length} already done, ${todo.length} to run; credits counted so far ${spentOf().toFixed(3)}${o.maxCredits !== undefined ? ` of ${o.maxCredits}` : ''}`);

  let stopReason: string | undefined;
  let consecutive = 0;
  writeState(h, { status: 'running', pid: process.pid });
  const finish = (status: CampaignResult['status'] | 'interrupted') => {
    writeState(h, { status, stopReason });
    const rep = writeReport(h.out, records, o.arms, { ...reportMeta(h), budget: budgetTotals(records, h.out, o.creditsPerRun), archivedAttempts: readArchived(h.out).length });
    for (const n of rep.notes) h.log(`WARN ${n}`);
    return rep;
  };
  try {
    for (const item of todo) {
      if (interrupted) throw new Interrupted('interrupted');
      const spent = spentOf();
      if (o.maxCredits !== undefined) {
        // a (task, rep) block only starts when the budget covers every arm of it: a pair is the unit of evidence
        const first = !records.some((r) => !r.smoke && r.task === item.task && r.rep === item.rep);
        const need = first ? blockCost(item) : estimateFor(records, item.arm, o.creditsPerRun);
        if (spent + need > o.maxCredits) {
          stopReason = `credit budget: ${spent.toFixed(3)} counted + about ${need.toFixed(3)} for ${first ? `task ${item.task} rep ${item.rep} in every arm` : `run ${item.runId}`} would exceed --max-credits ${o.maxCredits}`;
          break;
        }
      }
      const task = h.taskById.get(item.task)!;
      const runDir = join(h.out, 'runs', item.runId);
      let r: RunRecord;
      try {
        r = await executeRun(h, h.arms.get(item.arm)!, { runId: item.runId, idx: item.idx, task: item.task, kind: task.kind ?? '', arm: item.arm, rep: item.rep, order: item.order, smoke: false, model: o.model }, buildPrompt(task, o.promptSuffix), runDir, runLimit(h, spent, estimateFor(records, item.arm, o.creditsPerRun)));
      } catch (err) {
        if (!(err instanceof LoginLost) && !(err instanceof VersionChanged)) throw err;
        stopReason = err.message;
        break;
      }
      records.push(r);
      done.add(r.runId);
      const g = r.grade ? (r.grade.pass ? 'pass' : 'fail') : 'ungraded';
      h.log(
        `[${item.idx}/${plan.length}] ${item.task} arm ${item.arm} rep ${item.rep}: ${r.valid ? `${r.credits} credits (${r.creditsSource})` : `INVALID ${r.invalidReason}`}, ${r.toolCalls} tool calls${KOPT_ARMS.has(item.arm) ? `, ${r.koptCalls} kopt` : ''}, ${g}, ${(r.wallMs / 1000).toFixed(0)} s`,
      );
      if (r.koptFlag) h.log(`  flag: ${r.koptFlag}`);
      // arm B has kopt's steering and hooks: two valid runs without a single kopt call (by kopt's telemetry) means
      // kopt is not reachable
      if (item.arm === 'B') {
        const validB = records.filter((x) => !x.smoke && x.arm === 'B' && x.valid);
        if (validB.length === 2 && validB.every((x) => x.koptCalls === 0)) {
          stopReason = `stopped: the first 2 valid runs of arm B never called a kopt tool (kopt's telemetry is empty). The kopt tools are probably not visible, not allowed, or failing: check ${h.arms.get('B')!.agentPath} and the tool calls in ${join(h.out, 'runs', r.runId, 'stream.jsonl')}`;
          break;
        }
      }
      if (isFatal(r)) {
        stopReason = `stopped at the first ${r.errorKind} error (${r.runId}): ${r.errorDetail ?? ''}${r.errorKind === 'account_blocked' ? `\n${ACCOUNT_BLOCKED_ADVICE}` : ''}`;
        break;
      }
      consecutive = r.valid ? 0 : consecutive + 1;
      if (consecutive >= o.maxConsecutiveFailures) {
        stopReason = `stopped after ${consecutive} invalid runs in a row (last: ${r.invalidReason}: ${r.errorDetail ?? ''})`;
        break;
      }
    }
  } catch (err) {
    if (err instanceof Interrupted) {
      stopReason = 'interrupted (Ctrl-C or a termination signal); continue with --resume';
      try {
        finish('interrupted');
      } catch {
        // the report is best effort here
      }
    }
    throw err;
  }
  const status: CampaignResult['status'] = stopReason ? 'stopped' : 'completed';
  const { report, files } = finish(status);
  if (stopReason) h.log(stopReason);
  return { status, stopReason, records, spent: spentOf(), reportFiles: files, verdicts: report.comparisons.map((c) => c.verdict) };
}

export async function runCheck(o: AbOptions): Promise<PreflightResult & { smoke?: Awaited<ReturnType<typeof runSmoke>> }> {
  interrupted = false;
  const h = setupHarness(o);
  const release = acquireLock(h.out, 'check');
  try {
    // --smoke sends prompts: never to an account Kiro blocked during this campaign (until support restored it)
    if (o.smoke) guardBlockedAccount(h, o);
    await reapOrphans(h);
    const pre = await preflight(h, { forRun: false });
    if (!pre.ok || !o.smoke) return pre;
    if (o.maxCredits === undefined) {
      h.log('FAIL --smoke spends credits: pass --max-credits <N> too');
      return { ...pre, ok: false };
    }
    const prior = loadRecords(h.out);
    const smoke = await runSmoke(h, pre.smokeModel, budgetTotals(prior, h.out, o.creditsPerRun).counted);
    if (!smoke.ok) h.log(`smoke run failed:\n${smoke.diagnosis.join('\n')}`);
    return { ...pre, ok: smoke.ok, smoke };
  } finally {
    release();
  }
}

/** Rebuild the report from the run directories (optionally re-parsing the raw files). */
export function runReport(out: string, o: { reparse?: boolean; passRatio?: number; tasksFile?: string } = {}): { files: string[]; verdicts: string[]; notes: string[] } {
  const dir = resolve(out);
  const cfg = readJson<{ fingerprint?: { arms?: Arm[]; passRatio?: number; repo?: string; head?: string; model?: string; engine?: string; reps?: number }; options?: { creditsPerRun?: number }; kiroVersion?: string }>(join(dir, 'config.json'));
  if (!cfg) throw new AbError(`${dir} has no config.json: not a kopt bench ab output directory`);
  const lock = readJson<LockInfo>(join(dir, LOCK_FILE));
  if (lock && lock.host === hostname() && processAlive(lock.pid)) process.stderr.write(`kopt bench ab: note: a ${lock.what} (pid ${lock.pid}) is running in ${dir}; this report is a snapshot\n`);
  let records = loadRecords(dir);
  if (o.reparse) {
    const tasks = o.tasksFile ? loadAbTasks(resolve(o.tasksFile)) : undefined;
    const byId = new Map((tasks?.tasks ?? []).map((t) => [t.id, t]));
    const passRatio = o.passRatio ?? cfg.fingerprint?.passRatio ?? 0.6;
    records = records.map((r) => {
      const runDir = join(dir, r.smoke ? 'smoke' : 'runs', r.smoke ? r.arm : r.runId);
      const started = readJson<StartedMeta>(join(runDir, 'started.json'));
      if (!started) return r;
      const rebuilt = buildRecord(runDir, started, readJson<ExitInfo>(join(runDir, 'exit.json')), byId.get(r.task), passRatio);
      // without the task file, keep the grade computed at run time
      const merged = tasks ? rebuilt : { ...rebuilt, ...(r.grade ? { grade: r.grade } : {}) };
      writeJson(join(runDir, 'record.json'), merged);
      return merged;
    });
  }
  const arms = cfg.fingerprint?.arms ?? [...new Set(records.map((r) => r.arm))].sort();
  const meta = {
    repo: cfg.fingerprint?.repo,
    commit: cfg.fingerprint?.head,
    model: cfg.fingerprint?.model,
    engine: cfg.fingerprint?.engine,
    kiroVersion: cfg.kiroVersion ? `kiro-cli ${cfg.kiroVersion}` : undefined,
    reps: cfg.fingerprint?.reps,
    out: dir,
    budget: budgetTotals(records, dir, cfg.options?.creditsPerRun ?? 2),
    archivedAttempts: readArchived(dir).length,
  };
  const { report, files, notes } = writeReport(dir, records, arms, meta);
  return { files, verdicts: report.comparisons.map((c) => c.verdict), notes };
}

/**
 * Remove what a campaign keeps outside its results: the per-arm git worktrees, the arms' KIRO_HOMEs, the shared kopt
 * index, the V3 session folders of the worktrees under ~/.kiro/sessions, and a kopt index an earlier version of the
 * harness left in the user's kopt cache for a worktree. The results (runs/, smoke/, attempts/, reports) are kept.
 */
export function runClean(out: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const dir = resolve(out);
  const release = existsSync(dir) ? acquireLock(dir, 'clean') : () => {};
  try {
    const cfg = readJson<{ fingerprint?: { repo?: string } }>(join(dir, 'config.json'));
    const removed: string[] = [];
    const armsDir = join(dir, 'arms');
    const homes = userHomesOf(env);
    // the user's own kopt cache, as kopt computes it without the harness's KOPT_CACHE_DIR
    const userCache = cacheRoot({ env: { ...env, KOPT_CACHE_DIR: undefined }, home: homes[0] });
    const rm = (p: string) => {
      if (!existsSync(p)) return;
      rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      removed.push(p);
    };
    if (existsSync(armsDir)) {
      for (const arm of readdirSync(armsDir)) {
        const wt = join(armsDir, arm, 'repo');
        if (existsSync(wt)) {
          const real = realOr(wt);
          for (const d of worktreeSessionDirs({ kiroHome: join(armsDir, arm, 'kiro-home'), userHomes: homes, wt, wtReal: real })) rm(d);
          rm(join(userCache, repoCacheKey(wt)));
          let repoRoot = cfg?.fingerprint?.repo;
          if (!repoRoot) {
            try {
              repoRoot = dirname(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], wt).trim());
            } catch {
              repoRoot = undefined;
            }
          }
          if (repoRoot) removeWorktree(repoRoot, wt);
          else rmSync(wt, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
          removed.push(wt);
        }
        rm(join(armsDir, arm, 'kiro-home'));
        rm(join(armsDir, arm, 'baseline'));
        rm(join(armsDir, arm, 'prepared.json'));
      }
    }
    rm(join(dir, 'kopt-cache'));
    return removed;
  } finally {
    release();
  }
}
