// Unit tests of the online A/B harness (`kopt bench ab`): task files, plan, grading, stream / session / telemetry
// parsing, failure classification, statistics, report, kiro-cli output parsing, isolation helpers.
// End-to-end runs against the kiro-cli simulator are in bench-ab-e2e.test.ts.

import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/core/config.js';
import { which } from '../src/kiro/paths.js';
import { billed, budgetTotals, estimateFor, FREE_ERRORS } from '../src/bench/ab/budget.js';
import { gradeAnswer, mentionsFile, mentionsSymbol, needed } from '../src/bench/ab/grade.js';
import { cheapestModel, kiroCall, parseModelList, parseVersion, parseWhoami, startableUnderTests, validateOutputProblems, versionAtLeast } from '../src/bench/ab/kiro.js';
import { bucketCandidates, classifyRun, isDenied, isKoptCall, isKoptTitle, isKoptToolName, LiveMeter, parseSessionFiles, parseStream, parseTelemetry, stderrDenials, sumCredits, v3Bucket } from '../src/bench/ab/parse.js';
import { armOrder, makePlan } from '../src/bench/ab/plan.js';
import { launcherFor } from '../src/bench/ab/proc.js';
import { buildRecord, type StartedMeta } from '../src/bench/ab/record.js';
import { analyzeRuns, detectDelimiter, enoughEvidence, parseManualGrade, readCsv, renderReportMarkdown, toCsv, writeReport } from '../src/bench/ab/report.js';
import { acquireLock, isInsidePath, isSimulator, parseMcpList, userHomesOf } from '../src/bench/ab/runner.js';
import { clusterBootstrap, median, relativeDiff, signTest } from '../src/bench/ab/stats.js';
import { buildPrompt, loadAbTasks, normalizeTaskFile, parseTaskText, smokePrompt } from '../src/bench/ab/tasks.js';
import { FATAL_ERRORS, OWN_FAULT_ERRORS, RETRY_ON_RESUME, type RunRecord } from '../src/bench/ab/types.js';
import { agentConfig, armEnv, builtinTools, guardHead, hookPrefix, koptAgentHooks, parseStatus, restoreBaseline, snapshotBaseline, stripRepoMcpServers, trustList, userKiroInventory, worktreeHead } from '../src/bench/ab/workspace.js';
import { parseYaml } from '../src/bench/ab/yaml.js';
import { rmTree } from './helpers/fs.js';

const tmp = mkdtempSync(join(tmpdir(), 'kopt ab unit '));
afterAll(() => rmTree(tmp));
const ROOT = resolve(__dirname, '..');

describe('task files', () => {
  it('reads the YAML subset used by task files', () => {
    const doc = parseYaml(`# tasks for my repo
passRatio: 0.5
tasks:
  - id: refund-amount   # trailing comment
    kind: locate
    prompt: |
      Where is the refund amount computed?
      It must name "the file".
    gold:
      files: [src/billing/refunds.py, 'src/a b.py']
      symbols:
        - compute_refund
        - "RefundPolicy"
  - id: folded
    prompt: >-
      one
      two
    gold: {files: [x.py], symbols: []}
  - id: 7
    prompt: 'it''s quoted'
`);
    expect(doc).toEqual({
      passRatio: 0.5,
      tasks: [
        { id: 'refund-amount', kind: 'locate', prompt: 'Where is the refund amount computed?\nIt must name "the file".\n', gold: { files: ['src/billing/refunds.py', 'src/a b.py'], symbols: ['compute_refund', 'RefundPolicy'] } },
        { id: 'folded', prompt: 'one two', gold: { files: ['x.py'], symbols: [] } },
        { id: 7, prompt: "it's quoted" },
      ],
    });
  });

  it('rejects what it does not support, with a line number', () => {
    expect(() => parseYaml('a: &anchor 1\n')).toThrow(/line 1.*anchors/);
    expect(() => parseYaml('a:\n\t- x\n')).toThrow(/line 2.*tabs/);
    expect(() => parseYaml('a: 1\na: 2\n')).toThrow(/duplicate key/);
    expect(() => parseYaml('a: [1,\n  2]\n')).toThrow(/multi-line flow/);
    expect(() => parseYaml('a: 1\n---\nb: 2\n')).toThrow(/multi-document/);
  });

  it('normalizes and validates tasks (simple format, top-level list, offline bench format)', () => {
    const { file, problems } = normalizeTaskFile({ tasks: [{ id: 'a', prompt: ' Q? ', gold: { files: ['.\\src\\x.py'], symbols: ['f'] } }, { id: 'b', question: 'legacy?', gold: { files: [], symbols: [{ name: 'g', file: 'y', line: 1 }] } }] });
    expect(problems).toEqual([]);
    expect(file.tasks).toEqual([
      { id: 'a', prompt: 'Q?', gold: { files: ['src/x.py'], symbols: ['f'] } },
      { id: 'b', prompt: 'legacy?', gold: { files: [], symbols: ['g'] } },
    ]);
    expect(normalizeTaskFile([{ id: 'x', prompt: 'p' }]).problems).toEqual([]);
    const bad = normalizeTaskFile({ tasks: [{ id: 'a', prompt: 'p' }, { id: 'a', prompt: '' }, { prompt: 'p' }, { id: 'bad id!', prompt: 'p', gold: {} }] }).problems;
    expect(bad.join('\n')).toMatch(/task a: duplicate id/);
    expect(bad.join('\n')).toMatch(/"prompt" is required/);
    expect(bad.join('\n')).toMatch(/"id" is required/);
    expect(bad.join('\n')).toMatch(/id must be/);
    expect(bad.join('\n')).toMatch(/"gold" is empty/);
    expect(normalizeTaskFile({}).problems[0]).toMatch(/"tasks" list/);
  });

  it('loads the example task file and the offline benchmark task files unchanged', () => {
    const ex = loadAbTasks(join(ROOT, 'bench', 'ab', 'tasks.example.json'));
    expect(ex.tasks.length).toBeGreaterThanOrEqual(3);
    expect(ex.sha256).toMatch(/^[0-9a-f]{64}$/);
    const dj = loadAbTasks(join(ROOT, 'bench', 'tasks', 'django.json'));
    expect(dj.tasks[0].gold!.symbols.length).toBeGreaterThan(0);
    const yamlPath = join(tmp, 'tasks.yml');
    writeFileSync(yamlPath, 'tasks:\n  - id: t1\n    prompt: Where?\n');
    expect(loadAbTasks(yamlPath).tasks).toEqual([{ id: 't1', prompt: 'Where?' }]);
    writeFileSync(join(tmp, 'broken.json'), '{"tasks": [');
    expect(() => loadAbTasks(join(tmp, 'broken.json'))).toThrow(/invalid task file/);
    expect(parseTaskText('tasks: []', 'x.txt')).toEqual({ tasks: [] });
  });

  it('builds the same prompt for every arm', () => {
    expect(buildPrompt({ id: 'a', prompt: 'Where is X?' })).toMatch(/^Where is X\?\n\nDo not modify any file\./);
    expect(buildPrompt({ id: 'a', prompt: 'Where is X?' }, '')).toBe('Where is X?');
  });
});

describe('plan', () => {
  it('runs every (task, arm, rep) once, deterministically, in counterbalanced blocks', () => {
    const p = makePlan(['t1', 't2', 't3', 't4'], ['A', 'B'], 3, 1);
    expect(p).toHaveLength(24);
    expect(new Set(p.map((x) => x.runId)).size).toBe(24);
    expect(makePlan(['t1', 't2', 't3', 't4'], ['A', 'B'], 3, 1)).toEqual(p);
    expect(makePlan(['t1', 't2', 't3', 't4'], ['A', 'B'], 3, 2)).not.toEqual(p);
    // two arms: A B | B A | B A | A B ...: each arm first in exactly half of the blocks
    const firsts = p.filter((x) => x.order === 0).map((x) => x.arm);
    expect(firsts.filter((a) => a === 'A')).toHaveLength(6);
    expect(armOrder(['A', 'B'], 0)).toEqual(['A', 'B']);
    expect(armOrder(['A', 'B'], 1)).toEqual(['B', 'A']);
    expect(armOrder(['A', 'B'], 2)).toEqual(['B', 'A']);
    expect(armOrder(['A', 'B'], 3)).toEqual(['A', 'B']);
    // three arms: a Latin square over 6 blocks, each arm once in each position per cycle
    const pos = { A: [0, 0, 0], B: [0, 0, 0], C: [0, 0, 0] } as Record<string, number[]>;
    for (let k = 0; k < 6; k++) armOrder(['A', 'B', 'C'], k).forEach((a, i) => pos[a][i]++);
    expect(pos).toEqual({ A: [2, 2, 2], B: [2, 2, 2], C: [2, 2, 2] });
  });
});

describe('grading', () => {
  const gold = { files: ['src/billing/refunds.py', 'src/billing/orders.py'], symbols: ['compute_refund', 'RefundPolicy', 'cancel'] };
  it('counts whole identifiers and file paths (any slash direction) or file names', () => {
    expect(mentionsSymbol('calls compute_refund()', 'compute_refund')).toBe(true);
    expect(mentionsSymbol('calls compute_refunds', 'compute_refund')).toBe(false);
    expect(mentionsSymbol('$cancel', 'cancel')).toBe(false);
    expect(mentionsFile('see src\\billing\\refunds.py:12', 'src/billing/refunds.py')).toBe(true);
    expect(mentionsFile('in refunds.py', 'src/billing/refunds.py')).toBe(true);
    expect(mentionsFile('in old_refunds.py', 'src/billing/refunds.py')).toBe(false);
    expect(needed(3, 0.6)).toBe(2);
    expect(needed(2, 0.6)).toBe(2);
    expect(needed(5, 0.6)).toBe(3);
    expect(needed(0, 0.6)).toBe(0);
  });
  it('passes at ceil(0.6 n) of each gold list', () => {
    expect(gradeAnswer('compute_refund and RefundPolicy in src/billing/refunds.py and orders.py', gold)).toMatchObject({ pass: true, symbolsFound: 2, filesFound: 2, missingSymbols: ['cancel'] });
    expect(gradeAnswer('compute_refund, RefundPolicy, cancel in refunds.py', gold)).toMatchObject({ pass: false, filesFound: 1 });
    expect(gradeAnswer('', gold)!.pass).toBe(false);
    expect(gradeAnswer('anything', undefined)).toBeUndefined();
    expect(gradeAnswer('compute_refund in refunds.py', { files: ['src/billing/refunds.py'], symbols: [] })!.pass).toBe(true);
  });
});

