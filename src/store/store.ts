import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { META, SCHEMA_SQL, SCHEMA_VERSION, type FileRow, type SymbolRow } from './schema.js';

/**
 * Thin wrapper over node:sqlite. Write paths live in indexer/, read paths in retrieval/;
 * both use `store.db` with prepared statements cached through `store.prepare()`.
 */
export class Store {
  readonly db: DatabaseSync;
  readonly path: string;
  /** Repo root on disk (file text is read from there). Undefined for connections that only query the index. */
  root?: string;
  private stmts = new Map<string, StatementSync>();

  private constructor(path: string, db: DatabaseSync, root?: string) {
    this.path = path;
    this.db = db;
    this.root = root;
  }

  static open(path: string, opts: { root?: string; readonly?: boolean } = {}): Store {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path, { readOnly: !!opts.readonly });
    const store = new Store(path, db, opts.root);
    if (!opts.readonly) {
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA temp_store=MEMORY;');
      db.exec(SCHEMA_SQL);
      const v = store.getMeta(META.schemaVersion);
      if (v === undefined) store.setMeta(META.schemaVersion, String(SCHEMA_VERSION));
      else if (Number(v) !== SCHEMA_VERSION) {
        throw new Error(`index schema v${v} is incompatible with v${SCHEMA_VERSION}; delete ${path} and re-run 'kopt index'`);
      }
    } else {
      db.exec('PRAGMA foreign_keys=ON;');
    }
    return store;
  }

  /** Cached prepared statement. */
  prepare(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getMeta(key: string): string | undefined {
    const row = this.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  fileByPath(path: string): FileRow | undefined {
    return this.prepare('SELECT * FROM files WHERE path = ?').get(path) as FileRow | undefined;
  }

  fileById(id: number): FileRow | undefined {
    return this.prepare('SELECT * FROM files WHERE id = ?').get(id) as FileRow | undefined;
  }

  symbolById(id: number): SymbolRow | undefined {
    return this.prepare('SELECT * FROM symbols WHERE id = ?').get(id) as SymbolRow | undefined;
  }

  counts(): { files: number; symbols: number; refs: number } {
    const one = (sql: string) => (this.prepare(sql).get() as { n: number }).n;
    return {
      files: one('SELECT count(*) AS n FROM files'),
      symbols: one('SELECT count(*) AS n FROM symbols'),
      refs: one('SELECT count(*) AS n FROM refs'),
    };
  }

  /** Current text of a file, read from disk (always fresh). Undefined without a root or when the file is gone. */
  readText(file: FileRow | string): string | undefined {
    if (!this.root) return undefined;
    const abs = join(this.root, typeof file === 'string' ? file : file.path);
    return existsSync(abs) ? readFileSync(abs, 'utf8') : undefined;
  }

  close(): void {
    this.stmts.clear();
    this.db.close();
  }
}

/** Short, stable, model-friendly handle for a symbol id (e.g. 4711 -> "#3nj"). */
export function symbolHandle(id: number): string {
  return '#' + id.toString(36);
}

/** Inverse of symbolHandle. Accepts "#3nj" or "3nj". Returns undefined when not a handle. */
export function parseSymbolHandle(text: string): number | undefined {
  const m = /^#?([0-9a-z]{1,10})$/.exec(text.trim());
  if (!m || !text.trim().startsWith('#')) return undefined;
  const n = parseInt(m[1], 36);
  return Number.isFinite(n) ? n : undefined;
}
