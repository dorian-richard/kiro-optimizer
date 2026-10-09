// Reference + import resolution. Precision over recall: a ref is linked only when one candidate wins at the
// closest scope tier; ambiguity at a tier stops the search (NULL) instead of guessing further away.
//
// Tiers (after receiver-type / module hints and `this`/class-chain lookup):
//   same file > explicitly imported name > imported files > same package/namespace > imported packages
//   > unique global (only for loosely scoped languages, or qualified calls with distinctive names).

import { posix } from 'node:path';
import type { StatementSync } from 'node:sqlite';
import type { Store } from '../store/store.js';
import { pythonModule } from './langs/python.js';

export interface SymInfo {
  id: number;
  file: number;
  parent: number | null;
  kind: string;
  name: string;
  qname: string;
}

interface FileInfo {
  id: number;
  path: string;
  dir: string;
  lang: string;
  ns: string | null;
}

interface RefRow {
  id: number;
  file: number;
  from: number | null;
  name: string;
  qualifier: string | null;
  kind: string;
  hint: string | null;
  to: number | null;
}

interface FileCtx {
  info: FileInfo;
  importTargets: Set<number>;
  /** imported name -> resolved symbol (null = imported from outside the index) */
  importedNames: Map<string, number | null>;
  /** namespaces/packages imported as a whole (wildcards, C# usings, enclosing C# namespaces) */
  importedNs: Set<string>;
}

export interface ResolveScope {
  full: boolean;
  changedFileIds: Set<number>;
  removedSymbolIds: Set<number>;
  changedNames: Set<string>;
  addedFileIds: Set<number>;
  removedFileIds: Set<number>;
}

export interface ResolveStats {
  refsConsidered: number;
  refsResolved: number;
  importsResolved: number;
  durationMs: number;
}

const TYPE_KINDS = new Set(['class', 'interface', 'enum', 'type', 'struct', 'record', 'trait']);
const CONTAINERS = new Set(['class', 'interface', 'enum', 'struct', 'record', 'trait', 'module']);
const CALLABLE = new Set(['function', 'method', 'constructor']);
const NAMESPACE_LIKE = new Set(['namespace', 'module']);
const SELF = new Set(['this', 'self', 'super', 'base', 'cls', '$this', 'Self', 'static', 'parent']);
/** Languages where an unqualified name inside a class can mean a member of that class. */
const IMPLICIT_THIS = new Set(['java', 'c_sharp', 'kotlin', 'scala', 'ruby']);
/** Languages whose unqualified names see the whole package/namespace without imports. */
const NS_SCOPED = new Set(['java', 'kotlin', 'scala', 'c_sharp', 'php']);
const DIR_SCOPED = new Set(['go', 'rust', 'ruby']);
/** Languages where unimported global names can still be visible (global usings, autoload, mixins...). */
const LOOSE = new Set(['c_sharp', 'php', 'ruby', 'rust', 'scala']);
/**
 * Languages whose receivers are rarely typed in source: a distinctive method name that exists once in the
 * repo is then the best (and usually right) guess. Statically typed languages already got their chance
 * through receiver types, so an untyped receiver chain there is left unresolved.
 */
const DUCK_TYPED = new Set(['python', 'javascript', 'typescript', 'tsx', 'ruby', 'php']);
/**
 * Method names too common to link by name alone when the receiver type is unknown: they mostly hit
 * standard-library objects (lists, maps, promises, loggers, streams).
 */
const GENERIC = new Set(
  (
    'get set add put remove delete size length push pop shift unshift append extend insert map filter forEach find reduce ' +
    'toString equals hashCode close open run start stop apply call keys values items update clear contains has join split ' +
    'format read write send next then catch finally emit on off once init create build execute handle process load save ' +
    'parse validate render list count sort copy clone compare compareTo iterator isEmpty of from valueOf name value type ' +
    'log debug info warn error trace print println printf subscribe dispatch resolve reject all any some every includes ' +
    'indexOf slice splice concat replace trim toUpperCase toLowerCase match test exec bind wait notify lock unlock flush ' +
    'reset accept getName getValue getId setName setValue getType getKey setId stream collect orElse isPresent ' +
    'getOrDefault putAll addAll removeAll containsKey entrySet keySet toArray asList strip lower upper encode decode ' +
    'dumps loads dump json text group fetch post patch head first last min max sum abs round floor ceil ' +
    'Println Printf Sprintf Errorf New Close Error String Len Write Read Get Set Add Run Start Stop'
  ).split(' '),
);

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

function stemOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.indexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function stripExt(path: string): string {
  return path.replace(/\.(d\.ts|tsx?|mts|cts|jsx?|mjs|cjs|pyi?|rb)$/, '');
}

const TS_EXTS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];

