import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultConfig, type KoptConfig } from '../src/core/config.js';
import { extractFile, indexRepo, refreshIndex } from '../src/indexer/index.js';
import { extractFileWithin } from '../src/indexer/parse.js';
import { Writer } from '../src/indexer/writer.js';
import { Store } from '../src/store/store.js';
import { rmTree } from './helpers/fs.js';

const N = 3000;
const chain = (sep: string) => Array.from({ length: N }, (_, i) => `a${i}`).join(sep);
const calls = Array.from({ length: N }, (_, i) => `f${i}()`).join(' + ');

describe('deeply nested code', () => {
  // tree-sitter builds `a + b + c ...` left-deep: a long chain is thousands of levels deep
  const cases: Record<string, string> = {
    'x.ts': `export function before() {}\nconst x = ${chain(' + ')};\nconst y = ${calls};\nexport function after() { return go(); }\n`,
    'x.js': `function before() {}\nmodule.exports = ${chain(' || ')};\nfunction after() { go(); }\n`,
    'x.py': `def before(): pass\nx = ${chain(' + ')}\ny = ${calls}\ndef after():\n    go()\n`,
    'X.java': `class X { void before() {} int x = ${chain(' + ')}; int y = ${calls}; void after() { go(); } }\n`,
    'X.cs': `class X { void before() {} int x = ${chain(' + ')}; void after() { Go(); } }\n`,
    'x.go': `package p\nfunc before() {}\nvar x = ${chain(' + ')}\nfunc after() { goo() }\n`,
    'x.kt': `fun before() {}\nval x = ${chain(' + ')}\nfun after() { go() }\n`,
    'x.rs': `fn before() {}\nconst X: i32 = ${chain(' + ')};\nfn after() { go(); }\n`,
    'x.php': `<?php\nfunction before() {}\n$x = ${chain(' . ').replace(/a/g, '$a')};\nfunction after() { go(); }\n`,
    'x.rb': `def before; end\nX = ${chain(' + ')}\ndef after; go; end\n`,
    'x.scala': `object O { def before() = 1\n val x = ${chain(' + ')}\n def after() = go() }\n`,
    'paren.ts': `export function before() {}\nconst x = ${'('.repeat(N)}1${')'.repeat(N)};\nexport function after() { go(); }\n`,
    'elif.ts': `export function before() {}\nexport function mid(v) { ${Array.from({ length: 1000 }, (_, i) => `if (v === ${i}) { h${i}(); }`).join(' else ')} }\nexport function after() { go(); }\n`,
  };

  for (const [path, code] of Object.entries(cases)) {
    it(`keeps every declaration of ${path}`, async () => {
      const f = await extractFile(path, code);
      expect(f).toBeDefined();
      const names = f!.symbols.map((s) => s.name.toLowerCase());
      expect(names).toContain('before');
      expect(names).toContain('after');
    });
  }

  it('still records the calls found below the depth bound', async () => {
    const f = await extractFile('x.ts', cases['x.ts']);
    const called = new Set(f!.refs.filter((r) => r.kind === 'call').map((r) => r.name));
    expect(called.has('f0')).toBe(true);
    expect(called.has(`f${N - 1}`)).toBe(true);
    expect(called.has('go')).toBe(true);
    const mid = await extractFile('elif.ts', cases['elif.ts']);
    const midId = mid!.symbols.findIndex((s) => s.name === 'mid');
    // calls deep inside the else-if chain stay attributed to their function
    expect(mid!.refs.filter((r) => r.kind === 'call' && r.name === 'h999').map((r) => r.fromSymbol)).toEqual([midId]);
  });
});

// ------------------------------------------------------------------------------------------------ index level

const tmpRoots: string[] = [];
afterAll(() => {
  for (const r of tmpRoots) rmTree(r);
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}

function put(root: string, rel: string, text: string, when?: number): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, text);
  if (when) utimesSync(abs, when, when);
}

