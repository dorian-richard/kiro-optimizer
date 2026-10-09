// Best-effort extraction for Rust, PHP, Ruby and Scala: declarations, calls, inheritance, imports.
import type { Node } from 'web-tree-sitter';
import { baseTypeName, Ex, isConstName, isUpperStart, type Scope } from '../extract.js';
import type { SymbolKind } from '../../core/types.js';

function child(node: Node, type: string): Node | null {
  for (const c of node.namedChildren) if (c?.type === type) return c;
  return null;
}

function decl(
  ex: Ex,
  node: Node,
  scope: Scope,
  name: string | undefined,
  kind: SymbolKind,
  exported: boolean,
  body: Node | null,
  opts: { container?: boolean; qname?: string; termsBody?: boolean } = {},
): Scope | undefined {
  if (!name || scope.local) {
    if (body) ex.visitChildren(body, { ...scope, local: true });
    return undefined;
  }
  const idx = ex.addSymbol({
    name,
    kind,
    node,
    scope,
    exported,
    sigEnd: body ? body.startIndex : node.endIndex,
    body: opts.termsBody === false || opts.container ? null : body,
    qname: opts.qname,
  });
  return ex.enter(scope, idx, { container: opts.container });
}

// ------------------------------------------------------------------------------------------- Rust

const implScopes = new WeakSet<Scope>();

function rustPub(node: Node): boolean {
  return !!child(node, 'visibility_modifier');
}