/** Data access with caches; `preload()` bulk-fills them for full passes. */
class Graph {
  readonly files = new Map<number, FileInfo>();
  readonly byPath = new Map<string, number>();
  private readonly byStem = new Map<string, number[]>();
  private readonly byDir = new Map<string, number[]>();
  private pyModules?: Map<string, number>;
  private readonly names = new Map<string, SymInfo[]>();
  private readonly syms = new Map<number, SymInfo>();
  private readonly imports = new Map<number, Array<{ spec: string; target: number | null }>>();
  private readonly importRefs = new Map<number, Array<{ id: number; name: string; qualifier: string | null; to: number | null }>>();
  private readonly superMap = new Map<number, number[]>();
  private complete = false;
  private qCands: StatementSync;
  private qSym: StatementSync;
  private qImports: StatementSync;
  private qImportRefs: StatementSync;
  private qSupers: StatementSync;

  constructor(private readonly store: Store) {
    const rows = store.db.prepare('SELECT id, path, lang, namespace FROM files').all() as Array<{ id: number; path: string; lang: string | null; namespace: string | null }>;
    for (const r of rows) {
      const info: FileInfo = { id: r.id, path: r.path, dir: dirOf(r.path), lang: r.lang ?? '', ns: r.namespace };
      this.files.set(r.id, info);
      this.byPath.set(r.path, r.id);
      const stem = stemOf(r.path);
      (this.byStem.get(stem) ?? this.byStem.set(stem, []).get(stem)!).push(r.id);
      (this.byDir.get(info.dir) ?? this.byDir.set(info.dir, []).get(info.dir)!).push(r.id);
    }
    this.qCands = store.prepare('SELECT id, file_id AS file, parent_id AS parent, kind, name, qname FROM symbols WHERE name = ?');
    this.qSym = store.prepare('SELECT id, file_id AS file, parent_id AS parent, kind, name, qname FROM symbols WHERE id = ?');
    this.qImports = store.prepare('SELECT spec, target_file_id AS target FROM file_imports WHERE file_id = ?');
    this.qImportRefs = store.prepare("SELECT id, name, qualifier, to_symbol_id AS 'to' FROM refs WHERE file_id = ? AND kind = 'import'");
    this.qSupers = store.prepare("SELECT to_symbol_id AS t FROM refs WHERE from_symbol_id = ? AND kind IN ('inherit','implement') AND to_symbol_id IS NOT NULL");
  }

  preload(): void {
    const db = this.store.db;
    for (const r of db.prepare('SELECT id, file_id AS file, parent_id AS parent, kind, name, qname FROM symbols').iterate() as Iterable<SymInfo>) {
      const s: SymInfo = { id: r.id, file: r.file, parent: r.parent, kind: r.kind, name: r.name, qname: r.qname };
      this.syms.set(s.id, s);
      const list = this.names.get(s.name);
      if (list) list.push(s);
      else this.names.set(s.name, [s]);
    }
    for (const r of db.prepare('SELECT file_id AS f, spec, target_file_id AS target FROM file_imports').iterate() as Iterable<{ f: number; spec: string; target: number | null }>) {
      const list = this.imports.get(r.f);
      if (list) list.push({ spec: r.spec, target: r.target });
      else this.imports.set(r.f, [{ spec: r.spec, target: r.target }]);
    }
    this.complete = true;
    this.loadImportRefs();
  }

  /** After import refs were resolved: refresh cached targets (in place when preloaded, lazily otherwise). */
  updateImportRefTargets(targets: Map<number, number | null>): void {
    if (!this.complete) {
      this.importRefs.clear();
      return;
    }
    for (const list of this.importRefs.values()) {
      for (const r of list) {
        const t = targets.get(r.id);
        if (t !== undefined) r.to = t;
      }
    }
  }

  loadImportRefs(): void {
    this.importRefs.clear();
    const q = "SELECT id, file_id AS f, name, qualifier, to_symbol_id AS 'to' FROM refs WHERE kind = 'import'";
    for (const r of this.store.db.prepare(q).iterate() as Iterable<{ id: number; f: number; name: string; qualifier: string | null; to: number | null }>) {
      const list = this.importRefs.get(r.f);
      const v = { id: r.id, name: r.name, qualifier: r.qualifier, to: r.to };
      if (list) list.push(v);
      else this.importRefs.set(r.f, [v]);
    }
  }

  cands(name: string): SymInfo[] {
    let list = this.names.get(name);
    if (list) return list;
    if (this.complete) return [];
    list = (this.qCands.all(name) as unknown as SymInfo[]).map((r) => ({ ...r }));
    this.names.set(name, list);
    for (const s of list) this.syms.set(s.id, s);
    return list;
  }

  sym(id: number | null | undefined): SymInfo | undefined {
    if (id == null) return undefined;
    let s = this.syms.get(id);
    if (s || this.complete) return s;
    const r = this.qSym.get(id) as SymInfo | undefined;
    if (r) {
      s = { ...r };
      this.syms.set(id, s);
    }
    return s;
  }

