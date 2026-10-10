// A/B task files: JSON or YAML. Simple format (bench/ab/tasks.example.json):
//
//   { "tasks": [ { "id": "refund-total", "kind": "locate", "prompt": "Where is ...?",
//                  "gold": { "files": ["billing/refunds.py"], "symbols": ["compute_refund"] } } ] }
//
// A top-level array of tasks is accepted too. The offline benchmark's task files (bench/tasks/<repo>.json:
// `question`, gold symbols as {name, file, line}) load unchanged.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import type { AbGold, AbTask, AbTaskFile } from './types.js';
import { parseYaml } from './yaml.js';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

function asStringList(x: unknown, where: string, problems: string[]): string[] {
  if (x === undefined || x === null) return [];
  if (!Array.isArray(x)) {
    problems.push(`${where} must be a list`);
    return [];
  }
  const out: string[] = [];
  for (const v of x) {
    if (typeof v === 'string' && v.trim()) out.push(v.trim());
    else if (v && typeof v === 'object' && typeof (v as { name?: unknown }).name === 'string') out.push(String((v as { name: string }).name).trim());
    else problems.push(`${where}: every entry must be a non-empty string`);
  }
  return [...new Set(out)];
}

/** Structural validation; returns the normalized file and the list of problems (empty = valid). */
export function normalizeTaskFile(data: unknown): { file: AbTaskFile; problems: string[] } {
  const problems: string[] = [];
  const raw = Array.isArray(data) ? { tasks: data } : (data as Record<string, unknown> | null);
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.tasks)) {
    return { file: { tasks: [] }, problems: ['the file must contain a "tasks" list (or be a list of tasks)'] };
  }
  const tasks: AbTask[] = [];
  const ids = new Set<string>();
  (raw.tasks as unknown[]).forEach((t, i) => {
    const where = `task #${i + 1}`;
    if (!t || typeof t !== 'object' || Array.isArray(t)) {
      problems.push(`${where}: must be an object`);
      return;
    }
    const o = t as Record<string, unknown>;
    const id = typeof o.id === 'string' || typeof o.id === 'number' ? String(o.id).trim() : '';
    const label = id ? `task ${id}` : where;
    if (!id) problems.push(`${where}: "id" is required`);
    else if (!ID_RE.test(id)) problems.push(`${label}: id must be 1-80 characters among letters, digits, ".", "_" and "-"`);
    else if (ids.has(id)) problems.push(`${label}: duplicate id`);
    ids.add(id);
    const promptRaw = o.prompt ?? o.question;
    const prompt = typeof promptRaw === 'string' ? promptRaw.trim() : '';
    if (!prompt) problems.push(`${label}: "prompt" is required (a non-empty string)`);
    const kind = o.kind === undefined || o.kind === null ? undefined : String(o.kind).trim() || undefined;
    let gold: AbGold | undefined;
    if (o.gold !== undefined && o.gold !== null) {
      if (typeof o.gold !== 'object' || Array.isArray(o.gold)) problems.push(`${label}: "gold" must be an object with "files" and/or "symbols"`);
      else {
        const g = o.gold as Record<string, unknown>;
        const files = asStringList(g.files, `${label}: gold.files`, problems).map((f) => f.replace(/\\/g, '/').replace(/^\.\//, ''));
        const symbols = asStringList(g.symbols, `${label}: gold.symbols`, problems);
        if (!files.length && !symbols.length) problems.push(`${label}: "gold" is empty (give files and/or symbols, or remove it for manual grading)`);
        else gold = { files, symbols };
      }
    }
    tasks.push({ id, prompt, ...(kind ? { kind } : {}), ...(gold ? { gold } : {}) });
  });
  if (!tasks.length && !problems.length) problems.push('the task list is empty');
  let passRatio: number | undefined;
  if (raw.passRatio !== undefined) {
    const n = Number(raw.passRatio);
    if (!(n > 0 && n <= 1)) problems.push('"passRatio" must be a number in (0, 1]');
    else passRatio = n;
  }
  return { file: { tasks, ...(passRatio !== undefined ? { passRatio } : {}) }, problems };
}

export function parseTaskText(text: string, path: string): unknown {
  const ext = extname(path).toLowerCase();
  if (ext === '.yaml' || ext === '.yml') return parseYaml(text);
  if (ext === '.json') return JSON.parse(text.replace(/^﻿/, ''));
  // unknown extension: JSON first, then YAML
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return parseYaml(text);
  }
}

export function loadAbTasks(path: string): AbTaskFile & { sha256: string } {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`cannot read the task file ${path}: ${(err as Error).message}`);
  }
  let data: unknown;
  try {
    data = parseTaskText(text, path);
  } catch (err) {
    throw new Error(`invalid task file ${path}: ${(err as Error).message}`);
  }
  const { file, problems } = normalizeTaskFile(data);
  if (problems.length) throw new Error(`invalid task file ${path}:\n  ${problems.join('\n  ')}`);
  return { ...file, sha256: createHash('sha256').update(JSON.stringify(file)).digest('hex') };
}

/** Text appended to every prompt, identical in all arms: makes answers gradable and keeps the agent read-only. */
export const DEFAULT_PROMPT_SUFFIX =
  'Do not modify any file. Answer concisely and name the exact files (repo-relative paths) and the functions, classes or methods involved.';

export function buildPrompt(task: AbTask, suffix: string = DEFAULT_PROMPT_SUFFIX): string {
  return suffix ? `${task.prompt.trim()}\n\n${suffix}` : task.prompt.trim();
}

/** What every smoke prompt ends with (the answer is one word: a handful of output tokens). */
export const SMOKE_ANSWER = 'Then reply with the single word OK.';

/**
 * The smoke prompt of an arm: exactly one cheap tool call, so the smoke run proves the arm's tool trust end to end
 * (`agent validate` only checks the JSON shape): a built-in read of a small file in the control arm, one
 * kopt_read outline of the same file (or of the repository) in a kopt arm.
 */
export function smokePrompt(kind: 'builtin' | 'kopt', file: string | undefined): string {
  if (kind === 'kopt') {
    return `Call the kopt_read tool exactly once with target "${file ?? '.'}", mode "outline" and maxTokens 200. Do not use any other tool. ${SMOKE_ANSWER}`;
  }
  return file
    ? `Read the first 20 lines of the file "${file}" exactly once with your file reading tool. Do not use any other tool. ${SMOKE_ANSWER}`
    : `List the files of the current directory exactly once with your file reading tool. Do not use any other tool. ${SMOKE_ANSWER}`;
}
