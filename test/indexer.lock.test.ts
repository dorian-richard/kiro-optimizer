// One indexing pass at a time per project, across processes (src/indexer/lock.ts).
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultConfig, type KoptConfig } from '../src/core/config.js';
import { indexRepo, refreshIndex, type IndexPhase } from '../src/indexer/index.js';
import { lockHolder, STALE_MS, tryLock } from '../src/indexer/lock.js';
import { META } from '../src/store/schema.js';
import { Store } from '../src/store/store.js';

const FIX = join(import.meta.dirname, 'fixtures/indexer/sample-repo');
const dirs: string[] = [];

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'kopt-lock-'));
  dirs.push(d);
  return d;
}

function repo(): { root: string; cfg: KoptConfig; db: string } {
  const root = tmp();
  cpSync(FIX, root, { recursive: true });
  const cfg = defaultConfig(root);
  cfg.dataDir = join(root, '.kopt');
  return { root, cfg, db: join(root, '.kopt', 'index.db') };
}

/** pid of a process that has exited. */
function deadPid(): number {
  return Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).toString());
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('index lock', () => {
  it('is exclusive while held and free once released', () => {
    const path = join(tmp(), 'index.db.lock');
    const a = tryLock(path)!;
    expect(a).toBeDefined();
    expect(tryLock(path)).toBeUndefined();
    expect(lockHolder(path)?.pid).toBe(process.pid);
    a.release();
    expect(existsSync(path)).toBe(false);
    const b = tryLock(path);
    expect(b).toBeDefined();
    b!.release();
  });

  it('takes over a lock whose process is gone or that was not refreshed for a while', () => {
    const dir = tmp();
    const dead = join(dir, 'dead.lock');
    writeFileSync(dead, JSON.stringify({ pid: deadPid(), host: hostname(), token: 'x', at: Date.now() }));
    expect(lockHolder(dead)).toBeUndefined();
    const got = tryLock(dead);
    expect(got).toBeDefined();
    got!.release();

    const old = join(dir, 'old.lock');
    writeFileSync(old, JSON.stringify({ pid: process.pid, host: 'another-machine', token: 'y', at: 0 }));
    expect(lockHolder(old)?.host).toBe('another-machine');
    const past = (Date.now() - STALE_MS - 5_000) / 1000;
    utimesSync(old, past, past);
    expect(lockHolder(old)).toBeUndefined();
    const again = tryLock(old);
    expect(again).toBeDefined();
    again!.release();
  });

  it('a skip-mode pass does nothing while another process indexes; a wait-mode pass waits for it', async () => {
    const { root, cfg, db } = repo();
    const store = Store.open(db, { root });
    try {
      const held = tryLock(`${db}.lock`)!;
      const skipped = await refreshIndex(store, { config: cfg, lock: 'skip' });
      expect(skipped.locked).toBe(true);
      expect(store.getMeta(META.indexedAt)).toBeUndefined();

      const phases: IndexPhase[] = [];
      const t0 = Date.now();
      setTimeout(() => held.release(), 400);
      const stats = await indexRepo(store, { config: cfg, onPhase: (p) => phases.push(p) });
      expect(Date.now() - t0).toBeGreaterThanOrEqual(350);
      expect(phases[0]).toEqual({ phase: 'wait', holder: process.pid });
      expect(phases.map((p) => p.phase)).toContain('resolve');
      expect(stats.filesIndexed).toBeGreaterThan(5);
      expect(existsSync(`${db}.lock`)).toBe(false);
    } finally {
      store.close();
    }
  });

  it('two connections building the same index at once never collide (no UNIQUE failure)', async () => {
    const { root, cfg, db } = repo();
    const a = Store.open(db, { root });
    const b = Store.open(db, { root });
    try {
      const [sa, sb] = await Promise.all([indexRepo(a, { config: cfg }), indexRepo(b, { config: cfg })]);
      expect(sa.filesIndexed + sb.filesIndexed).toBe(sa.filesSeen);
      expect(Math.min(sa.filesIndexed, sb.filesIndexed)).toBe(0);
      const dup = a.db.prepare('SELECT count(*) AS n FROM (SELECT path FROM files GROUP BY path HAVING count(*) > 1)').get() as { n: number };
      expect(dup.n).toBe(0);
      expect(a.getMeta('idx_dirty')).toBe('0');
    } finally {
      a.close();
      b.close();
    }
  });

  it('opening the index while another process bulk-builds it neither fails nor rebuilds its dropped indexes', async () => {
    const { cfg, db } = repo();
    const a = Store.open(db, { root: cfg.root });
    await indexRepo(a, { config: cfg });
    // the other process: holds the pass lock, has dropped the secondary indexes, is inside a write transaction
    const held = tryLock(`${db}.lock`)!;
    a.db.exec('DROP INDEX IF EXISTS symbols_name');
    a.db.exec('BEGIN IMMEDIATE');
    a.setMeta('x', '1');
    const t0 = Date.now();
    const b = Store.open(db, { root: cfg.root }); // `kopt index` typed in a terminal: used to fail with "database is locked"
    expect(Date.now() - t0).toBeLessThan(2000);
    const names = () => (b.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'symbols_name'").all() as unknown[]).length;
    expect(names()).toBe(0);
    a.db.exec('COMMIT');
    held.release();
    b.close();
    // once nobody indexes, opening restores the missing indexes (a build that crashed midway)
    const c = Store.open(db, { root: cfg.root });
    expect((c.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'symbols_name'").all() as unknown[]).length).toBe(1);
    c.close();
    a.close();
  });
});
