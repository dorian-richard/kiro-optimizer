// One run directory -> one RunRecord. Pure function of the files the run left (stream.jsonl, stderr.log,
// session/**, kopt-home/telemetry/*.jsonl, started.json, exit.json), so `kopt bench ab report --reparse` can rebuild
// every record after a parser fix without spending a credit.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gradeAnswer } from './grade.js';
import { classifyRun, isDenied, isKoptCall, isKoptToolName, parseSessionFiles, parseStream, parseTelemetry, round, stderrWarnings } from './parse.js';
import { FATAL_ERRORS, type AbTask, type Arm, type Engine, type ErrorKind, type RunRecord } from './types.js';

export interface StartedMeta {
  runId: string;
  idx: number;
  task: string;
  kind: string;
  arm: Arm;
  rep: number;
  order: number;
  smoke: boolean;
  engine: Engine;
  model: string;
  startedAt: string;
  startMs: number;
  koptArm: boolean;
  /** Per-run wall-clock limit (seconds) the run was started with. */
  timeoutS?: number;
  /** kiro-cli version the run was started with. */
  kiroVersion?: string;
}

export interface ExitInfo {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  ms: number;
  spawnError?: string;
  dirtyAfter?: string[];
  /** The harness stopped before the run finished (no exit.json was written). */
  aborted?: boolean;
  /** The harness killed the run because its metered credits reached the budget (reason). */
  budgetKill?: string;
  /** Credits the live meter saw in the stream when the run ended. */
  metered?: number;
  /** HEAD of the worktree after the run, when the run moved it (it was reset). */
  headMoved?: string;
}

function readIf(p: string): string {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

function filesUnder(dir: string, re: RegExp, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) filesUnder(p, re, out);
    else if (re.test(n) && st.size < 256 * 1024 * 1024) out.push(p);
  }
  return out;
}

