import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs helpers (no type declarations on purpose: they run with bare node)
import { buildPrompt, gradeAnswer, makePlan, parseRunDir, parseSessionTexts, parseStopCapture, parseStream, toCsv } from '../bench/ab/ab-lib.mjs';
// @ts-expect-error plain .mjs helpers
import { analyze, bootstrapCI, mean, readCsv, renderReport, signTest } from '../bench/ab/analyze.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'kopt-ab-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const task = {
  id: 't1',
  kind: 'usage',
  lang: 'en',
  question: 'Who calls compute_refund?',
  verifiedBy: 'fixture',
  gold: {
    files: ['src/orders/service.py'],
    symbols: [
      { name: 'cancel', file: 'src/orders/service.py', line: 3 },
      { name: 'refund_all', file: 'src/orders/service.py', line: 9 },
      { name: 'RefundJob', file: 'src/orders/service.py', line: 12 },
    ],
  },
};

describe('plan and prompt', () => {
  it('covers every (task, arm, rep) once, deterministic per seed, arm order varies', () => {
    const p = makePlan(['a', 'b', 'c', 'd'], ['A', 'B'], 3, 1);
    expect(p).toHaveLength(24);
    expect(new Set(p.map((x: any) => `${x.task}/${x.arm}/${x.rep}`)).size).toBe(24);
    expect(p.map((x: any) => x.idx)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    expect(makePlan(['a', 'b', 'c', 'd'], ['A', 'B'], 3, 1)).toEqual(p);
    const firstArms = new Set<string>();
    for (let i = 0; i < p.length; i += 2) firstArms.add(p[i].arm);
    expect(firstArms).toEqual(new Set(['A', 'B']));
  });

  it('builds the same prompt for every arm', () => {
    expect(buildPrompt(task)).toMatch(/^Who calls compute_refund\?\n\nAnswer in at most 12 lines\./);
  });
});

describe('stream and session parsing', () => {
  it('V2 stream: sums meteringUsage credits, keeps max context %', () => {
    const lines = [
      JSON.stringify({ type: 'assistant_response', text: 'Hello ' }),
      JSON.stringify({ type: 'metadata', meteringUsage: [{ value: 0.0387, unit: 'credit' }], turnDurationMs: 2215, contextUsagePercentage: 12.5 }),
      'not json',
      JSON.stringify({ type: 'metadata', meteringUsage: [{ value: 0.5, unit: 'credit' }, { value: 3, unit: 'token' }], contextUsagePercentage: 30 }),
    ].join('\n');
    const r = parseStream(lines);
    expect(r.v2Credits).toBeCloseTo(0.5387);
    expect(r.v2MeteringEvents).toBe(2);
    expect(r.contextPctMax).toBe(30);
    expect(r.turnDurationMs).toBe(2215);
    expect(r.badLines).toBe(1);
    expect(r.answer).toBe('Hello ');
    expect(r.answerSource).toBe('stream:generic');
  });

  it('V3 stream: agent message chunks, tool calls, last promptTurnSummaries', () => {
    const upd = (update: object) => JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update } });
    const lines = [
      upd({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'grep', kind: 'search' }),
      upd({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', content: [{ type: 'content', content: { type: 'text', text: 'TOOL OUTPUT' } }] }),
      upd({ sessionUpdate: 'tool_call', toolCallId: 'c2', title: 'kopt_find' }),
      upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'cancel calls ' } }),
      upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'compute_refund.' } }),
      JSON.stringify({ method: 'session_info_update', params: { _meta: { kiro: { promptTurnSummaries: [{ unit: 'credit', usage: 0.3 }] } } } }),
      JSON.stringify({ method: 'session_info_update', params: { _meta: { kiro: { promptTurnSummaries: [{ unit: 'credit', usage: 0.5506, usedTools: ['read_file'] }] } } } }),
    ].join('\n');
    const r = parseStream(lines);
    expect(r.answer).toBe('cancel calls compute_refund.');
    expect(r.answerSource).toBe('stream:agent_message_chunk');
    expect(r.toolCalls).toBe(2);
    expect(r.toolNames).toEqual({ grep: 1, kopt_find: 1 });
    expect(r.v3Credits).toBeCloseTo(0.5506);
  });

  it('V2 sidecar: per-request metering summed over user turns', () => {
    const sidecar = JSON.stringify({
      session_id: 'x',
      user_turn_metadatas: [
        { metering_usage: [{ value: 0.026, unit: 'credit' }, { value: 0.077, unit: 'credit' }], total_request_count: 2, builtin_tool_uses: 3, context_usage_percentage: 8.1, turn_duration: { secs: 12, nanos: 0 } },
        { metering_usage: [{ value: 0.1, unit: 'credit' }], total_request_count: 1, builtin_tool_uses: 0, context_usage_percentage: 9.4 },
      ],
    });
    const r = parseSessionTexts([sidecar]);
    expect(r.credits).toBeCloseTo(0.203);
    expect(r).toMatchObject({ requests: 3, builtinToolUses: 3, contextPctMax: 9.4, turnDurationS: 12, source: 'sidecar:user_turn_metadatas' });
    const v3 = parseSessionTexts(['{"type":"usage_summary","promptTurnSummaries":[{"usage":1.25,"unit":"credit"}]}\n{"other":1}']);
    expect(v3).toMatchObject({ credits: 1.25, source: 'session:promptTurnSummaries' });
    expect(parseSessionTexts(['garbage']).credits).toBeUndefined();
  });

  it('stop hook capture', () => {
    expect(parseStopCapture(JSON.stringify({ hook_event_name: 'stop', assistant_response: 'final answer' }))).toBe('final answer');
    expect(parseStopCapture('')).toBe('');
  });
});

