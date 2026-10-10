// Parser-agnostic extraction state + helpers shared by the per-language visitors in ./langs/.
//
// Design notes:
// - One pass over named nodes per file. Visitors recurse through `ex.visit` / `ex.visitChildren`, which bound
//   the JS stack: below MAX_VISIT_DEPTH nested visits a subtree is queued and visited later from the top
//   (`drain`), so pathological nesting (a 2,000-term `a + b + ...` chain is 2,000 levels deep, because
//   tree-sitter builds binary expressions left-deep) cannot overflow the stack and lose the whole file.
// - Declarations create symbols only outside function
//   bodies (`scope.local`): locals, closures and anonymous classes never become symbols, but their calls
//   are still attributed to the enclosing symbol.
// - Receivers are typed cheaply (params, fields, typed locals, `new X()` initializers, imports) so the
//   resolver can link `repo.save()` to `Repo.save` instead of guessing by name. The inferred type travels
//   as an indexer-internal `hint` on the ref (not part of the shared ExtractedRef contract).

import type { Node } from 'web-tree-sitter';
import type { ExtractedFile, ExtractedRef, ExtractedSymbol, Lang, RefKind, SymbolKind } from '../core/types.js';
import { termsForText } from './terms.js';

/** Ref + resolution hint: `T:<Type>` receiver type, `M:<spec>` module/package the name lives in. */
export interface IxRef extends ExtractedRef {
  hint?: string;
}

export interface IxFile extends ExtractedFile {
  refs: IxRef[];
}

export const MAX_SIGNATURE = 300;
export const MAX_DOC = 200;
export const MAX_BODY_TERMS = 200;
export const MAX_QUALIFIER = 60;

const IDENT_RE = /^[A-Za-z_$][\w$]*$/;
const PRIMITIVES = new Set([
  'void', 'int', 'long', 'short', 'byte', 'char', 'boolean', 'bool', 'float', 'double', 'string', 'String', 'object',
  'Object', 'any', 'unknown', 'never', 'number', 'bigint', 'symbol', 'undefined', 'null', 'decimal', 'uint', 'ulong',
  'ushort', 'sbyte', 'nint', 'nuint', 'dynamic', 'var', 'val', 'Unit', 'Int', 'Long', 'Boolean', 'Double', 'Float',
  'Char', 'Byte', 'Short', 'Any', 'Nothing', 'str', 'bytes', 'None', 'error', 'rune', 'int8', 'int16', 'int32',
  'int64', 'uint8', 'uint16', 'uint32', 'uint64', 'float32', 'float64', 'complex64', 'complex128', 'uintptr', 'Self',
  'self', 'this', 'Integer', 'Void', 'Character',
]);

function isSpace(c: number): boolean {
  return c === 32 || c === 10 || c === 13 || c === 9;
}

export function isUpperStart(name: string): boolean {
  const c = name.charCodeAt(0);
  return c >= 65 && c <= 90;
}

/** UPPER_CASE (at least 2 chars, one letter). */
export function isConstName(name: string): boolean {
  return name.length >= 2 && /^[A-Z][A-Z0-9_]*$/.test(name);
}

/**
 * Simple type name from a type expression's text: `java.util.List<Order>` -> `List`, `*Ledger` -> `Ledger`,
 * `Optional[int]` -> `Optional`. Undefined for primitives, arrays/slices (`Order[]`, `[]Entry`: the value is
 * a collection, not an Order) and non-identifiers.
 */
/** `Map<String, List<Foo>>[]` -> `Map[]`: type arguments removed (arrays inside them are not the value's). */
function withoutTypeArgs(t: string): string {
  let out = t;
  for (let i = 0; i < 6 && out.includes('<'); i++) {
    const next = out.replace(/<[^<>]*>/g, '');
    if (next === out) break;
    out = next;
  }
  return out;
}

export function baseTypeName(text: string): string | undefined {
  let t = text.trim();
  if (t.startsWith('[') || /\[\s*\]/.test(withoutTypeArgs(t))) return undefined;
  const lt = t.indexOf('<');
  if (lt > 0) t = t.slice(0, lt);
  const br = t.indexOf('[');
  if (br > 0) t = t.slice(0, br);
  t = t.replace(/^[\s*&]+|[\s?!*&]+$/g, '').replace(/^(?:const|readonly|mut|ref|out|in|params)\s+/, '');
  const sep = Math.max(t.lastIndexOf('.'), t.lastIndexOf('::') >= 0 ? t.lastIndexOf('::') + 1 : -1, t.lastIndexOf('\\'));
  if (sep >= 0) t = t.slice(sep + 1);
  if (!IDENT_RE.test(t) || PRIMITIVES.has(t)) return undefined;
  return t;
}

