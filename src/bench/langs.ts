// bench/langs.json: one representative repository per language (the multi-language corpus).

import { readFileSync } from 'node:fs';
import type { LangRepo, LangsFile } from './types.js';

const LANG_IDS = new Set(['typescript', 'tsx', 'javascript', 'python', 'java', 'c_sharp', 'go', 'kotlin', 'rust', 'php', 'ruby', 'scala']);

export function validateLangsFile(data: LangsFile): string[] {
  const out: string[] = [];
  if (data?.version !== 1) out.push('version must be 1');
  if (!Array.isArray(data?.repos)) return [...out, 'repos must be an array'];
  const names = new Set<string>();
  for (const r of data.repos) {
    const where = `repo ${r?.name ?? '?'}`;
    if (!r?.name || !/^[\w.-]+$/.test(r.name)) out.push(`${where}: name must be a simple file name`);
    else if (names.has(r.name)) out.push(`${where}: duplicate name`);
    names.add(r?.name);
    if (!LANG_IDS.has(r?.language)) out.push(`${where}: unknown language ${r?.language}`);
    for (const l of r?.otherLanguages ?? []) if (!LANG_IDS.has(l)) out.push(`${where}: unknown language ${l}`);
    for (const k of ['url', 'tag', 'commit', 'license', 'reason'] as const) if (!r?.[k]) out.push(`${where}: ${k} is required`);
    if (r?.commit && !/^[0-9a-f]{40}$/.test(r.commit)) out.push(`${where}: commit must be a full sha1`);
    if (!(r?.loc > 0) || !(r?.files > 0)) out.push(`${where}: files and loc must be positive`);
  }
  return out;
}

export function loadLangsFile(path: string): LangsFile {
  const data = JSON.parse(readFileSync(path, 'utf8')) as LangsFile;
  const problems = validateLangsFile(data);
  if (problems.length) throw new Error(`invalid ${path}:\n  ${problems.join('\n  ')}`);
  return data;
}

export function findLangRepo(file: LangsFile, name: string): LangRepo | undefined {
  return file.repos.find((r) => r.name === name);
}
