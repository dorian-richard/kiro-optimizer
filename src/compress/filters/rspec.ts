// RSpec. Success -> `512 examples, 0 failures, 3 pending · Finished in 12.34 seconds`. Failure -> per example the
// `Failure/Error:` line, expected/got (or the exception), up to 3 `./` frames (gems dropped) and its rerun
// location (`rspec ./spec/x_spec.rb:12`); progress dots, the pending list and the seed lines dropped.

import { runs } from '../command.js';
import { layout, lastMatch, type Block, type Filter, type FilterInput } from './common.js';

const VERDICT_RE = /^(\d+ examples?, \d+ failures?(?:, \d+ pending)?(?:, \d+ errors? occurred outside of examples)?)$/;
const FINISHED_RE = /^Finished in (.+?)(?: \(files took .*\))?$/;
const ENTRY_RE = /^ {2}(\d+)\) (.+)$/;
const RERUN_RE = /^rspec (\S+:\d+|\S+\[[\d:]+\]) # (.+)$/;
const FRAME_RE = /^\s*# (\S+?):(\d+)(?::in [`'](.*)')?/;
const MAX_MESSAGE_LINES = 14;

function compressRspec(inp: FilterInput): string | undefined {
  const { lines, maxTokens } = inp;
  const verdict = lastMatch(lines, VERDICT_RE);
  const finished = lastMatch(lines, FINISHED_RE);
  const rerun = new Map<string, string>();
  for (const l of lines) {
    const m = RERUN_RE.exec(l);
    if (m) rerun.set(m[2].trim(), m[1]);
  }
  const blocks: Block[] = [];
  const start = lines.findIndex((l) => /^Failures:\s*$/.test(l));
  const outside = lines.findIndex((l) => /^An error occurred (?:while loading|in a `before\(:suite\)`|outside of examples)/.test(l));
  if (start >= 0) {
    let i = start + 1;
    while (i < lines.length && !FINISHED_RE.test(lines[i]) && !/^Failed examples:/.test(lines[i])) {
      const m = ENTRY_RE.exec(lines[i]);
      if (!m) {
        i++;
        continue;
      }
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length && !ENTRY_RE.test(lines[j]) && !FINISHED_RE.test(lines[j]) && !/^Failed examples:/.test(lines[j]); j++) body.push(lines[j]);
      i = j;
      blocks.push(digest(m[2].trim(), body, rerun.get(m[2].trim())));
    }
  }
  if (outside >= 0 && !blocks.length) {
    const body: string[] = [];
    for (let j = outside + 1; j < lines.length && !VERDICT_RE.test(lines[j]) && !FINISHED_RE.test(lines[j]); j++) body.push(lines[j]);
    blocks.push(digest(lines[outside].trim(), body));
  }
  if (!verdict && !blocks.length) return undefined;
  const head = [verdict?.[1], finished ? `Finished in ${finished[1]}` : undefined].filter(Boolean).join(' · ');
  return layout([head || `exit ${inp.exitCode}`], blocks, maxTokens, 'failures');
}

function digest(title: string, body: string[], where?: string): Block {
  const msg: string[] = [];
  const frames: string[] = [];
  let firstRepo = '';
  for (const raw of body) {
    const l = raw.trimEnd();
    if (!l.trim()) continue;
    const f = FRAME_RE.exec(l);
    if (f) {
      const lib = !/^\.\//.test(f[1]) || /\/(?:gems|vendor|ruby\/\d)\//.test(f[1]);
      if (!lib) {
        const fn = f[3]?.replace(/^block (?:\(\d+ levels?\) )?in /, '');
        const loc = `${f[1].replace(/^\.\//, '')}:${f[2]}${fn && !/^<(?:top \(required\)|main)>$/.test(fn) ? ` in ${fn}` : ''}`;
        if (!firstRepo) firstRepo = loc;
        if (frames.length < 3) frames.push(loc);
      }
      continue;
    }
    if (/^\s*\(compared using .*\)$/.test(l) || /^\s*# --- Caused by: ---$/.test(l)) continue;
    msg.push(l.trim());
  }
  const keptMsg = msg.length > MAX_MESSAGE_LINES ? [...msg.slice(0, MAX_MESSAGE_LINES), `… ${msg.length - MAX_MESSAGE_LINES} more lines`] : msg;
  const lines = [...keptMsg.map((l) => `  ${l}`), ...frames.map((f) => `  at ${f}`)];
  if (where) lines.push(`  rerun: rspec ${where}`);
  return { title: `FAILED ${title}`, lines, key: `${msg.filter((l) => !/^Failure\/Error:/.test(l)).slice(0, 3).join('\n')}|${firstRepo}` };
}

export const rspec: Filter = {
  name: 'rspec',
  match(cmd, sample) {
    if (runs(cmd, ['rspec'])) return 90;
    if (/^\d+ examples?, \d+ failures?/m.test(sample)) return 70;
    return 0;
  },
  compress: compressRspec,
};
