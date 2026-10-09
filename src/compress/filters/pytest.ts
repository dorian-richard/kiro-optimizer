// pytest (and stdlib unittest / Django test runner, same audience and similar needs).
// Success -> the `N passed in Xs` verdict. Failure -> per failing test: repo call chain (`path:line: code`),
// the `E` assertion lines; library frames (site-packages, _pytest...) dropped; identical errors merged.

import { runs } from '../command.js';
import { dedent, layout, lastMatch, trimStack, type Block, type Filter, type FilterInput } from './common.js';

const SECTION_RE = /^={3,} ?(.*?) ?={3,}$/;
const BLOCK_RE = /^_{3,} (.+?) _{3,}$/;
const SUBSECTION_RE = /^-{3,} (.+?) -{3,}$/;
const ENTRY_SEP_RE = /^(?:_ ){5,}_?\s*$/;
const VERDICT_RE =
  /^=*\s*((?:\d+ (?:passed|failed|errors?|skipped|xfailed|xpassed|deselected|warnings?|rerun)(?:, )?)+(?: in [\d.]+s(?: \([\d:.]+\))?)?|no tests ran(?: in [\d.]+s)?)\s*=*$/;
const SHORT_RE = /^(FAILED|ERROR)\s+(\S+(?:\[[^\]]*\])?)(?: - (.*))?$/;
const LOC_RE = /^([^\s:>][^:\s]*\.py):(\d+):(?: (.*))?$/;
const BANG_RE = /^!{3,} (.+?) !{3,}$/;
const PY_LIB_RE = /site-packages|dist-packages|[\\/]lib[\\/]python\d|^<frozen|(?:^|[\\/])_pytest[\\/]|(?:^|[\\/])pluggy[\\/]/;

interface Entry {
  loc: string;
  code?: string;
  lib: boolean;
}

function parseBlock(lines: string[]): { entries: Entry[]; errors: string[]; other: string[] } {
  const entries: Entry[] = [];
  const errors: string[] = [];
  const other: string[] = [];
  let gt: string | undefined;
  let captured = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (SUBSECTION_RE.test(line)) {
      captured = /captured|log/i.test(line);
      continue;
    }
    if (captured) continue;
    if (ENTRY_SEP_RE.test(line)) {
      gt = undefined;
      continue;
    }
    if (line.startsWith('>')) {
      gt = line.slice(1).trim();
      continue;
    }
    if (line === 'E' || line.startsWith('E ')) {
      errors.push(line.slice(1));
      continue;
    }
    const m = LOC_RE.exec(line);
    if (m) {
      const rest = m[3] ?? '';
      const loc = `${m[1]}:${m[2]}`;
      const lib = PY_LIB_RE.test(m[1]);
      if (rest.startsWith('in ')) {
        // short-style entry: location first, source line next
        const next = lines[i + 1];
        const code = next && /^\s{2,}\S/.test(next) && !next.startsWith('E ') ? next.trim() : undefined;
        if (code) i++;
        entries.push({ loc, code, lib });
      } else {
        entries.push({ loc, code: gt, lib });
        gt = undefined;
      }
      continue;
    }
    if (line.trim()) other.push(line);
  }
  return { entries, errors, other };
}

function nodeMatches(nodeid: string, blockTitle: string): boolean {
  const name = blockTitle.replace(/^ERROR (?:at (?:setup|teardown) of |collecting )/, '').trim();
  const dotted = nodeid.replace(/::/g, '.');
  return nodeid === name || dotted === name || dotted.endsWith(`.${name}`) || nodeid.endsWith(`/${name}`);
}

