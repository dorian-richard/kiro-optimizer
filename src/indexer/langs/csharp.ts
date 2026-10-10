import type { Node } from 'web-tree-sitter';
import { baseTypeName, declaredType, Ex, isUpperStart, Vars, type Scope } from '../extract.js';
import type { SymbolKind } from '../../core/types.js';

const TYPE_NODES = ['identifier', 'qualified_name', 'generic_name'];
const TYPE_DECLS: Record<string, SymbolKind> = {
  class_declaration: 'class',
  struct_declaration: 'struct',
  interface_declaration: 'interface',
  record_declaration: 'record',
  record_struct_declaration: 'record',
  enum_declaration: 'enum',
};
const LEAVES = new Set([
  'identifier', 'comment', 'string_literal', 'integer_literal', 'real_literal', 'boolean_literal', 'null_literal',
  'predefined_type', 'modifier', 'character_literal', 'verbatim_string_literal', 'interpolated_string_text',
]);

function modifiers(node: Node): string[] {
  const out: string[] = [];
  for (const c of node.namedChildren) if (c?.type === 'modifier') out.push(c.text);
  return out;
}

function exportedMember(ex: Ex, scope: Scope, mods: string[]): boolean {
  if (mods.includes('public') || mods.includes('protected')) return true;
  if (mods.includes('private') || mods.includes('internal')) return false;
  const k = scope.cls !== undefined ? ex.symbols[scope.cls].kind : undefined;
  return k === 'interface' || k === 'enum';
}

/** Type node of a declaration (field name differs across grammar versions). */
function typeField(node: Node): Node | null {
  return node.childForFieldName('type') ?? node.childForFieldName('returns');
}

function typeRefs(ex: Ex, node: Node | null | undefined, scope: Scope): void {
  if (!node) return;
  // identifiers inside a type expression (generic args included); qualified names collapse to the last part
  for (const n of node.type === 'identifier' ? [node] : node.descendantsOfType('identifier')) {
    if (!n || !isUpperStart(n.text) || n.text.length < 2) continue;
    if (n.parent?.type === 'qualified_name' && n.nextSibling) continue;
    ex.addRef(scope, n.text, 'type_ref', n);
  }
}

function attributes(ex: Ex, node: Node, scope: Scope): void {
  for (const c of node.namedChildren) {
    if (c?.type !== 'attribute_list') continue;
    for (const a of c.namedChildren) {
      if (a?.type !== 'attribute') continue;
      const n = a.childForFieldName('name');
      const name = n ? baseTypeName(n.text) : undefined;
      if (n && name) ex.addRef(scope, name, 'type_ref', n);
      for (const arg of a.namedChildren) if (arg?.type === 'attribute_argument_list') ex.visitChildren(arg, scope);
    }
  }
}

function params(ex: Ex, list: Node | null, inner: Scope): void {
  for (const p of list?.namedChildren ?? []) {
    if (p?.type !== 'parameter') continue;
    const ty = typeField(p);
    const n = p.childForFieldName('name');
    if (n && ty) inner.vars.set(n.text, declaredType(ty.text));
    typeRefs(ex, ty, inner);
  }
}

function prescan(body: Node | null, vars: Vars): void {
  for (const m of body?.namedChildren ?? []) {
    if (!m) continue;
    if (m.type === 'field_declaration' || m.type === 'event_field_declaration') {
      const vd = m.namedChildren.find((c) => c?.type === 'variable_declaration');
      const t = declaredType(vd ? typeField(vd)?.text : undefined);
      for (const d of vd?.namedChildren ?? []) {
        if (d?.type !== 'variable_declarator') continue;
        const n = d.childForFieldName('name') ?? d.namedChildren.find((c) => c?.type === 'identifier');
        if (n) vars.set(n.text, t);
      }
    } else if (m.type === 'property_declaration') {
      const n = m.childForFieldName('name');
      if (n) vars.set(n.text, declaredType(typeField(m)?.text));
    }
  }
}

