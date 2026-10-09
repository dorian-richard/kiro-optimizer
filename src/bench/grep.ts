// Emulation of Kiro's built-in grep_search for the offline benchmark.
//
// Kiro caps grep_search at 100 matches and ~10k chars (research: extension.js 1e4 cap). A real agent picks a
// pattern, sees matches in ripgrep's walk order (mostly noise on a large repo) and often needs 2-4 refining
// greps. We emulate ONE well-chosen grep instead, deliberately GENEROUS to the native baseline:
//   - pattern: the search keywords sorted by selectivity (fewest matches first), added greedily while the
//     total stays within the match cap (an agent greps `getImportedBy`, not `ConfigurationClass|getImportedBy`);
//   - display order: files with the most distinct keywords first, non-test files first, then match count.
// Savings measured against this baseline are therefore conservative.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { QUERY_STOPWORDS } from '../indexer/terms.js';

export interface GrepLimits {
  maxMatches: number;
  maxChars: number;
  /** Long lines are cut (ripgrep prints them whole; Kiro's 10k cap bounds the damage anyway). */
  maxLineChars: number;
}

export const KIRO_GREP_LIMITS: GrepLimits = { maxMatches: 100, maxChars: 10_000, maxLineChars: 250 };

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
  /** Number of distinct keywords on this line. */
  terms: number;
}

export interface GrepFileStat {
  path: string;
  /** Distinct keywords matched anywhere in the file. */
  distinct: number;
  /** Matching lines (any keyword). */
  count: number;
}

export interface GrepResult {
  /** Keywords actually OR-ed in the pattern. */
  keywords: string[];
  /** Keywords considered (from the search phrase), with their total matching lines in the repo. */
  candidates: { keyword: string; matches: number }[];
  pattern: string;
  /** All matching files, ranked. */
  files: GrepFileStat[];
  /** Matches shown to the model, in display order. */
  visible: GrepMatch[];
  /** Exactly what the model receives. */
  text: string;
  totalFiles: number;
  truncated: boolean;
}

const IDENT_LIKE = /[a-z][A-Z]|[A-Z]{2,}[a-z]|_|\d/;
const TEST_PATH = /(^|\/)(tests?|testing|__tests__|specs?|testFixtures)(\/|$)|(^|\/)test_[^/]*$|(_test|_tests|Tests?|\.test|\.spec)\.\w+$/;
const MAX_BUFFER = 1024 * 1024 * 1024;

/** Test/spec files: a competent agent looking for an implementation skips them (`--glob '!tests'`). */
export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path);
}

/**
 * Keywords a simple agent would grep for: identifiers kept whole (an agent greps `rotate_token`, not
 * `rotate|token`), plain words lower-cased minus EN/FR stopwords. Identifiers first, at most `max`.
 */
export function grepKeywords(input: string, max = 8): string[] {
  const idents: string[] = [];
  const words: string[] = [];
  const seen = new Set<string>();
  for (const m of input.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
    const tok = m[0].replace(/^[_$]+|[_$]+$/g, '');
    if (tok.length < 3) continue;
    const key = tok.toLowerCase();
    if (seen.has(key)) continue;
    if (IDENT_LIKE.test(tok)) {
      seen.add(key);
      idents.push(tok);
    } else if (!QUERY_STOPWORDS.has(key)) {
      seen.add(key);
      words.push(key);
    }
  }
  return [...idents, ...words].slice(0, max);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function run(cmd: string, args: string[], cwd: string): string {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) throw r.error;
  // git grep / rg exit 1 when nothing matched
  if (r.status !== 0 && r.status !== 1) throw new Error(`${cmd} failed (${r.status}): ${r.stderr.slice(0, 300)}`);
  return r.stdout;
}

interface RawMatch {
  path: string;
  line: number;
  text: string;
}

/**
 * Case-insensitive search for any of `keywords` (text files only, .gitignore respected). With `onlyMatching`
 * each occurrence is returned (text = the matched keyword) instead of the whole line.
 */
