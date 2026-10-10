// Same-length source rewrites that steer a grammar around known gaps (applied by KoptParser).
//
// Rules for every rewrite: the output has exactly the input's length and the same newlines, so byte offsets,
// rows and columns of the tree match the original file; it only changes how the grammar parses, never what
// the indexer reads (node text comes from the original source). A rewrite inside a string or a comment is
// therefore harmless.

import type { Node } from 'web-tree-sitter';

export interface SourceFix {
  /** Rewrite before the first parse. */
  text?(src: string): string;
  /** Second chance: given the first tree, a rewritten source to parse again (undefined = keep the tree). */
  tree?(src: string, root: Node): string | undefined;
}

/** `s` with [start, end) replaced by spaces, newlines kept. */
export function blank(s: string, start: number, end: number): string {
  if (end <= start) return s;
  return s.slice(0, start) + s.slice(start, end).replace(/[^\n\r]/g, ' ') + s.slice(end);
}

// ----------------------------------------------------------------------------------------------- Kotlin
//
// tree-sitter-kotlin (fwcd 0.3.8, the newest WASM build available) mis-parses a few common constructs, and
// tree-sitter's error recovery then often swallows the rest of the enclosing class:
// 1. Infix calls whose name starts with `e` (`a eq b`, the core of SQL DSLs such as Exposed): the external
//    scanner looks ahead for `else` and fails. Rewritten `a Eq b`.
// 2. Guarded `when` branches (Kotlin 2.1): `is Foo if cond ->` is rewritten `is Foo ,  cond ->`.
// 3. Multi-dollar strings (Kotlin 2.1): `$$"..."` loses its `$$`, and the `$` inside it are not templates.
// 4. Function types with a qualified or nullable receiver: `A.B.() -> Unit` is rewritten `A_B.() -> Unit`,
//    `Op<T>?.() -> R` is rewritten `Op<T> .() -> R`.
// 5. Identifiers starting with `else` (`elseResult`) or negated ones starting with `is`/`in` (`!isEmpty`):
//    the same look-ahead takes them for keywords. Rewritten `Else...`, `!Is...`, `!In...`.
// 6. Binary literals `0b1010` (rewritten `0x1010`) and the `..<` range operator (rewritten `.. `).
//    A `when` branch starting with `in` continues the previous line's expression: a `;` replaces the
//    last indentation character (not on a first branch, after `{`, nor after a `,`).
// 7. Assignments to a property of a call result, `find(id)!!.value = 2`, `m(f)[k] = v`: not assignable in
//    the grammar. Rewritten as a comparison (`... ==v`), which keeps every call and name.
// 8. Class delegation followed by the class body, `class X : I by impl { ... }`: the body is parsed as a
//    trailing lambda of `impl` and every member is lost (no ERROR node). `by impl` is blanked (found in the
//    text when the header is a class/object one, else from the first tree, which then is parsed again);
//    the signature still shows it because symbols read the original text.