function typeDecl(ex: Ex, node: Node, scope: Scope, kind: SymbolKind): void {
  const n = node.childForFieldName('name');
  const body = node.childForFieldName('body');
  if (!n || scope.local) {
    if (body) ex.visitChildren(body, scope);
    return;
  }
  const mods = modifiers(node);
  const idx = ex.addSymbol({
    name: n.text,
    kind,
    node,
    scope,
    exported: exportedMember(ex, scope, mods),
    sigEnd: body ? body.startIndex : node.endIndex,
  });
  const inner = ex.enter(scope, idx, { container: true });
  attributes(ex, node, inner);
  for (const c of node.namedChildren) {
    if (c?.type !== 'base_list') continue;
    let first = true;
    for (const b of c.namedChildren) {
      if (!b) continue;
      const name = baseTypeName(b.text);
      if (!name) continue;
      // `class A : Base, IFoo`: interfaces conventionally start with I + capital
      const iface = kind === 'interface' || /^I[A-Z]/.test(name) || !first || kind === 'struct';
      ex.addRef(inner, name, kind === 'interface' ? 'inherit' : iface ? 'implement' : 'inherit', b);
      first = false;
    }
  }
  const recParams = node.childForFieldName('parameters') ?? node.namedChildren.find((c) => c?.type === 'parameter_list') ?? null;
  if (recParams && kind === 'record') {
    for (const p of recParams.namedChildren) {
      if (p?.type !== 'parameter') continue;
      const pn = p.childForFieldName('name');
      if (!pn) continue;
      ex.addSymbol({ name: pn.text, kind: 'property', node: p, scope: inner, exported: true });
      inner.vars.set(pn.text, declaredType(typeField(p)?.text));
      typeRefs(ex, typeField(p), inner);
    }
  }
  prescan(body, inner.vars);
  if (body) {
    if (kind === 'enum') {
      for (const m of body.namedChildren) {
        if (m?.type !== 'enum_member_declaration') continue;
        const mn = m.childForFieldName('name') ?? m.namedChildren.find((c) => c?.type === 'identifier');
        if (mn) ex.addSymbol({ name: mn.text, kind: 'constant', node: m, scope: inner, exported: true });
      }
    } else ex.visitChildren(body, inner);
  }
}

function method(ex: Ex, node: Node, scope: Scope, kind: SymbolKind): void {
  const n = node.childForFieldName('name');
  const body = node.childForFieldName('body') ?? node.namedChildren.find((c) => c?.type === 'arrow_expression_clause' || c?.type === 'block') ?? null;
  if (!n || scope.local) {
    if (body) ex.visit(ex, body, scope);
    return;
  }
  const idx = ex.addSymbol({
    name: n.text,
    kind,
    node,
    scope,
    exported: exportedMember(ex, scope, modifiers(node)),
    sigEnd: body ? body.startIndex : node.endIndex,
    body,
  });
  const inner = ex.enter(scope, idx, { local: true });
  attributes(ex, node, inner);
  params(ex, node.childForFieldName('parameters'), inner);
  if (kind !== 'constructor') typeRefs(ex, typeField(node), inner);
  for (const c of node.namedChildren) if (c?.type === 'constructor_initializer') ex.visitChildren(c, inner);
  if (body) ex.visit(ex, body, inner);
}

function field(ex: Ex, node: Node, scope: Scope): void {
  const vd = node.namedChildren.find((c) => c?.type === 'variable_declaration');
  if (!vd) return;
  const ty = typeField(vd);
  const mods = modifiers(node);
  const kind: SymbolKind = mods.includes('const') || (mods.includes('static') && mods.includes('readonly')) ? 'constant' : 'field';
  const exported = exportedMember(ex, scope, mods);
  for (const d of vd.namedChildren) {
    if (d?.type !== 'variable_declarator') continue;
    const n = d.childForFieldName('name') ?? d.namedChildren.find((c) => c?.type === 'identifier');
    if (!n) continue;
    const value = d.namedChildren.find((c) => c?.type === 'equals_value_clause') ?? null;
    const sig = ex.signature(node.startIndex, ty ? ty.endIndex : vd.startIndex) + ' ' + ex.signature(d.startIndex, d.endIndex, value);
    const idx = ex.addSymbol({ name: n.text, kind, node, scope, exported, sigStart: node.startIndex, sigEnd: node.startIndex });
    ex.symbols[idx].signature = sig.length > 300 ? sig.slice(0, 299) + '…' : sig;
    const inner = ex.enter(scope, idx, { local: true });
    attributes(ex, node, inner);
    typeRefs(ex, ty, inner);
    if (value) ex.visit(ex, value, inner);
  }
}

