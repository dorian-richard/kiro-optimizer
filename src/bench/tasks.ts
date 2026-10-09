// Task files: loading, validation and mechanical re-verification of gold items against a checkout.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defSignature } from './metrics.js';
import type { BenchTask, TaskFile, TaskKind } from './types.js';

const KINDS: ReadonlySet<TaskKind> = new Set(['locate', 'explain', 'usage', 'impact']);

export function loadTaskFile(path: string): TaskFile {
  const data = JSON.parse(readFileSync(path, 'utf8')) as TaskFile;
  const problems = validateTaskFile(data);
  if (problems.length) throw new Error(`invalid task file ${path}:\n  ${problems.join('\n  ')}`);
  return data;
}

/** Structural checks only (no checkout needed). */
export function validateTaskFile(data: TaskFile): string[] {
  const out: string[] = [];
  if (!data?.repo?.name) out.push('repo.name is required');
  if (!Array.isArray(data?.tasks)) return [...out, 'tasks must be an array'];
  const ids = new Set<string>();
  for (const t of data.tasks) {
    const where = `task ${t?.id ?? '?'}`;
    if (!t.id) out.push(`${where}: id is required`);
    else if (ids.has(t.id)) out.push(`${where}: duplicate id`);
    ids.add(t.id);
    if (!KINDS.has(t.kind)) out.push(`${where}: kind must be locate|explain|usage|impact`);
    if (!t.question?.trim()) out.push(`${where}: question is required`);
    if (!t.verifiedBy?.trim()) out.push(`${where}: verifiedBy is required`);
    if (!Array.isArray(t.gold?.files) || !Array.isArray(t.gold?.symbols)) out.push(`${where}: gold.files and gold.symbols are required`);
    else if (!t.gold.files.length && !t.gold.symbols.length) out.push(`${where}: empty gold`);
    for (const s of t.gold?.symbols ?? []) {
      if (!s.name || !s.file || !(s.line > 0)) out.push(`${where}: gold symbol needs name, file, line`);
    }
  }
  return out;
}

export interface VerifyIssue {
  taskId: string;
  message: string;
}

/**
 * Check every gold item against the checkout: files exist, each symbol's line contains the name as an
 * identifier, and each symbol's file is listed in gold.files.
 */
export function verifyTasks(repoRoot: string, tasks: BenchTask[]): VerifyIssue[] {
  const issues: VerifyIssue[] = [];
  const cache = new Map<string, string[] | undefined>();
  const lines = (p: string) => {
    if (!cache.has(p)) {
      const abs = join(repoRoot, p);
      cache.set(p, existsSync(abs) ? readFileSync(abs, 'utf8').split('\n') : undefined);
    }
    return cache.get(p);
  };
  for (const t of tasks) {
    for (const f of t.gold.files) if (!lines(f)) issues.push({ taskId: t.id, message: `gold file missing: ${f}` });
    for (const s of t.gold.symbols) {
      const ls = lines(s.file);
      if (!ls) {
        issues.push({ taskId: t.id, message: `symbol file missing: ${s.file}` });
        continue;
      }
      const line = ls[s.line - 1];
      if (line === undefined || !defSignature(line, s.name)) {
        issues.push({ taskId: t.id, message: `${s.name} not found at ${s.file}:${s.line} (line: ${JSON.stringify((line ?? '').trim().slice(0, 80))})` });
      }
      if (!t.gold.files.includes(s.file)) issues.push({ taskId: t.id, message: `symbol file ${s.file} not listed in gold.files` });
    }
  }
  return issues;
}

/** Definition signatures of gold symbols, keyed `file:line` (see metrics.computeRecall). */
export function goldDefSignatures(repoRoot: string, tasks: BenchTask[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const cache = new Map<string, string[]>();
  for (const t of tasks) {
    for (const s of t.gold.symbols) {
      const key = `${s.file}:${s.line}`;
      if (out.has(key)) continue;
      let ls = cache.get(s.file);
      if (!ls) {
        const abs = join(repoRoot, s.file);
        ls = existsSync(abs) ? readFileSync(abs, 'utf8').split('\n') : [];
        cache.set(s.file, ls);
      }
      const sig = ls[s.line - 1] !== undefined ? defSignature(ls[s.line - 1], s.name) : undefined;
      if (sig) out.set(key, sig);
    }
  }
  return out;
}