  fileImports(fileId: number): Array<{ spec: string; target: number | null }> {
    let list = this.imports.get(fileId);
    if (list) return list;
    if (this.complete) return [];
    list = this.qImports.all(fileId) as unknown as Array<{ spec: string; target: number | null }>;
    this.imports.set(fileId, list);
    return list;
  }

  setImportTargets(fileId: number, rows: Array<{ spec: string; target: number | null }>): void {
    this.imports.set(fileId, rows);
  }

  importRefsOf(fileId: number): Array<{ id: number; name: string; qualifier: string | null; to: number | null }> {
    let list = this.importRefs.get(fileId);
    if (list) return list;
    if (this.complete) return [];
    list = (this.qImportRefs.all(fileId) as unknown as Array<{ id: number; name: string; qualifier: string | null; to: number | null }>).map((r) => ({ ...r }));
    this.importRefs.set(fileId, list);
    return list;
  }

  setSupers(map: Map<number, number[]>): void {
    for (const [k, v] of map) this.superMap.set(k, v);
  }

  supers(typeId: number): number[] {
    let s = this.superMap.get(typeId);
    if (s) return s;
    if (this.complete) return [];
    s = (this.qSupers.all(typeId) as Array<{ t: number }>).map((r) => r.t);
    this.superMap.set(typeId, s);
    return s;
  }

  clearSupers(): void {
    this.superMap.clear();
  }

  filesInDir(dir: string): number[] {
    return this.byDir.get(dir) ?? [];
  }

  filesWithStem(stem: string): number[] {
    return this.byStem.get(stem) ?? [];
  }

  pythonModules(): Map<string, number> {
    if (!this.pyModules) {
      this.pyModules = new Map();
      for (const f of this.files.values()) if (f.lang === 'python') this.pyModules.set(f.ns ?? pythonModule(f.path), f.id);
    }
    return this.pyModules;
  }
}

export class Resolver {
  readonly g: Graph;
  private readonly ctxs = new Map<number, FileCtx>();
  private readonly specCache = new Map<string, number | null>();
  private readonly importMemo = new Map<string, number | null>();
  private readonly typeMemo = new Map<string, number | null>();
  private goDirs?: string[];

  constructor(store: Store, full: boolean) {
    this.g = new Graph(store);
    if (full) this.g.preload();
  }

  resetContexts(): void {
    this.ctxs.clear();
  }

  // ------------------------------------------------------------------ module / import specifiers

  /** Single file an import specifier points to, or undefined (external, package-level or unknown). */
  resolveSpec(spec: string, from: FileInfo): number | undefined {
    const key = `${from.lang}\u0000${from.dir}\u0000${spec}`;
    if (this.specCache.has(key)) return this.specCache.get(key) ?? undefined;
    const r = this.computeSpec(spec, from);
    this.specCache.set(key, r ?? null);
    return r;
  }

  private computeSpec(spec: string, from: FileInfo): number | undefined {
    switch (from.lang) {
      case 'typescript':
      case 'tsx':
      case 'javascript':
        return this.tsSpec(spec, from);
      case 'python':
        return this.pySpec(spec, from);
      case 'java':
      case 'kotlin':
      case 'scala': {
        if (spec.endsWith('.*')) {
          // `import a.b.Outer.*` (nested types) -> Outer's file; package wildcards stay unresolved
          return this.qnameFile(spec.slice(0, -2));
        }
        return this.qnameFile(spec);
      }
      case 'php':
        return this.qnameFile(spec.replace(/^\\/, '').replace(/\\/g, '.'));
      case 'ruby': {
        if (spec.startsWith('./')) return this.firstExisting(posix.join(from.dir, spec.slice(2)), ['.rb']);
        return this.suffixFile(spec, ['.rb']);
      }
      default:
        return undefined;
    }
  }

  private qnameFile(qname: string): number | undefined {
    const name = qname.slice(qname.lastIndexOf('.') + 1);
    let best: SymInfo | undefined;
    for (const c of this.g.cands(name)) if (c.qname === qname && (!best || c.id < best.id)) best = c;
    return best?.file;
  }

  private firstExisting(base: string, exts: string[]): number | undefined {
    const b = posix.normalize(base);
    for (const e of exts) {
      const id = this.g.byPath.get(b + e);
      if (id !== undefined) return id;
    }
    return undefined;
  }