// Reconstructed 2.28 stream-json (envelope keys inferred, inner ACP objects from the V3 engine source).
const upd = (u: object) => JSON.stringify({ type: 'sessionUpdate', sessionId: 'sess_1', update: u });
const info = (kiro: object) => upd({ sessionUpdate: 'session_info_update', _meta: { kiro } });
const V3_STREAM = [
  JSON.stringify({ type: 'runStarted', payloadSchema: 'acp', acpProtocolVersion: 1, sessionId: 'sess_1' }),
  info({ kind: 'turn_start', turnStart: true }),
  upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old turn ' }, _meta: { kiro: { replay: true } } }),
  upd({ sessionUpdate: 'tool_call', toolCallId: 't1', title: '@kopt/kopt_find', kind: 'other', status: 'pending' }),
  upd({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' }),
  upd({ sessionUpdate: 'tool_call', toolCallId: 't2', title: 'Reading billing/refunds.py', kind: 'read', status: 'pending' }),
  upd({ sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'completed' }),
  upd({ sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'completed' }),
  info({ kind: 'context_usage', contextUsage: { usagePercentage: 7.9 }, usagePercentage: 7.9 }),
  info({ kind: 'turn_completion', promptTurnSummaries: [{ unit: 'credit', unitPlural: 'credits', usage: 0.42, usedTools: ['mcp_kopt_kopt_find', 'read_file'] }], elapsedTime: 18342, status: 'success', requestIds: ['r1', 'r2'] }),
  info({ kind: 'turn_start', turnStart: true }),
  upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '`compute_refund` in ' } }),
  'not json at all',
  upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'billing/refunds.py' } }),
  info({ kind: 'turn_completion', promptTurnSummaries: [{ unit: 'credit', unitPlural: 'credits', usage: 0.3, usedTools: [] }, { unit: 'token', unitPlural: 'tokens', usage: 999 }], elapsedTime: 2000, status: 'success', requestIds: ['r3'] }),
  info({ kind: 'turn_end', turnEnd: { stopReason: 'end_turn' } }),
  JSON.stringify({ type: 'runFinished', sessionId: 'sess_1', finalText: '`compute_refund` in billing/refunds.py', finalTextTruncated: false }),
].join('\n');

describe('stream parsing', () => {
  it('V3: sums EVERY turn_completion (credit units only), counts tools by id, takes finalText', () => {
    const s = parseStream(V3_STREAM);
    expect(s.creditsTurnCompletion).toBeCloseTo(0.72);
    expect(s.turnCompletions).toBe(2);
    expect(s.requestIds).toEqual(['r1', 'r2', 'r3']);
    expect(s.toolCalls.map((t) => t.name)).toEqual(['@kopt/kopt_find', 'kind:read']);
    expect(s.usedTools).toEqual({ mcp_kopt_kopt_find: 1, read_file: 1 });
    expect(s.finalText).toBe('`compute_refund` in billing/refunds.py');
    expect(s.lastTurnText).toBe('`compute_refund` in billing/refunds.py');
    expect(s.allChunksText).not.toContain('old turn');
    expect(s.badLines).toBe(1);
    expect(s.ctxPctMax).toBeCloseTo(7.9);
    expect(s.sessionId).toBe('sess_1');
    expect(s.runFinished).toBe(true);
  });

  it('V2: sums _kiro.dev/metadata meteringUsage once per request', () => {
    const meta = (requestId: string | undefined, value: number) => JSON.stringify({ jsonrpc: '2.0', method: '_kiro.dev/metadata', params: { sessionId: 'u-1', ...(requestId ? { requestId } : {}), contextUsagePercentage: 12.3, meteringUsage: [{ value, unit: 'credit', unitPlural: 'credits' }], turnDurationMs: 2215 } });
    const s = parseStream([meta('r1', 0.04), meta('r1', 0.04), meta('r2', 0.06), meta(undefined, 0.1)].join('\n'));
    expect(s.creditsMetering).toBeCloseTo(0.2);
    expect(s.meteringEvents).toBe(3);
    expect(s.creditsTurnCompletion).toBeUndefined();
    expect(s.ctxPctMax).toBeCloseTo(12.3);
  });

  it('errors, denials and interruptions', () => {
    const s = parseStream(
      [
        info({ kind: 'display_error', displayError: { message: 'Request quota exceeded. Please wait a moment and try again.', errorType: 'MonthlyLimitReached' } }),
        upd({ sessionUpdate: 'tool_call', toolCallId: 'x', title: '@kopt/kopt_read' }),
        upd({ sessionUpdate: 'tool_call_update', toolCallId: 'x', status: 'failed', _meta: { kiro: { failureReason: 'denied' } } }),
        JSON.stringify({ type: 'runError', stage: 'new_session', message: 'boom', sessionId: 's' }),
        JSON.stringify({ type: 'workflowEvent', stage: 'running', message: 'not an error' }),
        info({ kind: 'turn_end', turnEnd: { stopReason: 'cancelled' } }),
      ].join('\n'),
    );
    expect(s.displayErrors[0]).toMatch(/MonthlyLimitReached/);
    expect(s.deniedTools).toBe(1);
    expect(s.runErrors).toEqual(['[new_session] boom']);
    expect(s.interrupted).toBe(true);
  });

  it('ignores Kiro-like records inside tool inputs and outputs (they are the user\'s data)', () => {
    const fake = { promptTurnSummaries: [{ unit: 'credit', usage: 99 }], finalText: 'not the answer', meteringUsage: [{ value: 5, unit: 'credit' }] };
    const s = parseStream(
      [
        upd({ sessionUpdate: 'tool_call', toolCallId: 'r', title: 'Reading x.json', kind: 'read', rawInput: fake }),
        upd({ sessionUpdate: 'tool_call_update', toolCallId: 'r', status: 'completed', rawOutput: fake, content: [{ type: 'content', content: fake }] }),
      ].join('\n'),
    );
    expect(s.creditsTurnCompletion).toBeUndefined();
    expect(s.creditsMetering).toBeUndefined();
    expect(s.finalText).toBeUndefined();
  });

  it('recognizes kopt tools under every naming', () => {
    for (const n of ['@kopt/kopt_find', 'mcp_kopt_kopt_read', 'kopt_outline']) expect(isKoptToolName(n)).toBe(true);
    for (const n of ['read_file', 'grep', '@other/find', 'koptic']) expect(isKoptToolName(n)).toBe(false);
  });

  it('credit units follow Kiro\'s own filter', () => {
    expect(sumCredits([{ value: 1, unit: 'credit' }, { value: 2, unitPlural: 'Credits ' }, { value: 5, unit: 'token' }, { usage: 0.5 }])).toBeCloseTo(3.5);
    expect(sumCredits([{ unit: 'token', value: 1 }])).toBeUndefined();
    expect(sumCredits('x')).toBeUndefined();
  });
});

describe('session files', () => {
  it('V2 sidecar: metering summed over every turn and request, wherever user_turn_metadatas is nested', () => {
    const sidecar = JSON.stringify({
      agent_name: 'abarm-b',
      session_state: {
        version: 'v1',
        conversation_metadata: {
          user_turn_metadatas: [
            { total_request_count: 2, builtin_tool_uses: 3, final_context_usage_percentage: 9.4, metering_usage: [{ value: 0.21, unit: 'credit', unit_plural: 'credits' }, { value: 0.19, unit: 'credit', unit_plural: 'credits' }] },
            { total_request_count: 1, builtin_tool_uses: 0, context_usage_percentage: 12, metering_usage: [{ value: 0.1, unit: 'credit' }] },
          ],
        },
      },
    });
    const s = parseSessionFiles([['v2/u.json', sidecar], ['v2/u.jsonl', JSON.stringify({ metering_usage: [{ value: 9, unit: 'credit' }] })]]);
    expect(s).toMatchObject({ source: 'v2-sidecar', turns: 2, requests: 3, builtinToolUses: 3, ctxPctMax: 12 });
    expect(s.credits).toBeCloseTo(0.5);
    expect(parseSessionFiles([['v2/u.jsonl', JSON.stringify({ metering_usage: [{ value: 0.3, unit: 'credit' }] })]])).toMatchObject({ source: 'v2-event-log', credits: 0.3 });
  });

  it('V3 messages.jsonl: usage_summary once per execution, tool calls, last assistant text', () => {
    const rec = (id: string, payload: object) => JSON.stringify({ id, timestamp: 't', payload });
    const usage = { type: 'usage_summary', promptTurnSummaries: [{ unit: 'credit', unitPlural: 'credits', usage: 0.42, usedTools: ['mcp_kopt_kopt_find'] }], elapsedTime: 1, status: 'success', executionId: 'e1', requestIds: ['a', 'b'] };
    const text = [
      rec('u', { type: 'user', content: [{ type: 'text', text: 'q' }] }),
      rec('tc', { type: 'tool_call', toolCallId: 'x', name: 'mcp_kopt_kopt_find' }),
      rec('a', { type: 'assistant', content: [{ type: 'text', text: 'the answer' }] }),
      rec('e1-usage', usage),
      rec('e1-usage', usage),
      rec('e2-usage', { ...usage, executionId: 'e2', promptTurnSummaries: [{ unit: 'credit', usage: 0.08 }] }),
    ].join('\n');
    const s = parseSessionFiles([['v3/sess_1/messages.jsonl', text], ['v3/sess_1/session.json', '{"id":"sess_1"}']]);
    expect(s).toMatchObject({ source: 'v3-usage-summary', turns: 2, requests: 4, toolCalls: 1, lastAssistantText: 'the answer', usedTools: { mcp_kopt_kopt_find: 1 } });
    expect(s.credits).toBeCloseTo(0.5);
    expect(parseSessionFiles([]).credits).toBeUndefined();
  });

  it('kopt telemetry lines', () => {
    const t = parseTelemetry([['{"ts":1,"kind":"tool","tool":"kopt_find"}', '{"ts":2,"kind":"hook"}', 'garbage', '{"ts":3,"kind":"session"}', '{"kind":"tool","tool":"kopt_read"}'].join('\n')]);
    expect(t).toEqual({ toolCalls: 2, byTool: { kopt_find: 1, kopt_read: 1 }, hookEvents: 1, sessionEvents: 1, lines: 4 });
  });
});

