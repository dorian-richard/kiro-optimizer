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
import { TsConfigs } from './tsconfig.js';
import { baseTypeName, BUILTIN, declaredType } from './extract.js';

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

/** An import ref; `from` set when the import sits inside a declaration (Python function-local imports). */
interface ImportRef {
  id: number;
  name: string;
  qualifier: string | null;
  to: number | null;
  from: number | null;
}

/** File contexts kept between files of a pass (oldest dropped first). */
const MAX_CONTEXTS = 4096;

/** Candidate lists up to this long are filtered on each use instead of memoized. */
const MEMO_MIN = 16;

interface MemberIndex {
  /** parent symbol -> lowest member id with that parent */
  byParent: Map<number, number>;
  /** parentless methods (Go methods declared in another file, Rust impl blocks in other modules) */
  orphans: SymInfo[];
  size: number;
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
  /** Repo root on disk (tsconfig `paths`); defaults to the store's root. */
  root?: string;
  changedFileIds: Set<number>;
  removedSymbolIds: Set<number>;
  changedNames: Set<string>;
  addedFileIds: Set<number>;
  removedFileIds: Set<number>;
  /** Paths of the removed files (narrows which unresolved imports are worth another try). */
  removedPaths?: Set<string>;
  /** References examined so far, out of `total` (full passes: every ref; otherwise unknown). */
  onProgress?: (done: number, total?: number) => void;
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
/** Targets of member reads and writes. A read may also name a method or function used as a value (callbacks). */
const FIELD_LIKE = new Set(['field', 'property', 'constant']);
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
 * Languages whose receivers kopt often cannot type (call chains, fields of fields, inferred locals) but whose
 * calls on library types rarely share a name with repository code once the standard library's own method
 * names are set aside: a qualified call there links by name when the name is distinctive and declared exactly
 * once in the whole repository, as a function or method. Measured on gitea and meilisearch samples, nearly
 * every such link is right. JVM and .NET code calls library APIs (JDK, AssertJ, Jackson...) through untyped
 * chains far too often for that rule (most links were wrong on spring-framework), so it is not used there.
 */
const UNIQUE_NAME_OK = new Set(['go', 'rust']);

/** Standard-library method names that a Go or Rust receiver of unknown type most likely means. */
const STD_METHODS: Record<string, Set<string>> = {
  rust: new Set(
    (
      'into try_into from try_from as_ref as_mut as_str as_slice as_bytes as_ptr as_path as_deref as_deref_mut ' +
      'to_string to_owned to_vec to_lowercase to_uppercase to_ascii_lowercase to_ascii_uppercase to_be_bytes ' +
      'to_le_bytes to_ne_bytes from_be_bytes from_le_bytes from_ne_bytes checked_add checked_sub checked_mul ' +
      'checked_div checked_rem saturating_add saturating_sub saturating_mul saturating_div wrapping_add ' +
      'wrapping_sub wrapping_mul overflowing_add overflowing_sub unwrap unwrap_or unwrap_or_else ' +
      'unwrap_or_default unwrap_err expect expect_err map_err map_or map_or_else ok_or ok_or_else and_then ' +
      'or_else is_some is_none is_some_and is_ok is_err iter iter_mut into_iter collect borrow borrow_mut deref ' +
      'deref_mut drop push_str extend_from_slice retain drain entry or_insert or_insert_with or_default chars ' +
      'bytes lines split_whitespace split_once rsplit_once trim_start trim_end trim_matches starts_with ' +
      'ends_with strip_prefix strip_suffix contains_key get_mut get_or_insert_with insert remove take replace ' +
      'swap copied cloned flatten flat_map filter_map enumerate zip rev skip take_while skip_while step_by ' +
      'chain fold position find_map max_by_key min_by_key max_by min_by product last nth peekable windows ' +
      'chunks chunks_exact sort_by sort_by_key sort_unstable sort_unstable_by dedup binary_search concat ' +
      'lock read write send recv try_recv spawn poll block_on elapsed duration_since as_secs as_millis ' +
      'as_micros as_nanos as_secs_f64 parse hash partial_cmp clone_from default extend truncate reserve ' +
      'with_capacity capacity split_at split_off first_mut last_mut into_inner get_ref get_unchecked ' +
      'to_str to_path_buf file_name extension exists is_file is_dir read_to_string write_all flush ' +
      'join_all into_boxed_slice into_bytes from_utf8 from_str display downcast downcast_ref type_id'
    ).split(' '),
  ),
  go: new Set(
    (
      'Unix UnixNano UnixMilli Format Sub Before After Equal IsZero Seconds Milliseconds Minutes Hours Truncate ' +
      'Round Bytes Cap Reset WriteString WriteByte WriteRune ReadString ReadLine ReadBytes Scan Text Err Done ' +
      'Deadline Cancel Lock Unlock RLock RUnlock Wait Load Store Swap CompareAndSwap Header Del Query QueryRow ' +
      'QueryContext ExecContext Exec Begin BeginTx Commit Rollback Prepare Body StatusCode Encode Decode ' +
      'Marshal Unmarshal MarshalJSON UnmarshalJSON Contains HasPrefix HasSuffix TrimSpace Name Size Mode ' +
      'ModTime IsDir Sys Stat ReadDir Open Create Remove Rename Mkdir MkdirAll Seek Sync Fd Is As Unwrap Int ' +
      'Int64 Uint64 Float64 Bool Value Values Next Peek Flush Copy Context WithContext WithValue ' +
      'WithCancel WithTimeout Signal Notify Elem Kind Type Field Method NumField Interface IsNil IsValid ' +
      'Index Slice Append Join Split Replace Fields Lines Hex Base64 Sum Hash Reader Writer ServeHTTP ' +
      'Handle HandleFunc ListenAndServe Shutdown Dial Accept LocalAddr RemoteAddr SetDeadline FormValue ' +
      'PostFormValue Cookie SetCookie Redirect WriteHeader Hijack Push Done Year Month Day Hour Minute Second ' +
      'Weekday YearDay AddDate In UTC Local Location Since Until Parse ParseInt Atoi Itoa Sprint Fprint Fprintf'
    ).split(' '),
  ),
};
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
  private readonly importRefs = new Map<number, ImportRef[]>();
  private readonly superMap = new Map<number, number[]>();
  private complete = false;
  private qCands: StatementSync;
  private qSym: StatementSync;
  private qImports: StatementSync;
  private qImportRefs: StatementSync;
  private qSupers: StatementSync;

