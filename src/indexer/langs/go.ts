import type { Node } from 'web-tree-sitter';
import { baseTypeName, Ex, isUpperStart, type Scope } from '../extract.js';

const LEAVES = new Set([
  'identifier', 'field_identifier', 'type_identifier', 'package_identifier', 'comment', 'interpreted_string_literal',
  'raw_string_literal', 'int_literal', 'float_literal', 'true', 'false', 'nil', 'rune_literal',
]);

const exportedName = (name: string) => isUpperStart(name);

/** Type refs from a Go type expression; `pkg.Type` carries the package as qualifier + module hint. */
function typeRefs(ex: Ex, node: Node | null | undefined, scope: Scope): void {
  if (!node) return;
  const nodes = node.type === 'type_identifier' || node.type === 'qualified_type' ? [node] : node.descendantsOfType(['type_identifier', 'qualified_type']);
  for (const n of nodes) {
    if (!n) continue;
    if (n.type === 'qualified_type') {
      const pkg = n.childForFieldName('package')?.text;
      const name = n.childForFieldName('name')?.text;
      if (name) ex.addRef(scope, name, 'type_ref', n, pkg, pkg ? ex.receiverHint(pkg, scope) : undefined);
    } else if (n.parent?.type !== 'qualified_type') {
      const name = n.text;
      if (baseTypeName(name)) ex.addRef(scope, name, 'type_ref', n);
    }
  }
}

function typeName(node: Node | null | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === 'pointer_type') return typeName(node.namedChildren[0]);
  if (node.type === 'generic_type') return typeName(node.childForFieldName('type') ?? node.namedChildren[0]);
  if (node.type === 'qualified_type') return node.childForFieldName('name')?.text;
  if (node.type === 'type_identifier') return node.text;
  return undefined;
}

function params(ex: Ex, list: Node | null, inner: Scope): void {
  for (const p of list?.namedChildren ?? []) {
    if (p?.type !== 'parameter_declaration' && p?.type !== 'variadic_parameter_declaration') continue;
    const ty = p.childForFieldName('type');
    const t = typeName(ty);
    for (const n of p.childrenForFieldName('name')) if (n) inner.vars.set(n.text, t);
    typeRefs(ex, ty, inner);
  }
}

function func(ex: Ex, node: Node, scope: Scope): void {
  const n = node.childForFieldName('name');
  const body = node.childForFieldName('body');
  if (!n) return;
  let qname: string | undefined;
  let recvType: string | undefined;
  const recv = node.childForFieldName('receiver');
  if (recv) {
    const p = recv.namedChildren.find((c) => c?.type === 'parameter_declaration');
    recvType = typeName(p?.childForFieldName('type'));
    if (recvType) qname = `${scope.q ? scope.q + '.' : ''}${recvType}.${n.text}`;
  }
  const idx = ex.addSymbol({
    name: n.text,
    kind: recv ? 'method' : 'function',
    node,
    scope,
    exported: exportedName(n.text),
    sigEnd: body ? body.startIndex : node.endIndex,
    body,
    qname,
  });
  const inner = ex.enter(scope, idx, { local: true });
  if (recv) {
    const p = recv.namedChildren.find((c) => c?.type === 'parameter_declaration');
    const rn = p?.childForFieldName('name');
    if (rn && recvType) inner.vars.set(rn.text, recvType);
    if (recvType) receivers.get(ex)?.push([idx, recvType]) ?? receivers.set(ex, [[idx, recvType]]);
  }
  params(ex, node.childForFieldName('parameters'), inner);
  typeRefs(ex, node.childForFieldName('result'), inner);
  if (body) ex.visitChildren(body, inner);
}

const receivers = new WeakMap<Ex, Array<[number, string]>>();