function openIndex(root: string): { store: Store; config: KoptConfig } {
  const config = defaultConfig(root);
  config.dataDir = join(root, '.kopt');
  return { store: Store.open(join(root, '.kopt', 'index.db'), { root }), config };
}

const ids = (store: Store) =>
  Object.fromEntries((store.db.prepare('SELECT qname, id FROM symbols ORDER BY id').all() as Array<{ qname: string; id: number }>).map((r) => [r.qname, r.id]));
const filePaths = (store: Store) => (store.db.prepare('SELECT path FROM files ORDER BY path').all() as Array<{ path: string }>).map((r) => r.path);

let hasGit = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  hasGit = false;
}

function trySymlink(target: string, path: string, type?: 'dir' | 'file'): boolean {
  try {
    symlinkSync(target, path, type);
    return true;
  } catch {
    return false; // Windows without the symlink privilege
  }
}

describe('symlinks', () => {
  it.runIf(hasGit)('never indexes files reached through a symlink, tracked or reported by hooks', async () => {
    const outside = tmp('kopt-outside-');
    put(outside, 'secret.ts', 'export const AWS_SECRET_TOKEN = "s3cr3t";\n');
    put(outside, 'dir/leak.ts', 'export function leakedHelper() {}\n');
    const root = tmp('kopt-links-');
    put(root, 'src/real.ts', 'export function realThing() {}\n');
    const linked =
      trySymlink(join(outside, 'secret.ts'), join(root, 'src', 'secret.ts'), 'file') &&
      trySymlink('real.ts', join(root, 'src', 'alias.ts'), 'file') &&
      trySymlink(join(outside, 'dir'), join(root, 'linked'), 'dir');
    if (!linked) return;
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root, stdio: 'ignore' });
    git('init', '-q');
    git('add', '-A');
    git('commit', '-qm', 'init');
    const { store, config } = openIndex(root);
    try {
      await indexRepo(store, { config });
      expect(filePaths(store)).toEqual(['src/real.ts']);
      // hook-reported paths: the link itself and a file below a linked directory
      await refreshIndex(store, { config, paths: ['src/secret.ts', 'linked/leak.ts', join(root, 'linked', 'leak.ts')] });
      expect(filePaths(store)).toEqual(['src/real.ts']);
      const names = (store.db.prepare('SELECT name FROM symbols').all() as Array<{ name: string }>).map((r) => r.name);
      expect(names).toEqual(['realThing']);
    } finally {
      store.close();
    }
  });
});

describe('hook-reported paths', () => {
  it('uses the on-disk spelling on case-insensitive filesystems (no duplicate file)', async () => {
    const root = tmp('kopt-case-');
    put(root, 'src/UserService.ts', 'export class UserService { find() {} }\n');
    if (!existsSync(join(root, 'src', 'userservice.ts'))) return; // case-sensitive filesystem
    const { store, config } = openIndex(root);
    try {
      await indexRepo(store, { config });
      put(root, 'src/UserService.ts', 'export class UserService { find() {} save() {} }\n', Date.now() / 1000 + 60);
      await refreshIndex(store, { config, paths: ['src/userservice.ts'] });
      expect(filePaths(store)).toEqual(['src/UserService.ts']);
      expect(Object.keys(ids(store))).toEqual(['UserService', 'UserService.find', 'UserService.save']);
    } finally {
      store.close();
    }
  });
});

