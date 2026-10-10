// End-to-end tests of `kopt bench ab` against the kiro-cli simulator (bench/ab/fake-kiro-cli.mjs): whole campaigns on
// both engines, isolation, budget cap, smoke failure, invalid runs, timeouts, resume after a kill, report rebuild.
// The simulator runs the real kopt hooks and MCP server, so kopt's telemetry is real. Paths contain spaces on
// purpose. No Kiro account, no network.

import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cacheRoot } from '../src/core/config.js';
import { parseAbArgs, runAbCli } from '../src/bench/ab/cli.js';
import { parseStream } from '../src/bench/ab/parse.js';
import { makePlan } from '../src/bench/ab/plan.js';
import { readCsv } from '../src/bench/ab/report.js';
import { defaultOptions, runCampaign, runCheck, runClean, runReport, type AbOptions } from '../src/bench/ab/runner.js';
import type { PlanItem, RunRecord } from '../src/bench/ab/types.js';
import { rmTree } from './helpers/fs.js';

const ROOT = resolve(__dirname, '..');
const SIM = join(ROOT, 'bench', 'ab', 'fake-kiro-cli.mjs');
const BUILT = existsSync(join(ROOT, 'dist', 'bin.js'));
const tmp = mkdtempSync(join(tmpdir(), 'kopt ab e2e '));
afterAll(() => rmTree(tmp));

let n = 0;
function fixture(over: { kiroSteering?: boolean; repoMcp?: boolean; koptConfig?: boolean } = {}) {
  const base = join(tmp, `case ${++n}`);
  const repo = join(base, 'my repo');
  mkdirSync(join(repo, 'src', 'billing'), { recursive: true });
  mkdirSync(join(repo, 'src', 'orders'), { recursive: true });
  writeFileSync(
    join(repo, 'src', 'billing', 'refunds.py'),
    'class RefundPolicy:\n    def limit(self):\n        return 100\n\n\ndef compute_refund(order, policy):\n    """Compute the refund amount of an order."""\n    return min(order.total, policy.limit())\n',
  );
  writeFileSync(join(repo, 'src', 'orders', 'service.py'), 'from billing.refunds import compute_refund, RefundPolicy\n\n\nclass OrderService:\n    def cancel_order(self, order):\n        return compute_refund(order, RefundPolicy())\n');
  if (over.kiroSteering) {
    mkdirSync(join(repo, '.kiro', 'steering'), { recursive: true });
    writeFileSync(join(repo, '.kiro', 'steering', 'kopt.md'), 'Use kopt_find first.\n');
  }
  if (over.repoMcp) {
    // a server of the repository that cannot start (it would need a token): --require-mcp-startup would fail on it
    mkdirSync(join(repo, '.kiro', 'settings'), { recursive: true });
    writeFileSync(join(repo, '.kiro', 'settings', 'mcp.json'), JSON.stringify({ mcpServers: { 'needs-token': { command: process.execPath, args: ['-e', 'process.exit(1)'] } } }));
  }
  if (over.koptConfig) writeFileSync(join(repo, 'kopt.config.json'), JSON.stringify({ telemetry: { enabled: false }, dataDir: '.kopt-data' }));
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...a], { cwd: repo, stdio: 'ignore' });
  git('init', '-q');
  // the harness creates and restores worktrees with git: keep files LF whatever the machine's core.autocrlf
  git('config', 'core.autocrlf', 'false');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  const tasks = join(base, 'my tasks.json');
  writeFileSync(
    tasks,
    JSON.stringify({
      tasks: [
        { id: 'refund-amount', kind: 'locate', prompt: 'Where is the refund amount computed (compute_refund) and what limits it?', gold: { files: ['src/billing/refunds.py'], symbols: ['compute_refund', 'RefundPolicy'] } },
        { id: 'cancel-flow', kind: 'usage', prompt: 'What does OrderService.cancel_order call to compute the refund?', gold: { files: ['src/orders/service.py'], symbols: ['cancel_order', 'compute_refund'] } },
      ],
    }),
  );
  const home = join(base, 'home dir');
  mkdirSync(home, { recursive: true });
  return { base, repo, tasks, home, out: join(base, 'out dir'), state: join(base, 'sim state') };
}

type Fx = ReturnType<typeof fixture>;

function simEnv(fx: Fx, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(KIRO_API_KEY|KIRO_HOME|FAKE_KIRO_.*)$/i.test(k)) env[k] = v;
  return { ...env, HOME: fx.home, USERPROFILE: fx.home, KIRO_CLI: SIM, FAKE_KIRO_STATE_DIR: fx.state, ...extra };
}

/**
 * Options of a campaign against the simulator. The smoke run and the model list are opt-in (--smoke, --list-models);
 * most tests turn both on to cover them, `defaults()` keeps the shipped defaults.
 */
function options(fx: Fx, over: Partial<AbOptions> = {}, extraEnv: Record<string, string> = {}): AbOptions & { logs: string[] } {
  return defaults(fx, { smoke: true, listModels: true, ...over }, extraEnv);
}

function defaults(fx: Fx, over: Partial<AbOptions> = {}, extraEnv: Record<string, string> = {}): AbOptions & { logs: string[] } {
  const logs: string[] = [];
  return {
    ...defaultOptions({ repo: fx.repo, tasksFile: fx.tasks, out: fx.out, maxCredits: 100, reps: 1, env: simEnv(fx, extraEnv), log: (m) => logs.push(m), ...over }),
    logs,
  };
}

function calls(fx: Fx): Array<{ argv: string[]; cwd: string; env: Record<string, string | undefined> }> {
  const p = join(fx.state, 'calls.jsonl');
  return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
}

const chatRuns = (fx: Fx) => calls(fx).filter((c) => c.argv[0] === 'chat' && c.argv.includes('--no-interactive'));
const runs = (rs: RunRecord[]) => rs.filter((r) => !r.smoke);

/** Real path, case-folded on Windows (a child's cwd comes back resolved: /private/var vs /var on macOS). */
function canonical(p: string): string {
  const r = realpathSync.native(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

function gitStatus(dir: string): string {
  return execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: dir, encoding: 'utf8' });
}