describe('V3 session buckets', () => {
  // The algorithm (first 16 hex digits of sha256 of the cwd string) was checked against the bucket a real 2.28 engine
  // logged for a known workspace; this vector pins it.
  it('matches the 2.28 engine: sha256 of the cwd string', () => {
    expect(v3Bucket('/home/dev/my repo')).toBe('56659415f3fb44a8');
    expect(v3Bucket(undefined)).toBe('_global');
  });
  it('tries every spelling of a Windows path', () => {
    const b = bucketCandidates('C:\\Users\\me\\out dir\\arms\\A\\repo\\', 'C:\\Users\\me\\out dir\\arms\\A\\repo', 'win32');
    expect(b).toContain(v3Bucket('C:\\Users\\me\\out dir\\arms\\A\\repo'));
    expect(new Set(b).size).toBe(b.length);
  });
});

describe('failure classification', () => {
  const empty = parseStream('');
  it('maps exit codes, stderr and stream errors to error kinds', () => {
    const c = (o: Partial<Parameters<typeof classifyRun>[0]>) => classifyRun({ exitCode: 0, timedOut: false, stderr: '', stream: empty, ...o }).errorKind;
    expect(c({})).toBeUndefined();
    expect(c({ timedOut: true, exitCode: null })).toBe('timeout');
    expect(c({ spawnError: 'ENOENT' })).toBe('spawn_failed');
    expect(c({ exitCode: 1, stderr: 'error: Not logged in. Set the KIRO_API_KEY environment variable or run `kiro-cli login` first.' })).toBe('not_logged_in');
    expect(c({ exitCode: 1, stderr: 'Authentication expired - please log in again' })).toBe('auth_expired');
    expect(c({ stderr: "[warn] failed to set model 'x': InvalidModelId" })).toBe('model_unavailable');
    expect(c({ exitCode: 3 })).toBe('mcp_startup');
    expect(c({ exitCode: 4, stderr: "error: agent 'abarm-b' not found" })).toBe('agent_not_found');
    expect(c({ exitCode: 1, stream: parseStream(info({ kind: 'display_error', displayError: { message: 'MonthlyLimitReached', errorType: 'x' } })) })).toBe('quota');
    expect(c({ stream: parseStream(info({ kind: 'display_error', displayError: { message: 'ThrottlingException', errorType: 'Throttling' } })) })).toBe('throttled');
    expect(c({ exitCode: 101, stderr: 'panicked' })).toBe('exit_nonzero');
    // a denied read-only tool is a setup error; kopt_run (never trusted) being denied is expected
    const denied = (title: string) =>
      parseStream([upd({ sessionUpdate: 'tool_call', toolCallId: 'd', title }), upd({ sessionUpdate: 'tool_call_update', toolCallId: 'd', status: 'failed', _meta: { kiro: { failureReason: 'denied' } } })].join('\n'));
    expect(c({ stream: denied('@kopt/kopt_find') })).toBe('tool_denied');
    expect(c({ stream: denied('@kopt/kopt_run') })).toBeUndefined();
  });

  // The stdout of the real kiro-cli 2.28 (V2) on the first headless request of an account Kiro's anti-abuse checks
  // had just suspended (session and request ids replaced). Exit 1, nothing on stderr; the session file had no metering.
  const SUSPENDED = [
    '{"type":"runStarted","data":{"payloadSchema":"acp","acpProtocolVersion":1,"engine":"v2"}}',
    '{"type":"metadata","data":{"sessionId":"0f1e2d3c-4b5a-4697-8877-665544332211","contextUsagePercentage":3.5879998207092285,"reasoning":{"support":"unavailable","effortLevels":[]}}}',
    '{"type":"metadata","data":{"sessionId":"0f1e2d3c-4b5a-4697-8877-665544332211","contextUsagePercentage":0.5191406011581421,"reasoning":{"support":"unavailable","effortLevels":[]}}}',
    '{"type":"metadata","data":{"sessionId":"0f1e2d3c-4b5a-4697-8877-665544332211","turnDurationMs":399,"reasoning":{"support":"unavailable","effortLevels":[]}}}',
    '{"type":"runError","data":{"sessionId":"0f1e2d3c-4b5a-4697-8877-665544332211","stage":"prompt","message":"Internal error (code -32603): Encountered an error in the response stream: Your User ID is temporarily suspended. We detected unusual user activity and locked it as a security precaution. To restore access, please contact our support team to verify your identity: https://support.aws.amazon.com/#/contacts/kiro (request_id: 00000000-0000-4000-8000-000000000000)"}}',
  ].join('\n');

  it('a blocked account (real 2.28 stream) is account_blocked: fatal, free, not the arm\'s fault, retried only after --account-restored', () => {
    const stream = parseStream(SUSPENDED);
    expect(stream.runErrors).toHaveLength(1);
    expect(stream.ctxPctMax).toBeCloseTo(3.588, 3);
    expect(stream.sessionId).toBe('0f1e2d3c-4b5a-4697-8877-665544332211');
    expect(stream.badLines).toBe(0);
    const r = classifyRun({ exitCode: 1, timedOut: false, stderr: '', stream });
    expect(r.errorKind).toBe('account_blocked');
    expect(r.detail).toMatch(/temporarily suspended/);
    // the same refusal as Kiro's log words it (AccessDeniedException) is not mistaken for an expired login
    expect(classifyRun({ exitCode: 1, timedOut: false, stderr: 'ConverseStreamError { status_code: Some(403), reason_code: "AccessDeniedException", message: Some("Your User ID is temporarily suspended.") }', stream: parseStream('') }).errorKind).toBe('account_blocked');
    expect(FATAL_ERRORS.has('account_blocked')).toBe(true);
    expect(FREE_ERRORS.has('account_blocked')).toBe(true);
    expect(OWN_FAULT_ERRORS.has('account_blocked')).toBe(false);
    expect(RETRY_ON_RESUME.has('account_blocked')).toBe(true);
    expect(billed({ errorKind: 'account_blocked', creditsSession: 0 } as RunRecord, 2)).toBe(0);
  });
});

function meta(over: Partial<StartedMeta> = {}): StartedMeta {
  return { runId: 't1__B__r1', idx: 1, task: 't1', kind: 'locate', arm: 'B', rep: 1, order: 0, smoke: false, engine: 'v3', model: 'm', startedAt: 'now', startMs: 0, koptArm: true, ...over };
}

describe('run records', () => {
  it('session credits first, stream as the cross-check, kopt calls from stream and telemetry', () => {
    const dir = join(tmp, 'rec1');
    mkdirSync(join(dir, 'session', 'v3', 'sess_1'), { recursive: true });
    mkdirSync(join(dir, 'kopt-home', 'telemetry'), { recursive: true });
    writeFileSync(join(dir, 'stream.jsonl'), V3_STREAM);
    writeFileSync(join(dir, 'stderr.log'), '');
    writeFileSync(join(dir, 'session', 'v3', 'sess_1', 'messages.jsonl'), JSON.stringify({ id: 'e', payload: { type: 'usage_summary', executionId: 'e', promptTurnSummaries: [{ unit: 'credit', usage: 0.8 }] } }));
    writeFileSync(join(dir, 'kopt-home', 'telemetry', '2026-10-09.jsonl'), '{"kind":"tool","tool":"kopt_find"}\n{"kind":"tool","tool":"kopt_read"}\n{"kind":"hook"}\n');
    const r = buildRecord(dir, meta(), { code: 0, signal: null, timedOut: false, ms: 1000 }, { id: 't1', prompt: 'p', gold: { files: ['billing/refunds.py'], symbols: ['compute_refund'] } }, 0.6);
    expect(r).toMatchObject({ valid: true, credits: 0.8, creditsSource: 'session', creditsStream: 0.72, creditsSession: 0.8, creditsMismatch: true, koptCalls: 2, koptCallsStream: 1, koptCallsTelemetry: 2, koptHookEvents: 1, toolCalls: 2, answerSource: 'stream:finalText' });
    expect(r.grade!.pass).toBe(true);
  });

  it('invalid runs: no credits, control arm reaching kopt, timeouts', () => {
    const dir = join(tmp, 'rec2');
    mkdirSync(join(dir, 'kopt-home', 'telemetry'), { recursive: true });
    writeFileSync(join(dir, 'stream.jsonl'), JSON.stringify({ type: 'runFinished', finalText: 'answer' }));
    expect(buildRecord(dir, meta(), { code: 0, signal: null, timedOut: false, ms: 1 }, undefined, 0.6)).toMatchObject({ valid: false, invalidReason: 'no_credits' });
    writeFileSync(join(dir, 'stream.jsonl'), [V3_STREAM].join('\n'));
    const a = buildRecord(dir, meta({ arm: 'A', koptArm: false }), { code: 0, signal: null, timedOut: false, ms: 1 }, undefined, 0.6);
    expect(a).toMatchObject({ valid: false, invalidReason: 'kopt_leak' });
    const t = buildRecord(dir, meta(), { code: null, signal: 'SIGTERM', timedOut: true, ms: 9 }, undefined, 0.6);
    expect(t).toMatchObject({ valid: false, invalidReason: 'timeout' });
    const unfinished = buildRecord(dir, meta(), undefined, undefined, 0.6);
    expect(unfinished).toMatchObject({ valid: false, invalidReason: 'aborted' });
    // a kopt arm that never called kopt is flagged, not dropped
    writeFileSync(join(dir, 'stream.jsonl'), [info({ kind: 'turn_completion', promptTurnSummaries: [{ unit: 'credit', usage: 1 }] }), JSON.stringify({ type: 'runFinished', finalText: 'x' })].join('\n'));
    expect(buildRecord(dir, meta(), { code: 0, signal: null, timedOut: false, ms: 1 }, undefined, 0.6)).toMatchObject({ valid: true, koptFlag: 'no kopt tool call in this run' });
    // metering found but 0: not the same as no metering at all
    writeFileSync(join(dir, 'stream.jsonl'), [info({ kind: 'turn_completion', promptTurnSummaries: [{ unit: 'credit', usage: 0 }] }), JSON.stringify({ type: 'runFinished', finalText: 'OK' })].join('\n'));
    expect(buildRecord(dir, meta(), { code: 0, signal: null, timedOut: false, ms: 1 }, undefined, 0.6)).toMatchObject({ valid: false, invalidReason: 'zero_credits' });
    // a run the harness killed at the budget
    expect(buildRecord(dir, meta(), { code: null, signal: 'SIGTERM', timedOut: false, ms: 1, budgetKill: 'metered credits 5 reached the limit' }, undefined, 0.6)).toMatchObject({ valid: false, invalidReason: 'budget_exceeded' });
  });
});