describe('grading', () => {
  it('pass = at least ceil(0.6 n) gold symbol names, whole identifiers', () => {
    expect(gradeAnswer('cancel and refund_all in src/orders/service.py', task)).toMatchObject({ total: 3, mentioned: 2, pass: true, filesMentioned: 1 });
    expect(gradeAnswer('cancel only', task)).toMatchObject({ mentioned: 1, pass: false });
    expect(gradeAnswer('cancel_all refund_allx RefundJobs', task)).toMatchObject({ mentioned: 0, pass: false });
    expect(gradeAnswer('', task).pass).toBe(false);
    expect(gradeAnswer('cancel refund_all', task, 1).pass).toBe(false);
  });
});

function row(taskId: string, arm: string, rep: number, credits: number, pass: boolean) {
  return { task: taskId, kind: 'locate', arm, rep: String(rep), credits: String(credits), pass: pass ? '1' : '0', exit_code: '0', requests: '3', tool_calls: '4', wall_s: '30' };
}

describe('analysis', () => {
  it('bootstrap CI and sign test', () => {
    const xs = [-1, -2, -3, -4, -5, -0.5];
    const [lo, hi] = bootstrapCI(xs, mean, 2000, 3);
    expect(lo).toBeLessThan(mean(xs));
    expect(hi).toBeGreaterThan(mean(xs));
    expect(hi).toBeLessThan(0);
    expect(bootstrapCI([1], mean)).toEqual([undefined, undefined]);
    expect(signTest(5, 5)).toBeCloseTo(0.0625);
    expect(signTest(3, 6)).toBe(1);
  });

  it('pass-gates the paired comparison and only claims a saving when the CI excludes 0', () => {
    const rows: any[] = [];
    for (let t = 1; t <= 6; t++) {
      for (let rep = 1; rep <= 3; rep++) {
        rows.push(row(`t${t}`, 'A', rep, 2 + rep * 0.1, true));
        rows.push(row(`t${t}`, 'B', rep, 1 + rep * 0.1, t !== 6)); // B fails t6
      }
    }
    // t7: both fail -> excluded
    rows.push(row('t7', 'A', 1, 5, false), row('t7', 'B', 1, 0.1, false));
    const res = analyze(rows, { boot: 2000 });
    expect(res.paired.tasks).toBe(5);
    expect(res.paired.medianDiff).toBeCloseTo(-1);
    expect(res.paired.meanDiffCI[1]).toBeLessThan(0);
    expect(res.paired.bCheaper).toBe(5);
    expect(res.summary[0]).toMatchObject({ arm: 'A', tasksPassed: 6 });
    expect(res.summary[1]).toMatchObject({ arm: 'B', tasksPassed: 5 });
    expect(res.claim).toBe(true); // 5 >= 6 - 1
    expect(renderReport(res)).toContain('**Verdict: B uses fewer credits than A');

    // two more failures for B: success no longer non-inferior -> no claim even though cheaper
    const worse = rows.map((r) => (r.arm === 'B' && (r.task === 't4' || r.task === 't5') ? { ...r, pass: '0' } : r));
    const res2 = analyze(worse, { boot: 2000 });
    expect(res2.claim).toBe(false);
    expect(renderReport(res2)).toContain('no saving can be claimed');
  });

  it('flags tasks answerable from memory (arm M) and can exclude them', () => {
    const rows = [
      row('t1', 'A', 1, 2, true), row('t1', 'B', 1, 1, true), row('t1', 'M', 1, 0.2, true),
      row('t2', 'A', 1, 2, true), row('t2', 'B', 1, 1, true), row('t2', 'M', 1, 0.2, false),
    ];
    const res = analyze(rows, { boot: 500 });
    expect(res.memorized).toEqual(['t1']);
    expect(res.paired.tasks).toBe(2);
    expect(analyze(rows, { boot: 500, excludeMemorized: true }).paired.tasks).toBe(1);
  });

  it('CSV round trip', () => {
    const dir = join(tmp, 'runs', 't1', 'B-1');
    mkdirSync(join(dir, 'home', '.kiro', 'sessions', 'cli'), { recursive: true });
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ task: 't1', arm: 'B', rep: 1, idx: 3, model: 'm', start: 100, end: 130 }));
    writeFileSync(join(dir, 'exit_code'), '0\n');
    writeFileSync(join(dir, 'stream.jsonl'), JSON.stringify({ type: 'metadata', meteringUsage: [{ value: 9, unit: 'credit' }] }) + '\n');
    writeFileSync(join(dir, 'stop-hook.json'), JSON.stringify({ assistant_response: 'cancel, refund_all, "RefundJob"' }));
    writeFileSync(join(dir, 'home', '.kiro', 'sessions', 'cli', 'x.json'), JSON.stringify({ user_turn_metadatas: [{ metering_usage: [{ value: 0.75, unit: 'credit' }], total_request_count: 4 }] }));
    const r = parseRunDir(dir, task);
    expect(r).toMatchObject({ arm: 'B', credits: 0.75, credits_source: 'sidecar:user_turn_metadatas', credits_stream_v2: 9, requests: 4, wall_s: 30, pass: 1, answer_source: 'stop-hook', exit_code: 0 });
    const back = readCsv(toCsv([r]));
    expect(back).toHaveLength(1);
    expect(back[0].answer_source).toBe('stop-hook');
    expect(back[0].credits).toBe('0.75');
  });
});

