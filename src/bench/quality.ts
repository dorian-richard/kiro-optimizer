// Extraction quality of the indexer, per language (kopt bench quality <repo>).
//
// Everything here is mechanical and reproducible (seeded sampling):
//   - files indexed / skipped (by reason), from the index;
//   - parse error rate: a sample of indexed files is re-parsed with the same web-tree-sitter grammar the indexer
//     uses, counting ERROR and MISSING nodes;
//   - symbols per KLOC by kind, refs resolved (overall and among refs whose name is defined in the repo);
//   - sampled precision: N random symbols per language are re-read from disk and checked against their source
//     (name on the header lines, plausible start, plausible block end, signature identifiers present in order).
// The checks are heuristics: a failure is a pointer to inspect, not proof of an extraction bug.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Node } from 'web-tree-sitter';
import type { Lang } from '../core/types.js';
import type { Store } from '../store/store.js';
import type {
  LangQuality,
  ParseErrorStats,
  PrecisionChecks,
  PrecisionSample,
  PrecisionStats,
  QualityReport,
} from './types.js';
import { writePortable } from './portable.js';

// ---------------------------------------------------------------------------------------------------------
// Seeded randomness

/** 32-bit FNV-1a hash of a string (seed derivation). */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 PRNG in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `k` distinct items drawn without replacement (partial Fisher-Yates), in draw order. */
export function sample<T>(items: readonly T[], k: number, rand: () => number): T[] {
  const a = [...items];
  const n = Math.min(k, a.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rand() * (a.length - i));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

// ---------------------------------------------------------------------------------------------------------
// Lexical helpers: blank out strings, regex literals and comments (newlines kept) so that brackets can be
// counted and line ends inspected. Strings become '0' runs (they are values), comments become spaces.

interface LexSpec {
  line: string[];
  block: boolean;
  nestedBlock?: boolean;
  /** Plain quote characters. */
  quotes: string[];
  /** Triple-quoted strings. */
  triple?: string[];
  /** Backtick strings: 'template' (JS, `${}` interpolation) or 'raw' (Go, no escapes). */
  backtick?: 'template' | 'raw';
  /** Interpolation opener inside double-quoted strings (`${` Kotlin/Scala, `#{` Ruby). */
  interp?: string;
  /** `'x'` is a char literal only when it is closed right away (Rust lifetimes, Scala symbols). */
  strictChar?: boolean;
  rustRaw?: boolean;
  /** C# verbatim (`@"..."`) and interpolated (`$"...{x}..."`) strings. */
  csharp?: boolean;
  /** Python string prefixes (f-strings interpolate `{...}`). */
  python?: boolean;
  /** `/re/` literals. */
  regex?: boolean;
  /** Ruby `=begin`/`=end`, heredocs, `%w[]`-style literals. */
  ruby?: boolean;
  /** PHP heredoc / nowdoc. */
  php?: boolean;
}

const C_LIKE: LexSpec = { line: ['//'], block: true, quotes: ['"', "'"] };

export const LEX: Record<Lang, LexSpec> = {
  java: { ...C_LIKE, triple: ['"""'] },
  c_sharp: { ...C_LIKE, triple: ['"""'], csharp: true },
  typescript: { ...C_LIKE, backtick: 'template', regex: true },
  tsx: { ...C_LIKE, backtick: 'template', regex: true },
  javascript: { ...C_LIKE, backtick: 'template', regex: true },
  go: { ...C_LIKE, backtick: 'raw' },
  kotlin: { ...C_LIKE, nestedBlock: true, triple: ['"""'], interp: '${' },
  scala: { line: ['//'], block: true, nestedBlock: true, quotes: ['"', "'"], triple: ['"""'], strictChar: true, interp: '${' },
  rust: { line: ['//'], block: true, nestedBlock: true, quotes: ['"', "'"], strictChar: true, rustRaw: true },
  php: { line: ['//', '#'], block: true, quotes: ['"', "'"], php: true },
  ruby: { line: ['#'], block: false, quotes: ['"', "'"], interp: '#{', regex: true, ruby: true, backtick: 'raw' },
  python: { line: ['#'], block: false, quotes: ['"', "'"], triple: ['"""', "'''"], python: true },
};

const REGEX_PREV = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_KEYWORDS = /(?:^|[^\w$])(return|typeof|case|do|else|in|of|yield|await|void|delete|instanceof|new|throw|when|if|unless|and|or|not|elsif|while|until)\s*$/;
const RUBY_PERCENT = /^%([qQwWiIrsx]?)([^\w\s])/;
const CLOSER: Record<string, string> = { '(': ')', '[': ']', '{': '}', '<': '>' };

/** Same length as `text`; strings/regexes replaced by '0', comments by spaces (newlines preserved). */
export function blankStringsAndComments(text: string, lang: Lang): string {
  const spec = LEX[lang];
  const out = text.split('');
  const n = text.length;
  const fill = (from: number, to: number, ch: string) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ch;
  };
  const pendingHeredocs: Array<{ id: string; php: boolean }> = [];

  /** Last significant (non-blank) char before `i` in the output, and the code before it on that line. */
  const prevSig = (i: number): { ch: string; before: string } => {
    let k = i - 1;
    while (k >= 0 && (out[k] === ' ' || out[k] === '\t' || out[k] === '\r')) k--;
    if (k < 0 || out[k] === '\n') return { ch: '', before: '' };
    const ls = out.lastIndexOf('\n', k) + 1;
    return { ch: out[k], before: out.slice(ls, k + 1).join('') };
  };

  /** Skips heredoc bodies queued on the line that ends at `nl` (index of '\n'); returns the new index. */
  const flushHeredocs = (nl: number): number => {
    let i = nl + 1;
    while (pendingHeredocs.length) {
      const h = pendingHeredocs.shift()!;
      let j = i;
      while (j < n) {
        let e = text.indexOf('\n', j);
        if (e < 0) e = n;
        const line = text.slice(j, e);
        const t = line.trim();
        const done = h.php ? t.startsWith(h.id) && !/[\w]/.test(t[h.id.length] ?? '') : t === h.id;
        if (done && h.php) {
          // PHP >= 7.3: code may follow the closing marker on the same line (`PATTERN, $x));`)
          const markerEnd = j + line.indexOf(h.id) + h.id.length;
          fill(j, markerEnd, '0');
          pendingHeredocs.length = 0;
          return markerEnd;
        }
        fill(j, e, '0');
        j = e + 1;
        if (done) break;
      }
      i = Math.min(j, n);
    }
    return i;
  };

  /** From `i` (just after an interpolation opener), scan code to the matching `}`; returns the index after it. */
  const skipCode = (i: number): number => {
    let depth = 0;
    while (i < n) {
      const e = special(i);
      if (e > i) {
        i = e;
        continue;
      }
      const c = text[i];
      if (c === '{') depth++;
      else if (c === '}') {
        if (depth === 0) return i + 1;
        depth--;
      }
      i++;
    }
    return n;
  };

  /** End of a quoted string whose body starts at `i`. */
  const skipQuoted = (i: number, close: string, o: { escapes: boolean; interp?: string; braces?: boolean; multiline?: boolean; doubledQuote?: boolean }): number => {
    let j = i;
    while (j < n) {
      if (o.escapes && text[j] === '\\') {
        j += 2;
        continue;
      }
      if (o.doubledQuote && text.startsWith(close + close, j) && close.length === 1) {
        j += 2;
        continue;
      }
      if (text.startsWith(close, j)) return j + close.length;
      if (o.interp && text.startsWith(o.interp, j)) {
        j = skipCode(j + o.interp.length);
        continue;
      }
      if (o.braces) {
        if (text.startsWith('{{', j)) {
          j += 2;
          continue;
        }
        if (text[j] === '{') {
          j = skipCode(j + 1);
          continue;
        }
      }
      if (text[j] === '\n' && !o.multiline) return -1;
      j++;
    }
    return o.multiline ? n : -1;
  };

  /** If a comment / string / regex starts at `i`, blanks it and returns its end; else returns -1. */
  function special(i: number): number {
    const c = text[i];
    if (c === '\n' && pendingHeredocs.length) return flushHeredocs(i);
    if (spec.line.some((t) => text.startsWith(t, i)) && !(lang === 'php' && c === '#' && text[i + 1] === '[') && !(lang === 'ruby' && text[i - 1] === '?')) {
      let j = text.indexOf('\n', i);
      if (j < 0) j = n;
      fill(i, j, ' ');
      return j;
    }
    if (spec.block && c === '/' && text[i + 1] === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (spec.nestedBlock && text.startsWith('/*', j)) {
          depth++;
          j += 2;
        } else if (text.startsWith('*/', j)) {
          depth--;
          j += 2;
        } else j++;
      }
      fill(i, j, ' ');
      return j;
    }
    if (spec.ruby && c === '=' && text.startsWith('=begin', i) && (i === 0 || text[i - 1] === '\n')) {
      const e = text.indexOf('\n=end', i);
      const j = e < 0 ? n : e + 5;
      fill(i, j, ' ');
      return j;
    }
    if (spec.ruby && c === '<' && text[i + 1] === '<') {
      const m = /^<<([~-]?)(['"`]?)([A-Za-z_]\w*)\2/.exec(text.slice(i, i + 80));
      if (m && (m[1] || m[2] || /^[A-Z_]/.test(m[3])) && text[i + 2] !== ' ') {
        pendingHeredocs.push({ id: m[3], php: false });
        fill(i, i + m[0].length, '0');
        return i + m[0].length;
      }
    }
    if (spec.php && c === '<' && text.startsWith('<<<', i)) {
      const m = /^<<<[ \t]*(['"]?)([A-Za-z_]\w*)\1/.exec(text.slice(i, i + 80));
      if (m) {
        pendingHeredocs.push({ id: m[2], php: true });
        fill(i, i + m[0].length, '0');
        return i + m[0].length;
      }
    }
    if (spec.rustRaw && (c === 'r' || c === 'b') && !/[\w]/.test(text[i - 1] ?? '')) {
      const m = /^b?r(#*)"/.exec(text.slice(i, i + 16));
      if (m) {
        const close = '"' + m[1];
        const e = text.indexOf(close, i + m[0].length);
        const j = e < 0 ? n : e + close.length;
        fill(i, j, '0');
        return j;
      }
    }
    if (spec.python && /[rRbBfFuU]/.test(c) && !/[\w]/.test(text[i - 1] ?? '')) {
      const m = /^([rRbBfFuU]{1,2})("""|'''|"|')/.exec(text.slice(i, i + 6));
      if (m) {
        const f = /[fF]/.test(m[1]);
        const raw = /[rR]/.test(m[1]);
        const q = m[2];
        const j = skipQuoted(i + m[0].length, q, { escapes: !raw, braces: f, multiline: q.length === 3 });
        const end = j < 0 ? i + m[0].length : j;
        fill(i, end, '0');
        return end;
      }
    }
    const tq = spec.triple?.find((t) => text.startsWith(t, i));
    if (tq) {
      const j = skipQuoted(i + 3, tq, { escapes: lang !== 'kotlin' && lang !== 'scala', interp: spec.interp, multiline: true });
      fill(i, j, '0');
      return j;
    }
    if (spec.csharp && (c === '@' || c === '$') && /^(\$@|@\$|@|\$+)"/.test(text.slice(i, i + 4))) {
      const m = /^(\$@|@\$|@|\$+)"/.exec(text.slice(i, i + 4))!;
      const verbatim = m[1].includes('@');
      const interp = m[1].includes('$');
      const j = skipQuoted(i + m[0].length, '"', { escapes: !verbatim, doubledQuote: verbatim, braces: interp, multiline: verbatim });
      const end = j < 0 ? i + m[0].length : j;
      fill(i, end, '0');
      return end;
    }
    if (spec.backtick && c === '`') {
      const j = spec.backtick === 'template'
        ? skipQuoted(i + 1, '`', { escapes: true, interp: '${', multiline: true })
        : skipQuoted(i + 1, '`', { escapes: false, multiline: true });
      fill(i, j, '0');
      return j;
    }
    if (spec.regex && c === '/' && text[i + 1] !== '/' && text[i + 1] !== '*') {
      const p = prevSig(i);
      if (p.ch === '' || REGEX_PREV.has(p.ch) || REGEX_KEYWORDS.test(p.before)) {
        let j = i + 1;
        let cls = false;
        while (j < n && text[j] !== '\n') {
          const d = text[j];
          if (d === '\\') {
            j += 2;
            continue;
          }
          if (cls) {
            if (d === ']') cls = false;
          } else if (d === '[') cls = true;
          else if (d === '/') break;
          else if (spec.ruby && text.startsWith('#{', j)) {
            j = skipCode(j + 2);
            continue;
          }
          j++;
        }
        if (j < n && text[j] === '/') {
          j++;
          while (j < n && /[a-z]/i.test(text[j])) j++;
          fill(i, j, '0');
          return j;
        }
      }
    }
    if (spec.ruby && c === '%') {
      const m = RUBY_PERCENT.exec(text.slice(i, i + 3));
      const p = prevSig(i);
      if (m && (p.ch === '' || REGEX_PREV.has(p.ch) || REGEX_KEYWORDS.test(p.before))) {
        const open = m[2];
        const close = CLOSER[open] ?? open;
        const interp = m[1] === '' || /[QWIrx]/.test(m[1]);
        let depth = 1;
        let j = i + m[0].length;
        while (j < n) {
          const d = text[j];
          if (d === '\\') {
            j += 2;
            continue;
          }
          if (interp && text.startsWith('#{', j)) {
            j = skipCode(j + 2);
            continue;
          }
          if (close !== open && d === open) depth++;
          else if (d === close && --depth === 0) {
            j++;
            break;
          }
          j++;
        }
        fill(i, j, '0');
        return j;
      }
    }
    if (spec.quotes.includes(c)) {
      if (c === "'" && spec.strictChar) {
        const m = /^'(?:\\.[^'\n]{0,8}|[^'\\\n])'/.exec(text.slice(i, i + 14));
        if (!m) return -1;
        fill(i, i + m[0].length, '0');
        return i + m[0].length;
      }
      const interp = c === '"' ? spec.interp : undefined;
      const j = skipQuoted(i + 1, c, { escapes: true, interp, multiline: lang === 'ruby' || lang === 'php' });
      // unterminated on this line: not a string after all (apostrophe in a comment-like context)
      if (j < 0) return -1;
      fill(i, j, '0');
      return j;
    }
    return -1;
  }

  let i = 0;
  while (i < n) {
    const e = special(i);
    i = e > i ? e : i + 1;
  }
  return out.join('');
}

export function bracketBalance(code: string): { round: number; square: number; curly: number; minCurly: number } {
  let round = 0;
  let square = 0;
  let curly = 0;
  let minCurly = 0;
  for (const ch of code) {
    if (ch === '(') round++;
    else if (ch === ')') round--;
    else if (ch === '[') square++;
    else if (ch === ']') square--;
    else if (ch === '{') curly++;
    else if (ch === '}') {
      curly--;
      if (curly < minCurly) minCurly = curly;
    }
  }
  return { round, square, curly, minCurly };
}

// ---------------------------------------------------------------------------------------------------------
// Precision checks

const ANNOTATION_START: Record<Lang, RegExp> = {
  java: /^@(?!interface\b)[\w.]+/,
  kotlin: /^@[\w.:]+/,
  scala: /^@[\w.]+/,
  python: /^@[\w.]+/,
  typescript: /^@[\w.]+/,
  tsx: /^@[\w.]+/,
  javascript: /^@[\w.]+/,
  c_sharp: /^\[[A-Za-z][\w.]*(\(|\]|,|:)/,
  rust: /^#!?\[/,
  php: /^#\[/,
  go: /^\/\/go:/,
  ruby: /^$a/, // never
};

const COMMENT_START: Record<Lang, RegExp> = {
  java: /^(\/\/|\/\*|\*)/,
  kotlin: /^(\/\/|\/\*|\*)/,
  scala: /^(\/\/|\/\*|\*)/,
  typescript: /^(\/\/|\/\*|\*)/,
  tsx: /^(\/\/|\/\*|\*)/,
  javascript: /^(\/\/|\/\*|\*)/,
  c_sharp: /^(\/\/|\/\*|\*)/,
  rust: /^(\/\/|\/\*|\*)/,
  go: /^(\/\/|\/\*|\*)/,
  php: /^(\/\/|\/\*|\*|#(?!\[))/,
  python: /^#/,
  ruby: /^#/,
};

const DECL_KEYWORDS: Record<Lang, RegExp> = {
  java: /^(public|protected|private|static|final|abstract|synchronized|native|default|sealed|non-sealed|strictfp|transient|volatile|class|interface|enum|record|@interface|void)\b/,
  kotlin: /^(public|protected|private|internal|open|abstract|final|override|sealed|data|inline|value|enum|annotation|inner|lateinit|const|suspend|operator|infix|tailrec|external|expect|actual|companion|class|interface|object|fun|val|var|typealias|constructor|init|get|set)\b/,
  scala: /^(private|protected|final|sealed|abstract|implicit|lazy|override|case|inline|opaque|transparent|given|extension|class|trait|object|def|val|var|type|enum|package)\b/,
  typescript: /^(export|default|declare|abstract|async|public|private|protected|static|readonly|override|accessor|get|set|class|interface|function|const|let|var|type|enum|namespace|module)\b/,
  tsx: /^(export|default|declare|abstract|async|public|private|protected|static|readonly|override|accessor|get|set|class|interface|function|const|let|var|type|enum|namespace|module)\b/,
  javascript: /^(export|default|async|static|get|set|class|function|const|let|var)\b/,
  c_sharp: /^(public|protected|private|internal|static|readonly|sealed|abstract|virtual|override|partial|async|extern|unsafe|new|const|event|delegate|class|interface|enum|struct|record|namespace|implicit|explicit|operator|required|file|volatile|fixed)\b/,
  rust: /^(pub|pub\(\w+\)|const|static|fn|struct|enum|trait|impl|mod|type|union|unsafe|async|extern|macro_rules!)/,
  go: /^(func|type|var|const)\b/,
  php: /^(public|protected|private|static|final|abstract|readonly|function|class|interface|trait|enum|const|namespace)\b/,
  ruby: /^(def|class|module|attr_reader|attr_writer|attr_accessor|alias|alias_method|define_method|scope|has_many|has_one|belongs_to|delegate|private|protected|public)\b/,
  python: /^(async\s+def|def|class)\b|^[A-Za-z_]\w*\s*(:[^=]+)?=/,
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-identifier occurrence. PHP variables/properties keep their `$` in source but not in names. */
export function hasIdentifier(text: string, name: string, lang: Lang): boolean {
  if (!name) return false;
  const before = lang === 'php' ? '(?<![\\w])' : '(?<![\\w$])';
  // Ruby predicate/bang methods are distinct names (`valid` vs `valid?`); elsewhere `name?:` is an optional member
  const after = /[?!=]$/.test(name) ? '' : lang === 'ruby' ? '(?![\\w$?!])' : '(?![\\w$])';
  return new RegExp(`${before}${escapeRegex(name)}${after}`).test(text);
}

const indentOf = (line: string) => (/^[ \t]*/.exec(line)?.[0] ?? '').replace(/\t/g, '    ').length;

/** Identifiers of a text with annotations / attributes removed (`@Foo(...)`, `[Attr(...)]`, `#[...]`). */
export function signatureIdents(text: string): string[] {
  const noAnn = text
    .replace(/@[\w.]+(\((?:[^()]|\([^()]*\))*\))?/g, ' ')
    .replace(/#!?\[[^\]]*\]/g, ' ')
    .replace(/(^|[\s;{}])\[[A-Z][\w.]*(\((?:[^()]|\([^()]*\))*\))?(\s*,\s*[A-Z][\w.]*(\((?:[^()]|\([^()]*\))*\))?)*\]/g, '$1 ');
  return [...noAnn.matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]);
}

/** True when `needle` is a subsequence (in order, gaps allowed) of `hay`. */
export function isSubsequence(needle: string[], hay: string[]): boolean {
  let j = 0;
  for (let i = 0; i < hay.length && j < needle.length; i++) if (hay[i] === needle[j]) j++;
  return j === needle.length;
}

export interface SymbolForCheck {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  /** UTF-8 byte offsets of the declaration node (as stored by the indexer); checked when present. */
  startByte?: number;
  endByte?: number;
  signature: string;
}

const AT_ANNOTATION_LANGS: ReadonlySet<Lang> = new Set(['java', 'kotlin', 'scala', 'python', 'typescript', 'tsx', 'javascript']);

/** Index after the bracket group opened at `k` (any of ([{, nested), or text.length when unclosed. */
function skipGroup(text: string, k: number): number {
  let depth = 0;
  for (; k < text.length; k++) {
    const c = text[k];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return k + 1;
    }
  }
  return text.length;
}

/** End index of an annotation / decorator / attribute starting at `i` of blanked code, or -1. */
export function annotationEnd(code: string, i: number, lang: Lang): number {
  const c = code[i];
  if (c === '@' && AT_ANNOTATION_LANGS.has(lang) && /[A-Za-z_]/.test(code[i + 1] ?? '') && !code.startsWith('@interface', i)) {
    let j = i + 1;
    while (j < code.length && /[\w.:$]/.test(code[j])) j++;
    while (code[j] === '(' || code[j] === '[') j = skipGroup(code, j);
    return j;
  }
  if (c === '[' && lang === 'c_sharp') return skipGroup(code, i);
  if (c === '#' && (lang === 'rust' || lang === 'php')) {
    const b = code[i + 1] === '[' ? i + 1 : code[i + 1] === '!' && code[i + 2] === '[' ? i + 2 : -1;
    if (b > 0) return skipGroup(code, b);
  }
  return -1;
}

/**
 * Index (0-based, absolute) of the declaration line of a symbol whose range starts at line `start`: leading
 * blank lines, comments (already blanked in `code`) and annotations/decorators/attributes (possibly spanning
 * several lines) are skipped.
 */
export function declarationLine(code: string[], start: number, end: number, lang: Lang): number {
  const text = code.slice(start, end + 1).join('\n');
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    const a = annotationEnd(text, i, lang);
    if (a > i) {
      i = a;
      continue;
    }
    break;
  }
  if (i >= text.length) return start;
  let line = start;
  for (let k = 0; k < i; k++) if (text[k] === '\n') line++;
  return Math.min(line, end);
}

/** First line in [from, to] whose blanked code opens a `{` outside parentheses (the body start), else -1. */
function bodyOpenLine(code: string[], from: number, to: number): number {
  let round = 0;
  for (let i = from; i <= to && i < code.length; i++) {
    for (const ch of code[i]) {
      if (ch === '(' || ch === '[') round++;
      else if (ch === ')' || ch === ']') round--;
      else if (ch === '{' && round <= 0) return i;
    }
  }
  return -1;
}

const CONTINUATION_END = /(\(|\[|,|=|\+|-|\*|&&|\|\||\.|->|=>|\?|\\)\s*$/;
const BRACE_LANGS: ReadonlySet<Lang> = new Set(['java', 'c_sharp', 'typescript', 'tsx', 'javascript', 'go', 'kotlin', 'rust', 'php', 'scala']);
/** Brace languages where a body can also be an indented expression (Kotlin `= expr`, Scala 3 braceless). */
const EXPR_BODY_LANGS: ReadonlySet<Lang> = new Set(['scala', 'kotlin']);

/** Char offset of a UTF-8 byte offset in `text` (undefined when out of range). */
function charOffset(buf: Buffer, byte: number): number | undefined {
  if (byte < 0 || byte > buf.length) return undefined;
  return buf.subarray(0, byte).toString('utf8').length;
}

/** Runs the four mechanical checks of one symbol against the file text (BOM removed, line endings untouched). */
export function checkSymbol(text: string, sym: SymbolForCheck, lang: Lang): { checks: PrecisionChecks; reasons: string[] } {
  const lines = text.split('\n');
  const reasons: string[] = [];
  const s = sym.startLine - 1;
  const e = sym.endLine - 1;
  if (s < 0 || e < s || s >= lines.length) {
    return { checks: { name: false, start: false, end: false, signature: false }, reasons: [`range ${sym.startLine}-${sym.endLine} outside file (${lines.length} lines)`] };
  }
  const eClamped = Math.min(e, lines.length - 1);
  const blanked = blankStringsAndComments(text, lang);
  const code = blanked.split('\n');

  // exact node text from the byte offsets, when they are consistent with the line range
  let nodeFrom: number | undefined;
  let nodeTo: number | undefined;
  let bytesOk = true;
  if (sym.startByte !== undefined && sym.endByte !== undefined) {
    const buf = Buffer.from(text, 'utf8');
    nodeFrom = charOffset(buf, sym.startByte);
    nodeTo = charOffset(buf, sym.endByte);
    if (nodeFrom === undefined || nodeTo === undefined || nodeTo < nodeFrom) bytesOk = false;
    else {
      const lineOf = (off: number) => {
        let n = 1;
        for (let k = text.indexOf('\n'); k !== -1 && k < off; k = text.indexOf('\n', k + 1)) n++;
        return n;
      };
      const ls = lineOf(nodeFrom);
      const le = lineOf(Math.max(nodeFrom, nodeTo - 1));
      if (ls !== sym.startLine || le !== sym.endLine) {
        bytesOk = false;
        reasons.push(`byte range maps to lines ${ls}-${le}, stored lines are ${sym.startLine}-${sym.endLine}`);
      }
    }
  }
  if (!bytesOk) {
    nodeFrom = undefined;
    nodeTo = undefined;
  }
  const lineStart = (i: number) => {
    let off = 0;
    for (let k = 0; k < i; k++) off += lines[k].length + 1;
    return off;
  };
  const from = nodeFrom ?? lineStart(s);
  const to = nodeTo ?? lineStart(eClamped) + lines[eClamped].length;
  const nodeCode = blanked.slice(from, to);
  const nodeText = text.slice(from, to);

  const decl = declarationLine(code, s, eClamped, lang);
  // (a) name on the header: from the range start to the line that opens the body (or 3 lines past the
  // declaration line when there is none), so long generic/parameter lists still count as the header
  const headerEnd = Math.min(eClamped, Math.max(decl + 3, bodyOpenLine(code, decl, Math.min(eClamped, decl + 20))));
  const headerText = lines.slice(s, headerEnd + 1).join('\n');
  // constructors are named after their type but declared with a keyword in several languages
  const name =
    hasIdentifier(headerText, sym.name, lang) ||
    (sym.kind === 'constructor' && /(?<![\w$])(constructor|init|__init__|__construct|initialize|new|this)(?![\w$])/.test(headerText));
  if (!name) reasons.push(`name '${sym.name}' not on header lines ${s + 1}-${headerEnd + 1}`);

  // (b1) start: consistent bytes, and the first line is a comment/annotation or a declaration-looking line
  const first = lines[s].trim();
  const firstFromNode = nodeFrom !== undefined ? text.slice(nodeFrom, text.indexOf('\n', nodeFrom) < 0 ? undefined : text.indexOf('\n', nodeFrom)).trim() : first;
  let firstNoAnn = firstFromNode.replace(/^(@[\w.:]+(\((?:[^()]|\([^()]*\))*\))?\s*)+/, '');
  if (lang === 'c_sharp') firstNoAnn = firstNoAnn.replace(/^(\[[^\]]*\]\s*)+/, '');
  if (lang === 'rust' || lang === 'php') firstNoAnn = firstNoAnn.replace(/^(#!?\[[^\]]*\]\s*)+/, '');
  let start =
    bytesOk &&
    (COMMENT_START[lang].test(firstFromNode) ||
      ANNOTATION_START[lang].test(firstFromNode) ||
      DECL_KEYWORDS[lang].test(firstNoAnn) ||
      (hasIdentifier(firstFromNode, sym.name, lang) && !/^[)\]}.,;:+\-/%&|^!?>=]/.test(firstNoAnn)));
  if (start && nodeFrom === undefined && s > 0) {
    // without byte offsets: the previous code line must not leave the declaration open (`export`, `public` alone)
    let p = s - 1;
    while (p >= 0 && !code[p].trim()) p--;
    const prev = p >= 0 ? code[p].trim() : '';
    if (/^(export|public|private|protected|static|default|async|override|abstract|final)$/.test(prev)) {
      start = false;
      reasons.push(`declaration starts on line ${p + 1} ('${prev}'), before the range`);
    }
  }
  if (!start && bytesOk && !reasons.some((r) => r.startsWith('declaration starts'))) {
    reasons.push(`start does not look like a declaration: ${JSON.stringify(firstFromNode.slice(0, 80))}`);
  }

  // (b2) end
  let end = bytesOk;
  const bal = bracketBalance(nodeCode);
  const unbalanced = bal.round !== 0 || bal.square !== 0 || bal.curly !== 0 || bal.minCurly < 0;
  const nodeLines = nodeCode.split('\n');
  let li = nodeLines.length - 1;
  while (li > 0 && !nodeLines[li].trim()) li--;
  const lastCode = nodeLines[li].trim();
  const lastRaw = (nodeText.split('\n')[li] ?? '').trim();
  const multiLine = li > 0;
  let next = eClamped + 1;
  while (next < lines.length && !code[next].trim()) next++;
  const nextCode = next < lines.length ? code[next] : undefined;
  const declIndent = indentOf(lines[decl]);
  if (unbalanced) {
    end = false;
    reasons.push(`unbalanced brackets in the declaration (round ${bal.round}, square ${bal.square}, curly ${bal.curly})`);
  }
  if (lang === 'python') {
    if (nextCode !== undefined && indentOf(nextCode) > declIndent && !/^\s*[)\]}]/.test(nextCode)) {
      end = false;
      reasons.push(`line ${next + 1} after the range is still indented inside the block`);
    }
  } else if (lang === 'ruby') {
    if (multiLine) {
      // a multi-line literal (`%w[...]`, heredoc, string) is blanked to '0' by the lexer
      if (!/^(end\b|\}|\]|\)|0)/.test(lastCode)) {
        end = false;
        reasons.push(`last line is not a block end: ${JSON.stringify(lastRaw.slice(0, 60))}`);
      } else if (/^end\b/.test(lastCode) && indentOf(lines[eClamped]) !== declIndent) {
        end = false;
        reasons.push(`'end' on line ${eClamped + 1} is not aligned with the declaration (indent ${indentOf(lines[eClamped])} vs ${declIndent})`);
      }
    }
  } else if (BRACE_LANGS.has(lang)) {
    if (end && multiLine && CONTINUATION_END.test(lastCode) && !/^[})\]]/.test(lastCode)) {
      end = false;
      reasons.push(`last line ends mid-expression: ${JSON.stringify(lastRaw.slice(0, 60))}`);
    }
    if (end && nextCode !== undefined && /^\s*(\.|\?\.)[A-Za-z_]/.test(nextCode)) {
      end = false;
      reasons.push(`line ${next + 1} continues the expression (${JSON.stringify(nextCode.trim().slice(0, 40))})`);
    }
    if (end && EXPR_BODY_LANGS.has(lang) && multiLine && nextCode !== undefined && !/[}]/.test(lastCode) && indentOf(nextCode) > declIndent && !/^\s*[)\]}]/.test(nextCode)) {
      end = false;
      reasons.push(`line ${next + 1} after the range is still indented inside the body`);
    }
  }

  // (c) signature identifiers appear in order in the declaration source
  let sig = sym.signature;
  const cut = sig.indexOf('…');
  let sigIds = signatureIdents(cut >= 0 ? sig.slice(0, cut) : sig);
  if (cut >= 0 && sigIds.length) sigIds = sigIds.slice(0, -1); // the last identifier may be cut
  const srcIds = signatureIdents(nodeText);
  let signature = sigIds.length === 0 ? sig.trim().length > 0 : isSubsequence(sigIds, srcIds);
  // Go grouped declarations get a synthetic `type `/`const `/`var ` prefix
  if (!signature && sigIds.length > 1 && /^(type|const|var|func)$/.test(sigIds[0])) signature = isSubsequence(sigIds.slice(1), srcIds);
  if (!signature) {
    sig = sig.length > 80 ? sig.slice(0, 77) + '...' : sig;
    reasons.push(`signature identifiers not found in order in the source: ${JSON.stringify(sig)}`);
  }
  return { checks: { name, start, end, signature }, reasons };
}

// ---------------------------------------------------------------------------------------------------------
// Parse errors

/** Outermost ERROR nodes and MISSING nodes of a tree (only subtrees flagged `hasError` are visited). */
export function countParseErrors(root: Node): { errors: number; missing: number; firstErrorLine: number } {
  let errors = 0;
  let missing = 0;
  let firstErrorLine = 0;
  const stack: Node[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.isError) {
      errors++;
      const l = n.startPosition.row + 1;
      if (!firstErrorLine || l < firstErrorLine) firstErrorLine = l;
      continue;
    }
    if (n.isMissing) {
      missing++;
      const l = n.startPosition.row + 1;
      if (!firstErrorLine || l < firstErrorLine) firstErrorLine = l;
      continue;
    }
    if (!n.hasError) continue;
    for (let i = n.childCount - 1; i >= 0; i--) {
      const c = n.child(i);
      if (c) stack.push(c);
    }
  }
  return { errors, missing, firstErrorLine };
}

const PARSE_TIMEOUT_MS = 5000;

async function parseSample(repoRoot: string, lang: Lang, paths: string[]): Promise<ParseErrorStats> {
  const { parserFor } = await import('../indexer/languages.js');
  const parser = await parserFor(lang);
  const stats: ParseErrorStats = {
    sampledFiles: 0, sampledLines: 0, filesWithErrors: 0, errorNodes: 0, missingNodes: 0, errorFileRate: 0, errorsPerKloc: 0, parseFailures: 0, worst: [],
  };
  const worst: ParseErrorStats['worst'] = [];
  for (const path of paths) {
    let text: string;
    try {
      text = readFileSync(join(repoRoot, path), 'utf8');
    } catch {
      stats.parseFailures++;
      continue;
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const deadline = performance.now() + PARSE_TIMEOUT_MS;
    let tree;
    try {
      tree = parser.parse(text, null, { progressCallback: () => performance.now() > deadline });
    } catch {
      tree = null;
    }
    if (!tree) {
      parser.reset();
      stats.parseFailures++;
      continue;
    }
    try {
      const c = countParseErrors(tree.rootNode);
      stats.sampledFiles++;
      stats.sampledLines += text.split('\n').length;
      stats.errorNodes += c.errors;
      stats.missingNodes += c.missing;
      if (c.errors + c.missing > 0) {
        stats.filesWithErrors++;
        worst.push({ path, errors: c.errors + c.missing, firstErrorLine: c.firstErrorLine });
      }
    } finally {
      tree.delete();
    }
  }
  stats.errorFileRate = stats.sampledFiles ? stats.filesWithErrors / stats.sampledFiles : 0;
  stats.errorsPerKloc = stats.sampledLines ? ((stats.errorNodes + stats.missingNodes) * 1000) / stats.sampledLines : 0;
  stats.worst = worst.sort((a, b) => b.errors - a.errors || (a.path < b.path ? -1 : 1)).slice(0, 8);
  return stats;
}

// ---------------------------------------------------------------------------------------------------------
// Report

export interface QualityOptions {
  repo: string;
  repoRoot: string;
  store: Store;
  /** Primary language (listed first and headlined). */
  language?: Lang;
  index: QualityReport['index'];
  headCommit?: string;
  /** Files re-parsed per language (default 1000). */
  parseSample?: number;
  /** Symbols checked per language (default 30). */
  precisionSample?: number;
  /** Languages with fewer indexed files are reported without parse/precision samples (default 20). */
  minFiles?: number;
  seed?: string;
  onProgress?: (m: string) => void;
}

const ratio = (a: number, b: number) => (b ? a / b : 0);
const round = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d;

export async function runQuality(o: QualityOptions): Promise<QualityReport> {
  const t0 = Date.now();
  const log = o.onProgress ?? (() => {});
  const db = o.store.db;
  const parseN = o.parseSample ?? 1000;
  const precN = o.precisionSample ?? 30;
  const minFiles = o.minFiles ?? 20;
  const seed = o.seed ?? o.repo;

  const fileRows = db.prepare('SELECT lang, count(*) AS n, coalesce(sum(line_count), 0) AS lines FROM files GROUP BY lang').all() as Array<{ lang: string | null; n: number; lines: number }>;
  const indexedByLang: Record<string, number> = {};
  for (const r of fileRows) indexedByLang[r.lang ?? 'other'] = r.n;
  let skippedByReason: Record<string, number> = {};
  try {
    for (const r of db.prepare('SELECT reason, count(*) AS n FROM idx_skipped GROUP BY reason').all() as Array<{ reason: string; n: number }>) skippedByReason[r.reason] = r.n;
  } catch {
    skippedByReason = {};
  }
  const symRows = db
    .prepare('SELECT f.lang AS lang, s.kind AS kind, count(*) AS n FROM symbols s JOIN files f ON f.id = s.file_id GROUP BY f.lang, s.kind')
    .all() as Array<{ lang: string; kind: string; n: number }>;
  const refRows = db
    .prepare('SELECT f.lang AS lang, r.kind AS kind, count(*) AS n, sum(r.to_symbol_id IS NOT NULL) AS res FROM refs r JOIN files f ON f.id = r.file_id GROUP BY f.lang, r.kind')
    .all() as Array<{ lang: string; kind: string; n: number; res: number }>;
  log('quality: refs with an in-repo candidate');
  const candRows = db
    .prepare(
      `SELECT f.lang AS lang, count(*) AS n, sum(r.to_symbol_id IS NOT NULL) AS res FROM refs r JOIN files f ON f.id = r.file_id
       WHERE EXISTS (SELECT 1 FROM symbols s WHERE s.name = r.name) GROUP BY f.lang`,
    )
    .all() as Array<{ lang: string; n: number; res: number }>;

  const langs = fileRows
    .filter((r) => r.lang)
    .sort((a, b) => Number(b.lang === o.language) - Number(a.lang === o.language) || b.n - a.n || (a.lang! < b.lang! ? -1 : 1));
  const out: LangQuality[] = [];
  for (const fr of langs) {
    const lang = fr.lang as Lang;
    const kloc = fr.lines / 1000;
    const byKind: LangQuality['byKind'] = {};
    let symbols = 0;
    for (const r of symRows.filter((x) => x.lang === lang).sort((a, b) => b.n - a.n)) {
      byKind[r.kind] = { count: r.n, perKloc: round(ratio(r.n, kloc), 2) };
      symbols += r.n;
    }
    const refsByKind: LangQuality['refsByKind'] = {};
    let refs = 0;
    let refsResolved = 0;
    for (const r of refRows.filter((x) => x.lang === lang).sort((a, b) => b.n - a.n)) {
      refsByKind[r.kind] = { total: r.n, resolved: r.res };
      refs += r.n;
      refsResolved += r.res;
    }
    const cand = candRows.find((x) => x.lang === lang);
    const rand = rng(hashSeed(`${seed}:${lang}`));
    let parse: ParseErrorStats = { sampledFiles: 0, sampledLines: 0, filesWithErrors: 0, errorNodes: 0, missingNodes: 0, errorFileRate: 0, errorsPerKloc: 0, parseFailures: 0, worst: [] };
    let precision: PrecisionStats = { sampled: 0, nameOk: 0, startOk: 0, endOk: 0, signatureOk: 0, allOk: 0, rate: 0, failures: [] };
    if (fr.n >= minFiles || lang === o.language) {
      const paths = (db.prepare('SELECT path FROM files WHERE lang = ? ORDER BY path').all(lang) as Array<{ path: string }>).map((r) => r.path);
      log(`quality: ${lang}: parsing ${Math.min(parseN, paths.length)} of ${paths.length} files`);
      parse = await parseSample(o.repoRoot, lang, sample(paths, parseN, rand));
      const ids = (db.prepare('SELECT s.id AS id FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.lang = ? ORDER BY s.id').all(lang) as Array<{ id: number }>).map((r) => r.id);
      log(`quality: ${lang}: checking ${Math.min(precN, ids.length)} of ${ids.length} symbols`);
      precision = checkPrecision(o, lang, sample(ids, precN, rand));
    }
    out.push({
      lang,
      files: fr.n,
      lines: fr.lines,
      symbols,
      symbolsPerKloc: round(ratio(symbols, kloc), 2),
      byKind,
      refs,
      refsResolved,
      resolvedRate: round(ratio(refsResolved, refs)),
      refsWithCandidate: cand?.n ?? 0,
      resolvedOfCandidates: round(ratio(cand?.res ?? 0, cand?.n ?? 0)),
      refsByKind,
      parse: { ...parse, errorFileRate: round(parse.errorFileRate), errorsPerKloc: round(parse.errorsPerKloc, 3) },
      precision,
    });
  }
  const skipped = Object.values(skippedByReason).reduce((a, b) => a + b, 0);
  return {
    repo: o.repo,
    language: o.language,
    repoRoot: o.repoRoot,
    headCommit: o.headCommit,
    date: new Date().toISOString(),
    index: o.index,
    files: { indexed: fileRows.reduce((a, r) => a + r.n, 0), skipped, skippedByReason, indexedByLang },
    langs: out,
    settings: { parseSamplePerLang: parseN, precisionSamplePerLang: precN, seed },
    durationMs: Date.now() - t0,
  };
}

function checkPrecision(o: QualityOptions, lang: Lang, ids: number[]): PrecisionStats {
  const st: PrecisionStats = { sampled: 0, nameOk: 0, startOk: 0, endOk: 0, signatureOk: 0, allOk: 0, rate: 0, failures: [] };
  const q = o.store.db.prepare(
    `SELECT s.id AS id, s.name AS name, s.kind AS kind, s.start_line AS start_line, s.end_line AS end_line, s.start_byte AS start_byte,
       s.end_byte AS end_byte, s.signature AS signature, f.path AS path FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?`,
  );
  const texts = new Map<string, string | undefined>();
  for (const id of ids) {
    const r = q.get(id) as
      | { id: number; name: string; kind: string; start_line: number; end_line: number; start_byte: number; end_byte: number; signature: string; path: string }
      | undefined;
    if (!r) continue;
    if (!texts.has(r.path)) {
      const abs = join(o.repoRoot, r.path);
      let t = existsSync(abs) ? readFileSync(abs, 'utf8') : undefined;
      if (t && t.charCodeAt(0) === 0xfeff) t = t.slice(1);
      texts.set(r.path, t);
    }
    const text = texts.get(r.path);
    st.sampled++;
    const res = text === undefined
      ? { checks: { name: false, start: false, end: false, signature: false }, reasons: ['file missing on disk'] }
      : checkSymbol(
          text,
          { name: r.name, kind: r.kind, startLine: r.start_line, endLine: r.end_line, startByte: r.start_byte, endByte: r.end_byte, signature: r.signature },
          lang,
        );
    const { checks } = res;
    if (checks.name) st.nameOk++;
    if (checks.start) st.startOk++;
    if (checks.end) st.endOk++;
    if (checks.signature) st.signatureOk++;
    const ok = checks.name && checks.start && checks.end && checks.signature;
    if (ok) st.allOk++;
    else {
      const ls = text?.split('\n') ?? [];
      st.failures.push({
        id: r.id,
        path: r.path,
        name: r.name,
        kind: r.kind,
        startLine: r.start_line,
        endLine: r.end_line,
        checks,
        ok,
        reasons: res.reasons,
        firstLine: (ls[r.start_line - 1] ?? '').trim().slice(0, 160),
        lastLine: (ls[r.end_line - 1] ?? '').trim().slice(0, 160),
        signature: r.signature.slice(0, 200),
      });
    }
  }
  st.rate = round(ratio(st.allOk, st.sampled));
  return st;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const num = (x: number) => Math.round(x).toLocaleString('en-US');

function table(head: string[], rows: string[][]): string {
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

const md = (s: string) => s.replace(/\|/g, '\\|').replace(/`/g, "'");

export function renderQualityMarkdown(q: QualityReport): string {
  const out: string[] = [];
  out.push(`# kopt bench quality: ${q.repo}`);
  out.push('');
  out.push(
    `${q.language ? `Primary language \`${q.language}\` · ` : ''}${q.headCommit ? `commit \`${q.headCommit.slice(0, 12)}\` · ` : ''}` +
      `${num(q.files.indexed)} files indexed, ${num(q.files.skipped)} skipped` +
      `${q.files.skipped ? ` (${Object.entries(q.files.skippedByReason).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''} · ` +
      `index ${q.index.built ? `built in ${q.index.durationMs !== null ? num(q.index.durationMs) : '?'} ms` : `reused${q.index.durationMs !== null ? ` (build took ${num(q.index.durationMs)} ms)` : ''}`} · ${q.date}`,
  );
  out.push('');
  out.push('## Per language');
  out.push('');
  out.push(
    table(
      ['lang', 'files', 'KLOC', 'symbols/KLOC', 'refs resolved', 'resolved of in-repo names', 'files with parse errors', 'parse errors/KLOC', 'precision sample'],
      q.langs.map((l) => [
        l.lang,
        num(l.files),
        (l.lines / 1000).toFixed(1),
        l.symbolsPerKloc.toFixed(1),
        pct(l.resolvedRate),
        pct(l.resolvedOfCandidates),
        l.parse.sampledFiles ? `${pct(l.parse.errorFileRate)} (${l.parse.filesWithErrors}/${l.parse.sampledFiles})` : 'n/a',
        l.parse.sampledFiles ? l.parse.errorsPerKloc.toFixed(2) : 'n/a',
        l.precision.sampled ? `${pct(l.precision.rate)} (${l.precision.allOk}/${l.precision.sampled})` : 'n/a',
      ]),
    ),
  );
  out.push('');
  out.push('`refs resolved` counts every reference, library calls included. `resolved of in-repo names` only counts references');
  out.push('whose name is defined somewhere in the repo, i.e. where an in-repo target is plausible.');
  out.push('');
  for (const l of q.langs) {
    out.push(`## ${l.lang}`);
    out.push('');
    out.push(`Symbols by kind (count, per KLOC): ${Object.entries(l.byKind).map(([k, v]) => `${k} ${num(v.count)} (${v.perKloc})`).join(', ') || 'none'}.`);
    out.push('');
    out.push(`Refs by kind (resolved/total): ${Object.entries(l.refsByKind).map(([k, v]) => `${k} ${num(v.resolved)}/${num(v.total)} (${pct(ratio(v.resolved, v.total))})`).join(', ') || 'none'}.`);
    out.push('');
    if (l.parse.sampledFiles) {
      out.push(
        `Parse sample: ${l.parse.sampledFiles} files, ${num(l.parse.sampledLines)} lines, ${l.parse.errorNodes} ERROR + ${l.parse.missingNodes} MISSING nodes` +
          `${l.parse.parseFailures ? `, ${l.parse.parseFailures} parse failures` : ''}.` +
          (l.parse.worst.length ? ` Worst: ${l.parse.worst.slice(0, 5).map((w) => `\`${w.path}:${w.firstErrorLine}\` (${w.errors})`).join(', ')}.` : ''),
      );
      out.push('');
    }
    const p = l.precision;
    if (p.sampled) {
      out.push(
        `Precision sample: ${p.sampled} symbols · name on header ${p.nameOk}/${p.sampled} · start ${p.startOk}/${p.sampled} · ` +
          `end ${p.endOk}/${p.sampled} · signature ${p.signatureOk}/${p.sampled} · all ${p.allOk}/${p.sampled}.`,
      );
      out.push('');
      if (p.failures.length) {
        out.push(
          table(
            ['symbol', 'kind', 'range', 'failed', 'why'],
            p.failures.map((f) => [
              `\`${md(f.name)}\``,
              f.kind,
              `\`${md(f.path)}:${f.startLine}-${f.endLine}\``,
              (Object.entries(f.checks) as Array<[string, boolean]>).filter(([, v]) => !v).map(([k]) => k).join(', '),
              md(f.reasons.join('; ')).slice(0, 220),
            ]),
          ),
        );
        out.push('');
      }
    }
  }
  out.push('## Method');
  out.push('');
  out.push(`- Parse errors: up to ${q.settings.parseSamplePerLang} indexed files per language, re-parsed with the indexer's web-tree-sitter grammar (JavaScript uses the TSX grammar, like the indexer); outermost ERROR nodes and MISSING nodes are counted.`);
  out.push(`- Precision: ${q.settings.precisionSamplePerLang} random symbols per language (seed \`${q.settings.seed}\`). Checks: (a) the name is a whole identifier on the header lines (range start to 3 lines past the declaration line, after comments and annotations); (b) the first line is a comment, an annotation or a declaration-looking line, and the range ends at a plausible block end (balanced brackets outside strings/comments, closing brace or aligned \`end\`, nothing indented or chained after it); (c) the identifiers of the stored signature appear in order in the source of the range.`);
  out.push('- These are heuristics. A failed sample is a pointer to inspect, not proof of an extraction bug.');
  out.push(`- Duration: ${num(q.durationMs)} ms.`);
  out.push('');
  return out.join('\n');
}

/** Writes `quality-<repo>.md` and `quality-<repo>.json` into `outDir`. */
export function writeQuality(q: QualityReport, outDir: string): string[] {
  mkdirSync(outDir, { recursive: true });
  const safe = q.repo.replace(/[^\w.-]+/g, '_');
  const mdPath = join(outDir, `quality-${safe}.md`);
  const jsonPath = join(outDir, `quality-${safe}.json`);
  writePortable(mdPath, renderQualityMarkdown(q));
  writePortable(jsonPath, JSON.stringify(q, null, 2) + '\n');
  return [mdPath, jsonPath];
}
