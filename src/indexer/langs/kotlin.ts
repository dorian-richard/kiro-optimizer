// Kotlin (fwcd grammar): no field names, so children are found by node type.
import type { Node } from 'web-tree-sitter';
import { baseTypeName, Ex, isConstName, isUpperStart, type Scope } from '../extract.js';
import type { SymbolKind } from '../../core/types.js';

const TYPE_NODES = ['type_identifier'];
const LEAVES = new Set([
  'simple_identifier', 'type_identifier', 'comment', 'multiline_comment', 'line_comment', 'string_literal',
  'integer_literal', 'real_literal', 'boolean_literal', 'null_literal', 'character_literal', 'modifiers',
]);

function child(node: Node, type: string): Node | null {
  for (const c of node.namedChildren) if (c?.type === type) return c;
  return null;
}

function modifiersText(node: Node): string {
  return child(node, 'modifiers')?.text ?? '';
}

function visible(mods: string): boolean {
  return !/\b(private|internal)\b/.test(mods);
}

/** `user_type` / `nullable_type` -> simple name of the outermost type. */
function typeOf(node: Node | null | undefined): string | undefined {
  if (!node) return undefined;
  return baseTypeName(node.text.replace(/\?$/, ''));
}

function annotations(ex: Ex, node: Node, scope: Scope): void {
  const mods = child(node, 'modifiers');
  for (const a of mods?.namedChildren ?? []) {
    if (a?.type !== 'annotation') continue;
    for (const ut of a.descendantsOfType('user_type').slice(0, 1)) {
      const n = ut ? baseTypeName(ut.text) : undefined;
      if (ut && n) ex.addRef(scope, n, 'type_ref', ut);
    }
  }
}

function params(ex: Ex, list: Node | null, inner: Scope): void {
  for (const p of list?.namedChildren ?? []) {
    if (p?.type !== 'parameter' && p?.type !== 'function_value_parameter') continue;
    const param = p.type === 'function_value_parameter' ? child(p, 'parameter') : p;
    if (!param) continue;
    const n = child(param, 'simple_identifier');
    const ty = param.namedChildren.find((c) => c && (c.type === 'user_type' || c.type === 'nullable_type' || c.type === 'function_type')) ?? null;
    if (n) inner.vars.set(n.text, typeOf(ty));
    ex.typeRefs(ty, inner, TYPE_NODES);
  }
}

function bodyOf(node: Node): Node | null {
  for (const c of node.namedChildren) if (c && (c.type === 'class_body' || c.type === 'enum_class_body')) return c;
  return null;
}

function classDecl(ex: Ex, node: Node, scope: Scope): void {
  const nameNode = child(node, 'type_identifier');
  const body = bodyOf(node);
  if (!nameNode || scope.local) {
    if (body) ex.visitChildren(body, { ...scope, local: true });
    return;
  }
  const mods = modifiersText(node);
  let kind: SymbolKind = 'class';
  if (node.type === 'class_declaration') {
    if (node.children.some((c) => c?.type === 'interface')) kind = 'interface';
    else if (/\benum\b/.test(mods)) kind = 'enum';
  }
  const idx = ex.addSymbol({
    name: nameNode.text,
    kind,
    node,
    scope,
    exported: visible(mods) && (scope.cls === undefined || scope.exported),
    sigEnd: body ? body.startIndex : node.endIndex,
  });
  const inner = ex.enter(scope, idx, { container: true });
  annotations(ex, node, inner);
  for (const c of node.namedChildren) {
    if (c?.type !== 'delegation_specifier') continue;
    const ci = child(c, 'constructor_invocation');
    const ut = ci ? child(ci, 'user_type') : child(c, 'user_type') ?? c.descendantsOfType('user_type')[0] ?? null;
    const n = ut ? baseTypeName(ut.text) : undefined;
    if (ut && n) ex.addRef(inner, n, kind === 'interface' ? 'inherit' : ci ? 'inherit' : 'implement', ut);
    if (ci) {
      const args = child(ci, 'value_arguments');
      if (args) ex.visitChildren(args, inner);
    }
  }
  const pc = child(node, 'primary_constructor');
  for (const p of pc?.descendantsOfType('class_parameter') ?? []) {
    if (!p) continue;
    const n = child(p, 'simple_identifier');
    const ty = p.namedChildren.find((c) => c && (c.type === 'user_type' || c.type === 'nullable_type')) ?? null;
    if (!n) continue;
    inner.vars.set(n.text, typeOf(ty));
    ex.typeRefs(ty, inner, TYPE_NODES);
    if (child(p, 'binding_pattern_kind')) {
      ex.addSymbol({ name: n.text, kind: 'property', node: p, scope: inner, exported: visible(modifiersText(p)) && inner.exported });
    }
  }
  if (body) {
    prescan(body, inner);
    ex.visitChildren(body, inner);
  }
}

