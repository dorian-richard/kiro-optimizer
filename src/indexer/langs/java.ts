import type { Node } from 'web-tree-sitter';
import { baseTypeName, declaredType, Ex, isConstName, isUpperStart, Vars, type Scope } from '../extract.js';
import type { SymbolKind } from '../../core/types.js';

const TYPE_NODES = ['type_identifier'];
const TYPE_DECLS: Record<string, SymbolKind> = {
  class_declaration: 'class',
  interface_declaration: 'interface',
  enum_declaration: 'enum',
  record_declaration: 'record',
  annotation_type_declaration: 'interface',
};

function modifiersText(node: Node): string {
  for (const c of node.namedChildren) if (c?.type === 'modifiers') return c.text;
  return '';
}

function hasMod(mods: string, word: string): boolean {
  return new RegExp(`(^|\\s)${word}(\\s|$)`).test(mods.replace(/@\w[\w.]*(\([^)]*\))?/g, ' '));
}

function isApiMember(ex: Ex, scope: Scope, mods: string): boolean {
  if (hasMod(mods, 'public') || hasMod(mods, 'protected')) return true;
  if (hasMod(mods, 'private')) return false;
  const k = scope.cls !== undefined ? ex.symbols[scope.cls].kind : undefined;
  return k === 'interface'; // interface / annotation members are implicitly public
}

function annotationRefs(ex: Ex, node: Node, scope: Scope): void {
  for (const c of node.namedChildren) {
    if (c?.type !== 'modifiers') continue;
    for (const a of c.namedChildren) {
      if (a?.type === 'marker_annotation' || a?.type === 'annotation') {
        const n = a.childForFieldName('name');
        const name = n ? baseTypeName(n.text) : undefined;
        if (name && n) ex.addRef(scope, name, 'type_ref', n);
        const args = a.childForFieldName('arguments');
        if (args) ex.visitChildren(args, scope);
      }
    }
  }
}

function prescanFields(body: Node | null, vars: Vars): void {
  if (!body) return;
  for (const m of body.namedChildren) {
    if (!m) continue;
    if (m.type === 'field_declaration' || m.type === 'constant_declaration') {
      const t = declaredType(m.childForFieldName('type')?.text);
      for (const d of m.childrenForFieldName('declarator')) {
        const n = d?.childForFieldName('name');
        if (n) vars.set(n.text, t);
      }
    } else if (m.type === 'enum_body_declarations') {
      prescanFields(m, vars);
    }
  }
}

function params(ex: Ex, list: Node | null, scope: Scope, inner: Scope): void {
  if (!list) return;
  for (const p of list.namedChildren) {
    if (!p) continue;
    if (p.type === 'formal_parameter' || p.type === 'spread_parameter' || p.type === 'receiver_parameter') {
      const typeNode = p.childForFieldName('type') ?? p.namedChildren.find((c) => c && /type|identifier$/.test(c.type) && c.type !== 'identifier') ?? null;
      const nameNode = p.childForFieldName('name') ?? p.namedChildren.find((c) => c?.type === 'variable_declarator')?.childForFieldName('name') ?? null;
      if (typeNode) {
        if (nameNode) inner.vars.set(nameNode.text, declaredType(typeNode.text));
        ex.typeRefs(typeNode, scope, TYPE_NODES);
      }
      annotationRefs(ex, p, inner);
    }
  }
}

function typeDecl(ex: Ex, node: Node, scope: Scope, kind: SymbolKind): void {
  const nameNode = node.childForFieldName('name');
  const body = node.childForFieldName('body');
  if (!nameNode || scope.local) {
    // local / anonymous classes: not symbols, but their calls belong to the enclosing method
    if (body) ex.visitChildren(body, scope);
    return;
  }
  const mods = modifiersText(node);
  const idx = ex.addSymbol({
    name: nameNode.text,
    kind,
    node,
    scope,
    exported: isApiMember(ex, scope, mods) || (scope.cls === undefined && hasMod(mods, 'public')),
    sigEnd: body ? body.startIndex : node.endIndex,
  });
  const inner = ex.enter(scope, idx, { container: true });
  annotationRefs(ex, node, inner);
  const sup = node.childForFieldName('superclass');
  if (sup) for (const t of sup.namedChildren) inheritRef(ex, t, inner, 'inherit');
  const ifaces = node.childForFieldName('interfaces');
  if (ifaces) for (const t of ifaces.descendantsOfType('type_list')[0]?.namedChildren ?? []) inheritRef(ex, t, inner, kind === 'interface' ? 'inherit' : 'implement');
  for (const c of node.namedChildren) {
    if (c?.type === 'extends_interfaces') for (const t of c.descendantsOfType('type_list')[0]?.namedChildren ?? []) inheritRef(ex, t, inner, 'inherit');
  }
  // record components are fields
  const recParams = node.childForFieldName('parameters');
  if (kind === 'record' && recParams) {
    for (const p of recParams.namedChildren) {
      if (p?.type !== 'formal_parameter') continue;
      const pn = p.childForFieldName('name');
      const pt = p.childForFieldName('type');
      if (!pn) continue;
      ex.addSymbol({ name: pn.text, kind: 'field', node: p, scope: inner, exported: true });
      inner.vars.set(pn.text, declaredType(pt?.text));
      if (pt) ex.typeRefs(pt, inner, TYPE_NODES);
    }
  }
  prescanFields(body, inner.vars);
  if (body) ex.visitChildren(body, inner);
}

