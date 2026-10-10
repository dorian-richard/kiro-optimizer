// SQLite schema (node:sqlite, FTS5). Contract shared by indexer (writes) and retrieval (reads).

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id          INTEGER PRIMARY KEY,
  path        TEXT NOT NULL UNIQUE,      -- repo-relative, forward slashes
  lang        TEXT,                      -- Lang, NULL for non-code files we only track
  hash        TEXT NOT NULL,             -- sha1 of content
  size        INTEGER NOT NULL,
  line_count  INTEGER NOT NULL,
  mtime_ms    INTEGER NOT NULL DEFAULT 0,
  namespace   TEXT,                      -- package / namespace declared by the file
  rank        REAL NOT NULL DEFAULT 0,   -- file centrality (PageRank over import/ref graph), 0..1
  indexed_at  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS symbols (
  id          INTEGER PRIMARY KEY,
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  qname       TEXT NOT NULL,
  kind        TEXT NOT NULL,             -- SymbolKind
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL,
  start_byte  INTEGER NOT NULL,
  end_byte    INTEGER NOT NULL,
  signature   TEXT NOT NULL,
  doc         TEXT,
  parent_id   INTEGER,                   -- enclosing symbol id
  exported    INTEGER NOT NULL DEFAULT 0,
  rank        REAL NOT NULL DEFAULT 0    -- symbol centrality 0..1 (in-degree weighted), used as a ranking prior
);
CREATE INDEX IF NOT EXISTS symbols_name   ON symbols(name);
CREATE INDEX IF NOT EXISTS symbols_lname  ON symbols(lower(name));
CREATE INDEX IF NOT EXISTS symbols_qname  ON symbols(qname);
CREATE INDEX IF NOT EXISTS symbols_file   ON symbols(file_id);
CREATE INDEX IF NOT EXISTS symbols_parent ON symbols(parent_id);

CREATE TABLE IF NOT EXISTS refs (
  id             INTEGER PRIMARY KEY,
  file_id        INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  from_symbol_id INTEGER,                -- enclosing symbol (NULL = file level)
  name           TEXT NOT NULL,          -- referenced simple name
  qualifier      TEXT,
  kind           TEXT NOT NULL,          -- RefKind
  line           INTEGER NOT NULL,
  to_symbol_id   INTEGER                 -- resolved target (NULL = unresolved / external)
);
CREATE INDEX IF NOT EXISTS refs_name ON refs(name);
CREATE INDEX IF NOT EXISTS refs_to   ON refs(to_symbol_id);
CREATE INDEX IF NOT EXISTS refs_from ON refs(from_symbol_id);
CREATE INDEX IF NOT EXISTS refs_file ON refs(file_id);

CREATE TABLE IF NOT EXISTS file_imports (
  file_id        INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  spec           TEXT NOT NULL,          -- raw import specifier
  target_file_id INTEGER                 -- resolved file when possible
);
CREATE INDEX IF NOT EXISTS file_imports_file   ON file_imports(file_id);
CREATE INDEX IF NOT EXISTS file_imports_target ON file_imports(target_file_id);

-- Lexical index over symbols. rowid = symbols.id. Contentless: we only need matching + bm25.
-- No prefix index: FTS5 uses one only for prefix queries of exactly its length, and kopt's prefix queries are 4+
-- characters (indexes built by earlier versions have prefix='3', which works the same, only bigger).
-- Columns hold space-separated, lower-cased, code-aware terms (see indexer/terms.ts):
--   name_terms: full name + its sub-words (camelCase/snake_case split) + qualified name parts
--   sig_terms : identifiers from the signature (param names, types, return type)
--   path_terms: path segments + sub-words
--   doc       : doc comment text
--   body_terms: distinct identifiers used in the body
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
  name_terms, sig_terms, path_terms, doc, body_terms,
  content='', contentless_delete=1,
  tokenize='unicode61 remove_diacritics 2 tokenchars ''_'''
);
`;

/** bm25() column weights, in column order of symbols_fts. */
export const FTS_WEIGHTS = [10.0, 3.0, 2.0, 1.5, 1.0] as const;

export interface FileRow {
  id: number;
  path: string;
  lang: string | null;
  hash: string;
  size: number;
  line_count: number;
  mtime_ms: number;
  namespace: string | null;
  rank: number;
  indexed_at: number;
}

export interface SymbolRow {
  id: number;
  file_id: number;
  name: string;
  qname: string;
  kind: string;
  start_line: number;
  end_line: number;
  start_byte: number;
  end_byte: number;
  signature: string;
  doc: string | null;
  parent_id: number | null;
  exported: number;
  rank: number;
}

export interface RefRow {
  id: number;
  file_id: number;
  from_symbol_id: number | null;
  name: string;
  qualifier: string | null;
  kind: string;
  line: number;
  to_symbol_id: number | null;
}

/** Well-known meta keys. */
export const META = {
  schemaVersion: 'schema_version',
  /** git HEAD commit the index reflects (for files not locally modified). */
  commit: 'commit',
  indexedAt: 'indexed_at',
  toolVersion: 'tool_version',
} as const;