export function visitRust(ex: Ex, node: Node, scope: Scope): void {
  const t = node.type;
  switch (t) {
    case 'use_declaration': {
      const arg = node.childForFieldName('argument');
      if (!arg) return;
      const text = arg.text.replace(/\s+/g, '');
      const brace = text.indexOf('::{');
      const base = brace >= 0 ? text.slice(0, brace) : text.slice(0, Math.max(0, text.lastIndexOf('::')));
      ex.addImport(base || text);
      const names = brace >= 0 ? text.slice(brace + 3, -1).split(',') : [text.slice(text.lastIndexOf('::') + 2)];
      for (const raw of names) {
        const [orig, alias] = raw.split(' as ').map((s) => s.trim());
        const nm = orig?.split('::').pop();
        if (!nm || nm === '*' || nm === 'self') continue;
        ex.addRef(scope, nm, 'import', arg, base);
        if (alias) ex.importAlias.set(alias, { name: nm, spec: base });
      }
      return;
    }
    case 'struct_item':
    case 'union_item':
    case 'enum_item':
    case 'trait_item': {
      const n = node.childForFieldName('name');
      const body = node.childForFieldName('body');
      const kind: SymbolKind = t === 'enum_item' ? 'enum' : t === 'trait_item' ? 'trait' : 'struct';
      const inner = decl(ex, node, scope, n?.text, kind, rustPub(node), body, { container: true });
      if (!inner || !body) return;
      for (const m of body.namedChildren) {
        if (!m) continue;
        if (m.type === 'field_declaration') {
          const fn = m.childForFieldName('name');
          if (fn) ex.addSymbol({ name: fn.text, kind: 'field', node: m, scope: inner, exported: rustPub(m) });
          inner.vars.set(fn?.text ?? '', baseTypeName(m.childForFieldName('type')?.text ?? ''));
        } else if (m.type === 'enum_variant') {
          const vn = m.childForFieldName('name');
          if (vn) ex.addSymbol({ name: vn.text, kind: 'constant', node: m, scope: inner, exported: rustPub(node) });
        } else ex.visit(ex, m, { ...inner, exported: kind === 'trait' ? rustPub(node) : inner.exported });
      }
      return;
    }
    case 'impl_item': {
      const ty = node.childForFieldName('type');
      const tn = ty ? baseTypeName(ty.text) : undefined;
      const trait = node.childForFieldName('trait');
      const owner = tn ? ex.symbols.findIndex((s) => s.name === tn && s.parent === undefined && (s.kind === 'struct' || s.kind === 'enum')) : -1;
      const ownerScope: Scope = owner >= 0
        ? { ...ex.enter(scope, owner, { container: true, vars: ex.classVars.get(owner) }), exported: !!trait || ex.symbols[owner].exported }
        : { ...scope, q: tn ? (scope.q ? `${scope.q}.${tn}` : tn) : scope.q, exported: !!trait };
      implScopes.add(ownerScope);
      if (trait && tn) {
        const trn = baseTypeName(trait.text);
        if (trn) ex.addRef(ownerScope, trn, 'implement', trait);
      }
      const body = node.childForFieldName('body');
      if (body) ex.visitChildren(body, ownerScope);
      return;
    }
    case 'mod_item': {
      const n = node.childForFieldName('name');
      const body = node.childForFieldName('body');
      const inner = decl(ex, node, scope, n?.text, 'module', rustPub(node), body, { container: true });
      if (inner && body) ex.visitChildren(body, inner);
      return;
    }
    case 'function_item':
    case 'function_signature_item': {
      const n = node.childForFieldName('name');
      const body = node.childForFieldName('body');
      const inImpl = implScopes.has(scope) || (scope.cls !== undefined && ex.symbols[scope.cls].kind === 'trait');
      const inner = decl(ex, node, scope, n?.text, inImpl ? 'method' : 'function', rustPub(node) || scope.exported, body);
      if (!inner) return;
      for (const p of node.childForFieldName('parameters')?.namedChildren ?? []) {
        if (p?.type !== 'parameter') continue;
        const pat = p.childForFieldName('pattern');
        if (pat?.type === 'identifier') inner.vars.set(pat.text, baseTypeName(p.childForFieldName('type')?.text ?? ''));
        ex.typeRefs(p.childForFieldName('type'), inner, ['type_identifier']);
      }
      ex.typeRefs(node.childForFieldName('return_type'), inner, ['type_identifier']);
      if (body) ex.visitChildren(body, inner);
      return;
    }
    case 'const_item':
    case 'static_item': {
      const n = node.childForFieldName('name');
      if (n && !scope.local) ex.addSymbol({ name: n.text, kind: 'constant', node, scope, exported: rustPub(node), value: node.childForFieldName('value') });
      const v = node.childForFieldName('value');
      if (v) ex.visit(ex, v, scope);
      return;
    }
    case 'type_item': {
      const n = node.childForFieldName('name');
      if (n && !scope.local) ex.addSymbol({ name: n.text, kind: 'type', node, scope, exported: rustPub(node) });
      return;
    }
    case 'let_declaration': {
      const pat = node.childForFieldName('pattern');
      const ty = node.childForFieldName('type');
      if (pat?.type === 'identifier') scope.vars.set(pat.text, baseTypeName(ty?.text ?? ''));
      const v = node.childForFieldName('value');
      if (v) ex.visit(ex, v, scope);
      return;
    }
    case 'call_expression': {
      const f = node.childForFieldName('function');
      if (f?.type === 'identifier') ex.addRef(scope, ex.dealias(f.text), 'call', f);
      else if (f?.type === 'scoped_identifier') {
        const n = f.childForFieldName('name');
        const p = f.childForFieldName('path');
        if (n) ex.addRef(scope, n.text, 'call', n, p?.text, p && isUpperStart(baseTypeName(p.text) ?? '') ? `T:${baseTypeName(p.text)}` : undefined);
      } else if (f?.type === 'field_expression') {
        const n = f.childForFieldName('field');
        const v = f.childForFieldName('value');
        if (n) ex.addRef(scope, n.text, 'call', n, v?.text, ex.receiverHint(v?.text, scope));
        if (v) ex.visit(ex, v, scope);
      } else if (f) ex.visit(ex, f, scope);
      const args = node.childForFieldName('arguments');
      if (args) ex.visitChildren(args, scope);
      return;
    }
    case 'struct_expression': {
      const n = node.childForFieldName('name');
      const name = n ? baseTypeName(n.text) : undefined;
      if (n && name) ex.addRef(scope, name, 'new', n);
      const body = node.childForFieldName('body');
      if (body) ex.visitChildren(body, scope);
      return;
    }
    case 'macro_invocation':
    case 'line_comment':
    case 'block_comment':
    case 'string_literal':
    case 'identifier':
      return;
    case 'closure_expression':
      ex.visitChildren(node, { ...scope, local: true });
      return;
    default:
      ex.visitChildren(node, scope);
  }
}