/**
 * Type recorded for a variable declared with a type that is never a repository type (primitives, strings,
 * arrays): a call on it is a library call, so name-based fallbacks must not link it to repository code.
 */
export const BUILTIN = '#builtin';
/** Resolution hint for such a receiver (the resolver leaves the call unresolved). */
export const EXTERNAL_HINT = 'X:';
/**
 * Prefix of a variable "type" that is a resolution hint rather than a type name: a local initialized from a call
 * (`x := svc.Load()`, `var x = repo.find()`) carries that call's `C:` hint, so a call on `x` is typed from the
 * callee's declared return type.
 */
export const HINT_VAR = '\u0002';

const BUILTIN_TYPES = new Set([
  'void', 'int', 'long', 'short', 'byte', 'char', 'boolean', 'bool', 'float', 'double', 'string', 'String', 'decimal',
  'uint', 'ulong', 'ushort', 'sbyte', 'nint', 'nuint', 'number', 'bigint', 'symbol', 'Unit', 'Int', 'Long', 'Boolean',
  'Double', 'Float', 'Char', 'Byte', 'Short', 'Integer', 'Void', 'Character', 'str', 'bytes', 'rune', 'int8', 'int16',
  'int32', 'int64', 'uint8', 'uint16', 'uint32', 'uint64', 'float32', 'float64', 'complex64', 'complex128', 'uintptr',
  'CharSequence', 'StringBuilder', 'StringBuffer',
]);

/**
 * Type to record for a declared variable: the simple type name, BUILTIN for primitives, strings and arrays,
 * undefined when the declaration says nothing usable (`var`, `Object`, `any`, function types...).
 */
export function declaredType(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  const t = baseTypeName(text);
  if (t) return BUILTIN_TYPES.has(t) ? BUILTIN : t;
  const s = text.trim().replace(/[?!]+$/, '').replace(/^[&*\s]+/, '').replace(/^(?:const|readonly|mut|final)\s+/, '');
  if (!s) return undefined;
  if (s.startsWith('[') || /\[\s*\]/.test(withoutTypeArgs(s))) return BUILTIN;
  const base = s.replace(/<.*$/, '').replace(/^.*[.:\\]/, '');
  return BUILTIN_TYPES.has(base) ? BUILTIN : undefined;
}

export class Vars {
  private m?: Map<string, string>;
  constructor(readonly parent?: Vars) {}
  set(name: string, type: string | undefined): void {
    if (!type || !name) return;
    (this.m ??= new Map()).set(name, type);
  }
  get(name: string): string | undefined {
    for (let v: Vars | undefined = this; v; v = v.parent) {
      const t = v.m?.get(name);
      if (t) return t;
    }
    return undefined;
  }
  own(name: string): string | undefined {
    return this.m?.get(name);
  }
}

export interface Scope {
  /** Innermost enclosing symbol (ref attribution). */
  sym?: number;
  /** Innermost enclosing container symbol (class, interface...). */
  cls?: number;
  /** Qualified-name prefix for declarations made in this scope. */
  q: string;
  /** Inside a function/method body: declarations are locals and never become symbols. */
  local: boolean;
  /** Language-specific "members are exported" flag (TS exported namespace/class, Rust pub trait...). */
  exported: boolean;
  vars: Vars;
}

export interface SymbolSpec {
  name: string;
  kind: SymbolKind;
  /** Node spanning the whole declaration (including decorators / annotations / `export`). */
  node: Node;
  scope: Scope;
  exported: boolean;
  /** Where the signature starts (default node start). */
  sigStart?: number;
  /** Where the signature stops, exclusive (typically the body start). Default node end. */
  sigEnd?: number;
  /** Initializer to abbreviate in the signature. */
  value?: Node | null;
  sigPrefix?: string;
  /** Body whose identifiers feed `bodyTerms`. */
  body?: Node | null;
  /** Explicit doc (Python docstrings); otherwise the comment block above the declaration. */
  doc?: string;
  /** Line used to look for the doc comment (0-based row); default node start row. */
  docRow?: number;
  qname?: string;
}