function inheritRef(ex: Ex, t: Node | null, scope: Scope, kind: 'inherit' | 'implement'): void {
  if (!t) return;
  const name = baseTypeName(t.text);
  if (name) ex.addRef(scope, name, kind, t);
  // generic arguments are type references too
  const args = t.descendantsOfType('type_arguments')[0];
  if (args) ex.typeRefs(args, scope, TYPE_NODES);
}

function method(ex: Ex, node: Node, scope: Scope, kind: SymbolKind): void {
  const body = node.childForFieldName('body');
  const nameNode = node.childForFieldName('name');
  if (scope.local || !nameNode) {
    if (body) ex.visitChildren(body, scope);
    return;
  }
  const mods = modifiersText(node);
  const idx = ex.addSymbol({
    name: nameNode.text,
    kind,
    node,
    scope,
    exported: isApiMember(ex, scope, mods),
    sigEnd: body ? body.startIndex : node.endIndex,
    body,
  });
  const inner = ex.enter(scope, idx, { local: true });
  annotationRefs(ex, node, inner);
  params(ex, node.childForFieldName('parameters'), inner, inner);
  ex.typeRefs(node.childForFieldName('type'), inner, TYPE_NODES);
  for (const c of node.namedChildren) if (c?.type === 'throws') ex.typeRefs(c, inner, TYPE_NODES);
  if (body) ex.visitChildren(body, inner);
}

function field(ex: Ex, node: Node, scope: Scope): void {
  const typeNode = node.childForFieldName('type');
  const declarators = node.childrenForFieldName('declarator');
  if (scope.local) {
    for (const d of declarators) {
      const n = d?.childForFieldName('name');
      const v = d?.childForFieldName('value');
      // value first: `var x = repo.find(id)` types x from the callee's declared result
      if (v) ex.visit(ex, v, scope);
      if (n) scope.vars.set(n.text, localType(typeNode, v) ?? ex.valueHint(v));
    }
    return;
  }
  const mods = modifiersText(node);
  const constant = node.type === 'constant_declaration' || (hasMod(mods, 'static') && hasMod(mods, 'final'));
  const inInterface = scope.cls !== undefined && ex.symbols[scope.cls].kind === 'interface';
  const exported = isApiMember(ex, scope, mods);
  const typeEnd = typeNode ? typeNode.endIndex : node.startIndex;
  for (const d of declarators) {
    const n = d?.childForFieldName('name');
    if (!d || !n) continue;
    const v = d.childForFieldName('value');
    const sig = ex.signature(node.startIndex, typeEnd) + ' ' + ex.signature(d.startIndex, d.endIndex, v);
    const idx = ex.addSymbol({ name: n.text, kind: constant || inInterface ? 'constant' : 'field', node, scope, exported, sigStart: node.startIndex, sigEnd: node.startIndex });
    ex.symbols[idx].signature = sig.length > 300 ? sig.slice(0, 299) + '…' : sig;
    const inner = ex.enter(scope, idx, { local: true });
    if (typeNode) ex.typeRefs(typeNode, inner, TYPE_NODES);
    annotationRefs(ex, node, inner);
    if (v) ex.visit(ex, v, inner);
  }
}

function localType(typeNode: Node | null, value: Node | null | undefined): string | undefined {
  const t = typeNode ? declaredType(typeNode.text) : undefined;
  if (t) return t;
  // `var x = new Foo()`
  if (value?.type === 'object_creation_expression') return baseTypeName(value.childForFieldName('type')?.text ?? '');
  return undefined;
}