function typeSpec(ex: Ex, spec: Node, outer: Node, scope: Scope, single: boolean): void {
  const n = spec.childForFieldName('name');
  const ty = spec.childForFieldName('type');
  if (!n || scope.local) return;
  const kind = ty?.type === 'struct_type' ? 'struct' : ty?.type === 'interface_type' ? 'interface' : 'type';
  const bodyNode = ty?.type === 'struct_type' ? ty.namedChildren.find((c) => c?.type === 'field_declaration_list') ?? null : ty?.type === 'interface_type' ? ty : null;
  const node = single ? outer : spec;
  const idx = ex.addSymbol({
    name: n.text,
    kind,
    node,
    scope,
    exported: exportedName(n.text),
    sigStart: node.startIndex,
    sigEnd: bodyNode ? (kind === 'interface' ? bodyNode.startIndex + 'interface'.length : bodyNode.startIndex) : spec.endIndex,
    sigPrefix: single ? undefined : 'type ',
  });
  const inner = ex.enter(scope, idx, { container: kind !== 'type' });
  if (kind === 'struct' && bodyNode) {
    for (const f of bodyNode.namedChildren) {
      if (f?.type !== 'field_declaration') continue;
      const fty = f.childForFieldName('type');
      const names = f.childrenForFieldName('name').filter((x): x is Node => !!x);
      if (!names.length) {
        // embedded struct: Go's inheritance
        const en = typeName(fty);
        if (en && fty) ex.addRef(inner, en, 'inherit', fty, fty.type === 'qualified_type' ? fty.childForFieldName('package')?.text : undefined);
        continue;
      }
      const t = typeName(fty);
      for (const fnode of names) {
        const fidx = ex.addSymbol({ name: fnode.text, kind: 'field', node: f, scope: inner, exported: exportedName(fnode.text) });
        inner.vars.set(fnode.text, t);
        typeRefs(ex, fty, ex.enter(inner, fidx, { local: true }));
      }
    }
  } else if (kind === 'interface' && bodyNode) {
    for (const m of bodyNode.namedChildren) {
      if (!m) continue;
      if (m.type === 'method_spec' || m.type === 'method_elem') {
        const mn = m.childForFieldName('name');
        if (!mn) continue;
        const midx = ex.addSymbol({ name: mn.text, kind: 'method', node: m, scope: inner, exported: exportedName(mn.text) });
        const mi = ex.enter(inner, midx, { local: true });
        params(ex, m.childForFieldName('parameters'), mi);
        typeRefs(ex, m.childForFieldName('result'), mi);
      } else if (m.type === 'type_identifier' || m.type === 'qualified_type' || m.type === 'constraint_elem' || m.type === 'type_elem') {
        const en = typeName(m.type === 'constraint_elem' || m.type === 'type_elem' ? m.namedChildren[0] : m);
        if (en) ex.addRef(inner, en, 'inherit', m);
      }
    }
  } else {
    typeRefs(ex, ty, inner);
  }
}

function valueSpecs(ex: Ex, node: Node, scope: Scope, kind: 'const' | 'var'): void {
  const specs = node.namedChildren.filter((c): c is Node => !!c && (c.type === 'const_spec' || c.type === 'var_spec'));
  for (const spec of specs) {
    const ty = spec.childForFieldName('type');
    const value = spec.childForFieldName('value');
    const t = typeName(ty) ?? compositeType(value?.namedChildren[0]);
    for (const n of spec.childrenForFieldName('name')) {
      if (!n) continue;
      scope.vars.set(n.text, t);
      if (scope.local || n.text === '_') continue;
      const one = specs.length === 1 && spec.childrenForFieldName('name').length === 1;
      const idx = ex.addSymbol({
        name: n.text,
        kind: 'constant',
        node: one ? node : spec,
        scope,
        exported: exportedName(n.text),
        value,
        sigPrefix: one ? undefined : `${kind} `,
      });
      const inner = ex.enter(scope, idx, { local: true });
      typeRefs(ex, ty, inner);
      if (value) ex.visit(ex, value, inner);
    }
    if (scope.local && value) ex.visit(ex, value, scope);
  }
}

function compositeType(v: Node | null | undefined): string | undefined {
  if (!v) return undefined;
  if (v.type === 'unary_expression') return compositeType(v.childForFieldName('operand'));
  if (v.type === 'composite_literal') return typeName(v.childForFieldName('type'));
  return undefined;
}