// -------------------------------------------------------------------------------------------- PHP

function phpVisible(node: Node): boolean {
  const v = child(node, 'visibility_modifier');
  return !v || v.text !== 'private';
}

function phpName(node: Node | null): string | undefined {
  return node?.text.replace(/^\\/, '');
}

export function visitPhp(ex: Ex, node: Node, scope: Scope): void {
  const t = node.type;
  switch (t) {
    case 'namespace_definition': {
      const n = node.childForFieldName('name');
      const body = node.childForFieldName('body');
      const ns = n?.text ?? '';
      if (!ex.namespace && ns) ex.namespace = ns;
      const q = ns.replace(/\\/g, '.');
      if (body) ex.visitChildren(body, { ...scope, q });
      else scope.q = q;
      return;
    }
    case 'namespace_use_declaration': {
      for (const c of node.descendantsOfType('namespace_use_clause')) {
        if (!c) continue;
        const qn = c.namedChildren.find((x) => x && (x.type === 'qualified_name' || x.type === 'name'));
        if (!qn) continue;
        const full = phpName(qn)!;
        ex.addImport(full);
        const parts = full.split('\\');
        const name = parts.pop()!;
        ex.addRef(scope, name, 'import', qn, parts.join('\\'));
        const alias = c.namedChildren.find((x) => x?.type === 'namespace_aliasing_clause')?.namedChildren[0];
        if (alias) ex.importAlias.set(alias.text, { name, spec: full });
      }
      return;
    }
    case 'class_declaration':
    case 'interface_declaration':
    case 'trait_declaration':
    case 'enum_declaration': {
      const n = node.childForFieldName('name');
      const body = node.childForFieldName('body');
      const kind: SymbolKind = t === 'interface_declaration' ? 'interface' : t === 'trait_declaration' ? 'trait' : t === 'enum_declaration' ? 'enum' : 'class';
      const inner = decl(ex, node, scope, n?.text, kind, true, body, { container: true });
      if (!inner) return;
      for (const c of node.namedChildren) {
        if (c?.type === 'base_clause' || c?.type === 'class_interface_clause') {
          for (const b of c.namedChildren) {
            const bn = b ? baseTypeName(phpName(b) ?? '') : undefined;
            if (b && bn) ex.addRef(inner, bn, c.type === 'base_clause' && kind !== 'interface' ? 'inherit' : kind === 'interface' ? 'inherit' : 'implement', b);
          }
        }
      }
      for (const m of body?.namedChildren ?? []) {
        if (m?.type !== 'property_declaration') continue;
        const ty = m.childForFieldName('type');
        for (const el of m.descendantsOfType('property_element')) {
          const vn = el?.descendantsOfType('name')[0];
          if (vn) inner.vars.set(vn.text, baseTypeName(ty?.text ?? ''));
        }
      }
      if (body) ex.visitChildren(body, inner);
      return;
    }
    case 'method_declaration':
    case 'function_definition': {
      const n = node.childForFieldName('name');
      const body = node.childForFieldName('body');
      const inClass = scope.cls !== undefined;
      const kind: SymbolKind = !inClass ? 'function' : n?.text === '__construct' ? 'constructor' : 'method';
      const inner = decl(ex, node, scope, n?.text, kind, phpVisible(node), body);
      if (!inner) return;
      for (const p of node.childForFieldName('parameters')?.namedChildren ?? []) {
        if (!p) continue;
        const pn = p.childForFieldName('name')?.text.replace(/^\$/, '');
        const ty = p.childForFieldName('type');
        if (pn) inner.vars.set(pn, baseTypeName(ty?.text ?? ''));
        if (ty) ex.typeRefs(ty, inner, ['name'], { upperOnly: true });
        // promoted constructor properties
        if (kind === 'constructor' && pn && child(p, 'visibility_modifier') && scope.cls !== undefined) {
          ex.classVars.get(scope.cls)?.set(pn, baseTypeName(ty?.text ?? ''));
        }
      }
      if (body) ex.visitChildren(body, inner);
      return;
    }
    case 'property_declaration': {
      if (scope.local) return;
      for (const el of node.descendantsOfType('property_element')) {
        const vn = el?.descendantsOfType('name')[0];
        if (vn) ex.addSymbol({ name: vn.text, kind: 'field', node, scope, exported: phpVisible(node) });
      }
      return;
    }
    case 'const_declaration': {
      if (scope.local) return;
      for (const el of node.namedChildren) {
        if (el?.type !== 'const_element') continue;
        const n = child(el, 'name');
        if (n) ex.addSymbol({ name: n.text, kind: 'constant', node, scope, exported: phpVisible(node) });
      }
      return;
    }
    case 'use_declaration': {
      // trait use inside a class
      for (const c of node.namedChildren) {
        const n = c ? baseTypeName(phpName(c) ?? '') : undefined;
        if (c && n) ex.addRef(scope, n, 'inherit', c);
      }
      return;
    }
    case 'function_call_expression': {
      const f = node.childForFieldName('function');
      const name = f && (f.type === 'name' || f.type === 'qualified_name') ? baseTypeName(phpName(f) ?? '') : undefined;
      if (f && name) ex.addRef(scope, ex.dealias(name), 'call', f);
      const args = node.childForFieldName('arguments');
      if (args) ex.visitChildren(args, scope);
      return;
    }
    case 'member_call_expression':
    case 'nullsafe_member_call_expression':
    case 'scoped_call_expression': {
      const n = node.childForFieldName('name');
      const obj = node.childForFieldName('object') ?? node.childForFieldName('scope');
      if (n) {
        const q = obj?.text;
        const hint = t === 'scoped_call_expression' && q && /^[A-Z]/.test(q) ? `T:${baseTypeName(q)}` : ex.receiverHint(q, scope);
        ex.addRef(scope, n.text, 'call', n, q, hint);
      }
      if (obj) ex.visit(ex, obj, scope);
      const args = node.childForFieldName('arguments');
      if (args) ex.visitChildren(args, scope);
      return;
    }
    case 'object_creation_expression': {
      const n = node.namedChildren.find((c) => c && (c.type === 'name' || c.type === 'qualified_name'));
      const name = n ? baseTypeName(phpName(n) ?? '') : undefined;
      if (n && name) ex.addRef(scope, ex.dealias(name), 'new', n);
      for (const c of node.namedChildren) if (c?.type === 'arguments') ex.visitChildren(c, scope);
      return;
    }
    case 'comment':
    case 'string':
    case 'encapsed_string':
    case 'text':
    case 'name':
      return;
    case 'anonymous_function_creation_expression':
    case 'arrow_function':
      ex.visitChildren(node, { ...scope, local: true });
      return;
    default:
      ex.visitChildren(node, scope);
  }
}