describe('symbol ids', () => {
  it('come back when a removed symbol or a deleted file comes back', async () => {
    const root = tmp('kopt-ids-');
    const v1 = 'export class Cart {\n  add() {}\n  total() { return 1; }\n}\nexport function helper() {}\n';
    let clock = Date.now() / 1000 + 100;
    put(root, 'src/cart.ts', v1, clock);
    put(root, 'src/other.ts', "import { helper } from './cart';\nexport function other() { helper(); }\n", clock);
    const { store, config } = openIndex(root);
    try {
      await indexRepo(store, { config });
      const before = ids(store);
      const helperRef = () => (store.db.prepare("SELECT to_symbol_id AS t FROM refs WHERE name = 'helper' AND kind = 'call'").get() as { t: number | null }).t;
      expect(helperRef()).toBe(before['helper']);
      // an edit that loses `total` (typing in progress), then the fix
      put(root, 'src/cart.ts', 'export class Cart {\n  add() {}\n}\nexport function helper() {}\n', (clock += 5));
      await refreshIndex(store, { config, paths: ['src/cart.ts'] });
      expect(ids(store)['Cart.total']).toBeUndefined();
      put(root, 'src/cart.ts', v1, (clock += 5));
      await refreshIndex(store, { config, paths: ['src/cart.ts'] });
      expect(ids(store)).toEqual(before);
      // the file disappears (branch switch) and comes back
      unlinkSync(join(root, 'src', 'cart.ts'));
      await refreshIndex(store, { config });
      expect(ids(store)['Cart']).toBeUndefined();
      put(root, 'src/cart.ts', v1, (clock += 5));
      await refreshIndex(store, { config });
      expect(ids(store)).toEqual(before);
      // and refs from other files point at it again
      expect(helperRef()).toBe(before['helper']);
      // a new symbol never takes an id that was used before
      put(root, 'src/cart.ts', v1 + 'export function fresh() {}\n', (clock += 5));
      await refreshIndex(store, { config, paths: ['src/cart.ts'] });
      expect(ids(store)['fresh']).toBeGreaterThan(Math.max(...Object.values(before)));
    } finally {
      store.close();
    }
  });

  it('keeps the retired table bounded', async () => {
    const root = tmp('kopt-retired-');
    let clock = Date.now() / 1000 + 100;
    const many = (n: number) => Array.from({ length: n }, (_, i) => `export function f${i}() {}`).join('\n') + '\n';
    put(root, 'a.ts', many(30), clock);
    const { store, config } = openIndex(root);
    try {
      await indexRepo(store, { config });
      put(root, 'a.ts', 'export const x = 1;\n', (clock += 5));
      await refreshIndex(store, { config, paths: ['a.ts'] });
      const count = () => (store.db.prepare('SELECT count(*) AS n FROM idx_retired').get() as { n: number }).n;
      expect(count()).toBe(30);
      const w = new Writer(store);
      (w as unknown as { retiredAdded: number }).retiredAdded = 1;
      w.pruneRetired(10);
      expect(count()).toBeLessThanOrEqual(10);
    } finally {
      store.close();
    }
  });
});

describe('parse timeouts', () => {
  it('are reported as such, and retried by the next pass instead of dropping the file for good', async () => {
    const big = Array.from({ length: 20000 }, (_, i) => `export function f${i}() { return ${i}; }`).join('\n');
    expect(await extractFileWithin('big.ts', big, 0)).toBe('timeout');
    const root = tmp('kopt-timeout-');
    put(root, 'a.ts', 'export function a() {}\n', Date.now() / 1000 + 100);
    const { store, config } = openIndex(root);
    try {
      await indexRepo(store, { config });
      // simulate a timeout recorded by a pass that ran on a starved machine
      const st = store.db.prepare("SELECT size, mtime_ms FROM files WHERE path = 'a.ts'").get() as { size: number; mtime_ms: number };
      store.db.exec("DELETE FROM symbols_fts; DELETE FROM files WHERE path = 'a.ts'");
      store.db.prepare("INSERT INTO idx_skipped(path, size, mtime_ms, reason) VALUES ('a.ts', ?, ?, 'timeout')").run(st.size, st.mtime_ms);
      await refreshIndex(store, { config });
      expect(filePaths(store)).toEqual(['a.ts']);
      // other skip reasons stand until the file changes
      store.db.exec("DELETE FROM symbols_fts; DELETE FROM files WHERE path = 'a.ts'");
      store.db.prepare("INSERT OR REPLACE INTO idx_skipped(path, size, mtime_ms, reason) VALUES ('a.ts', ?, ?, 'parse')").run(st.size, st.mtime_ms);
      await refreshIndex(store, { config });
      expect(filePaths(store)).toEqual([]);
    } finally {
      store.close();
    }
  });
});
