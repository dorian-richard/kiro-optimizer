// `kopt bench ab ...` command line.

import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { binPath } from '../../kiro/command.js';
import { AbError, DEFAULT_MODEL, defaultOptions, Interrupted, requestInterrupt, runCampaign, runCheck, runClean, runReport, type AbOptions } from './runner.js';
import { ACCOUNT_BLOCKED_ADVICE, ALL_ARMS, type Arm, type Engine } from './types.js';
import { TOOL_TAGS, type ToolTag } from './workspace.js';

export const AB_HELP = `kopt bench ab --repo <path> --tasks <file> --max-credits <N> [options]   run the A/B campaign
kopt bench ab --check --repo <path> [--tasks <file>] [options]          preflight only (no prompt, no credit)
kopt bench ab --check --smoke --max-credits <N> ...                     preflight + one tiny prompt per arm (opt-in)
kopt bench ab report --out <dir> [--reparse --tasks <file>]             rebuild report.md / runs.csv / report.json
kopt bench ab clean --out <dir>                                         remove worktrees, KIRO_HOMEs, kopt index

Measures real Kiro credits with headless kiro-cli on YOUR repository: arm A = stock Kiro (no kopt anywhere),
arm B = kopt installed (MCP server + hooks + steering), optional arm C = kopt MCP server only. Each run is a
fresh kiro-cli session in a per-arm git worktree with its own KIRO_HOME; your login (in your home directory)
is reused, nothing is ever logged in for you. Log in yourself (kiro-cli login) before --check, and read the
account-safety warning of the guide first: Kiro's anti-abuse checks can suspend an account that sends many
automated requests, logins or logouts in a short time (seen on a Free account). Guide: ${guidePath()}

  --repo <path>            git repository to test (default: current directory); arms use worktrees of HEAD
  --tasks <file>           tasks (.json or .yaml): id, prompt, optional kind and gold {files, symbols}
  --out <dir>              output directory (default: <repo>/../<name>-kopt-ab; must be outside the repo)
  --arms <list>            A,B (default) or A,B,C
  --reps <n>               repetitions per task and arm (default 2)
  --model <id>             pinned model for every run (default ${DEFAULT_MODEL}; not Auto)
  --smoke-model <id>       model of the smoke run (default: --model; with --list-models, the cheapest of the list)
  --effort <level>         reasoning effort passed to kiro-cli (optional)
  --engine v2|v3           kiro-cli agent engine (default v2: KIRO_HOME isolates all of its config;
                           v3 also reads ~/.kiro, which --check reports)
  --max-credits <n>        budget (required): a task block starts only when it fits in every arm; a run is killed
                           when its metered credits would cross it (V2 stream); one run can still overshoot it
  --max-run-credits <n>    kill a single run whose metered credits would reach n (optional)
  --credits-per-run <n>    cost guess before real runs are measured (default 2): set it from a probe run
  --timeout <s>            per-run wall-clock limit, the run is killed after it (default 600)
  --tools <tags>           built-in tool tags given to every arm: read (default), write, shell
  --pass-ratio <r>         grading threshold for gold symbols/files (default 0.6)
  --no-prompt-suffix       send the task prompts as they are (default: append a short "name the files" instruction)
  --setting <k=v>          Kiro CLI setting written to every arm's cli.json (repeatable), e.g. chat.enableKnowledge=false
  --only <ids>             comma list of task ids
  --seed <n>               plan order seed (default 42)
  --resume                 continue the campaign in --out: finished runs are kept; unfinished runs and runs that
                           failed on login, quota, throttling, the budget or (with a larger --timeout) a timeout
                           run again, their earlier credits still count
  --smoke                  smoke run: one tiny prompt per arm before the first real run (or with --check);
                           opt-in, default off; a campaign does not run it again once it passed in --out
  --max-consecutive-failures <n>  stop after n invalid runs in a row (default 3)
  --kiro-cli <path>        kiro-cli(-chat) executable (default: KIRO_CLI, then auto-detected)
  --node <path>            Node >= 22.13 used to run kopt (default: the Node running this command)
  --list-models            read your account's model list in the preflight (kiro-cli chat --list-models: one
                           request to Kiro) to check --model and pick the cheapest smoke model; default off
  --account-restored       continue (--resume) a campaign in which Kiro blocked the account, once Kiro support
                           has restored access; without it nothing is sent to that account again
  --index-timeout <s>      kopt index build limit per kopt arm (default 1800)
  --json                   print the result as JSON on stdout

Exit status: 0 done (check passed, campaign completed), 1 error or failed check / preflight / smoke run,
2 campaign stopped early (budget, fatal error, anomaly; resume with --resume), 130 interrupted.
`;

/** The A/B guide next to this installation (bench/ab/README.md ships with the package). */
function guidePath(): string {
  try {
    return join(dirname(dirname(binPath())), 'bench', 'ab', 'README.md');
  } catch {
    return 'bench/ab/README.md';
  }
}

