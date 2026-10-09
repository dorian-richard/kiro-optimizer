// git log / show / diff / status.
// log  -> one line per commit (`sha date author: subject [n files +a -d]`); bodies kept only for <= 3 commits.
// diff -> hunks kept verbatim (they are the information) but `index`/`---`/`+++` lines dropped, binary and
//         lockfile/generated hunks summarized, and a fair per-file budget so one huge file cannot hide the rest.
// status (long format) -> one line per section with short codes, hint lines dropped.

import { estimateTokens, tokensToChars, truncateLines } from '../../core/tokens.js';
import { subcommandOf } from '../command.js';
import { capLine, fit, joinWithin, type Filter, type FilterInput } from './common.js';

const COMMIT_RE = /^commit ([0-9a-f]{7,40})(?: \((.+)\))?$/;
const DIFF_HEAD_RE = /^diff --git (?:"?a\/(.+?)"? "?b\/(.+?)"?|(.+))$/;
const HUNK_RE = /^@@ /;
const STAT_LINE_RE = /^ (\S.*?)\s+\|\s+(?:\d+ ?[+-]*|Bin .*)$/;
const STAT_SUMMARY_RE = /^ (\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?$/;
const GENERATED_RE =
  /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock|go\.sum|gradle\.lockfile|packages\.lock\.json)$|\.min\.(?:js|css)$|\.map$|\.snap$|\.pb\.go$|_pb2\.py$|\.generated\.\w+$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function shortDate(raw: string): string {
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  if (iso) return iso[1];
  const m = /^\w{3} (\w{3}) (\d{1,2}) [\d:]+ (\d{4})/.exec(raw);
  if (m && MONTHS.includes(m[1])) return `${m[3]}-${String(MONTHS.indexOf(m[1]) + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return raw;
}

// ---------------------------------------------------------------------------------------------------------------
// diff

interface FileDiff {
  header: string;
  path: string;
  meta: string[];
  hunks: string[][];
  binary: boolean;
  adds: number;
  dels: number;
}

function parseDiff(lines: string[]): { pre: string[]; files: FileDiff[] } {
  const files: FileDiff[] = [];
  const pre: string[] = [];
  let cur: FileDiff | undefined;
  let inBinaryPatch = false;
  for (const line of lines) {
    const h = DIFF_HEAD_RE.exec(line);
    if (h) {
      const path = h[2] ?? h[3] ?? '';
      cur = { header: line, path, meta: [], hunks: [], binary: false, adds: 0, dels: 0 };
      files.push(cur);
      inBinaryPatch = false;
      continue;
    }
    if (!cur) {
      pre.push(line);
      continue;
    }
    if (inBinaryPatch) continue;
    if (HUNK_RE.test(line)) {
      cur.hunks.push([line]);
      continue;
    }
    const hunk = cur.hunks[cur.hunks.length - 1];
    if (!hunk) {
      if (/^index [0-9a-f]+\.\.[0-9a-f]+/.test(line) || /^(?:---|\+\+\+) /.test(line)) continue;
      if (/^GIT binary patch$/.test(line)) {
        cur.binary = true;
        inBinaryPatch = true;
        continue;
      }
      if (/^Binary files .* differ$/.test(line)) {
        cur.binary = true;
        continue;
      }
      if (line.trim()) cur.meta.push(line.replace(/ mode \d+$/, ''));
      continue;
    }
    if (line.startsWith('+')) cur.adds++;
    else if (line.startsWith('-')) cur.dels++;
    hunk.push(capLine(line));
  }
  return { pre, files };
}

function renderFile(f: FileDiff, budget: number): string {
  const head = [f.header, ...f.meta];
  if (f.binary) return [...head, 'Binary files differ'].join('\n');
  if (GENERATED_RE.test(f.path) && f.hunks.length) {
    return [...head, `(generated/lockfile: +${f.adds} -${f.dels} in ${f.hunks.length} hunks, omitted)`].join('\n');
  }
  const out = [...head];
  let used = estimateTokens(out.join('\n'));
  let k = 0;
  for (; k < f.hunks.length; k++) {
    const text = f.hunks[k].join('\n');
    const t = estimateTokens(text) + 1;
    if (used + t <= budget) {
      out.push(text);
      used += t;
      continue;
    }
    if (k === 0 || budget - used > 60) {
      const room = budget - used - 12;
      if (room > 20) {
        out.push(truncateLines(text, room, (n) => `… ${n} more lines in this hunk`).text);
        k++;
      }
    }
    break;
  }
  if (k < f.hunks.length) {
    let a = 0;
    let d = 0;
    for (const h of f.hunks.slice(k)) for (const l of h) l.startsWith('+') ? a++ : l.startsWith('-') ? d++ : 0;
    out.push(`… +${f.hunks.length - k} hunks (+${a} -${d}) omitted`);
  }
  return out.join('\n');
}

export function compressDiff(lines: string[], maxTokens: number): string {
  const { pre, files } = parseDiff(lines);
  if (!files.length) return fit(lines.join('\n'), maxTokens);
  const preText = pre.join('\n').trim();
  const budget = maxTokens - estimateTokens(preText) - 2;
  const full = files.map((f) => renderFile(f, Infinity));
  const costs = full.map((t) => estimateTokens(t) + 1);
  if (costs.reduce((a, b) => a + b, 0) <= budget) return [preText, ...full].filter(Boolean).join('\n');
  const alloc = new Array<number>(files.length).fill(0);
  let remaining = budget - 40;
  if (remaining / files.length >= 60) {
    // Water-filling: small files get what they need, big files share the rest evenly.
    const order = costs.map((c, i) => [c, i] as const).sort((a, b) => a[0] - b[0]);
    order.forEach(([c, i], n) => {
      const share = Math.floor(remaining / (order.length - n));
      alloc[i] = Math.min(c, share);
      remaining -= alloc[i];
    });
  } else {
    // Too many files for a fair share: first files in order, none larger than 40% of the budget.
    const cap = Math.floor(budget * 0.4);
    for (let i = 0; i < files.length && remaining > 60; i++) {
      alloc[i] = Math.min(costs[i], cap, remaining);
      remaining -= alloc[i];
    }
  }
  const out: string[] = [];
  const skipped: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const headCost = estimateTokens(files[i].header) + 4;
    if (alloc[i] < headCost + 10 && alloc[i] < costs[i]) {
      skipped.push(`${files[i].path} (+${files[i].adds} -${files[i].dels})`);
      continue;
    }
    out.push(alloc[i] >= costs[i] ? full[i] : renderFile(files[i], alloc[i]));
  }
  if (skipped.length) out.push(`… +${skipped.length} files omitted: ${joinWithin(skipped, 300)}`);
  return fit([preText, ...out].filter(Boolean).join('\n'), maxTokens);
}

// ---------------------------------------------------------------------------------------------------------------
// log / show

interface Commit {
  sha: string;
  refs?: string;
  author?: string;
  date?: string;
  message: string[];
  stat: string[];
  statSummary?: string;
  diff: string[];
}

function compressLog(lines: string[], maxTokens: number, isShow: boolean): string {
  const commits: Commit[] = [];
  const pre: string[] = [];
  let c: Commit | undefined;
  let inDiff = false;
  for (const line of lines) {
    const m = COMMIT_RE.exec(line);
    if (m) {
      c = { sha: m[1], refs: m[2], message: [], stat: [], diff: [] };
      commits.push(c);
      inDiff = false;
      continue;
    }
    if (!c) {
      pre.push(line);
      continue;
    }
    if (inDiff || DIFF_HEAD_RE.test(line)) {
      inDiff = true;
      c.diff.push(line);
      continue;
    }
    let h: RegExpExecArray | null;
    if ((h = /^Author:\s+(.*?)(?: <[^>]*>)?$/.exec(line))) c.author = h[1];
    else if ((h = /^(?:Author)?Date:\s+(.*)$/.exec(line))) c.date = shortDate(h[1]);
    else if (/^Merge: /.test(line)) continue;
    else if (/^(?:Commit|CommitDate):/.test(line)) continue;
    else if (line.startsWith('    ')) c.message.push(line.slice(4));
    else if ((h = STAT_SUMMARY_RE.exec(line))) c.statSummary = `${h[1]} files +${h[2] ?? 0} -${h[3] ?? 0}`;
    else if (STAT_LINE_RE.test(line)) c.stat.push(line.trim());
  }
  const detailed = isShow || commits.length <= 3;
  const out: string[] = [];
  for (const k of commits) {
    const subject = k.message.find((l) => l.trim())?.trim() ?? '';
    const meta = [k.sha.slice(0, 9), k.refs ? `(${k.refs})` : '', k.date, k.author ? `${k.author}:` : ''].filter(Boolean).join(' ');
    const stat = k.statSummary ? ` [${k.statSummary}]` : '';
    out.push(`${meta} ${subject}${stat}`);
    if (detailed) {
      const body = k.message.slice(k.message.findIndex((l) => l.trim()) + 1).filter((l, i, a) => l.trim() || (i > 0 && a[i - 1].trim()));
      const trimmedBody = body.join('\n').trim().split('\n').filter(Boolean);
      for (const b of trimmedBody.slice(0, 8)) out.push(`  ${b}`);
      if (trimmedBody.length > 8) out.push(`  … ${trimmedBody.length - 8} more lines`);
      for (const s of k.stat.slice(0, 15)) out.push(`  ${s}`);
      if (k.stat.length > 15) out.push(`  … +${k.stat.length - 15} files`);
    }
  }
  const header = [...pre.filter((l) => l.trim()), ...out].join('\n');
  const diffLines = commits.flatMap((k) => k.diff);
  if (!diffLines.length) {
    if (estimateTokens(header) <= maxTokens) return header;
    return truncateLines(header, maxTokens, (n) => `… +${n} more commits (narrow with -n or a path)`).text;
  }
  const headerText = fit(header, Math.floor(maxTokens * 0.35));
  return fit(`${headerText}\n${compressDiff(diffLines, maxTokens - estimateTokens(headerText) - 2)}`, maxTokens);
}

// ---------------------------------------------------------------------------------------------------------------
// status

const STATUS_CODES: Record<string, string> = {
  modified: 'M', 'new file': 'A', deleted: 'D', renamed: 'R', copied: 'C', typechange: 'T',
  'both modified': 'UU', 'both added': 'AA', 'both deleted': 'DD', 'added by us': 'AU', 'added by them': 'UA',
  'deleted by us': 'DU', 'deleted by them': 'UD',
};

function groupPaths(paths: string[]): string[] {
  if (paths.length <= 20) return paths;
  const groups = new Map<string, string[]>();
  for (const p of paths) {
    const parts = p.replace(/^[A-Z]{1,2} /, '').split('/');
    const key = parts.length > 2 ? `${parts.slice(0, 2).join('/')}/` : parts.length === 2 ? `${parts[0]}/` : p;
    const arr = groups.get(key) ?? [];
    arr.push(p);
    groups.set(key, arr);
  }
  return [...groups].map(([k, ps]) => (ps.length > 1 ? `${k} (${ps.length} files)` : ps[0]));
}

const LONG_STATUS_RE = /^(?:On branch |HEAD detached |Not currently on any branch|Changes (?:to be committed|not staged for commit):|Untracked files:|Unmerged paths:|nothing to commit|You are (?:in the middle|currently))/;

function compressStatus(lines: string[], maxTokens: number): string | undefined {
  // Short/porcelain formats are already compact.
  if (!lines.some((l) => LONG_STATUS_RE.test(l))) return undefined;
  const head: string[] = [];
  const sections = new Map<string, string[]>();
  let section: string | undefined;
  for (const line of lines) {
    if (/^\s+\(use "git /.test(line) || !line.trim()) continue;
    let m: RegExpExecArray | null;
    if ((m = /^(Changes to be committed|Changes not staged for commit|Untracked files|Unmerged paths|Ignored files):$/.exec(line))) {
      section = { 'Changes to be committed': 'staged', 'Changes not staged for commit': 'unstaged', 'Untracked files': 'untracked', 'Unmerged paths': 'conflicts', 'Ignored files': 'ignored' }[m[1]]!;
      continue;
    }
    if (section && /^\t/.test(line)) {
      const entry = line.trim();
      const em = /^([a-z ]+):\s+(.*)$/.exec(entry);
      const arr = sections.get(section) ?? [];
      arr.push(em && STATUS_CODES[em[1]] ? `${STATUS_CODES[em[1]]} ${em[2]}` : entry);
      sections.set(section, arr);
      continue;
    }
    section = undefined;
    if (/^no changes added to commit|^nothing added to commit but untracked files present/.test(line)) continue;
    head.push(line.trim().replace(/\.$/, ''));
  }
  if (!sections.size && !head.length) return undefined;
  const out = [head.join(', ')];
  const room = tokensToChars(maxTokens) - out[0].length;
  const per = Math.max(120, Math.floor(room / Math.max(1, sections.size)) - 30);
  for (const [name, entries] of sections) out.push(`${name} (${entries.length}): ${joinWithin(groupPaths(entries), per)}`);
  return fit(out.join('\n'), maxTokens);
}

// ---------------------------------------------------------------------------------------------------------------

function compressGit(inp: FilterInput): string | undefined {
  const { command, lines, maxTokens } = inp;
  const sub = subcommandOf(command, ['git']);
  if (lines.some((l) => COMMIT_RE.test(l))) return compressLog(lines, maxTokens, sub === 'show');
  if (lines.some((l) => /^diff --git /.test(l))) return compressDiff(lines, maxTokens);
  if (sub === 'status' || lines.some((l) => /^(?:On branch |HEAD detached |Changes (?:to be committed|not staged)|Untracked files:)/.test(l))) {
    const s = compressStatus(lines, maxTokens);
    if (s !== undefined) return s;
  }
  const text = lines.map((l) => capLine(l)).join('\n');
  if (estimateTokens(text) <= maxTokens) return text;
  return truncateLines(text, maxTokens, (n) => `… +${n} more lines`).text;
}

export const git: Filter = {
  name: 'git',
  match(cmd, sample) {
    const sub = subcommandOf(cmd, ['git']);
    if (sub && ['log', 'show', 'diff', 'status', 'whatchanged', 'reflog'].includes(sub)) return 90;
    if (/^diff --git a\//m.test(sample) || /^commit [0-9a-f]{40}/m.test(sample)) return 55;
    return 0;
  },
  compress: compressGit,
};
