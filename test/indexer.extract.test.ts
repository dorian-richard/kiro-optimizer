import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExtractedFile, ExtractedRef, ExtractedSymbol } from '../src/core/types.js';
import { extractFile, languageForPath, splitIdentifier, termsForText } from '../src/indexer/index.js';
import { isMinified } from '../src/indexer/prepare.js';

const FIX = join(import.meta.dirname, 'fixtures/indexer/sample-repo');

async function ex(rel: string): Promise<ExtractedFile> {
  const f = await extractFile(rel, readFileSync(join(FIX, rel), 'utf8'));
  if (!f) throw new Error(`no extraction for ${rel}`);
  return f;
}

function sym(f: ExtractedFile, qname: string): ExtractedSymbol {
  const s = f.symbols.find((x) => x.qualifiedName === qname);
  if (!s) throw new Error(`missing ${qname}; have: ${f.symbols.map((x) => x.qualifiedName).join(', ')}`);
  return s;
}

function refs(f: ExtractedFile, kind: string, name: string): ExtractedRef[] {
  return f.refs.filter((r) => r.kind === kind && r.name === name);
}

describe('languageForPath', () => {
  it('maps extensions', () => {
    expect(languageForPath('a/b.ts')).toBe('typescript');
    expect(languageForPath('a/b.mts')).toBe('typescript');
    expect(languageForPath('a/b.tsx')).toBe('tsx');
    expect(languageForPath('a/b.jsx')).toBe('javascript');
    expect(languageForPath('a/b.cjs')).toBe('javascript');
    expect(languageForPath('x.py')).toBe('python');
    expect(languageForPath('X.java')).toBe('java');
    expect(languageForPath('X.cs')).toBe('c_sharp');
    expect(languageForPath('x.go')).toBe('go');
    expect(languageForPath('X.kts')).toBe('kotlin');
    expect(languageForPath('x.rs')).toBe('rust');
    expect(languageForPath('x.php')).toBe('php');
    expect(languageForPath('x.rb')).toBe('ruby');
    expect(languageForPath('x.scala')).toBe('scala');
    expect(languageForPath('README.md')).toBeUndefined();
    expect(languageForPath('.eslintrc')).toBeUndefined();
    expect(languageForPath('Makefile')).toBeUndefined();
  });

  it('re-exports the shared term functions', () => {
    expect(splitIdentifier('parseHTTPRequest_v2')).toEqual(['parse', 'http', 'request', 'v2']);
    expect(termsForText('OrderService.place()')).toEqual(['orderservice', 'order', 'service', 'place']);
  });
});

