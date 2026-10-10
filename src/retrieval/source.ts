// File text access with staleness detection: the index may lag behind the working tree, so symbol line
// ranges are re-located before slicing source text.

import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtractedFile, ExtractedSymbol } from '../core/types.js';
import type { FileRow, SymbolRow } from '../store/schema.js';
import type { Store } from '../store/store.js';
import { staysInside } from './access.js';
import { sha1 } from './common.js';

export interface Source {
  path: string;
  text: string;
  lines: string[];
  /** File on disk differs from what was indexed. */
  stale: boolean;
  file?: FileRow;
  hash?: string;
}

export function loadSource(store: Store, path: string, file?: FileRow): Source | undefined {
  // Never follow a link out of the project (a symlink committed in a cloned repository).
  if (store.root && !staysInside(store.root, join(store.root, path))) return undefined;
  const row = file ?? store.fileByPath(path);
  let raw: string | undefined;
  try {
    raw = store.readText(row ?? path);
  } catch {
    return undefined;
  }
  if (raw === undefined) return undefined;
  // The indexer hashes the raw bytes but parses the text without its BOM (line numbers are the same either
  // way); returned code never carries the BOM nor the CR of CRLF files.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const src: Source = { path, text, lines: splitLines(text), stale: false, file: row };
  if (row && store.root) {
    let st: { size: number; mtimeMs: number } | undefined;
    try {
      st = statSync(join(store.root, path));
    } catch {
      st = undefined;
    }
    if (st) {
      const sameMeta = st.size === row.size && row.mtime_ms > 0 && Math.abs(Math.floor(st.mtimeMs) - row.mtime_ms) <= 1;
      if (!sameMeta) {
        src.hash = sha1(raw);
        src.stale = src.hash !== row.hash;
      }
    }
  }
  return src;
}

/**
 * Lines as the indexer counts them (tree-sitter rows end at `\n`), without the `\r` of CRLF endings. A stray
 * `\r` at the end of a line (mixed endings) is dropped too; a lone `\r` inside a line is not a line break.
 */
export function splitLines(text: string): string[] {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.charCodeAt(l.length - 1) === 13) lines[i] = l.replace(/\r+$/, '');
  }
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function sliceLines(src: Source, start: number, end: number): string {
  return src.lines.slice(Math.max(0, start - 1), Math.max(0, end)).join('\n');
}

// ---------------------------------------------------------------------------------------------
// Background re-extraction (extractFile is async; retrieval tools are sync by contract, so the first
// call on a stale file uses the heuristic relocation and later calls get exact lines).

interface ExtractEntry {
  hash: string;
  file: ExtractedFile;
}
const extractCache = new WeakMap<Store, Map<string, ExtractEntry>>();
const pending = new Set<string>();
export type Extractor = (path: string, text: string) => Promise<ExtractedFile | undefined>;
let injected: Extractor | undefined;
let lazyExtractor: Promise<Extractor | undefined> | undefined;
let reextractEnabled = process.env.KOPT_NO_REEXTRACT !== '1';

/** Tests / embedders can disable the background parse. */
export function setReextract(enabled: boolean): void {
  reextractEnabled = enabled;
}

/**
 * Inject the parser used to re-extract stale files (e.g. the indexer's `extractFile`). Without it, the
 * indexer module is imported lazily on first need, and its absence is tolerated.
 */
export function setExtractor(fn: Extractor | undefined): void {
  injected = fn;
}

function extractor(): Promise<Extractor | undefined> {
  if (injected) return Promise.resolve(injected);
  // Non-literal specifier: the indexer is developed separately and may be absent.
  const spec = '../indexer/index.js';
  lazyExtractor ??= import(spec).then(
    (m: { extractFile?: unknown }) => (typeof m?.extractFile === 'function' ? (m.extractFile as Extractor) : undefined),
    () => undefined,
  );
  return lazyExtractor;
}

function scheduleExtract(store: Store, src: Source): void {
  if (!reextractEnabled || !src.hash) return;
  const key = `${store.path}\0${src.path}\0${src.hash}`;
  if (pending.has(key)) return;
  pending.add(key);
  const hash = src.hash;
  extractor()
    .then((fn) => (fn ? fn(src.path, src.text) : undefined))
    .then((ef) => {
      if (!ef) return;
      let m = extractCache.get(store);
      if (!m) extractCache.set(store, (m = new Map()));
      m.set(src.path, { hash, file: ef });
    })
    .catch(() => undefined)
    .finally(() => pending.delete(key));
}

/** Resolves when pending background extractions settle (tests). */
export async function settleExtractions(timeoutMs = 5000): Promise<void> {
  const t0 = Date.now();
  while (pending.size && Date.now() - t0 < timeoutMs) await new Promise((r) => setTimeout(r, 10));
}

function extracted(store: Store, src: Source): ExtractedFile | undefined {
  const e = extractCache.get(store)?.get(src.path);
  return e && e.hash === src.hash ? e.file : undefined;
}

/** Fresh parse of a stale file when available; otherwise schedules one and returns undefined. */
export function currentExtraction(store: Store, src: Source): ExtractedFile | undefined {
  if (!src.stale) return undefined;
  const ef = extracted(store, src);
  if (!ef) scheduleExtract(store, src);
  return ef;
}

export type LocateHow = 'exact' | 'extracted' | 'relocated' | 'stale';

export interface Located {
  start: number;
  end: number;
  how: LocateHow;
}

