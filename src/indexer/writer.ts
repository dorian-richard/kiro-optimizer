// Persistence of extracted files. Symbol ids are stable across re-indexing of a file (matched by kind +
// qualified name + occurrence) and never reused once retired, so `#handles` already in a model's context
// keep pointing at the same symbol after edits, and refs from other files stay valid.

import type { StatementSync } from 'node:sqlite';
import { SCHEMA_SQL } from '../store/schema.js';
import type { Store } from '../store/store.js';
import type { IxFile } from './extract.js';
import type { Prepared } from './prepare.js';
import { ftsRows } from './fts.js';

/** Indexer-private tables (the shared schema has no room for resolution hints / skip markers). */
export const INDEXER_SQL = `
CREATE TABLE IF NOT EXISTS idx_ref_hints (
  ref_id INTEGER PRIMARY KEY,
  hint   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS idx_skipped (
  path     TEXT PRIMARY KEY,
  size     INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  reason   TEXT NOT NULL
);
`;

export const META_NEXT_SYMBOL = 'idx_next_symbol_id';

/** Secondary indexes of the shared schema on the tables we bulk-load (parsed so they stay in sync). */
function bulkIndexes(): Array<{ name: string; sql: string }> {
  const out: Array<{ name: string; sql: string }> = [];
  for (const m of SCHEMA_SQL.matchAll(/CREATE INDEX IF NOT EXISTS (\w+)\s+ON (symbols|refs|file_imports)\([^;]*\);/g)) out.push({ name: m[1], sql: m[0] });
  return out;
}

/**
 * First builds insert hundreds of thousands of rows: maintaining a dozen B-tree indexes row by row costs more
 * than rebuilding them once. Returns a function that recreates them (idempotent, also run by Store.open).
 */
export function dropSecondaryIndexes(store: Store): () => Promise<void> {
  const idx = bulkIndexes();
  for (const i of idx) store.db.exec(`DROP INDEX IF EXISTS ${i.name}`);
  return async () => {
    for (const i of idx) {
      store.db.exec(i.sql);
      // each rebuild is a long synchronous call: let the event loop (MCP requests) breathe in between
      await new Promise((r) => setImmediate(r));
    }
  };
}

export interface DbFile {
  id: number;
  size: number;
  mtime_ms: number;
  hash: string;
}

export interface WriteTracker {
  changedFileIds: Set<number>;
  addedFileIds: Set<number>;
  removedFileIds: Set<number>;
  removedSymbolIds: Set<number>;
  changedNames: Set<string>;
  filesIndexed: number;
  filesDeleted: number;
  filesSkipped: number;
}

export function newTracker(): WriteTracker {
  return {
    changedFileIds: new Set(),
    addedFileIds: new Set(),
    removedFileIds: new Set(),
    removedSymbolIds: new Set(),
    changedNames: new Set(),
    filesIndexed: 0,
    filesDeleted: 0,
    filesSkipped: 0,
  };
}

export class Writer {
  private nextId: number;
  private readonly s: Record<string, StatementSync>;