describe('java', () => {
  it('extracts types, members, qualified names, signatures and docs', async () => {
    const f = await ex('java/com/acme/billing/DefaultRefundPolicy.java');
    expect(f.lang).toBe('java');
    expect(f.namespace).toBe('com.acme.billing');
    expect(f.imports).toEqual(['java.math.BigDecimal', 'java.util.List']);

    const cls = sym(f, 'com.acme.billing.DefaultRefundPolicy');
    expect(cls.kind).toBe('class');
    expect(cls.exported).toBe(true);
    expect(cls.signature).toBe('@Component public class DefaultRefundPolicy extends AbstractPolicy implements RefundPolicy');
    expect(cls.doc).toBe('Default policy: refunds at most the paid amount minus fees.');
    expect(cls.startLine).toBe(9); // annotation line included
    expect(cls.endLine).toBe(35);

    const m = sym(f, 'com.acme.billing.DefaultRefundPolicy.computeRefund');
    expect(m.kind).toBe('method');
    expect(m.signature).toBe('@Override public BigDecimal computeRefund(Order order, BigDecimal requested)');
    expect(m.signature).not.toContain('{');
    expect(m.doc).toBe('Computes the refund.');
    expect(f.symbols[m.parent!].name).toBe('DefaultRefundPolicy');
    expect(m.bodyTerms).toEqual(expect.arrayContaining(['feecalculator', 'fee', 'calculator', 'localfee', 'getpaidamount']));

    expect(sym(f, 'com.acme.billing.DefaultRefundPolicy.DefaultRefundPolicy').kind).toBe('constructor');
    expect(sym(f, 'com.acme.billing.DefaultRefundPolicy.MAX_FEE').kind).toBe('constant');
    const field = sym(f, 'com.acme.billing.DefaultRefundPolicy.feeCalculator');
    expect(field.kind).toBe('field');
    expect(field.exported).toBe(false);
    expect(field.signature).toBe('private final FeeCalculator feeCalculator');
    expect(sym(f, 'com.acme.billing.DefaultRefundPolicy.retries').exported).toBe(true); // protected

    const nested = sym(f, 'com.acme.billing.DefaultRefundPolicy.Audit.record');
    expect(nested.kind).toBe('method');
    expect(nested.exported).toBe(false);
  });

  it('never indexes locals', async () => {
    const f = await ex('java/com/acme/billing/DefaultRefundPolicy.java');
    const names = f.symbols.map((s) => s.name);
    expect(names).not.toContain('localFee');
    expect(names).not.toContain('notes');
    expect(names).not.toContain('what');
  });

  it('emits typed call refs, inheritance, imports and signature type refs', async () => {
    const f = await ex('java/com/acme/billing/DefaultRefundPolicy.java');
    const feeFor = refs(f, 'call', 'feeFor')[0] as ExtractedRef & { hint?: string };
    expect(feeFor.qualifier).toBe('feeCalculator');
    expect(feeFor.hint).toBe('T:FeeCalculator');
    expect(feeFor.line).toBe(25);
    expect(f.symbols[feeFor.fromSymbol!].name).toBe('computeRefund');
    expect(refs(f, 'inherit', 'AbstractPolicy')).toHaveLength(1);
    expect(refs(f, 'implement', 'RefundPolicy')).toHaveLength(1);
    expect(refs(f, 'import', 'BigDecimal')[0].qualifier).toBe('java.math');
    expect(refs(f, 'new', 'BigDecimal')).toHaveLength(1);
    // type refs are deduped per symbol
    const orderRefs = refs(f, 'type_ref', 'Order');
    expect(orderRefs).toHaveLength(1);
    expect(f.symbols[orderRefs[0].fromSymbol!].name).toBe('computeRefund');
  });

  it('handles interfaces (implicitly public members), records and enums', async () => {
    const i = await ex('java/com/acme/billing/RefundPolicy.java');
    const m = sym(i, 'com.acme.billing.RefundPolicy.computeRefund');
    expect(m.exported).toBe(true);
    expect(m.signature).toBe('BigDecimal computeRefund(Order order, BigDecimal requested)');
    expect(m.doc).toBe('Computes the refundable amount for an order.');
    const r = await ex('java/com/acme/billing/Order.java');
    expect(sym(r, 'com.acme.billing.Order').kind).toBe('record');
    expect(sym(r, 'com.acme.billing.Order.paid').kind).toBe('field');
    const e = await ex('java/com/acme/billing/FeeCalculator.java');
    expect(sym(e, 'com.acme.billing.AbstractPolicy.Mode').kind).toBe('enum');
    expect(sym(e, 'com.acme.billing.AbstractPolicy.Mode.STRICT').kind).toBe('constant');
    expect(sym(e, 'com.acme.billing.AbstractPolicy').exported).toBe(false); // package-private
  });

  it('uses line comments as docs', async () => {
    const f = await ex('java/com/acme/billing/RefundService.java');
    expect(sym(f, 'com.acme.billing.RefundService.refund').doc).toBe('Refunds an order, applying the configured policy.');
  });
});

