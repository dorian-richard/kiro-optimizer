// PHPUnit, Pest, ParaTest and `php artisan test` (Collision printer).
// PHPUnit: `OK (120 tests, 340 assertions)` / `FAILURES!` + `Tests: 120, Assertions: 340, Failures: 1.`; per error
// and failure the message and the repo locations (vendor/ dropped); progress dots and the runtime banner dropped.
// Collision: `Tests: 1 failed, 119 passed (340 assertions)`; per `FAILED  Class > test` block the message and
// the `at path:line` location, without the source excerpt.

import { runs } from '../command.js';
import { layout, lastMatch, type Block, type Filter, type FilterInput } from './common.js';

const SECTION_RE = /^There (?:was|were) (\d+) (errors?|failures?|warnings?|risky tests?|skipped tests?|incomplete tests?|deprecations?|notices?|PHPUnit (?:errors?|warnings?|deprecations?)):?$/;
const ENTRY_RE = /^(\d+)\) (\S.*)$/;
const LOC_RE = /^((?:[A-Za-z]:)?[^\s:]+\.php):(\d+)$/;
const VERDICT_RE = /^(OK \(.+\)|OK, but (?:incomplete, skipped, or risky tests|there were issues|some tests were skipped)!|FAILURES!|ERRORS!|No tests executed!)$/;
const COUNTS_RE = /^(Tests: \d+, Assertions: \d+.*)$/;
const TIME_RE = /^Time: ([\d:.]+), Memory: .*$/;
const COLLISION_TESTS_RE = /^\s*Tests:\s+(.+)$/;
const COLLISION_DURATION_RE = /^\s*Duration:\s+(.+)$/;
const COLLISION_FAILED_RE = /^\s*(?:FAILED|ERROR)\s{1,}(\S.*?)(?:\s{2,}\S.*)?$/;
const MAX_MESSAGE_LINES = 12;

function isVendor(path: string): boolean {
  return /(?:^|[\\/])vendor[\\/]|phar:\/\//.test(path);
}

function compressPhpunit(inp: FilterInput): string | undefined {
  const { lines, maxTokens } = inp;
  const blocks: Block[] = [];
  const other: string[] = [];
  let section = '';
  for (let i = 0; i < lines.length; i++) {
    const s = SECTION_RE.exec(lines[i]);
    if (s) {
      section = s[2];
      if (!/^(?:errors?|failures?)$/.test(section)) other.push(`${s[1]} ${section}`);
      continue;
    }
    if (VERDICT_RE.test(lines[i])) {
      section = '';
      continue;
    }
    if (!/^(?:errors?|failures?)$/.test(section)) continue;
    const m = ENTRY_RE.exec(lines[i]);
    if (!m) continue;
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length && !ENTRY_RE.test(lines[j]) && !SECTION_RE.test(lines[j]) && !VERDICT_RE.test(lines[j]) && lines[j] !== '--'; j++) body.push(lines[j]);
    i = j - 1;
    blocks.push(digestPhpunit(`${section.startsWith('error') ? 'ERROR' : 'FAILED'} ${m[2].trim()}`, body));
  }

  // Collision (Pest / artisan test)
  for (let i = 0; i < lines.length; i++) {
    const m = COLLISION_FAILED_RE.exec(lines[i]);
    if (!m || !/^\s*(?:FAILED|ERROR)\s/.test(lines[i]) || !/ > |::/.test(m[1])) continue;
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length && !COLLISION_FAILED_RE.test(lines[j]) && !COLLISION_TESTS_RE.test(lines[j]) && !/^\s*(?:PASS|FAIL)\s{2}\S/.test(lines[j]); j++) body.push(lines[j]);
    i = j - 1;
    blocks.push(digestCollision(`FAILED ${m[1].trim()}`, body));
  }

  const verdict = lastMatch(lines, VERDICT_RE);
  const counts = lastMatch(lines, COUNTS_RE);
  const time = lastMatch(lines, TIME_RE);
  const cTests = lastMatch(lines, COLLISION_TESTS_RE);
  const cDuration = lastMatch(lines, COLLISION_DURATION_RE);
  if (!verdict && !cTests && !blocks.length) return undefined;
  const head: string[] = [];
  if (verdict) head.push(/^OK \(/.test(verdict[1]) ? verdict[1] : [verdict[1], counts?.[1]].filter(Boolean).join(' '));
  if (cTests && !verdict) head.push(`Tests: ${cTests[1].trim()}`);
  if (time) head.push(`Time: ${time[1]}`);
  else if (cDuration) head.push(`Duration: ${cDuration[1].trim()}`);
  if (other.length) head.push(other.join(', '));
  return layout([head.join(' · ') || `exit ${inp.exitCode}`], blocks, maxTokens, 'failures');
}