function prescan(body: Node, scope: Scope): void {
  for (const m of body.namedChildren) {
    if (m?.type !== 'property_declaration') continue;
    const vd = child(m, 'variable_declaration');
    const n = vd ? child(vd, 'simple_identifier') : null;
    const ty = vd?.namedChildren.find((c) => c && (c.type === 'user_type' || c.type === 'nullable_type'));
    if (n) scope.vars.set(n.text, typeOf(ty) ?? ctorCall(m));
  }
}

/** `val x = Foo(...)` -> Foo */
function ctorCall(prop: Node): string | undefined {
  const call = child(prop, 'call_expression');
  const callee = call?.namedChildren[0];
  return callee?.type === 'simple_identifier' && isUpperStart(callee.text) ? callee.text : undefined;
}

function func(ex: Ex, node: Node, scope: Scope): void {
  const nameNode = child(node, 'simple_identifier');
  const body = child(node, 'function_body');
  if (!nameNode || scope.local) {
    if (body) ex.visitChildren(body, { ...scope, local: true });
    return;
  }
  const mods = modifiersText(node);
  const inClass = scope.cls !== undefined;
  const idx = ex.addSymbol({
    name: nameNode.text,
    kind: inClass ? 'method' : 'function',
    node,
    scope,
    exported: visible(mods) && (!inClass || scope.exported),
    sigEnd: body ? body.startIndex : node.endIndex,
    body,
  });
  const inner = ex.enter(scope, idx, { local: true });
  annotations(ex, node, inner);
  params(ex, child(node, 'function_value_parameters'), inner);
  // return type: the type node after the parameter list
  let afterParams = false;
  for (const c of node.namedChildren) {
    if (!c) continue;
    if (c.type === 'function_value_parameters') afterParams = true;
    else if (afterParams && (c.type === 'user_type' || c.type === 'nullable_type')) ex.typeRefs(c, inner, TYPE_NODES);
  }
  if (body) ex.visitChildren(body, inner);
}

function property(ex: Ex, node: Node, scope: Scope): void {
  const vd = child(node, 'variable_declaration');
  const n = vd ? child(vd, 'simple_identifier') : null;
  const ty = vd?.namedChildren.find((c) => c && (c.type === 'user_type' || c.type === 'nullable_type')) ?? null;
  if (scope.local || !n) {
    if (n) scope.vars.set(n.text, typeOf(ty) ?? ctorCall(node));
    for (const c of node.namedChildren) if (c && c !== vd) ex.visit(ex, c, scope);
    return;
  }
  const mods = modifiersText(node);
  const inClass = scope.cls !== undefined;
  const value = node.namedChildren.find((c) => c && c !== vd && c.type !== 'modifiers' && c.type !== 'binding_pattern_kind' && c.type !== 'getter' && c.type !== 'setter') ?? null;
  const kind: SymbolKind = /\bconst\b/.test(mods) || (!inClass && isConstName(n.text)) ? 'constant' : inClass ? 'property' : 'constant';
  const idx = ex.addSymbol({ name: n.text, kind, node, scope, exported: visible(mods) && (!inClass || scope.exported), value });
  const inner = ex.enter(scope, idx, { local: true });
  ex.typeRefs(ty, inner, TYPE_NODES);
  annotations(ex, node, inner);
  for (const c of node.namedChildren) if (c && c !== vd && c.type !== 'modifiers') ex.visit(ex, c, inner);
}

