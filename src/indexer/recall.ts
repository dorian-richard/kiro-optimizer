// Extraction recall check (for the benchmark's quality pass): lines that look like a declaration but have no
// covering symbol. The precision check only looks at symbols that were extracted, so a silently dropped class
// body (Kotlin `class X : I by impl { ... }`) or a grammar failure scores 100% there; this check finds them.
//
// Heuristic by design: one regex per language over raw lines (comments and strings are not parsed), so the
// absolute rate is approximate. Compare it between two extractor versions, not across languages. Declarations
// inside a function or method body, or inside a value (lambda, anonymous class), are excluded: locals are never
// indexed on purpose.

import type { ExtractedSymbol, Lang } from '../core/types.js';

export interface DefinitionSite {
  /** 1-based line. */
  line: number;
  name: string;
  /** Keyword that introduced it (class, def, fun, func, fn, function, method...). */
  keyword: string;
  text: string;
}

export interface RecallCheck {
  /** Definition-looking lines considered (outside function bodies). */
  sites: number;
  /** Of those, lines with a symbol of that name whose range contains the line. */
  covered: number;
  missing: DefinitionSite[];
}

type SymbolLike = Pick<ExtractedSymbol, 'name' | 'kind' | 'startLine' | 'endLine'>;

const MODS = String.raw`(?:(?:public|private|protected|internal|static|final|abstract|sealed|open|override|virtual|async|partial|readonly|export|default|declare|inline|suspend|data|enum|annotation|inner|value|implicit|lazy|case|unsafe|extern|const|pub(?:\([^)]*\))?|operator|infix|tailrec|external|actual|expect|synchronized|native|strictfp|transient|volatile|new|extern)\s+)*`;
const ANNOT = String.raw`(?:@[\w.]+(?:\([^)]*\))?\s+)*`;

interface Rule {
  re: RegExp;
  /** Capture group holding the name. */
  group: number;
  keyword: string | number;
}

const TYPE_DECL = (kw: string): Rule => ({ re: new RegExp(String.raw`^\s*${ANNOT}${MODS}(${kw})\s+([A-Za-z_$][\w$]*)`), group: 2, keyword: 1 });

const RULES: Record<Lang, Rule[]> = {
  java: [
    TYPE_DECL('class|interface|enum|record|@interface'),
    { re: new RegExp(String.raw`^\s*${ANNOT}${MODS}(?:<[^>]+>\s+)?[\w$.<>\[\]?, ]+\s+([a-z_$][\w$]*)\s*\([^;]*$`), group: 1, keyword: 'method' },
  ],
  c_sharp: [
    TYPE_DECL('class|interface|enum|record|struct'),
    { re: new RegExp(String.raw`^\s*(?:\[[^\]]*\]\s*)*${MODS}[\w.<>\[\]?, ]+\s+([A-Z_][\w]*)\s*(?:<[^>]*>)?\s*\([^;]*$`), group: 1, keyword: 'method' },
  ],
  kotlin: [
    TYPE_DECL('class|interface|object'),
    { re: new RegExp(String.raw`^\s*${ANNOT}${MODS}(fun)\s+(?:<[^>]*>\s*)?(?:[\w.<>?, *]+\.)?([A-Za-z_][\w]*)\s*\(`), group: 2, keyword: 1 },
  ],
  scala: [
    TYPE_DECL('class|trait|object|enum'),
    { re: new RegExp(String.raw`^\s*${ANNOT}${MODS}(?:(?:private|protected)\[[\w.]+\]\s+)?${MODS}(def)\s+([A-Za-z_][\w]*)`), group: 2, keyword: 1 },
  ],
  typescript: [
    TYPE_DECL('class|interface|enum|abstract class'),
    { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(function)\*?\s+([A-Za-z_$][\w$]*)/, group: 2, keyword: 1 },
  ],
  tsx: [],
  javascript: [],
  python: [
    { re: /^\s*(?:async\s+)?(def)\s+([A-Za-z_]\w*)/, group: 2, keyword: 1 },
    { re: /^\s*(class)\s+([A-Za-z_]\w*)/, group: 2, keyword: 1 },
  ],
  go: [
    { re: /^(func)\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, group: 2, keyword: 1 },
    { re: /^(type)\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/, group: 2, keyword: 1 },
  ],
  rust: [
    { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?(fn)\s+([A-Za-z_]\w*)/, group: 2, keyword: 1 },
    { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|union)\s+([A-Za-z_]\w*)/, group: 2, keyword: 1 },
  ],
  php: [
    { re: /^\s*(?:(?:abstract|final|readonly)\s+)*(class|interface|trait|enum)\s+([A-Za-z_]\w*)/, group: 2, keyword: 1 },
    { re: /^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*(function)\s+&?([A-Za-z_]\w*)\s*\(/, group: 2, keyword: 1 },
  ],
  ruby: [
    { re: /^\s*(def)\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/, group: 2, keyword: 1 },
    { re: /^\s*(class|module)\s+(?:[A-Z]\w*::)*([A-Z]\w*)/, group: 2, keyword: 1 },
  ],
};
RULES.tsx = RULES.typescript;
RULES.javascript = RULES.typescript;