export type Visitor = (ex: Ex, node: Node, scope: Scope) => void;

/**
 * Nested visits before a subtree is deferred to the top-level loop. Each level costs a handful of JS frames
 * (visit -> language visitor -> helper -> visitChildren); 256 levels stay far below Node's default stack and
 * far above the nesting of real code, so deferral only kicks in on generated or degenerate expressions.
 */
export const MAX_VISIT_DEPTH = 256;

const TYPE_SYMBOL_KINDS = new Set(['class', 'struct', 'record', 'interface', 'trait', 'enum', 'type']);

/** Expression wrappers between a call and the call made on its result (`(f())`, `f()!!`, `f()?`, `await f()`). */
const CHAIN_WRAPPERS = new Set(['parenthesized_expression', 'non_null_assertion_expression', 'postfix_expression', 'try_expression', 'await_expression']);

/** Member names a read ref can carry: identifiers, plus TS `#private` names (symbols keep their `#`). */
const MEMBER_NAME_RE = /^#?[A-Za-z_$][\w$]*$/;

/**
 * Property names read on nearly every kind of object (`x.length`, `res.data`, `e.message`): a read of one of them
 * through a receiver of unknown type could be any of thousands of declarations, so it is only recorded when the
 * receiver is typed or is `this` / `self` (writes are always recorded).
 */
const GENERIC_READS = new Set(
  (
    'length size id name data type value values status message key keys code title items params options children ' +
    'props body error errors result fields metadata description count state index label text url path config ' +
    'context headers query request response env default prototype constructor current target parent next prev ' +
    'first last total x y width height left right top bottom start end min max ok err args arguments this super class'
  ).split(' '),
);
const SELF_RECEIVER = /^(?:this|self|\$this|super|base|static|parent|Self)$/;
/** JVM package paths used as receivers (`java.util.Locale.ROOT`): never a field of repository code. */
const JVM_PACKAGE = /^(?:java|javax|jakarta|org|com|net|io|kotlin|scala|android|sun|jdk)(?:\.[a-z_]\w*)*$/;

/** Assignment-like parents and the field that holds their target (null: the operand itself, `x.n++`). */
const WRITE_PARENTS: Record<string, string | null> = {
  assignment_expression: 'left',
  augmented_assignment_expression: 'left',
  assignment: 'left',
  augmented_assignment: 'left',
  compound_assignment_expr: 'left',
  assignment_statement: 'left',
  update_expression: null,
  inc_statement: null,
  dec_statement: null,
};
/** Unary parents that write their operand only with these operators (C# `x.N++`, Kotlin `x.n--`; not `!x.y`, `x!!`). */
const UNARY_WRITE = new Set(['postfix_unary_expression', 'prefix_unary_expression', 'postfix_expression', 'prefix_expression']);

/**
 * True when `node` (a member access) is the target of an assignment, a compound assignment or an increment:
 * `this.x = v`, `x.total += n`, `s.count++`, Go `a, s.f = ...`, Scala `x.y += 1`.
 */
export function isAssignTarget(node: Node): boolean {
  let child: Node = node;
  let parent = node.parent;
  // Go: `a.b = 1` puts the targets in an expression_list (the statement's `left` field)
  if (parent?.type === 'expression_list' && parent.parent?.type === 'assignment_statement') {
    child = parent;
    parent = parent.parent;
  }
  if (!parent) return false;
  if (parent.type in WRITE_PARENTS) {
    const field = WRITE_PARENTS[parent.type];
    if (field === null) return true;
    const target = parent.childForFieldName(field) ?? parent.namedChildren[0];
    return target?.id === child.id;
  }
  if (UNARY_WRITE.has(parent.type)) return /^\s*(?:\+\+|--)|(?:\+\+|--)\s*$/.test(parent.text.replace(child.text, ''));
  // Scala: `x.y += 1` is an infix expression whose operator ends with `=`
  if (parent.type === 'infix_expression' && parent.namedChildren[0]?.id === child.id) {
    const op = parent.childForFieldName('operator')?.text ?? parent.namedChildren[1]?.text ?? '';
    return /^[^=!<>:]?=$|^[^=!<>:]{2,}=$/.test(op);
  }
  return false;
}

/** Context the pure extractor cannot infer from one file alone (supplied by the indexer). */
export interface ExtractOptions {
  /** Dotted module name of a Python file, computed from the package layout (`__init__.py` dirs). */
  pythonModule?: string;
}

