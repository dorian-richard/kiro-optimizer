// Result files are committed and published, so they must not carry machine-specific absolute paths
// (home directories, temp folders, private index dirs). Paths inside the project become repo-relative,
// everything else is reduced to a placeholder plus its meaningful tail. Only absolute paths that start a
// token are touched, so relative paths and other text (e.g. PHP namespaces) are never rewritten.

import { homedir, tmpdir } from 'node:os';
import { realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const START = '(?<=^|[\\s"\'(=`])';
const PATH_CHARS = '[^\\s"\'`|)]';
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function variants(p: string): string[] {
  const out = new Set<string>([p]);
  try {
    out.add(realpathSync(p));
  } catch {
    // keep the plain path
  }
  return [...out].map((x) => x.replace(/\/+$/, '')).filter((x) => x.length > 1);
}

/** Rewrites absolute paths in `text` so the file is portable between machines. */
export function portablePaths(text: string, projectRoot: string): string {
  let out = text;
  // Anything under a benchmark checkout or result folder is named relative to the project,
  // wherever the checkout or worktree actually lives.
  out = out.replace(new RegExp(`${START}/${PATH_CHARS}*?/(bench/(?:repos|competitors|results|tasks)/)`, 'gm'), '$1');
  for (const root of variants(projectRoot)) out = out.replace(new RegExp(`${START}${escape(root)}/`, 'gm'), '');
  // Private index dirs and other temp folders: keep only the meaningful tail.
  const temps = [...variants(tmpdir()), '/private/tmp', '/private/var/folders', '/var/folders', '/tmp'];
  for (const t of temps) {
    out = out.replace(new RegExp(`${START}${escape(t)}/${PATH_CHARS}*?/(\\.kopt-${PATH_CHARS}+)`, 'gm'), '<index-dir>/$1');
    out = out.replace(new RegExp(`${START}${escape(t)}/${PATH_CHARS}+`, 'gm'), '<tmp>');
  }
  for (const h of variants(homedir())) out = out.replace(new RegExp(`${START}${escape(h)}(?=/)`, 'gm'), '~');
  return out;
}

/** writeFileSync for committed result files: absolute machine paths are made portable first. */
export function writePortable(path: string, text: string): void {
  writeFileSync(path, portablePaths(text, PROJECT_ROOT));
}