const COMMENT_START = /^\s*(?:\/\/|\/\*|\*|#(?!\[)|--|<!--)/;
/** Statements that only look like `Type name(` declarations. */
const STATEMENT_START = /^\s*(?:return|throw|new|await|yield|else|case|var|val|let|const|goto|assert)\b/;
const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'else', 'when', 'match', 'throw', 'synchronized', 'using', 'lock', 'foreach', 'super', 'this']);
/** Symbols whose body or value holds locals: functions, and values (lambdas, anonymous classes). */
const LOCAL_SCOPES = new Set(['function', 'method', 'constructor', 'property', 'field', 'constant']);

/** Definition-looking lines of a file (comment lines skipped). */
export function definitionSites(lang: Lang, text: string): DefinitionSite[] {
  const rules = RULES[lang];
  if (!rules?.length) return [];
  const out: DefinitionSite[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.length > 400 || COMMENT_START.test(raw) || STATEMENT_START.test(raw)) continue;
    for (const r of rules) {
      const m = r.re.exec(raw);
      if (!m) continue;
      const name = m[r.group];
      if (!name || CONTROL.has(name)) continue;
      out.push({ line: i + 1, name, keyword: typeof r.keyword === 'number' ? m[r.keyword] : r.keyword, text: raw.trim().slice(0, 160) });
      break;
    }
  }
  return out;
}

/**
 * Which definition-looking lines have a covering symbol: a symbol with that name whose range contains the
 * line. Lines inside the body of a function/method symbol or the value of a property/constant (not its first
 * line) are locals and skipped.
 */
export function checkExtractionRecall(lang: Lang, text: string, symbols: readonly SymbolLike[]): RecallCheck {
  const sites = definitionSites(lang, text);
  const bodies = symbols.filter((s) => LOCAL_SCOPES.has(s.kind) && s.endLine > s.startLine);
  const byName = new Map<string, SymbolLike[]>();
  for (const s of symbols) {
    const list = byName.get(s.name);
    if (list) list.push(s);
    else byName.set(s.name, [s]);
  }
  let considered = 0;
  let covered = 0;
  const missing: DefinitionSite[] = [];
  for (const site of sites) {
    const named = byName.get(site.name.replace(/[?!=]$/, '')) ?? byName.get(site.name);
    const hit = named?.some((s) => s.startLine <= site.line && site.line <= s.endLine);
    if (!hit && bodies.some((b) => b.startLine < site.line && site.line <= b.endLine)) continue; // a local
    considered++;
    if (hit) covered++;
    else missing.push(site);
  }
  return { sites: considered, covered, missing };
}