// ------------------------------------------------------------------------------------------- Ruby

export function visitRuby(ex: Ex, node: Node, scope: Scope): void {
  const t = node.type;
  switch (t) {
    case 'module':
    case 'class': {
      const n = node.childForFieldName('name');
      const body = node.childForFieldName('body');
      const name = n?.text.split('::').pop();
      const inner = decl(ex, node, scope, name, t === 'module' ? 'module' : 'class', true, body, { container: true });
      if (!inner) return;
      const sup = node.childForFieldName('superclass');
      const sn = sup?.namedChildren[0];
      if (sn) ex.addRef(inner, sn.text.split('::').pop()!, 'inherit', sn, sn.text.includes('::') ? sn.text.split('::').slice(0, -1).join('::') : undefined);
      if (body) ex.visitChildren(body, inner);
      return;
    }
    case 'method':
    case 'singleton_method': {
      const n = node.childForFieldName('name');
      const body = node.childForFieldName('body') ?? child(node, 'body_statement');
      const inClass = scope.cls !== undefined;
      const inner = decl(ex, node, scope, n?.text, inClass ? 'method' : 'function', !n?.text.startsWith('_'), body);
      if (inner && body) ex.visitChildren(body, inner);
      return;
    }
    case 'assignment': {
      const left = node.childForFieldName('left');
      const right = node.childForFieldName('right');
      if (left?.type === 'constant' && !scope.local) {
        const idx = ex.addSymbol({ name: left.text, kind: 'constant', node, scope, exported: true, value: right });
        if (right) ex.visit(ex, right, ex.enter(scope, idx, { local: true }));
        return;
      }
      if (left?.type === 'identifier' && right?.type === 'call') {
        const recv = right.childForFieldName('receiver');
        if (right.childForFieldName('method')?.text === 'new' && recv?.type === 'constant') scope.vars.set(left.text, recv.text);
      }
      if (right) ex.visit(ex, right, scope);
      return;
    }
    case 'call': {
      const m = node.childForFieldName('method');
      const recv = node.childForFieldName('receiver');
      const args = node.childForFieldName('arguments');
      const name = m?.text;
      if (m && name) {
        if (!recv && (name === 'require' || name === 'require_relative' || name === 'load')) {
          const s = args?.namedChildren[0];
          if (s?.type === 'string') ex.addImport((name === 'require_relative' ? './' : '') + s.text.slice(1, -1));
          return;
        }
        if (!recv && (name === 'include' || name === 'extend' || name === 'prepend') && scope.cls !== undefined) {
          for (const a of args?.namedChildren ?? []) if (a?.type === 'constant' || a?.type === 'scope_resolution') ex.addRef(scope, a.text.split('::').pop()!, 'inherit', a);
          return;
        }
        if (name === 'new' && recv && (recv.type === 'constant' || recv.type === 'scope_resolution')) {
          ex.addRef(scope, recv.text.split('::').pop()!, 'new', recv);
        } else {
          const q = recv?.text;
          ex.addRef(scope, name, 'call', m, q, recv?.type === 'constant' ? `T:${q}` : ex.receiverHint(q, scope));
        }
      }
      if (recv) ex.visit(ex, recv, scope);
      if (args) ex.visitChildren(args, scope);
      const block = node.childForFieldName('block');
      if (block) ex.visitChildren(block, scope);
      return;
    }
    case 'comment':
    case 'string':
    case 'identifier':
    case 'constant':
      return;
    default:
      ex.visitChildren(node, scope);
  }
}

