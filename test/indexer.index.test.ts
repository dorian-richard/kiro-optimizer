import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { defaultConfig, type KoptConfig } from '../src/core/config.js';
import { indexRepo, refreshIndex, type IndexStats } from '../src/indexer/index.js';
import { META } from '../src/store/schema.js';
import { Store } from '../src/store/store.js';

const FIX = join(import.meta.dirname, 'fixtures/indexer/sample-repo');
const tmpRoots: string[] = [];

function copyFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'kopt-idx-'));
  tmpRoots.push(root);
  cpSync(FIX, root, { recursive: true });
  return root;
}

function config(root: string): KoptConfig {
  const cfg = defaultConfig(root);
  cfg.dataDir = join(root, '.kopt');
  return cfg;
}

function open(root: string): Store {
  return Store.open(join(root, '.kopt', 'index.db'), { root });
}

/** Touches a file with a distinct mtime (same-second rewrites must still be seen as changes). */
let clock = Date.now() / 1000 + 10;
function write(root: string, rel: string, text: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, text);
  clock += 5;
  utimesSync(abs, clock, clock);
}

/** Target qname of the ref `name` made from symbol `fromQname`. */
function target(store: Store, fromQname: string, name: string, kind?: string): string | null | undefined {
  const row = store.db
    .prepare(
      `SELECT t.qname AS q FROM refs r JOIN symbols f ON f.id = r.from_symbol_id LEFT JOIN symbols t ON t.id = r.to_symbol_id
       WHERE f.qname = ? AND r.name = ? ${kind ? 'AND r.kind = ?' : ''} LIMIT 1`,
    )
    .get(...(kind ? [fromQname, name, kind] : [fromQname, name])) as { q: string | null } | undefined;
  return row === undefined ? undefined : row.q;
}

function symbolId(store: Store, qname: string): number | undefined {
  return (store.db.prepare('SELECT id FROM symbols WHERE qname = ?').get(qname) as { id: number } | undefined)?.id;
}

function ftsMatch(store: Store, query: string): string[] {
  return (
    store.db
      .prepare('SELECT s.qname AS q FROM symbols_fts JOIN symbols s ON s.id = symbols_fts.rowid WHERE symbols_fts MATCH ? ORDER BY bm25(symbols_fts, 10, 3, 2, 1.5, 1)')
      .all(query) as Array<{ q: string }>
  ).map((r) => r.q);
}

function paths(store: Store): string[] {
  return (store.db.prepare('SELECT path FROM files ORDER BY path').all() as Array<{ path: string }>).map((r) => r.path);
}

afterAll(() => {
  for (const r of tmpRoots) rmSync(r, { recursive: true, force: true });
});

