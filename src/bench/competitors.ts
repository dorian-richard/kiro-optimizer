// Results of competitor tools (KiroGraph, CodeGraph) produced elsewhere (Docker harness) and scored here with
// the same metrics as the built-in strategies.
//
// File: <dir>/<tool>-<repo>.jsonl (default dir bench/competitors/results), one JSON object per line:
//   { "taskId": "dj-locate-db-cache-cull",   // bench task id
//     "input": "database cache backend ...",  // text given to the tool (search phrase or question)
//     "output": "...",                        // everything the tool returned to the model, concatenated
//     "toolCalls": 2,                         // number of tool calls, or an array of calls (see below)
//     "error": "...", "durationMs": 1234 }    // optional
// toolCalls may also be an array of { tool?, args?, output? | chars? }: per-call sizes are then reported.
// Tokens are always estimateTokens(output), like every other strategy.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { estimateTokens } from '../core/tokens.js';
import { computeRecall } from './metrics.js';
import { EXTERNAL_STRATEGIES, type BenchTask, type ExternalStrategy, type RecallResult, type TaskStrategyResult, type ToolCallRecord } from './types.js';

export interface CompetitorLine {
  taskId: string;
  input?: string;
  output: string;
  toolCalls?: number | Array<{ tool?: string; args?: string; output?: string; chars?: number }>;
  error?: string;
  durationMs?: number;
}

export interface CompetitorFile {
  tool: ExternalStrategy;
  path: string;
  /** Lines grouped by task id (a task may have been run with several inputs). */
  byTask: Map<string, CompetitorLine[]>;
  /** Unparsable / invalid lines (1-based line numbers with the reason). */
  invalid: string[];
}

export function competitorPath(dir: string, tool: ExternalStrategy, repo: string): string {
  return join(dir, `${tool}-${repo}.jsonl`);
}

/** Parses one JSONL file. Invalid lines are reported, never fatal. */
export function parseCompetitorJsonl(text: string): { byTask: Map<string, CompetitorLine[]>; invalid: string[] } {
  const byTask = new Map<string, CompetitorLine[]>();
  const invalid: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    let o: unknown;
    try {
      o = JSON.parse(raw);
    } catch {
      invalid.push(`line ${i + 1}: not JSON`);
      continue;
    }
    const l = o as Partial<CompetitorLine>;
    if (!l || typeof l !== 'object' || typeof l.taskId !== 'string' || !l.taskId) {
      invalid.push(`line ${i + 1}: taskId missing`);
      continue;
    }
    if (typeof l.output !== 'string' && !l.error) {
      invalid.push(`line ${i + 1}: output must be a string`);
      continue;
    }
    const line: CompetitorLine = { taskId: l.taskId, output: typeof l.output === 'string' ? l.output : '' };
    if (typeof l.input === 'string') line.input = l.input;
    if (typeof l.toolCalls === 'number' || Array.isArray(l.toolCalls)) line.toolCalls = l.toolCalls;
    if (typeof l.error === 'string' && l.error) line.error = l.error;
    if (typeof l.durationMs === 'number') line.durationMs = l.durationMs;
    const list = byTask.get(line.taskId) ?? [];
    list.push(line);
    byTask.set(line.taskId, list);
  }
  return { byTask, invalid };
}

/** Competitor result files present for `repo` (none is fine: the strategies are simply not reported). */
export function loadCompetitors(dir: string, repo: string, tools: readonly ExternalStrategy[] = EXTERNAL_STRATEGIES): CompetitorFile[] {
  const out: CompetitorFile[] = [];
  for (const tool of tools) {
    const path = competitorPath(dir, tool, repo);
    if (!existsSync(path)) continue;
    const { byTask, invalid } = parseCompetitorJsonl(readFileSync(path, 'utf8'));
    out.push({ tool, path, byTask, invalid });
  }
  return out;
}

/**
 * The line to score for a task: the one whose input is exactly the text the bench feeds (search phrase or
 * question); else, when the task has a single line, that line (flagged as an input mismatch).
 */
export function pickLine(lines: CompetitorLine[] | undefined, input: string): { line?: CompetitorLine; mismatch: boolean } {
  if (!lines?.length) return { mismatch: false };
  const exact = lines.find((l) => l.input === undefined || l.input === input);
  if (exact) return { line: exact, mismatch: false };
  return lines.length === 1 ? { line: lines[0], mismatch: true } : { mismatch: true };
}

function callRecords(tool: string, line: CompetitorLine): ToolCallRecord[] {
  const tc = line.toolCalls;
  if (Array.isArray(tc) && tc.length) {
    return tc.map((c) => {
      const chars = typeof c.output === 'string' ? c.output.length : typeof c.chars === 'number' ? c.chars : 0;
      return {
        tool: c.tool ?? tool,
        args: c.args ?? '',
        chars,
        tokens: typeof c.output === 'string' ? estimateTokens(c.output) : Math.ceil(chars / 3),
      };
    });
  }
  const n = typeof tc === 'number' && tc > 0 ? Math.round(tc) : 1;
  const rec: ToolCallRecord = { tool, args: line.input ?? '', chars: line.output.length, tokens: estimateTokens(line.output) };
  // only the total is known: one record carrying the whole output, plus empty records for the call count
  return [rec, ...Array.from({ length: n - 1 }, () => ({ tool, args: '', chars: 0, tokens: 0 }))];
}

function emptyRecall(task: BenchTask): RecallResult {
  return { fileRecall: 0, symbolRecall: 0, defRecall: 0, filesMissed: [...task.gold.files], symbolsMissed: task.gold.symbols.map((s) => s.name), found: false };
}

/** Scores one competitor's lines for `task` exactly like a built-in strategy output. */
export function competitorResult(
  file: CompetitorFile,
  task: BenchTask,
  input: string,
  defSigs: Map<string, string[]>,
  keepOutput = false,
): { result: TaskStrategyResult; mismatch: boolean } {
  const base = { taskId: task.id, kind: task.kind, strategy: file.tool } as const;
  const { line, mismatch } = pickLine(file.byTask.get(task.id), input);
  if (!line) {
    const why = mismatch ? `no ${file.tool} result for this input` : `no ${file.tool} result line for this task`;
    return { result: { ...base, skipped: why, tokens: 0, chars: 0, toolCalls: 0, durationMs: 0, recall: emptyRecall(task), calls: [] }, mismatch };
  }
  if (line.error) {
    return {
      result: { ...base, error: line.error.split('\n')[0], tokens: 0, chars: 0, toolCalls: 0, durationMs: line.durationMs ?? 0, recall: emptyRecall(task), calls: [] },
      mismatch,
    };
  }
  const calls = callRecords(file.tool, line);
  return {
    result: {
      ...base,
      tokens: estimateTokens(line.output),
      chars: line.output.length,
      toolCalls: calls.length,
      durationMs: line.durationMs ?? 0,
      recall: computeRecall(line.output, task.gold, defSigs),
      calls,
      ...(keepOutput ? { output: line.output } : {}),
    },
    mismatch,
  };
}