function property(ex: Ex, node: Node, scope: Scope): void {
  const n = node.childForFieldName('name');
  if (!n || scope.local) return;
  const accessors = node.childForFieldName('accessors') ?? node.namedChildren.find((c) => c?.type === 'accessor_list') ?? null;
  const arrow = node.namedChildren.find((c) => c?.type === 'arrow_expression_clause') ?? null;
  const short = accessors && accessors.text.length <= 60;
  const sigEnd = accessors ? (short ? accessors.endIndex : accessors.startIndex) : arrow ? arrow.startIndex : node.endIndex;
  const idx = ex.addSymbol({
    name: n.text,
    kind: 'property',
    node,
    scope,
    exported: exportedMember(ex, scope, modifiers(node)),
    sigEnd,
    body: accessors && !short ? accessors : arrow,
  });
  const inner = ex.enter(scope, idx, { local: true });
  attributes(ex, node, inner);
  typeRefs(ex, typeField(node), inner);
  if (accessors) ex.visitChildren(accessors, inner);
  if (arrow) ex.visit(ex, arrow, inner);
  const init = node.childForFieldName('value') ?? node.namedChildren.find((c) => c?.type === 'equals_value_clause');
  if (init) ex.visit(ex, init, inner);
}

function localDecl(ex: Ex, node: Node, scope: Scope): void {
  const vd = node.namedChildren.find((c) => c?.type === 'variable_declaration');
  if (!vd) return ex.visitChildren(node, scope);
  const ty = typeField(vd);
  const declared = ty ? declaredType(ty.text) : undefined;
  for (const d of vd.namedChildren) {
    if (d?.type !== 'variable_declarator') continue;
    const n = d.childForFieldName('name') ?? d.namedChildren.find((c) => c?.type === 'identifier');
    const value = d.namedChildren.find((c) => c?.type === 'equals_value_clause');
    let t = declared;
    const v = value?.namedChildren[0];
    if (!t && v?.type === 'object_creation_expression') t = baseTypeName(v.childForFieldName('type')?.text ?? '');
    // value first: `var x = repo.Find(id)` types x from the callee's declared result
    if (value) ex.visit(ex, value, scope);
    if (n) scope.vars.set(n.text, t ?? (ty && !/^var$/.test(ty.text.trim()) ? undefined : ex.valueHint(v)));
  }
}

/** Object initializer `new Foo { Bar = 1 }`: a write of Foo.Bar for each `Name = value`, then the values. */
function initializerWrites(ex: Ex, init: Node, scope: Scope, typeName: string): void {
  for (const a of init.namedChildren) {
    if (!a) continue;
    const left = a.type === 'assignment_expression' ? a.childForFieldName('left') : null;
    if (left?.type === 'identifier') {
      ex.addRef(scope, left.text, 'write', left, typeName, `T:${typeName}`);
      const right = a.childForFieldName('right');
      if (right) ex.visit(ex, right, scope);
    } else ex.visit(ex, a, scope);
  }
}