export class Ex {
  readonly symbols: ExtractedSymbol[] = [];
  readonly refs: IxRef[] = [];
  readonly imports: string[] = [];
  namespace?: string;
  /** Local alias -> imported original name + source (`import { a as b } from 'x'`, `from x import a as b`). */
  readonly importAlias = new Map<string, { name: string; spec: string }>();
  /** Local name bound to a module / package / namespace import (`import * as ns`, `import x.y as z`, Go imports). */
  readonly moduleAlias = new Map<string, string>();
  /** Field types per container symbol index (for `this.x.f()` receivers). */
  readonly classVars = new Map<number, Vars>();
  private readonly importSet = new Set<string>();
  private readonly refKeys = new Map<string, IxRef>();
  /** Ref made for a call / instantiation node (node id), so an outer call on its result can point at it. */
  private readonly callRefs = new Map<number, IxRef>();
  private readonly bodies: Array<[number, number, number]> = [];
  private lineStarts?: number[];
  private byteLineStarts?: number[];
  private readonly ascii: boolean;
  private depth = 0;
  private readonly deferred: Array<[Node, Scope]> = [];
  /** Visits one node with the language visitor (depth-bounded, see MAX_VISIT_DEPTH). */
  readonly visit: Visitor;

  constructor(readonly path: string, readonly lang: Lang, readonly text: string, readonly options: ExtractOptions = {}, visitor?: Visitor) {
    // eslint-disable-next-line no-control-regex
    this.ascii = !/[^\x00-\x7f]/.test(text);
    const lv: Visitor = visitor ?? (() => {});
    this.visit = (ex, node, scope) => {
      if (this.depth >= MAX_VISIT_DEPTH) {
        this.deferred.push([node, scope]);
        return;
      }
      this.depth++;
      try {
        lv(ex, node, scope);
      } finally {
        this.depth--;
      }
    };
  }

  visitChildren(node: Node, scope: Scope): void {
    for (const c of node.namedChildren) if (c) this.visit(this, c, scope);
  }

  /** Visits the subtrees deferred by the depth bound, each from the top of the stack (FIFO, so roughly in source order). */
  drain(): void {
    for (let i = 0; i < this.deferred.length; i++) {
      const [node, scope] = this.deferred[i];
      this.visit(this, node, scope);
    }
    this.deferred.length = 0;
  }

  addImport(spec: string): void {
    if (!spec || this.importSet.has(spec)) return;
    this.importSet.add(spec);
    this.imports.push(spec);
  }

  /** Creates a symbol and returns its index. */
  addSymbol(s: SymbolSpec): number {
    const node = s.node;
    const parent = s.scope.sym;
    const qname = s.qname ?? (s.scope.q ? `${s.scope.q}.${s.name}` : s.name);
    const start = node.startIndex;
    let end = node.endIndex;
    let endRow = node.endPosition.row;
    // Layout-sensitive grammars (Scala 3 indented blocks) end a node where the next token starts: trailing
    // blank lines would make the symbol run into the next declaration's line.
    if (end > start && isSpace(this.text.charCodeAt(end - 1))) {
      while (end > start && isSpace(this.text.charCodeAt(end - 1))) end--;
      endRow = this.rowOf(Math.max(start, end - 1));
    }
    const sym: ExtractedSymbol = {
      name: s.name,
      qualifiedName: qname,
      kind: s.kind,
      startLine: node.startPosition.row + 1,
      endLine: endRow + 1,
      startByte: this.byteOffset(start),
      endByte: this.byteOffset(end),
      signature: this.signature(s.sigStart ?? start, s.sigEnd ?? end, s.value, s.sigPrefix),
      exported: s.exported,
    };
    // Members declared on their container's first line (Kotlin/Scala/record params) would steal its doc.
    const row = s.docRow ?? node.startPosition.row;
    const sameLineAsParent = parent !== undefined && this.symbols[parent].startLine === row + 1;
    const doc = s.doc ?? (sameLineAsParent ? undefined : this.docAbove(row));
    if (doc) sym.doc = doc;
    if (parent !== undefined) sym.parent = parent;
    const idx = this.symbols.push(sym) - 1;
    if (s.body) this.bodies.push([idx, s.body.startIndex, s.body.endIndex]);
    return idx;
  }

