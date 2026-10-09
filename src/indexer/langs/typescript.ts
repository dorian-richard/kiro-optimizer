import type { Node } from 'web-tree-sitter';
import { baseTypeName, Ex, isConstName, isUpperStart, Vars, type Scope } from '../extract.js';
import type { SymbolKind } from '../../core/types.js';

const TYPE_NODES = ['type_identifier'];
const FUNCTION_VALUES = new Set(['arrow_function', 'function_expression', 'function', 'generator_function']);
const LEAVES = new Set([
  'identifier', 'property_identifier', 'type_identifier', 'string', 'template_string', 'number', 'comment', 'regex',
  'true', 'false', 'null', 'undefined', 'this', 'super', 'predefined_type', 'shorthand_property_identifier', 'string_fragment',
  'jsx_text', 'html_comment', 'private_property_identifier', 'statement_identifier', 'hash_bang_line',
]);

/** Names listed in `export { a, b }` clauses, applied after the walk. */
const exportedNames = new WeakMap<Ex, Set<string>>();

function stringValue(node: Node | null | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === 'string') return node.text.slice(1, -1);
  if (node.type === 'template_string' && !node.text.includes('${')) return node.text.slice(1, -1);
  return undefined;
}

function annotationType(node: Node | null | undefined): string | undefined {
  if (!node) return undefined;
  const inner = node.type === 'type_annotation' ? node.namedChildren[0] : node;
  return inner ? baseTypeName(inner.text) : undefined;
}

function isPrivate(member: Node, nameNode: Node | null): boolean {
  if (nameNode?.type === 'private_property_identifier') return true;
  for (const c of member.namedChildren) if (c?.type === 'accessibility_modifier' && c.text === 'private') return true;
  return false;
}

function hasKeyword(node: Node, word: string): boolean {
  for (const c of node.children) {
    if (!c) continue;
    if (c.type === word) return true;
    if (c.type === 'property_identifier' || c.type === 'formal_parameters' || c.type === 'statement_block') break;
  }
  return false;
}

/** Parameter names/types into `inner.vars`, type refs, and TS parameter properties as class fields. */
function params(ex: Ex, list: Node | null | undefined, inner: Scope, ctorOf?: { scope: Scope }): void {
  if (!list) return;
  for (const p of list.namedChildren) {
    if (!p) continue;
    if (p.type !== 'required_parameter' && p.type !== 'optional_parameter') {
      if (p.type === 'identifier') continue;
      continue;
    }
    const pat = p.childForFieldName('pattern');
    const typeNode = p.childForFieldName('type');
    const tname = annotationType(typeNode);
    if (pat?.type === 'identifier') inner.vars.set(pat.text, tname);
    if (typeNode) ex.typeRefs(typeNode, inner, TYPE_NODES);
    if (ctorOf && pat?.type === 'identifier') {
      const acc = p.namedChildren.find((c) => c?.type === 'accessibility_modifier');
      const ro = p.children.some((c) => c?.type === 'readonly');
      if (acc || ro) {
        const cls = ctorOf.scope;
        const priv = acc?.text === 'private';
        ex.addSymbol({ name: pat.text, kind: 'field', node: p, scope: cls, exported: cls.exported && !priv });
        cls.vars.set(pat.text, tname);
      }
    }
    const value = p.childForFieldName('value');
    if (value) ex.visit(ex, value, inner);
  }
}