describe('typescript', () => {
  it('extracts classes, members, arrow functions, interfaces, types, enums, namespaces', async () => {
    const f = await ex('ts/src/orders/OrderService.ts');
    expect(f.lang).toBe('typescript');
    expect(f.imports).toEqual(['./money', 'node:path', '../repo']);
    const cls = sym(f, 'OrderService');
    expect(cls.kind).toBe('class');
    expect(cls.exported).toBe(true);
    expect(cls.doc).toBe('Places and prices orders.');
    expect(cls.signature).toBe('export class OrderService extends BaseService implements Disposable');

    const total = sym(f, 'OrderService.total');
    expect(total.kind).toBe('method');
    expect(total.signature).toBe('async total(id: OrderId): Promise<number>');
    expect(total.doc).toBe('Total price of the order, rounded.');
    expect(sym(f, 'OrderService.describe').kind).toBe('method'); // class property arrow fn
    expect(sym(f, 'OrderService.describe').signature).toBe('describe = (id: OrderId): string =>');
    expect(sym(f, 'OrderService.computeTotalSync').exported).toBe(false); // private
    expect(sym(f, 'OrderService.constructor').kind).toBe('constructor');
    expect(sym(f, 'OrderService.repo').kind).toBe('field'); // parameter property
    expect(sym(f, 'OrderService.lines').exported).toBe(false);

    const place = sym(f, 'placeOrder');
    expect(place.kind).toBe('function');
    expect(place.exported).toBe(true);
    expect(place.signature).toBe('export const placeOrder = async (svc: OrderService, id: OrderId) =>');

    expect(sym(f, 'OrderLine').kind).toBe('interface');
    expect(sym(f, 'OrderLine.sku').kind).toBe('property');
    expect(sym(f, 'OrderId').kind).toBe('type');
    expect(sym(f, 'OrderStatus').kind).toBe('enum');
    expect(sym(f, 'OrderStatus.Open').kind).toBe('constant');
    expect(sym(f, 'Orders').kind).toBe('namespace');
    expect(sym(f, 'Orders.make').kind).toBe('function');
  });

  it('never indexes locals and resolves import aliases in refs', async () => {
    const f = await ex('ts/src/orders/OrderService.ts');
    const names = f.symbols.map((s) => s.name);
    expect(names).not.toContain('sum');
    expect(names).not.toContain('t');
    expect(refs(f, 'import', 'formatMoney')[0].qualifier).toBe('./money');
    // `fmt(...)` is an alias of formatMoney
    expect(refs(f, 'call', 'formatMoney')).toHaveLength(1);
    expect(refs(f, 'call', 'fmt')).toHaveLength(0);
    const total = refs(f, 'call', 'total')[0] as ExtractedRef & { hint?: string };
    expect(total.qualifier).toBe('svc');
    expect(total.hint).toBe('T:OrderService');
    expect(refs(f, 'call', 'computeTotalSync')[0].qualifier).toBe('this');
    expect(refs(f, 'inherit', 'BaseService')).toHaveLength(1);
    expect(refs(f, 'implement', 'Disposable')).toHaveLength(1);
    expect(refs(f, 'new', 'Receipt')).toHaveLength(1);
  });

  it('keeps module constants and function expressions, flags exports', async () => {
    const f = await ex('ts/src/orders/money.ts');
    expect(sym(f, 'CURRENCY').kind).toBe('constant');
    expect(sym(f, 'roundCents').doc).toBe('Rounds an amount to cents.');
    expect(sym(f, 'formatMoney').kind).toBe('function');
    const helper = sym(f, 'internalHelper');
    expect(helper.kind).toBe('function');
    expect(helper.exported).toBe(false);
  });

  it('parses TSX and CommonJS', async () => {
    const tsx = await extractFile(
      'web/App.tsx',
      `import { Button } from './Button';\nexport function App({ name }: Props) {\n  return <div><Button label={name} /></div>;\n}\n`,
    );
    expect(tsx!.symbols.map((s) => s.name)).toEqual(['App']);
    expect(tsx!.refs.some((r) => r.kind === 'call' && r.name === 'Button')).toBe(true);
    const cjs = await extractFile('lambda/handler.js', `const db = require('./db');\nexports.handler = async (event) => {\n  return db.query(event.id);\n};\n`);
    expect(cjs!.symbols[0]).toMatchObject({ name: 'handler', kind: 'function', exported: true });
    expect(cjs!.imports).toEqual(['./db']);
    expect((cjs!.refs.find((r) => r.name === 'query') as ExtractedRef & { hint?: string }).hint).toBe('M:./db');
  });
});