  /** Scope for the members / body of symbol `idx`. */
  enter(scope: Scope, idx: number, opts: { container?: boolean; local?: boolean; exported?: boolean; vars?: Vars } = {}): Scope {
    const sym = this.symbols[idx];
    const container = !!opts.container;
    let vars = opts.vars;
    if (!vars) {
      vars = new Vars(scope.vars);
      if (container) this.classVars.set(idx, vars);
    }
    return {
      sym: idx,
      cls: container ? idx : scope.cls,
      q: sym.qualifiedName,
      local: opts.local ?? !container,
      exported: opts.exported ?? sym.exported,
      vars,
    };
  }

  /** Adds a ref (or returns the existing one with the same key). */
  addRef(scope: Scope, name: string, kind: RefKind, at: Node, qualifier?: string, hint?: string): IxRef | undefined {
    if (!name || name.length > 128) return undefined;
    let q = qualifier;
    if (q !== undefined) {
      if (q.length > MAX_QUALIFIER * 2 || /\s/.test(q)) q = q.replace(/\s+/g, ' ');
      if (q.length > MAX_QUALIFIER) q = q.slice(0, MAX_QUALIFIER);
      if (!q) q = undefined;
    }
    // One ref per (enclosing symbol, kind, name, qualifier): callers lists stay short and the refs table
    // stays proportional to distinct relations rather than raw call sites.
    const key = `${scope.sym ?? -1}\u0000${kind}\u0000${name}\u0000${q ?? ''}`;
    const seen = this.refKeys.get(key);
    if (seen) return seen;
    const ref: IxRef = { name, kind, line: at.startPosition.row + 1 };
    if (scope.sym !== undefined) ref.fromSymbol = scope.sym;
    if (q !== undefined) ref.qualifier = q;
    if (hint) ref.hint = hint;
    this.refKeys.set(key, ref);
    this.refs.push(ref);
    return ref;
  }

  /**
   * A member read or write that is not a call (`obj.field`, `this.x = v`, `x.count++`): one `read` / `write` ref
   * named after the member, qualified and typed like a call receiver (receiver hints, call-chain hints), then
   * the receiver is visited. Call visitors record callees themselves and never come through here.
   */
  memberRef(scope: Scope, node: Node, nameNode: Node | null | undefined, object: Node | null | undefined, kind?: 'read' | 'write'): IxRef | undefined {
    let ref: IxRef | undefined;
    const name = nameNode?.type === 'variable_name' ? nameNode.text.replace(/^\$/, '') : nameNode?.text;
    if (nameNode && name && MEMBER_NAME_RE.test(name)) {
      const q = object ? object.text : undefined;
      const k = kind ?? (isAssignTarget(node) ? 'write' : 'read');
      const hint = this.receiverHint(q, scope);
      const jvm = q !== undefined && (this.lang === 'java' || this.lang === 'kotlin' || this.lang === 'scala') && JVM_PACKAGE.test(q);
      const generic = k === 'read' && !hint && GENERIC_READS.has(name) && !(q !== undefined && SELF_RECEIVER.test(q));
      if (!jvm && !generic) ref = this.addRef(scope, name, k, nameNode, q, hint);
    } else if (nameNode && nameNode.namedChildCount) {
      // computed member name (PHP `$this->{$this->getKeyName()}`): the calls in it still count
      this.visit(this, nameNode, scope);
    }
    if (object) {
      this.visit(this, object, scope);
      this.chainHint(ref, object);
    }
    return ref;
  }

  /** Resolution hint for a value of declared type `t` (see typeHint), public for struct literal fields. */
  hintForType(t: string): string {
    return this.typeHint(t);
  }

  /** Records the ref made for a call or instantiation node. */
  noteCall(node: Node, ref: IxRef | undefined): void {
    if (ref) this.callRefs.set(node.id, ref);
  }

  /**
   * Receiver of `outer` is the result of another call (`getContext().fire()`, `NewPolicy().Transport()`,
   * `new Foo().bar()`): call after visiting the receiver. The hint names the inner call's ref (`C:<name>`
   * + `\u0001<qualifier>`) so the resolver can type the receiver from that call's declared return type, or
   * gives the type directly for an instantiation.
   */
  chainHint(outer: IxRef | undefined, receiver: Node | null | undefined): void {
    if (!outer || outer.hint || !receiver) return;
    let n: Node | null = receiver;
    for (let i = 0; n && i < 4 && CHAIN_WRAPPERS.has(n.type) && n.namedChildCount >= 1; i++) n = n.namedChildren[0];
    const inner = n ? this.callRefs.get(n.id) : undefined;
    if (!inner || inner === outer) return;
    outer.hint = inner.kind === 'new' ? `T:${inner.name}` : `C:${inner.name}\u0001${inner.qualifier ?? ''}`;
  }