// Plumbing of the shell harness with stub kiro-cli / kopt binaries (the real kiro-cli is not available here).
const hasBash = spawnSync('bash', ['--version'], { stdio: 'ignore' }).status === 0;

// POSIX only: the stubs are shell scripts and PATH is joined with ':'
describe.skipIf(!hasBash || process.platform === 'win32')('run-kiro-cli-ab.sh with stubs', () => {
  it('runs the plan, isolates arms, parses and analyzes', () => {
    const base = join(tmp, 'sh');
    const repo = join(base, 'repo');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'a.py'), 'def cancel():\n    pass\n');
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo, stdio: 'ignore' });
    git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    const tasksFile = join(base, 'tasks.json');
    writeFileSync(
      tasksFile,
      JSON.stringify({
        repo: { name: 'stub' },
        tasks: [
          { id: 'easy', kind: 'locate', question: 'Where is cancel?', verifiedBy: 'x', gold: { files: ['src/a.py'], symbols: [{ name: 'cancel', file: 'src/a.py', line: 1 }] } },
          { id: 'hard', kind: 'usage', question: 'Who uses RefundJob?', verifiedBy: 'x', gold: { files: ['src/a.py'], symbols: [{ name: 'RefundJob', file: 'src/a.py', line: 1 }, { name: 'refund_all', file: 'src/a.py', line: 1 }] } },
        ],
      }),
    );
    const bin = join(base, 'bin');
    mkdirSync(bin, { recursive: true });
    const kiro = join(bin, 'kiro-cli');
    writeFileSync(
      kiro,
      `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "kiro-cli 0.0.0-stub"; exit 0; fi
agent=""; prev=""
for a in "$@"; do [ "$prev" = "--agent" ] && agent="$a"; prev="$a"; done
case "$agent" in
  kopt-ab-b) ans="cancel RefundJob refund_all"; credit=1.5; [ -f .kiro/steering/kopt.md ] || ans="NO STEERING" ;;
  kopt-ab-a) ans="cancel"; credit=2.0; [ -e .kiro/steering ] && ans="LEAK" ;;
  *) ans="?"; credit=0.1 ;;
esac
mkdir -p "$HOME/.kiro/sessions/cli"
printf '{"user_turn_metadatas":[{"metering_usage":[{"value":%s,"unit":"credit"}],"total_request_count":2}]}' "$credit" > "$HOME/.kiro/sessions/cli/s.json"
printf '{"assistant_response":"%s"}' "$ans" > "$KOPT_AB_RUN_DIR/stop-hook.json"
printf '{"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"%s"}}}}\\n' "$ans"
`,
    );
    const kopt = join(bin, 'kopt');
    writeFileSync(
      kopt,
      `#!/usr/bin/env bash
cmd="$1"; shift; root=""
while [ $# -gt 0 ]; do [ "$1" = "--root" ] && root="$2"; shift; done
if [ "$cmd" = init ]; then mkdir -p "$root/.kiro/steering" "$root/.kiro/settings"; echo "# kopt" > "$root/.kiro/steering/kopt.md"; echo '{}' > "$root/.kiro/settings/mcp.json"; fi
exit 0
`,
    );
    chmodSync(kiro, 0o755);
    chmodSync(kopt, 0o755);
    const out = join(base, 'out');
    const script = resolve('bench/ab/run-kiro-cli-ab.sh');
    const r = spawnSync('bash', [script, 'stub', 'stub-label'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        MODEL: 'stub-model',
        N: '2',
        ARMS: 'A B',
        KIRO_API_KEY: 'dummy',
        AB_TASKS: tasksFile,
        AB_SRC: repo,
        AB_OUT: out,
        AB_WORK: join(base, 'work'),
      },
      timeout: 60_000,
    });
    expect(r.status, r.stderr).toBe(0);
    const rows = readCsv(readFileSync(join(out, 'runs.csv'), 'utf8'));
    expect(rows).toHaveLength(8);
    for (const x of rows) {
      expect(x.credits_source).toBe('sidecar:user_turn_metadatas');
      expect(x.credits).toBe(x.arm === 'A' ? '2' : '1.5');
      expect(x.model).toBe('stub-model');
    }
    expect(rows.filter((x) => x.arm === 'A' && x.task === 'hard').every((x) => x.pass === '0')).toBe(true);
    expect(rows.filter((x) => x.arm === 'B').every((x) => x.pass === '1')).toBe(true);
    const report = readFileSync(join(out, 'report.md'), 'utf8');
    expect(report).toContain('Pass-gated paired comparison (1 tasks passed by both arms)');
    expect(existsSync(join(out, 'plan.tsv'))).toBe(true);
    // resumable: a second invocation does not re-run anything
    const again = spawnSync('bash', [script, 'stub', 'stub-label'], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MODEL: 'stub-model', N: '2', KIRO_API_KEY: 'dummy', AB_TASKS: tasksFile, AB_SRC: repo, AB_OUT: out, AB_WORK: join(base, 'work') } });
    expect(again.status, again.stderr).toBe(0);
    expect(again.stderr).not.toMatch(/\[\d+\/8\]/);
  });
});