export function visitGo(ex: Ex, node: Node, scope: Scope): void {
  const t = node.type;
  if (LEAVES.has(t)) return;
  switch (t) {
    case 'package_clause': {
      const n = node.namedChildren.find((c) => c?.type === 'package_identifier');
      if (n) {
        ex.namespace = n.text;
        scope.q = n.text;
      }
      return;
    }
    case 'import_declaration': {
      for (const s of node.descendantsOfType('import_spec')) {
        if (!s) continue;
        const p = s.childForFieldName('path');
        if (!p) continue;
        const spec = p.text.slice(1, -1);
        ex.addImport(spec);
        const alias = s.childForFieldName('name')?.text;
        if (alias === '_' || alias === '.') continue;
        // the local name of an import is its last path segment unless aliased (major-version suffixes skipped)
        const segs = spec.split('/');
        let last = segs[segs.length - 1];
        if (/^v\d+$/.test(last) && segs.length > 1) last = segs[segs.length - 2];
        ex.moduleAlias.set(alias ?? last.replace(/^go-|-go$/g, '').replace(/[-.]/g, '_'), spec);
      }
      return;
    }
    case 'function_declaration':
    case 'method_declaration':
      if (scope.local) return ex.visitChildren(node, scope);
      func(ex, node, scope);
      return;
    case 'type_declaration': {
      const specs = node.namedChildren.filter((c): c is Node => !!c && (c.type === 'type_spec' || c.type === 'type_alias'));
      for (const s of specs) typeSpec(ex, s, node, scope, specs.length === 1);
      return;
    }
    case 'const_declaration':
      valueSpecs(ex, node, scope, 'const');
      return;
    case 'var_declaration':
      valueSpecs(ex, node, scope, 'var');
      return;
    case 'short_var_declaration': {
      const left = node.childForFieldName('left')?.namedChildren ?? [];
      const right = node.childForFieldName('right')?.namedChildren ?? [];
      left.forEach((l, i) => {
        if (l?.type === 'identifier') scope.vars.set(l.text, compositeType(right[i]));
      });
      for (const r of right) if (r) ex.visit(ex, r, scope);
      return;
    }
    case 'call_expression': {
      const f = node.childForFieldName('function');
      if (f?.type === 'identifier') ex.addRef(scope, f.text, 'call', f);
      else if (f?.type === 'selector_expression') {
        const field = f.childForFieldName('field');
        const operand = f.childForFieldName('operand');
        if (field) {
          const q = operand?.text;
          ex.addRef(scope, field.text, 'call', field, q, ex.receiverHint(q, scope));
        }
        if (operand) ex.visit(ex, operand, scope);
      } else if (f) ex.visit(ex, f, scope);
      const args = node.childForFieldName('arguments');
      if (args) ex.visitChildren(args, scope);
      return;
    }
    case 'composite_literal': {
      const ty = node.childForFieldName('type');
      if (ty?.type === 'type_identifier') ex.addRef(scope, ty.text, 'new', ty);
      else if (ty?.type === 'qualified_type') {
        const pkg = ty.childForFieldName('package')?.text;
        const name = ty.childForFieldName('name')?.text;
        if (name) ex.addRef(scope, name, 'new', ty, pkg, pkg ? ex.receiverHint(pkg, scope) : undefined);
      } else if (ty?.type === 'generic_type') {
        const name = typeName(ty);
        if (name) ex.addRef(scope, name, 'new', ty);
      }
      const body = node.childForFieldName('body');
      if (body) ex.visitChildren(body, scope);
      return;
    }
    case 'func_literal': {
      const body = node.childForFieldName('body');
      if (body) ex.visitChildren(body, { ...scope, local: true });
      return;
    }
    default:
      ex.visitChildren(node, scope);
  }
}

/** Methods declared in the same file as their receiver type become its members. */
export function postGo(ex: Ex): void {
  const list = receivers.get(ex);
  if (!list) return;
  const types = new Map<string, number>();
  ex.symbols.forEach((s, i) => {
    if (s.parent === undefined && (s.kind === 'struct' || s.kind === 'interface' || s.kind === 'type')) types.set(s.name, i);
  });
  for (const [idx, recv] of list) {
    const p = types.get(recv);
    if (p !== undefined && ex.symbols[idx].parent === undefined) ex.symbols[idx].parent = p;
  }
}