function num(v: string | undefined, flag: string, o: { int?: boolean; min?: number } = {}): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || (o.int && !Number.isInteger(n)) || (o.min !== undefined && n < o.min)) throw new AbError(`${flag} must be a ${o.int ? 'whole ' : ''}number${o.min !== undefined ? ` >= ${o.min}` : ''}`);
  return n;
}

function settingValue(v: string): unknown {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

export function parseAbArgs(argv: string[]): { sub: 'run' | 'check' | 'report' | 'clean' | 'help'; o: AbOptions; json: boolean; reparse: boolean } {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      tasks: { type: 'string' },
      out: { type: 'string' },
      arms: { type: 'string' },
      reps: { type: 'string' },
      model: { type: 'string' },
      'smoke-model': { type: 'string' },
      effort: { type: 'string' },
      engine: { type: 'string' },
      'max-credits': { type: 'string' },
      'max-run-credits': { type: 'string' },
      'credits-per-run': { type: 'string' },
      timeout: { type: 'string' },
      tools: { type: 'string' },
      'pass-ratio': { type: 'string' },
      'no-prompt-suffix': { type: 'boolean' },
      setting: { type: 'string', multiple: true },
      only: { type: 'string' },
      seed: { type: 'string' },
      resume: { type: 'boolean' },
      smoke: { type: 'boolean' },
      'no-smoke': { type: 'boolean' }, // the default; kept for older command lines
      'max-consecutive-failures': { type: 'string' },
      'kiro-cli': { type: 'string' },
      node: { type: 'string' },
      'list-models': { type: 'boolean' },
      'no-list-models': { type: 'boolean' }, // the default; kept for older command lines
      'account-restored': { type: 'boolean' },
      'index-timeout': { type: 'string' },
      check: { type: 'boolean' },
      reparse: { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const first = positionals[0];
  if (positionals.length > 1 || (first && !['run', 'report', 'clean', 'check'].includes(first))) throw new AbError(`unknown argument ${positionals.find((p) => !['run', 'report', 'clean', 'check'].includes(p))}`);
  const sub = values.help ? 'help' : first === 'report' ? 'report' : first === 'clean' ? 'clean' : values.check || first === 'check' ? 'check' : 'run';
  const arms = (values.arms ?? 'A,B').split(/[\s,]+/).filter(Boolean).map((a) => a.toUpperCase()) as Arm[];
  for (const a of arms) if (!ALL_ARMS.includes(a)) throw new AbError(`--arms: unknown arm ${a} (A, B, C)`);
  if (new Set(arms).size !== arms.length) throw new AbError('--arms: duplicate arm');
  if (sub === 'run' || sub === 'check') {
    if (!arms.includes('A')) throw new AbError('--arms must include A (stock Kiro, the baseline)');
    if (arms.length < 2 && sub === 'run') throw new AbError('--arms needs A and at least one kopt arm (B or C)');
  }
  const engine = (values.engine ?? 'v2').toLowerCase();
  if (engine !== 'v2' && engine !== 'v3') throw new AbError('--engine must be v2 or v3 (stream-json is not available on v1)');
  const tools = (values.tools ?? 'read').split(/[\s,]+/).filter(Boolean) as ToolTag[];
  for (const t of tools) if (!TOOL_TAGS.includes(t)) throw new AbError(`--tools: unknown tag ${t} (read, write, shell)`);
  if (!tools.includes('read')) throw new AbError('--tools must include read');
  const settings: Record<string, unknown> = {};
  for (const s of values.setting ?? []) {
    const i = s.indexOf('=');
    if (i <= 0) throw new AbError(`--setting ${s}: expected key=value`);
    settings[s.slice(0, i).trim()] = settingValue(s.slice(i + 1).trim());
  }
  if (values.smoke && values['no-smoke']) throw new AbError('--smoke and --no-smoke are exclusive');
  if (values['list-models'] && values['no-list-models']) throw new AbError('--list-models and --no-list-models are exclusive');
  const passRatio = num(values['pass-ratio'], '--pass-ratio');
  if (passRatio !== undefined && !(passRatio > 0 && passRatio <= 1)) throw new AbError('--pass-ratio must be in (0, 1]');
  const model = values.model ?? DEFAULT_MODEL;
  const o = defaultOptions({
    repo: values.repo ?? process.cwd(),
    tasksFile: values.tasks,
    out: values.out,
    arms,
    reps: num(values.reps, '--reps', { int: true, min: 1 }) ?? 2,
    model,
    smokeModel: values['smoke-model'],
    effort: values.effort,
    engine: engine as Engine,
    maxCredits: num(values['max-credits'], '--max-credits', { min: 0 }),
    maxRunCredits: num(values['max-run-credits'], '--max-run-credits', { min: 0.0001 }),
    creditsPerRun: num(values['credits-per-run'], '--credits-per-run', { min: 0.0001 }) ?? 2,
    timeoutS: num(values.timeout, '--timeout', { min: 10 }) ?? 600,
    seed: num(values.seed, '--seed', { int: true }) ?? 42,
    resume: !!values.resume,
    smoke: !!values.smoke,
    tools,
    passRatio,
    ...(values['no-prompt-suffix'] ? { promptSuffix: '' } : {}),
    kiroCli: values['kiro-cli'],
    node: values.node,
    maxConsecutiveFailures: num(values['max-consecutive-failures'], '--max-consecutive-failures', { int: true, min: 1 }) ?? 3,
    settings,
    only: values.only ? values.only.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    listModels: !!values['list-models'],
    accountRestored: !!values['account-restored'],
    indexTimeoutS: num(values['index-timeout'], '--index-timeout', { min: 10 }) ?? 1800,
  });
  return { sub, o, json: !!values.json, reparse: !!values.reparse };
}

/** Returns the process exit code: 0 done, 1 error / failed check, 2 stopped early (cap or anomaly), 130 interrupted. */
export async function runAbCli(argv: string[], out: NodeJS.WriteStream = process.stdout): Promise<number> {
  let parsed: ReturnType<typeof parseAbArgs>;
  try {
    parsed = parseAbArgs(argv);
  } catch (err) {
    process.stderr.write(`kopt bench ab: ${(err as Error).message}\n\n${AB_HELP}`);
    return 1;
  }
  const { sub, o, json } = parsed;
  if (sub === 'help') {
    out.write(AB_HELP);
    return 0;
  }
  const onSignal = () => {
    process.stderr.write('\nkopt bench ab: interrupted, stopping the current run (resume with --resume)\n');
    requestInterrupt();
  };
  // a closed terminal (SIGHUP) or Ctrl-Break on Windows (SIGBREAK) must stop kiro-cli too: it runs in its own
  // process group and would otherwise keep spending credits after the harness is gone
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', ...(process.platform === 'win32' ? (['SIGBREAK'] as NodeJS.Signals[]) : (['SIGHUP'] as NodeJS.Signals[]))];
  for (const sig of signals) process.once(sig, onSignal);
  try {
    if (sub === 'report') {
      if (!o.out) throw new AbError('report needs --out <dir>');
      const r = runReport(o.out, { reparse: parsed.reparse, passRatio: o.passRatio, tasksFile: o.tasksFile });
      for (const n of r.notes) process.stderr.write(`kopt bench ab: WARN ${n}\n`);
      out.write(json ? JSON.stringify(r, null, 2) + '\n' : `${r.verdicts.map((v) => `- ${v}`).join('\n')}\n\n${r.files.map((f) => `wrote ${f}`).join('\n')}\n`);
      return 0;
    }
    if (sub === 'clean') {
      if (!o.out) throw new AbError('clean needs --out <dir>');
      const removed = runClean(o.out);
      out.write(json ? JSON.stringify({ removed }, null, 2) + '\n' : removed.length ? removed.map((r) => `removed ${r}`).join('\n') + '\n' : 'nothing to remove\n');
      return 0;
    }
    if (sub === 'check') {
      const r = await runCheck(o);
      if (json) out.write(JSON.stringify({ ok: r.ok, checks: r.checks, estimate: r.estimate, smokeModel: r.smokeModel, smoke: r.smoke ? { ok: r.smoke.ok, diagnosis: r.smoke.diagnosis } : undefined }, null, 2) + '\n');
      else out.write(r.ok ? `ready: ${r.checks.filter((c) => c.status === 'warn').length} warning(s)\n` : `not ready: ${r.checks.filter((c) => c.status === 'fail').length} failed check(s) (see above)${r.smoke && !r.smoke.ok ? ', smoke run failed' : ''}\n`);
      return r.ok ? 0 : 1;
    }
    if (o.maxCredits === undefined) throw new AbError('--max-credits <N> is required: it is the budget of this campaign');
    const r = await runCampaign(o);
    if (json) out.write(JSON.stringify({ status: r.status, stopReason: r.stopReason, spent: r.spent, runs: r.records.length, verdicts: r.verdicts, files: r.reportFiles }, null, 2) + '\n');
    else {
      if (r.status === 'preflight_failed') out.write('not started: the preflight failed (see above); no credit was spent\n');
      else if (r.status === 'smoke_failed') {
        const blocked = r.records.some((x) => x.errorKind === 'account_blocked');
        out.write(`not started: the smoke run failed (see above); ${r.spent.toFixed(3)} credits counted. ${blocked ? ACCOUNT_BLOCKED_ADVICE : 'Fix the cause, then run the same command with --resume'}\n`);
      }
      else out.write(`${r.status === 'completed' ? 'completed' : `stopped early: ${r.stopReason}`}; ${r.spent.toFixed(3)} credits counted (measured, plus estimates for unmeasured runs)\n${r.verdicts.map((v) => `- ${v}`).join('\n')}\n${r.reportFiles.map((f) => `wrote ${f}`).join('\n')}\n`);
    }
    return r.status === 'completed' ? 0 : r.status === 'stopped' ? 2 : 1;
  } catch (err) {
    if (err instanceof Interrupted) return 130;
    process.stderr.write(`kopt bench ab: ${(err as Error).message}\n`);
    if (process.env.KOPT_DEBUG && (err as Error).stack) process.stderr.write(`${(err as Error).stack}\n`);
    return 1;
  } finally {
    for (const sig of signals) process.removeListener(sig, onSignal);
  }
}