  constructor(private readonly store: Store) {
    store.db.exec(INDEXER_SQL);
    const max = (store.db.prepare('SELECT coalesce(max(id), 0) AS m FROM symbols').get() as { m: number }).m;
    this.nextId = Math.max(max + 1, Number(store.getMeta(META_NEXT_SYMBOL) ?? '1'));
    const p = (sql: string) => store.prepare(sql);
    this.s = {
      insFile: p('INSERT INTO files(path, lang, hash, size, line_count, mtime_ms, namespace, rank, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)'),
      updFile: p('UPDATE files SET lang = ?, hash = ?, size = ?, line_count = ?, mtime_ms = ?, namespace = ?, indexed_at = ? WHERE id = ?'),
      updStat: p('UPDATE files SET size = ?, mtime_ms = ? WHERE id = ?'),
      oldSyms: p('SELECT id, kind, qname, name, rank FROM symbols WHERE file_id = ? ORDER BY id'),
      delFts: p('DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE file_id = ?)'),
      delSyms: p('DELETE FROM symbols WHERE file_id = ?'),
      delHints: p('DELETE FROM idx_ref_hints WHERE ref_id IN (SELECT id FROM refs WHERE file_id = ?)'),
      delRefs: p('DELETE FROM refs WHERE file_id = ?'),
      delImports: p('DELETE FROM file_imports WHERE file_id = ?'),
      delFile: p('DELETE FROM files WHERE id = ?'),
      insSym: p(
        'INSERT INTO symbols(id, file_id, name, qname, kind, start_line, end_line, start_byte, end_byte, signature, doc, parent_id, exported, rank) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ),
      insFts: p('INSERT INTO symbols_fts(rowid, name_terms, sig_terms, path_terms, doc, body_terms) VALUES (?, ?, ?, ?, ?, ?)'),
      insRef: p('INSERT INTO refs(file_id, from_symbol_id, name, qualifier, kind, line) VALUES (?, ?, ?, ?, ?, ?)'),
      insHint: p('INSERT OR REPLACE INTO idx_ref_hints(ref_id, hint) VALUES (?, ?)'),
      insImport: p('INSERT INTO file_imports(file_id, spec) VALUES (?, ?)'),
      upsSkip: p('INSERT OR REPLACE INTO idx_skipped(path, size, mtime_ms, reason) VALUES (?, ?, ?, ?)'),
      delSkip: p('DELETE FROM idx_skipped WHERE path = ?'),
    };
  }

  /** Applies a batch of prepared files in one transaction. */
  writeBatch(items: Prepared[], dbFiles: Map<string, DbFile>, t: WriteTracker): void {
    if (!items.length) return;
    const now = Date.now();
    this.store.transaction(() => {
      for (const it of items) {
        const row = dbFiles.get(it.rel);
        switch (it.kind) {
          case 'gone':
            if (row) this.deleteFile(it.rel, row, dbFiles, t);
            break;
          case 'skip':
            if (row) this.deleteFile(it.rel, row, dbFiles, t);
            this.s.upsSkip.run(it.rel, it.size, Math.round(it.mtimeMs), it.reason);
            t.filesSkipped++;
            break;
          case 'same':
            if (row) {
              this.s.updStat.run(it.size, Math.round(it.mtimeMs), row.id);
              row.size = it.size;
              row.mtime_ms = Math.round(it.mtimeMs);
            }
            break;
          case 'file':
            this.writeFile(it, row, dbFiles, t, now);
            break;
        }
      }
      this.store.setMeta(META_NEXT_SYMBOL, String(this.nextId));
    });
  }

  private writeFile(it: Extract<Prepared, { kind: 'file' }>, row: DbFile | undefined, dbFiles: Map<string, DbFile>, t: WriteTracker, now: number): void {
    const f: IxFile = it.file;
    const mtime = Math.round(it.mtimeMs);
    let fileId: number;
    const reuse = new Map<string, Array<{ id: number; rank: number }>>();
    const oldNames = new Map<number, string>();
    if (row) {
      fileId = row.id;
      for (const o of this.s.oldSyms.all(fileId) as Array<{ id: number; kind: string; qname: string; name: string; rank: number }>) {
        const key = `${o.kind}\u0000${o.qname}`;
        (reuse.get(key) ?? reuse.set(key, []).get(key)!).push({ id: o.id, rank: o.rank });
        oldNames.set(o.id, o.name);
      }
      this.s.delFts.run(fileId);
      this.s.delSyms.run(fileId);
      this.s.delHints.run(fileId);
      this.s.delRefs.run(fileId);
      this.s.delImports.run(fileId);
      this.s.updFile.run(f.lang, it.hash, it.size, f.lineCount, mtime, f.namespace ?? null, now, fileId);
      row.size = it.size;
      row.mtime_ms = mtime;
      row.hash = it.hash;
    } else {
      fileId = Number(this.s.insFile.run(it.rel, f.lang, it.hash, it.size, f.lineCount, mtime, f.namespace ?? null, now).lastInsertRowid);
      dbFiles.set(it.rel, { id: fileId, size: it.size, mtime_ms: mtime, hash: it.hash });
      t.addedFileIds.add(fileId);
      this.s.delSkip.run(it.rel);
    }
    t.changedFileIds.add(fileId);
    t.filesIndexed++;

    // stable ids: same kind + qualified name (+ occurrence order for overloads) keeps the old id
    const ids: number[] = new Array(f.symbols.length);
    const ranks: number[] = new Array(f.symbols.length);
    for (let i = 0; i < f.symbols.length; i++) {
      const s = f.symbols[i];
      const old = reuse.get(`${s.kind}\u0000${s.qualifiedName}`)?.shift();
      if (old) {
        ids[i] = old.id;
        ranks[i] = old.rank;
        oldNames.delete(old.id);
      } else {
        ids[i] = this.nextId++;
        ranks[i] = 0;
        t.changedNames.add(s.name);
      }
    }
    for (const [id, name] of oldNames) {
      t.removedSymbolIds.add(id);
      t.changedNames.add(name);
    }

    const fts = it.fts ?? ftsRows(f);
    for (let i = 0; i < f.symbols.length; i++) {
      const s = f.symbols[i];
      const id = ids[i];
      this.s.insSym.run(
        id,
        fileId,
        s.name,
        s.qualifiedName,
        s.kind,
        s.startLine,
        s.endLine,
        s.startByte,
        s.endByte,
        s.signature,
        s.doc ?? null,
        s.parent !== undefined ? ids[s.parent] : null,
        s.exported ? 1 : 0,
        ranks[i],
      );
      const row = fts[i];
      this.s.insFts.run(id, row[0], row[1], row[2], row[3], row[4]);
    }
    for (const r of f.refs) {
      const res = this.s.insRef.run(fileId, r.fromSymbol !== undefined ? ids[r.fromSymbol] : null, r.name, r.qualifier ?? null, r.kind, r.line);
      if (r.hint) this.s.insHint.run(Number(res.lastInsertRowid), r.hint);
    }
    for (const spec of f.imports) this.s.insImport.run(fileId, spec);
  }

  /** Must run inside a transaction. */
  deleteFile(path: string, row: DbFile, dbFiles: Map<string, DbFile>, t: WriteTracker): void {
    for (const o of this.s.oldSyms.all(row.id) as Array<{ id: number; name: string }>) {
      t.removedSymbolIds.add(o.id);
      t.changedNames.add(o.name);
    }
    this.s.delFts.run(row.id);
    this.s.delHints.run(row.id);
    this.s.delFile.run(row.id); // cascades to symbols, refs, file_imports
    dbFiles.delete(path);
    t.removedFileIds.add(row.id);
    t.filesDeleted++;
  }

  forgetSkipped(paths: string[]): void {
    if (!paths.length) return;
    this.store.transaction(() => {
      for (const p of paths) this.s.delSkip.run(p);
    });
  }

  deleteFiles(paths: string[], dbFiles: Map<string, DbFile>, t: WriteTracker): void {
    if (!paths.length) return;
    this.store.transaction(() => {
      for (const p of paths) {
        const row = dbFiles.get(p);
        if (row) this.deleteFile(p, row, dbFiles, t);
        this.s.delSkip.run(p);
      }
    });
  }
}