describe('statistics', () => {
  it('median, relative difference of totals, exact sign test', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeUndefined();
    expect(relativeDiff([{ task: 'a', a: 2, b: 1 }, { task: 'b', a: 2, b: 2 }])).toBeCloseTo(-0.25);
    expect(signTest(5, 5)).toBeCloseTo(0.0625);
    expect(signTest(3, 6)).toBe(1);
    expect(signTest(0, 0)).toBeUndefined();
  });
  it('cluster bootstrap: deterministic, brackets the estimate', () => {
    const pairs = Array.from({ length: 12 }, (_, i) => ({ task: `t${i % 4}`, a: 2 + (i % 3) * 0.1, b: 1.4 + (i % 5) * 0.05 }));
    const ci = clusterBootstrap(pairs, relativeDiff, 2000, 3);
    expect(ci).toEqual(clusterBootstrap(pairs, relativeDiff, 2000, 3));
    expect(ci[0]!).toBeLessThan(relativeDiff(pairs)!);
    expect(ci[1]!).toBeGreaterThan(relativeDiff(pairs)!);
    expect(ci[1]!).toBeLessThan(0);
    expect(clusterBootstrap(pairs.slice(0, 1), relativeDiff)).toEqual([undefined, undefined]);
  });
});

function rec(task: string, arm: 'A' | 'B', rep: number, credits: number, pass: boolean | undefined, over: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: `${task}__${arm}__r${rep}`, idx: 0, task, kind: 'locate', arm, rep, order: 0, smoke: false, engine: 'v2', model: 'm', startedAt: '', wallMs: 1000,
    exitCode: 0, signal: null, timedOut: false, valid: true, credits, creditsSource: 'session', creditsMismatch: false, toolCalls: 3, toolsByName: {}, usedTools: {},
    koptCalls: arm === 'B' ? 2 : 0, koptCallsStream: 0, koptCallsTelemetry: 0, koptHookEvents: 0, answerChars: 10, answerSource: 'x', streamLines: 5, streamBadLines: 0,
    warnings: [], dirtyAfter: false,
    ...(pass === undefined ? {} : { grade: { pass, symbolsFound: 1, symbolsTotal: 1, filesFound: 1, filesTotal: 1, missingSymbols: [], missingFiles: [] } }),
    ...over,
  };
}

describe('report', () => {
  const campaign = (bFactor: number, bPass = true) => {
    const out: RunRecord[] = [];
    for (let t = 1; t <= 5; t++) for (let rep = 1; rep <= 2; rep++) {
      const a = 2 + t * 0.1 + rep * 0.05;
      out.push(rec(`t${t}`, 'A', rep, a, true), rec(`t${t}`, 'B', rep, a * bFactor * (1 + (rep - 1.5) * 0.04), bPass));
    }
    return out;
  };
  it('worth rolling out: >= 20% saving, CI below 0, equal correctness', () => {
    const r = analyzeRuns(campaign(0.6), ['A', 'B'], { bootstrap: 2000 });
    const c = r.comparisons[0];
    expect(c.verdictCode).toBe('worth_rolling_out');
    expect(c.bothCorrect.pairs).toBe(10);
    expect(c.bothCorrect.relDiff).toBeCloseTo(-0.4, 1);
    expect(c.bothCorrect.ci[1]!).toBeLessThan(0);
    expect(c.bothCorrect.xCheaper).toBe(10);
    const md = renderReportMarkdown(r);
    expect(md).toContain('**Worth rolling out: arm B saves');
    expect(md).toContain('| t1 | locate |');
  });
  it('other verdicts: no saving, costs more, correctness drop, insufficient data, ungraded', () => {
    expect(analyzeRuns(campaign(0.9), ['A', 'B'], { bootstrap: 2000 }).comparisons[0].verdictCode).toBe('no_saving');
    expect(analyzeRuns(campaign(1.4), ['A', 'B'], { bootstrap: 2000 }).comparisons[0].verdictCode).toBe('costs_more');
    expect(analyzeRuns(campaign(0.5, false), ['A', 'B'], { bootstrap: 2000 }).comparisons[0].verdictCode).toBe('correctness_drop');
    expect(analyzeRuns(campaign(0.5).slice(0, 4), ['A', 'B'], { bootstrap: 500 }).comparisons[0].verdictCode).toBe('insufficient_data');
    const ungraded = campaign(0.6).map((r) => ({ ...r, grade: undefined }));
    const u = analyzeRuns(ungraded, ['A', 'B'], { bootstrap: 1000 });
    expect(u.graded).toBe(false);
    expect(u.comparisons[0].mainView).toBe('allRuns');
    expect(u.comparisons[0].verdict).toMatch(/not graded/);
  });
  it('a promising but noisy saving is not a rollout', () => {
    const noisy: RunRecord[] = [];
    const factors = [0.3, 1.2, 0.4, 1.1];
    factors.forEach((f, i) => noisy.push(rec(`t${i}`, 'A', 1, 2, true), rec(`t${i}`, 'B', 1, 2 * f, true)));
    expect(analyzeRuns(noisy, ['A', 'B'], { bootstrap: 2000 }).comparisons[0].verdictCode).toBe('promising');
  });
  it('invalid runs are excluded and listed; manual grades override the automatic grade', () => {
    const rs = campaign(0.6);
    rs[1] = { ...rs[1], valid: false, invalidReason: 'no_credits', errorKind: 'no_credits', credits: undefined };
    rs[2] = { ...rs[2], dirtyAfter: true };
    const manual = new Map(rs.filter((r) => r.arm === 'B').map((r) => [r.runId, '0']));
    const r = analyzeRuns(rs, ['A', 'B'], { bootstrap: 500, manualGrades: manual });
    expect(r.invalidRuns).toEqual([{ runId: rs[1].runId, arm: 'B', reason: 'no_credits', detail: undefined }]);
    expect(r.comparisons[0].allRuns.pairs).toBe(9);
    expect(r.dirtyRuns).toEqual([rs[2].runId]);
    expect(renderReportMarkdown(r)).toMatch(/1 run\(s\) changed files of their worktree/);
    expect(r.comparisons[0].verdictCode).toBe('correctness_drop');
    expect(parseManualGrade(' Yes ')).toBe(true);
    expect(parseManualGrade('fail')).toBe(false);
    expect(parseManualGrade('?')).toBeUndefined();
  });
  it('CSV round trip keeps manual grades and quotes free text', () => {
    const rs = [rec('t1', 'A', 1, 1.5, true, { errorDetail: 'a, "quoted"\nline', warnings: ['w1', 'w2'] })];
    const csv = toCsv(rs, new Map([[rs[0].runId, '1']]));
    const back = readCsv(csv);
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ run_id: 't1__A__r1', credits: '1.5', manual_grade: '1', error_detail: 'a, "quoted"\nline', warnings: 'w1 | w2', auto_grade: 'pass' });
  });
});

describe('kiro-cli output parsing', () => {
  it('whoami: exit code decides, the e-mail is never kept', () => {
    const r = (stdout: string, code: number) => ({ code, signal: null, timedOut: false, ms: 1, stdout, stderr: '' });
    expect(parseWhoami(r('Logged in with Builder ID\nEmail: someone@example.com\n', 0))).toMatchObject({ loggedIn: true, method: 'Builder ID' });
    expect(parseWhoami(r('Logged in with Builder ID\nEmail: someone@example.com\n', 0)).output).not.toContain('someone@');
    expect(parseWhoami(r('Authenticated with API key\n', 0))).toMatchObject({ loggedIn: true, method: 'API key' });
    expect(parseWhoami(r('Not logged in\n', 1)).loggedIn).toBe(false);
    expect(parseWhoami(r('{"account":null}', 1)).loggedIn).toBe(false);
  });
  it('model list, cheapest model, versions, agent validate', () => {
    const models = parseModelList(JSON.stringify({ models: [{ modelId: 'auto', rateMultiplier: 1 }, { modelId: 'claude-sonnet-4.5', rateMultiplier: 1.3 }, { modelId: 'qwen3-coder-next', rateMultiplier: 0.05 }, { id: 'x' }] }));
    expect(models.map((m) => m.id)).toEqual(['auto', 'claude-sonnet-4.5', 'qwen3-coder-next', 'x']);
    expect(cheapestModel(models)!.id).toBe('qwen3-coder-next');
    expect(parseModelList('not json')).toEqual([]);
    expect(parseVersion('kiro-cli 2.28.0\n')).toBe('2.28.0');
    expect(versionAtLeast('2.28.0', [2, 28, 0])).toBe(true);
    expect(versionAtLeast('2.27.9', [2, 28, 0])).toBe(false);
    expect(versionAtLeast('3.0.0', [2, 28, 0])).toBe(true);
    const ok = { code: 0, signal: null, timedOut: false, ms: 1, stdout: '', stderr: '' };
    expect(validateOutputProblems(ok)).toBeUndefined();
    // 2.28 exits 0 and reports problems on stderr only (verified)
    expect(validateOutputProblems({ ...ok, stderr: '\x1b[38;5;9mError: \x1b[0mJson supplied at /x.json is invalid: invalid type: string "read", expected a sequence' })).toMatch(/^Error: Json supplied/);
  });
  it('mcp list: the 2.28 stderr layout', () => {
    // captured from kiro-cli 2.28 `mcp list` in a temporary HOME (paths shortened)
    const text = '\n\x1b[1m🤖 default:\x1b[0m\n\n  kiro_default\n    • kopt         /usr/local/bin/node\n\n📄 workspace:\n\n  abarm-a\n    (empty)\n  abarm-b\n    • kopt         /usr/local/bin/node [legacy]\n  kiro_help\n    (empty)\n\n🌍 global:\n\n';
    const m = parseMcpList(text);
    expect(m.get('abarm-a')).toEqual([]);
    expect(m.get('abarm-b')).toEqual(['kopt']);
    expect(m.get('kiro_default')).toEqual(['kopt']);
  });
});