function compressPytest(inp: FilterInput): string | undefined {
  const { lines, exitCode, maxTokens } = inp;
  const verdictM = lastMatch(lines, VERDICT_RE);
  const verdict = verdictM ? verdictM[1] : undefined;
  const shorts: { kind: string; nodeid: string; msg?: string; used?: boolean }[] = [];
  const raw: { title: string; body: string[]; section: string }[] = [];
  const notes: string[] = [];
  let section = '';
  let cur: { title: string; body: string[]; section: string } | undefined;
  for (const line of lines) {
    const bang = BANG_RE.exec(line);
    if (bang) {
      notes.push(bang[1]);
      continue;
    }
    const sec = SECTION_RE.exec(line);
    if (sec && !BLOCK_RE.test(line)) {
      section = sec[1].toLowerCase();
      cur = undefined;
      continue;
    }
    if (section === 'failures' || section === 'errors') {
      const b = BLOCK_RE.exec(line);
      if (b) {
        cur = { title: b[1], body: [], section };
        raw.push(cur);
      } else if (cur) cur.body.push(line);
      continue;
    }
    if (section === 'short test summary info') {
      const s = SHORT_RE.exec(line);
      if (s) shorts.push({ kind: s[1], nodeid: s[2], msg: s[3] });
    }
  }

  const blocks: Block[] = [];
  for (const r of raw) {
    const { entries, errors, other } = parseBlock(r.body);
    const short = shorts.find((s) => !s.used && nodeMatches(s.nodeid, r.title));
    if (short) short.used = true;
    const kind = r.section === 'errors' ? 'ERROR' : 'FAILED';
    const title = short ? `${short.kind} ${short.nodeid}` : r.title.startsWith('ERROR') ? r.title : `${kind} ${r.title}`;
    const repo = entries.filter((e) => !e.lib).slice(-3);
    const body: string[] = repo.map((e) => (e.code ? `${e.loc}: ${e.code}` : e.loc));
    const err = dedent(errors).slice(0, 14).map((l) => `E ${l}`.trimEnd());
    if (err.length) body.push(...err);
    else if (short?.msg) body.push(`E ${short.msg}`);
    else body.push(...trimStack(other, 3, false).slice(-6));
    const last = entries[entries.length - 1];
    blocks.push({ title, lines: body, key: `${errors.join('\n')}|${last?.loc ?? ''}` });
  }
  // --tb=no / --tb=line: only the short summary is available.
  for (const s of shorts) {
    if (s.used || raw.length) continue;
    blocks.push({ title: `${s.kind} ${s.nodeid}`, lines: s.msg ? [`E ${s.msg}`] : [], key: s.msg ? `${s.kind}|${s.msg}` : undefined });
  }

  if (!verdict && !blocks.length) return undefined;
  if (exitCode !== 0 && !blocks.length && !/failed|error/.test(verdict ?? '') && !/no tests ran/.test(verdict ?? '')) return undefined;
  const head = [verdict ?? `exit ${exitCode}`, ...notes.filter((n) => !verdict || !n.includes(verdict))];
  return layout(head, blocks, maxTokens, 'failures');
}

export const pytest: Filter = {
  name: 'pytest',
  match(cmd, sample) {
    if (runs(cmd, ['pytest', 'py.test'])) return 90;
    if (/^=+ test session starts =+$/m.test(sample)) return 75;
    if (/^(?:FAILED|PASSED|ERROR) \S+\.py::\S+/m.test(sample)) return 60;
    return 0;
  },
  compress: compressPytest,
};

// ---------------------------------------------------------------------------------------------------------------
// unittest / Django: `FAIL: test_x (pkg.Class.test_x)` blocks, `Ran N tests in Xs`, `OK` / `FAILED (failures=1)`.

const UT_HEAD_RE = /^(FAIL|ERROR|UNEXPECTED SUCCESS): (.+)$/;
const UT_RAN_RE = /^Ran (\d+) tests? in ([\d.]+s)$/;
const UT_VERDICT_RE = /^(OK|FAILED)(?: \((.*)\))?$/;

function compressUnittest(inp: FilterInput): string | undefined {
  const { lines, maxTokens } = inp;
  const ran = lastMatch(lines, UT_RAN_RE);
  const verdict = lastMatch(lines, UT_VERDICT_RE);
  if (!ran && !verdict) return undefined;
  const blocks: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = UT_HEAD_RE.exec(lines[i]);
    if (!m || !/^={20,}$/.test(lines[i - 1] ?? '')) continue;
    const body: string[] = [];
    let j = i + 1;
    if (/^-{20,}$/.test(lines[j] ?? '')) j++;
    for (; j < lines.length && !/^(?:={20,}|-{20,})$/.test(lines[j]); j++) body.push(lines[j]);
    const trimmed = trimStack(body.filter((l) => l.trim() && !/^Traceback \(most recent call last\):$/.test(l)), 3, false);
    const exc = trimmed.filter((l) => /^\S/.test(l));
    blocks.push({ title: `${m[1]}: ${m[2]}`, lines: trimmed.slice(0, 16), key: exc.join('\n') || undefined });
    i = j - 1;
  }
  const head = [[ran ? `Ran ${ran[1]} tests in ${ran[2]}` : '', verdict ? verdict[0] : ''].filter(Boolean).join(' · ')];
  return layout(head, blocks, maxTokens, 'failures');
}

export const unittest: Filter = {
  name: 'unittest',
  match(cmd, sample) {
    const cmdHit = runs(cmd, ['unittest', 'nose2']) || cmd.segments.some((s) => s.program === 'manage.py' || (/^python/.test(s.program) && s.args[0]?.endsWith('manage.py') && s.args[1] === 'test'));
    if (/^Ran \d+ tests? in [\d.]+s$/m.test(sample)) return cmdHit ? 90 : 65;
    return cmdHit ? 55 : 0;
  },
  compress: compressUnittest,
};
