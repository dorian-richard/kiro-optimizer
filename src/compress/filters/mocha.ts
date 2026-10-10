// Mocha (spec/dot reporters). Success -> `N passing (2s) · M pending`. Failure -> per `N) suite title:` block the
// error message, the assertion diff and up to 3 in-repo frames; the passing-test tree is dropped.

import { runs } from '../command.js';
import { dedent, layout, lastMatch, trimStack, type Block, type Filter, type FilterInput } from './common.js';

const COUNT_RE = /^\s*(\d+) (passing|pending|failing)(?: \(([^)]+)\))?\s*$/;
const ENTRY_RE = /^ {2}(\d+)\) (.*)$/;
const MAX_MESSAGE_LINES = 14;

function compressMocha(inp: FilterInput): string | undefined {
  const { lines, exitCode, maxTokens } = inp;
  const counts = new Map<string, string>();
  let failingAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = COUNT_RE.exec(lines[i]);
    if (!m) continue;
    counts.set(m[2], m[3] ? `${m[1]} ${m[2]} (${m[3]})` : `${m[1]} ${m[2]}`);
    if (m[2] === 'failing') failingAt = i;
  }
  if (!counts.size) return undefined;
  const blocks: Block[] = [];
  if (failingAt >= 0) {
    let i = failingAt + 1;
    while (i < lines.length) {
      const m = ENTRY_RE.exec(lines[i]);
      if (!m) {
        i++;
        continue;
      }
      // Title: `1) Suite` then indented `nested suite` / `test title:` lines, the last one ending with ':'
      const title = [m[2].trim()];
      let j = i + 1;
      if (!title[0].endsWith(':')) {
        for (; j < lines.length && j < i + 6; j++) {
          const t = lines[j].trim();
          if (!t) break;
          title.push(t);
          if (t.endsWith(':')) {
            j++;
            break;
          }
        }
      }
      const body: string[] = [];
      for (; j < lines.length && !ENTRY_RE.test(lines[j]); j++) body.push(lines[j]);
      i = j;
      blocks.push(digest(title.join(' › ').replace(/:$/, ''), body));
    }
  }
  const head = ['passing', 'pending', 'failing'].filter((k) => counts.has(k)).map((k) => counts.get(k)!);
  if (exitCode !== 0 && !blocks.length && !counts.has('failing')) {
    // crashed before the summary (compile error in a test file, unhandled rejection): let the generic filter show it
    const crash = lastMatch(lines, /^\s*(?:Error|TypeError|SyntaxError|ReferenceError)\b/);
    if (crash) return undefined;
  }
  return layout([head.join(' · ')], blocks, maxTokens, 'failures');
}

function digest(title: string, body: string[]): Block {
  const lines = dedent(body.filter((l, k) => l.trim() || (k > 0 && body[k - 1].trim())));
  const msg: string[] = [];
  const frames: string[] = [];
  for (const l of lines) {
    if (/^\s*at\s/.test(l)) frames.push(l.trim());
    else if (l.trim() && !/^\s*\+ expected - actual\s*$/.test(l)) msg.push(l.trimEnd());
  }
  const keptMsg = msg.length > MAX_MESSAGE_LINES ? [...msg.slice(0, MAX_MESSAGE_LINES), `… ${msg.length - MAX_MESSAGE_LINES} more lines`] : msg;
  const kept = trimStack(frames.map((f) => `at ${f.replace(/^at\s+/, '')}`), 3, false);
  return {
    title: `FAIL ${title}`,
    lines: [...keptMsg.map((l) => `  ${l.trim()}`), ...kept.map((f) => `  ${f}`)],
    key: `${msg.slice(0, 3).join('\n')}|${kept[0] ?? ''}`,
  };
}

export const mocha: Filter = {
  name: 'mocha',
  match(cmd, sample) {
    if (runs(cmd, ['mocha', '_mocha'])) return 90;
    if (/^\s+\d+ passing \(\d/m.test(sample)) return 70;
    return 0;
  },
  compress: compressMocha,
};
