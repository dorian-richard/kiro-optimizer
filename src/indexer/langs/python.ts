import type { Node } from 'web-tree-sitter';
import { baseTypeName, cleanDocstring, Ex, isConstName, isUpperStart, joinModule, type Scope } from '../extract.js';

const TYPE_NODES = ['identifier'];
const LEAVES = new Set(['identifier', 'string', 'integer', 'float', 'comment', 'true', 'false', 'none', 'escape_sequence']);

/**
 * Module-level calls that return a function: `gettext_lazy = lazy(gettext, str)`, `partial(...)`,
 * `csrf_protect = decorator_from_middleware(CsrfViewMiddleware)`. Matched on the callee's last name.
 */
const FUNCTION_FACTORIES = new Set([
  'lazy', 'keep_lazy', 'keep_lazy_text', 'partial', 'partialmethod', 'wraps', 'update_wrapper', 'lru_cache', 'cache',
  'singledispatch', 'contextmanager', 'asynccontextmanager', 'method_decorator', 'decorator_from_middleware',
  'decorator_from_middleware_with_args', 'sync_to_async', 'async_to_sync', 'staticmethod', 'classmethod',
  'deprecated', 'njit', 'jit', 'vectorize', 'memoize', 'memoized', 'curry',
]);

/** Test modules: classes declared inside their functions are fixtures, not API worth indexing. */
const TEST_PATH = /(?:^|\/)(?:tests?|testing)\/|(?:^|\/)(?:test_[^/]*|[^/]*_tests?|conftest)\.pyi?$/;

function isPublic(name: string): boolean {
  if (!name.startsWith('_')) return true;
  return name.startsWith('__') && name.endsWith('__'); // dunders are API
}

/**
 * Python module path from a repo-relative file path. With the set of package directories (those holding an
 * `__init__.py`), the module is rooted at the topmost package: `backend/payments/gateway.py` ->
 * `payments.gateway` when only `payments/` is a package. Without it (or for namespace packages) the path
 * is used, minus a conventional source root: `src/pkg/mod.py` -> `pkg.mod`.
 */