describe('python', () => {
  it('extracts classes, decorated defs, docstrings, constants, class attributes', async () => {
    const f = await ex('py/payments/gateway.py');
    expect(f.namespace).toBe('py.payments.gateway');
    expect(f.imports).toEqual(['logging', 'decimal', '.models']);
    const cls = sym(f, 'py.payments.gateway.PaymentGateway');
    expect(cls.doc).toBe('Talks to the payment provider.');
    expect(cls.signature).toBe('class PaymentGateway(BaseGateway)');
    const charge = sym(f, 'py.payments.gateway.PaymentGateway.charge');
    expect(charge.kind).toBe('method');
    expect(charge.signature).toBe('@retry(times=MAX_RETRIES) def charge(self, amount: Decimal, token: str) -> Charge');
    expect(charge.doc).toBe('Charge a card token.');
    expect(charge.startLine).toBe(20); // decorator line
    expect(sym(f, 'py.payments.gateway.PaymentGateway.__init__').kind).toBe('constructor');
    expect(sym(f, 'py.payments.gateway.PaymentGateway._sign').exported).toBe(false);
    expect(sym(f, 'py.payments.gateway.PaymentGateway.timeout').kind).toBe('field');
    expect(sym(f, 'py.payments.gateway.PaymentGateway.Config').kind).toBe('class');
    expect(sym(f, 'py.payments.gateway.MAX_RETRIES').kind).toBe('constant');
    const fn = sym(f, 'py.payments.gateway.refund_charge');
    expect(fn.kind).toBe('function');
    expect(fn.doc).toBe('Refund a previous charge.');
    expect(sym(f, 'py.payments.gateway._internal').exported).toBe(false);
  });

  it('never indexes locals or self attributes', async () => {
    const f = await ex('py/payments/gateway.py');
    const names = f.symbols.map((s) => s.name);
    for (const n of ['local_value', 'result', 'client', '_cache', 'logger', '_private_flag']) expect(names).not.toContain(n);
  });

  it('types receivers from annotations and resolves aliases', async () => {
    const f = await ex('py/payments/gateway.py');
    const call = refs(f, 'call', 'charge')[0] as ExtractedRef & { hint?: string };
    expect(call.qualifier).toBe('gateway');
    expect(call.hint).toBe('T:PaymentGateway');
    // RefundModel is `Refund as RefundModel`
    expect(refs(f, 'new', 'Refund')).toHaveLength(1);
    expect(refs(f, 'import', 'Refund')[0].qualifier).toBe('.models');
    expect(refs(f, 'type_ref', 'Refund')).toHaveLength(1);
  });
});

describe('c#', () => {
  it('extracts namespaced types, members, properties and xml docs', async () => {
    const f = await ex('cs/Billing/InvoiceService.cs');
    expect(f.namespace).toBe('Acme.Billing');
    const cls = sym(f, 'Acme.Billing.InvoiceService');
    expect(cls.doc).toBe('Creates and sends invoices.');
    expect(cls.signature).toBe('public class InvoiceService : IInvoiceService');
    const send = sym(f, 'Acme.Billing.InvoiceService.Send');
    expect(send.doc).toBe('Sends the invoice to the customer.');
    expect(send.signature).toBe('public void Send(Invoice invoice)');
    expect(sym(f, 'Acme.Billing.InvoiceService.Render').exported).toBe(false);
    expect(sym(f, 'Acme.Billing.InvoiceService.Count').kind).toBe('property');
    expect(sym(f, 'Acme.Billing.InvoiceService.MaxLines').kind).toBe('constant');
    expect(sym(f, 'Acme.Billing.InvoiceService.InvoiceService').kind).toBe('constructor');
    expect(sym(f, 'Acme.Billing.IInvoiceService.Send').exported).toBe(true);
    expect(f.symbols.map((s) => s.name)).not.toContain('body');
    expect(refs(f, 'implement', 'IInvoiceService')).toHaveLength(1);
    expect((refs(f, 'call', 'Deliver')[0] as ExtractedRef & { hint?: string }).hint).toBe('T:IMailer');
  });

  it('handles file-scoped namespaces, records and structs', async () => {
    const f = await ex('cs/Billing/Models.cs');
    expect(sym(f, 'Acme.Billing.Invoice').kind).toBe('record');
    expect(sym(f, 'Acme.Billing.Invoice.Email').kind).toBe('property');
    expect(sym(f, 'Acme.Billing.Money').kind).toBe('struct');
  });
});