  private tsSpec(spec: string, from: FileInfo): number | undefined {
    if (spec.includes(':') || !spec) return undefined;
    if (spec.startsWith('.')) {
      const base = posix.normalize(posix.join(from.dir, spec));
      const direct = this.g.byPath.get(base);
      if (direct !== undefined) return direct;
      // ESM TS imports './x.js' for './x.ts'
      const noJs = base.replace(/\.(m|c)?jsx?$/, '');
      return this.firstExisting(noJs, TS_EXTS) ?? this.firstExisting(noJs + '/index', TS_EXTS);
    }
    // path aliases (@/x, ~/x, #x) and monorepo-internal paths: unique suffix match only
    const rest = spec.replace(/^(?:@|~|#|\$)\//, '').replace(/^#/, '');
    if (!rest.includes('/') && rest === spec) return undefined; // bare package name
    return this.suffixFile(rest, TS_EXTS, true);
  }

  private suffixFile(rest: string, exts: string[], allowIndex = false): number | undefined {
    const clean = rest.replace(/\.(m|c)?jsx?$/, '');
    const segs = clean.split('/');
    const stem = segs[segs.length - 1];
    let found: number | undefined;
    let count = 0;
    const consider = (ids: number[], target: string) => {
      for (const id of ids) {
        const f = this.g.files.get(id)!;
        if (!exts.some((e) => f.path.endsWith(e))) continue;
        const p = stripExt(f.path);
        if (p === target || p.endsWith('/' + target)) {
          if (found !== id) count++;
          found = id;
        }
      }
    };
    consider(this.g.filesWithStem(stem), clean);
    if (!count && allowIndex) consider(this.g.filesWithStem('index'), clean + '/index');
    return count === 1 ? found : undefined;
  }

  private pySpec(spec: string, from: FileInfo): number | undefined {
    const m = /^(\.*)(.*)$/.exec(spec)!;
    const dots = m[1].length;
    const rest = m[2];
    if (dots > 0) {
      let base = from.dir;
      for (let i = 1; i < dots; i++) base = dirOf(base);
      const p = rest ? posix.join(base, rest.replace(/\./g, '/')) : base;
      return this.firstExisting(p, ['.py', '.pyi', '/__init__.py', '/__init__.pyi']);
    }
    const mods = this.g.pythonModules();
    const direct = mods.get(rest);
    if (direct !== undefined) return direct;
    // non-standard source roots (backend/app/x.py imported as app.x): unique suffix
    let found: number | undefined;
    let count = 0;
    const suffix = '.' + rest;
    for (const [mod, id] of mods) {
      if (mod.endsWith(suffix)) {
        count++;
        found = id;
        if (count > 1) break;
      }
    }
    return count === 1 ? found : undefined;
  }

  /** Files a module/package qualifier refers to (`M:` hints). Undefined = outside the index. */
  moduleFiles(spec: string, from: FileInfo): number[] | undefined {
    if (from.lang === 'go') {
      const dir = this.goPackageDir(spec);
      return dir === undefined ? undefined : this.g.filesInDir(dir).filter((id) => this.g.files.get(id)!.lang === 'go');
    }
    const f = this.resolveSpec(spec, from);
    return f === undefined ? undefined : [f];
  }

  private goPackageDir(importPath: string): string | undefined {
    if (!this.goDirs) {
      const dirs = new Set<string>();
      for (const f of this.g.files.values()) if (f.lang === 'go') dirs.add(f.dir);
      this.goDirs = [...dirs];
    }
    let best: string | undefined;
    for (const d of this.goDirs) {
      if (!d) continue;
      if ((importPath === d || importPath.endsWith('/' + d)) && (!best || d.length > best.length)) best = d;
    }
    return best;
  }

  // ------------------------------------------------------------------ file contexts

  ctx(fileId: number): FileCtx {
    let c = this.ctxs.get(fileId);
    if (c) return c;
    const info = this.g.files.get(fileId)!;
    const importTargets = new Set<number>();
    const importedNs = new Set<string>();
    for (const imp of this.g.fileImports(fileId)) {
      if (imp.target != null) importTargets.add(imp.target);
      if (info.lang === 'c_sharp' || info.lang === 'php') importedNs.add(imp.spec.replace(/\\/g, '.'));
      else if (imp.spec.endsWith('.*')) importedNs.add(imp.spec.slice(0, -2));
    }
    if (info.lang === 'c_sharp' && info.ns) {
      // C# sees enclosing namespaces without `using`
      const parts = info.ns.split('.');
      for (let i = parts.length - 1; i > 0; i--) importedNs.add(parts.slice(0, i).join('.'));
    }
    const importedNames = new Map<string, number | null>();
    for (const r of this.g.importRefsOf(fileId)) {
      const prev = importedNames.get(r.name);
      if (prev == null) importedNames.set(r.name, r.to);
    }
    c = { info, importTargets, importedNames, importedNs };
    this.ctxs.set(fileId, c);
    return c;
  }

  // ------------------------------------------------------------------ symbols

  private kindAllowed(refKind: string, symKind: string, name: string, lang?: string): boolean {
    switch (refKind) {
      case 'call':
        // instantiation looks like a call in Python whatever the class name's case (`cached_property`)
        return CALLABLE.has(symKind) || ((symKind === 'class' || symKind === 'struct' || symKind === 'record') && (lang === 'python' || /^[A-Z]/.test(name)));
      case 'new':
        return symKind === 'class' || symKind === 'struct' || symKind === 'record' || symKind === 'function';
      case 'inherit':
      case 'implement':
        return TYPE_KINDS.has(symKind) || symKind === 'module';
      case 'type_ref':
        return TYPE_KINDS.has(symKind);
      default:
        return true;
    }
  }

  /** undefined = no candidate at this tier; null = ambiguous (stop). */
  private pick(list: SymInfo[]): number | null | undefined {
    if (list.length === 0) return undefined;
    if (list.length === 1) return list[0].id;
    const first = list[0];
    let minId = first.id;
    let sameOwner = true;
    for (const c of list) {
      if (c.parent !== first.parent || c.file !== first.file) sameOwner = false;
      if (c.id < minId) minId = c.id;
    }
    if (sameOwner) return minId; // overloads
    // one logical type split over several declarations (C# partial classes, reopened Ruby classes)
    if (TYPE_KINDS.has(first.kind) && list.every((c) => c.qname === first.qname && TYPE_KINDS.has(c.kind))) return minId;
    if (list.length <= 8) {
      // declaration in a supertype + overrides in subtypes: the declaration is the static target
      for (const c of list) {
        if (c.parent == null) continue;
        if (list.every((d) => d === c || (d.parent != null && (d.parent === c.parent || this.isAncestor(c.parent!, d.parent))))) {
          let best = c.id;
          for (const d of list) if (d.parent === c.parent && d.id < best) best = d.id;
          return best;
        }
      }
    }
    return null;
  }

  private isAncestor(anc: number, of: number): boolean {
    const seen = new Set<number>([of]);
    const queue = [of];
    while (queue.length && seen.size < 64) {
      const t = queue.shift()!;
      for (const s of this.g.supers(t)) {
        if (s === anc) return true;
        if (!seen.has(s)) {
          seen.add(s);
          queue.push(s);
        }
      }
    }
    return false;
  }

  private enclosingType(symId: number | null): number | undefined {
    let s = this.g.sym(symId);
    for (let guard = 0; s && guard < 32; guard++) {
      if (CONTAINERS.has(s.kind)) return s.id;
      s = this.g.sym(s.parent);
    }
    return undefined;
  }

  /** All declarations of the same logical type (partial classes): members may live in any of them. */
  private typeParts(typeId: number): number[] {
    const t = this.g.sym(typeId);
    if (!t || !TYPE_KINDS.has(t.kind)) return [typeId];
    const parts = this.g.cands(t.name).filter((c) => c.qname === t.qname && TYPE_KINDS.has(c.kind)).map((c) => c.id);
    return parts.length ? parts : [typeId];
  }

  /** Member `name` of `typeIds` or their supertypes (BFS, nearest wins). */
  private memberOf(typeIds: number[], name: string, refKind: string): number | undefined {
    const cands = this.g.cands(name).filter((c) => this.kindAllowed(refKind, c.kind, name));
    if (!cands.length) return undefined;
    const seen = new Set<number>();
    let level = typeIds.flatMap((t) => this.typeParts(t)).filter((t) => !seen.has(t) && (seen.add(t), true));
    for (let depth = 0; level.length && depth < 12; depth++) {
      for (const t of level) {
        let best: number | undefined;
        const owner = this.g.sym(t);
        for (const c of cands) {
          const isMember =
            c.parent === t ||
            // Go: methods declared in another file of the package carry no parent
            (owner && c.parent == null && c.kind === 'method' && c.qname === `${owner.qname}.${name}` && this.sameDir(c.file, owner.file));
          if (isMember && (best === undefined || c.id < best)) best = c.id;
        }
        if (best !== undefined) return best;
      }
      const next: number[] = [];
      for (const t of level) for (const s of this.g.supers(t)) for (const p of this.typeParts(s)) if (!seen.has(p)) (seen.add(p), next.push(p));
      level = next;
    }
    return undefined;
  }


  private sameDir(a: number, b: number): boolean {
    return this.g.files.get(a)?.dir === this.g.files.get(b)?.dir;
  }

  private samePackage(f: FileCtx, fileId: number): boolean {
    const o = this.g.files.get(fileId);
    if (!o) return false;
    if (NS_SCOPED.has(f.info.lang)) return f.info.ns != null && o.ns === f.info.ns;
    return o.dir === f.info.dir && o.lang === f.info.lang;
  }

  /** Top-level `name` defined (or re-exported) by a module file. */
  private nameInFile(fileId: number, name: string, refKind: string, depth = 0): number | null | undefined {
    const memo = `${fileId}\u0000${name}\u0000${refKind}`;
    if (this.importMemo.has(memo)) return this.importMemo.get(memo);
    this.importMemo.set(memo, undefined as unknown as null); // cycle guard
    let res: number | null | undefined = this.pick(
      this.g.cands(name).filter((c) => c.file === fileId && (c.parent == null || NAMESPACE_LIKE.has(this.g.sym(c.parent)?.kind ?? '')) && this.kindAllowed(refKind, c.kind, name)),
    );
    if (res === undefined && depth < 4) {
      // barrels / package __init__: follow the file's own imports of that name, then wildcard re-exports
      const info = this.g.files.get(fileId);
      if (info) {
        for (const r of this.g.importRefsOf(fileId)) {
          if (r.name !== name || r.qualifier == null) continue;
          const target = this.resolveSpec(r.qualifier, info);
          if (target !== undefined) {
            res = this.nameInFile(target, name, refKind, depth + 1);
            if (res !== undefined) break;
          }
        }
        if (res === undefined) {
          for (const imp of this.g.fileImports(fileId)) {
            const target = imp.target ?? this.resolveSpec(imp.spec, info);
            if (target === undefined || target === null || target === fileId) continue;
            const r = this.nameInFile(target, name, refKind, depth + 1);
            if (r != null) {
              res = r;
              break;
            }
          }
        }
      }
    }
    this.importMemo.set(memo, res ?? null);
    return res;
  }

  resolveImportRef(r: RefRow): number | null {
    const f = this.g.files.get(r.file);
    if (!f) return null;
    const q = r.qualifier ?? '';
    switch (f.lang) {
      case 'java':
      case 'kotlin':
      case 'scala':
      case 'php': {
        const qn = (q ? q.replace(/^\\/, '').replace(/\\/g, '.') + '.' : '') + r.name;
        // a type wins over same-named functions (Kotlin `fun GenericApplicationContext(...)` builders)
        let best: SymInfo | undefined;
        for (const c of this.g.cands(r.name)) {
          if (c.qname !== qn) continue;
          const better = !best || (TYPE_KINDS.has(c.kind) && !TYPE_KINDS.has(best.kind)) || (TYPE_KINDS.has(c.kind) === TYPE_KINDS.has(best.kind) && c.id < best.id);
          if (better) best = c;
        }
        return best?.id ?? null;
      }
      case 'typescript':
      case 'tsx':
      case 'javascript':
      case 'python': {
        const target = this.resolveSpec(q, f);
        if (target === undefined) return null;
        const res = this.nameInFile(target, r.name, 'import');
        if (res != null) return res;
        // `import Foo from './Foo'`: the default export may be named differently
        if (f.lang !== 'python') {
          const def = this.g.cands('default').find((c) => c.file === target);
          if (def) return def.id;
        }
        return null;
      }
      default: {
        const top = this.g.cands(r.name).filter((c) => c.parent == null);
        return top.length === 1 ? top[0].id : null;
      }
    }
  }

  /** Main entry for non-import refs. */
  resolveRef(r: RefRow): number | null {
    const name = r.name;
    const all = this.g.cands(name);
    if (!all.length) return null;
    const f = this.ctx(r.file);
    const lang = f.info.lang;

    if (r.hint) {
      const kind = r.hint.charCodeAt(0);
      const arg = r.hint.slice(2);
      if (kind === 84 /* T */) {
        const typeId = this.resolveType(arg, r);
        if (typeId == null) return null;
        return this.memberOf([typeId], name, r.kind) ?? null;
      }
      if (kind === 77 /* M */) {
        const files = this.moduleFiles(arg, f.info);
        if (!files || !files.length) return null;
        if (files.length === 1) return this.nameInFile(files[0], name, r.kind) ?? null;
        const set = new Set(files);
        return this.pick(all.filter((c) => set.has(c.file) && c.parent == null && this.kindAllowed(r.kind, c.kind, name))) ?? null;
      }
    }

    const q = r.qualifier ?? undefined;
    const selfQ = q !== undefined && SELF.has(q);
    if (r.from != null && (selfQ || (q === undefined && IMPLICIT_THIS.has(lang)))) {
      const cls = this.enclosingType(r.from);
      if (cls !== undefined) {
        const start = q === 'super' || q === 'base' || q === 'parent' ? this.g.supers(cls) : [cls];
        const m = this.memberOf(start, name, r.kind);
        if (m !== undefined) return m;
        // `this.x()` not declared in our hierarchy: inherited from outside the index
        if (selfQ) return null;
      }
    }
    if (selfQ) return null;

    const unqualified = q === undefined;
    // class literals (`Foo.class.getMethod`) and literals as receivers are always outside the index
    if (q !== undefined && (q.endsWith('.class') || q.endsWith('::class') || /^["'`\d]/.test(q))) return null;
    let pool = all.filter((c) => this.kindAllowed(r.kind, c.kind, name, lang));
    if (unqualified && r.kind === 'call') pool = pool.filter((c) => c.parent == null || NAMESPACE_LIKE.has(this.g.sym(c.parent)?.kind ?? ''));
    if (!pool.length) return null;

    let res = this.pick(pool.filter((c) => c.file === r.file));
    if (res !== undefined) return res;
    if (unqualified) {
      const imp = f.importedNames.get(name);
      if (imp !== undefined) {
        if (imp === null) return null; // imported from outside the index
        const s = this.g.sym(imp);
        if (!s) return null;
        if (this.kindAllowed(r.kind, s.kind, name, lang)) return imp;
        // same qualified name, other kind (Kotlin factory functions named like the class they build)
        return this.pick(all.filter((c) => c.qname === s.qname && this.kindAllowed(r.kind, c.kind, name, lang))) ?? null;
      }
    }
    if (f.importTargets.size) {
      res = this.pick(pool.filter((c) => f.importTargets.has(c.file)));
      if (res !== undefined) return res;
    }
    if (NS_SCOPED.has(lang) || DIR_SCOPED.has(lang) || !unqualified) {
      res = this.pick(pool.filter((c) => this.samePackage(f, c.file)));
      if (res !== undefined) return res;
    }
    if (f.importedNs.size) {
      res = this.pick(pool.filter((c) => f.importedNs.has(this.g.files.get(c.file)?.ns ?? '\u0000')));
      if (res !== undefined) return res;
    }
    const globalOk = unqualified ? LOOSE.has(lang) : DUCK_TYPED.has(lang) && name.length > 3 && !GENERIC.has(name);
    if (!globalOk) return null;
    return this.pick(pool) ?? null;
  }

  /** Type symbol a receiver type name refers to, from the point of view of ref `r`. */
  private resolveType(typeName: string, r: RefRow): number | null {
    const memo = `${r.file}\u0000${r.from ?? ''}\u0000${typeName}`;
    if (this.typeMemo.has(memo)) return this.typeMemo.get(memo) ?? null;
    const res = this.resolveRef({ id: 0, file: r.file, from: r.from, name: typeName, qualifier: null, kind: 'type_ref', hint: null, to: null });
    this.typeMemo.set(memo, res);
    return res;
  }
}

// ------------------------------------------------------------------------------------------ driver

const REF_COLS = "r.id AS id, r.file_id AS file, r.from_symbol_id AS 'from', r.name AS name, r.qualifier AS qualifier, r.kind AS kind, h.hint AS hint, r.to_symbol_id AS 'to'";
const CHUNK = 25_000;

function yieldNow(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

/** Rows of `kinds` to (re)resolve: everything for full passes, the affected subset otherwise. */
function* refRows(store: Store, scope: ResolveScope, kinds: string[]): Generator<RefRow[]> {
  const kindList = kinds.map((k) => `'${k}'`).join(',');
  if (scope.full) {
    const stmt = store.db.prepare(`SELECT ${REF_COLS} FROM refs r LEFT JOIN idx_ref_hints h ON h.ref_id = r.id WHERE r.id > ? AND r.kind IN (${kindList}) ORDER BY r.id LIMIT ${CHUNK}`);
    let last = 0;
    for (;;) {
      const rows = stmt.all(last) as unknown as RefRow[];
      if (!rows.length) return;
      last = rows[rows.length - 1].id;
      yield rows;
    }
  }
  const seen = new Set<number>();
  let batch: RefRow[] = [];
  const take = (rows: RefRow[]) => {
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      batch.push(r);
    }
  };
  const byFile = store.db.prepare(`SELECT ${REF_COLS} FROM refs r LEFT JOIN idx_ref_hints h ON h.ref_id = r.id WHERE r.file_id = ? AND r.kind IN (${kindList})`);
  const byTo = store.db.prepare(`SELECT ${REF_COLS} FROM refs r LEFT JOIN idx_ref_hints h ON h.ref_id = r.id WHERE r.to_symbol_id = ? AND r.kind IN (${kindList})`);
  const byName = store.db.prepare(`SELECT ${REF_COLS} FROM refs r LEFT JOIN idx_ref_hints h ON h.ref_id = r.id WHERE r.name = ? AND r.kind IN (${kindList})`);
  for (const id of scope.changedFileIds) {
    take(byFile.all(id) as unknown as RefRow[]);
    if (batch.length >= CHUNK) (yield batch, (batch = []));
  }
  for (const id of scope.removedSymbolIds) {
    take(byTo.all(id) as unknown as RefRow[]);
    if (batch.length >= CHUNK) (yield batch, (batch = []));
  }
  for (const n of scope.changedNames) {
    take(byName.all(n) as unknown as RefRow[]);
    if (batch.length >= CHUNK) (yield batch, (batch = []));
  }
  if (batch.length) yield batch;
}

function applyUpdates(store: Store, updates: Array<[number, number | null]>): void {
  if (!updates.length) return;
  const upd = store.prepare('UPDATE refs SET to_symbol_id = ? WHERE id = ?');
  store.transaction(() => {
    for (const [id, to] of updates) upd.run(to, id);
  });
}

/** Resolves file_imports targets and refs.to_symbol_id for the given scope. */
const DEBUG = process.env.KOPT_INDEX_DEBUG === '1';

function debug(label: string, t0: number): void {
  if (!DEBUG) return;
  const m = process.memoryUsage();
  process.stderr.write(`kopt resolve: ${label} ${Math.round(performance.now() - t0)}ms (heap ${Math.round(m.heapUsed / 1e6)}MB)\n`);
}

export async function resolveIndex(store: Store, scope: ResolveScope): Promise<ResolveStats> {
  const t0 = performance.now();
  const res = new Resolver(store, scope.full);
  debug('preload', t0);
  const stats: ResolveStats = { refsConsidered: 0, refsResolved: 0, importsResolved: 0, durationMs: 0 };

  // A. file_imports targets
  {
    const updates: Array<[number, number | null]> = [];
    const rows: Array<{ rowid: number; file: number; spec: string; target: number | null }> = [];
    const sel = 'SELECT rowid, file_id AS file, spec, target_file_id AS target FROM file_imports';
    if (scope.full) rows.push(...(store.db.prepare(sel).all() as unknown as typeof rows));
    else {
      const byFile = store.db.prepare(`${sel} WHERE file_id = ?`);
      for (const id of scope.changedFileIds) rows.push(...(byFile.all(id) as unknown as typeof rows));
      if (scope.addedFileIds.size || scope.removedFileIds.size) {
        const seen = new Set(rows.map((r) => r.rowid));
        const stale = store.db.prepare(`${sel} WHERE target_file_id IS NULL`).all() as unknown as typeof rows;
        const removed = scope.removedFileIds.size
          ? (store.db.prepare(`${sel} WHERE target_file_id IN (${[...scope.removedFileIds].join(',')})`).all() as unknown as typeof rows)
          : [];
        for (const r of [...stale, ...removed]) if (!seen.has(r.rowid)) rows.push(r);
      }
    }
    const touchedFiles = new Set<number>();
    for (const r of rows) {
      const info = res.g.files.get(r.file);
      if (!info) continue;
      const t = res.resolveSpec(r.spec, info) ?? null;
      if (t !== null) stats.importsResolved++;
      if (t !== r.target) {
        updates.push([r.rowid, t]);
        touchedFiles.add(r.file);
      }
    }
    if (updates.length) {
      const upd = store.prepare('UPDATE file_imports SET target_file_id = ? WHERE rowid = ?');
      store.transaction(() => {
        for (const [rowid, t] of updates) upd.run(t, rowid);
      });
    }
    if (scope.full) {
      // reload resolved targets into the preloaded graph
      const byFile = new Map<number, Array<{ spec: string; target: number | null }>>();
      for (const r of store.db.prepare('SELECT file_id AS f, spec, target_file_id AS target FROM file_imports').iterate() as Iterable<{ f: number; spec: string; target: number | null }>) {
        (byFile.get(r.f) ?? byFile.set(r.f, []).get(r.f)!).push({ spec: r.spec, target: r.target });
      }
      for (const [f, list] of byFile) res.g.setImportTargets(f, list);
    } else {
      // files whose imports now point elsewhere: their refs may resolve differently
      for (const f of touchedFiles) scope.changedFileIds.add(f);
    }
  }

  debug('file imports', t0);
  // B. import refs, C. inheritance, D. everything else. Each phase is written before the next reads it.
  const phases: Array<{ kinds: string[]; fn: (r: RefRow) => number | null }> = [
    { kinds: ['import'], fn: (r) => res.resolveImportRef(r) },
    { kinds: ['inherit', 'implement'], fn: (r) => res.resolveRef(r) },
    { kinds: ['call', 'new', 'type_ref'], fn: (r) => res.resolveRef(r) },
  ];
  for (const [i, phase] of phases.entries()) {
    const supers = new Map<number, number[]>();
    const importTargets = new Map<number, number | null>();
    for (const rows of refRows(store, scope, phase.kinds)) {
      const updates: Array<[number, number | null]> = [];
      for (const r of rows) {
        stats.refsConsidered++;
        let to: number | null = null;
        try {
          to = phase.fn(r);
        } catch {
          to = null;
        }
        if (to !== null) {
          stats.refsResolved++;
          if (i === 1 && r.from != null) (supers.get(r.from) ?? supers.set(r.from, []).get(r.from)!).push(to);
        }
        if (i === 0) importTargets.set(r.id, to);
        if (to !== r.to) updates.push([r.id, to]);
      }
      applyUpdates(store, updates);
      await yieldNow();
    }
    debug(`phase ${phase.kinds.join('/')}`, t0);
    if (i === 0) {
      res.g.updateImportRefTargets(importTargets);
      res.resetContexts();
    }
    if (i === 1) {
      if (scope.full) res.g.setSupers(supers);
      else res.g.clearSupers();
    }
  }
  stats.durationMs = Math.round(performance.now() - t0);
  return stats;
}