// ------------------------------------------------------------------------------------------ Scala

function scalaVisible(node: Node): boolean {
  const mods = child(node, 'modifiers');
  return !mods || !/\bprivate\b/.test(mods.text);
}

export function visitScala(ex: Ex, node: Node, scope: Scope): void {
  const t = node.type;
  switch (t) {
    case 'package_clause': {
      const n = node.childForFieldName('name');
      if (n) {
        ex.namespace = n.text.replace(/\s+/g, '');
        scope.q = ex.namespace;
      }
      const body = node.childForFieldName('body');
      if (body) ex.visitChildren(body, scope);
      return;
    }
    case 'import_declaration': {
      const path = node.childForFieldName('path')?.text.replace(/\s+/g, '');
      if (!path) return;
      const rest = node.text.slice(node.text.indexOf(path) + path.length).trim();
      if (rest.startsWith('.{') || rest.startsWith('{')) {
        ex.addImport(path);
        for (const s of rest.replace(/^\.?\{|\}$/g, '').split(',')) {
          const nm = s.split('=>')[0].trim();
          if (nm && nm !== '_') ex.addRef(scope, nm, 'import', node, path);
        }
      } else if (rest.startsWith('._') || rest.startsWith('.*')) {
        ex.addImport(`${path}.*`);
      } else {
        ex.addImport(path);
        const dot = path.lastIndexOf('.');
        if (dot > 0) ex.addRef(scope, path.slice(dot + 1), 'import', node, path.slice(0, dot));
      }
      return;
    }
    case 'class_definition':
    case 'object_definition':
    case 'trait_definition':
    case 'enum_definition': {
      const n = node.childForFieldName('name');
      const body = node.childForFieldName('body');
      const kind: SymbolKind = t === 'trait_definition' ? 'trait' : t === 'enum_definition' ? 'enum' : 'class';
      const inner = decl(ex, node, scope, n?.text, kind, scalaVisible(node), body, { container: true });
      if (!inner) return;
      const ext = node.childForFieldName('extend');
      if (ext) {
        let first = true;
        for (const ty of ext.descendantsOfType(['type_identifier'])) {
          if (!ty || ty.parent?.type === 'type_arguments') continue;
          ex.addRef(inner, ty.text, first && kind !== 'trait' ? 'inherit' : 'implement', ty);
          first = false;
        }
        for (const a of ext.descendantsOfType('arguments')) if (a) ex.visitChildren(a, inner);
      }
      for (const p of node.childForFieldName('class_parameters')?.namedChildren ?? []) {
        if (p?.type !== 'class_parameter') continue;
        const pn = p.childForFieldName('name');
        const pt = p.childForFieldName('type');
        if (pn) inner.vars.set(pn.text, baseTypeName(pt?.text ?? ''));
        ex.typeRefs(pt, inner, ['type_identifier']);
      }
      if (body) ex.visitChildren(body, inner);
      return;
    }
    case 'function_definition':
    case 'function_declaration': {
      const n = node.childForFieldName('name');
      const body = node.childForFieldName('body');
      const inClass = scope.cls !== undefined;
      const inner = decl(ex, node, scope, n?.text, inClass ? 'method' : 'function', scalaVisible(node), body);
      if (!inner) return;
      for (const ps of node.namedChildren) {
        if (ps?.type !== 'parameters') continue;
        for (const p of ps.namedChildren) {
          if (p?.type !== 'parameter') continue;
          const pn = p.childForFieldName('name');
          const pt = p.childForFieldName('type');
          if (pn) inner.vars.set(pn.text, baseTypeName(pt?.text ?? ''));
          ex.typeRefs(pt, inner, ['type_identifier']);
        }
      }
      ex.typeRefs(node.childForFieldName('return_type'), inner, ['type_identifier']);
      if (body) ex.visit(ex, body, inner);
      return;
    }
    case 'val_definition':
    case 'var_definition':
    case 'val_declaration':
    case 'var_declaration': {
      const pat = node.childForFieldName('pattern') ?? node.childForFieldName('name');
      const ty = node.childForFieldName('type');
      const v = node.childForFieldName('value');
      if (pat?.type === 'identifier') {
        scope.vars.set(pat.text, baseTypeName(ty?.text ?? '') ?? (v?.type === 'instance_expression' ? baseTypeName(v.namedChildren[0]?.text ?? '') : undefined));
        if (!scope.local) {
          const inClass = scope.cls !== undefined;
          ex.addSymbol({ name: pat.text, kind: inClass && !isConstName(pat.text) ? 'property' : 'constant', node, scope, exported: scalaVisible(node), value: v });
        }
      }
      if (v) ex.visit(ex, v, scope);
      return;
    }
    case 'call_expression': {
      const f = node.childForFieldName('function');
      if (f?.type === 'identifier') {
        const name = ex.dealias(f.text);
        ex.addRef(scope, name, isUpperStart(name) ? 'new' : 'call', f);
      } else if (f?.type === 'field_expression') {
        const n = f.childForFieldName('field');
        const v = f.childForFieldName('value');
        if (n) ex.addRef(scope, n.text, 'call', n, v?.text, ex.receiverHint(v?.text, scope));
        if (v) ex.visit(ex, v, scope);
      } else if (f) ex.visit(ex, f, scope);
      const args = node.childForFieldName('arguments');
      if (args) ex.visitChildren(args, scope);
      return;
    }
    case 'instance_expression': {
      const ty = node.namedChildren[0];
      const name = ty ? baseTypeName(ty.text) : undefined;
      if (ty && name) ex.addRef(scope, name, 'new', ty);
      for (const c of node.namedChildren.slice(1)) if (c) ex.visit(ex, c, scope);
      return;
    }
    case 'comment':
    case 'string':
    case 'identifier':
      return;
    case 'lambda_expression':
      ex.visitChildren(node, { ...scope, local: true });
      return;
    default:
      ex.visitChildren(node, scope);
  }
}