function functionLike(
  ex: Ex,
  opts: { name: string; kind: SymbolKind; node: Node; fn: Node; scope: Scope; exported: boolean; qname?: string; sigStart?: number },
): number {
  const body = opts.fn.childForFieldName('body');
  const idx = ex.addSymbol({
    name: opts.name,
    kind: opts.kind,
    node: opts.node,
    scope: opts.scope,
    exported: opts.exported,
    sigStart: opts.sigStart,
    sigEnd: body ? body.startIndex : opts.node.endIndex,
    body,
    qname: opts.qname,
  });
  const inner = ex.enter(opts.scope, idx, { local: true });
  params(ex, opts.fn.childForFieldName('parameters'), inner, opts.kind === 'constructor' ? { scope: opts.scope } : undefined);
  // single-identifier arrow params: `x => x.go()`
  const p = opts.fn.childForFieldName('parameter');
  if (p) inner.vars.set(p.text, undefined);
  ex.typeRefs(opts.fn.childForFieldName('return_type'), inner, TYPE_NODES);
  for (const c of opts.node.namedChildren) if (c?.type === 'decorator') decorator(ex, c, inner);
  if (body) {
    if (body.type === 'statement_block' || body.type === 'class_body') ex.visitChildren(body, inner);
    else ex.visit(ex, body, inner);
  }
  return idx;
}

function decorator(ex: Ex, node: Node, scope: Scope): void {
  const e = node.namedChildren[0];
  if (!e) return;
  if (e.type === 'identifier') ex.addRef(scope, ex.dealias(e.text), 'call', e);
  else if (e.type === 'member_expression') {
    const prop = e.childForFieldName('property');
    if (prop) ex.addRef(scope, prop.text, 'call', prop, e.childForFieldName('object')?.text);
  } else ex.visit(ex, e, scope);
}

function classDecl(ex: Ex, node: Node, scope: Scope, outer: Node, exported: boolean, nameOverride?: string): void {
  const nameNode = node.childForFieldName('name');
  const body = node.childForFieldName('body');
  const name = nameOverride ?? nameNode?.text ?? (outer.type === 'export_statement' ? 'default' : undefined);
  if (scope.local || !name) {
    if (body) ex.visitChildren(body, { ...scope, local: true });
    return;
  }
  const idx = ex.addSymbol({ name, kind: 'class', node: outer, scope, exported, sigEnd: body ? body.startIndex : node.endIndex });
  const inner = ex.enter(scope, idx, { container: true });
  for (const c of outer === node ? node.namedChildren : [...outer.namedChildren, ...node.namedChildren]) {
    if (c?.type === 'decorator') decorator(ex, c, inner);
  }
  for (const c of node.namedChildren) {
    if (c?.type !== 'class_heritage') continue;
    for (const h of c.namedChildren) {
      if (!h) continue;
      if (h.type === 'extends_clause') {
        for (const v of h.childrenForFieldName('value')) {
          if (!v) continue;
          if (v.type === 'member_expression') {
            const prop = v.childForFieldName('property');
            if (prop) ex.addRef(inner, prop.text, 'inherit', prop, v.childForFieldName('object')?.text);
          } else if (v.type === 'identifier') {
            ex.addRef(inner, ex.dealias(v.text), 'inherit', v);
          } else ex.visit(ex, v, inner);
        }
        for (const ta of h.childrenForFieldName('type_arguments')) ex.typeRefs(ta, inner, TYPE_NODES);
      } else if (h.type === 'implements_clause') {
        for (const t of h.namedChildren) {
          const n = t ? baseTypeName(t.text) : undefined;
          if (t && n) ex.addRef(inner, n, 'implement', t);
        }
      } else {
        // JS grammar: `class A extends B` puts the expression directly in class_heritage
        if (h.type === 'identifier') ex.addRef(inner, ex.dealias(h.text), 'inherit', h);
      }
    }
  }
  if (body) {
    prescanClass(body, inner.vars);
    ex.visitChildren(body, inner);
  }
}