describe('go', () => {
  it('extracts structs, methods as Receiver.Method, interfaces, consts', async () => {
    const f = await ex('go/ledger/ledger.go');
    expect(f.namespace).toBe('ledger');
    expect(f.imports).toEqual(['fmt', 'strings']);
    const st = sym(f, 'ledger.Ledger');
    expect(st.kind).toBe('struct');
    expect(st.doc).toBe('Ledger records entries per account.');
    const m = sym(f, 'ledger.Ledger.Record');
    expect(m.kind).toBe('method');
    expect(m.signature).toBe('func (l *Ledger) Record(account string, e Entry) error');
    expect(f.symbols[m.parent!].name).toBe('Ledger');
    expect(sym(f, 'ledger.Recorder').kind).toBe('interface');
    expect(sym(f, 'ledger.Recorder.Record').kind).toBe('method');
    expect(sym(f, 'ledger.MaxEntries').kind).toBe('constant');
    expect(sym(f, 'ledger.Ledger.entries').exported).toBe(false);
    expect(sym(f, 'ledger.Ledger.Name').exported).toBe(true);
    expect(sym(f, 'ledger.helper').exported).toBe(false);
    expect(f.symbols.map((s) => s.name)).not.toContain('key');
    expect(refs(f, 'inherit', 'Store')).toHaveLength(1); // embedding
    expect((refs(f, 'call', 'Println')[0] as ExtractedRef & { hint?: string }).hint).toBe('M:fmt');
    expect(refs(f, 'new', 'Ledger')).toHaveLength(1);
  });
});

describe('kotlin', () => {
  it('extracts classes, objects, functions, properties, companion constants', async () => {
    const f = await ex('kt/com/acme/notify/Notifier.kt');
    expect(f.namespace).toBe('com.acme.notify');
    const cls = sym(f, 'com.acme.notify.Notifier');
    expect(cls.doc).toBe('Sends notifications to customers.');
    expect(cls.signature).toBe('class Notifier(private val sender: EmailSender) : BaseNotifier(), Closeable');
    const fn = sym(f, 'com.acme.notify.Notifier.notifyRefund');
    expect(fn.kind).toBe('method');
    expect(fn.signature).toBe('fun notifyRefund(orderId: String, amount: Double): Boolean');
    expect(fn.doc).toBe('Notifies about a refund.');
    expect(sym(f, 'com.acme.notify.Notifier.format').exported).toBe(false);
    expect(sym(f, 'com.acme.notify.Notifier.sender').doc).toBeUndefined();
    expect(sym(f, 'com.acme.notify.Notifier.DEFAULT_CHANNEL').kind).toBe('constant');
    expect(sym(f, 'com.acme.notify.EmailSender').kind).toBe('interface');
    expect(sym(f, 'com.acme.notify.NotifierRegistry').kind).toBe('class');
    expect(sym(f, 'com.acme.notify.topLevelHelper').kind).toBe('function');
    expect(f.symbols.map((s) => s.name)).not.toContain('msg');
    expect(refs(f, 'inherit', 'BaseNotifier')).toHaveLength(1);
    expect(refs(f, 'implement', 'Closeable')).toHaveLength(1);
    expect((refs(f, 'call', 'send')[0] as ExtractedRef & { hint?: string }).hint).toBe('T:EmailSender');
  });
});

