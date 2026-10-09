// Jest and Vitest. Success -> one summary line. Failure -> per failing test: message, expected/received,
// the failing source line, up to 3 in-repo stack frames; console output, code-frame context, passing files dropped.

import { runs } from '../command.js';
import { dedent, isFrameLine, isLibraryFrame, layout, trimStack, type Block, type Filter, type FilterInput } from './common.js';

const MAX_MESSAGE_LINES = 18;

/** Message lines + `> failing line` + trimmed frames from a jest/vitest failure body. */
function digestBody(body: string[], frameRe?: RegExp): { lines: string[]; key: string } {
  const lines = dedent(body);
  const msg: string[] = [];
  const frames: string[] = [];
  let failing: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    // jest code frame: `  12 |   code`, `> 14 |   code`, `     |   ^`
    const jestCode = /^\s*(>)?\s*\d+\s*\|(.*)$/.exec(l);
    if (jestCode) {
      if (jestCode[1]) failing = jestCode[2].trim();
      continue;
    }
    // vitest code frame: `14|   code` followed by `  |   ^`
    if (/^\s*\|\s*\^/.test(l)) {
      const prev = /^\s*\d+\|(.*)$/.exec(lines[i - 1] ?? '');
      if (prev) failing = prev[1].trim();
      continue;
    }
    if (frameRe?.test(l)) {
      frames.push(l.trim());
      continue;
    }
    if (isFrameLine(l)) {
      frames.push(l.trim());
      continue;
    }
    msg.push(l);
  }
  const keptMsg = msg.length > MAX_MESSAGE_LINES ? [...msg.slice(0, MAX_MESSAGE_LINES), `… ${msg.length - MAX_MESSAGE_LINES} more lines`] : msg;
  let keptFrames: string[];
  if (frameRe) {
    const repo = frames.filter((f) => !/node_modules|node:|\(internal\//.test(f));
    keptFrames = (repo.length ? repo : frames).slice(0, 3);
  } else {
    keptFrames = trimStack(frames.map((f) => `at ${f.replace(/^at\s+/, '')}`), 3, false);
  }
  const out = [...keptMsg.map((l) => `  ${l}`), ...(failing ? [`  > ${failing}`] : []), ...keptFrames.map((f) => `  ${f}`)];
  const firstRepo = frames.find((f) => !isLibraryFrame(f.startsWith('at ') ? f : `at ${f}`) && !/node_modules|node:/.test(f)) ?? '';
  return { lines: out, key: `${msg.slice(0, 4).join('\n')}|${firstRepo}` };
}

// ---------------------------------------------------------------------------------------------------------------
// Jest

const JEST_FILE_RE = /^(PASS|FAIL)\s+(\S.*?)(?:\s+\([\d.]+ m?s\))?$/;
const JEST_BULLET_RE = /^ {2}● (.+)$/;
const JEST_SUMMARY_RE = /^(Test Suites|Tests|Snapshots|Time):\s+(.*)$/;

function compressJest(inp: FilterInput): string | undefined {
  const { lines, maxTokens } = inp;
  const summary = new Map<string, string>();
  const notes: string[] = [];
  const blocks: Block[] = [];
  const failFiles: string[] = [];
  let file = '';
  let cur: { title: string; body: string[] } | undefined;
  let done = false;
  const close = () => {
    if (!cur) return;
    const d = digestBody(cur.body);
    blocks.push({ title: cur.title, lines: d.lines, key: d.key });
    cur = undefined;
  };
  for (const line of lines) {
    const sm = JEST_SUMMARY_RE.exec(line);
    if (sm) {
      close();
      summary.set(sm[1], sm[2].trim());
      done = true;
      continue;
    }
    if (/^Summary of all failing tests$/.test(line)) {
      close();
      done = true;
      continue;
    }
    if (/^Jest: .*(?:threshold|not met)/.test(line) || /^\s*●.*(?:obsolete snapshot|has failed to exit)/.test(line)) {
      notes.push(line.trim());
      continue;
    }
    if (done) continue;
    const fm = JEST_FILE_RE.exec(line);
    if (fm) {
      close();
      file = fm[2];
      if (fm[1] === 'FAIL') failFiles.push(file);
      continue;
    }
    const bm = JEST_BULLET_RE.exec(line);
    if (bm) {
      close();
      if (/^Console$/.test(bm[1])) continue;
      cur = { title: `FAIL ${file ? `${file} › ` : ''}${bm[1]}`, body: [] };
      continue;
    }
    if (cur) cur.body.push(line);
  }
  close();
  if (!summary.size && !blocks.length) return undefined;
  const parts = ['Test Suites', 'Tests', 'Snapshots', 'Time']
    .filter((k) => summary.has(k) && (k !== 'Snapshots' || /failed|obsolete|written|updated|removed/.test(summary.get(k)!)))
    .map((k) => `${k}: ${summary.get(k)}`);
  if (!blocks.length && failFiles.length) for (const f of failFiles) blocks.push({ title: `FAIL ${f}`, lines: [] });
  return layout([parts.join(' · ') || `exit ${inp.exitCode}`, ...notes], blocks, maxTokens, 'failures');
}

export const jest: Filter = {
  name: 'jest',
  match(cmd, sample) {
    if (runs(cmd, ['jest']) || runs(cmd, ['react-scripts', 'craco'], ['test'])) return 90;
    if (/^Test Suites: \d+/m.test(sample)) return 70;
    if (/^(?:PASS|FAIL) \S+\.(?:test|spec)\.[jt]sx?\b/m.test(sample)) return 60;
    return 0;
  },
  compress: compressJest,
};

// ---------------------------------------------------------------------------------------------------------------
// Vitest

const VITEST_SUMMARY_RE = /^\s*(Test Files|Tests|Snapshots|Errors|Duration)\s{2,}(.*)$/;
const VITEST_FAIL_RE = /^\s*FAIL\s+(.+)$/;
const VITEST_SEP_RE = /^\s*⎯{3,}/;
const VITEST_FRAME_RE = /^\s*❯ /;

function compressVitest(inp: FilterInput): string | undefined {
  const { lines, maxTokens } = inp;
  const summary = new Map<string, string>();
  const notes: string[] = [];
  const blocks: Block[] = [];
  const crossed: string[] = [];
  let inDetails = false;
  let section = '';
  let titles: string[] = [];
  let body: string[] = [];
  const close = () => {
    if (titles.length || body.some((l) => l.trim())) {
      const d = digestBody(body, VITEST_FRAME_RE);
      const ts = titles.length ? titles : [section || 'error'];
      for (const t of ts) blocks.push({ title: t, lines: d.lines, key: d.key });
    }
    titles = [];
    body = [];
  };
  for (const line of lines) {
    const sm = VITEST_SUMMARY_RE.exec(line);
    if (sm) {
      close();
      inDetails = false;
      summary.set(sm[1], sm[1] === 'Duration' ? sm[2].replace(/\s*\(.*\)$/, '') : sm[2].trim());
      continue;
    }
    if (VITEST_SEP_RE.test(line)) {
      close();
      const name = /⎯\s+(.+?)\s+⎯/.exec(line);
      if (name) {
        inDetails = true;
        section = name[1].replace(/\s+\d+$/, '');
      }
      continue;
    }
    if (/^\s*Vitest caught \d+ unhandled error/.test(line)) {
      notes.push(line.trim());
      continue;
    }
    if (!inDetails) {
      const x = /^\s*(?:×|✗|x)\s+(.+?)(?:\s+\d+m?s)?$/.exec(line);
      if (x && !/^\s*(?:×|✗|x)\s+\d/.test(line)) crossed.push(x[1]);
      continue;
    }
    const fm = VITEST_FAIL_RE.exec(line);
    if (fm) {
      if (body.some((l) => l.trim())) close();
      titles.push(`FAIL ${fm[1].trim()}`);
      continue;
    }
    body.push(line);
  }
  close();
  if (!summary.size && !blocks.length) return undefined;
  if (!blocks.length) for (const c of crossed) blocks.push({ title: `FAIL ${c}`, lines: [] });
  const parts = ['Test Files', 'Tests', 'Snapshots', 'Errors', 'Duration'].filter((k) => summary.has(k)).map((k) => `${k} ${summary.get(k)}`);
  return layout([parts.join(' · ') || `exit ${inp.exitCode}`, ...notes], blocks, maxTokens, 'failures');
}

export const vitest: Filter = {
  name: 'vitest',
  match(cmd, sample) {
    if (runs(cmd, ['vitest'])) return 90;
    if (/^\s*Test Files\s{2,}\d+/m.test(sample)) return 72;
    return 0;
  },
  compress: compressVitest,
};