  /**
   * Variable "type" for a local initialized with `value` when the declaration names no type: the hint of the call
   * or instantiation `value` is (see HINT_VAR), else undefined. Call after visiting `value`.
   */
  valueHint(value: Node | null | undefined): string | undefined {
    let n: Node | null | undefined = value;
    for (let i = 0; n && i < 4 && CHAIN_WRAPPERS.has(n.type) && n.namedChildCount >= 1; i++) n = n.namedChildren[0];
    const ref = n ? this.callRefs.get(n.id) : undefined;
    if (!ref) return undefined;
    if (ref.kind === 'new') return ref.name;
    return `${HINT_VAR}C:${ref.name}\u0001${ref.qualifier ?? ''}`;
  }

  /** type_ref for every type name found under `node` (dedup per symbol via addRef). */
  typeRefs(node: Node | null | undefined, scope: Scope, types: string[], opts: { upperOnly?: boolean } = {}): void {
    if (!node) return;
    const upperOnly = opts.upperOnly ?? true;
    const nodes = types.includes(node.type) ? [node] : node.descendantsOfType(types);
    for (const n of nodes) {
      if (!n) continue;
      const raw = baseTypeName(n.text);
      if (!raw || raw.length < 2) continue;
      if (upperOnly && !isUpperStart(raw)) continue;
      this.addRef(scope, this.dealias(raw), 'type_ref', n);
    }
  }

  /**
   * Resolution hint for a call receiver. `T:<Type>` when the receiver's static type is known (param, field,
   * typed local, imported/capitalized type for static calls), `M:<spec>` when it is a module/package alias.
   */
  receiverHint(qualifier: string | undefined, scope: Scope): string | undefined {
    if (!qualifier) return undefined;
    let q = qualifier;
    if (q.charCodeAt(0) === 36 /* $ */ && this.lang === 'php') q = q.slice(1);
    if (q === 'this' || q === 'self' || q === 'super' || q === 'base' || q === 'cls' || q === 'Self') return undefined;
    const m = /^(?:this|self|\$this)\s*(?:\.|->)\s*([A-Za-z_$][\w$]*)$/.exec(q);
    if (m) {
      const t = scope.cls !== undefined ? this.classVars.get(scope.cls)?.own(m[1]) : undefined;
      return t ? this.typeHint(t) : undefined;
    }
    if (!IDENT_RE.test(q)) {
      // Dotted module path used as a qualifier (Python `os.path.join`, Java `java.util.List.of`).
      const mod = this.moduleAlias.get(q);
      if (mod !== undefined) return `M:${mod}`;
      // A field of a typed variable (`s.policy` with `s *server`): the field's declared type, when that type is
      // declared earlier in this file (Go receivers, Java/C# locals of a same-file class).
      const fm = /^([A-Za-z_$][\w$]*)\s*(?:\.|->)\s*([A-Za-z_$][\w$]*)$/.exec(q);
      if (fm && !this.moduleAlias.has(fm[1])) {
        const owner = scope.vars.get(fm[1]);
        const idx = owner && !owner.startsWith(HINT_VAR) && owner !== BUILTIN ? this.typeIndex(owner) : undefined;
        const ft = idx !== undefined ? this.classVars.get(idx)?.own(fm[2]) : undefined;
        if (ft) return this.typeHint(ft);
      }
      return undefined;
    }
    const t = scope.vars.get(q);
    if (t) return this.typeHint(t);
    const mod = this.moduleAlias.get(q);
    if (mod !== undefined) return `M:${mod}`;
    const imp = this.importAlias.get(q);
    if (imp) return isUpperStart(imp.name) ? `T:${imp.name}` : `M:${joinModule(imp.spec, imp.name, this.lang)}`;
    if (isUpperStart(q) && this.lang !== 'go') return `T:${q}`;
    return undefined;
  }