function callExpr(ex: Ex, node: Node, scope: Scope): void {
  const callee = node.namedChildren[0];
  if (!callee) return;
  if (callee.type === 'simple_identifier') {
    const name = ex.dealias(callee.text);
    ex.addRef(scope, name, isUpperStart(name) ? 'new' : 'call', callee);
  } else if (callee.type === 'navigation_expression') {
    const suffix = callee.namedChildren[callee.namedChildCount - 1];
    const recv = callee.namedChildren[0];
    const n = suffix?.type === 'navigation_suffix' ? child(suffix, 'simple_identifier') : null;
    if (n && recv) {
      const q = recv.type === 'this_expression' ? 'this' : recv.type === 'super_expression' ? 'super' : recv.text;
      ex.addRef(scope, n.text, isUpperStart(n.text) && q !== 'this' ? 'new' : 'call', n, q, ex.receiverHint(q, scope));
    }
    if (recv) ex.visit(ex, recv, scope);
  } else ex.visit(ex, callee, scope);
  for (const c of node.namedChildren) if (c && c !== callee) ex.visit(ex, c, scope);
}

export function visitKotlin(ex: Ex, node: Node, scope: Scope): void {
  const t = node.type;
  if (LEAVES.has(t)) return;
  switch (t) {
    case 'package_header': {
      const id = child(node, 'identifier');
      if (id) {
        ex.namespace = id.text.replace(/\s+/g, '');
        scope.q = ex.namespace;
      }
      return;
    }
    case 'import_list':
      for (const h of node.namedChildren) if (h?.type === 'import_header') visitKotlin(ex, h, scope);
      return;
    case 'import_header': {
      const id = child(node, 'identifier');
      if (!id) return;
      const path = id.text.replace(/\s+/g, '');
      const wildcard = node.children.some((c) => c?.type === 'wildcard_import') || /\.\*\s*$/.test(node.text);
      ex.addImport(wildcard ? `${path}.*` : path);
      if (wildcard) return;
      const dot = path.lastIndexOf('.');
      const name = path.slice(dot + 1);
      ex.addRef(scope, name, 'import', id, dot > 0 ? path.slice(0, dot) : undefined);
      const alias = child(node, 'import_alias');
      const an = alias ? child(alias, 'type_identifier') ?? child(alias, 'simple_identifier') : null;
      if (an) ex.importAlias.set(an.text, { name, spec: path });
      return;
    }
    case 'class_declaration':
    case 'object_declaration':
      classDecl(ex, node, scope);
      return;
    case 'companion_object': {
      // members belong to the enclosing class
      const body = bodyOf(node);
      if (body) ex.visitChildren(body, scope);
      return;
    }
    case 'function_declaration':
      func(ex, node, scope);
      return;
    case 'property_declaration':
      property(ex, node, scope);
      return;
    case 'secondary_constructor': {
      if (scope.local || scope.cls === undefined) return ex.visitChildren(node, scope);
      const body = child(node, 'statements') ?? node.namedChildren[node.namedChildCount - 1];
      const idx = ex.addSymbol({
        name: ex.symbols[scope.cls].name,
        kind: 'constructor',
        node,
        scope,
        exported: visible(modifiersText(node)),
        sigEnd: body && body.type !== 'function_value_parameters' ? body.startIndex : node.endIndex,
        body,
      });
      const inner = ex.enter(scope, idx, { local: true });
      params(ex, child(node, 'function_value_parameters'), inner);
      ex.visitChildren(node, inner);
      return;
    }
    case 'call_expression':
      callExpr(ex, node, scope);
      return;
    case 'lambda_literal':
    case 'anonymous_function':
    case 'object_literal':
      ex.visitChildren(node, { ...scope, local: true });
      return;
    default:
      ex.visitChildren(node, scope);
  }
}