export function pythonModule(path: string, packageDirs?: ReadonlySet<string>): string {
  const slash = path.lastIndexOf('/');
  const dir = slash < 0 ? '' : path.slice(0, slash);
  let rel = path;
  if (packageDirs && dir && packageDirs.has(dir)) {
    let root = dir;
    for (;;) {
      const i = root.lastIndexOf('/');
      const parent = i < 0 ? '' : root.slice(0, i);
      if (!parent || !packageDirs.has(parent)) {
        rel = parent ? path.slice(parent.length + 1) : path;
        break;
      }
      root = parent;
    }
  } else {
    rel = path.replace(/^(?:src|lib|python)\//, '');
  }
  return rel.replace(/\.pyi?$/, '').replace(/(^|\/)__init__$/, '').split('/').join('.');
}

function docstring(body: Node | null): string | undefined {
  const first = body?.namedChildren[0];
  if (first?.type !== 'expression_statement') return undefined;
  const s = first.namedChildren[0];
  return s?.type === 'string' ? cleanDocstring(s.text) : undefined;
}

function typeOf(node: Node | null | undefined): string | undefined {
  if (!node) return undefined;
  let t = node.text.replace(/^["']|["']$/g, '').trim();
  const opt = /^(?:typing\.)?Optional\[(.+)\]$/.exec(t);
  if (opt) t = opt[1];
  const union = /^(.+?)\s*\|\s*None$/.exec(t);
  if (union) t = union[1];
  return baseTypeName(t);
}

function params(ex: Ex, list: Node | null, inner: Scope): void {
  if (!list) return;
  for (const p of list.namedChildren) {
    if (!p) continue;
    if (p.type === 'typed_parameter' || p.type === 'typed_default_parameter') {
      const n = p.childForFieldName('name') ?? p.namedChildren.find((c) => c?.type === 'identifier') ?? null;
      const ty = p.childForFieldName('type');
      if (n) inner.vars.set(n.text, typeOf(ty));
      ex.typeRefs(ty, inner, TYPE_NODES);
    }
    const v = p.childForFieldName('value');
    if (v) ex.visit(ex, v, inner);
  }
}

function decorators(ex: Ex, node: Node, scope: Scope): void {
  for (const d of node.namedChildren) {
    if (d?.type !== 'decorator') continue;
    const e = d.namedChildren[0];
    if (!e) continue;
    if (e.type === 'identifier') ex.addRef(scope, ex.dealias(e.text), 'call', e);
    else if (e.type === 'attribute') {
      const a = e.childForFieldName('attribute');
      const o = e.childForFieldName('object');
      if (a) ex.addRef(scope, a.text, 'call', a, o?.text, ex.receiverHint(o?.text, scope));
    } else ex.visit(ex, e, scope);
  }
}

/**
 * A class declared in a function body is indexed (as a child of that function) when the function is part of
 * the code base's API: factories such as Django's create_forward_many_to_many_manager() build their main
 * classes that way. Test functions and test modules are left out (their local classes are fixtures).
 */
function indexLocalClass(ex: Ex, scope: Scope): boolean {
  if (scope.sym === undefined) return false;
  const fn = ex.symbols[scope.sym];
  if (fn.kind !== 'function' && fn.kind !== 'method' && fn.kind !== 'constructor') return false;
  if (/^test/i.test(fn.name) || TEST_PATH.test(ex.path)) return false;
  return true;
}

function classDef(ex: Ex, node: Node, outer: Node, scope: Scope): void {
  const n = node.childForFieldName('name');
  const body = node.childForFieldName('body');
  let local = false;
  if (n && scope.local && indexLocalClass(ex, scope)) local = true;
  else if (!n || scope.local) {
    if (body) ex.visitChildren(body, scope);
    return;
  }
  const inClass = scope.cls !== undefined && !local;
  const idx = ex.addSymbol({
    name: n.text,
    kind: 'class',
    node: outer,
    scope,
    exported: !local && isPublic(n.text) && (!inClass || scope.exported),
    sigEnd: body ? body.startIndex : node.endIndex,
    doc: docstring(body),
  });
  // members of a local class are symbols too; its own locals stay locals
  const inner = { ...ex.enter(scope, idx, { container: true }), local: false };
  if (outer !== node) decorators(ex, outer, inner);
  const sup = node.childForFieldName('superclasses');
  for (const b of sup?.namedChildren ?? []) {
    if (!b || b.type === 'keyword_argument') continue;
    if (b.type === 'identifier') ex.addRef(inner, ex.dealias(b.text), 'inherit', b);
    else if (b.type === 'attribute') {
      const a = b.childForFieldName('attribute');
      const o = b.childForFieldName('object');
      if (a) ex.addRef(inner, a.text, 'inherit', a, o?.text, ex.receiverHint(o?.text, scope));
    }
  }
  if (body) ex.visitChildren(body, inner);
}

function funcDef(ex: Ex, node: Node, outer: Node, scope: Scope): void {
  const n = node.childForFieldName('name');
  const body = node.childForFieldName('body');
  if (!n || scope.local) {
    // nested function: part of the enclosing body
    if (outer !== node) decorators(ex, outer, scope);
    if (body) ex.visitChildren(body, scope);
    return;
  }
  const inClass = scope.cls !== undefined;
  const name = n.text;
  const idx = ex.addSymbol({
    name,
    kind: inClass ? (name === '__init__' ? 'constructor' : 'method') : 'function',
    node: outer,
    scope,
    exported: isPublic(name) && (!inClass || scope.exported),
    sigEnd: body ? body.startIndex : node.endIndex,
    body,
    doc: docstring(body),
  });
  const inner = ex.enter(scope, idx, { local: true });
  if (outer !== node) decorators(ex, outer, inner);
  params(ex, node.childForFieldName('parameters'), inner);
  ex.typeRefs(node.childForFieldName('return_type'), inner, TYPE_NODES);
  if (body) ex.visitChildren(body, inner);
}

function assignment(ex: Ex, stmt: Node, a: Node, scope: Scope): void {
  const left = a.childForFieldName('left');
  const right = a.childForFieldName('right');
  const ty = a.childForFieldName('type');
  const rtype = ty ? typeOf(ty) : right?.type === 'call' ? ctorName(ex, right) : undefined;
  if (scope.local) {
    if (left?.type === 'identifier') scope.vars.set(left.text, rtype);
    else if (left?.type === 'attribute' && left.childForFieldName('object')?.text === 'self' && scope.cls !== undefined) {
      const attr = left.childForFieldName('attribute');
      if (attr) ex.classVars.get(scope.cls)?.set(attr.text, rtype);
    }
    if (right) ex.visit(ex, right, scope);
    if (left?.type === 'attribute') ex.visit(ex, left, scope);
    return;
  }
  if (left?.type !== 'identifier') {
    if (right) ex.visit(ex, right, scope);
    if (left?.type === 'attribute') ex.visit(ex, left, scope);
    return;
  }
  const name = left.text;
  const inClass = scope.cls !== undefined;
  scope.vars.set(name, rtype);
  if (!inClass && right && !ty && !isUpperStart(name) && isFunctionAlias(ex, right)) {
    // `gettext_lazy = lazy(gettext, str)`, `handler404 = defaults.page_not_found`: callable module API
    const idx = ex.addSymbol({ name, kind: 'function', node: stmt, scope, exported: isPublic(name), value: right });
    ex.visit(ex, right, ex.enter(scope, idx, { local: true }));
    return;
  }
  // Module level: UPPER_CASE constants, type aliases (Capitalized) and singletons built from a class
  // (`app = Flask(__name__)`, `router = APIRouter()`); other module variables are noise.
  if (inClass || isConstName(name) || isUpperStart(name) || rtype) {
    const idx = ex.addSymbol({
      name,
      kind: inClass ? (isConstName(name) ? 'constant' : 'field') : 'constant',
      node: stmt,
      scope,
      exported: isPublic(name) && (!inClass || scope.exported),
      value: right,
    });
    const inner = ex.enter(scope, idx, { local: true });
    ex.typeRefs(ty, inner, TYPE_NODES);
    if (right) ex.visit(ex, right, inner);
    return;
  }
  if (right) ex.visit(ex, right, scope);
}

/** Right side of a module-level assignment that binds a function: an alias, or a known function factory call. */
function isFunctionAlias(ex: Ex, right: Node): boolean {
  if (right.type === 'identifier') return !isUpperStart(right.text) && !isConstName(right.text) && right.text !== 'None';
  if (right.type === 'attribute') {
    const a = right.childForFieldName('attribute')?.text ?? '';
    return !!a && !isUpperStart(a);
  }
  if (right.type !== 'call') return false;
  const f = right.childForFieldName('function');
  const callee = f?.type === 'identifier' ? ex.dealias(f.text) : f?.type === 'attribute' ? f.childForFieldName('attribute')?.text : undefined;
  return !!callee && FUNCTION_FACTORIES.has(callee);
}

/** `Foo(...)` / `mod.Foo(...)` -> `Foo` when it looks like a class instantiation. */
function ctorName(ex: Ex, call: Node): string | undefined {
  const f = call.childForFieldName('function');
  if (!f) return undefined;
  const name = f.type === 'identifier' ? ex.dealias(f.text) : f.type === 'attribute' ? f.childForFieldName('attribute')?.text : undefined;
  return name && isUpperStart(name) ? name : undefined;
}

function importStmt(ex: Ex, node: Node, scope: Scope): void {
  if (node.type === 'import_statement') {
    for (const c of node.namedChildren) {
      if (!c) continue;
      if (c.type === 'dotted_name') {
        ex.addImport(c.text);
        ex.moduleAlias.set(c.text, c.text);
      } else if (c.type === 'aliased_import') {
        const n = c.childForFieldName('name');
        const a = c.childForFieldName('alias');
        if (n) {
          ex.addImport(n.text);
          if (a) ex.moduleAlias.set(a.text, n.text);
        }
      }
    }
    return;
  }
  // import_from_statement
  const mod = node.childForFieldName('module_name');
  if (!mod) return;
  const spec = mod.text.replace(/\s+/g, '');
  ex.addImport(spec);
  // `from x import *` re-exports x's names: recorded as an import of `*` so barrels follow it
  if (node.namedChildren.some((c) => c?.type === 'wildcard_import')) ex.addRef(scope, '*', 'import', mod, spec);
  for (const c of node.childrenForFieldName('name')) {
    if (!c) continue;
    let n: Node | null = c;
    let alias: string | undefined;
    if (c.type === 'aliased_import') {
      n = c.childForFieldName('name');
      alias = c.childForFieldName('alias')?.text;
    }
    if (!n) continue;
    const name = n.text;
    ex.addRef(scope, name, 'import', n, spec);
    ex.importAlias.set(alias ?? name, { name, spec });
    if (!isUpperStart(name)) ex.moduleAlias.set(alias ?? name, joinModule(spec, name, 'python'));
  }
}

export function visitPython(ex: Ex, node: Node, scope: Scope): void {
  const t = node.type;
  if (LEAVES.has(t)) return;
  switch (t) {
    case 'import_statement':
    case 'import_from_statement':
      importStmt(ex, node, scope);
      return;
    case 'class_definition':
      classDef(ex, node, node, scope);
      return;
    case 'function_definition':
      funcDef(ex, node, node, scope);
      return;
    case 'decorated_definition': {
      const def = node.childForFieldName('definition');
      if (def?.type === 'class_definition') classDef(ex, def, node, scope);
      else if (def?.type === 'function_definition') funcDef(ex, def, node, scope);
      else ex.visitChildren(node, scope);
      return;
    }
    case 'expression_statement': {
      const a = node.namedChildren[0];
      if (a?.type === 'assignment') assignment(ex, node, a, scope);
      else ex.visitChildren(node, scope);
      return;
    }
    case 'call': {
      const f = node.childForFieldName('function');
      if (f?.type === 'identifier') {
        const name = ex.dealias(f.text);
        ex.noteCall(node, ex.addRef(scope, name, isUpperStart(name) ? 'new' : 'call', f));
      } else if (f?.type === 'attribute') {
        const a = f.childForFieldName('attribute');
        const o = f.childForFieldName('object');
        const q = o?.text;
        const ref = a ? ex.addRef(scope, a.text, isUpperStart(a.text) && q && !q.startsWith('self') ? 'new' : 'call', a, q, ex.receiverHint(q, scope)) : undefined;
        ex.noteCall(node, ref);
        if (o) {
          ex.visit(ex, o, scope);
          ex.chainHint(ref, o);
        }
      } else if (f) ex.visit(ex, f, scope);
      const args = node.childForFieldName('arguments');
      if (args) ex.visitChildren(args, scope);
      return;
    }
    case 'attribute':
      // `obj.field`, `self.x = v` (calls and decorators are recorded by their own visitors)
      ex.memberRef(scope, node, node.childForFieldName('attribute'), node.childForFieldName('object'));
      return;
    case 'lambda':
      ex.visitChildren(node, { ...scope, local: true });
      return;
    default:
      ex.visitChildren(node, scope);
  }
}

export function initPython(ex: Ex, scope: Scope): void {
  ex.namespace = ex.options.pythonModule ?? pythonModule(ex.path);
  scope.q = ex.namespace;
}