describe('best-effort languages', () => {
  it('rust', async () => {
    const f = await extractFile(
      'src/user.rs',
      `/// A user.\npub struct User { pub name: String }\nimpl User {\n    /// Builds one.\n    pub fn new(name: String) -> Self { User { name } }\n}\npub trait Greeter { fn greet(&self) -> String; }\nfn helper() { let u = User::new("x".into()); }\n`,
    );
    expect(f!.symbols.map((s) => `${s.kind}:${s.qualifiedName}`)).toEqual([
      'struct:User', 'field:User.name', 'method:User.new', 'trait:Greeter', 'method:Greeter.greet', 'function:helper',
    ]);
    expect(f!.symbols[0].doc).toBe('A user.');
    expect(f!.symbols[2].doc).toBe('Builds one.');
  });

  it('php, ruby, scala', async () => {
    const php = await extractFile('app/Svc.php', `<?php\nnamespace App;\nclass Svc extends Base {\n  public function run($x) { return $this->go($x); }\n  private function go($x) {}\n}\n`);
    expect(php!.symbols.map((s) => s.qualifiedName)).toEqual(['App.Svc', 'App.Svc.run', 'App.Svc.go']);
    expect(php!.symbols[2].exported).toBe(false);
    const rb = await extractFile('lib/svc.rb', `module Billing\n  # Computes invoices.\n  class Invoice < Base\n    def total(x)\n      helper(x)\n    end\n  end\nend\n`);
    expect(rb!.symbols.map((s) => s.qualifiedName)).toEqual(['Billing', 'Billing.Invoice', 'Billing.Invoice.total']);
    expect(rb!.symbols[1].doc).toBe('Computes invoices.');
    const sc = await extractFile('src/Svc.scala', `package com.acme\nclass Svc(val repo: Repo) extends Base {\n  def run(x: Int): Int = repo.save(x)\n}\nobject Svc { def apply(): Svc = new Svc(null) }\n`);
    expect(sc!.symbols.map((s) => s.qualifiedName)).toEqual(['com.acme.Svc', 'com.acme.Svc.run', 'com.acme.Svc', 'com.acme.Svc.apply']);
  });
});

describe('robustness', () => {
  it('returns undefined for unknown languages and survives broken code', async () => {
    expect(await extractFile('README.md', '# hi')).toBeUndefined();
    const f = await extractFile('broken.ts', 'export function bad(a: number {\n  return a +;\n}\n\nexport function ok(): number {\n  return 1;\n}\n');
    expect(f!.symbols.map((s) => s.name)).toEqual(['bad', 'ok']);
    const j = await extractFile('A.java', 'class A {\n  void f( {\n  }\n  int g() { return 1; }\n}\n');
    expect(j!.symbols.map((s) => s.qualifiedName)).toEqual(['A', 'A.f', 'A.g']);
    const garbage = await extractFile('g.ts', 'export class { function ( {{{ \n )))');
    expect(garbage).toBeDefined();
  });

  it('reports UTF-8 byte offsets', async () => {
    const f = await extractFile('u.py', '# é\ndef f():\n    pass\n');
    expect(f!.symbols[0].startByte).toBe(Buffer.byteLength('# é\n'));
  });

  it('detects minified text', () => {
    expect(isMinified('var a=1;'.repeat(600))).toBe(true);
    expect(isMinified('const a = 1;\n'.repeat(1000))).toBe(false);
  });

  it('caps signature and doc lengths', async () => {
    const params = Array.from({ length: 60 }, (_, i) => `p${i}: number`).join(', ');
    const doc = 'Very long doc '.repeat(40);
    const f = await extractFile('x.ts', `/** ${doc}. */\nexport function f(${params}): void {}\n`);
    expect(f!.symbols[0].signature.length).toBeLessThanOrEqual(300);
    expect(f!.symbols[0].doc!.length).toBeLessThanOrEqual(200);
  });
});