function prescanClass(body: Node, vars: Vars): void {
  for (const m of body.namedChildren) {
    if (!m) continue;
    if (m.type === 'public_field_definition' || m.type === 'field_definition') {
      const n = m.childForFieldName('name') ?? m.childForFieldName('property');
      if (!n) continue;
      let t = annotationType(m.childForFieldName('type'));
      const v = m.childForFieldName('value');
      if (!t && v?.type === 'new_expression') t = baseTypeName(v.childForFieldName('constructor')?.text ?? '');
      vars.set(n.text.replace(/^#/, ''), t);
    }
  }
}

function member(ex: Ex, node: Node, scope: Scope): void {
  const t = node.type;
  const nameNode = node.childForFieldName('name') ?? node.childForFieldName('property');
  if (scope.local || !nameNode || scope.cls === undefined) {
    // object-literal methods and members of local classes: refs only
    const body = node.childForFieldName('body');
    const value = node.childForFieldName('value');
    if (body) ex.visitChildren(body, { ...scope, local: true });
    if (value) ex.visit(ex, value, { ...scope, local: true });
    return;
  }
  const name = nameNode.type === 'string' ? nameNode.text.slice(1, -1) : nameNode.text;
  const exported = scope.exported && !isPrivate(node, nameNode);
  if (t === 'method_definition') {
    const kind: SymbolKind = name === 'constructor' ? 'constructor' : hasKeyword(node, 'get') || hasKeyword(node, 'set') ? 'property' : 'method';
    functionLike(ex, { name, kind, node, fn: node, scope, exported });
    return;
  }
  if (t === 'abstract_method_signature' || t === 'method_signature') {
    functionLike(ex, { name, kind: 'method', node, fn: node, scope, exported: scope.exported && !isPrivate(node, nameNode) });
    return;
  }
  if (t === 'property_signature') {
    const idx = ex.addSymbol({ name, kind: 'property', node, scope, exported });
    ex.typeRefs(node.childForFieldName('type'), ex.enter(scope, idx, { local: true }), TYPE_NODES);
    return;
  }
  // class fields
  const value = node.childForFieldName('value');
  if (value && FUNCTION_VALUES.has(value.type)) {
    functionLike(ex, { name, kind: 'method', node, fn: value, scope, exported });
    return;
  }
  const isStatic = hasKeyword(node, 'static');
  const ro = hasKeyword(node, 'readonly');
  const kind: SymbolKind = isStatic && ro && isConstName(name) ? 'constant' : 'field';
  const idx = ex.addSymbol({ name, kind, node, scope, exported, value });
  const inner = ex.enter(scope, idx, { local: true });
  ex.typeRefs(node.childForFieldName('type'), inner, TYPE_NODES);
  for (const c of node.namedChildren) if (c?.type === 'decorator') decorator(ex, c, inner);
  if (value) ex.visit(ex, value, inner);
}

function interfaceDecl(ex: Ex, node: Node, scope: Scope, outer: Node, exported: boolean): void {
  const nameNode = node.childForFieldName('name');
  const body = node.childForFieldName('body');
  if (!nameNode || scope.local) return;
  const idx = ex.addSymbol({ name: nameNode.text, kind: 'interface', node: outer, scope, exported, sigEnd: body ? body.startIndex : node.endIndex });
  const inner = ex.enter(scope, idx, { container: true });
  for (const c of node.namedChildren) {
    if (c?.type === 'extends_type_clause' || c?.type === 'extends_clause') {
      for (const ty of c.namedChildren) {
        const n = ty ? baseTypeName(ty.text) : undefined;
        if (ty && n) ex.addRef(inner, n, 'inherit', ty);
      }
    }
  }
  if (body) ex.visitChildren(body, inner);
}

function enumDecl(ex: Ex, node: Node, scope: Scope, outer: Node, exported: boolean): void {
  const nameNode = node.childForFieldName('name');
  const body = node.childForFieldName('body');
  if (!nameNode || scope.local) return;
  const idx = ex.addSymbol({ name: nameNode.text, kind: 'enum', node: outer, scope, exported, sigEnd: body ? body.startIndex : node.endIndex });
  const inner = ex.enter(scope, idx, { container: true });
  for (const m of body?.namedChildren ?? []) {
    if (!m) continue;
    const n = m.type === 'property_identifier' ? m : m.type === 'enum_assignment' ? m.childForFieldName('name') : null;
    if (n) ex.addSymbol({ name: n.text.replace(/^['"]|['"]$/g, ''), kind: 'constant', node: m, scope: inner, exported });
  }
}

function namespaceDecl(ex: Ex, node: Node, scope: Scope, outer: Node, exported: boolean): void {
  const nameNode = node.childForFieldName('name');
  const body = node.childForFieldName('body');
  if (!nameNode || scope.local) {
    if (body) ex.visitChildren(body, scope);
    return;
  }
  const name = nameNode.type === 'string' ? nameNode.text.slice(1, -1) : nameNode.text;
  const idx = ex.addSymbol({ name, kind: 'namespace', node: outer, scope, exported, sigEnd: body ? body.startIndex : node.endIndex });
  const inner = ex.enter(scope, idx, { container: true, exported: false });
  if (body) ex.visitChildren(body, inner);
}

function varDecl(ex: Ex, node: Node, scope: Scope, outer: Node, exported: boolean): void {
  const isConst = node.children.some((c) => c?.type === 'const');
  for (const d of node.namedChildren) {
    if (d?.type !== 'variable_declarator') continue;
    const nameNode = d.childForFieldName('name');
    const value = d.childForFieldName('value');
    const typeNode = d.childForFieldName('type');
    if (!nameNode) continue;
    // CommonJS: const x = require('./y') / const { a, b: c } = require('./y')
    if (value?.type === 'call_expression' && value.childForFieldName('function')?.text === 'require') {
      const spec = stringValue(value.childForFieldName('arguments')?.namedChildren[0]);
      if (spec) {
        ex.addImport(spec);
        if (nameNode.type === 'identifier') ex.moduleAlias.set(nameNode.text, spec);
        else if (nameNode.type === 'object_pattern') {
          for (const p of nameNode.namedChildren) {
            if (p?.type === 'shorthand_property_identifier_pattern') {
              ex.addRef(scope, p.text, 'import', p, spec);
              ex.importAlias.set(p.text, { name: p.text, spec });
            } else if (p?.type === 'pair_pattern') {
              const k = p.childForFieldName('key');
              const v = p.childForFieldName('value');
              if (k && v?.type === 'identifier') {
                ex.addRef(scope, k.text, 'import', k, spec);
                ex.importAlias.set(v.text, { name: k.text, spec });
              }
            }
          }
        }
        continue;
      }
    }
    let vtype = annotationType(typeNode);
    if (!vtype && value?.type === 'new_expression') vtype = baseTypeName(value.childForFieldName('constructor')?.text ?? '');
    if (!vtype && value?.type === 'await_expression') {
      const inner = value.namedChildren[0];
      if (inner?.type === 'new_expression') vtype = baseTypeName(inner.childForFieldName('constructor')?.text ?? '');
    }
    if (nameNode.type === 'identifier') scope.vars.set(nameNode.text, vtype);
    if (scope.local || nameNode.type !== 'identifier') {
      if (typeNode) ex.typeRefs(typeNode, scope, TYPE_NODES);
      if (value) ex.visit(ex, value, scope);
      continue;
    }
    const name = nameNode.text;
    const single = node.namedChildren.filter((c) => c?.type === 'variable_declarator').length === 1;
    const symNode = single ? outer : d;
    const sigStart = single ? outer.startIndex : d.startIndex;
    if (value && FUNCTION_VALUES.has(value.type)) {
      functionLike(ex, { name, kind: 'function', node: symNode, fn: value, scope, exported, sigStart });
      continue;
    }
    if (value && (value.type === 'class' || value.type === 'class_declaration')) {
      classDecl(ex, value, scope, symNode, exported, name);
      continue;
    }
    const exportedLater = scope.q === '' && (exportedNames.get(ex)?.has(name) ?? false);
    // HOC-wrapped components / handlers: `const Inner = memo(function Inner() {...})`, `forwardRef((p, r) => ...)`
    const wrapped = value?.type === 'call_expression' ? value.childForFieldName('arguments')?.namedChildren.find((a) => a && FUNCTION_VALUES.has(a.type)) : undefined;
    if (wrapped && (exported || exportedLater || isUpperStart(name))) {
      functionLike(ex, { name, kind: 'function', node: symNode, fn: wrapped, scope, exported, sigStart });
      ex.visit(ex, value!.childForFieldName('function')!, scope);
      continue;
    }
    if (exported || exportedLater || isConstName(name)) {
      const idx = ex.addSymbol({ name, kind: 'constant', node: symNode, scope, exported, sigStart, value });
      const inner = ex.enter(scope, idx, { local: true });
      if (typeNode) ex.typeRefs(typeNode, inner, TYPE_NODES);
      if (value) ex.visit(ex, value, inner);
      continue;
    }
    if (value) ex.visit(ex, value, { ...scope, local: true });
  }
}

function importStmt(ex: Ex, node: Node, scope: Scope): void {
  const spec = stringValue(node.childForFieldName('source'));
  if (!spec) return;
  ex.addImport(spec);
  for (const c of node.namedChildren) {
    if (c?.type === 'import_require_clause') {
      const id = c.namedChildren.find((x) => x?.type === 'identifier');
      if (id) ex.moduleAlias.set(id.text, spec);
    }
    if (c?.type !== 'import_clause') continue;
    for (const k of c.namedChildren) {
      if (!k) continue;
      if (k.type === 'identifier') {
        // default import: the local name usually matches the exported declaration
        ex.addRef(scope, k.text, 'import', k, spec);
        ex.importAlias.set(k.text, { name: k.text, spec });
      } else if (k.type === 'namespace_import') {
        const id = k.namedChildren.find((x) => x?.type === 'identifier');
        if (id) ex.moduleAlias.set(id.text, spec);
      } else if (k.type === 'named_imports') {
        for (const s of k.namedChildren) {
          if (s?.type !== 'import_specifier') continue;
          const n = s.childForFieldName('name');
          const a = s.childForFieldName('alias');
          if (!n) continue;
          const name = n.type === 'string' ? n.text.slice(1, -1) : n.text;
          ex.addRef(scope, name, 'import', n, spec);
          ex.importAlias.set(a?.text ?? name, { name, spec });
        }
      }
    }
  }
}

function exportStmt(ex: Ex, node: Node, scope: Scope): void {
  const source = stringValue(node.childForFieldName('source'));
  if (source) {
    // re-export: `export { a } from './x'`, `export * from './x'`
    ex.addImport(source);
    for (const c of node.namedChildren) {
      if (c?.type !== 'export_clause') continue;
      for (const s of c.namedChildren) {
        const n = s?.childForFieldName('name');
        if (n) ex.addRef(scope, n.text, 'import', n, source);
      }
    }
    return;
  }
  const decl = node.childForFieldName('declaration');
  if (decl) {
    declaration(ex, decl, scope, node, true);
    return;
  }
  const value = node.childForFieldName('value');
  if (value) {
    if (value.type === 'identifier') markExported(ex, value.text);
    else if (FUNCTION_VALUES.has(value.type) && !scope.local) {
      const n = value.childForFieldName('name');
      functionLike(ex, { name: n?.text ?? 'default', kind: 'function', node, fn: value, scope, exported: true });
    } else if (value.type === 'class') classDecl(ex, value, scope, node, true);
    else ex.visit(ex, value, { ...scope, local: true });
    return;
  }
  for (const c of node.namedChildren) {
    if (c?.type !== 'export_clause') continue;
    for (const s of c.namedChildren) {
      const n = s?.childForFieldName('name');
      if (n) markExported(ex, n.text);
    }
  }
}

function markExported(ex: Ex, name: string): void {
  let set = exportedNames.get(ex);
  if (!set) exportedNames.set(ex, (set = new Set()));
  set.add(name);
}

/** Declarations that may be wrapped in `export` / `declare`. Returns false when `decl` is not one. */
function declaration(ex: Ex, decl: Node, scope: Scope, outer: Node, exported: boolean): boolean {
  switch (decl.type) {
    case 'class_declaration':
    case 'abstract_class_declaration':
      classDecl(ex, decl, scope, outer, exported);
      return true;
    case 'interface_declaration':
      interfaceDecl(ex, decl, scope, outer, exported);
      return true;
    case 'type_alias_declaration': {
      const n = decl.childForFieldName('name');
      if (!n || scope.local) return true;
      const value = decl.childForFieldName('value');
      const idx = ex.addSymbol({ name: n.text, kind: 'type', node: outer, scope, exported, value });
      ex.typeRefs(value, ex.enter(scope, idx, { local: true }), TYPE_NODES);
      return true;
    }
    case 'enum_declaration':
      enumDecl(ex, decl, scope, outer, exported);
      return true;
    case 'internal_module':
    case 'module':
      namespaceDecl(ex, decl, scope, outer, exported);
      return true;
    case 'function_declaration':
    case 'generator_function_declaration':
    case 'function_signature': {
      const n = decl.childForFieldName('name');
      if (scope.local || !n) {
        const body = decl.childForFieldName('body');
        if (body) ex.visitChildren(body, { ...scope, local: true });
        return true;
      }
      functionLike(ex, { name: n.text, kind: 'function', node: outer, fn: decl, scope, exported });
      return true;
    }
    case 'lexical_declaration':
    case 'variable_declaration':
      varDecl(ex, decl, scope, outer, exported);
      return true;
    case 'ambient_declaration':
      for (const c of decl.namedChildren) if (c) declaration(ex, c, scope, c, exported) || ex.visit(ex, c, scope);
      return true;
    default:
      return false;
  }
}

function callExpr(ex: Ex, node: Node, scope: Scope): void {
  const fn = node.childForFieldName('function');
  const args = node.childForFieldName('arguments');
  if (fn) {
    if (fn.type === 'identifier') {
      const text = fn.text;
      if (text === 'require' || text === 'import') {
        const spec = stringValue(args?.namedChildren[0]);
        if (spec) ex.addImport(spec);
        return;
      }
      ex.addRef(scope, ex.dealias(text), 'call', fn);
    } else if (fn.type === 'member_expression') {
      const prop = fn.childForFieldName('property');
      const obj = fn.childForFieldName('object');
      if (prop) {
        const q = obj?.text;
        ex.addRef(scope, prop.text.replace(/^#/, ''), 'call', prop, q, ex.receiverHint(q, scope));
      }
      if (obj) ex.visit(ex, obj, scope);
    } else if (fn.type === 'import') {
      const spec = stringValue(args?.namedChildren[0]);
      if (spec) ex.addImport(spec);
    } else if (fn.type !== 'super') {
      ex.visit(ex, fn, scope);
    }
  }
  if (args) ex.visitChildren(args, scope);
}

function expressionStmt(ex: Ex, node: Node, scope: Scope): void {
  const a = node.namedChildren[0];
  if (!scope.local && a?.type === 'assignment_expression') {
    const left = a.childForFieldName('left');
    const right = a.childForFieldName('right');
    if (left?.type === 'member_expression' && right && FUNCTION_VALUES.has(right.type)) {
      const obj = left.childForFieldName('object')?.text ?? '';
      const prop = left.childForFieldName('property')?.text;
      if (prop && (obj === 'exports' || obj === 'module.exports')) {
        functionLike(ex, { name: prop, kind: 'function', node, fn: right, scope, exported: true });
        return;
      }
      if (prop && obj.endsWith('.prototype')) {
        const cls = obj.slice(0, -'.prototype'.length);
        functionLike(ex, { name: prop, kind: 'method', node, fn: right, scope, exported: true, qname: `${cls}.${prop}` });
        return;
      }
    }
    if (left?.text === 'module.exports' && right && FUNCTION_VALUES.has(right.type)) {
      const n = right.childForFieldName('name');
      functionLike(ex, { name: n?.text ?? 'exports', kind: 'function', node, fn: right, scope, exported: true });
      return;
    }
    if (left?.text === 'module.exports' && right?.type === 'object') {
      // module.exports = { a, b: c } exports the local declarations a and c
      for (const p of right.namedChildren) {
        if (p?.type === 'shorthand_property_identifier') markExported(ex, p.text);
        else if (p?.type === 'pair' && p.childForFieldName('value')?.type === 'identifier') markExported(ex, p.childForFieldName('value')!.text);
      }
    }
  }
  ex.visitChildren(node, scope);
}

export function visitTs(ex: Ex, node: Node, scope: Scope): void {
  const t = node.type;
  if (LEAVES.has(t)) return;
  switch (t) {
    case 'import_statement':
      importStmt(ex, node, scope);
      return;
    case 'export_statement':
      exportStmt(ex, node, scope);
      return;
    case 'class':
      // class expression in an expression position
      classDecl(ex, node, { ...scope, local: true }, node, false);
      return;
    case 'method_definition':
    case 'public_field_definition':
    case 'field_definition':
    case 'abstract_method_signature':
    case 'method_signature':
    case 'property_signature':
      member(ex, node, scope);
      return;
    case 'call_signature':
    case 'construct_signature':
    case 'index_signature':
      return;
    case 'expression_statement':
      expressionStmt(ex, node, scope);
      return;
    case 'call_expression':
      callExpr(ex, node, scope);
      return;
    case 'new_expression': {
      const c = node.childForFieldName('constructor');
      if (c?.type === 'identifier') ex.addRef(scope, ex.dealias(c.text), 'new', c);
      else if (c?.type === 'member_expression') {
        const prop = c.childForFieldName('property');
        if (prop) ex.addRef(scope, prop.text, 'new', prop, c.childForFieldName('object')?.text);
      }
      const args = node.childForFieldName('arguments');
      if (args) ex.visitChildren(args, scope);
      return;
    }
    case 'jsx_opening_element':
    case 'jsx_self_closing_element': {
      const n = node.childForFieldName('name');
      if (n?.type === 'identifier' && isUpperStart(n.text)) ex.addRef(scope, ex.dealias(n.text), 'call', n);
      else if (n && (n.type === 'member_expression' || n.type === 'nested_identifier')) {
        const parts = n.text.split('.');
        ex.addRef(scope, parts[parts.length - 1], 'call', n, parts.slice(0, -1).join('.'));
      }
      for (const c of node.namedChildren) if (c && c !== n) ex.visit(ex, c, scope);
      return;
    }
    case 'decorator':
      decorator(ex, node, scope);
      return;
    case 'arrow_function':
    case 'function_expression':
    case 'function':
    case 'generator_function': {
      // callbacks: typed params help resolve calls in the body
      const inner = { ...scope, local: true, vars: new Vars(scope.vars) };
      params(ex, node.childForFieldName('parameters'), inner);
      const body = node.childForFieldName('body');
      if (body) ex.visit(ex, body, inner);
      return;
    }
    case 'object':
      ex.visitChildren(node, scope.local ? scope : { ...scope, local: true });
      return;
    case 'type_annotation':
    case 'type_arguments':
      if (scope.local) return;
      ex.visitChildren(node, scope);
      return;
    default:
      if (declaration(ex, node, scope, node, false)) return;
      ex.visitChildren(node, scope);
  }
}

/** Collects `export { a, b }` names up front so declarations above the clause know they are exported. */
export function initTs(ex: Ex, _scope: Scope, root: Node): void {
  for (const c of root.namedChildren) {
    if (c?.type !== 'export_statement' || c.childForFieldName('source') || c.childForFieldName('declaration')) continue;
    for (const clause of c.namedChildren) {
      if (clause?.type !== 'export_clause') continue;
      for (const sp of clause.namedChildren) {
        const n = sp?.childForFieldName('name');
        if (n) markExported(ex, n.text);
      }
    }
  }
}

/** Applies `export { a, b }` clauses to top-level symbols. */
export function postTs(ex: Ex): void {
  const names = exportedNames.get(ex);
  if (!names) return;
  for (const s of ex.symbols) if (s.parent === undefined && names.has(s.name)) s.exported = true;
  for (const s of ex.symbols) {
    if (s.parent === undefined || s.exported) continue;
    const p = ex.symbols[s.parent];
    // members of a class exported late (export { Foo }) follow the class unless private
    if (p.exported && p.parent === undefined && names.has(p.name) && !/(^|\s)(private|#)/.test(s.signature)) s.exported = true;
  }
}