  /**
   * Hint for a receiver of recorded type `t`: `X:` for builtins, the stored hint of a call-initialized local, `Q:` +
   * package + name for a Go type qualified by an imported package (`*policy.Policy`), else `T:` + the type name.
   */
  private typeHint(t: string): string {
    if (t === BUILTIN) return EXTERNAL_HINT;
    if (t.startsWith(HINT_VAR)) return t.slice(1);
    const dot = t.indexOf('.');
    if (dot > 0) {
      const mod = this.moduleAlias.get(t.slice(0, dot));
      const name = t.slice(dot + 1);
      return mod !== undefined ? `Q:${mod}\u0001${name}` : `T:${name}`;
    }
    return `T:${t}`;
  }

  /** Index of the top-level type declared in this file under `name` (types declared so far). */
  private typeIndex(name: string): number | undefined {
    for (let i = 0; i < this.symbols.length; i++) {
      const s = this.symbols[i];
      if (s.name === name && s.parent === undefined && TYPE_SYMBOL_KINDS.has(s.kind) && this.classVars.has(i)) return i;
    }
    return undefined;
  }

  /** Original name + hint for an identifier that may be an import alias (`fmt` -> `formatMoney`). */
  dealias(name: string): string {
    const imp = this.importAlias.get(name);
    return imp ? imp.name : name;
  }