describe('isolation helpers', () => {
  it('the run environment drops inherited KOPT_* variables, sets KIRO_HOME and kopt dirs, keeps HOME', () => {
    const env = armEnv({ HOME: '/home/me', USERPROFILE: 'C:\\Users\\me', PATH: '/usr/bin', KOPT_TELEMETRY: '0', KOPT_HOOKS: '0', KOPT_ROOT: '/x', KOPT_DATA_DIR: '/elsewhere', KIRO_API_KEY: 'k' }, { kiroHome: '/o/A/kiro-home', koptHome: '/o/runs/r/kopt-home', cacheDir: '/o/cache', dataDir: '/o/cache/repo-1234', nodePath: '/opt/node22/bin/node', ideSettings: '/o/A/ide.json' });
    expect(env).toMatchObject({ HOME: '/home/me', USERPROFILE: 'C:\\Users\\me', KIRO_HOME: '/o/A/kiro-home', KOPT_HOME: '/o/runs/r/kopt-home', KOPT_CACHE_DIR: '/o/cache', KOPT_DATA_DIR: '/o/cache/repo-1234', KOPT_KIRO_HOME: '/o/A/kiro-home', KIRO_API_KEY: 'k', KIRO_NO_AUTO_UPDATE: '1' });
    // kopt's telemetry is the proof of kopt usage: forced on, whatever the caller or a committed config says
    expect(env.KOPT_TELEMETRY).toBe('1');
    expect(env.KOPT_HOOKS).toBeUndefined();
    expect(env.KOPT_ROOT).toBeUndefined();
    expect(env.PATH!.startsWith('/opt/node22/bin')).toBe(true);
  });
  it('per-engine tools, trust lists and agents', () => {
    expect(builtinTools('v2', ['read'])).toEqual(['fs_read', 'grep', 'glob']);
    expect(builtinTools('v3', ['read', 'shell'])).toEqual(['read', 'shell']);
    expect(trustList('v2', ['read'], true)).toBe('fs_read,grep,glob,@kopt/kopt_find,@kopt/kopt_read,@kopt/kopt_outline,@kopt/kopt_refs,@kopt/kopt_expand');
    expect(trustList('v3', ['read'], true)).toBe('read');
    const a = agentConfig({ arm: 'A', engine: 'v2', tags: ['read'], kopt: false, includeMcpJson: false });
    expect(JSON.stringify(a)).not.toMatch(/kopt/i);
    const b = agentConfig({ arm: 'B', engine: 'v2', tags: ['read'], kopt: true, includeMcpJson: true, hooks: koptAgentHooks('/n/node', '/k/bin.js', {}) });
    expect(b.tools).toEqual(['fs_read', 'grep', 'glob', '@kopt']);
    expect(Object.keys(b.hooks as object)).toEqual(['agentSpawn', 'userPromptSubmit', 'preToolUse', 'postToolUse', 'stop']);
    expect(JSON.stringify(b.hooks)).toContain('/k/bin.js hook --source agent');
  });
  it('launchers: Node scripts and .cmd shims run through Node, executables directly', () => {
    expect(launcherFor('/x/fake.mjs', '/n/node')).toEqual({ command: '/n/node', prefix: ['/x/fake.mjs'], display: '/x/fake.mjs' });
    const shim = join(ROOT, 'bench', 'ab', 'fake-kiro-cli.cmd');
    expect(launcherFor(shim, '/n/node')).toMatchObject({ command: '/n/node', prefix: [join(ROOT, 'bench', 'ab', 'fake-kiro-cli.mjs')] });
    expect(launcherFor('C:\\Program Files\\Kiro\\kiro-cli-chat.exe', '/n/node')).toMatchObject({ command: 'C:\\Program Files\\Kiro\\kiro-cli-chat.exe', prefix: [] });
  });
  it('the output directory must be outside the repository', () => {
    expect(isInsidePath(join(tmp, 'a', 'b'), join(tmp, 'a'))).toBe(true);
    expect(isInsidePath(join(tmp, 'a'), join(tmp, 'a'))).toBe(true);
    expect(isInsidePath(join(tmp, 'ab'), join(tmp, 'a'))).toBe(false);
  });
  it('baseline snapshot and restore put a worktree back exactly', () => {
    const repo = join(tmp, 'base repo');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'a.py'), 'a\n');
    writeFileSync(join(repo, 'src', 'b.py'), 'b\n');
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo, stdio: 'ignore' });
    git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    // prepared state: one tracked file modified, one untracked config file, one tracked file deleted
    writeFileSync(join(repo, 'src', 'a.py'), 'a prepared\n');
    mkdirSync(join(repo, '.kiro', 'settings'), { recursive: true });
    writeFileSync(join(repo, '.kiro', 'settings', 'mcp.json'), '{}\n');
    execFileSync('git', ['rm', '-q', 'src/b.py'], { cwd: repo });
    const store = join(tmp, 'base store');
    const b = snapshotBaseline(repo, store);
    expect(b.paths.sort()).toEqual(['.kiro/settings/mcp.json', 'src/a.py']);
    expect(b.deleted).toEqual(['src/b.py']);
    // a run edits, creates and deletes files
    writeFileSync(join(repo, 'src', 'a.py'), 'changed by the run\n');
    writeFileSync(join(repo, '.kiro', 'settings', 'mcp.json'), '{"x":1}\n');
    writeFileSync(join(repo, 'src', 'new.py'), 'new\n');
    writeFileSync(join(repo, 'src', 'b.py'), 'back\n');
    const changed = restoreBaseline(repo, store, b);
    expect(changed.sort()).toEqual(['.kiro/settings/mcp.json', 'src/a.py', 'src/b.py', 'src/new.py']);
    expect(readFileSync(join(repo, 'src', 'a.py'), 'utf8')).toBe('a prepared\n');
    expect(readFileSync(join(repo, '.kiro', 'settings', 'mcp.json'), 'utf8')).toBe('{}\n');
    expect(existsSync(join(repo, 'src', 'new.py'))).toBe(false);
    expect(existsSync(join(repo, 'src', 'b.py'))).toBe(false);
    expect(restoreBaseline(repo, store, b)).toEqual([]);

    // a repository that gitignores .kiro/: the prepared agent is still part of the baseline, run leftovers go
    const ign = join(tmp, 'ignoring repo');
    mkdirSync(ign, { recursive: true });
    writeFileSync(join(ign, '.gitignore'), '.kiro/\n');
    writeFileSync(join(ign, 'a.py'), 'a\n');
    const g2 = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: ign, stdio: 'ignore' });
    g2('init', '-q');
    g2('add', '-A');
    g2('commit', '-q', '-m', 'init');
    mkdirSync(join(ign, '.kiro', 'agents'), { recursive: true });
    writeFileSync(join(ign, '.kiro', 'agents', 'abarm-a.json'), '{"name":"abarm-a"}\n');
    const store2 = join(tmp, 'ignoring store');
    const b2 = snapshotBaseline(ign, store2);
    expect(b2.paths).toEqual(['.kiro/agents/abarm-a.json']);
    mkdirSync(join(ign, '.kiro', 'hooks'), { recursive: true });
    writeFileSync(join(ign, '.kiro', 'hooks', 'leftover.kiro.hook'), '{}');
    writeFileSync(join(ign, '.kiro', 'agents', 'abarm-a.json'), '{"name":"changed"}\n');
    expect(restoreBaseline(ign, store2, b2).sort()).toEqual(['.kiro/agents/abarm-a.json', '.kiro/hooks/leftover.kiro.hook']);
    expect(existsSync(join(ign, '.kiro', 'hooks', 'leftover.kiro.hook'))).toBe(false);
    expect(readFileSync(join(ign, '.kiro', 'agents', 'abarm-a.json'), 'utf8')).toBe('{"name":"abarm-a"}\n');
    expect(parseStatus(' M a b.py\0?? c\0R  new\0old\0')).toEqual([{ code: ' M', path: 'a b.py' }, { code: '??', path: 'c' }, { code: 'R ', path: 'new', orig: 'old' }]);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Regression tests of the review of `kopt bench ab` (numbers = the issue in the review)