function search(root: string, keywords: string[], onlyMatching: boolean, paths: string[] = []): RawMatch[] {
  const pats = keywords.flatMap((k) => ['-e', escapeRegex(k)]);
  const git = existsSync(join(root, '.git'));
  const stdout = git
    ? run('git', ['-c', 'core.quotePath=false', 'grep', '-n', '-z', '-I', '-i', '-E', ...(onlyMatching ? ['-o'] : []), ...pats, '--', ...paths], root)
    : run('rg', ['-n', '-i', '--null', '--no-heading', '--no-messages', ...(onlyMatching ? ['-o'] : []), ...pats, '--', ...(paths.length ? paths : ['.'])], root);
  const out: RawMatch[] = [];
  for (const raw of stdout.split('\n')) {
    const a = raw.indexOf('\0');
    if (a <= 0) continue;
    // git: "path\0line\0text"; rg --null: "path\0line:text"
    let b = raw.indexOf('\0', a + 1);
    if (b < 0) b = raw.indexOf(':', a + 1);
    if (b < 0) continue;
    const path = raw.slice(0, a).replace(/^\.\//, '');
    out.push({ path, line: Number(raw.slice(a + 1, b)), text: raw.slice(b + 1) });
  }
  return out;
}

/**
 * One emulated grep_search call for the given search keywords, capped like Kiro.
 * Never throws on "no match"; throws when neither git nor rg can search `root`.
 */
export function nativeGrep(root: string, keywords: string[], limits: GrepLimits = KIRO_GREP_LIMITS): GrepResult {
  const kws = keywords.filter(Boolean);
  const none = (candidates: GrepResult['candidates']): GrepResult => ({
    keywords: [], candidates, pattern: kws.map(escapeRegex).join('|'), files: [], visible: [], text: 'No matches found', totalFiles: 0, truncated: false,
  });
  if (!kws.length) return none([]);

  // One pass over the repo: matching lines per keyword per file.
  const lower = kws.map((k) => k.toLowerCase());
  const perKw = lower.map(() => new Map<string, Set<number>>());
  for (const m of search(root, kws, true)) {
    const i = lower.indexOf(m.text.toLowerCase());
    if (i < 0) continue;
    let lines = perKw[i].get(m.path);
    if (!lines) perKw[i].set(m.path, (lines = new Set()));
    lines.add(m.line);
  }
  const candidates = kws.map((keyword, i) => ({ keyword, matches: [...perKw[i].values()].reduce((n, s) => n + s.size, 0) }));

  // Most selective keywords first, broadened while the output stays within the cap.
  const order = candidates.map((c, i) => ({ ...c, i })).filter((c) => c.matches > 0).sort((a, b) => a.matches - b.matches || a.i - b.i);
  const chosen: number[] = [];
  let total = 0;
  for (const c of order) {
    if (chosen.length && total + c.matches > limits.maxMatches) break;
    chosen.push(c.i);
    total += c.matches;
  }
  if (!chosen.length) return none(candidates);
  chosen.sort((a, b) => a - b);
  const keywordsUsed = chosen.map((i) => kws[i]);

  const stats = new Map<string, GrepFileStat & { lines: Set<number> }>();
  for (const i of chosen) {
    for (const [path, lines] of perKw[i]) {
      const s = stats.get(path) ?? { path, distinct: 0, count: 0, lines: new Set<number>() };
      s.distinct++;
      for (const l of lines) s.lines.add(l);
      s.count = s.lines.size;
      stats.set(path, s);
    }
  }
  const files = [...stats.values()]
    .sort((x, y) => y.distinct - x.distinct || Number(isTestPath(x.path)) - Number(isTestPath(y.path)) || y.count - x.count || (x.path < y.path ? -1 : 1))
    .map(({ path, distinct, count }) => ({ path, distinct, count }));

  // Fetch full lines only for the files that can still be displayed.
  const wanted: string[] = [];
  let budget = 0;
  for (const f of files) {
    if (budget >= limits.maxMatches) break;
    wanted.push(f.path);
    budget += f.count;
  }
  const usedLower = keywordsUsed.map((k) => k.toLowerCase());
  const byFile = new Map<string, GrepMatch[]>();
  for (const m of search(root, keywordsUsed, false, wanted)) {
    const text = m.text.toLowerCase();
    const list = byFile.get(m.path) ?? [];
    list.push({ ...m, terms: usedLower.reduce((n, k) => n + (text.includes(k) ? 1 : 0), 0) });
    byFile.set(m.path, list);
  }

  const visible: GrepMatch[] = [];
  const lines: string[] = [];
  let chars = 0;
  let truncated = wanted.length < files.length;
  outer: for (const p of wanted) {
    for (const m of (byFile.get(p) ?? []).sort((x, y) => x.line - y.line)) {
      let text = m.text.trim();
      if (text.length > limits.maxLineChars) text = text.slice(0, limits.maxLineChars) + '…';
      const line = `${m.path}:${m.line}:${text}`;
      if (visible.length >= limits.maxMatches || chars + line.length + 1 > limits.maxChars) {
        truncated = true;
        break outer;
      }
      visible.push({ ...m, text });
      lines.push(line);
      chars += line.length + 1;
    }
  }
  const header = `Found ${total} matches in ${files.length} files` + (truncated ? ` (showing first ${visible.length})` : '');
  return {
    keywords: keywordsUsed,
    candidates,
    pattern: keywordsUsed.map(escapeRegex).join('|'),
    files,
    visible,
    text: [header, ...lines].join('\n'),
    totalFiles: files.length,
    truncated,
  };
}