function digestPhpunit(title: string, body: string[]): Block {
  const msg: string[] = [];
  const locs: string[] = [];
  for (const raw of body) {
    const l = raw.trimEnd();
    if (!l.trim()) continue;
    const loc = LOC_RE.exec(l.trim());
    if (loc) {
      if (!isVendor(loc[1]) && locs.length < 3) locs.push(`${loc[1]}:${loc[2]}`);
      continue;
    }
    msg.push(l.trim());
  }
  const keptMsg = msg.length > MAX_MESSAGE_LINES ? [...msg.slice(0, MAX_MESSAGE_LINES), `… ${msg.length - MAX_MESSAGE_LINES} more lines`] : msg;
  return { title, lines: [...keptMsg.map((l) => `  ${l}`), ...locs.map((l) => `  at ${l}`)], key: `${msg.slice(0, 3).join('\n')}|${locs[0] ?? ''}` };
}

function digestCollision(title: string, body: string[]): Block {
  const msg: string[] = [];
  const locs: string[] = [];
  let excerpt = false;
  for (const raw of body) {
    const t = raw.trim();
    if (!t || /^[─━-]{10,}$/.test(t)) continue;
    const at = /^at (\S+?):(\d+)$/.exec(t);
    if (at) {
      if (!isVendor(at[1])) locs.push(`${at[1]}:${at[2]}`);
      excerpt = true;
      continue;
    }
    // source excerpt (`18▕ code`, `➜ 22▕ code`) and the numbered trace (`1   tests/x.php:22`)
    if (/^(?:➜\s*)?\d+▕/.test(t) || /^\+\d+ vendor frames/.test(t)) continue;
    const frame = /^\d+\s+(\S+?\.php):(\d+)/.exec(t);
    if (frame) {
      if (!isVendor(frame[1]) && !locs.includes(`${frame[1]}:${frame[2]}`) && locs.length < 3) locs.push(`${frame[1]}:${frame[2]}`);
      continue;
    }
    if (excerpt && /^\d/.test(t)) continue;
    msg.push(t);
  }
  const keptMsg = msg.length > MAX_MESSAGE_LINES ? [...msg.slice(0, MAX_MESSAGE_LINES), `… ${msg.length - MAX_MESSAGE_LINES} more lines`] : msg;
  return { title, lines: [...keptMsg.map((l) => `  ${l}`), ...locs.slice(0, 3).map((l) => `  at ${l}`)], key: `${msg.slice(0, 3).join('\n')}|${locs[0] ?? ''}` };
}

export const phpunit: Filter = {
  name: 'phpunit',
  match(cmd, sample) {
    if (runs(cmd, ['phpunit', 'pest', 'paratest'])) return 90;
    if (cmd.segments.some((s) => (s.program === 'php' && /(?:^|[\\/])(?:phpunit|pest|paratest)$/.test(s.args[0] ?? '')) || (/artisan$/.test(s.program === 'php' ? s.args[0] ?? '' : s.program) && (s.program === 'php' ? s.args[1] : s.args[0]) === 'test'))) return 90;
    if (/^PHPUnit \d+\.\d+/m.test(sample)) return 70;
    if (/^\s*Tests:\s+.*\(\d+ assertions?\)/m.test(sample)) return 68;
    return 0;
  },
  compress: compressPhpunit,
};
