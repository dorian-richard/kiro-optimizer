// Behaviour that only shows on large repositories (hundreds of thousands of rows), on synthetic indexes.
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/core/config.js';
import { indexRepo, refreshIndex } from '../src/indexer/index.js';
import { defaultWorkers } from '../src/indexer/pool.js';
import { resolveIndex } from '../src/indexer/resolve.js';
import { INDEXER_SQL } from '../src/indexer/writer.js';
import { Store } from '../src/store/store.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'kopt-scale-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const IMPORTS = 200_000;

/** A Java-like index with IMPORTS import specs spread over 2,000 files; one class `Target` in `p0/Target.java`. */
function seed(path: string): Store {
  const store = Store.open(path, { root: dir });
  store.db.exec(INDEXER_SQL);
  store.db.exec(`
    WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 2000)
    INSERT INTO files(id, path, lang, hash, size, line_count, namespace) SELECT x, 'p' || (x % 50) || '/F' || x || '.java', 'java', 'h', 1, 1, 'p' || (x % 50) FROM c;
    WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${IMPORTS})
    INSERT INTO file_imports(file_id, spec) SELECT 1 + (x % 2000), CASE WHEN x % 1000 = 0 THEN 'p0.Target' ELSE 'org.lib.Type' || (x % 5000) END FROM c;
  `);
  return store;
}

describe('resolution at scale', () => {
  it('resolves 200k import specs in a full pass (no argument spread of all rows)', async () => {
    const store = seed(join(dir, 'full.db'));
    try {
      store.db.exec(`INSERT INTO files(id, path, lang, hash, size, line_count, namespace) VALUES (5000, 'p0/Target.java', 'java', 'h', 1, 1, 'p0')`);
      store.db.exec(`INSERT INTO symbols(id, file_id, name, qname, kind, start_line, end_line, start_byte, end_byte, signature) VALUES (1, 5000, 'Target', 'p0.Target', 'class', 1, 1, 0, 1, 'class Target')`);
      const stats = await resolveIndex(store, {
        full: true,
        changedFileIds: new Set(),
        removedSymbolIds: new Set(),
        changedNames: new Set(),
        addedFileIds: new Set(),
        removedFileIds: new Set(),
      });
      expect(stats.importsResolved).toBe(IMPORTS / 1000);
      const n = (store.db.prepare('SELECT count(*) AS n FROM file_imports WHERE target_file_id = 5000').get() as { n: number }).n;
      expect(n).toBe(IMPORTS / 1000);
    } finally {
      store.close();
    }
  });

  it('re-resolves unresolved imports when a file is added, with 200k of them pending', async () => {
    const store = seed(join(dir, 'incr.db'));
    try {
      store.db.exec(`INSERT INTO files(id, path, lang, hash, size, line_count, namespace) VALUES (5000, 'p0/Target.java', 'java', 'h', 1, 1, 'p0')`);
      store.db.exec(`INSERT INTO symbols(id, file_id, name, qname, kind, start_line, end_line, start_byte, end_byte, signature) VALUES (1, 5000, 'Target', 'p0.Target', 'class', 1, 1, 0, 1, 'class Target')`);
      const stats = await resolveIndex(store, {
        full: false,
        changedFileIds: new Set([5000]),
        removedSymbolIds: new Set(),
        changedNames: new Set(['Target']),
        addedFileIds: new Set([5000]),
        removedFileIds: new Set(),
      });
      expect(stats.importsResolved).toBe(IMPORTS / 1000);
      const n = (store.db.prepare('SELECT count(*) AS n FROM file_imports WHERE target_file_id = 5000').get() as { n: number }).n;
      expect(n).toBe(IMPORTS / 1000);
    } finally {
      store.close();
    }
  });
});

describe('first-build memory', () => {
  it('uses at most 4 parse workers, 2 below 12 GB of memory, never more than cores - 1', () => {
    const GB = 2 ** 30;
    expect(defaultWorkers(10, 16 * GB)).toBe(4);
    expect(defaultWorkers(10, 8 * GB)).toBe(2);
    expect(defaultWorkers(3, 32 * GB)).toBe(2);
    expect(defaultWorkers(1, 32 * GB)).toBe(0);
  });

  it('creates the full-text index without a prefix index (kopt never queries prefixes that short)', () => {
    const store = Store.open(join(dir, 'schema.db'));
    try {
      const sql = (store.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'symbols_fts'").get() as { sql: string }).sql;
      expect(sql).not.toMatch(/prefix/);
    } finally {
      store.close();
    }
  });
});

describe('unresolved imports after files come and go', () => {
  it('retries only the imports the added or removed files can change, and still resolves them', async () => {
    const root = join(dir, 'ts-repo');
    const put = (rel: string, text: string) => {
      mkdirSync(join(root, rel, '..'), { recursive: true });
      writeFileSync(join(root, rel), text);
    };
    put('x/lib/util.ts', 'export function f(): number { return 1; }\n');
    put('y/lib/util.ts', 'export function f(): number { return 2; }\n');
    put('app/main.ts', "import { f } from '@/lib/util';\nimport { fmt } from './helpers/fmt';\nexport const v = f() + fmt();\n");
    const cfg = defaultConfig(root);
    cfg.dataDir = join(root, '.kopt');
    const store = Store.open(join(cfg.dataDir, 'index.db'), { root });
    const target = (spec: string) =>
      (store.db.prepare('SELECT f.path AS p FROM file_imports i LEFT JOIN files f ON f.id = i.target_file_id WHERE i.spec = ?').get(spec) as { p: string | null }).p;
    try {
      await indexRepo(store, { config: cfg });
      expect(target('@/lib/util')).toBeNull(); // two candidates: ambiguous
      expect(target('./helpers/fmt')).toBeNull();
      put('app/helpers/fmt.ts', 'export function fmt(): number { return 3; }\n');
      await refreshIndex(store, { config: cfg, paths: ['app/helpers/fmt.ts'] });
      expect(target('./helpers/fmt')).toBe('app/helpers/fmt.ts');
      unlinkSync(join(root, 'y/lib/util.ts'));
      await refreshIndex(store, { config: cfg, paths: ['y/lib/util.ts'] });
      expect(target('@/lib/util')).toBe('x/lib/util.ts');
    } finally {
      store.close();
    }
  });
});