/** The kopt cache kopt would use for this HOME without the harness's KOPT_CACHE_DIR. */
const userCache = (fx: Fx) => cacheRoot({ env: {}, home: fx.home });

/** Seed whose plan starts with `arm` for the first task. */
function seedStartingWith(arm: 'A' | 'B', tasks: string[]): number {
  for (let seed = 1; seed < 200; seed++) if (makePlan(tasks, ['A', 'B'], 1, seed)[0].arm === arm) return seed;
  throw new Error('no seed');
}

const archived = (fx: Fx) =>
  existsSync(join(fx.out, 'aborted.jsonl'))
    ? readFileSync(join(fx.out, 'aborted.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { runId: string; credits: number; measured: boolean; reason: string; errorKind?: string; archivedTo?: string })
    : [];

const waitFor = async (cond: () => boolean, ms: number) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return cond();
};

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!BUILT)('kopt bench ab with the kiro-cli simulator', () => {
  it('V2: a whole campaign, isolated arms, kopt usage proven, report written', async () => {
    const fx = fixture();
    const o = options(fx, { reps: 2 });
    const res = await runCampaign(o);
    expect(res.status, o.logs.join('\n')).toBe('completed');
    expect(res.records.filter((r) => r.smoke).map((r) => r.arm)).toEqual(['A', 'B']);
    const rs = runs(res.records);
    expect(rs).toHaveLength(8);
    for (const r of rs) {
      expect(r.valid, `${r.runId}: ${r.invalidReason} ${r.errorDetail}`).toBe(true);
      expect(r.creditsSource).toBe('session');
      expect(r.creditsStream).toBeCloseTo(r.creditsSession!, 3);
      expect(r.grade).toBeDefined();
    }
    for (const r of rs.filter((x) => x.arm === 'B')) {
      expect(r.koptCallsTelemetry).toBeGreaterThanOrEqual(1);
      expect(r.koptCallsStream).toBeGreaterThanOrEqual(1);
      expect(r.koptHookEvents).toBeGreaterThan(0);
      expect(r.koptFlag).toBeUndefined();
    }
    for (const r of rs.filter((x) => x.arm === 'A')) expect([r.koptCalls, r.koptCallsTelemetry, r.koptHookEvents]).toEqual([0, 0, 0]);

    // isolation: HOME untouched, one KIRO_HOME per arm, one KOPT_HOME per run, whoami before any chat
    const all = calls(fx);
    const chats = chatRuns(fx);
    expect(chats).toHaveLength(10);
    expect(all.findIndex((c) => c.argv[0] === 'whoami')).toBeLessThan(all.findIndex((c) => c.argv[0] === 'chat'));
    for (const c of chats) {
      const arm = c.argv[c.argv.indexOf('--agent') + 1].slice(-1).toUpperCase();
      expect(c.env.HOME).toBe(fx.home);
      expect(c.env.KIRO_HOME).toBe(join(fx.out, 'arms', arm, 'kiro-home'));
      expect(c.env.KOPT_HOME!.startsWith(join(fx.out, 'runs')) || c.env.KOPT_HOME!.startsWith(join(fx.out, 'smoke'))).toBe(true);
      expect(c.env.KOPT_HOME).toMatch(/kopt-home$/);
      expect(canonical(c.cwd)).toBe(canonical(join(fx.out, 'arms', arm, 'repo')));
      expect(c.argv).toEqual(expect.arrayContaining(['--no-interactive', '--agent-engine', 'v2', '--output-format', 'stream-json']));
      // telemetry forced on (the proof of kopt usage), a fixed index location, no self-update mid-campaign
      expect(c.env.KOPT_TELEMETRY).toBe('1');
      expect(c.env.KOPT_DATA_DIR!.startsWith(join(fx.out, 'kopt-cache'))).toBe(true);
      expect(c.env.KIRO_NO_AUTO_UPDATE).toBe('1');
    }
    expect(new Set(chats.map((c) => c.env.KOPT_HOME)).size).toBe(10);
    expect(existsSync(join(fx.home, '.kiro'))).toBe(false);
    // (5) nothing was indexed into the user's own kopt cache (the preflight's MCP check included)
    expect(existsSync(userCache(fx))).toBe(false);
    for (const arm of ['A', 'B']) expect(JSON.parse(readFileSync(join(fx.out, 'arms', arm, 'kiro-home', 'settings', 'cli.json'), 'utf8'))).toMatchObject({ 'app.disableAutoupdates': true });
    // (2) the smoke runs made one tool call each, completed, and arm B's went through kopt
    const smokeB = parseStream(readFileSync(join(fx.out, 'smoke', 'B', 'stream.jsonl'), 'utf8')).toolCalls;
    expect(smokeB.map((t) => [t.title, t.status])).toEqual([['@kopt/kopt_read', 'completed']]);
    expect(res.records.find((r) => r.smoke && r.arm === 'B')!.koptCallsTelemetry).toBe(1);
    expect(parseStream(readFileSync(join(fx.out, 'smoke', 'A', 'stream.jsonl'), 'utf8')).toolCalls.map((t) => t.status)).toEqual(['completed']);
    // (18) the report counts what the console counts
    expect(JSON.parse(readFileSync(join(fx.out, 'report.json'), 'utf8')).budget.counted).toBeCloseTo(res.spent, 6);

    // counterbalanced order, clean worktrees, report files
    const plan = JSON.parse(readFileSync(join(fx.out, 'plan.json'), 'utf8')) as PlanItem[];
    expect(plan.filter((p) => p.order === 0).map((p) => p.arm).sort()).toEqual(['A', 'A', 'B', 'B']);
    // each worktree is back to its prepared state: the arm's agent only (A), kopt's workspace files (B)
    expect(gitStatus(join(fx.out, 'arms', 'A', 'repo'))).toBe('?? .kiro/agents/abarm-a.json\n');
    expect(gitStatus(join(fx.out, 'arms', 'B', 'repo'))).toContain('.kiro/steering/kopt.md');
    const md = readFileSync(join(fx.out, 'report.md'), 'utf8');
    expect(md).toContain('## Arm B vs arm A');
    expect(md).toMatch(/\| all valid runs \| 4 \| 2 \|/);
    const csv = readCsv(readFileSync(join(fx.out, 'runs.csv'), 'utf8'));
    expect(csv).toHaveLength(10);
    expect(csv.filter((r) => r.arm === 'B' && r.smoke === '0').every((r) => Number(r.kopt_calls) >= 1)).toBe(true);
    expect(JSON.parse(readFileSync(join(fx.out, 'report.json'), 'utf8')).comparisons[0].allRuns.pairs).toBe(4);
    expect(res.spent).toBeGreaterThan(0);

    // report rebuild keeps the human's manual grades; --reparse rebuilds records from the raw files
    const csvPath = join(fx.out, 'runs.csv');
    const lines = readFileSync(csvPath, 'utf8').split('\n');
    const header = lines[0].split(',');
    const gi = header.indexOf('manual_grade');
    const row = lines.findIndex((l) => l.startsWith(rs[0].runId + ','));
    const cells = lines[row].split(',');
    cells[gi] = '0';
    lines[row] = cells.join(',');
    writeFileSync(csvPath, lines.join('\n'));
    runReport(fx.out, { reparse: true, tasksFile: fx.tasks });
    const again = readCsv(readFileSync(csvPath, 'utf8'));
    expect(again.find((r) => r.run_id === rs[0].runId)!.manual_grade).toBe('0');
    expect(again.find((r) => r.run_id === rs[1].runId)!.manual_grade).toBe('');
    expect(JSON.parse(readFileSync(join(fx.out, 'runs', rs[0].runId, 'record.json'), 'utf8')).credits).toBe(rs[0].credits);
    const out: string[] = [];
    const fake = { write: (s: string) => out.push(s) } as unknown as NodeJS.WriteStream;
    expect(await runAbCli(['report', '--out', fx.out], fake)).toBe(0);
    expect(out.join('')).toMatch(/wrote .*report\.md/);

    // clean removes the worktrees, the arms' KIRO_HOMEs and the kopt index; keeps the results
    const removed = runClean(fx.out, simEnv(fx));
    expect(removed).toEqual(expect.arrayContaining([join(fx.out, 'arms', 'A', 'repo'), join(fx.out, 'arms', 'B', 'repo'), join(fx.out, 'arms', 'B', 'kiro-home'), join(fx.out, 'kopt-cache')]));
    expect(existsSync(join(fx.out, 'arms', 'A', 'repo'))).toBe(false);
    expect(existsSync(join(fx.out, 'kopt-cache'))).toBe(false);
    expect(existsSync(join(fx.out, 'report.md'))).toBe(true);
    expect(existsSync(join(fx.out, 'runs', rs[0].runId, 'record.json'))).toBe(true);
    expect(execFileSync('git', ['worktree', 'list'], { cwd: fx.repo, encoding: 'utf8' }).trim().split('\n')).toHaveLength(1);
  }, 300_000);

  it('V3 with arm C: sessions read from the home directory, stream and session agree, C has no hooks', async () => {
    const fx = fixture();
    const o = options(fx, { engine: 'v3', arms: ['A', 'B', 'C'] });
    const res = await runCampaign(o);
    expect(res.status, o.logs.join('\n')).toBe('completed');
    const rs = runs(res.records);
    expect(rs).toHaveLength(6);
    for (const r of rs) {
      expect(r.valid, `${r.runId}: ${r.invalidReason} ${r.errorDetail}`).toBe(true);
      expect(r.creditsSession).toBeCloseTo(r.creditsStream!, 4);
      expect(r.turns).toBe(1);
      expect(existsSync(join(fx.out, 'runs', r.runId, 'session', 'v3'))).toBe(true);
    }
    for (const r of rs.filter((x) => x.arm !== 'A')) expect(r.koptCallsTelemetry).toBeGreaterThanOrEqual(1);
    for (const r of rs.filter((x) => x.arm === 'C')) expect(r.koptHookEvents).toBe(0);
    for (const r of rs.filter((x) => x.arm === 'B')) expect(r.koptHookEvents).toBeGreaterThan(0);
    for (const r of rs.filter((x) => x.arm !== 'A')) expect(r.usedTools).toHaveProperty('mcp_kopt_kopt_find');
    // the V3 engine writes under the OS home: the harness copies, never deletes there
    expect(readdirSync(join(fx.home, '.kiro', 'sessions')).length).toBe(3);
    // C: MCP only, nothing else of kopt in its workspace
    expect(existsSync(join(fx.out, 'arms', 'C', 'repo', '.kiro', 'steering'))).toBe(false);
    expect(existsSync(join(fx.out, 'arms', 'C', 'repo', '.kiro', 'hooks'))).toBe(false);
    expect(readFileSync(join(fx.out, 'report.md'), 'utf8')).toContain('## Arm C vs arm A');
    // clean also removes the V3 session folders of the worktrees under the home directory
    runClean(fx.out, simEnv(fx));
    expect(readdirSync(join(fx.home, '.kiro', 'sessions'))).toEqual([]);
  }, 300_000);

  it('(1) the budget only starts a task block that fits in every arm: whole pairs, never above --max-credits', async () => {
    const fx = fixture();
    const o = options(fx, { reps: 2, maxCredits: 5.5, creditsPerRun: 1 }, { FAKE_KIRO_CREDITS: '1' });
    const res = await runCampaign(o);
    expect(res.status, o.logs.join('\n')).toBe('stopped');
    expect(res.stopReason).toMatch(/credit budget: .* in every arm would exceed --max-credits 5\.5/);
    expect(res.spent).toBeLessThanOrEqual(5.5);
    const rs = runs(res.records);
    expect(rs.length).toBeGreaterThanOrEqual(2);
    expect(rs.length).toBeLessThan(8);
    // no lone run: every task/rep block that started has both arms
    for (const r of rs) expect(rs.some((x) => x.task === r.task && x.rep === r.rep && x.arm !== r.arm)).toBe(true);
    expect(readFileSync(join(fx.out, 'report.md'), 'utf8')).toMatch(/counted against --max-credits/);
  }, 300_000);

  it('(1) a runaway run is killed live before a request that would cross the budget; the campaign stops at the budget', async () => {
    const fx = fixture();
    const seed = seedStartingWith('A', ['refund-amount']);
    // a run costs 8 (3 requests of ~2.67) where 2 were expected: after its 2nd request it is a runaway, and a 3rd
    // request would cross --max-credits 6
    const o = options(fx, { reps: 1, maxCredits: 6, creditsPerRun: 2, only: ['refund-amount'], seed }, { FAKE_KIRO_CREDITS: '8', FAKE_KIRO_REQUEST_MS: '600' });
    const res = await runCampaign(o);
    expect(res.status, o.logs.join('\n')).toBe('stopped');
    const killed = runs(res.records).find((r) => r.errorKind === 'budget_exceeded');
    expect(killed, o.logs.join('\n')).toBeDefined();
    expect(killed!.arm).toBe('A');
    expect(killed!.errorDetail).toMatch(/over 1\.5x the expected 2\) \+ about .* for a next request would exceed the limit of this run/);
    expect(killed!.credits).toBeLessThan(6);
    expect(res.spent).toBeLessThanOrEqual(6);
    // the other arm never started
    expect(runs(res.records).filter((r) => r.arm === 'B')).toEqual([]);
  }, 300_000);

  it('(1) --max-run-credits: a run is killed as soon as its metered credits reach it', async () => {
    const fx = fixture();
    const o = options(fx, { reps: 1, maxCredits: 100, maxRunCredits: 2, only: ['refund-amount'] }, { FAKE_KIRO_CREDITS: '8', FAKE_KIRO_REQUEST_MS: '600' });
    const res = await runCampaign(o);
    expect(res.status).toBe('stopped');
    const killed = runs(res.records).find((r) => r.errorKind === 'budget_exceeded')!;
    expect(killed.errorDetail).toMatch(/reached the limit of this run, 2 \(--max-run-credits\)/);
    // killed after the first request crossed 2: the next ones were never sent
    expect(killed.credits).toBeLessThan(8 * 0.7);
  }, 300_000);

  it('(1) a budget that cannot pay for the smoke runs plus one task in every arm fails the preflight, nothing spent', async () => {
    const fx = fixture();
    const o = options(fx, { maxCredits: 3, creditsPerRun: 2 });
    const res = await runCampaign(o);
    expect(res.status).toBe('preflight_failed');
    expect(o.logs.join('\n')).toMatch(/cannot pay for the smoke runs plus one task in every arm[\s\S]*First probe: --only <one task id> --reps 1 --model qwen3-coder-next --timeout 120/);
    expect(chatRuns(fx)).toEqual([]);
  }, 120_000);

  it('logged out: the preflight stops before any chat call (a chat call could start a browser login)', async () => {
    const fx = fixture();
    const o = options(fx, {}, { FAKE_KIRO_AUTH: 'none' });
    const res = await runCampaign(o);
    expect(res.status).toBe('preflight_failed');
    expect(o.logs.join('\n')).toMatch(/NOT logged in[\s\S]*kiro-cli login/);
    expect(calls(fx).filter((c) => c.argv[0] === 'chat')).toEqual([]);
    // logged out, the preflight runs one whoami and nothing else (no agent validate, no mcp list; the simulator logs
    // every command but --version)
    expect(calls(fx).map((c) => c.argv[0])).toEqual(['whoami']);
    expect(existsSync(join(fx.out, 'plan.json'))).toBe(false);
  }, 120_000);

  it('a login lost mid-campaign stops it before the next chat call', async () => {
    const fx = fixture();
    const o = options(fx, { reps: 2 }, { FAKE_KIRO_LOGOUT_AFTER: '3' });
    const res = await runCampaign(o);
    expect(res.status).toBe('stopped');
    expect(res.stopReason).toMatch(/no longer logged in/);
    expect(chatRuns(fx)).toHaveLength(3);
    expect(runs(res.records)).toHaveLength(1);
  }, 300_000);

  it('the control arm must be kopt-free: a committed kopt steering file fails the preflight', async () => {
    const fx = fixture({ kiroSteering: true });
    const r = await runCheck(options(fx));
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.id === 'control-kopt-free')).toMatchObject({ status: 'fail' });
  }, 120_000);

  it('(16, README) --check warns about kopt in ~/.kiro/steering on V2 and about gold that does not match HEAD', async () => {
    const fx = fixture();
    mkdirSync(join(fx.home, '.kiro', 'steering'), { recursive: true });
    writeFileSync(join(fx.home, '.kiro', 'steering', 'kopt.md'), 'Prefer kopt_find.\n');
    const tasks = JSON.parse(readFileSync(fx.tasks, 'utf8'));
    tasks.tasks[0].gold.files.push('src/billing/missing.py');
    tasks.tasks[0].gold.symbols.push('NoSuchSymbol');
    writeFileSync(fx.tasks, JSON.stringify(tasks));
    const r = await runCheck(options(fx));
    expect(r.checks.find((c) => c.id === 'v2-global-steering')).toMatchObject({ status: 'warn' });
    const gold = r.checks.find((c) => c.id === 'tasks-gold')!;
    expect(gold.status).toBe('warn');
    expect(gold.message).toMatch(/task refund-amount: file\(s\) not in the repository: src\/billing\/missing.py; task refund-amount: symbol\(s\) found nowhere in the code: NoSuchSymbol/);
    // (5) the check alone does not index into the user's kopt cache either
    expect(existsSync(userCache(fx))).toBe(false);
  }, 120_000);

  it('smoke failure: no credits in arm B aborts with a diagnosis before any planned run', async () => {
    const fx = fixture();
    const o = options(fx, {}, { FAKE_KIRO_MODE_FOR: 'abarm-b:no-credits' });
    const res = await runCampaign(o);
    expect(res.status).toBe('smoke_failed');
    expect(res.stopReason).toMatch(/no_credits/);
    expect(res.stopReason).toMatch(/credits: stream none, session none/);
    expect(runs(res.records)).toEqual([]);
    expect(existsSync(join(fx.out, 'runs'))).toBe(false);
    // the next attempt runs the smoke again (it never passed)
    const o2 = options(fx, { resume: true });
    const res2 = await runCampaign(o2);
    expect(res2.status, o2.logs.join('\n')).toBe('completed');
    expect(runs(res2.records)).toHaveLength(4);
  }, 300_000);

  it('invalid runs are kept and excluded; a quota error stops the campaign', async () => {
    const fx = fixture();
    // chat calls 1-2 = smoke; 3.. = planned runs
    const o = options(fx, { reps: 2 }, { FAKE_KIRO_MODE_AT: '4:no-credits;5:malformed,no-stream-credits;6:quota' });
    const res = await runCampaign(o);
    expect(res.status).toBe('stopped');
    expect(res.stopReason).toMatch(/quota/);
    const rs = runs(res.records);
    expect(rs).toHaveLength(4);
    expect(rs[1]).toMatchObject({ valid: false, invalidReason: 'no_credits' });
    expect(rs[2]).toMatchObject({ valid: true, creditsSource: 'session' });
    expect(rs[2].creditsStream).toBeUndefined();
    expect(rs[2].warnings.join(' ')).toMatch(/malformed/);
    expect(rs[3]).toMatchObject({ valid: false, invalidReason: 'quota' });
    const md = readFileSync(join(fx.out, 'report.md'), 'utf8');
    expect(md).toMatch(/2 invalid run\(s\), excluded from the comparison/);
    expect(chatRuns(fx)).toHaveLength(6);
  }, 300_000);

  it('arm B never reaching kopt stops the campaign after its first two runs', async () => {
    const fx = fixture();
    const o = options(fx, { reps: 2 }, { FAKE_KIRO_USE_KOPT: '0' });
    const res = await runCampaign(o);
    expect(res.status).toBe('stopped');
    expect(res.stopReason).toMatch(/never called a kopt tool/);
    expect(runs(res.records).filter((r) => r.arm === 'B')).toHaveLength(2);
    expect(runs(res.records).filter((r) => r.arm === 'B').every((r) => r.koptFlag)).toBe(true);
  }, 300_000);

  it('a hung run is killed at the timeout and the campaign goes on', async () => {
    const fx = fixture();
    const o = options(fx, { timeoutS: 10 }, { FAKE_KIRO_MODE_AT: '3:hang' });
    const res = await runCampaign(o);
    expect(res.status, o.logs.join('\n')).toBe('completed');
    const rs = runs(res.records);
    expect(rs[0]).toMatchObject({ valid: false, invalidReason: 'timeout', timedOut: true });
    expect(rs.slice(1).every((r) => r.valid)).toBe(true);
    // the killed simulator is gone
    const marker = readdirSync(fx.state).find((f) => f.startsWith('running-'));
    if (marker) {
      const pid = Number(marker.slice('running-'.length));
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    }
  }, 300_000);

  it('resume after the harness was killed mid-run: finished runs are kept, the killed one is re-run and counted', async () => {
    const fx = fixture();
    const env = simEnv(fx, { FAKE_KIRO_MODE_AT: '4:slow', FAKE_KIRO_DELAY_MS: '60000' });
    const args = ['--no-warnings', '--import', 'tsx', join(ROOT, 'src', 'cli.ts'), 'bench', 'ab', '--repo', fx.repo, '--tasks', fx.tasks, '--out', fx.out, '--max-credits', '100', '--reps', '1', '--smoke'];
    const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c));
    // wait until the 4th chat call (2nd planned run) is running
    const t0 = Date.now();
    let marker: string | undefined;
    while (Date.now() - t0 < 90_000) {
      marker = existsSync(fx.state) ? readdirSync(fx.state).find((f) => f.startsWith('running-') && readFileSync(join(fx.state, f), 'utf8') === '4') : undefined;
      if (marker) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(marker, stderr).toBeDefined();
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    child.kill('SIGINT');
    const code = await exited;
    if (process.platform !== 'win32') {
      expect(code).toBe(130);
      // (18) an interruption leaves an honest state and a report
      expect(JSON.parse(readFileSync(join(fx.out, 'state.json'), 'utf8')).status).toBe('interrupted');
      expect(existsSync(join(fx.out, 'report.md'))).toBe(true);
      expect(existsSync(join(fx.out, 'lock.json'))).toBe(false);
    }
    // Windows has no SIGINT for a child: the harness died at once and the simulator it started may still sleep
    const simPid = Number(marker!.slice('running-'.length));
    try {
      process.kill(simPid);
    } catch {
      // already gone (POSIX: the harness killed the process group)
    }
    const firstRun = JSON.parse(readFileSync(join(fx.out, 'plan.json'), 'utf8'))[0] as PlanItem;
    const killedRun = JSON.parse(readFileSync(join(fx.out, 'plan.json'), 'utf8'))[1] as PlanItem;
    const before = JSON.parse(readFileSync(join(fx.out, 'runs', firstRun.runId, 'record.json'), 'utf8')) as RunRecord;
    expect(existsSync(join(fx.out, 'runs', killedRun.runId, 'started.json'))).toBe(true);
    expect(existsSync(join(fx.out, 'runs', killedRun.runId, 'record.json'))).toBe(false);

    // without --resume the out dir is refused
    await expect(runCampaign(options(fx))).rejects.toThrow(/--resume/);
    // a different setting is refused on resume
    await expect(runCampaign(options(fx, { resume: true, reps: 2 }))).rejects.toThrow(/different settings \(reps\)/);
    const o = options(fx, { resume: true });
    const res = await runCampaign(o);
    expect(res.status, o.logs.join('\n')).toBe('completed');
    const rs = runs(res.records);
    expect(rs.map((r) => r.runId).sort()).toEqual((JSON.parse(readFileSync(join(fx.out, 'plan.json'), 'utf8')) as PlanItem[]).map((p) => p.runId).sort());
    expect(rs.find((r) => r.runId === firstRun.runId)!.startedAt).toBe(before.startedAt);
    const aborted = archived(fx);
    expect(aborted.map((a) => a.runId)).toEqual([killedRun.runId]);
    expect(aborted[0]).toMatchObject({ reason: 'aborted' });
    expect(existsSync(join(fx.out, aborted[0].archivedTo!, 'started.json'))).toBe(true);
    // the smoke passed in the first process: not run again
    expect(chatRuns(fx).filter((c) => c.argv.some((a) => /single word OK/.test(a)))).toHaveLength(2);
  }, 300_000);

  const harness = (fx: Fx, extra: Record<string, string>) =>
    spawn(process.execPath, ['--no-warnings', '--import', 'tsx', join(ROOT, 'src', 'cli.ts'), 'bench', 'ab', '--repo', fx.repo, '--tasks', fx.tasks, '--out', fx.out, '--max-credits', '100', '--reps', '1', '--smoke'], {
      cwd: ROOT,
      env: simEnv(fx, extra),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const markerOf = (fx: Fx, nth: string) => (existsSync(fx.state) ? readdirSync(fx.state).find((f) => f.startsWith('running-') && readFileSync(join(fx.state, f), 'utf8') === nth) : undefined);

  it.skipIf(process.platform === 'win32')('(6) a SIGKILLed harness: the kiro-cli it left finishes, its session is collected and billed at the measured credits', async () => {
    const fx = fixture();
    const child = harness(fx, { FAKE_KIRO_MODE_AT: '4:slow', FAKE_KIRO_DELAY_MS: '3000' });
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c));
    expect(await waitFor(() => !!markerOf(fx, '4'), 90_000), stderr).toBe(true);
    const simPid = Number(markerOf(fx, '4')!.slice('running-'.length));
    const exited = new Promise((r) => child.on('exit', r));
    child.kill('SIGKILL');
    await exited;
    // the orphan outlives the harness (its own process group) and finishes its run
    expect(await waitFor(() => !alive(simPid), 30_000)).toBe(true);
    const killedRun = (JSON.parse(readFileSync(join(fx.out, 'plan.json'), 'utf8')) as PlanItem[])[1];
    expect(JSON.parse(readFileSync(join(fx.out, 'runs', killedRun.runId, 'child.json'), 'utf8')).pid).toBe(simPid);
    const o = options(fx, { resume: true });
    const res = await runCampaign(o);
    expect(res.status, o.logs.join('\n')).toBe('completed');
    const a = archived(fx);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ runId: killedRun.runId, reason: 'aborted', measured: true });
    expect(a[0].credits).toBeGreaterThan(0);
    expect(readdirSync(join(fx.out, a[0].archivedTo!, 'session', 'v2')).some((f) => f.endsWith('.json'))).toBe(true);
    expect(res.spent).toBeGreaterThanOrEqual(a[0].credits);
  }, 300_000);

  it.skipIf(process.platform === 'win32')('(6) a SIGKILLed harness: a kiro-cli still running at --resume is stopped first and billed at the estimate', async () => {
    const fx = fixture();
    const child = harness(fx, { FAKE_KIRO_MODE_AT: '4:slow', FAKE_KIRO_DELAY_MS: '120000' });
    expect(await waitFor(() => !!markerOf(fx, '4'), 90_000)).toBe(true);
    const simPid = Number(markerOf(fx, '4')!.slice('running-'.length));
    const exited = new Promise((r) => child.on('exit', r));
    child.kill('SIGKILL');
    await exited;
    expect(alive(simPid)).toBe(true);
    const o = options(fx, { resume: true });
    const res = await runCampaign(o);
    expect(res.status, o.logs.join('\n')).toBe('completed');
    expect(alive(simPid)).toBe(false);
    expect(o.logs.join('\n')).toMatch(/from a previous harness process is still running: stopping it/);
    const a = archived(fx);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ reason: 'aborted', measured: false });
    expect(a[0].credits).toBeGreaterThan(0);
  }, 300_000);

  it('(7) --resume runs again a run that failed on quota; the failed attempt is archived and still counted', async () => {
    const fx = fixture();
    const o = options(fx, { reps: 1 }, { FAKE_KIRO_MODE_AT: '4:quota' });
    const res = await runCampaign(o);
    expect(res.status).toBe('stopped');
    expect(res.stopReason).toMatch(/quota/);
    const failed = runs(res.records).find((r) => r.errorKind === 'quota')!;
    const o2 = options(fx, { reps: 1, resume: true });
    const res2 = await runCampaign(o2);
    expect(res2.status, o2.logs.join('\n')).toBe('completed');
    const rs = runs(res2.records);
    expect(rs).toHaveLength(4);
    expect(rs.every((r) => r.valid)).toBe(true);
    expect(archived(fx)).toEqual([expect.objectContaining({ runId: failed.runId, reason: 'retried', errorKind: 'quota' })]);
    expect(o2.logs.join('\n')).toMatch(/failed with quota: archived, its .* credits still count, it runs again/);
  }, 300_000);

  it('(12, 13) a run that edits, deletes, stages and commits leaves the worktree exactly as prepared, HEAD included', async () => {
    const fx = fixture();
    const o = options(fx, { reps: 1 }, { FAKE_KIRO_MODE_FOR: 'abarm-a:dirty,commit' });
    const res = await runCampaign(o);
    expect(res.status, o.logs.join('\n')).toBe('completed');
    const wtA = join(fx.out, 'arms', 'A', 'repo');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.repo, encoding: 'utf8' }).trim();
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wtA, encoding: 'utf8' }).trim()).toBe(head);
    expect(gitStatus(wtA)).toBe('?? .kiro/agents/abarm-a.json\n');
    expect(readFileSync(join(wtA, 'src', 'billing', 'refunds.py'), 'utf8')).toBe(readFileSync(join(fx.repo, 'src', 'billing', 'refunds.py'), 'utf8'));
    expect(existsSync(join(wtA, 'src', 'orders', 'service.py'))).toBe(true);
    for (const r of runs(res.records).filter((x) => x.arm === 'A')) expect(r).toMatchObject({ dirtyAfter: true, headMoved: true });
    // a resume finds the worktree where it belongs
    const o2 = options(fx, { reps: 1, resume: true });
    expect((await runCampaign(o2)).status, o2.logs.join('\n')).toBe('completed');
  }, 300_000);

  it('(14, 21) MCP servers and a kopt.config.json committed in the repository: stripped, overridden, measured', async () => {
    const fx = fixture({ repoMcp: true, koptConfig: true });
    const o = options(fx, { reps: 1 });
    const res = await runCampaign(o);
    expect(res.status, o.logs.join('\n')).toBe('completed');
    expect(o.logs.join('\n')).toMatch(/arm B: the repository's .kiro\/settings\/mcp.json declares MCP server\(s\) needs-token: removed/);
    expect(o.logs.join('\n')).toMatch(/arm B: the repository commits kopt.config.json \(telemetry, dataDir\)[^\n]*overridden by the harness/);
    expect(Object.keys(JSON.parse(readFileSync(join(fx.out, 'arms', 'B', 'repo', '.kiro', 'settings', 'mcp.json'), 'utf8')).mcpServers)).toEqual(['kopt']);
    for (const r of runs(res.records).filter((x) => x.arm === 'B')) expect(r.koptCallsTelemetry).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(fx.out, 'arms', 'B', 'repo', '.kopt-data'))).toBe(false);
  }, 300_000);

  it('(2) the smoke run proves tool trust: a refused kopt call fails it before any planned run', async () => {
    const fx = fixture();
    const o = options(fx, {}, { FAKE_KIRO_MODE_FOR: 'abarm-b:deny-kopt' });
    const res = await runCampaign(o);
    expect(res.status).toBe('smoke_failed');
    expect(res.stopReason).toMatch(/tool_denied/);
    expect(res.stopReason).toMatch(/the kopt tool call did not complete \(@kopt\/kopt_read: failed permission_denied\)/);
    expect(runs(res.records)).toEqual([]);
  }, 300_000);

  it('(3) kopt calls that fail are not kopt usage: arm B is stopped after two runs without kopt telemetry', async () => {
    const fx = fixture();
    const o = options(fx, { reps: 2, smoke: false }, { FAKE_KIRO_MODE_FOR: 'abarm-b:fail-kopt' });
    const res = await runCampaign(o);
    expect(res.status).toBe('stopped');
    expect(res.stopReason).toMatch(/never called a kopt tool \(kopt's telemetry is empty\)/);
    const b = runs(res.records).filter((r) => r.arm === 'B');
    expect(b).toHaveLength(2);
    for (const r of b) expect(r).toMatchObject({ valid: true, koptCalls: 0, koptCallsFailed: 1 });
  }, 300_000);

  it('(15) kiro-cli updating itself mid-campaign stops it; --resume with another version is refused', async () => {
    const fx = fixture();
    const o = options(fx, { reps: 1 }, { FAKE_KIRO_VERSION_AFTER: '3:2.29.0' });
    const res = await runCampaign(o);
    expect(res.status).toBe('stopped');
    expect(res.stopReason).toMatch(/kiro-cli changed from 2\.28\.0 to 2\.29\.0/);
    expect(runs(res.records)).toHaveLength(1);
    await expect(runCampaign(options(fx, { reps: 1, resume: true }, { FAKE_KIRO_VERSION_AFTER: '3:2.29.0' }))).rejects.toThrow(/kiro-cli is 2\.29\.0 now, the campaign .* ran with 2\.28\.0/);
  }, 300_000);

  it('(22) a smoke run Kiro meters at 0 credits passes (the metering was parsed)', async () => {
    const fx = fixture();
    const o = options(fx, { reps: 1 }, { FAKE_KIRO_MODE_AT: '1:zero-credits;2:zero-credits' });
    const res = await runCampaign(o);
    expect(res.status, o.logs.join('\n')).toBe('completed');
    expect(o.logs.join('\n')).toMatch(/metered the smoke run at 0 credits/);
  }, 300_000);

  it('defaults: no smoke run and no model-list request; the preflight reads the login once, every run again', async () => {
    const fx = fixture();
    const o = defaults(fx, { reps: 1 });
    const res = await runCampaign(o);
    expect(res.status, o.logs.join('\n')).toBe('completed');
    expect(res.records.filter((r) => r.smoke)).toEqual([]);
    expect(existsSync(join(fx.out, 'smoke'))).toBe(false);
    const all = calls(fx);
    // no chat call but the planned runs: no --list-models, no smoke prompt
    expect(all.filter((c) => c.argv[0] === 'chat')).toEqual(chatRuns(fx));
    expect(chatRuns(fx)).toHaveLength(4);
    expect(chatRuns(fx).some((c) => c.argv.some((a) => /single word OK/.test(a)))).toBe(false);
    expect(all.filter((c) => c.argv[0] === 'whoami')).toHaveLength(1 + 4);
    expect(o.logs.join('\n')).toMatch(/no smoke run \(opt-in: --smoke\)/);
    expect(o.logs.join('\n')).toMatch(/model claude-sonnet-4\.5: not checked against your account's model list \(--list-models/);
    // --check alone sends no prompt either
    const fx2 = fixture();
    const r = await runCheck(defaults(fx2));
    expect(r.ok).toBe(true);
    expect(calls(fx2).filter((c) => c.argv[0] === 'chat')).toEqual([]);
    expect(calls(fx2).filter((c) => c.argv[0] === 'whoami')).toHaveLength(1);
  }, 300_000);

  it('an account Kiro blocked: the campaign stops at once, nothing billed, and nothing is sent again without --account-restored', async () => {
    const fx = fixture();
    const seed = seedStartingWith('A', ['refund-amount', 'cancel-flow']);
    const o = defaults(fx, { reps: 1, seed }, { FAKE_KIRO_MODE_AT: '1:suspended' });
    const res = await runCampaign(o);
    expect(res.status, o.logs.join('\n')).toBe('stopped');
    expect(res.stopReason).toMatch(/stopped at the first account_blocked error/);
    expect(res.stopReason).toMatch(/temporarily suspended/);
    expect(res.stopReason).toMatch(/Do not retry and do not resume[\s\S]*https:\/\/support\.aws\.amazon\.com\/#\/contacts\/kiro[\s\S]*--resume --account-restored/);
    const [blocked] = runs(res.records);
    expect(runs(res.records)).toHaveLength(1);
    expect(blocked).toMatchObject({ valid: false, errorKind: 'account_blocked', exitCode: 1, creditsSession: 0 });
    // the real 2.28 envelope (records wrapped in `data`) is parsed: session id and context from the metadata records
    expect(blocked.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(blocked.ctxPctMax).toBeCloseTo(3.588, 3);
    expect(res.spent).toBe(0);
    expect(chatRuns(fx)).toHaveLength(1);

    // --resume without --account-restored: refused before any kiro-cli call
    const before = calls(fx).length;
    await expect(runCampaign(defaults(fx, { reps: 1, seed, resume: true }))).rejects.toThrow(/the account was blocked[\s\S]*--account-restored/);
    await expect(runCheck(defaults(fx, { reps: 1, seed, smoke: true }))).rejects.toThrow(/the account was blocked/);
    expect(calls(fx)).toHaveLength(before);

    // once support restored it: the blocked run is archived (free) and run again
    const o2 = defaults(fx, { reps: 1, seed, resume: true, accountRestored: true });
    const res2 = await runCampaign(o2);
    expect(res2.status, o2.logs.join('\n')).toBe('completed');
    expect(runs(res2.records).every((r) => r.valid)).toBe(true);
    expect(archived(fx)).toEqual([expect.objectContaining({ runId: blocked.runId, reason: 'retried', errorKind: 'account_blocked', credits: 0 })]);
    expect(JSON.parse(readFileSync(join(fx.out, 'account-restored.json'), 'utf8')).runs).toEqual([blocked.runId]);
    // the acknowledged block does not stop a later resume
    const o3 = defaults(fx, { reps: 1, seed, resume: true });
    expect((await runCampaign(o3)).status, o3.logs.join('\n')).toBe('completed');
  }, 300_000);

  it('an account Kiro blocked during the smoke run: smoke_failed with the advice, 0 credits counted', async () => {
    const fx = fixture();
    const o = options(fx, {}, { FAKE_KIRO_MODE: 'suspended' });
    const res = await runCampaign(o);
    expect(res.status).toBe('smoke_failed');
    expect(res.stopReason).toMatch(/account_blocked[\s\S]*contact Kiro support/i);
    expect(res.spent).toBe(0);
    expect(chatRuns(fx)).toHaveLength(1);
  }, 300_000);

  it('(23) under the test runner, a kiro-cli that is not the simulator never receives a prompt', async () => {
    const fx = fixture();
    const copy = join(fx.base, 'kiro-cli-chat.mjs');
    copyFileSync(SIM, copy);
    const o = options(fx, { reps: 1 }, { KIRO_CLI: copy });
    await expect(runCampaign(o)).rejects.toThrow(/refusing to send a prompt with a real kiro-cli under the test runner/);
    expect(chatRuns(fx)).toEqual([]);
    expect(calls(fx).some((c) => c.argv.includes('--list-models'))).toBe(false);
  }, 120_000);
});

describe('kopt bench ab command line', () => {
  it('parses options and rejects unsafe or invalid ones', () => {
    const p = parseAbArgs(['--repo', '/r', '--tasks', 't.yaml', '--arms', 'a,b,c', '--engine', 'V3', '--max-credits', '12.5', '--setting', 'chat.enableKnowledge=false', '--no-smoke', '--tools', 'read,shell']);
    expect(p.sub).toBe('run');
    expect(p.o).toMatchObject({ arms: ['A', 'B', 'C'], engine: 'v3', maxCredits: 12.5, settings: { 'chat.enableKnowledge': false }, smoke: false, tools: ['read', 'shell'], model: 'claude-sonnet-4.5', reps: 2 });
    // the smoke run, the model list and --account-restored are opt-in; the old --no-* spellings still parse
    expect(parseAbArgs(['--repo', '/r']).o).toMatchObject({ smoke: false, listModels: false, accountRestored: false });
    expect(parseAbArgs(['--repo', '/r', '--smoke', '--list-models', '--account-restored']).o).toMatchObject({ smoke: true, listModels: true, accountRestored: true });
    expect(parseAbArgs(['--repo', '/r', '--no-list-models']).o.listModels).toBe(false);
    expect(() => parseAbArgs(['--list-models', '--no-list-models'])).toThrow(/exclusive/);
    expect(parseAbArgs(['--check']).sub).toBe('check');
    expect(parseAbArgs(['report', '--out', 'x']).sub).toBe('report');
    expect(() => parseAbArgs(['--arms', 'B'])).toThrow(/include A/);
    expect(() => parseAbArgs(['--arms', 'A'])).toThrow(/at least one kopt arm/);
    expect(() => parseAbArgs(['--engine', 'v1'])).toThrow(/v2 or v3/);
    expect(() => parseAbArgs(['--reps', '0'])).toThrow(/--reps/);
    expect(() => parseAbArgs(['--tools', 'web'])).toThrow(/unknown tag/);
    expect(() => parseAbArgs(['--smoke', '--no-smoke'])).toThrow(/exclusive/);
  });
  it('a real run requires --max-credits', async () => {
    const err: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string) => (err.push(String(s)), true)) as typeof process.stderr.write;
    try {
      expect(await runAbCli(['--repo', ROOT, '--tasks', join(ROOT, 'bench', 'ab', 'tasks.example.json')])).toBe(1);
    } finally {
      process.stderr.write = orig;
    }
    expect(err.join('')).toMatch(/--max-credits <N> is required/);
  });
});