function importDecl(ex: Ex, node: Node, scope: Scope): void {
  const text = node.text.replace(/\s+/g, ' ');
  const m = /^import\s+(static\s+)?([\w.]+)(\.\*)?\s*;?$/.exec(text.replace(/\s*\.\s*/g, '.'));
  if (!m) return;
  const path = m[2];
  ex.addImport(m[3] ? `${path}.*` : path);
  if (m[3]) return;
  const dot = path.lastIndexOf('.');
  if (dot <= 0) return;
  const name = path.slice(dot + 1);
  ex.addRef(scope, name, 'import', node, path.slice(0, dot));
}

export function visitJava(ex: Ex, node: Node, scope: Scope): void {
  const t = node.type;
  switch (t) {
    case 'package_declaration': {
      const id = node.namedChildren.find((c) => c && (c.type === 'scoped_identifier' || c.type === 'identifier'));
      if (id) {
        ex.namespace = id.text.replace(/\s+/g, '');
        scope.q = ex.namespace;
      }
      return;
    }
    case 'import_declaration':
      importDecl(ex, node, scope);
      return;
    case 'class_declaration':
    case 'interface_declaration':
    case 'enum_declaration':
    case 'record_declaration':
    case 'annotation_type_declaration':
      typeDecl(ex, node, scope, TYPE_DECLS[t]);
      return;
    case 'method_declaration':
    case 'annotation_type_element_declaration':
      method(ex, node, scope, 'method');
      return;
    case 'constructor_declaration':
    case 'compact_constructor_declaration':
      method(ex, node, scope, 'constructor');
      return;
    case 'field_declaration':
    case 'constant_declaration':
    case 'local_variable_declaration':
      field(ex, node, scope);
      return;
    case 'enum_constant': {
      const n = node.childForFieldName('name');
      if (!n || scope.local) return;
      const body = node.childForFieldName('body');
      const idx = ex.addSymbol({ name: n.text, kind: 'constant', node, scope, exported: true, sigEnd: body ? body.startIndex : node.endIndex });
      const inner = ex.enter(scope, idx, { local: true });
      const args = node.childForFieldName('arguments');
      if (args) ex.visitChildren(args, inner);
      if (body) ex.visitChildren(body, inner);
      return;
    }
    case 'method_invocation': {
      const n = node.childForFieldName('name');
      const obj = node.childForFieldName('object');
      const ref = n ? ex.addRef(scope, n.text, 'call', n, obj?.text, ex.receiverHint(obj?.text, scope)) : undefined;
      ex.noteCall(node, ref);
      if (obj) {
        ex.visit(ex, obj, scope);
        ex.chainHint(ref, obj);
      }
      const args = node.childForFieldName('arguments');
      if (args) ex.visitChildren(args, scope);
      return;
    }
    case 'object_creation_expression': {
      const typeNode = node.childForFieldName('type');
      const name = typeNode ? baseTypeName(typeNode.text) : undefined;
      if (name && typeNode) ex.noteCall(node, ex.addRef(scope, name, 'new', typeNode));
      const args = node.childForFieldName('arguments');
      if (args) ex.visitChildren(args, scope);
      for (const c of node.namedChildren) if (c?.type === 'class_body') ex.visitChildren(c, { ...scope, local: true });
      return;
    }
    case 'method_reference': {
      const kids = node.namedChildren;
      const last = kids[kids.length - 1];
      if (kids.length >= 2 && last && last.type === 'identifier') {
        const q = kids[0]!.text;
        ex.addRef(scope, last.text, 'call', last, q, ex.receiverHint(q, scope));
      }
      return;
    }
    case 'field_access': {
      // `obj.field`, `this.x = v`; a capitalized member (`Outer.Inner`, `java.util.List`) names a type, not a field
      const f = node.childForFieldName('field');
      const o = node.childForFieldName('object');
      ex.memberRef(scope, node, f && isUpperStart(f.text) && !isConstName(f.text) ? null : f, o);
      return;
    }
    case 'enhanced_for_statement': {
      const ty = node.childForFieldName('type');
      const n = node.childForFieldName('name');
      if (ty && n) scope.vars.set(n.text, declaredType(ty.text));
      ex.visitChildren(node, scope);
      return;
    }
    case 'marker_annotation':
    case 'annotation': {
      const n = node.childForFieldName('name');
      const name = n ? baseTypeName(n.text) : undefined;
      if (name && n && isUpperStart(name)) ex.addRef(scope, name, 'type_ref', n);
      const args = node.childForFieldName('arguments');
      if (args) ex.visitChildren(args, scope);
      return;
    }
    case 'identifier':
    case 'type_identifier':
    case 'string_literal':
    case 'line_comment':
    case 'block_comment':
    case 'decimal_integer_literal':
    case 'modifiers':
      return;
    default:
      ex.visitChildren(node, scope);
  }
}