describe('indexRepo (full build)', () => {
  let root: string;
  let store: Store;
  let stats: IndexStats;

  beforeAll(async () => {
    root = copyFixture();
    // files that must be skipped
    writeFileSync(join(root, 'py/payments/blob.py'), Buffer.from([0x23, 0x20, 0x00, 0x01, 0x02, 0x0a]));
    writeFileSync(join(root, 'ts/src/bundle.js'), 'var a=' + '1+'.repeat(3000) + '1;\n');
    writeFileSync(join(root, 'py/payments/huge.py'), 'X = 1\n'.repeat(20_000));
    const cfg = config(root);
    cfg.maxFileBytes = 50_000;
    store = open(root);
    const progress: number[] = [];
    stats = await indexRepo(store, { config: cfg, onProgress: (d) => progress.push(d) });
    expect(progress.length).toBeGreaterThan(0);
  });
  afterAll(() => store.close());

  it('indexes supported files and honors .gitignore-style rules, .kiroignore and config.exclude', () => {
    expect(paths(store)).toEqual([
      'cs/Billing/InvoiceService.cs',
      'cs/Billing/Models.cs',
      'go/ledger/ledger.go',
      'go/ledger/store.go',
      'java/com/acme/billing/DefaultRefundPolicy.java',
      'java/com/acme/billing/FeeCalculator.java',
      'java/com/acme/billing/Order.java',
      'java/com/acme/billing/RefundPolicy.java',
      'java/com/acme/billing/RefundService.java',
      'kt/com/acme/notify/Notifier.kt',
      'py/payments/__init__.py',
      'py/payments/gateway.py',
      'py/payments/models.py',
      'ts/src/orders/OrderService.ts',
      'ts/src/orders/money.ts',
    ]);
    expect(stats.filesIndexed).toBe(15);
    expect(stats.filesSkipped).toBe(3); // binary, minified, too large
    expect(stats.filesDeleted).toBe(0);
    const c = store.counts();
    expect(stats.symbols).toBe(c.symbols);
    expect(stats.refs).toBe(c.refs);
    expect(c.symbols).toBeGreaterThan(80);
  });

  it('records skipped files and does not re-read them while unchanged', async () => {
    const skipped = store.db.prepare('SELECT path, reason FROM idx_skipped ORDER BY path').all() as Array<{ path: string; reason: string }>;
    expect(skipped.map((s) => `${s.path}:${s.reason}`)).toEqual(['py/payments/blob.py:binary', 'py/payments/huge.py:large', 'ts/src/bundle.js:minified']);
    const cfg = config(root);
    cfg.maxFileBytes = 50_000;
    const again = await refreshIndex(store, { config: cfg });
    expect(again.filesIndexed).toBe(0);
    expect(again.filesSkipped).toBe(0);
    expect(again.filesUnchanged).toBe(15);
  });

  it('persists symbols with signatures, docs, parents and exported flags', () => {
    const m = store.db.prepare('SELECT * FROM symbols WHERE qname = ?').get('com.acme.billing.DefaultRefundPolicy.computeRefund') as Record<string, unknown>;
    expect(m.kind).toBe('method');
    expect(m.signature).toBe('@Override public BigDecimal computeRefund(Order order, BigDecimal requested)');
    expect(m.doc).toBe('Computes the refund.');
    expect(m.exported).toBe(1);
    expect(m.parent_id).toBe(symbolId(store, 'com.acme.billing.DefaultRefundPolicy'));
    const f = store.fileByPath('java/com/acme/billing/DefaultRefundPolicy.java')!;
    expect(f.lang).toBe('java');
    expect(f.namespace).toBe('com.acme.billing');
    expect(f.line_count).toBe(35);
    expect(f.hash).toMatch(/^[0-9a-f]{40}$/);
  });

  it('resolves calls through receiver types, imports, packages and class hierarchy', () => {
    // Java: field typed with the interface -> interface method; field typed with the class -> impl method
    expect(target(store, 'com.acme.billing.RefundService.refund', 'computeRefund')).toBe('com.acme.billing.RefundPolicy.computeRefund');
    expect(target(store, 'com.acme.billing.RefundService.refund', 'isEligible')).toBe('com.acme.billing.RefundPolicy.isEligible');
    expect(target(store, 'com.acme.billing.DefaultRefundPolicy.computeRefund', 'feeFor')).toBe('com.acme.billing.FeeCalculator.feeFor');
    expect(target(store, 'com.acme.billing.DefaultRefundPolicy.computeRefund', 'getPaidAmount')).toBe('com.acme.billing.Order.getPaidAmount');
    expect(target(store, 'com.acme.billing.RefundService.RefundService', 'DefaultRefundPolicy', 'new')).toBe('com.acme.billing.DefaultRefundPolicy');
    expect(target(store, 'com.acme.billing.DefaultRefundPolicy', 'RefundPolicy', 'implement')).toBe('com.acme.billing.RefundPolicy');
    expect(target(store, 'com.acme.billing.DefaultRefundPolicy', 'AbstractPolicy', 'inherit')).toBe('com.acme.billing.AbstractPolicy');
    // TS: named import, aliased import, typed parameter, this-call
    expect(target(store, 'OrderService.total', 'roundCents')).toBe('roundCents');
    expect(target(store, 'OrderService.describe', 'formatMoney')).toBe('formatMoney');
    expect(target(store, 'OrderService.describe', 'computeTotalSync')).toBe('OrderService.computeTotalSync');
    expect(target(store, 'placeOrder', 'total')).toBe('OrderService.total');
    // Python: annotated parameter + relative import (aliased)
    expect(target(store, 'payments.gateway.refund_charge', 'charge')).toBe('payments.gateway.PaymentGateway.charge');
    expect(target(store, 'payments.gateway.refund_charge', 'Refund', 'new')).toBe('payments.models.Refund');
    // Go: same package, other file (embedding) and composite literal
    expect(target(store, 'ledger.Ledger', 'Store', 'inherit')).toBe('ledger.Store');
    expect(target(store, 'ledger.NewLedger', 'Ledger', 'new')).toBe('ledger.Ledger');
    // C#: field type -> interface in another file of the namespace
    expect(target(store, 'Acme.Billing.InvoiceService.Send', 'Deliver')).toBe('Acme.Billing.IMailer.Deliver');
    expect(target(store, 'Acme.Billing.InvoiceService.Send', 'Render')).toBe('Acme.Billing.InvoiceService.Render');
    // Kotlin: constructor property type, implicit this
    expect(target(store, 'com.acme.notify.Notifier.notifyRefund', 'send')).toBe('com.acme.notify.EmailSender.send');
    expect(target(store, 'com.acme.notify.Notifier.notifyRefund', 'format')).toBe('com.acme.notify.Notifier.format');
  });

  it('leaves external and ambiguous references unresolved', () => {
    expect(target(store, 'com.acme.billing.DefaultRefundPolicy.MAX_FEE', 'BigDecimal', 'new')).toBeNull();
    expect(target(store, 'com.acme.billing.DefaultRefundPolicy.computeRefund', 'of')).toBeNull(); // List.of
    expect(target(store, 'com.acme.billing.DefaultRefundPolicy.computeRefund', 'subtract')).toBeNull();
    expect(target(store, 'ledger.NewLedger', 'Println')).toBeNull();
    expect(target(store, 'OrderService.total', 'reduce')).toBeNull();
    expect(target(store, 'Acme.Billing.InvoiceService.Render', 'ToString')).toBeNull();
  });

  it('resolves imports to files and symbols, including cross-language JVM imports', () => {
    const imp = (from: string, spec: string) =>
      (
        store.db
          .prepare('SELECT t.path AS p FROM file_imports i JOIN files f ON f.id = i.file_id LEFT JOIN files t ON t.id = i.target_file_id WHERE f.path = ? AND i.spec = ?')
          .get(from, spec) as { p: string | null }
      ).p;
    expect(imp('ts/src/orders/OrderService.ts', './money')).toBe('ts/src/orders/money.ts');
    expect(imp('ts/src/orders/OrderService.ts', 'node:path')).toBeNull();
    expect(imp('py/payments/gateway.py', '.models')).toBe('py/payments/models.py');
    expect(imp('kt/com/acme/notify/Notifier.kt', 'com.acme.billing.RefundService')).toBe('java/com/acme/billing/RefundService.java');
    const importTarget = store.db
      .prepare("SELECT t.qname AS q FROM refs r JOIN files f ON f.id = r.file_id LEFT JOIN symbols t ON t.id = r.to_symbol_id WHERE r.kind = 'import' AND f.path = ? AND r.name = ?")
      .get('kt/com/acme/notify/Notifier.kt', 'RefundService') as { q: string };
    expect(importTarget.q).toBe('com.acme.billing.RefundService');
  });

  it('builds a searchable FTS index with code-aware sub-words', () => {
    expect(ftsMatch(store, 'calculator')).toContain('com.acme.billing.FeeCalculator');
    expect(ftsMatch(store, 'name_terms:refund')[0]).toMatch(/refund/i);
    expect(ftsMatch(store, 'name_terms:computerefund')).toEqual(
      expect.arrayContaining(['com.acme.billing.RefundPolicy.computeRefund', 'com.acme.billing.DefaultRefundPolicy.computeRefund']),
    );
    // only the first sentence of a doc comment is kept
    expect(ftsMatch(store, 'doc:refunded')).toEqual(['com.acme.billing.RefundPolicy']);
    expect(ftsMatch(store, 'doc:stateless')).toEqual([]);
    expect(ftsMatch(store, 'path_terms:ledger').length).toBeGreaterThan(5);
    expect(ftsMatch(store, 'body_terms:localfee')).toEqual(['com.acme.billing.DefaultRefundPolicy.computeRefund']);
    expect(ftsMatch(store, 'roun*')).toContain('roundCents');
    const fts = store.db.prepare('SELECT count(*) AS n FROM symbols_fts').get() as { n: number };
    expect(fts.n).toBe(store.counts().symbols);
  });

  it('computes file and symbol ranks', () => {
    const rank = (p: string) => store.fileByPath(p)!.rank;
    expect(rank('java/com/acme/billing/Order.java')).toBe(1);
    expect(rank('java/com/acme/billing/RefundPolicy.java')).toBeGreaterThan(0);
    expect(rank('ts/src/orders/money.ts')).toBeGreaterThan(rank('ts/src/orders/OrderService.ts'));
    const srank = (q: string) => store.symbolById(symbolId(store, q)!)!.rank;
    expect(srank('com.acme.billing.Order')).toBeGreaterThan(0);
    expect(srank('com.acme.billing.Order')).toBeLessThanOrEqual(1);
    expect(srank('com.acme.billing.RefundPolicy.computeRefund')).toBeGreaterThan(0);
    expect(srank('payments.gateway._internal')).toBe(0);
  });

  it('sets meta', () => {
    expect(Number(store.getMeta(META.indexedAt))).toBeGreaterThan(0);
    expect(store.getMeta(META.toolVersion)).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('refreshIndex (incremental)', () => {
  let root: string;
  let store: Store;
  let cfg: KoptConfig;

  beforeAll(async () => {
    root = copyFixture();
    cfg = config(root);
    store = open(root);
    await indexRepo(store, { config: cfg });
  });
  afterAll(() => store.close());

  it('is a cheap no-op when nothing changed', async () => {
    const s = await refreshIndex(store, { config: cfg });
    expect(s).toMatchObject({ filesIndexed: 0, filesDeleted: 0, filesUnchanged: 15 });
    expect(s.refsConsidered).toBeUndefined();
  });

  it('re-indexes a modified file, keeps symbol ids stable and refs from other files valid', async () => {
    const feeForId = symbolId(store, 'com.acme.billing.FeeCalculator.feeFor');
    const classId = symbolId(store, 'com.acme.billing.FeeCalculator');
    write(
      root,
      'java/com/acme/billing/FeeCalculator.java',
      `package com.acme.billing;

import java.math.BigDecimal;

public class FeeCalculator {
    /** Fee charged for a refund. */
    public BigDecimal feeForRefund(Order order) {
        return feeFor(order).add(BigDecimal.ONE);
    }

    public BigDecimal feeFor(Order order) {
        return BigDecimal.TEN;
    }
}

abstract class AbstractPolicy {
    enum Mode { STRICT, LENIENT }
}
`,
    );
    const s = await refreshIndex(store, { config: cfg });
    expect(s.filesIndexed).toBe(1);
    expect(s.filesUnchanged).toBe(14);
    expect(s.fullResolve).toBe(false);
    expect(symbolId(store, 'com.acme.billing.FeeCalculator.feeFor')).toBe(feeForId);
    expect(symbolId(store, 'com.acme.billing.FeeCalculator')).toBe(classId);
    const added = store.symbolById(symbolId(store, 'com.acme.billing.FeeCalculator.feeForRefund')!)!;
    expect(added.doc).toBe('Fee charged for a refund.');
    expect(added.start_line).toBe(7); // declaration line; the doc comment is stored separately
    expect(store.symbolById(feeForId!)!.start_line).toBe(11);
    expect(target(store, 'com.acme.billing.DefaultRefundPolicy.computeRefund', 'feeFor')).toBe('com.acme.billing.FeeCalculator.feeFor');
    expect(target(store, 'com.acme.billing.FeeCalculator.feeForRefund', 'feeFor')).toBe('com.acme.billing.FeeCalculator.feeFor');
    expect(ftsMatch(store, 'name_terms:feeforrefund')).toEqual(['com.acme.billing.FeeCalculator.feeForRefund']);
  });

  it('resolves existing refs when a new file defines their target', async () => {
    expect(target(store, 'com.acme.notify.Notifier', 'BaseNotifier', 'inherit')).toBeNull();
    write(root, 'kt/com/acme/notify/BaseNotifier.kt', 'package com.acme.notify\n\nopen class BaseNotifier {\n    open fun close() {}\n}\n');
    const s = await refreshIndex(store, { config: cfg });
    expect(s.filesIndexed).toBe(1);
    expect(target(store, 'com.acme.notify.Notifier', 'BaseNotifier', 'inherit')).toBe('com.acme.notify.BaseNotifier');
  });

  it('removes deleted files with their symbols, FTS rows and dangling links', async () => {
    const storeIds = (store.db.prepare("SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = 'go/ledger/store.go'").all() as Array<{ id: number }>).map((r) => r.id);
    expect(storeIds.length).toBe(2);
    unlinkSync(join(root, 'go/ledger/store.go'));
    const s = await refreshIndex(store, { config: cfg });
    expect(s.filesDeleted).toBe(1);
    expect(store.fileByPath('go/ledger/store.go')).toBeUndefined();
    for (const id of storeIds) expect(store.symbolById(id)).toBeUndefined();
    expect(ftsMatch(store, 'name_terms:save')).toEqual([]);
    expect(target(store, 'ledger.Ledger', 'Store', 'inherit')).toBeNull();
    const fts = store.db.prepare('SELECT count(*) AS n FROM symbols_fts').get() as { n: number };
    expect(fts.n).toBe(store.counts().symbols);
    const dangling = store.db.prepare('SELECT count(*) AS n FROM refs r LEFT JOIN symbols s ON s.id = r.to_symbol_id WHERE r.to_symbol_id IS NOT NULL AND s.id IS NULL').get() as { n: number };
    expect(dangling.n).toBe(0);
  });

  it('never reuses retired symbol ids', async () => {
    const before = (store.db.prepare('SELECT max(id) AS m FROM symbols').get() as { m: number }).m;
    write(root, 'go/ledger/extra.go', 'package ledger\n\n// Extra is new.\nfunc Extra() {}\n');
    await refreshIndex(store, { config: cfg });
    expect(symbolId(store, 'ledger.Extra')).toBeGreaterThan(before);
  });

  it('honors maxFiles: most recent first, the rest reported as pending', async () => {
    write(root, 'py/payments/models.py', 'class Charge:\n    pass\n\n\nclass Refund:\n    pass\n');
    write(root, 'ts/src/orders/money.ts', "export const CURRENCY = 'USD';\nexport function roundCents(a: number): number { return a; }\n");
    write(root, 'cs/Billing/Models.cs', 'namespace Acme.Billing;\n\npublic interface IMailer\n{\n    void Deliver(string to, string body);\n}\n');
    const s1 = await refreshIndex(store, { config: cfg, maxFiles: 1 });
    expect(s1.filesIndexed).toBe(1);
    expect(s1.filesPending).toBe(2);
    expect(store.fileByPath('cs/Billing/Models.cs')!.line_count).toBe(6); // most recently written
    const s2 = await refreshIndex(store, { config: cfg, maxFiles: 10 });
    expect(s2.filesIndexed).toBe(2);
    expect(s2.filesPending).toBeUndefined();
    expect(symbolId(store, 'Acme.Billing.Money')).toBeUndefined();
    expect(target(store, 'Acme.Billing.InvoiceService.Send', 'Deliver')).toBe('Acme.Billing.IMailer.Deliver');
  });

  it('detects content-identical rewrites without re-parsing', async () => {
    const text = 'package ledger\n\n// Extra is new.\nfunc Extra() {}\n';
    write(root, 'go/ledger/extra.go', text);
    const s = await refreshIndex(store, { config: cfg });
    expect(s.filesIndexed).toBe(0);
    expect(s.filesUnchanged).toBeGreaterThan(0);
  });

  it('restricts a pass to explicit paths', async () => {
    write(root, 'go/ledger/extra.go', 'package ledger\n\nfunc Extra() {}\n\nfunc Extra2() {}\n');
    write(root, 'ts/src/orders/money.ts', "export const CURRENCY = 'EUR';\nexport function roundCents(a: number): number { return a; }\n");
    const s = await indexRepo(store, { config: cfg, paths: ['go/ledger/extra.go', join(root, 'secrets/keys.py')] });
    expect(s.filesSeen).toBe(1); // secrets/ is .kiroignored
    expect(s.filesIndexed).toBe(1);
    expect(symbolId(store, 'ledger.Extra2')).toBeDefined();
    const money = await refreshIndex(store, { config: cfg });
    expect(money.filesIndexed).toBe(1);
  });

  it('applies nested .kiroignore files and drops newly ignored files', async () => {
    write(root, 'py/.kiroignore', 'models.py\n');
    const s = await refreshIndex(store, { config: cfg });
    expect(s.filesDeleted).toBe(1);
    expect(store.fileByPath('py/payments/models.py')).toBeUndefined();
    expect(target(store, 'payments.gateway.refund_charge', 'Refund', 'new')).toBeNull();
  });

  it('renames Python modules when the package layout changes', async () => {
    expect(store.fileByPath('py/payments/gateway.py')!.namespace).toBe('payments.gateway');
    write(root, 'py/__init__.py', '');
    const s = await refreshIndex(store, { config: cfg });
    expect(s.filesIndexed).toBe(3); // the new __init__.py + the two modules whose name changed
    expect(store.fileByPath('py/payments/gateway.py')!.namespace).toBe('py.payments.gateway');
    expect(symbolId(store, 'py.payments.gateway.PaymentGateway.charge')).toBeDefined();
    expect(target(store, 'py.payments.gateway.refund_charge', 'charge')).toBe('py.payments.gateway.PaymentGateway.charge');
  });

  it('forgets skip markers of deleted files', async () => {
    write(root, 'ts/src/blob.ts', 'x\u0000y');
    await refreshIndex(store, { config: cfg });
    expect(store.db.prepare("SELECT count(*) AS n FROM idx_skipped WHERE path = 'ts/src/blob.ts'").get()).toEqual({ n: 1 });
    unlinkSync(join(root, 'ts/src/blob.ts'));
    await refreshIndex(store, { config: cfg });
    expect(store.db.prepare("SELECT count(*) AS n FROM idx_skipped WHERE path = 'ts/src/blob.ts'").get()).toEqual({ n: 0 });
  });

  it('refuses to run against a missing root instead of wiping the index', async () => {
    const before = store.counts().files;
    await expect(refreshIndex(store, { config: { ...cfg, root: join(root, 'does-not-exist') } })).rejects.toThrow(/root not found/);
    expect(store.counts().files).toBe(before);
  });

  it('recovers from an interrupted pass with a full re-resolution', async () => {
    store.setMeta('idx_dirty', '1');
    const s = await refreshIndex(store, { config: cfg });
    expect(s.fullResolve).toBe(true);
    expect(target(store, 'com.acme.billing.RefundService.refund', 'computeRefund')).toBe('com.acme.billing.RefundPolicy.computeRefund');
  });
});

describe('git listing and workers', () => {
  const hasGit = (() => {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  it.runIf(hasGit)('lists files through git (untracked included, .gitignore honored) and records HEAD', async () => {
    const root = copyFixture();
    write(root, 'ignored/gen.py', 'def generated():\n    pass\n');
    writeFileSync(join(root, '.gitignore'), 'node_modules/\nignored/\n');
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root, stdio: 'ignore' });
    git('init', '-q');
    git('add', '-A');
    git('commit', '-qm', 'init');
    write(root, 'py/payments/untracked.py', 'def fresh():\n    pass\n');
    const store = open(root);
    const s = await indexRepo(store, { config: config(root) });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
    expect(s.commit).toBe(head);
    expect(store.getMeta(META.commit)).toBe(head);
    const p = paths(store);
    expect(p).toContain('py/payments/untracked.py');
    expect(p).not.toContain('ignored/gen.py');
    expect(p).not.toContain('secrets/keys.py');
    expect(p).toHaveLength(16);
    store.close();
  });

  it('bulk-loads with secondary indexes dropped, then restores them', async () => {
    const root = copyFixture();
    const store = open(root);
    const indexes = () =>
      (store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
    const before = indexes();
    const prev = process.env.KOPT_INDEX_BULK_MIN;
    vi.resetModules();
    process.env.KOPT_INDEX_BULK_MIN = '1';
    try {
      const fresh = (await import('../src/indexer/index.js')) as typeof import('../src/indexer/index.js');
      await fresh.indexRepo(store, { config: config(root) });
    } finally {
      if (prev === undefined) delete process.env.KOPT_INDEX_BULK_MIN;
      else process.env.KOPT_INDEX_BULK_MIN = prev;
    }
    expect(indexes()).toEqual(before);
    expect(target(store, 'com.acme.billing.RefundService.refund', 'computeRefund')).toBe('com.acme.billing.RefundPolicy.computeRefund');
    expect(ftsMatch(store, 'calculator')).toContain('com.acme.billing.FeeCalculator');
    store.close();
  });

  it('produces the same index with the worker pool', async () => {
    const root = copyFixture();
    // enough files to cross the worker threshold
    for (let i = 0; i < 160; i++) write(root, `gen/m${i}.py`, `def f${i}(x):\n    return g${(i + 1) % 160}(x)\n`);
    const store = open(root);
    const prev = process.env.KOPT_INDEX_WORKERS;
    process.env.KOPT_INDEX_WORKERS = '2';
    try {
      const s = await indexRepo(store, { config: config(root) });
      expect(s.filesIndexed).toBe(175);
    } finally {
      if (prev === undefined) delete process.env.KOPT_INDEX_WORKERS;
      else process.env.KOPT_INDEX_WORKERS = prev;
    }
    expect(symbolId(store, 'gen.m7.f7')).toBeDefined();
    expect(target(store, 'com.acme.billing.RefundService.refund', 'computeRefund')).toBe('com.acme.billing.RefundPolicy.computeRefund');
    store.close();
  });
});