describe('review fixes: kopt usage and leaks (3, 4)', () => {
  it('only exact kopt tool names or qualified titles count; free-text titles never do', () => {
    for (const n of ['@kopt/kopt_find', 'mcp_kopt_kopt_read', 'kopt_outline', '@kopt/kopt_run']) expect(isKoptToolName(n)).toBe(true);
    for (const n of ['Searching for kopt_find in src', 'grep kopt_find', '@kopt/kopt_findx', 'xkopt_find', 'kopt_find2']) expect(isKoptToolName(n)).toBe(false);
    expect(isKoptTitle('@kopt/kopt_find')).toBe(true);
    expect(isKoptTitle('mcp_kopt_kopt_outline')).toBe(true);
    expect(isKoptTitle('Searching for kopt_find in src')).toBe(false);
    expect(isKoptTitle('Reading kopt_read.ts')).toBe(false);
    expect(isKoptCall({ name: 'kind:search', title: 'Searching for kopt_find in src' })).toBe(false);
    expect(isKoptCall({ name: 'kind:other', title: '@kopt/kopt_find' })).toBe(true);
  });

  const runDir = (name: string, stream: string[], telemetry?: string[]) => {
    const dir = join(tmp, name);
    mkdirSync(join(dir, 'kopt-home', 'telemetry'), { recursive: true });
    writeFileSync(join(dir, 'stream.jsonl'), stream.join('\n'));
    if (telemetry) writeFileSync(join(dir, 'kopt-home', 'telemetry', '2026-10-09.jsonl'), telemetry.join('\n') + '\n');
    return dir;
  };
  const credits = info({ kind: 'turn_completion', promptTurnSummaries: [{ unit: 'credit', usage: 1 }] });
  const done = JSON.stringify({ type: 'runFinished', finalText: 'compute_refund in src/billing/refunds.py' });
  const ok = { code: 0, signal: null, timedOut: false, ms: 1 };

  it('a failed kopt call is not kopt usage: arm B is flagged, arm A is not a leak', () => {
    const dir = runDir('rev-failed-kopt', [
      upd({ sessionUpdate: 'tool_call', toolCallId: 't1', title: '@kopt/kopt_find', kind: 'other', status: 'pending' }),
      upd({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed', _meta: { kiro: { error: 'Tool use was rejected: approval not available in non-interactive mode' } } }),
      credits,
      done,
    ]);
    const b = buildRecord(dir, meta(), ok, undefined, 0.6);
    expect(b).toMatchObject({ koptCalls: 0, koptCallsStream: 0, koptCallsTelemetry: 0, koptCallsFailed: 1 });
    // the wording is Kiro's refusal: a read-only tool denied is a setup error, fatal for the campaign
    expect(b.errorKind).toBe('tool_denied');
    const a = buildRecord(dir, meta({ arm: 'A', koptArm: false }), ok, undefined, 0.6);
    expect(a.errorKind).not.toBe('kopt_leak');
  });

  it('a kopt call that failed while running (not refused) leaves a valid, flagged run', () => {
    const dir = runDir('rev-failed-kopt-run', [
      upd({ sessionUpdate: 'tool_call', toolCallId: 't1', title: '@kopt/kopt_find', kind: 'other', status: 'pending' }),
      upd({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed', _meta: { kiro: { error: 'MCP error -32000: Connection closed' } } }),
      credits,
      done,
    ]);
    const b = buildRecord(dir, meta(), ok, undefined, 0.6);
    expect(b).toMatchObject({ valid: true, koptCalls: 0, koptCallsFailed: 1 });
    expect(b.koptFlag).toMatch(/failed or was refused/);
  });

  it('a grep titled with a kopt tool name in arm A is not a leak (benchmarking the kopt repository)', () => {
    const dir = runDir('rev-grep-title', [
      upd({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Searching for kopt_find in src', kind: 'search', status: 'pending' }),
      upd({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' }),
      credits,
      done,
    ]);
    const a = buildRecord(dir, meta({ arm: 'A', koptArm: false }), ok, undefined, 0.6);
    expect(a).toMatchObject({ valid: true, koptCalls: 0 });
    // a real kopt call (completed, exact name) or kopt telemetry in arm A is a leak
    const leak = runDir('rev-real-leak', [upd({ sessionUpdate: 'tool_call', toolCallId: 't1', title: '@kopt/kopt_find', status: 'pending' }), upd({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' }), credits, done]);
    expect(buildRecord(leak, meta({ arm: 'A', koptArm: false }), ok, undefined, 0.6).errorKind).toBe('kopt_leak');
    const tel = runDir('rev-tel-leak', [credits, done], ['{"kind":"hook"}']);
    expect(buildRecord(tel, meta({ arm: 'A', koptArm: false }), ok, undefined, 0.6).errorKind).toBe('kopt_leak');
  });

  it('kopt arms are judged by kopt telemetry; stream calls without telemetry are flagged', () => {
    const stream = [upd({ sessionUpdate: 'tool_call', toolCallId: 't1', title: '@kopt/kopt_find', status: 'pending' }), upd({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' }), credits, done];
    const noTel = buildRecord(runDir('rev-no-tel', stream), meta(), ok, undefined, 0.6);
    expect(noTel).toMatchObject({ valid: true, koptCalls: 0, koptCallsStream: 1 });
    expect(noTel.koptFlag).toMatch(/none in kopt's telemetry/);
    const withTel = buildRecord(runDir('rev-tel', stream, ['{"kind":"tool","tool":"kopt_find"}']), meta(), ok, undefined, 0.6);
    expect(withTel).toMatchObject({ valid: true, koptCalls: 1, koptCallsStream: 1 });
    expect(withTel.koptFlag).toBeUndefined();
  });

  it('denials: Kiro failure reasons, permission requests and stderr [denied] lines; OS errors are not denials', () => {
    const p = (...l: string[]) => parseStream(l.join('\n'));
    const tc = (id: string, title: string) => upd({ sessionUpdate: 'tool_call', toolCallId: id, title, status: 'pending' });
    const failed = (id: string, extra: object = {}) => upd({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'failed', ...extra });
    expect(p(tc('a', '@kopt/kopt_find'), failed('a', { _meta: { kiro: { toolCallFailureReason: 'permission_denied' } } })).deniedTools).toBe(1);
    expect(p(tc('a', 'fs_read'), failed('a', { _meta: { kiro: { failure_reason: 'denied' } } })).deniedTools).toBe(1);
    expect(p(tc('a', 'fs_read'), JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'session/request_permission', params: { toolCall: { toolCallId: 'a', title: 'fs_read' } } }), failed('a')).deniedTools).toBe(1);
    const osError = p(tc('a', 'fs_read'), failed('a', { content: [{ type: 'content', content: { type: 'text', text: 'Permission denied (os error 13)' } }] }));
    expect(osError.deniedTools).toBe(0);
    expect(isDenied({ id: 'x', name: 'fs_read', status: 'completed', failureReason: 'denied' })).toBe(false);
    expect(stderrDenials('[denied] tool permission approval is not supported in non-interactive mode. Use --trust-all-tools to auto-approve.\nother\n')).toBe(1);
    const c = (stream: ReturnType<typeof parseStream>, stderr = '') => classifyRun({ exitCode: 0, timedOut: false, stderr, stream }).errorKind;
    expect(c(osError)).toBeUndefined();
    // an unattributed [denied] line on stderr blames the failed read-only call
    expect(c(p(tc('a', 'fs_read'), failed('a')), '[denied] tool permission approval is not supported in non-interactive mode.\n')).toBe('tool_denied');
    // kopt_run is never trusted: its refusal is expected, and its [denied] line does not blame another failed call
    expect(c(p(tc('a', '@kopt/kopt_run'), failed('a', { _meta: { kiro: { toolCallFailureReason: 'permission_denied' } } })))).toBeUndefined();
    expect(c(p(tc('a', '@kopt/kopt_run'), failed('a'), tc('b', 'fs_read'), failed('b', { content: [{ type: 'content', content: { type: 'text', text: 'No such file' } }] })), '[denied] tool permission approval is not supported in non-interactive mode.\n')).toBeUndefined();
  });
});

describe('review fixes: budget (1, 6, 18)', () => {
  it('the live meter sums V2 requests once each and knows when more requests may follow', () => {
    const m = new LiveMeter();
    const meta2 = (requestId: string, value: number) => JSON.stringify({ jsonrpc: '2.0', method: '_kiro.dev/metadata', params: { requestId, meteringUsage: [{ value, unit: 'credit', unitPlural: 'credits' }] } });
    expect(m.feed(meta2('r1', 1.5) + '\n' + meta2('r1', 1.5).slice(0, 10))).toBeCloseTo(1.5);
    expect(m.feed(meta2('r1', 1.5).slice(10) + '\n')).toBe(0);
    expect(m.feed(meta2('r2', 2) + '\nnot json\n')).toBeCloseTo(2);
    expect(m).toMatchObject({ credits: 3.5, maxStep: 2, lastFromRequest: true });
    m.line(info({ kind: 'turn_completion', promptTurnSummaries: [{ unit: 'credit', usage: 0.5 }] }));
    expect(m.credits).toBeCloseTo(4);
    expect(m.lastFromRequest).toBe(false);
  });

  it('billing: measured credits, timeouts scaled by how long they ran, aborted runs at least the estimate, free failures', () => {
    const r = (over: Partial<RunRecord>) => rec('t1', 'A', 1, 1, true, over);
    expect(billed(r({ credits: 0.8 }), 2)).toBe(0.8);
    expect(billed(r({ credits: undefined, valid: false, errorKind: 'no_credits' }), 2)).toBe(2);
    // a timeout ran 10x longer than a typical run: 5x the estimate at most
    expect(billed(r({ credits: undefined, valid: false, errorKind: 'timeout', timedOut: true, wallMs: 600_000 }), 2, 60_000)).toBe(10);
    expect(billed(r({ credits: undefined, valid: false, errorKind: 'timeout', timedOut: true, wallMs: 90_000 }), 2, 60_000)).toBe(3);
    expect(billed(r({ credits: 0.1, valid: false, errorKind: 'aborted' }), 2)).toBe(2);
    expect(billed(r({ credits: 3, valid: false, errorKind: 'aborted' }), 2)).toBe(3);
    expect(billed(r({ credits: undefined, valid: false, errorKind: 'mcp_startup' }), 2)).toBe(0);
    expect(estimateFor([], 'A', 2)).toBe(2);
    expect(estimateFor([r({ credits: 1 }), r({ credits: 3 })], 'A', 2)).toBe(3);
  });

  it('the report and the console count the same total (archived attempts included)', () => {
    const out = join(tmp, 'rev-budget');
    mkdirSync(out, { recursive: true });
    const records = [rec('t1', 'A', 1, 1, true), rec('t1', 'B', 1, 0.5, true), rec('t2', 'A', 1, 1, true, { credits: undefined, valid: false, errorKind: 'no_credits' })];
    appendFileSync(join(out, 'aborted.jsonl'), JSON.stringify({ runId: 'x', at: 'now', credits: 0.7, measured: false, reason: 'aborted' }) + '\nnot json\n');
    const t = budgetTotals(records, out, 2);
    expect(t).toMatchObject({ measured: 1.5, archived: 0.7 });
    expect(t.counted).toBeCloseTo(1 + 0.5 + 1 + 0.7);
    const { report } = writeReport(out, records, ['A', 'B'], { budget: t });
    expect(report.budget!.counted).toBeCloseTo(t.counted);
    expect(readFileSync(join(out, 'report.md'), 'utf8')).toMatch(/3\.200 counted against --max-credits, the same total the console prints/);
  });
});

describe('review fixes: verdicts (8, 9, 10)', () => {
  const mk = (task: string, arm: 'A' | 'B', rep: number, credits: number, pass: boolean | undefined = true, over: Partial<RunRecord> = {}) => rec(task, arm, rep, credits, pass, over);
  it('3 tasks all cheaper is promising, never worth rolling out (sign test p = 0.25)', () => {
    const r = analyzeRuns([mk('t1', 'A', 1, 1), mk('t1', 'B', 1, 0.7), mk('t2', 'A', 1, 1.2), mk('t2', 'B', 1, 0.8), mk('t3', 'A', 1, 0.9), mk('t3', 'B', 1, 0.75)], ['A', 'B'], { bootstrap: 2000 });
    expect(r.comparisons[0]).toMatchObject({ verdictCode: 'promising', conclusive: false });
    expect(r.comparisons[0].verdict).toMatch(/not enough for a conclusive verdict/);
  });
  it('one large task carrying the total is mixed, not promising', () => {
    const r = analyzeRuns([mk('t1', 'A', 1, 10), mk('t1', 'B', 1, 5), mk('t2', 'A', 1, 1), mk('t2', 'B', 1, 1.5), mk('t3', 'A', 1, 1), mk('t3', 'B', 1, 1.5), mk('t4', 'A', 1, 1), mk('t4', 'B', 1, 1.5)], ['A', 'B'], { bootstrap: 2000 });
    expect(r.comparisons[0].verdictCode).toBe('mixed');
    expect(r.comparisons[0].verdict).toMatch(/cheaper on only 1 of 4 pairs/);
  });
  it('evidence: 5 tasks and 10 pairs, or a sign test below 0.05 over at least 3 tasks', () => {
    const v = (tasks: number, pairs: number, signP: number) => ({ tasks, pairs, signP, sumA: 1, sumX: 1, ci: [undefined, undefined] as [undefined, undefined], xCheaper: 0, aCheaper: 0, ties: 0 });
    expect(enoughEvidence(v(5, 10, 0.5))).toBe(true);
    expect(enoughEvidence(v(4, 12, 0.5))).toBe(false);
    expect(enoughEvidence(v(3, 6, 0.03))).toBe(true);
    expect(enoughEvidence(v(1, 6, 0.03))).toBe(false);
    // costs more without enough evidence is not conclusive either
    const r = analyzeRuns([mk('t1', 'A', 1, 1), mk('t1', 'B', 1, 1.5), mk('t2', 'A', 1, 1), mk('t2', 'B', 1, 1.6), mk('t3', 'A', 1, 1), mk('t3', 'B', 1, 1.4)], ['A', 'B'], { bootstrap: 2000 });
    expect(r.comparisons[0].verdictCode).toBe('inconclusive');
  });
  it('invalid runs that are the arm\'s own doing count as wrong answers and as failures', () => {
    const rs: RunRecord[] = [];
    for (let t = 1; t <= 5; t++) for (let rep = 1; rep <= 2; rep++) rs.push(mk(`t${t}`, 'A', rep, 2), mk(`t${t}`, 'B', rep, 1.2));
    // three B runs time out: with the gold, they are wrong answers (the main view only had the valid pairs)
    const timeouts = rs.map((r) => (r.arm === 'B' && r.rep === 2 && ['t1', 't2', 't3'].includes(r.task) ? { ...r, valid: false, credits: undefined, timedOut: true, errorKind: 'timeout' as const, invalidReason: 'timeout', grade: { ...r.grade!, pass: false } } : r));
    const c = analyzeRuns(timeouts, ['A', 'B'], { bootstrap: 1000 }).comparisons[0];
    expect(c.verdictCode).toBe('correctness_drop');
    // ungraded tasks: the reliability rule catches it
    const ungraded = timeouts.map((r) => ({ ...r, grade: undefined }));
    const u = analyzeRuns(ungraded, ['A', 'B'], { bootstrap: 1000 });
    expect(u.comparisons[0]).toMatchObject({ verdictCode: 'reliability_drop', reliabilityOk: false });
    expect(u.arms.find((a) => a.arm === 'B')).toMatchObject({ ownFaultInvalid: 3, attempted: 10 });
    // environment failures (quota) are not the arm's fault
    const quota = rs.map((r) => (r.arm === 'B' && r.rep === 2 && ['t1', 't2', 't3'].includes(r.task) ? { ...r, valid: false, credits: undefined, errorKind: 'quota' as const, invalidReason: 'quota' } : r));
    expect(analyzeRuns(quota, ['A', 'B'], { bootstrap: 1000 }).comparisons[0].reliabilityOk).toBe(true);
  });
  it('tasks without a gold or a manual grade are named, not silently left out', () => {
    const rs: RunRecord[] = [];
    for (let t = 1; t <= 3; t++) for (let rep = 1; rep <= 2; rep++) rs.push(rec(`t${t}`, 'A', rep, 2, t === 3 ? undefined : true), rec(`t${t}`, 'B', rep, 1.2, t === 3 ? undefined : true));
    const r = analyzeRuns(rs, ['A', 'B'], { bootstrap: 500 });
    expect(r.ungradedTasks).toEqual(['t3']);
    expect(r.comparisons[0].verdict).toMatch(/1 task\(s\) without a gold or a manual grade are not in this view: t3/);
    expect(renderReportMarkdown(r)).toMatch(/have no gold and no manual grade, so they are left out of the main view .*`t3`/);
  });
});

describe('review fixes: manual grades survive a spreadsheet (11)', () => {
  it('reads ; and tab CSV and the Excel sep= line', () => {
    expect(detectDelimiter('run_id;task;manual_grade\n')).toBe(';');
    expect(detectDelimiter('run_id\ttask\n')).toBe('\t');
    expect(detectDelimiter('"a;b",c,d\n')).toBe(',');
    expect(detectDelimiter('sep=;\nrun_id;manual_grade\n')).toBe(';');
    expect(readCsv('sep=;\r\nrun_id;manual_grade\r\nx;"1;2"\r\n')).toEqual([{ run_id: 'x', manual_grade: '1;2' }]);
  });
  it('a runs.csv re-saved with ; keeps every grade; an unreadable one falls back to manual-grades.json; the old file is kept', () => {
    const out = join(tmp, 'rev-csv');
    mkdirSync(out, { recursive: true });
    const records = [rec('t1', 'A', 1, 1, undefined), rec('t1', 'B', 1, 0.5, undefined), rec('t2', 'A', 1, 1, undefined)];
    writeReport(out, records, ['A', 'B'], {});
    // the user grades in Excel (decimal-comma locale): saved with ;
    const rows = readCsv(readFileSync(join(out, 'runs.csv'), 'utf8'));
    const head = Object.keys(rows[0]);
    const grade: Record<string, string> = { t1__A__r1: '1', t1__B__r1: '0', t2__A__r1: 'yes' };
    const semi = [head.join(';'), ...rows.map((r) => head.map((h) => (h === 'manual_grade' ? grade[r.run_id] : (r[h] ?? '').replace(/[;\n"]/g, ' '))).join(';'))].join('\r\n');
    writeFileSync(join(out, 'runs.csv'), '\uFEFF' + semi);
    writeReport(out, records, ['A', 'B'], {});
    const after = readCsv(readFileSync(join(out, 'runs.csv'), 'utf8'));
    expect(Object.fromEntries(after.map((r) => [r.run_id, r.manual_grade]))).toEqual(grade);
    expect(existsSync(join(out, 'runs.csv.bak'))).toBe(true);
    expect(JSON.parse(readFileSync(join(out, 'manual-grades.json'), 'utf8'))).toEqual(grade);
    // a file a spreadsheet mangled beyond reading: the grades come from manual-grades.json
    writeFileSync(join(out, 'runs.csv'), 'garbage without the columns\n');
    const r = writeReport(out, records, ['A', 'B'], {});
    expect(r.notes.join(' ')).toMatch(/could not be read/);
    expect(Object.fromEntries(readCsv(readFileSync(join(out, 'runs.csv'), 'utf8')).map((x) => [x.run_id, x.manual_grade]))).toEqual(grade);
    // a grade cleared in runs.csv is cleared for good
    const lines = readFileSync(join(out, 'runs.csv'), 'utf8').split('\n');
    const gi = lines[0].split(',').indexOf('manual_grade');
    const row = lines.findIndex((l) => l.startsWith('t2__A__r1,'));
    const cells = lines[row].split(',');
    cells[gi] = '';
    lines[row] = cells.join(',');
    writeFileSync(join(out, 'runs.csv'), lines.join('\n'));
    writeReport(out, records, ['A', 'B'], {});
    expect(JSON.parse(readFileSync(join(out, 'manual-grades.json'), 'utf8'))).toEqual({ t1__A__r1: '1', t1__B__r1: '0' });
  });
});

describe('review fixes: worktrees (12, 13, 14, 20)', () => {
  const repoWith = (name: string) => {
    const repo = join(tmp, name);
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'a.py'), 'a\n');
    writeFileSync(join(repo, 'src', 'b.py'), 'b\n');
    writeFileSync(join(repo, 'src', 'c.py'), 'c\n');
    writeFileSync(join(repo, 'src', '[x].py'), 'x\n');
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo, stdio: 'ignore' });
    git('init', '-q');
    // the restore checks files out with git: keep them LF whatever the machine's core.autocrlf (true on Windows)
    git('config', 'core.autocrlf', 'false');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    return { repo, git };
  };

  it('a restore never deletes a tracked file, whatever else the run staged', () => {
    const { repo, git } = repoWith('rev-restore');
    const store = join(tmp, 'rev-restore-store');
    const b = snapshotBaseline(repo, store);
    // the run edits and deletes tracked files, stages a new file, renames one, edits a file with a glob character
    writeFileSync(join(repo, 'src', 'a.py'), 'edited\n');
    rmSync(join(repo, 'src', 'b.py'));
    writeFileSync(join(repo, 'staged.txt'), 'staged\n');
    git('add', 'staged.txt');
    git('mv', 'src/c.py', 'src/c2.py');
    writeFileSync(join(repo, 'src', '[x].py'), 'edited\n');
    const changed = restoreBaseline(repo, store, b);
    expect(changed.sort()).toEqual(['src/[x].py', 'src/a.py', 'src/b.py', 'src/c.py', 'src/c2.py', 'staged.txt'].sort());
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })).toBe('');
    expect(readFileSync(join(repo, 'src', 'a.py'), 'utf8')).toBe('a\n');
    expect(readFileSync(join(repo, 'src', 'b.py'), 'utf8')).toBe('b\n');
    expect(readFileSync(join(repo, 'src', 'c.py'), 'utf8')).toBe('c\n');
    expect(readFileSync(join(repo, 'src', '[x].py'), 'utf8')).toBe('x\n');
    expect(existsSync(join(repo, 'staged.txt'))).toBe(false);
  });

  it('a commit or a branch switch by a run is undone: HEAD back on the campaign commit, detached', () => {
    const { repo, git } = repoWith('rev-head');
    const head = worktreeHead(repo);
    git('checkout', '-q', '--detach');
    expect(guardHead(repo, head)).toBeUndefined();
    writeFileSync(join(repo, 'new.txt'), 'n\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'agent commit');
    const moved = guardHead(repo, head);
    expect(moved).toMatch(/^[0-9a-f]{40}$/);
    expect(worktreeHead(repo)).toBe(head);
    // the committed file is now an untracked leftover, for the baseline restore
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })).toBe('?? new.txt\n');
    rmSync(join(repo, 'new.txt'));
    git('checkout', '-q', '-b', 'agent-branch');
    expect(guardHead(repo, head)).toBe(head);
    expect(() => execFileSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: repo, stdio: 'ignore' })).toThrow();
  });

  it('the repository\'s own git hooks never run in the harness\'s git calls', () => {
    const { repo, git } = repoWith('rev-hooks');
    const marker = join(tmp, 'rev-hooks-ran');
    mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(repo, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\necho ran > '${marker}'\n`, { mode: 0o755 });
    const store = join(tmp, 'rev-hooks-store');
    const b = snapshotBaseline(repo, store);
    writeFileSync(join(repo, 'src', 'a.py'), 'edited\n');
    restoreBaseline(repo, store, b);
    expect(existsSync(marker)).toBe(false);
    if (process.platform !== 'win32') {
      git('checkout', '-q', 'HEAD', '--', 'src/a.py');
      expect(existsSync(marker)).toBe(true);
    }
  });

  it('MCP servers committed in the repository are stripped (arm B keeps kopt only)', () => {
    const dir = join(tmp, 'rev-mcp');
    mkdirSync(join(dir, '.kiro', 'settings'), { recursive: true });
    writeFileSync(join(dir, '.kiro', 'settings', 'mcp.json'), JSON.stringify({ mcpServers: { jira: { command: 'jira-mcp' }, kopt: { command: 'node' } }, other: 1 }));
    expect(stripRepoMcpServers(dir, 'kopt')).toEqual(['jira']);
    expect(JSON.parse(readFileSync(join(dir, '.kiro', 'settings', 'mcp.json'), 'utf8'))).toEqual({ mcpServers: { kopt: { command: 'node' } }, other: 1 });
    expect(stripRepoMcpServers(dir)).toEqual(['kopt']);
    expect(stripRepoMcpServers(join(tmp, 'nothing here'))).toEqual([]);
  });
});

describe('review fixes: environment and platforms (5, 15, 17, 19, 21, 23, 24)', () => {
  it('KOPT_HOME and KOPT_TELEMETRY=1 win over a kopt.config.json committed in the repository', () => {
    const repo = join(tmp, 'rev-config');
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, 'kopt.config.json'), JSON.stringify({ telemetry: { enabled: false }, userDir: '/somewhere/else' }));
    const saved = { home: process.env.KOPT_HOME, tel: process.env.KOPT_TELEMETRY };
    try {
      process.env.KOPT_HOME = join(tmp, 'rev-config-home');
      process.env.KOPT_TELEMETRY = '1';
      expect(loadConfig(repo)).toMatchObject({ userDir: join(tmp, 'rev-config-home'), telemetry: { enabled: true } });
      delete process.env.KOPT_TELEMETRY;
      expect(loadConfig(repo).telemetry.enabled).toBe(false);
    } finally {
      process.env.KOPT_HOME = saved.home;
      if (saved.tel === undefined) delete process.env.KOPT_TELEMETRY;
      else process.env.KOPT_TELEMETRY = saved.tel;
    }
  });

  it('V3 inventory lists permission rules (names only)', () => {
    const home = join(tmp, 'rev-inv-home');
    mkdirSync(join(home, '.kiro', 'settings'), { recursive: true });
    mkdirSync(join(home, '.kiro', 'workspace-roots', 'abc123'), { recursive: true });
    writeFileSync(join(home, '.kiro', 'settings', 'permissions.yaml'), 'rules: []\n');
    writeFileSync(join(home, '.kiro', 'workspace-roots', 'abc123', 'permissions.yaml'), 'rules: []\n');
    expect(userKiroInventory(home).join('\n')).toMatch(/permission rules: settings\/permissions.yaml[\s\S]*1 workspace-roots/);
  });

  it('Windows: verbatim \\\\?\\ paths are hashed too; the profile folder joins %USERPROFILE%', () => {
    const b = bucketCandidates('C:\\Users\\me\\out\\arms\\A\\repo', undefined, 'win32');
    expect(b).toContain(v3Bucket('\\\\?\\C:\\Users\\me\\out\\arms\\A\\repo'));
    const v = bucketCandidates('\\\\?\\C:\\x\\repo', undefined, 'win32');
    expect(v).toContain(v3Bucket('C:\\x\\repo'));
    expect(userHomesOf({ HOME: '/home/me' }, 'linux')).toEqual(['/home/me']);
  });

  it('under the test runner no kiro-cli but the simulator or a temporary fixture is ever started', async () => {
    const real = { command: '/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli-chat', prefix: [], display: 'kiro-cli-chat' };
    expect(startableUnderTests(real)).toBe(false);
    expect(startableUnderTests({ command: '/home/me/.local/bin/kiro-cli-chat', prefix: [], display: 'kiro-cli-chat' })).toBe(false);
    expect(startableUnderTests(real, {})).toBe(true);
    expect(startableUnderTests({ command: process.execPath, prefix: [process.env.KIRO_CLI!], display: 'sim' })).toBe(true);
    expect(startableUnderTests({ command: join(tmp, 'kiro-cli-chat'), prefix: [], display: 'fixture' })).toBe(true);
    await expect(kiroCall(real, ['whoami'], { cwd: tmp, env: {} })).rejects.toThrow(/refusing to start kiro-cli-chat under the test runner/);
  });

  it('Windows hooks use the absolute Node when it needs no quoting', () => {
    expect(hookPrefix('C:\\nodejs\\node.exe', 'C:\\kopt\\dist\\bin.js', {}, 'win32')).toBe('C:\\nodejs\\node.exe C:\\kopt\\dist\\bin.js');
    expect(hookPrefix('C:\\Program Files\\nodejs\\node.exe', 'C:\\kopt\\dist\\bin.js', {}, 'win32')).toMatch(/^node /);
    expect(hookPrefix('/opt/node/bin/node', '/k/bin.js', {}, 'linux')).toBe('/opt/node/bin/node /k/bin.js');
  });

  it.runIf(process.platform === 'win32')('which() on Windows skips an extensionless shim and finds the .exe', () => {
    const dir = join(tmp, 'rev-which');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'kiro-cli-chat'), '#!/bin/sh\n');
    writeFileSync(join(dir, 'kiro-cli-chat.exe'), '');
    expect(which('kiro-cli-chat', { platform: 'win32', env: { PATH: dir, PATHEXT: '.EXE;.CMD' }, home: dir })).toBe(join(dir, 'kiro-cli-chat.exe'));
  });

  it('one harness process per output directory: a live holder is refused, a dead one replaced', async () => {
    const out = join(tmp, 'rev-lock');
    const release = acquireLock(out, 'test');
    expect(JSON.parse(readFileSync(join(out, 'lock.json'), 'utf8')).pid).toBe(process.pid);
    release();
    expect(existsSync(join(out, 'lock.json'))).toBe(false);
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    try {
      writeFileSync(join(out, 'lock.json'), JSON.stringify({ pid: holder.pid, host: (await import('node:os')).hostname(), what: 'campaign', at: 'now' }));
      expect(() => acquireLock(out, 'check')).toThrow(/in use by another kopt bench ab \(campaign/);
    } finally {
      holder.kill();
    }
    await new Promise((r) => holder.on('exit', r));
    acquireLock(out, 'check')();
  });

  it('the test suite talks to the simulator only', () => {
    expect(process.env.KIRO_CLI).toMatch(/fake-kiro-cli\.mjs$/);
    expect(process.env.HOME).toContain(process.env.KOPT_VITEST_SANDBOX!);
    expect(isSimulator({ command: process.execPath, prefix: [process.env.KIRO_CLI!], display: process.env.KIRO_CLI! })).toBe(true);
    expect(isSimulator({ command: '/Users/me/.local/bin/kiro-cli-chat', prefix: [], display: 'kiro-cli-chat' })).toBe(false);
  });

  it('smoke prompts ask for exactly one tool call and a one-word answer', () => {
    expect(smokePrompt('kopt', 'src/a.py')).toMatch(/^Call the kopt_read tool exactly once with target "src\/a.py", mode "outline" and maxTokens 200\..*single word OK\.$/);
    expect(smokePrompt('builtin', 'src/a.py')).toMatch(/Read the first 20 lines of the file "src\/a.py" exactly once.*single word OK\.$/);
  });
});