export function visitCSharp(ex: Ex, node: Node, scope: Scope): void {
  const t = node.type;
  if (LEAVES.has(t)) return;
  switch (t) {
    case 'using_directive': {
      const n = node.namedChildren.find((c) => c && (c.type === 'qualified_name' || c.type === 'identifier'));
      if (n) ex.addImport(n.text.replace(/\s+/g, ''));
      return;
    }
    case 'namespace_declaration':
    case 'file_scoped_namespace_declaration': {
      const n = node.childForFieldName('name');
      if (!n) return ex.visitChildren(node, scope);
      const name = n.text.replace(/\s+/g, '');
      if (!ex.namespace) ex.namespace = scope.q ? `${scope.q}.${name}` : name;
      const inner: Scope = { ...scope, q: scope.q ? `${scope.q}.${name}` : name };
      const body = node.childForFieldName('body');
      if (body) ex.visitChildren(body, inner);
      else for (const c of node.namedChildren) if (c && c !== n) ex.visit(ex, c, inner);
      return;
    }
    case 'class_declaration':
    case 'struct_declaration':
    case 'interface_declaration':
    case 'record_declaration':
    case 'record_struct_declaration':
    case 'enum_declaration':
      typeDecl(ex, node, scope, TYPE_DECLS[t]);
      return;
    case 'delegate_declaration': {
      const n = node.childForFieldName('name');
      if (n && !scope.local) ex.addSymbol({ name: n.text, kind: 'type', node, scope, exported: exportedMember(ex, scope, modifiers(node)) });
      return;
    }
    case 'method_declaration':
    case 'operator_declaration':
    case 'conversion_operator_declaration':
      method(ex, node, scope, 'method');
      return;
    case 'local_function_statement': {
      const body = node.childForFieldName('body') ?? node.namedChildren.find((c) => c?.type === 'block' || c?.type === 'arrow_expression_clause');
      if (body) ex.visit(ex, body, scope);
      return;
    }
    case 'constructor_declaration':
      method(ex, node, scope, 'constructor');
      return;
    case 'field_declaration':
    case 'event_field_declaration':
      if (scope.local) return ex.visitChildren(node, scope);
      field(ex, node, scope);
      return;
    case 'property_declaration':
      property(ex, node, scope);
      return;
    case 'local_declaration_statement':
      localDecl(ex, node, scope);
      return;
    case 'invocation_expression': {
      const f = node.childForFieldName('function') ?? node.namedChildren[0];
      if (f) {
        if (f.type === 'identifier' || f.type === 'generic_name') {
          const name = f.type === 'generic_name' ? f.namedChildren[0]?.text : f.text;
          if (name) ex.noteCall(node, ex.addRef(scope, name, 'call', f));
        } else if (f.type === 'member_access_expression') {
          const name = f.childForFieldName('name');
          const obj = f.childForFieldName('expression');
          const nm = name?.type === 'generic_name' ? name.namedChildren[0]?.text : name?.text;
          const ref = name && nm ? ex.addRef(scope, nm, 'call', name, obj?.text, ex.receiverHint(obj?.text, scope)) : undefined;
          ex.noteCall(node, ref);
          if (obj) {
            ex.visit(ex, obj, scope);
            ex.chainHint(ref, obj);
          }
        } else ex.visit(ex, f, scope);
      }
      const args = node.childForFieldName('arguments') ?? node.namedChildren.find((c) => c?.type === 'argument_list');
      if (args) ex.visitChildren(args, scope);
      return;
    }
    case 'object_creation_expression': {
      const ty = node.childForFieldName('type');
      const name = ty ? baseTypeName(ty.text) : undefined;
      if (ty && name) ex.noteCall(node, ex.addRef(scope, name, 'new', ty));
      for (const c of node.namedChildren) {
        if (!c || c === ty) continue;
        if (c.type === 'initializer_expression' && name) initializerWrites(ex, c, scope, name);
        else ex.visit(ex, c, scope);
      }
      return;
    }
    case 'member_access_expression':
      // `obj.Field`, `this.x = v`, `Color.Red` (invocations record their callee themselves)
      ex.memberRef(scope, node, node.childForFieldName('name'), node.childForFieldName('expression'));
      return;
    case 'attribute_list':
      return;
    default:
      ex.visitChildren(node, scope);
  }
}