/** Current line range of `sym` in `src` (which may have changed since indexing). */
export function locate(store: Store, src: Source, sym: SymbolRow): Located {
  const n = src.lines.length;
  const clamp = (x: number) => Math.min(Math.max(1, x), Math.max(1, n));
  if (!src.stale) return { start: clamp(sym.start_line), end: clamp(sym.end_line), how: 'exact' };
  const ef = extracted(store, src);
  if (ef) {
    const m = bestExtracted(ef.symbols, sym, overloadOrdinal(store, sym));
    if (m) return { start: clamp(m.startLine), end: clamp(m.endLine), how: 'extracted' };
  } else scheduleExtract(store, src);
  const r = relocate(src, sym);
  if (r) return { ...r, how: 'relocated' };
  return { start: clamp(sym.start_line), end: clamp(sym.end_line), how: 'stale' };
}

const OVERLOADS_SQL = 'SELECT id FROM symbols WHERE file_id = ? AND name = ? AND kind = ? AND qname = ? ORDER BY start_line, id';

/** Position of `sym` among the indexed symbols of its file sharing its name, kind and qualified name (overloads). */
export function overloadOrdinal(store: Store, sym: SymbolRow): { index: number; count: number } {
  try {
    const ids = (store.prepare(OVERLOADS_SQL).all(sym.file_id, sym.name, sym.kind, sym.qname) as unknown as Array<{ id: number }>).map((r) => r.id);
    return { index: Math.max(0, ids.indexOf(sym.id)), count: ids.length };
  } catch {
    return { index: 0, count: 1 };
  }
}

/**
 * The freshly extracted symbol that is `sym`: same name and kind, same qualified name, then the same signature,
 * then (overloads) the same position among its namesakes, and only then the nearest start line.
 */
export function bestExtracted(list: ExtractedSymbol[], sym: SymbolRow, ordinal = { index: 0, count: 1 }): ExtractedSymbol | undefined {
  const named = list.filter((s) => s.name === sym.name && s.kind === sym.kind);
  if (!named.length) return undefined;
  const sameQ = named.filter((s) => s.qualifiedName === sym.qname || sym.qname.endsWith('.' + s.qualifiedName) || s.qualifiedName.endsWith('.' + sym.qname));
  const pool = sameQ.length ? sameQ : named;
  const sig = norm(sym.signature);
  const bySig = pool.filter((s) => norm(s.signature) === sig);
  if (bySig.length === 1) return bySig[0];
  // Same number of namesakes as when indexed: the k-th overload is still the k-th.
  if (!bySig.length && sameQ.length > 1 && sameQ.length === ordinal.count) return [...sameQ].sort((a, b) => a.startLine - b.startLine)[ordinal.index];
  let best: ExtractedSymbol | undefined;
  let bestD = Infinity;
  for (const s of bySig.length ? bySig : pool) {
    const d = Math.abs(s.startLine - sym.start_line);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Heuristic: find the declaration line (contains the name and its normalized prefix up to the name is
 * part of the indexed signature) nearest to the old position, then find the block end.
 */
export function relocate(src: Source, sym: SymbolRow): { start: number; end: number } | undefined {
  const name = sym.name;
  if (!name) return undefined;
  const sig = norm(sym.signature);
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rx = new RegExp(`(^|[^A-Za-z0-9_$])${esc}(?![A-Za-z0-9_$])`);
  // What the declaration has before the name ("public void", "def", "func (s *Server)"): a call site such as
  // `validate(o);` contains the name too, but not this prefix.
  const inSig = rx.exec(sig);
  const sigBefore = inSig ? norm(sig.slice(0, inSig.index + inSig[1].length)) : '';
  let bestLine = -1;
  let bestD = Infinity;
  const lines = src.lines;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = rx.exec(line);
    if (!m) continue;
    const upto = norm(line.slice(0, m.index + m[0].length));
    if (!upto || !sig.includes(upto)) continue;
    const before = norm(line.slice(0, m.index + m[1].length));
    if (sigBefore ? !before || !sigBefore.endsWith(before) : /;\s*$/.test(line)) continue;
    const d = Math.abs(i + 1 - sym.start_line);
    if (d < bestD) {
      bestD = d;
      bestLine = i;
    }
  }
  if (bestLine < 0) return undefined;
  let start = bestLine;
  // Keep leading annotations/decorators that the original range included.
  while (start > 0 && /^\s*@/.test(lines[start - 1])) start--;
  const oldLen = Math.max(0, sym.end_line - sym.start_line);
  const end = blockEnd(lines, bestLine, src.path) ?? Math.min(lines.length - 1, bestLine + oldLen);
  return { start: start + 1, end: end + 1 };
}

const INDENT_LANGS = /\.(py|pyi|rb|yaml|yml)$/;

/** 0-based index of the last line of the block starting at `i`, or undefined. */
export function blockEnd(lines: string[], i: number, path: string): number | undefined {
  if (INDENT_LANGS.test(path)) {
    const indent = (s: string) => s.length - s.trimStart().length;
    const base = indent(lines[i]);
    let last = i;
    for (let j = i + 1; j < lines.length && j < i + 5000; j++) {
      const l = lines[j];
      if (!l.trim()) continue;
      if (indent(l) <= base) {
        if (/^\s*end\b/.test(l) && indent(l) === base) return j;
        break;
      }
      last = j;
    }
    return last;
  }
  let depth = 0;
  let opened = false;
  for (let j = i; j < lines.length && j < i + 5000; j++) {
    const l = lines[j]
      .replace(/\/\/.*$/, '')
      .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
    for (const c of l) {
      if (c === '{') {
        depth++;
        opened = true;
      } else if (c === '}') depth--;
    }
    if (opened && depth <= 0) return j;
    if (!opened && /;\s*$/.test(l)) return j;
  }
  return undefined;
}