export function buildRecord(runDir: string, meta: StartedMeta, exit: ExitInfo | undefined, task: AbTask | undefined, passRatio: number): RunRecord {
  const streamText = readIf(join(runDir, 'stream.jsonl'));
  const stderr = readIf(join(runDir, 'stderr.log'));
  const stream = parseStream(streamText);
  const session = parseSessionFiles(filesUnder(join(runDir, 'session'), /\.(json|jsonl)$/i).map((p) => [p, readIf(p)] as [string, string]));
  const telemetry = parseTelemetry(filesUnder(join(runDir, 'kopt-home', 'telemetry'), /\.jsonl$/i).map(readIf));
  const ex: ExitInfo = exit ?? { code: null, signal: null, timedOut: false, ms: 0, aborted: true };

  const warnings = stderrWarnings(stderr);
  if (stream.finalTextTruncated) warnings.push('finalText truncated by kiro-cli: graded on the truncated text');
  if (stream.refusal) warnings.push('the model refused (part of) the request');
  if (stream.interrupted) warnings.push('the run reports an interruption');
  if (stream.badLines) warnings.push(`${stream.badLines} malformed stream line(s) skipped`);

  // tools
  const toolsByName: Record<string, number> = {};
  for (const t of stream.toolCalls) toolsByName[t.name] = (toolsByName[t.name] ?? 0) + 1;
  let toolCalls = stream.toolCalls.length;
  if (!toolCalls && session.toolCalls) {
    toolCalls = session.toolCalls;
    Object.assign(toolsByName, session.toolNames);
  }
  const usedTools = Object.keys(stream.usedTools).length ? stream.usedTools : session.usedTools;
  // kopt calls in Kiro's own records: only COMPLETED calls count (a failed or refused call never reached kopt's
  // code). The session files and usage summaries carry no status: they are a fallback when the stream has no tool
  // events at all.
  const koptInStream = stream.toolCalls.filter(isKoptCall);
  const koptCompleted = koptInStream.filter((t) => t.status === 'completed').length;
  const koptFailed = koptInStream.filter((t) => t.status === 'failed' || isDenied(t)).length;
  const koptStream = stream.toolCalls.length
    ? koptCompleted
    : Math.max(
        Object.entries(session.toolNames).filter(([n]) => isKoptToolName(n)).reduce((a, [, c]) => a + c, 0),
        Object.entries(usedTools).filter(([n]) => isKoptToolName(n)).reduce((a, [, c]) => a + c, 0),
      );
  // the proof that a kopt arm used kopt is kopt's own telemetry (one line per MCP tool call it served); the
  // control arm is judged on both: any kopt telemetry, or a completed call of a kopt tool
  const koptCalls = meta.koptArm ? telemetry.toolCalls : Math.max(koptStream, telemetry.toolCalls);

  // credits: session file first, stream otherwise; both recorded
  const creditsStream = stream.creditsTurnCompletion ?? stream.creditsMetering;
  const creditsSession = session.credits;
  let credits: number | undefined;
  let creditsSource: RunRecord['creditsSource'];
  if (creditsSession !== undefined && creditsSession > 0) [credits, creditsSource] = [creditsSession, 'session'];
  else if (creditsStream !== undefined && creditsStream > 0) [credits, creditsSource] = [creditsStream, 'stream'];
  const creditsMismatch =
    creditsSession !== undefined && creditsStream !== undefined && creditsSession > 0 && creditsStream > 0 &&
    Math.abs(creditsSession - creditsStream) / Math.max(creditsSession, creditsStream) > 0.05;
  if (creditsMismatch) warnings.push(`stream credits ${creditsStream} vs session credits ${creditsSession}`);

  const answer = stream.finalText ?? (stream.lastTurnText || stream.allChunksText || session.lastAssistantText || '');
  const answerSource = stream.finalText !== undefined ? 'stream:finalText' : stream.lastTurnText ? 'stream:chunks' : stream.allChunksText ? 'stream:chunks' : session.lastAssistantText ? 'session' : '';

  // validity
  const cls = classifyRun({ exitCode: ex.code, timedOut: ex.timedOut, spawnError: ex.spawnError, stderr, stream, aborted: ex.aborted, budgetKill: ex.budgetKill });
  let errorKind: ErrorKind | undefined = cls.errorKind;
  let errorDetail = cls.detail;
  if (!errorKind && !meta.koptArm && (koptStream > 0 || telemetry.lines > 0)) {
    errorKind = 'kopt_leak';
    errorDetail = `the control arm reached kopt (${koptStream} completed kopt tool call(s) in Kiro's records, ${telemetry.lines} kopt telemetry line(s))`;
  }
  if (!errorKind && credits === undefined) {
    const metered = creditsSession !== undefined || creditsStream !== undefined;
    errorKind = metered ? 'zero_credits' : 'no_credits';
    errorDetail = metered
      ? `Kiro metered this run at 0 credits (stream ${creditsStream ?? 'none'}, session ${creditsSession ?? 'none'}): the metering was found and parsed, the amount is 0 (a tiny answer on a cheap model can round to 0)`
      : `no credit found: stream ${creditsStream === undefined ? 'has no metering event' : `total ${creditsStream}`}, session files: ${session.files}${creditsSession === undefined ? '' : ` (total ${creditsSession})`}`;
  }
  if (!errorKind && !answer.trim()) {
    errorKind = 'no_answer';
    errorDetail = 'no final answer in the stream or the session files';
  }
  const valid = !errorKind;
  let koptFlag: string | undefined;
  if (meta.koptArm && !meta.smoke && valid && telemetry.toolCalls === 0) {
    koptFlag =
      koptStream > 0
        ? `${koptStream} kopt call(s) completed in Kiro's records but none in kopt's telemetry (the kopt MCP server did not write to this run's KOPT_HOME)`
        : koptFailed > 0
          ? `every kopt tool call failed or was refused (${koptFailed})`
          : 'no kopt tool call in this run';
  }
  if (koptFailed) warnings.push(`${koptFailed} kopt tool call(s) failed or were refused (not counted as kopt usage)`);

  const grade = meta.smoke ? undefined : gradeAnswer(answer, task?.gold, passRatio);

  return {
    runId: meta.runId,
    idx: meta.idx,
    task: meta.task,
    kind: meta.kind,
    arm: meta.arm,
    rep: meta.rep,
    order: meta.order,
    smoke: meta.smoke,
    engine: meta.engine,
    model: meta.model,
    startedAt: meta.startedAt,
    wallMs: ex.ms,
    exitCode: ex.code,
    signal: ex.signal,
    timedOut: ex.timedOut,
    valid,
    ...(errorKind ? { invalidReason: errorKind, errorKind, errorDetail } : {}),
    ...(credits !== undefined ? { credits: round(credits), creditsSource } : {}),
    ...(creditsStream !== undefined ? { creditsStream } : {}),
    ...(creditsSession !== undefined ? { creditsSession } : {}),
    creditsMismatch,
    ...(stream.turnCompletions || session.turns !== undefined ? { turns: stream.turnCompletions || session.turns } : {}),
    ...(session.requests !== undefined || stream.requestIds.length ? { requests: session.requests ?? stream.requestIds.length } : {}),
    toolCalls,
    toolsByName,
    usedTools,
    koptCalls,
    koptCallsStream: koptStream,
    koptCallsTelemetry: telemetry.toolCalls,
    ...(koptFailed ? { koptCallsFailed: koptFailed } : {}),
    koptHookEvents: telemetry.hookEvents + telemetry.sessionEvents,
    ...(koptFlag ? { koptFlag } : {}),
    ...(stream.ctxPctMax !== undefined || session.ctxPctMax !== undefined ? { ctxPctMax: session.ctxPctMax ?? stream.ctxPctMax } : {}),
    answerChars: answer.length,
    answerSource,
    ...(grade ? { grade } : {}),
    ...(stream.sessionId ? { sessionId: stream.sessionId } : {}),
    streamLines: stream.lines,
    streamBadLines: stream.badLines,
    warnings,
    dirtyAfter: !!ex.dirtyAfter?.length || !!ex.headMoved,
    ...(ex.headMoved ? { headMoved: true } : {}),
    ...(meta.kiroVersion ? { kiroVersion: meta.kiroVersion } : {}),
    ...(meta.timeoutS !== undefined ? { timeoutS: meta.timeoutS } : {}),
  };
}

export function isFatal(r: RunRecord): boolean {
  return !!r.errorKind && FATAL_ERRORS.has(r.errorKind);
}

/** The answer text of a run (written to answer.md for manual grading), same precedence as buildRecord. */
export function answerText(runDir: string): string {
  const stream = parseStream(readIf(join(runDir, 'stream.jsonl')));
  if (stream.finalText !== undefined) return stream.finalText;
  if (stream.lastTurnText || stream.allChunksText) return stream.lastTurnText || stream.allChunksText;
  const session = parseSessionFiles(filesUnder(join(runDir, 'session'), /\.(json|jsonl)$/i).map((p) => [p, readIf(p)] as [string, string]));
  return session.lastAssistantText ?? '';
}