  constructor(readonly store: Store) {
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
    this.qImportRefs = store.prepare("SELECT id, name, qualifier, to_symbol_id AS 'to', from_symbol_id AS 'from' FROM refs WHERE file_id = ? AND kind = 'import'");
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
    const q = "SELECT id, file_id AS f, name, qualifier, to_symbol_id AS 'to', from_symbol_id AS 'from' FROM refs WHERE kind = 'import'";
    for (const r of this.store.db.prepare(q).iterate() as Iterable<ImportRef & { f: number }>) {
      const list = this.importRefs.get(r.f);
      const v: ImportRef = { id: r.id, name: r.name, qualifier: r.qualifier, to: r.to, from: r.from };
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

  importRefsOf(fileId: number): ImportRef[] {
    let list = this.importRefs.get(fileId);
    if (list) return list;
    if (this.complete) return [];
    list = (this.qImportRefs.all(fileId) as unknown as ImportRef[]).map((r) => ({ ...r }));
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
  private readonly importMemo = new Map<string, number | null | undefined>();
  private readonly typeMemo = new Map<string, number | null>();
  private goDirs?: string[];
  private readonly tsconfigs?: TsConfigs;
  private readonly extMemo = new Map<string, number | null | undefined>();
  private qSig?: StatementSync;
  private qInnerIn?: StatementSync;
  private qInnerTop?: StatementSync;
  private readonly chainMemo = new Map<string, number | typeof BUILTIN | null>();
  private readonly chainActive = new Set<string>();
  private chainDepth = 0;
  /**
   * Candidates of a name filtered by ref kind, per candidate list (lists are stable for a Resolver's lifetime).
   * Big repositories have thousands of symbols named `get` or `toString`: filtering them again for each of 2M call
   * refs, then once more per level of a type hierarchy, was most of the resolution time.
   */
  private readonly allowMemo = new WeakMap<SymInfo[], Map<string, SymInfo[]>>();
  private readonly memberMemo = new WeakMap<SymInfo[], MemberIndex>();
  private readonly partsMemo = new Map<number, number[]>();

  constructor(store: Store, full: boolean, root?: string) {
    this.g = new Graph(store);
    if (full) this.g.preload();
    const r = root ?? store.root;
    if (r) this.tsconfigs = new TsConfigs(r);
  }

  resetContexts(): void {
    this.ctxs.clear();
  }

  /**
   * Refs come in id order, which is file order: once a file is done, its receiver-type and call-chain memos are
   * dead weight (keyed by file + enclosing symbol), and only recently used file contexts are worth keeping. Without
   * this a full pass on a 30k-file repository kept millions of entries until the end.
   */
  endFile(): void {
    this.typeMemo.clear();
    this.chainMemo.clear();
    if (this.ctxs.size > MAX_CONTEXTS) {
      let drop = this.ctxs.size - MAX_CONTEXTS / 2;
      for (const k of this.ctxs.keys()) {
        if (drop-- <= 0) break;
        this.ctxs.delete(k);
      }
    }
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
    // tsconfig/jsconfig `paths` and `baseUrl` of the nearest config
    const cfg = this.tsconfigs?.forDir(from.dir);
    if (cfg) {
      for (const cand of this.tsconfigs!.candidates(spec, cfg)) {
        const direct = this.g.byPath.get(cand);
        if (direct !== undefined) return direct;
        const base = cand.replace(/\.(m|c)?jsx?$/, '');
        const f = this.firstExisting(base, TS_EXTS) ?? this.firstExisting(base + '/index', TS_EXTS);
        if (f !== undefined) return f;
      }
    }
    // other path aliases (@/x, ~/x, #x) and monorepo-internal paths: unique suffix match only
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

  /** `qualified`: the ref names a member of something (`Foo::BAR`, `self::X`), so constants qualify for type refs. */
  private kindAllowed(refKind: string, symKind: string, name: string, lang?: string, qualified = false): boolean {
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
        return TYPE_KINDS.has(symKind) || (qualified && symKind === 'constant');
      case 'read':
        return FIELD_LIKE.has(symKind) || symKind === 'method' || symKind === 'function';
      case 'write':
        return FIELD_LIKE.has(symKind);
      default:
        return true;
    }
  }

  /** `this.g.cands(name)` filtered by kindAllowed, memoized. */
  private allowed(name: string, refKind: string, lang: string | undefined, qualified: boolean): SymInfo[] {
    const all = this.g.cands(name);
    if (!all.length) return all;
    // short lists are cheaper to filter again than to keep in memory
    if (all.length <= MEMO_MIN) return all.filter((c) => this.kindAllowed(refKind, c.kind, name, lang, qualified));
    // kindAllowed only looks at the language for Python calls and at `qualified` for type refs
    const key = `${refKind}\u0000${lang === 'python' ? 1 : 0}${refKind === 'type_ref' && qualified ? 1 : 0}`;
    let byKey = this.allowMemo.get(all);
    if (!byKey) this.allowMemo.set(all, (byKey = new Map()));
    let list = byKey.get(key);
    if (!list) {
      list = all.filter((c) => this.kindAllowed(refKind, c.kind, name, lang, qualified));
      byKey.set(key, list);
    }
    return list;
  }

  /** Allowed `call` candidates declared at top level (or in a namespace/module), memoized. */
  private topLevelCalls(name: string, lang: string): SymInfo[] {
    const pool = this.allowed(name, 'call', lang, false);
    if (pool.length <= MEMO_MIN) return pool.filter((c) => c.parent == null || NAMESPACE_LIKE.has(this.g.sym(c.parent)?.kind ?? ''));
    let byKey = this.allowMemo.get(pool);
    if (!byKey) this.allowMemo.set(pool, (byKey = new Map()));
    let list = byKey.get('top');
    if (!list) {
      list = pool.filter((c) => c.parent == null || NAMESPACE_LIKE.has(this.g.sym(c.parent)?.kind ?? ''));
      byKey.set('top', list);
    }
    return list;
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
    const memo = this.partsMemo.get(typeId);
    if (memo) return memo;
    const t = this.g.sym(typeId);
    let parts = [typeId];
    if (t && TYPE_KINDS.has(t.kind)) {
      const found = this.g.cands(t.name).filter((c) => c.qname === t.qname && TYPE_KINDS.has(c.kind)).map((c) => c.id);
      if (found.length) parts = found;
    }
    this.partsMemo.set(typeId, parts);
    return parts;
  }

  /** Allowed member candidates of `name` indexed by their parent (lowest id per parent), memoized. */
  private memberIndex(name: string, refKind: string): MemberIndex {
    const cands = this.allowed(name, refKind, undefined, true);
    let idx = cands.length > MEMO_MIN ? this.memberMemo.get(cands) : undefined;
    if (!idx) {
      const byParent = new Map<number, number>();
      const orphans: SymInfo[] = [];
      for (const c of cands) {
        if (c.parent != null) {
          const b = byParent.get(c.parent);
          if (b === undefined || c.id < b) byParent.set(c.parent, c.id);
        } else if (c.kind === 'method') orphans.push(c);
      }
      idx = { byParent, orphans, size: cands.length };
      if (cands.length > MEMO_MIN) this.memberMemo.set(cands, idx);
    }
    return idx;
  }

  /** Member `name` of `typeIds` or their supertypes (BFS, nearest wins). */
  private memberOf(typeIds: number[], name: string, refKind: string): number | undefined {
    const idx = this.memberIndex(name, refKind);
    if (!idx.size) return undefined;
    const seen = new Set<number>();
    let level = typeIds.flatMap((t) => this.typeParts(t)).filter((t) => !seen.has(t) && (seen.add(t), true));
    for (let depth = 0; level.length && depth < 12; depth++) {
      for (const t of level) {
        let best = idx.byParent.get(t);
        const owner = idx.orphans.length ? this.g.sym(t) : undefined;
        if (owner) {
          // Go: methods declared in another file of the package carry no parent
          const qn = `${owner.qname}.${name}`;
          for (const c of idx.orphans) if (c.qname === qn && this.sameDir(c.file, owner.file) && (best === undefined || c.id < best)) best = c.id;
        }
        if (best !== undefined) return best;
        // Rust: `impl Foo` / `impl Trait for Foo` blocks in another file (module) of the crate: parentless
        // methods named `Foo.name`, accepted only when exactly one exists
        if (owner && this.g.files.get(owner.file)?.lang === 'rust') {
          const qn = `${owner.qname}.${name}`;
          const loose = idx.orphans.filter((c) => c.qname === qn);
          if (loose.length === 1) return loose[0].id;
        }
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
    // the depth is part of the key: a lookup cut short by the depth limit must not answer a shallower one
    const memo = `${fileId}\u0000${name}\u0000${refKind}\u0000${depth}`;
    if (this.importMemo.has(memo)) return this.importMemo.get(memo);
    this.importMemo.set(memo, undefined); // cycle guard
    let res: number | null | undefined = this.pick(
      this.g.cands(name).filter((c) => c.file === fileId && (c.parent == null || NAMESPACE_LIKE.has(this.g.sym(c.parent)?.kind ?? '')) && this.kindAllowed(refKind, c.kind, name)),
    );
    if (res === undefined && depth < 4) {
      // barrels / package __init__: follow the file's own imports of that name, then wildcard re-exports
      const info = this.g.files.get(fileId);
      if (info) {
        for (const r of this.g.importRefsOf(fileId)) {
          // a function-local import binds a local name, not an attribute of the module
          if (r.name !== name || r.qualifier == null || r.from != null) continue;
          const target = this.resolveSpec(r.qualifier, info);
          if (target !== undefined) {
            res = this.nameInFile(target, name, refKind, depth + 1);
            if (res !== undefined) break;
          }
        }
        if (res === undefined) {
          // wildcard re-exports only (`export * from`, `from x import *`, recorded as imports of `*`): a module
          // that imports named things from another one (possibly inside a function) does not re-export the
          // rest of it. Specs without any named import (CommonJS requires, older indexes) are followed too.
          const named = new Set<string>();
          const star = new Set<string>();
          for (const r of this.g.importRefsOf(fileId)) {
            if (r.qualifier == null) continue;
            (r.name === '*' && r.from == null ? star : named).add(r.qualifier);
          }
          for (const imp of this.g.fileImports(fileId)) {
            if (named.has(imp.spec) && !star.has(imp.spec)) continue;
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
    this.importMemo.set(memo, res);
    return res;
  }

  resolveImportRef(r: RefRow): number | null {
    const f = this.g.files.get(r.file);
    if (!f || r.name === '*') return null; // wildcard marker, see nameInFile
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
      // receiver declared with a primitive, string or array type: a library call, or a repository extension
      if (kind === 88 /* X */) return r.kind === 'call' ? this.extensionOf(name, lang) ?? null : null;
      if (kind === 67 /* C */) {
        // receiver = result of another call in the same symbol: its declared return type when known,
        // else the usual name-based tiers below
        const t = this.chainType(r, arg);
        if (t === BUILTIN) return r.kind === 'call' ? this.extensionOf(name, lang) ?? null : null;
        if (t != null) {
          const member = this.memberOf([t], name, r.kind);
          if (member !== undefined) return member;
          return r.kind === 'call' ? this.extensionOf(name, lang) ?? null : null;
        }
      }
      if (kind === 84 /* T */) {
        const typeId = this.resolveType(arg, r);
        if (typeId == null) {
          // JS `Date.prototype.getTwoDigitHour = function () {}` extends a type that is not in the index
          const proto = all.filter((c) => c.parent == null && c.kind === 'method' && c.qname === `${arg}.${name}`);
          return proto.length === 1 ? proto[0].id : null;
        }
        const member = this.memberOf([typeId], name, r.kind);
        if (member !== undefined) return member;
        // a repository type without that member: an extension declared for it (never for a static call
        // `Type.name()` on a type outside the index, which stops above)
        return r.kind === 'call' ? this.extensionOf(name, lang) ?? null : null;
      }
      if (kind === 81 /* Q */) {
        // receiver typed with a type of an imported package (Go `p *policy.Policy`): `<import path>\u0001<Type>`
        const sep = arg.indexOf('\u0001');
        const typeId = sep > 0 ? this.typeInModule(arg.slice(0, sep), arg.slice(sep + 1), f.info) : undefined;
        if (typeId === undefined) return null;
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
    const pool = unqualified && r.kind === 'call' ? this.topLevelCalls(name, lang) : this.allowed(name, r.kind, lang, !unqualified);
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
    const distinctive = name.length > 3 && !GENERIC.has(name);
    if (!unqualified && r.kind === 'call' && distinctive && UNIQUE_NAME_OK.has(lang) && !STD_METHODS[lang]?.has(name)) {
      // receiver of unknown type (no hint): link only a name declared once in the repo, as a callable
      return all.length === 1 && CALLABLE.has(all[0].kind) ? all[0].id : null;
    }
    // Member reads and writes never link by a repository-wide unique name: property names (`kind`, `owner`,
    // `direction`) recur across unrelated object shapes far more than method names do.
    if (r.kind === 'read' || r.kind === 'write') return null;
    const globalOk = unqualified ? LOOSE.has(lang) : DUCK_TYPED.has(lang) && distinctive;
    if (!globalOk) return null;
    return this.pick(pool) ?? null;
  }

  /**
   * C# extension methods (`static T Foo(this string s)`) and Kotlin extension functions (`fun String.foo()`)
   * declared in the repository: the target of a call on a receiver whose type has no such member (or lives
   * outside the index). Undefined when the language has no extensions or no extension of that name exists.
   */
  private extensionOf(name: string, lang: string): number | null | undefined {
    if (lang !== 'c_sharp' && lang !== 'kotlin') return undefined;
    const key = `${lang}\u0000${name}`;
    if (this.extMemo.has(key)) return this.extMemo.get(key);
    const cands = this.g.cands(name).filter((c) => c.kind === 'method' || c.kind === 'function');
    let res: number | null | undefined;
    if (cands.length) {
      this.qSig ??= this.g.store.prepare('SELECT signature FROM symbols WHERE id = ?');
      const ext = cands.filter((c) => {
        const sig = (this.qSig!.get(c.id) as { signature: string } | undefined)?.signature ?? '';
        if (lang === 'c_sharp') return /\(\s*(?:\[[^\]]*\]\s*)?this\s/.test(sig);
        // `fun Receiver.name(` / `fun <T> List<T>.name(`: the declared name is prefixed by a receiver type
        const head = /\bfun\s+(?:<[^>]*>\s*)?([^(]*?)\s*\(/.exec(sig)?.[1] ?? '';
        return head.length > name.length && head.endsWith(name) && /\.\s*$/.test(head.slice(0, -name.length));
      });
      res = this.pick(ext);
    }
    this.extMemo.set(key, res);
    return res;
  }

  /**
   * Type of the value returned by the call named in a `C:` hint (`<name>\u0001<qualifier>`): the call's own
   * ref in the same symbol is resolved (recursively for longer chains), then the target's declared return
   * type is resolved from the target's file. BUILTIN for primitive / string / array results; null when unknown.
   */
  private chainType(r: RefRow, spec: string): number | typeof BUILTIN | null {
    const memo = `${r.file}\u0000${r.from ?? ''}\u0000${spec}`;
    if (this.chainMemo.has(memo)) return this.chainMemo.get(memo)!;
    if (this.chainActive.has(memo)) return null; // cycle
    // only top-level answers are memoized: a nested one may have been cut short by the depth limit
    const top = this.chainDepth === 0;
    let res: number | typeof BUILTIN | null = null;
    if (this.chainDepth < 8) {
      this.chainActive.add(memo);
      this.chainDepth++;
      try {
        const sep = spec.indexOf('\u0001');
        const name = sep < 0 ? spec : spec.slice(0, sep);
        const qual = sep < 0 ? '' : spec.slice(sep + 1);
        // The unary `+` keeps SQLite off refs_name: once ANALYZE has run (PRAGMA optimize after a full pass) it
        // prefers that index (6 rows per name on average), and walks 50k+ refs for each `.get()` of a chain.
        let inner: RefRow | undefined;
        if (r.from != null) {
          this.qInnerIn ??= this.g.store.prepare(
            `SELECT ${REF_COLS} FROM refs r LEFT JOIN idx_ref_hints h ON h.ref_id = r.id WHERE r.from_symbol_id = ? AND +r.file_id = ? AND +r.name = ? AND coalesce(r.qualifier, '') = ? AND r.kind IN ('call', 'new') ORDER BY r.id LIMIT 1`,
          );
          inner = this.qInnerIn.get(r.from, r.file, name, qual) as unknown as RefRow | undefined;
        } else {
          this.qInnerTop ??= this.g.store.prepare(
            `SELECT ${REF_COLS} FROM refs r LEFT JOIN idx_ref_hints h ON h.ref_id = r.id WHERE r.file_id = ? AND +r.from_symbol_id IS NULL AND +r.name = ? AND coalesce(r.qualifier, '') = ? AND r.kind IN ('call', 'new') ORDER BY r.id LIMIT 1`,
          );
          inner = this.qInnerTop.get(r.file, name, qual) as unknown as RefRow | undefined;
        }
        const target = inner ? this.resolveRef({ ...inner }) : null;
        if (target != null) res = this.returnType(target);
      } finally {
        this.chainDepth--;
        this.chainActive.delete(memo);
      }
    }
    if (top) this.chainMemo.set(memo, res);
    return res;
  }

  /** The type named `typeName` declared at the top level of the files of module `spec`, when exactly one. */
  private typeInModule(spec: string, typeName: string, from: FileInfo): number | undefined {
    const files = this.moduleFiles(spec, from);
    if (!files?.length) return undefined;
    const set = new Set(files);
    const types = this.g.cands(typeName).filter((c) => set.has(c.file) && c.parent == null && TYPE_KINDS.has(c.kind));
    return types.length === 1 ? types[0].id : undefined;
  }

  /**
   * A Go result type qualified by a package (`*policy.Policy`), seen from the file that declares the function:
   * the package is the import whose last path segment (or alias-free name) is `pkg`.
   */
  private goQualifiedType(fileId: number, pkg: string, typeName: string): number | undefined {
    const info = this.g.files.get(fileId);
    if (!info) return undefined;
    for (const imp of this.g.fileImports(fileId)) {
      const segs = imp.spec.split('/');
      let last = segs[segs.length - 1];
      if (/^v\d+$/.test(last) && segs.length > 1) last = segs[segs.length - 2];
      if (last.replace(/^go-|-go$/g, '').replace(/[-.]/g, '_') !== pkg) continue;
      return this.typeInModule(imp.spec, typeName, info);
    }
    return undefined;
  }

  /** Declared result type of a callable symbol (a class for constructors and instantiations). */
  private returnType(symId: number): number | typeof BUILTIN | null {
    const s = this.g.sym(symId);
    if (!s) return null;
    if (TYPE_KINDS.has(s.kind)) return s.id;
    if (s.kind === 'constructor') return this.enclosingType(s.parent) ?? null;
    if (s.kind !== 'method' && s.kind !== 'function') return null;
    const info = this.g.files.get(s.file);
    this.qSig ??= this.g.store.prepare('SELECT signature FROM symbols WHERE id = ?');
    const sig = (this.qSig.get(s.id) as { signature: string } | undefined)?.signature ?? '';
    const text = returnTypeText(sig, s.name, info?.lang ?? '');
    if (!text) return null;
    const bare = text.replace(/^[&*?\s]+|[?!\s]+$/g, '').replace(/^(?:mut|const|readonly)\s+/, '');
    if (/^(?:Self|this|static|self|\$this)$/.test(bare)) return this.enclosingType(s.parent) ?? null;
    const unwrapped = /^(?:Promise|Result|Option|Task|ValueTask|Future|Mono)<\s*([^,<>]+(?:<[^<>]*>)?)/.exec(bare)?.[1] ?? bare;
    const goQ = info?.lang === 'go' ? /^\*?([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(unwrapped) : null;
    if (goQ) return this.goQualifiedType(s.file, goQ[1], goQ[2]) ?? null;
    const declared = declaredType(unwrapped);
    if (declared === BUILTIN) return BUILTIN;
    const tname = declared ?? baseTypeName(unwrapped);
    if (!tname) return null;
    // a type parameter (`<T> T get()`, `S uri(...)` in `UriSpec<S extends ...>`): unknown here
    if (/^[A-Z][A-Z0-9]?$/.test(tname) || new RegExp(`<[^>]*\\b${tname}\\b`).test(sig.slice(0, sig.indexOf('(') + 1 || sig.length))) return null;
    if (tname === 'Self') return this.enclosingType(s.parent) ?? null;
    return this.resolveType(tname, { id: 0, file: s.file, from: s.id, name: tname, qualifier: null, kind: 'type_ref', hint: null, to: null });
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

/**
 * Return type text from a stored signature: `public List<Foo> name(...)` (Java, C#), `fun name(...): Foo`
 * (Kotlin), `def name(...)(...): Foo` (Scala), `name(...): Foo` (TypeScript, PHP), `-> Foo` (Rust, Python),
 * `func (r *X) Name(...) (*Foo, error)` (Go). Undefined when the signature does not say.
 */
export function returnTypeText(sig: string, name: string, lang: string): string | undefined {
  const esc = name.replace(/[$]/g, '\\$&');
  const at = new RegExp(`(^|[^\\w$])${esc}\\s*(?:<[^()]*?>\\s*)?\\(`).exec(sig);
  if (!at) return undefined;
  const nameStart = at.index + at[1].length;
  if (lang === 'java' || lang === 'c_sharp') {
    const head = sig.slice(0, nameStart).replace(/@[\w.]+(?:\([^)]*\))?/g, ' ').trimEnd();
    // last top-level token, generics included: `Map<String, List<Foo>>`, `Task<User>`, `Foo[]`
    let depth = 0;
    let k = head.length - 1;
    for (; k >= 0; k--) {
      const c = head[k];
      if (c === '>') depth++;
      else if (c === '<') depth--;
      else if (depth === 0 && /\s/.test(c)) break;
    }
    const token = head.slice(k + 1);
    return token && !JAVA_MODIFIERS.has(token) && !token.startsWith('<') ? token : undefined;
  }
  // skip the parameter list(s)
  let i = sig.indexOf('(', nameStart);
  let close = -1;
  for (;;) {
    if (i < 0 || sig[i] !== '(') break;
    let depth = 0;
    let j = i;
    for (; j < sig.length; j++) {
      if (sig[j] === '(') depth++;
      else if (sig[j] === ')' && --depth === 0) break;
    }
    if (j >= sig.length) return undefined;
    close = j;
    i = j + 1;
    while (sig[i] === ' ') i++;
    if (lang !== 'scala' || sig[i] !== '(') break;
  }
  if (close < 0) return undefined;
  const rest = sig.slice(close + 1).trim();
  if (lang === 'rust' || lang === 'python') {
    const m = /^->\s*(.+?)(?:\s+where\b.*)?$/.exec(rest);
    return m?.[1].trim();
  }
  if (lang === 'go') {
    if (!rest) return undefined;
    if (rest.startsWith('(')) {
      const first = rest.slice(1).split(',')[0].trim().split(/\s+/);
      return first[first.length - 1];
    }
    return rest.split(/\s+/)[0];
  }
  const m = /^:\s*(.+?)(?:\s*(?:=|\{|where\b).*)?$/.exec(rest);
  return m?.[1].trim();
}

const JAVA_MODIFIERS = new Set([
  'public', 'protected', 'private', 'static', 'final', 'abstract', 'synchronized', 'native', 'default', 'strictfp',
  'internal', 'virtual', 'override', 'sealed', 'async', 'extern', 'unsafe', 'new', 'partial', 'readonly', 'ref',
]);

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

const MAX_IMPORT_KEYS = 64;
const KEY_KINDS = "('class','interface','enum','type','struct','record','trait','module','namespace')";

/**
 * Words an import spec must contain to resolve to (or away from) the added / removed files: file stems, the
 * directory names of index files and packages, and the type names they declare (JVM/PHP imports name a class). Undefined
 * when there are too many to filter on (a large pull): every unresolved import is then retried.
 */
function importKeys(store: Store, g: Graph, scope: ResolveScope): string[] | undefined {
  const keys = new Set<string>();
  const addPath = (p: string) => {
    const stem = stemOf(p);
    if (stem) keys.add(stem);
    // a directory is imported by name only through its index / __init__ file (`./dir`, `pkg.sub`); a directory
    // word such as `shard` or `index` would select thousands of unrelated specs
    if (stem === 'index' || stem === '__init__' || stem === 'mod') {
      const dir = dirOf(p);
      const base = dir.slice(dir.lastIndexOf('/') + 1);
      if (base) keys.add(base);
    }
  };
  const types = store.prepare(`SELECT DISTINCT name FROM symbols WHERE file_id = ? AND kind IN ${KEY_KINDS} LIMIT 64`);
  for (const id of scope.addedFileIds) {
    const f = g.files.get(id);
    if (f) addPath(f.path);
    for (const r of types.iterate(id) as Iterable<{ name: string }>) if (r.name) keys.add(r.name);
    if (keys.size > MAX_IMPORT_KEYS) return undefined;
  }
  for (const p of scope.removedPaths ?? []) addPath(p);
  if (scope.removedFileIds.size && !scope.removedPaths) return undefined;
  return keys.size > MAX_IMPORT_KEYS ? undefined : [...keys];
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
  const res = new Resolver(store, scope.full, scope.root);
  debug('preload', t0);
  const stats: ResolveStats = { refsConsidered: 0, refsResolved: 0, importsResolved: 0, durationMs: 0 };

  // A. file_imports targets
  {
    const updates: Array<[number, number | null]> = [];
    const rows: Array<{ rowid: number; file: number; spec: string; target: number | null }> = [];
    const sel = 'SELECT rowid, file_id AS file, spec, target_file_id AS target FROM file_imports';
    // Never `rows.push(...all())`: spreading every row as a call argument overflows the stack past ~110k rows
    // (a 30k-file Java repository has over 500k import lines).
    if (scope.full) for (const r of store.db.prepare(sel).iterate() as Iterable<(typeof rows)[number]>) rows.push(r);
    else {
      const byFile = store.db.prepare(`${sel} WHERE file_id = ?`);
      for (const id of scope.changedFileIds) for (const r of byFile.iterate(id) as Iterable<(typeof rows)[number]>) rows.push(r);
      if (scope.addedFileIds.size || scope.removedFileIds.size) {
        const seen = new Set(rows.map((r) => r.rowid));
        const take = (it: Iterable<unknown>) => {
          for (const r of it as Iterable<(typeof rows)[number]>) if (!seen.has(r.rowid)) (seen.add(r.rowid), rows.push(r));
        };
        // Unresolved imports that the added/removed files could change (an ES-size repository has 200k of them:
        // re-trying them all took ~1 s and 140 MB for each new file)
        const keys = importKeys(store, res.g, scope);
        if (keys === undefined) take(store.db.prepare(`${sel} WHERE target_file_id IS NULL`).iterate());
        else if (keys.length) {
          const like = keys.map(() => "spec LIKE ? ESCAPE '\\'").join(' OR ');
          take(store.db.prepare(`${sel} WHERE target_file_id IS NULL AND (${like})`).iterate(...keys.map((k) => `%${k.replace(/[\\%_]/g, '\\$&')}%`)));
        }
        if (scope.removedFileIds.size) take(store.db.prepare(`${sel} WHERE target_file_id IN (${[...scope.removedFileIds].join(',')})`).iterate());
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
  const totalRefs = scope.full ? (store.db.prepare('SELECT count(*) AS n FROM refs').get() as { n: number }).n : undefined;
  scope.onProgress?.(0, totalRefs);
  // B. import refs, C. inheritance, D. everything else. Each phase is written before the next reads it.
  const phases: Array<{ kinds: string[]; fn: (r: RefRow) => number | null }> = [
    { kinds: ['import'], fn: (r) => res.resolveImportRef(r) },
    { kinds: ['inherit', 'implement'], fn: (r) => res.resolveRef(r) },
    { kinds: ['call', 'new', 'type_ref', 'read', 'write'], fn: (r) => res.resolveRef(r) },
  ];
  let lastFile = -1;
  for (const [i, phase] of phases.entries()) {
    const supers = new Map<number, number[]>();
    const importTargets = new Map<number, number | null>();
    for (const rows of refRows(store, scope, phase.kinds)) {
      const updates: Array<[number, number | null]> = [];
      for (const r of rows) {
        if (r.file !== lastFile) {
          if (lastFile !== -1) res.endFile();
          lastFile = r.file;
        }
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
      scope.onProgress?.(stats.refsConsidered, totalRefs);
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
