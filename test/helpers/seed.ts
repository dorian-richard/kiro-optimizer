// Builds an in-memory index over a small, realistic codebase (Java billing/refund domain, TS frontend, tests).
// Rows are inserted directly (no indexer), with FTS columns computed as documented in src/store/schema.ts.
// Line ranges are derived from the real source text written to a temp dir, so tests can read bodies.

import { mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { RefKind, SymbolKind } from '../../src/core/types.js';
import { Store } from '../../src/store/store.js';
import { termsForText } from '../../src/indexer/terms.js';

export interface SymSpec {
  /** Local qualified name inside the file, e.g. "RefundService.computeRefund". */
  key: string;
  /** Registry id for `ids` / ref targets when `key` is not unique across the fixture. Default: key. */
  id?: string;
  kind: SymbolKind;
  /** Snippet identifying the declaration line (searched from the parent's start). Default: name + "(" or "<kind> <name>". */
  at?: string;
  doc?: string;
  exported?: boolean;
  rank?: number;
}

export interface RefSpec {
  /** Key of the enclosing symbol; undefined = file level. */
  from?: string;
  name: string;
  qualifier?: string;
  kind?: RefKind;
  /** Key of the resolved target symbol; undefined = unresolved. */
  to?: string;
  /** Snippet to locate the line within the enclosing range (default `name(`, or `name` for imports). */
  at?: string;
  /** n-th occurrence (0-based) of the snippet inside the range. */
  nth?: number;
}

export interface FileSpec {
  path: string;
  lang: string | null;
  namespace?: string;
  rank: number;
  text: string;
  symbols: SymSpec[];
  refs?: RefSpec[];
  /** [spec, target path | undefined] */
  imports?: Array<[string, string | undefined]>;
}

export interface Seeded {
  store: Store;
  root: string;
  /** Symbol ids by registry id (default: key, e.g. "RefundService.computeRefund"). */
  ids: Record<string, number>;
  fileIds: Record<string, number>;
  specs: FileSpec[];
  cleanup(): void;
}

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

/** Matcher for the declaration line: explicit snippet, "<kind> Name", or "<type|modifier> name(" (not a call). */
function declMatcher(s: SymSpec): (line: string) => boolean {
  if (s.at) {
    const at = s.at;
    return (l) => l.includes(at);
  }
  const name = s.key.split('.').pop()!;
  switch (s.kind) {
    case 'class':
    case 'interface':
    case 'enum':
    case 'record':
    case 'type': {
      const kw = s.kind === 'type' ? 'type' : s.kind;
      return (l) => l.includes(`${kw} ${name}`);
    }
    default: {
      const rx = new RegExp(`(?:^|\\s)(?!return\\s|new\\s|await\\s|throw\\s)[\\w<>\\[\\],?.]+\\s+${name}\\s*[(<]`);
      return (l) => rx.test(l);
    }
  }
}

function blockEnd(lines: string[], i: number): number {
  let depth = 0;
  let opened = false;
  for (let j = i; j < lines.length; j++) {
    const l = lines[j].replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""').replace(/\/\/.*$/, '');
    for (const c of l) {
      if (c === '{') {
        depth++;
        opened = true;
      } else if (c === '}') depth--;
    }
    if (opened && depth <= 0) return j;
    if (!opened && /[;,]\s*$/.test(l)) return j;
  }
  return i;
}

function signatureOf(line: string): string {
  return line
    .trim()
    .replace(/\s*\{\s*\}?\s*$/, '')
    .replace(/[;,]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function seedStore(opts: { specs?: FileSpec[]; root?: boolean; blobs?: boolean } = {}): Seeded {
  const specs = opts.specs ?? fixture();
  const root = mkdtempSync(join(tmpdir(), 'kopt-retrieval-'));
  for (const f of specs) {
    const abs = join(root, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.text);
  }
  const store = Store.open(':memory:', { root: opts.root === false ? undefined : root });
  const ids: Record<string, number> = {};
  const fileIds: Record<string, number> = {};
  const ranges: Record<string, { file: string; start: number; end: number }> = {};

  const insFile = store.db.prepare(
    'INSERT INTO files(path, lang, hash, size, line_count, mtime_ms, namespace, rank, indexed_at) VALUES (?,?,?,?,?,?,?,?,?)',
  );
  const insSym = store.db.prepare(
    'INSERT INTO symbols(file_id, name, qname, kind, start_line, end_line, start_byte, end_byte, signature, doc, parent_id, exported, rank) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
  );
  const insFts = store.db.prepare('INSERT INTO symbols_fts(rowid, name_terms, sig_terms, path_terms, doc, body_terms) VALUES (?,?,?,?,?,?)');
  const insRef = store.db.prepare('INSERT INTO refs(file_id, from_symbol_id, name, qualifier, kind, line, to_symbol_id) VALUES (?,?,?,?,?,?,?)');
  const insImp = store.db.prepare('INSERT INTO file_imports(file_id, spec, target_file_id) VALUES (?,?,?)');
  const insBlob = store.db.prepare('INSERT INTO blobs(file_id, content) VALUES (?, ?)');

  store.db.exec('BEGIN');
  for (const f of specs) {
    const lines = f.text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const st = statSync(join(root, f.path));
    const fid = Number(
      insFile.run(f.path, f.lang, sha1(f.text), Buffer.byteLength(f.text), lines.length, Math.floor(st.mtimeMs), f.namespace ?? null, f.rank, Date.now())
        .lastInsertRowid,
    );
    fileIds[f.path] = fid;
    if (opts.blobs) insBlob.run(fid, gzipSync(Buffer.from(f.text)));
    const offsets: number[] = [];
    let off = 0;
    for (const l of lines) {
      offsets.push(off);
      off += Buffer.byteLength(l) + 1;
    }
    const local = new Map<string, { id: number; start: number }>();
    for (const s of f.symbols) {
      const parts = s.key.split('.');
      const name = parts[parts.length - 1];
      const parentKey = parts.length > 1 ? parts.slice(0, -1).join('.') : undefined;
      const parent = parentKey ? local.get(parentKey) : undefined;
      if (parentKey && !parent) throw new Error(`seed: parent ${parentKey} of ${s.key} must be declared first`);
      const from = parent ? parent.start - 1 : 0;
      const isDecl = declMatcher(s);
      const i = lines.findIndex((l, idx) => idx >= from && isDecl(l));
      if (i < 0) throw new Error(`seed: declaration of ${s.key} not found in ${f.path}`);
      let start = i;
      while (start > 0 && /^\s*@/.test(lines[start - 1])) start--;
      const end = s.kind === 'field' || s.kind === 'property' || s.kind === 'constant' ? i : blockEnd(lines, i);
      const signature = signatureOf(lines[i]);
      const qname = f.namespace ? `${f.namespace}.${s.key}` : s.key;
      const body = lines.slice(i + 1, end + 1).join('\n');
      const id = Number(
        insSym.run(
          fid, name, qname, s.kind, start + 1, end + 1, offsets[start], offsets[end] + Buffer.byteLength(lines[end]),
          signature, s.doc ?? null, parent ? parent.id : null, s.exported ? 1 : 0, s.rank ?? 0.05,
        ).lastInsertRowid,
      );
      const reg = s.id ?? s.key;
      if (ids[reg] !== undefined) throw new Error(`seed: duplicate registry id ${reg}; set SymSpec.id`);
      ids[reg] = id;
      local.set(s.key, { id, start: start + 1 });
      ranges[reg] = { file: f.path, start: start + 1, end: end + 1 };
      insFts.run(
        id,
        termsForText(`${name} ${qname}`).join(' '),
        termsForText(signature).join(' '),
        termsForText(f.path).join(' '),
        s.doc ?? '',
        termsForText(body, 200).join(' '),
      );
    }
  }
  // Refs and imports after all symbols exist (targets cross files).
  for (const f of specs) {
    const fid = fileIds[f.path];
    const lines = f.text.split('\n');
    for (const r of f.refs ?? []) {
      const range = r.from ? ranges[r.from] : { file: f.path, start: 1, end: lines.length };
      if (!range) throw new Error(`seed: unknown from ${r.from}`);
      const snippet = r.at ?? (r.kind === 'import' ? r.name : `${r.name}(`);
      let seen = 0;
      let line = -1;
      for (let i = range.start - 1; i < range.end; i++) {
        if (lines[i].includes(snippet) && seen++ === (r.nth ?? 0)) {
          line = i + 1;
          break;
        }
      }
      if (line < 0) throw new Error(`seed: ref "${snippet}" not found in ${r.from ?? f.path}`);
      if (r.to && ids[r.to] === undefined) throw new Error(`seed: unknown ref target ${r.to}`);
      insRef.run(fid, r.from ? ids[r.from] : null, r.name, r.qualifier ?? null, r.kind ?? 'call', line, r.to ? ids[r.to] : null);
    }
    for (const [spec, target] of f.imports ?? []) insImp.run(fid, spec, target ? fileIds[target] : null);
  }
  store.db.exec('COMMIT');

  return {
    store,
    root,
    ids,
    fileIds,
    specs,
    cleanup() {
      try {
        store.close();
      } catch {
        /* already closed */
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Fixture

const J = 'src/main/java/com/acme';

function legacyEngine(): string {
  const out = [
    'package com.acme.legacy;',
    '',
    'import com.acme.billing.Order;',
    'import java.math.BigDecimal;',
    '',
    '/** Pre-2019 billing engine kept for old contracts. */',
    'public class LegacyBillingEngine {',
    '    private final BigDecimal rate = BigDecimal.ONE;',
    '',
  ];
  for (let i = 1; i <= 24; i++) {
    const n = String(i).padStart(2, '0');
    out.push(
      `    public BigDecimal step${n}(Order order) {`,
      '        BigDecimal v = order.getTotal();',
      `        v = v.add(BigDecimal.valueOf(${i}));`,
      '        v = v.multiply(rate);',
      '        return v;',
      '    }',
      '',
    );
  }
  out.push('    public BigDecimal reconcileAll(Order order) {', '        BigDecimal acc = BigDecimal.ZERO;');
  for (let k = 0; k < 4; k++) {
    for (let i = 1; i <= 24; i++) out.push(`        acc = acc.add(step${String(i).padStart(2, '0')}(order));`);
  }
  out.push('        return acc;', '    }', '}', '');
  return out.join('\n');
}

export function fixture(): FileSpec[] {
  const legacySteps: SymSpec[] = [];
  const legacyRefs: RefSpec[] = [];
  for (let i = 1; i <= 24; i++) {
    const n = String(i).padStart(2, '0');
    legacySteps.push({ key: `LegacyBillingEngine.step${n}`, kind: 'method', exported: true, rank: 0.02 });
    for (let k = 0; k < 4; k++) legacyRefs.push({ from: 'LegacyBillingEngine.reconcileAll', name: `step${n}`, to: `LegacyBillingEngine.step${n}`, nth: k });
  }
  return [
    {
      path: `${J}/billing/RefundService.java`,
      lang: 'java',
      namespace: 'com.acme.billing',
      rank: 0.8,
      text: `package com.acme.billing;

import java.math.BigDecimal;
import java.util.Objects;

/**
 * Application service for customer refunds.
 */
public class RefundService {
    private final RefundPolicy policy;
    private final LedgerClient ledger;

    public RefundService(RefundPolicy policy, LedgerClient ledger) {
        this.policy = policy;
        this.ledger = ledger;
    }

    /** Computes the refund amount for an order, capped by the refund policy. */
    public BigDecimal computeRefund(Order order, RefundRequest request) {
        validateRequest(order, request);
        BigDecimal requested = request.amount();
        BigDecimal cap = policy.maxRefundFor(order);
        if (requested.compareTo(cap) > 0) {
            return cap;
        }
        return requested;
    }

    /** Approves a refund and records it in the ledger. */
    public Refund approveRefund(Order order, RefundRequest request) {
        BigDecimal amount = computeRefund(order, request);
        Refund refund = new Refund(order.getId(), amount, RefundStatus.APPROVED);
        ledger.record(refund);
        return refund;
    }

    public Refund rejectRefund(Order order, String reason) {
        Refund refund = new Refund(order.getId(), BigDecimal.ZERO, RefundStatus.REJECTED);
        ledger.record(refund);
        return refund;
    }

    private void validateRequest(Order order, RefundRequest request) {
        Objects.requireNonNull(order, "order");
        if (!policy.isRefundable(order)) {
            throw new IllegalStateException("order not refundable: " + order.getId());
        }
    }
}
`,
      symbols: [
        { key: 'RefundService', kind: 'class', exported: true, rank: 0.8, doc: 'Application service for customer refunds.' },
        { key: 'RefundService.policy', kind: 'field', at: 'RefundPolicy policy;', rank: 0.05 },
        { key: 'RefundService.ledger', kind: 'field', at: 'LedgerClient ledger;', rank: 0.05 },
        { key: 'RefundService.RefundService', kind: 'constructor', exported: true, at: 'public RefundService(', rank: 0.3 },
        { key: 'RefundService.computeRefund', kind: 'method', exported: true, rank: 0.6, doc: 'Computes the refund amount for an order, capped by the refund policy.' },
        { key: 'RefundService.approveRefund', kind: 'method', exported: true, rank: 0.4, doc: 'Approves a refund and records it in the ledger.' },
        { key: 'RefundService.rejectRefund', kind: 'method', exported: true, rank: 0.2 },
        { key: 'RefundService.validateRequest', kind: 'method', rank: 0.1 },
      ],
      refs: [
        { from: 'RefundService.computeRefund', name: 'validateRequest', to: 'RefundService.validateRequest' },
        { from: 'RefundService.computeRefund', name: 'amount', qualifier: 'request' },
        { from: 'RefundService.computeRefund', name: 'maxRefundFor', qualifier: 'policy', to: 'RefundPolicy.maxRefundFor' },
        { from: 'RefundService.computeRefund', name: 'compareTo', qualifier: 'requested' },
        { from: 'RefundService.approveRefund', name: 'computeRefund', to: 'RefundService.computeRefund' },
        { from: 'RefundService.approveRefund', name: 'Refund', kind: 'new', to: 'Refund', at: 'new Refund(' },
        { from: 'RefundService.approveRefund', name: 'getId', qualifier: 'order', to: 'Order.getId' },
        { from: 'RefundService.approveRefund', name: 'record', qualifier: 'ledger', to: 'LedgerClient.record' },
        { from: 'RefundService.rejectRefund', name: 'Refund', kind: 'new', to: 'Refund', at: 'new Refund(' },
        { from: 'RefundService.rejectRefund', name: 'getId', qualifier: 'order', to: 'Order.getId' },
        { from: 'RefundService.rejectRefund', name: 'record', qualifier: 'ledger', to: 'LedgerClient.record' },
        { from: 'RefundService.validateRequest', name: 'requireNonNull', qualifier: 'Objects' },
        { from: 'RefundService.validateRequest', name: 'isRefundable', qualifier: 'policy', to: 'RefundPolicy.isRefundable' },
        { from: 'RefundService.validateRequest', name: 'IllegalStateException', kind: 'new' },
        { from: 'RefundService.validateRequest', name: 'getId', qualifier: 'order', to: 'Order.getId' },
      ],
      imports: [['java.math.BigDecimal', undefined], ['java.util.Objects', undefined]],
    },
    {
      path: `${J}/billing/RefundPolicy.java`,
      lang: 'java',
      namespace: 'com.acme.billing',
      rank: 0.6,
      text: `package com.acme.billing;

import java.math.BigDecimal;

/** Business rules deciding whether and how much can be refunded. */
public class RefundPolicy {
    public static final int MAX_DAYS = 30;

    /** Maximum refundable amount for an order. */
    public BigDecimal maxRefundFor(Order order) {
        return order.getTotal();
    }

    public boolean isRefundable(Order order) {
        return order.isPaid() && order.ageInDays() <= MAX_DAYS;
    }
}
`,
      symbols: [
        { key: 'RefundPolicy', kind: 'class', exported: true, rank: 0.5, doc: 'Business rules deciding whether and how much can be refunded.' },
        { key: 'RefundPolicy.MAX_DAYS', kind: 'constant', at: 'MAX_DAYS =', exported: true, rank: 0.1 },
        { key: 'RefundPolicy.maxRefundFor', kind: 'method', exported: true, rank: 0.4, doc: 'Maximum refundable amount for an order.' },
        { key: 'RefundPolicy.isRefundable', kind: 'method', exported: true, rank: 0.3 },
      ],
      refs: [
        { from: 'RefundPolicy.maxRefundFor', name: 'getTotal', qualifier: 'order', to: 'Order.getTotal' },
        { from: 'RefundPolicy.isRefundable', name: 'isPaid', qualifier: 'order', to: 'Order.isPaid' },
        { from: 'RefundPolicy.isRefundable', name: 'ageInDays', qualifier: 'order', to: 'Order.ageInDays' },
      ],
    },
    {
      path: `${J}/billing/Order.java`,
      lang: 'java',
      namespace: 'com.acme.billing',
      rank: 0.9,
      text: `package com.acme.billing;

import java.math.BigDecimal;

public class Order {
    private final String id;
    private final BigDecimal total;
    private boolean paid;

    public Order(String id, BigDecimal total) {
        this.id = id;
        this.total = total;
    }

    public String getId() {
        return id;
    }

    public BigDecimal getTotal() {
        return total;
    }

    public boolean isPaid() {
        return paid;
    }

    public int ageInDays() {
        return 0;
    }
}
`,
      symbols: [
        { key: 'Order', kind: 'class', exported: true, rank: 0.9 },
        { key: 'Order.id', kind: 'field', at: 'String id;' },
        { key: 'Order.total', kind: 'field', at: 'BigDecimal total;' },
        { key: 'Order.paid', kind: 'field', at: 'boolean paid;' },
        { key: 'Order.Order', kind: 'constructor', exported: true, at: 'public Order(', rank: 0.3 },
        { key: 'Order.getId', kind: 'method', exported: true, rank: 0.5 },
        { key: 'Order.getTotal', kind: 'method', exported: true, rank: 0.5 },
        { key: 'Order.isPaid', kind: 'method', exported: true, rank: 0.2 },
        { key: 'Order.ageInDays', kind: 'method', exported: true, rank: 0.2 },
      ],
    },
    {
      path: `${J}/billing/RefundRequest.java`,
      lang: 'java',
      namespace: 'com.acme.billing',
      rank: 0.7,
      text: `package com.acme.billing;

import java.math.BigDecimal;

/** A customer's request to refund part of an order. */
public record RefundRequest(String orderId, BigDecimal amount, String reason) {
}
`,
      symbols: [{ key: 'RefundRequest', kind: 'record', exported: true, rank: 0.7, doc: "A customer's request to refund part of an order." }],
    },
    {
      path: `${J}/billing/Refund.java`,
      lang: 'java',
      namespace: 'com.acme.billing',
      rank: 0.5,
      text: `package com.acme.billing;

import java.math.BigDecimal;

public record Refund(String orderId, BigDecimal amount, RefundStatus status) {
}
`,
      symbols: [{ key: 'Refund', kind: 'record', exported: true, rank: 0.5 }],
    },
    {
      path: `${J}/billing/RefundStatus.java`,
      lang: 'java',
      namespace: 'com.acme.billing',
      rank: 0.4,
      text: `package com.acme.billing;

public enum RefundStatus {
    APPROVED,
    REJECTED
}
`,
      symbols: [{ key: 'RefundStatus', kind: 'enum', exported: true, rank: 0.4 }],
    },
    {
      path: `${J}/billing/LedgerClient.java`,
      lang: 'java',
      namespace: 'com.acme.billing',
      rank: 0.5,
      text: `package com.acme.billing;

/** Port to the accounting ledger. */
public interface LedgerClient {
    void record(Refund refund);
}
`,
      symbols: [
        { key: 'LedgerClient', kind: 'interface', exported: true, rank: 0.5, doc: 'Port to the accounting ledger.' },
        { key: 'LedgerClient.record', kind: 'method', exported: true, rank: 0.3 },
      ],
    },
    {
      path: `${J}/billing/InvoiceService.java`,
      lang: 'java',
      namespace: 'com.acme.billing',
      rank: 0.3,
      text: `package com.acme.billing;

import java.math.BigDecimal;

public class InvoiceService {
    /** Computes the invoice total including tax. */
    public BigDecimal computeInvoiceTotal(Order order) {
        return order.getTotal().add(computeTax(order));
    }

    public BigDecimal computeTax(Order order) {
        return order.getTotal().multiply(new BigDecimal("0.2"));
    }

    void validateRequest(Order order) {
        if (order == null) throw new IllegalArgumentException("order");
    }
}
`,
      symbols: [
        { key: 'InvoiceService', kind: 'class', exported: true, rank: 0.3 },
        { key: 'InvoiceService.computeInvoiceTotal', kind: 'method', exported: true, rank: 0.2, doc: 'Computes the invoice total including tax.' },
        { key: 'InvoiceService.computeTax', kind: 'method', exported: true, rank: 0.1 },
        { key: 'InvoiceService.validateRequest', kind: 'method', rank: 0.05 },
      ],
      refs: [
        { from: 'InvoiceService.computeInvoiceTotal', name: 'getTotal', qualifier: 'order', to: 'Order.getTotal' },
        { from: 'InvoiceService.computeInvoiceTotal', name: 'computeTax', to: 'InvoiceService.computeTax' },
        { from: 'InvoiceService.computeTax', name: 'getTotal', qualifier: 'order', to: 'Order.getTotal' },
      ],
    },
    {
      path: `${J}/api/RefundController.java`,
      lang: 'java',
      namespace: 'com.acme.api',
      rank: 0.4,
      text: `package com.acme.api;

import com.acme.billing.Order;
import com.acme.billing.Refund;
import com.acme.billing.RefundRequest;
import com.acme.billing.RefundService;
import java.math.BigDecimal;

public class RefundController {
    private final RefundService refundService;
    private final OrderRepository orders;

    public RefundController(RefundService refundService, OrderRepository orders) {
        this.refundService = refundService;
        this.orders = orders;
    }

    public Refund refund(String orderId, RefundRequest request) {
        Order order = orders.find(orderId);
        return refundService.approveRefund(order, request);
    }

    public BigDecimal preview(String orderId, RefundRequest request) {
        Order order = orders.find(orderId);
        return refundService.computeRefund(order, request);
    }
}
`,
      symbols: [
        { key: 'RefundController', kind: 'class', exported: true, rank: 0.3 },
        { key: 'RefundController.refundService', kind: 'field', at: 'RefundService refundService;' },
        { key: 'RefundController.orders', kind: 'field', at: 'OrderRepository orders;' },
        { key: 'RefundController.RefundController', kind: 'constructor', exported: true, at: 'public RefundController(' },
        { key: 'RefundController.refund', kind: 'method', exported: true, rank: 0.2 },
        { key: 'RefundController.preview', kind: 'method', exported: true, rank: 0.1 },
      ],
      refs: [
        { name: 'Order', kind: 'import', to: 'Order', at: 'billing.Order;' },
        { name: 'RefundService', kind: 'import', to: 'RefundService', at: 'billing.RefundService;' },
        { from: 'RefundController.refund', name: 'find', qualifier: 'orders', to: 'OrderRepository.find' },
        { from: 'RefundController.refund', name: 'approveRefund', qualifier: 'refundService', to: 'RefundService.approveRefund' },
        { from: 'RefundController.preview', name: 'find', qualifier: 'orders', to: 'OrderRepository.find' },
        { from: 'RefundController.preview', name: 'computeRefund', qualifier: 'refundService', to: 'RefundService.computeRefund' },
      ],
      imports: [
        ['com.acme.billing.Order', `${J}/billing/Order.java`],
        ['com.acme.billing.Refund', `${J}/billing/Refund.java`],
        ['com.acme.billing.RefundRequest', `${J}/billing/RefundRequest.java`],
        ['com.acme.billing.RefundService', `${J}/billing/RefundService.java`],
        ['java.math.BigDecimal', undefined],
      ],
    },
    {
      path: `${J}/api/OrderRepository.java`,
      lang: 'java',
      namespace: 'com.acme.api',
      rank: 0.3,
      text: `package com.acme.api;

import com.acme.billing.Order;

public interface OrderRepository {
    Order find(String id);
}
`,
      symbols: [
        { key: 'OrderRepository', kind: 'interface', exported: true, rank: 0.3 },
        { key: 'OrderRepository.find', kind: 'method', exported: true, rank: 0.3 },
      ],
      imports: [['com.acme.billing.Order', `${J}/billing/Order.java`]],
    },
    {
      path: `${J}/jobs/BillingJob.java`,
      lang: 'java',
      namespace: 'com.acme.jobs',
      rank: 0.1,
      text: `package com.acme.jobs;

import com.acme.api.RefundController;
import com.acme.billing.RefundRequest;

/** Nightly job replaying pending refund requests. */
public class BillingJob {
    private final RefundController controller;

    public BillingJob(RefundController controller) {
        this.controller = controller;
    }

    public void run() {
        for (RefundRequest r : pending()) {
            controller.refund(r.orderId(), r);
        }
    }

    public Object retry(Object service, Object order, RefundRequest r) {
        return ((com.acme.billing.RefundService) service).computeRefund(null, r);
    }

    private java.util.List<RefundRequest> pending() {
        return java.util.List.of();
    }
}
`,
      symbols: [
        { key: 'BillingJob', kind: 'class', exported: true, rank: 0.1, doc: 'Nightly job replaying pending refund requests.' },
        { key: 'BillingJob.controller', kind: 'field', at: 'RefundController controller;' },
        { key: 'BillingJob.BillingJob', kind: 'constructor', exported: true, at: 'public BillingJob(' },
        { key: 'BillingJob.run', kind: 'method', exported: true, rank: 0.05 },
        { key: 'BillingJob.retry', kind: 'method', exported: true, rank: 0.05 },
        { key: 'BillingJob.pending', kind: 'method', at: 'pending() {' },
      ],
      refs: [
        { from: 'BillingJob.run', name: 'pending', to: 'BillingJob.pending' },
        { from: 'BillingJob.run', name: 'refund', qualifier: 'controller', to: 'RefundController.refund' },
        { from: 'BillingJob.run', name: 'orderId', qualifier: 'r' },
        // Cast receiver: the indexer cannot resolve it (realistic unresolved ref).
        { from: 'BillingJob.retry', name: 'computeRefund', qualifier: 'service' },
      ],
      imports: [
        ['com.acme.api.RefundController', `${J}/api/RefundController.java`],
        ['com.acme.billing.RefundRequest', `${J}/billing/RefundRequest.java`],
      ],
    },
    {
      path: `${J}/legacy/LegacyBillingEngine.java`,
      lang: 'java',
      namespace: 'com.acme.legacy',
      rank: 0.1,
      text: legacyEngine(),
      symbols: [
        { key: 'LegacyBillingEngine', kind: 'class', exported: true, rank: 0.05, doc: 'Pre-2019 billing engine kept for old contracts.' },
        { key: 'LegacyBillingEngine.rate', kind: 'field', at: 'BigDecimal rate =' },
        ...legacySteps,
        { key: 'LegacyBillingEngine.reconcileAll', kind: 'method', exported: true, rank: 0.05 },
      ],
      refs: legacyRefs,
      imports: [['com.acme.billing.Order', `${J}/billing/Order.java`]],
    },
    {
      path: 'src/test/java/com/acme/billing/RefundServiceTest.java',
      lang: 'java',
      namespace: 'com.acme.billing',
      rank: 0.05,
      text: `package com.acme.billing;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.math.BigDecimal;
import org.junit.jupiter.api.Test;

class RefundServiceTest {
    private final RefundService service = new RefundService(new RefundPolicy(), refund -> {});

    @Test
    void computeRefundReturnsRequestedAmountUnderCap() {
        Order order = new Order("o1", new BigDecimal("100"));
        BigDecimal amount = service.computeRefund(order, new RefundRequest("o1", new BigDecimal("40"), "damaged"));
        assertEquals(new BigDecimal("40"), amount);
    }

    @Test
    void computeRefundCapsAmountAtPolicyLimit() {
        Order order = new Order("o1", new BigDecimal("100"));
        BigDecimal amount = service.computeRefund(order, new RefundRequest("o1", new BigDecimal("400"), "damaged"));
        assertEquals(new BigDecimal("100"), amount);
    }
}
`,
      symbols: [
        { key: 'RefundServiceTest', kind: 'class', rank: 0.01 },
        { key: 'RefundServiceTest.service', kind: 'field', at: 'RefundService service =' },
        { key: 'RefundServiceTest.computeRefundReturnsRequestedAmountUnderCap', kind: 'method', rank: 0.01 },
        { key: 'RefundServiceTest.computeRefundCapsAmountAtPolicyLimit', kind: 'method', rank: 0.01 },
      ],
      refs: [
        { from: 'RefundServiceTest.service', name: 'RefundService', kind: 'new', to: 'RefundService', at: 'new RefundService(' },
        { from: 'RefundServiceTest.computeRefundReturnsRequestedAmountUnderCap', name: 'computeRefund', qualifier: 'service', to: 'RefundService.computeRefund' },
        { from: 'RefundServiceTest.computeRefundCapsAmountAtPolicyLimit', name: 'computeRefund', qualifier: 'service', to: 'RefundService.computeRefund' },
      ],
    },
    {
      path: 'web/src/api/refunds.ts',
      lang: 'typescript',
      rank: 0.3,
      text: `import { ApiClient } from './client';
import type { OrderDto } from '../types';

export interface RefundDto {
  orderId: string;
  amount: number;
  status: 'APPROVED' | 'REJECTED';
}

/** Requests a refund for an order through the billing API. */
export async function requestRefund(client: ApiClient, orderId: string, amount: number): Promise<RefundDto> {
  return client.post<RefundDto>(\`/orders/\${orderId}/refunds\`, { amount });
}

/** Client-side preview of the refundable amount (server recomputes). */
export function computeRefundPreview(order: OrderDto, amount: number): number {
  return Math.min(order.total, amount);
}
`,
      symbols: [
        { key: 'RefundDto', kind: 'interface', exported: true, rank: 0.2 },
        { key: 'RefundDto.amount', kind: 'property', at: 'amount: number;' },
        { key: 'requestRefund', kind: 'function', exported: true, rank: 0.2, doc: 'Requests a refund for an order through the billing API.' },
        { key: 'computeRefundPreview', kind: 'function', exported: true, rank: 0.1, doc: 'Client-side preview of the refundable amount (server recomputes).' },
      ],
      refs: [
        { from: 'requestRefund', name: 'post', qualifier: 'client', to: 'ApiClient.post', at: 'post<' },
        { from: 'computeRefundPreview', name: 'min', qualifier: 'Math' },
      ],
      imports: [
        ['./client', 'web/src/api/client.ts'],
        ['../types', 'web/src/types.ts'],
      ],
    },
    {
      path: 'web/src/api/client.ts',
      lang: 'typescript',
      rank: 0.4,
      text: `export class ApiClient {
  constructor(private readonly baseUrl: string) {}

  async get<T>(path: string): Promise<T> {
    const res = await fetch(this.baseUrl + path);
    return (await res.json()) as T;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(this.baseUrl + path, { method: 'POST', body: JSON.stringify(body) });
    return (await res.json()) as T;
  }
}
`,
      symbols: [
        { key: 'ApiClient', kind: 'class', exported: true, rank: 0.4 },
        { key: 'ApiClient.constructor', kind: 'constructor', at: 'constructor(' },
        { key: 'ApiClient.get', kind: 'method', at: 'get<T>(', rank: 0.2 },
        { key: 'ApiClient.post', kind: 'method', at: 'post<T>(', rank: 0.2 },
      ],
    },
    {
      path: 'web/src/types.ts',
      lang: 'typescript',
      rank: 0.3,
      text: `export interface OrderDto {
  id: string;
  total: number;
}
`,
      symbols: [{ key: 'OrderDto', kind: 'interface', exported: true, rank: 0.3 }],
    },
    {
      path: 'web/src/utils/format.ts',
      lang: 'typescript',
      rank: 0.3,
      text: `/** Formats a money amount for display. */
export function formatAmount(value: number, currency: string): string {
  return new Intl.NumberFormat('en', { style: 'currency', currency }).format(value);
}

export function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
`,
      symbols: [
        { key: 'formatAmount', kind: 'function', exported: true, rank: 0.2, doc: 'Formats a money amount for display.' },
        { key: 'formatDate', kind: 'function', exported: true, rank: 0.1 },
      ],
    },
    {
      path: 'web/src/components/RefundForm.tsx',
      lang: 'tsx',
      rank: 0.2,
      text: `import { computeRefundPreview, requestRefund } from '../api/refunds';
import { formatAmount } from '../utils/format';

export function RefundForm({ order, client }: RefundFormProps) {
  const preview = computeRefundPreview(order, order.total);
  return <form onSubmit={() => submitRefund(client, order.id, preview)}>{formatAmount(preview, 'EUR')}</form>;
}

async function submitRefund(client: ApiClient, orderId: string, amount: number) {
  await requestRefund(client, orderId, amount);
}
`,
      symbols: [
        { key: 'RefundForm', kind: 'function', exported: true, rank: 0.1 },
        { key: 'submitRefund', kind: 'function', at: 'function submitRefund(', rank: 0.05 },
      ],
      refs: [
        { from: 'RefundForm', name: 'computeRefundPreview', to: 'computeRefundPreview' },
        { from: 'RefundForm', name: 'submitRefund', to: 'submitRefund' },
        { from: 'RefundForm', name: 'formatAmount', to: 'formatAmount' },
        { from: 'submitRefund', name: 'requestRefund', to: 'requestRefund' },
      ],
      imports: [
        ['../api/refunds', 'web/src/api/refunds.ts'],
        ['../utils/format', 'web/src/utils/format.ts'],
      ],
    },
    {
      path: 'web/src/__tests__/refunds.test.ts',
      lang: 'typescript',
      rank: 0.05,
      text: `import { computeRefundPreview } from '../api/refunds';

function makeOrder(total: number) {
  return { id: 'o1', total };
}

function formatAmount(v: number) {
  return String(v);
}

test('computeRefundPreview caps at order total', () => {
  expect(computeRefundPreview(makeOrder(10), 50)).toBe(10);
});
`,
      symbols: [
        { key: 'makeOrder', kind: 'function', rank: 0.01 },
        // Test-only shadow of utils/format.ts formatAmount (dominance case for name resolution).
        { key: 'formatAmount', id: 'test:formatAmount', kind: 'function', rank: 0.01, at: 'function formatAmount(' },
      ],
      refs: [
        { name: 'computeRefundPreview', to: 'computeRefundPreview', at: 'expect(computeRefundPreview(' },
        { name: 'makeOrder', to: 'makeOrder', at: 'makeOrder(10)' },
      ],
      imports: [['../api/refunds', 'web/src/api/refunds.ts']],
    },
    {
      path: 'README.md',
      lang: null,
      rank: 0.0,
      text: `# Acme billing

Refund and invoicing services.

## Architecture

### Billing domain

### Web frontend

## Running tests
`,
      symbols: [],
    },
  ];
}