const KOTLIN_E_KEYWORDS = new Set(['else', 'enum', 'expect', 'external']);
const INFIX_E = /(?<=[\w)\]}"'`][ \t]+)e(\w*)/g;
const ELSE_PREFIX = /\belse(?=\w)/g;
const NOT_IS_PREFIX = /!(i)(?=[sn]\w)/g;
const GUARD = /^([ \t]*!?(?:is|in)[ \t]+(?:(?!->)[^\n])*?[ \t])if(?=[ \t(])/gm;
const MULTI_DOLLAR = /(?<![\w$"])(\$\$+)"((?:[^"\\\n]|\\.)*)"/g;
const QUALIFIED_RECEIVER = /\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+(?=\.\()/g;
const BINARY_LITERAL = /\b0[bB](?=[01_]+\b)/g;
const RANGE_UNTIL = /\.\.</g;
const WHEN_IN = /(?<=[^{,\s][ \t]*\r?\n(?:[ \t]*\r?\n)*)^([ \t]*)[ \t](?=!?in[ \t(][^\n]*->)/gm;
const CALL_TARGET_ASSIGN =
  /^([ \t]*(?=\S)(?!(?:val|var|const|fun|private|public|protected|internal|override|open|lateinit|class|object|interface|typealias|return|if|else|while|for|when|import|package)\b)(?![^=\n]*\bfun\b)[^=\n"'{}]*\([^=\n"'{}]*(?:\.[A-Za-z_]\w*|\]))[ \t]=(?=[ \t][^=])/gm;
const NULLABLE_RECEIVER = /\?(?=\.\()/g;

const DELEGATE_THEN_BRACE = /\bby[ \t]+[\w.]+(?:\([^()\n]*\))?(?=\s*\{)/g;
const HEADER_WORD = /[A-Za-z_]\w*/y;

/** Keyword that starts the declaration `by` at `at` belongs to (scanning back at parenthesis depth 0). */
function declarationKeyword(s: string, at: number): string | undefined {
  let depth = 0;
  for (let i = at - 1, n = 0; i >= 0 && n < 4000; i--, n++) {
    const c = s.charCodeAt(i);
    if (c === 41 /* ) */) depth++;
    else if (c === 40 /* ( */) depth--;
    else if (c === 123 /* { */ || c === 125 /* } */ || c === 59 /* ; */ || c === 61 /* = */) {
      if (depth <= 0) return undefined;
    } else if (depth === 0 && /[a-z]/.test(s[i]) && (i === 0 || !/[\w$]/.test(s[i - 1]))) {
      HEADER_WORD.lastIndex = i;
      const w = HEADER_WORD.exec(s)?.[0];
      if (w === 'class' || w === 'object' || w === 'val' || w === 'var' || w === 'fun') return w;
    }
  }
  return undefined;
}

function blankClassDelegations(s: string): string {
  let out = s;
  for (const m of s.matchAll(DELEGATE_THEN_BRACE)) {
    const kw = declarationKeyword(s, m.index);
    if (kw === 'class' || kw === 'object') out = blank(out, m.index, m.index + m[0].length);
  }
  return out;
}

function kotlinText(src: string): string {
  let s = src;
  if (/\bby[ \t]/.test(s)) s = blankClassDelegations(s);
  if (/[\w)\]}"'`][ \t]+e/.test(s)) s = s.replace(INFIX_E, (m, rest: string) => (KOTLIN_E_KEYWORDS.has(m) ? m : 'E' + rest));
  if (s.includes('else')) s = s.replace(ELSE_PREFIX, 'Else');
  if (s.includes('!i')) s = s.replace(NOT_IS_PREFIX, '!I');
  if (s.includes('if')) s = s.replace(GUARD, (_m, head: string) => head + ', ');
  // `$$"a ${b}"`: no interpolation inside, so neither the prefix nor a lone `$` may start a template
  if (s.includes('$$')) s = s.replace(MULTI_DOLLAR, (_m, d: string, body: string) => ' '.repeat(d.length) + '"' + body.replace(/\$/g, '_') + '"');
  if (s.includes('.(')) s = s.replace(NULLABLE_RECEIVER, ' ').replace(QUALIFIED_RECEIVER, (m) => m.replace(/\./g, '_'));
  if (/\b0[bB][01]/.test(s)) s = s.replace(BINARY_LITERAL, '0x');
  if (s.includes('..<')) s = s.replace(RANGE_UNTIL, '.. ');
  if (s.includes('in')) s = s.replace(WHEN_IN, '$1;');
  if (s.includes(' = ')) s = s.replace(CALL_TARGET_ASSIGN, (_m, lhs: string) => lhs + '==');
  return s;
}

/** `by <expr>` of class/object delegations whose expression swallowed the body as a trailing lambda. */
function kotlinTree(src: string, root: Node): string | undefined {
  if (!/\bby\b/.test(src)) return undefined;
  let out = src;
  for (const d of root.descendantsOfType('explicit_delegation')) {
    if (!d) continue;
    const expr = d.namedChildren[d.namedChildCount - 1];
    if (!expr || expr.type !== 'call_expression') continue;
    const suffix = expr.namedChildren[expr.namedChildCount - 1];
    if (suffix?.type !== 'call_suffix') continue;
    const lambda = suffix.namedChildren[suffix.namedChildCount - 1];
    if (lambda?.type !== 'annotated_lambda' || lambda.endIndex !== d.endIndex) continue;
    let by: Node | null = null;
    for (const c of d.children) if (c?.type === 'by') by = c;
    if (!by) continue;
    out = blank(out, by.startIndex, lambda.startIndex);
  }
  return out === src ? undefined : out;
}

export const kotlinFix: SourceFix = { text: kotlinText, tree: kotlinTree };

export const SOURCE_FIXES: Partial<Record<string, SourceFix>> = {
  kotlin: kotlinFix,
};