  signature(start: number, end: number, value?: Node | null, prefix?: string): string {
    let raw: string;
    if (value && value.endIndex <= end && value.startIndex >= start && value.endIndex - value.startIndex > 60) {
      const v = this.text.slice(value.startIndex, value.endIndex).replace(/\s+/g, ' ');
      raw = this.text.slice(start, value.startIndex) + v.slice(0, 40) + '…';
    } else {
      raw = this.text.slice(start, Math.min(end, start + 4000));
    }
    let s = raw.replace(/\s+/g, ' ').trim();
    s = shortenAnnotations(s);
    s = s.replace(/\s*[{;:=]\s*$/, '').replace(/\s*(?:->|=>)\s*$/, (m) => m.trim() === '=>' ? ' =>' : '');
    if (prefix) s = prefix + s;
    if (s.length > MAX_SIGNATURE) s = s.slice(0, MAX_SIGNATURE - 1) + '…';
    return s;
  }

  /** First sentence of the comment block right above `row` (0-based), skipping attribute lines. */
  docAbove(row: number): string | undefined {
    if (row <= 0) return undefined;
    const ls = this.getLineStarts();
    const lineText = (i: number) => this.text.slice(ls[i], i + 1 < ls.length ? ls[i + 1] - 1 : this.text.length);
    let i = row - 1;
    // Attributes that are siblings of the declaration (Rust #[...], C# [Attr], stray annotations).
    while (i >= 0) {
      const t = lineText(i).trim();
      if (/^(#!?\[|\[[A-Z]|@[A-Za-z])/.test(t) && !t.startsWith('/')) i--;
      else break;
    }
    if (i < 0) return undefined;
    const first = lineText(i).trim();
    const collected: string[] = [];
    if (first.endsWith('*/')) {
      let j = i;
      for (; j >= 0 && row - j < 400; j--) {
        const t = lineText(j);
        collected.unshift(t);
        if (t.includes('/*')) break;
      }
      if (j < 0) return undefined;
    } else if (/^(\/\/|#(?![\[!])|--)/.test(first)) {
      for (let j = i; j >= 0 && i - j < 60; j--) {
        const t = lineText(j).trim();
        if (/^(\/\/|#(?![\[!])|--)/.test(t)) collected.unshift(t);
        else break;
      }
    } else {
      return undefined;
    }
    return cleanDoc(collected.join('\n'));
  }

  /** Converts a JS string index into a UTF-8 byte offset. */
  byteOffset(index: number): number {
    if (this.ascii) return index;
    const ls = this.getLineStarts();
    if (!this.byteLineStarts) {
      const b: number[] = new Array(ls.length);
      let acc = 0;
      for (let i = 0; i < ls.length; i++) {
        b[i] = acc;
        const next = i + 1 < ls.length ? ls[i + 1] : this.text.length;
        acc += Buffer.byteLength(this.text.slice(ls[i], next), 'utf8');
      }
      this.byteLineStarts = b;
    }
    let lo = 0;
    let hi = ls.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ls[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return this.byteLineStarts[lo] + Buffer.byteLength(this.text.slice(ls[lo], index), 'utf8');
  }

  /** 0-based row of a string index. */
  private rowOf(index: number): number {
    const ls = this.getLineStarts();
    let lo = 0;
    let hi = ls.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ls[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  private getLineStarts(): number[] {
    if (!this.lineStarts) {
      const ls = [0];
      const text = this.text;
      for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) ls.push(i + 1);
      this.lineStarts = ls;
    }
    return this.lineStarts;
  }

  finish(lineCount: number): IxFile {
    // Bodies -> identifier terms. Containers get their members' names instead of their (huge) bodies.
    for (const [idx, start, end] of this.bodies) {
      const terms = termsForText(this.text.slice(start, end), MAX_BODY_TERMS);
      if (terms.length) this.symbols[idx].bodyTerms = terms;
    }
    const memberTerms = new Map<number, Set<string>>();
    for (const s of this.symbols) {
      if (s.parent === undefined) continue;
      let set = memberTerms.get(s.parent);
      if (!set) memberTerms.set(s.parent, (set = new Set()));
      if (set.size >= MAX_BODY_TERMS) continue;
      for (const t of termsForText(s.name)) set.add(t);
    }
    for (const [idx, set] of memberTerms) {
      const sym = this.symbols[idx];
      if (sym.bodyTerms) continue;
      sym.bodyTerms = [...set].slice(0, MAX_BODY_TERMS);
    }
    const file: IxFile = { path: this.path, lang: this.lang, lineCount, symbols: this.symbols, refs: this.refs, imports: this.imports };
    if (this.namespace) file.namespace = this.namespace;
    return file;
  }
}

export function joinModule(spec: string, name: string, lang: Lang): string {
  if (lang === 'python') return spec.endsWith('.') ? spec + name : `${spec}.${name}`;
  return spec;
}

/** `@Foo(very long args)` -> `@Foo(…)`, same for C# `[Attr(...)]` and Python decorators. */
export function shortenAnnotations(s: string): string {
  if (!s.includes('@') && !s.includes('[')) return s;
  let out = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if ((ch === '@' || ch === '[') && /[A-Za-z]/.test(s[i + 1] ?? '')) {
      // name
      let j = i + 1;
      while (j < s.length && /[\w.]/.test(s[j])) j++;
      if (s[j] === '(') {
        let depth = 0;
        let k = j;
        let quote = '';
        for (; k < s.length; k++) {
          const c = s[k];
          if (quote) {
            if (c === '\\') k++;
            else if (c === quote) quote = '';
            continue;
          }
          if (c === '"' || c === "'" || c === '`') quote = c;
          else if (c === '(') depth++;
          else if (c === ')' && --depth === 0) break;
        }
        if (k < s.length && k - j > 40) {
          out += s.slice(i, j) + '(…)';
          i = k + 1;
          continue;
        }
      }
      out += s.slice(i, j);
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Comment text -> first sentence, markers / tags / XML stripped. */
export function cleanDoc(raw: string): string | undefined {
  let t = raw
    .replace(/^\s*\/\*+!?/, '')
    .replace(/\*+\/\s*$/, '')
    .split('\n')
    .map((l) => l.replace(/^\s*(?:\/\/\/?!?|#+|--|\*+(?!\/))\s?/, '').trimEnd())
    .join('\n');
  // Javadoc/JSDoc block tags end the description.
  const tag = t.search(/(^|\n)\s*@[a-zA-Z]/);
  if (tag >= 0) t = t.slice(0, tag);
  t = t
    .replace(/<\/?(?:summary|remarks|para|p|b|i|em|strong|code|c|br\s*\/?)>/gi, ' ')
    .replace(/<see\s+cref="([^"]+)"\s*\/>/gi, '$1')
    .replace(/\{@(?:link|code|linkplain)\s+([^}]+)\}/g, '$1')
    .replace(/<[^>]{1,60}>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || /^(copyright|licensed |spdx-license|eslint-|@ts-|prettier-ignore|noinspection|todo\b|fixme\b)/i.test(t)) return undefined;
  if (/^[-=*#_/\\]+$/.test(t)) return undefined;
  const m = /^(.+?[.!?])(?=\s|$)/.exec(t);
  let first = m ? m[1] : t;
  if (first.length > MAX_DOC) first = first.slice(0, MAX_DOC - 1) + '…';
  return first;
}

/** Python docstring literal -> first sentence. */
export function cleanDocstring(literal: string): string | undefined {
  const t = literal.replace(/^[rRbBuUfF]*("""|'''|"|')/, '').replace(/("""|'''|"|')$/, '');
  return cleanDoc(t.split(/\n\s*\n/)[0]);
}
