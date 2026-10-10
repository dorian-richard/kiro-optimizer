// Regenerates the compress fixtures: `node test/fixtures/compress/generate.mjs`.
// Outputs imitate the real tools' formats (CI / non-TTY mode). Long passing runs are generated, failing
// sections are written by hand. Paths use the fake repo root /home/dev/shop.
// Not generated here: vitest-kopt-pass.txt, vitest-kopt-fail.txt and build-kopt-fail.txt are real outputs of this
// repository's own `npx vitest run` (passing, and with one injected failing assertion) and `npm run build` (after
// renaming ToolResult.tokens), captured through kopt_run's runner with the worktree path rewritten to /home/dev/shop.
// vitest-kopt-many-fail.txt (19 failures in 4 files) and vitest-kopt-diff-fail.txt (5 failures with object diffs)
// are stored kopt_run logs of two failing runs of this repository's suite. node-test-*.txt are real node:test runs
// (Node 22) of a small project, captured through kopt_run's runner: `npm test` failing (TAP, node's reporter when
// the output is not a terminal) and passing, `node --test --test-reporter=spec` failing, and `node --test` with a
// test file that does not load, an assertion on numbers, a custom message, a timeout and a skipped test.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const out = (name, text) => writeFileSync(join(DIR, name), text.replace(/^\n/, ''));

// Deterministic pseudo-random
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const pad = (s, n, ch = ' ') => (s.length >= n ? s : s + ch.repeat(n - s.length));

const domains = ['cart', 'orders', 'refunds', 'payments', 'invoices', 'customers', 'catalog', 'inventory', 'shipping', 'auth', 'pricing', 'tax', 'discounts', 'reports', 'webhooks', 'notifications'];
const verbs = ['creates', 'updates', 'deletes', 'lists', 'validates', 'rejects', 'computes', 'formats', 'parses', 'serializes', 'handles', 'retries', 'caches', 'paginates'];
const nouns = ['item', 'order', 'total', 'refund', 'invoice', 'customer', 'address', 'token', 'discount', 'currency', 'payload', 'batch', 'page', 'timeout', 'rounding'];

// ---------------------------------------------------------------------------------------------------------------
// pytest

function pytestHeader(n) {
  return `============================= test session starts ==============================
platform linux -- Python 3.11.9, pytest-8.2.1, pluggy-1.5.0 -- /home/dev/shop/.venv/bin/python
cachedir: .pytest_cache
rootdir: /home/dev/shop
configfile: pyproject.toml
testpaths: tests
plugins: cov-5.0.0, asyncio-0.23.7, mock-3.14.0, xdist-3.6.1
asyncio: mode=Mode.STRICT
collecting ... collected ${n} items
`;
}

function pytestPass() {
  const n = 412;
  const lines = [];
  for (let i = 0; i < n; i++) {
    const d = domains[i % domains.length];
    const name = `test_${pick(verbs)}_${pick(nouns)}_${i}`;
    const status = i % 97 === 13 ? 'SKIPPED (requires redis)' : 'PASSED';
    const pct = `[${String(Math.floor(((i + 1) * 100) / n)).padStart(3)}%]`;
    lines.push(`${pad(`tests/${d}/test_${d}.py::${name} ${status}`, 73)} ${pct}`);
  }
  return `${pytestHeader(n)}
${lines.join('\n')}

=============================== warnings summary ===============================
tests/orders/test_orders.py::test_lists_order_17
  /home/dev/shop/.venv/lib/python3.11/site-packages/flask/json/provider.py:120: DeprecationWarning: datetime.datetime.utcnow() is deprecated and scheduled for removal in a future version.
    warnings.warn(

tests/payments/test_payments.py::test_retries_payload_35
  /home/dev/shop/shop/payments/client.py:44: ResourceWarning: unclosed <socket.socket fd=12>
    self._session = requests.Session()

-- Docs: https://docs.pytest.org/en/stable/how-to/capture-warnings.html
============ 407 passed, 5 skipped, 2 warnings in 12.34s (0:00:12) =============
`;
}

function pytestFail() {
  const n = 380;
  const lines = [];
  const fails = new Map([
    [41, 'FAILED'], [120, 'FAILED'], [200, 'ERROR'], [201, 'ERROR'], [202, 'ERROR'], [203, 'ERROR'], [204, 'ERROR'],
  ]);
  for (let i = 0; i < n; i++) {
    const d = domains[i % domains.length];
    let nodeid = `tests/${d}/test_${d}.py::test_${pick(verbs)}_${pick(nouns)}_${i}`;
    if (i === 41) nodeid = 'tests/refunds/test_refunds.py::test_refund_partial';
    if (i === 120) nodeid = 'tests/api/test_api.py::test_create_order';
    if (i >= 200 && i <= 204) nodeid = `tests/db/test_repository.py::test_repository_query_${i - 200}`;
    const status = fails.get(i) ?? 'PASSED';
    const pct = `[${String(Math.floor(((i + 1) * 100) / n)).padStart(3)}%]`;
    lines.push(`${pad(`${nodeid} ${status}`, 73)} ${pct}`);
  }
  const fixtureErr = (k) => `_____________________ ERROR at setup of test_repository_query_${k} _____________________

    @pytest.fixture
    def db_session():
>       engine = create_engine(settings.DATABASE_URL)

tests/conftest.py:31:
_ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _
.venv/lib/python3.11/site-packages/sqlalchemy/engine/create.py:610: in create_engine
    dbapi = dbapi_meth(**dbapi_args)
.venv/lib/python3.11/site-packages/sqlalchemy/dialects/postgresql/psycopg2.py:690: in import_dbapi
    import psycopg2
_ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _

    """
>   from psycopg2._psycopg import (                     # noqa
        BINARY, NUMBER, STRING, DATETIME, ROWID,
E   ImportError: libpq.so.5: cannot open shared object file: No such file or directory

.venv/lib/python3.11/site-packages/psycopg2/__init__.py:51: ImportError
`;
  return `${pytestHeader(n)}
${lines.join('\n')}

==================================== ERRORS ====================================
${[0, 1, 2, 3, 4].map(fixtureErr).join('')}=================================== FAILURES ===================================
_________________________ test_refund_partial __________________________

    def test_refund_partial():
        order = make_order(total=Decimal("100.00"), paid=True)
        refund = compute_refund(order, percent=30)
>       assert refund.amount == Decimal("70.00")
E       AssertionError: assert Decimal('60.00') == Decimal('70.00')
E        +  where Decimal('60.00') = Refund(order_id=1, amount=Decimal('60.00'), reason=None).amount

tests/refunds/test_refunds.py:42: AssertionError
----------------------------- Captured stdout call -----------------------------
computing refund for order 1
applying fee policy DefaultFeePolicy(rate=0.1)
------------------------------ Captured log call -------------------------------
INFO     shop.refunds.service:service.py:88 refund computed order=1 amount=60.00
____________________________ test_create_order _____________________________

client = <FlaskClient <Flask 'shop'>>

    def test_create_order(client):
>       resp = client.post("/orders", json={"items": [1, 2]})

tests/api/test_api.py:18:
_ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _
.venv/lib/python3.11/site-packages/werkzeug/test.py:1167: in post
    return self.open(*args, **kw)
.venv/lib/python3.11/site-packages/flask/testing.py:232: in open
    response = super().open(
.venv/lib/python3.11/site-packages/werkzeug/test.py:1116: in open
    response = self.run_wsgi_app(request.environ, buffered=buffered)
.venv/lib/python3.11/site-packages/werkzeug/test.py:988: in run_wsgi_app
    rv = run_wsgi_app(self.application, environ, buffered=buffered)
.venv/lib/python3.11/site-packages/flask/app.py:1498: in wsgi_app
    response = self.handle_exception(e)
.venv/lib/python3.11/site-packages/flask/app.py:1476: in wsgi_app
    response = self.full_dispatch_request()
shop/api/orders.py:27: in create_order
    customer = load_customer(payload)
_ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _

payload = {'items': [1, 2]}

    def load_customer(payload: dict) -> Customer:
>       customer_id = payload["customer_id"]
E       KeyError: 'customer_id'

shop/customers/loader.py:12: KeyError
=========================== short test summary info ============================
FAILED tests/refunds/test_refunds.py::test_refund_partial - AssertionError: assert Decimal('60.00') == Decimal('70.00')
FAILED tests/api/test_api.py::test_create_order - KeyError: 'customer_id'
ERROR tests/db/test_repository.py::test_repository_query_0 - ImportError: libpq.so.5: cannot open shared object file: No such file or directory
ERROR tests/db/test_repository.py::test_repository_query_1 - ImportError: libpq.so.5: cannot open shared object file: No such file or directory
ERROR tests/db/test_repository.py::test_repository_query_2 - ImportError: libpq.so.5: cannot open shared object file: No such file or directory
ERROR tests/db/test_repository.py::test_repository_query_3 - ImportError: libpq.so.5: cannot open shared object file: No such file or directory
ERROR tests/db/test_repository.py::test_repository_query_4 - ImportError: libpq.so.5: cannot open shared object file: No such file or directory
============= 2 failed, 373 passed, 5 errors in 14.87s (0:00:14) ==============
`;
}

function unittestFail() {
  const dots = [];
  for (let i = 0; i < 6; i++) dots.push('.'.repeat(70));
  return `Creating test database for alias 'default'...
System check identified no issues (0 silenced).
${dots.join('\n')}
.....F.........E..................s...........
======================================================================
ERROR: test_invoice_pdf (billing.tests.test_invoices.InvoicePdfTests.test_invoice_pdf)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/home/dev/shop/billing/tests/test_invoices.py", line 58, in test_invoice_pdf
    pdf = render_invoice(self.invoice)
          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "/home/dev/shop/billing/pdf.py", line 21, in render_invoice
    return HTML(string=html).write_pdf()
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "/home/dev/shop/.venv/lib/python3.11/site-packages/weasyprint/__init__.py", line 252, in write_pdf
    self.render(font_config, counter_style, **options)
  File "/home/dev/shop/.venv/lib/python3.11/site-packages/weasyprint/document.py", line 112, in render
    raise OSError("cannot load library 'gobject-2.0-0'")
OSError: cannot load library 'gobject-2.0-0'

======================================================================
FAIL: test_refund_rounding (billing.tests.test_refunds.RefundTests.test_refund_rounding)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/home/dev/shop/billing/tests/test_refunds.py", line 31, in test_refund_rounding
    self.assertEqual(refund.amount, Decimal("33.34"))
AssertionError: Decimal('33.33') != Decimal('33.34')

----------------------------------------------------------------------
Ran 466 tests in 8.512s

FAILED (failures=1, errors=1, skipped=1)
Destroying test database for alias 'default'...
`;
}

// ---------------------------------------------------------------------------------------------------------------
// jest / vitest

function jestPass() {
  const lines = [];
  let tests = 0;
  for (let f = 0; f < 120; f++) {
    const d = domains[f % domains.length];
    const file = `src/${d}/${pick(nouns)}${f}.test.ts`;
    lines.push(`PASS ${file}${f % 9 === 0 ? ` (${(rnd() * 6 + 1).toFixed(3)} s)` : ''}`);
    const k = 3 + Math.floor(rnd() * 5);
    lines.push(`  ${d} ${pick(nouns)}`);
    for (let t = 0; t < k; t++) {
      lines.push(`    ✓ ${pick(verbs)} ${pick(nouns)} when ${pick(nouns)} is ${pick(['empty', 'valid', 'missing', 'expired', 'negative'])} (${Math.floor(rnd() * 40) + 1} ms)`);
      tests++;
    }
    lines.push('');
  }
  return `${lines.join('\n')}
Test Suites: 120 passed, 120 total
Tests:       ${tests} passed, ${tests} total
Snapshots:   32 passed, 32 total
Time:        45.67 s
Ran all test suites.
`;
}

function jestFail() {
  const lines = [];
  for (let f = 0; f < 60; f++) lines.push(`PASS src/${domains[f % domains.length]}/${pick(nouns)}${f}.test.ts`);
  return `${lines.slice(0, 30).join('\n')}
FAIL src/cart/cart.test.ts (5.123 s)
  ● Cart › computes total with discount

    expect(received).toBe(expected) // Object.is equality

    Expected: 90
    Received: 100

      12 |     const cart = new Cart([{ price: 100 }]);
      13 |     cart.applyDiscount(0.1);
    > 14 |     expect(cart.total()).toBe(90);
         |                          ^
      15 |   });
      16 |
      17 |   it('handles empty cart', () => {

      at Object.<anonymous> (src/cart/cart.test.ts:14:26)

  ● Cart › handles empty cart

    TypeError: Cannot read properties of undefined (reading 'reduce')

      20 |
      21 |   total(): number {
    > 22 |     return this.items.reduce((s, i) => s + i.price, 0) * (1 - this.discount);
         |                       ^
      23 |   }
      24 |
      25 |   applyDiscount(rate: number) {

      at Cart.total (src/cart/cart.ts:22:23)
      at Object.<anonymous> (src/cart/cart.test.ts:19:17)
      at Promise.then.completed (node_modules/jest-circus/build/utils.js:298:28)
      at new Promise (<anonymous>)
      at callAsyncCircusFn (node_modules/jest-circus/build/utils.js:231:10)
      at _callCircusTest (node_modules/jest-circus/build/run.js:316:40)
      at processTicksAndRejections (node:internal/process/task_queues:95:5)
      at _runTest (node_modules/jest-circus/build/run.js:252:3)

  ● Console

    console.log
      cart created with 0 items

      at Cart.log [as constructor] (src/cart/cart.ts:8:13)

${lines.slice(30).join('\n')}
FAIL src/orders/orderSummary.test.tsx
  ● OrderSummary › renders line items

    expect(received).toMatchSnapshot()

    Snapshot name: \`OrderSummary renders line items 1\`

    - Snapshot  - 1
    + Received  + 1

      <div
        className="summary"
      >
    -   Total: $90.00
    +   Total: $100.00
      </div>

      31 |   it('renders line items', () => {
      32 |     const tree = renderer.create(<OrderSummary order={order} />).toJSON();
    > 33 |     expect(tree).toMatchSnapshot();
         |                  ^
      34 |   });

      at Object.<anonymous> (src/orders/orderSummary.test.tsx:33:18)

Summary of all failing tests
FAIL src/cart/cart.test.ts (5.123 s)
  ● Cart › computes total with discount

    expect(received).toBe(expected) // Object.is equality

    Expected: 90
    Received: 100

      at Object.<anonymous> (src/cart/cart.test.ts:14:26)

  ● Cart › handles empty cart

    TypeError: Cannot read properties of undefined (reading 'reduce')

      at Cart.total (src/cart/cart.ts:22:23)

FAIL src/orders/orderSummary.test.tsx
  ● OrderSummary › renders line items

    expect(received).toMatchSnapshot()


Test Suites: 2 failed, 60 passed, 62 total
Tests:       3 failed, 412 passed, 415 total
Snapshots:   1 failed, 31 passed, 32 total
Time:        38.912 s
Ran all test suites.
`;
}

function vitestPass() {
  const lines = [' RUN  v1.6.0 /home/dev/shop', ''];
  let tests = 0;
  for (let f = 0; f < 140; f++) {
    const k = 2 + Math.floor(rnd() * 12);
    tests += k;
    lines.push(` ✓ src/${domains[f % domains.length]}/${pick(nouns)}${f}.test.ts  (${k} tests) ${Math.floor(rnd() * 300) + 2}ms`);
  }
  return `${lines.join('\n')}

 Test Files  140 passed (140)
      Tests  ${tests} passed (${tests})
   Start at  10:12:01
   Duration  6.52s (transform 1.21s, setup 0ms, collect 3.42s, tests 2.18s, environment 5ms, prepare 3.10s)
`;
}

function vitestFail() {
  const lines = [' RUN  v1.6.0 /home/dev/shop', ''];
  for (let f = 0; f < 80; f++) lines.push(` ✓ src/${domains[f % domains.length]}/${pick(nouns)}${f}.test.ts  (${2 + (f % 7)} tests) ${10 + f}ms`);
  return `${lines.join('\n')}
 ❯ src/cart/cart.test.ts  (3 tests | 2 failed) 15ms
   × Cart > computes total with discount
     → expected 100 to be 90 // Object.is equality
   × Cart > computes total with coupon
     → expected 100 to be 90 // Object.is equality

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/cart/cart.test.ts > Cart > computes total with discount
 FAIL  src/cart/cart.test.ts > Cart > computes total with coupon
AssertionError: expected 100 to be 90 // Object.is equality

- Expected
+ Received

- 90
+ 100

 ❯ src/cart/cart.test.ts:14:26
     12|     const cart = new Cart([{ price: 100 }]);
     13|     cart.applyDiscount(0.1);
     14|     expect(cart.total()).toBe(90);
       |                          ^
     15|   });
     16|

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed | 80 passed (81)
      Tests  2 failed | 498 passed (500)
   Start at  10:12:01
   Duration  4.52s (transform 1.20s, setup 0ms, collect 3.40s, tests 2.10s, environment 5ms, prepare 3.10s)

`;
}

// ---------------------------------------------------------------------------------------------------------------
// maven

const MODULES = ['shop-parent', 'shop-model', 'shop-core', 'shop-persistence', 'shop-api', 'shop-web'];

function mavenModule(name, i, { tests = true } = {}) {
  const L = [];
  L.push(`[INFO] `);
  L.push(`[INFO] ${pad(`-----------------------< com.acme.shop:${name} >`, 72, '-')}`);
  L.push(`[INFO] Building ${name} 1.4.0-SNAPSHOT                                  [${i + 1}/${MODULES.length}]`);
  L.push(`[INFO] --------------------------------[ jar ]---------------------------------`);
  if (name === 'shop-parent') {
    L.push(`[INFO] `);
    L.push(`[INFO] --- maven-enforcer-plugin:3.4.1:enforce (enforce-versions) @ ${name} ---`);
    return L;
  }
  for (let d = 0; d < 6; d++) {
    L.push(`[INFO] Downloading from central: https://repo.maven.apache.org/maven2/org/springframework/spring-core/6.1.${d}/spring-core-6.1.${d}.pom`);
    L.push(`[INFO] Downloaded from central: https://repo.maven.apache.org/maven2/org/springframework/spring-core/6.1.${d}/spring-core-6.1.${d}.pom (2.1 kB at 45 kB/s)`);
  }
  L.push(`[INFO] `);
  L.push(`[INFO] --- maven-resources-plugin:3.3.1:resources (default-resources) @ ${name} ---`);
  L.push(`[INFO] Copying 4 resources from src/main/resources to target/classes`);
  L.push(`[INFO] `);
  L.push(`[INFO] --- maven-compiler-plugin:3.11.0:compile (default-compile) @ ${name} ---`);
  L.push(`[INFO] Changes detected - recompiling the module! :source`);
  L.push(`[INFO] Compiling ${40 + i * 13} source files with javac [debug release 17] to target/classes`);
  L.push(`[WARNING] /home/dev/shop/${name}/src/main/java/com/acme/shop/legacy/LegacyMapper.java:[33,18] [deprecation] getRawValue() in Field has been deprecated`);
  L.push(`[INFO] `);
  L.push(`[INFO] --- maven-surefire-plugin:3.2.5:test (default-test) @ ${name} ---`);
  if (!tests) return L;
  L.push(`[INFO] Using auto detected provider org.apache.maven.surefire.junitplatform.JUnitPlatformProvider`);
  L.push(`[INFO] `);
  L.push(`[INFO] -------------------------------------------------------`);
  L.push(`[INFO]  T E S T S`);
  L.push(`[INFO] -------------------------------------------------------`);
  let total = 0;
  for (let c = 0; c < 18; c++) {
    const cls = `com.acme.shop.${domains[(c + i) % domains.length]}.${pick(['Order', 'Refund', 'Price', 'Invoice', 'Customer'])}${pick(['Service', 'Repository', 'Mapper', 'Validator'])}Test`;
    const n = 3 + Math.floor(rnd() * 12);
    total += n;
    L.push(`[INFO] Running ${cls}`);
    L.push(`[INFO] Tests run: ${n}, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: ${(rnd() * 2).toFixed(3)} s -- in ${cls}`);
  }
  L.push(`[INFO] `);
  L.push(`[INFO] Results:`);
  L.push(`[INFO] `);
  L.push(`[INFO] Tests run: ${total}, Failures: 0, Errors: 0, Skipped: 0`);
  L.push(`[INFO] `);
  L.push(`[INFO] `);
  L.push(`[INFO] --- maven-jar-plugin:3.3.0:jar (default-jar) @ ${name} ---`);
  L.push(`[INFO] Building jar: /home/dev/shop/${name}/target/${name}-1.4.0-SNAPSHOT.jar`);
  return L;
}

function mavenPass() {
  const L = ['[INFO] Scanning for projects...', '[INFO] ------------------------------------------------------------------------', '[INFO] Reactor Build Order:', '[INFO] '];
  for (const m of MODULES) L.push(`[INFO] ${pad(m, 52)}[jar]`);
  MODULES.forEach((m, i) => L.push(...mavenModule(m, i)));
  L.push('[INFO] ------------------------------------------------------------------------');
  L.push('[INFO] Reactor Summary for shop-parent 1.4.0-SNAPSHOT:');
  L.push('[INFO] ');
  for (const m of MODULES) L.push(`[INFO] ${pad(`${m} `, 51, '.')}`.replace(/ $/, ' ') + ` SUCCESS [ ${(rnd() * 20).toFixed(3)} s]`);
  L.push('[INFO] ------------------------------------------------------------------------');
  L.push('[INFO] BUILD SUCCESS');
  L.push('[INFO] ------------------------------------------------------------------------');
  L.push('[INFO] Total time:  01:12 min');
  L.push('[INFO] Finished at: 2026-10-09T10:15:42+02:00');
  L.push('[INFO] ------------------------------------------------------------------------');
  return L.join('\n') + '\n';
}

function mavenCompileFail() {
  const L = ['[INFO] Scanning for projects...', '[INFO] ------------------------------------------------------------------------', '[INFO] Reactor Build Order:', '[INFO] '];
  for (const m of MODULES) L.push(`[INFO] ${pad(m, 52)}[jar]`);
  L.push(...mavenModule('shop-parent', 0), ...mavenModule('shop-model', 1));
  L.push(...mavenModule('shop-core', 2, { tests: false }).slice(0, -3));
  const errs = `[INFO] -------------------------------------------------------------
[ERROR] COMPILATION ERROR :
[INFO] -------------------------------------------------------------
[ERROR] /home/dev/shop/shop-core/src/main/java/com/acme/shop/orders/OrderService.java:[42,17] cannot find symbol
  symbol:   method computeTotal(java.util.List<com.acme.shop.model.Item>)
  location: variable calculator of type com.acme.shop.pricing.PriceCalculator
[ERROR] /home/dev/shop/shop-core/src/main/java/com/acme/shop/orders/OrderService.java:[57,29] incompatible types: java.lang.String cannot be converted to int
[ERROR] /home/dev/shop/shop-core/src/main/java/com/acme/shop/refunds/RefundService.java:[88,9] method does not override or implement a method from a supertype
[INFO] 3 errors
[INFO] -------------------------------------------------------------`;
  L.push(...errs.split('\n'));
  L.push('[INFO] ------------------------------------------------------------------------');
  L.push('[INFO] Reactor Summary for shop-parent 1.4.0-SNAPSHOT:');
  L.push('[INFO] ');
  MODULES.forEach((m, i) => L.push(`[INFO] ${pad(`${m} `, 51, '.')}`.replace(/ $/, ' ') + (i < 2 ? ` SUCCESS [  ${(rnd() * 9).toFixed(3)} s]` : i === 2 ? ' FAILURE [  3.217 s]' : ' SKIPPED')));
  L.push(...`[INFO] ------------------------------------------------------------------------
[INFO] BUILD FAILURE
[INFO] ------------------------------------------------------------------------
[INFO] Total time:  14.902 s
[INFO] Finished at: 2026-10-09T10:15:42+02:00
[INFO] ------------------------------------------------------------------------
[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.11.0:compile (default-compile) on project shop-core: Compilation failure: Compilation failure:
[ERROR] /home/dev/shop/shop-core/src/main/java/com/acme/shop/orders/OrderService.java:[42,17] cannot find symbol
[ERROR]   symbol:   method computeTotal(java.util.List<com.acme.shop.model.Item>)
[ERROR]   location: variable calculator of type com.acme.shop.pricing.PriceCalculator
[ERROR] /home/dev/shop/shop-core/src/main/java/com/acme/shop/orders/OrderService.java:[57,29] incompatible types: java.lang.String cannot be converted to int
[ERROR] /home/dev/shop/shop-core/src/main/java/com/acme/shop/refunds/RefundService.java:[88,9] method does not override or implement a method from a supertype
[ERROR] -> [Help 1]
[ERROR]
[ERROR] To see the full stack trace of the errors, re-run Maven with the -e switch.
[ERROR] Re-run Maven using the -X switch to enable full debug logging.
[ERROR]
[ERROR] For more information about the errors and possible solutions, please read the following articles:
[ERROR] [Help 1] http://cwiki.apache.org/confluence/display/MAVEN/MojoFailureException
[ERROR]
[ERROR] After correcting the problems, you can resume the build with the command
[ERROR]   mvn <args> -rf :shop-core`.split('\n'));
  return L.join('\n') + '\n';
}

function junitFrames() {
  return `	at org.junit.jupiter.api.AssertionFailureBuilder.build(AssertionFailureBuilder.java:151)
	at org.junit.jupiter.api.AssertionFailureBuilder.buildAndThrow(AssertionFailureBuilder.java:132)
	at org.junit.jupiter.api.AssertEquals.failNotEqual(AssertEquals.java:197)
	at org.junit.jupiter.api.AssertEquals.assertEquals(AssertEquals.java:182)
	at org.junit.jupiter.api.Assertions.assertEquals(Assertions.java:1156)`;
}

function reflectFrames() {
  return `	at java.base/jdk.internal.reflect.DirectMethodHandleAccessor.invoke(DirectMethodHandleAccessor.java:103)
	at java.base/java.lang.reflect.Method.invoke(Method.java:580)
	at org.junit.platform.commons.util.ReflectionUtils.invokeMethod(ReflectionUtils.java:728)
	at org.junit.jupiter.engine.execution.MethodInvocation.proceed(MethodInvocation.java:60)
	at org.junit.jupiter.engine.execution.InvocationInterceptorChain$ValidatingInvocation.proceed(InvocationInterceptorChain.java:131)
	at org.junit.jupiter.engine.extension.TimeoutExtension.intercept(TimeoutExtension.java:156)
	at org.junit.jupiter.engine.descriptor.TestMethodTestDescriptor.invokeTestMethod(TestMethodTestDescriptor.java:218)
	at org.apache.maven.surefire.junitplatform.JUnitPlatformProvider.invoke(JUnitPlatformProvider.java:142)
	at org.apache.maven.surefire.booter.ForkedBooter.runSuitesInProcess(ForkedBooter.java:385)
	at org.apache.maven.surefire.booter.ForkedBooter.main(ForkedBooter.java:507)`;
}

function mavenTestFail() {
  const L = ['[INFO] Scanning for projects...'];
  L.push(...mavenModule('shop-core', 2, { tests: false }));
  L.push('[INFO] ', '[INFO] -------------------------------------------------------', '[INFO]  T E S T S', '[INFO] -------------------------------------------------------');
  for (let c = 0; c < 30; c++) {
    const cls = `com.acme.shop.${domains[c % domains.length]}.${pick(['Order', 'Price', 'Invoice'])}${pick(['Service', 'Mapper'])}Test`;
    L.push(`[INFO] Running ${cls}`, `[INFO] Tests run: ${5 + (c % 9)}, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.${100 + c} s -- in ${cls}`);
    if (c === 12) {
      L.push(...`[INFO] Running com.acme.shop.refunds.RefundServiceTest
[ERROR] Tests run: 14, Failures: 1, Errors: 1, Skipped: 0, Time elapsed: 0.612 s <<< FAILURE! -- in com.acme.shop.refunds.RefundServiceTest
[ERROR] com.acme.shop.refunds.RefundServiceTest.refundPartial -- Time elapsed: 0.012 s <<< FAILURE!
org.opentest4j.AssertionFailedError: expected: <70.00> but was: <60.00>
${junitFrames()}
	at com.acme.shop.refunds.RefundServiceTest.refundPartial(RefundServiceTest.java:42)
${reflectFrames()}

[ERROR] com.acme.shop.refunds.RefundServiceTest.refundForUnknownOrder -- Time elapsed: 0.003 s <<< ERROR!
java.lang.NullPointerException: Cannot invoke "com.acme.shop.model.Order.getCustomer()" because "order" is null
	at com.acme.shop.refunds.RefundService.refund(RefundService.java:57)
	at com.acme.shop.refunds.RefundServiceTest.refundForUnknownOrder(RefundServiceTest.java:77)
${reflectFrames()}
`.split('\n'));
    }
  }
  L.push(...`[INFO]
[INFO] Results:
[INFO]
[ERROR] Failures:
[ERROR]   RefundServiceTest.refundPartial:42 expected: <70.00> but was: <60.00>
[ERROR] Errors:
[ERROR]   RefundServiceTest.refundForUnknownOrder:77 NullPointer Cannot invoke "com.acme.shop.model.Order.getCustomer()" because "order" is null
[INFO]
[ERROR] Tests run: 312, Failures: 1, Errors: 1, Skipped: 0
[INFO]
[INFO] ------------------------------------------------------------------------
[INFO] BUILD FAILURE
[INFO] ------------------------------------------------------------------------
[INFO] Total time:  21.338 s
[INFO] Finished at: 2026-10-09T10:15:42+02:00
[INFO] ------------------------------------------------------------------------
[ERROR] Failed to execute goal org.apache.maven.plugins:maven-surefire-plugin:3.2.5:test (default-test) on project shop-core: There are test failures.
[ERROR]
[ERROR] Please refer to /home/dev/shop/shop-core/target/surefire-reports for the individual test results.
[ERROR] Please refer to dump files (if any exist) [date].dump, [date]-jvmRun[N].dump and [date].dumpstream.
[ERROR] -> [Help 1]
[ERROR]
[ERROR] To see the full stack trace of the errors, re-run Maven with the -e switch.
[ERROR] Re-run Maven using the -X switch to enable full debug logging.
[ERROR]
[ERROR] For more information about the errors and possible solutions, please read the following articles:
[ERROR] [Help 1] http://cwiki.apache.org/confluence/display/MAVEN/MojoFailureException`.split('\n'));
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------------------------
// gradle

function gradleTasks(project) {
  return [':compileJava', ':processResources', ':classes', ':compileTestJava', ':processTestResources', ':testClasses', ':test', ':jar']
    .map((t) => `> Task :${project}${t}${t === ':processResources' ? ' NO-SOURCE' : t === ':classes' ? ' UP-TO-DATE' : ''}`);
}

function gradlePass() {
  const L = ['Starting a Gradle Daemon (subsequent builds will be faster)', '> Configure project :', 'Configuration on demand is an incubating feature.', ''];
  const projects = ['model', 'core', 'persistence', 'api', 'web', 'batch', 'notifications', 'reporting'];
  for (const p of projects) {
    L.push(...gradleTasks(p));
    for (let t = 0; t < 30; t++) L.push(`${pick(['Order', 'Refund', 'Invoice'])}${pick(['Service', 'Mapper'])}Test > ${pick(verbs)}${pick(nouns).replace(/^./, (c) => c.toUpperCase())}() PASSED`);
  }
  L.push('', 'Deprecated Gradle features were used in this build, making it incompatible with Gradle 9.0.', '', "You can use '--warning-mode all' to show the individual deprecation warnings and determine if they come from your own scripts or plugins.", '', 'For more on this, please refer to https://docs.gradle.org/8.7/userguide/command_line_interface.html#sec:command_line_warnings in the Gradle documentation.', '', 'BUILD SUCCESSFUL in 1m 4s', '64 actionable tasks: 64 executed');
  return L.join('\n') + '\n';
}

function gradleFail() {
  const L = ['> Configure project :'];
  for (const p of ['model', 'core', 'persistence']) L.push(...gradleTasks(p).slice(0, 6));
  L.push(...`> Task :api:compileJava FAILED
/home/dev/shop/api/src/main/java/com/acme/shop/api/OrderController.java:42: error: cannot find symbol
        BigDecimal total = calculator.computeTotal(items);
                                     ^
  symbol:   method computeTotal(List<Item>)
  location: variable calculator of type PriceCalculator
/home/dev/shop/api/src/main/java/com/acme/shop/api/OrderController.java:57: error: incompatible types: String cannot be converted to int
        int qty = request.getQuantity();
                                     ^
Note: Some input files use unchecked or unsafe operations.
Note: Recompile with -Xlint:unchecked for details.
2 errors

> Task :core:test FAILED

RefundServiceTest > refundPartial() FAILED
    org.opentest4j.AssertionFailedError: expected: <70.00> but was: <60.00>
        at app//org.junit.jupiter.api.AssertionFailureBuilder.build(AssertionFailureBuilder.java:151)
        at app//org.junit.jupiter.api.AssertionFailureBuilder.buildAndThrow(AssertionFailureBuilder.java:132)
        at app//org.junit.jupiter.api.AssertEquals.failNotEqual(AssertEquals.java:197)
        at app//org.junit.jupiter.api.AssertEquals.assertEquals(AssertEquals.java:182)
        at app//org.junit.jupiter.api.Assertions.assertEquals(Assertions.java:1156)
        at app//com.acme.shop.refunds.RefundServiceTest.refundPartial(RefundServiceTest.java:42)

RefundServiceTest > refundRounding() FAILED
    org.opentest4j.AssertionFailedError: expected: <33.34> but was: <33.33>
        at app//org.junit.jupiter.api.AssertionFailureBuilder.build(AssertionFailureBuilder.java:151)
        at app//org.junit.jupiter.api.Assertions.assertEquals(Assertions.java:1156)
        at app//com.acme.shop.refunds.RefundServiceTest.refundRounding(RefundServiceTest.java:61)

248 tests completed, 2 failed, 3 skipped

FAILURE: Build completed with 2 failures.

1: Task failed with an exception.
-----------
* What went wrong:
Execution failed for task ':api:compileJava'.
> Compilation failed; see the compiler error output for details.

* Try:
> Run with --info option to get more log output.
> Run with --scan to get full insights.
==============================================================================

2: Task failed with an exception.
-----------
* What went wrong:
Execution failed for task ':core:test'.
> There were failing tests. See the report at: file:///home/dev/shop/core/build/reports/tests/test/index.html

* Try:
> Run with --scan to get full insights.
==============================================================================

* Get more help at https://help.gradle.org

BUILD FAILED in 41s
37 actionable tasks: 12 executed, 25 up-to-date`.split('\n'));
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------------------------
// dotnet

const PROJECTS = ['Shop.Domain', 'Shop.Core', 'Shop.Infrastructure', 'Shop.Api', 'Shop.Worker', 'Shop.Tests'];

function dotnetBuildPass() {
  const L = ['MSBuild version 17.9.8+b34f75857 for .NET', '  Determining projects to restore...', '  All projects are up-to-date for restore.'];
  const warn = [];
  for (let i = 0; i < 40; i++) {
    const p = PROJECTS[i % 5];
    const w = `/home/dev/shop/src/${p}/${pick(['Orders', 'Refunds', 'Billing'])}/${pick(['OrderService', 'RefundPolicy', 'InvoiceMapper'])}.cs(${10 + i},${5 + (i % 30)}): warning ${pick(['CS8602', 'CS8618', 'CS0168'])}: ${pick(["Dereference of a possibly null reference.", "Non-nullable property 'Name' must contain a non-null value when exiting constructor.", "The variable 'ex' is declared but never used"])} [/home/dev/shop/src/${p}/${p}.csproj]`;
    warn.push(w);
    L.push(w);
  }
  for (const p of PROJECTS) L.push(`  ${p} -> /home/dev/shop/src/${p}/bin/Debug/net8.0/${p}.dll`);
  L.push('', 'Build succeeded.', '');
  L.push(...warn.map((w) => w));
  L.push(`    ${warn.length} Warning(s)`, '    0 Error(s)', '', 'Time Elapsed 00:00:18.42');
  return L.join('\n') + '\n';
}

function dotnetBuildFail() {
  const errs = [
    "/home/dev/shop/src/Shop.Core/Orders/OrderService.cs(42,17): error CS0103: The name 'ComputeTotal' does not exist in the current context [/home/dev/shop/src/Shop.Core/Shop.Core.csproj]",
    "/home/dev/shop/src/Shop.Core/Orders/OrderService.cs(57,29): error CS0029: Cannot implicitly convert type 'string' to 'int' [/home/dev/shop/src/Shop.Core/Shop.Core.csproj]",
    "/home/dev/shop/src/Shop.Api/Controllers/OrdersController.cs(23,13): error CS0246: The type or namespace name 'IOrderQueue' could not be found (are you missing a using directive or an assembly reference?) [/home/dev/shop/src/Shop.Api/Shop.Api.csproj]",
  ];
  const warns = [
    '/home/dev/shop/src/Shop.Core/Refunds/RefundPolicy.cs(18,9): warning CS8602: Dereference of a possibly null reference. [/home/dev/shop/src/Shop.Core/Shop.Core.csproj]',
  ];
  const L = ['MSBuild version 17.9.8+b34f75857 for .NET', '  Determining projects to restore...', '  Restored /home/dev/shop/src/Shop.Api/Shop.Api.csproj (in 312 ms).', '  2 of 3 projects are up-to-date for restore.', '  Shop.Domain -> /home/dev/shop/src/Shop.Domain/bin/Debug/net8.0/Shop.Domain.dll'];
  L.push(...warns, ...errs, '', 'Build FAILED.', '', ...warns, ...errs, '    1 Warning(s)', '    3 Error(s)', '', 'Time Elapsed 00:00:07.91');
  return L.join('\n') + '\n';
}

function dotnetTestFail() {
  const L = ['  Determining projects to restore...', '  All projects are up-to-date for restore.'];
  for (const p of PROJECTS) L.push(`  ${p} -> /home/dev/shop/src/${p}/bin/Debug/net8.0/${p}.dll`);
  L.push(...`Test run for /home/dev/shop/src/Shop.Tests/bin/Debug/net8.0/Shop.Tests.dll (.NETCoreApp,Version=v8.0)
Microsoft (R) Test Execution Command Line Tool Version 17.9.0 (x64)
Copyright (c) Microsoft Corporation.  All rights reserved.

Starting test execution, please wait...
A total of 1 test files matched the specified pattern.
[xUnit.net 00:00:00.52]     Shop.Tests.Refunds.RefundServiceTests.RefundPartial [FAIL]
[xUnit.net 00:00:00.55]     Shop.Tests.Orders.OrderServiceTests.CreateOrder_UnknownCustomer [FAIL]
  Failed Shop.Tests.Refunds.RefundServiceTests.RefundPartial [12 ms]
  Error Message:
   Assert.Equal() Failure: Values differ
Expected: 70.00
Actual:   60.00
  Stack Trace:
     at Shop.Tests.Refunds.RefundServiceTests.RefundPartial() in /home/dev/shop/src/Shop.Tests/Refunds/RefundServiceTests.cs:line 42
   at System.RuntimeMethodHandle.InvokeMethod(Object target, Void** arguments, Signature sig, Boolean isConstructor)
   at System.Reflection.MethodBaseInvoker.InvokeWithNoArgs(Object obj, BindingFlags invokeAttr)
  Failed Shop.Tests.Orders.OrderServiceTests.CreateOrder_UnknownCustomer [3 ms]
  Error Message:
   System.NullReferenceException : Object reference not set to an instance of an object.
  Stack Trace:
     at Shop.Core.Orders.OrderService.Create(OrderRequest request) in /home/dev/shop/src/Shop.Core/Orders/OrderService.cs:line 57
   at Shop.Tests.Orders.OrderServiceTests.CreateOrder_UnknownCustomer() in /home/dev/shop/src/Shop.Tests/Orders/OrderServiceTests.cs:line 88
   at System.RuntimeMethodHandle.InvokeMethod(Object target, Void** arguments, Signature sig, Boolean isConstructor)
   at System.Reflection.MethodBaseInvoker.InvokeWithNoArgs(Object obj, BindingFlags invokeAttr)
  Standard Output Messages:
 creating order for customer 42
 customer lookup returned null

Failed!  - Failed:     2, Passed:   338, Skipped:     1, Total:   341, Duration: 3 s - Shop.Tests.dll (net8.0)`.split('\n'));
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------------------------
// go

function goTestPass() {
  const L = [];
  const pkgs = ['cart', 'order', 'refund', 'payment', 'invoice', 'customer', 'catalog', 'inventory', 'shipping', 'auth', 'pricing', 'tax'];
  for (const p of pkgs) {
    for (let t = 0; t < 22; t++) {
      const name = `Test${pick(verbs).replace(/^./, (c) => c.toUpperCase())}${pick(nouns).replace(/^./, (c) => c.toUpperCase())}${t}`;
      L.push(`=== RUN   ${name}`);
      if (t % 5 === 0) L.push(`    ${p}_test.go:${20 + t}: using fixture ${pick(nouns)}.json`);
      L.push(`--- PASS: ${name} (0.0${t % 10}s)`);
    }
    L.push('PASS', `ok  \tgithub.com/acme/shop/internal/${p}\t0.${String(10 + pkgs.indexOf(p) * 7).padStart(3, '0')}s`);
  }
  L.push('?   \tgithub.com/acme/shop/cmd/shop\t[no test files]', '?   \tgithub.com/acme/shop/internal/version\t[no test files]');
  return L.join('\n') + '\n';
}

function goTestFail() {
  const L = [];
  for (const p of ['cart', 'catalog', 'customer']) L.push(`ok  \tgithub.com/acme/shop/internal/${p}\t(cached)`);
  for (let t = 0; t < 40; t++) L.push(`=== RUN   TestOrderLookup${t}`, `--- PASS: TestOrderLookup${t} (0.00s)`);
  L.push(...`=== RUN   TestRefundPartial
    refund_test.go:42: compute refund: got 60.00, want 70.00
--- FAIL: TestRefundPartial (0.00s)
=== RUN   TestRefundTable
=== RUN   TestRefundTable/zero_amount
=== RUN   TestRefundTable/negative_amount
    refund_test.go:88: expected ErrInvalidAmount, got <nil>
=== RUN   TestRefundTable/full_amount
--- FAIL: TestRefundTable (0.00s)
    --- PASS: TestRefundTable/zero_amount (0.00s)
    --- FAIL: TestRefundTable/negative_amount (0.00s)
    --- PASS: TestRefundTable/full_amount (0.00s)
=== RUN   TestCreateOrder
--- FAIL: TestCreateOrder (0.00s)
panic: runtime error: invalid memory address or nil pointer dereference [recovered]
	panic: runtime error: invalid memory address or nil pointer dereference
[signal SIGSEGV: segmentation violation code=0x1 addr=0x0 pc=0x5f3a1c]

goroutine 7 [running]:
testing.tRunner.func1.2({0x6a1b20, 0x8e5c40})
	/usr/local/go/src/testing/testing.go:1631 +0x24a
testing.tRunner.func1()
	/usr/local/go/src/testing/testing.go:1634 +0x377
panic({0x6a1b20?, 0x8e5c40?})
	/usr/local/go/src/runtime/panic.go:770 +0x132
github.com/acme/shop/internal/order.(*Service).Create(0x0, {0xc0000a6000, 0x2, 0x2})
	/home/dev/shop/internal/order/service.go:57 +0x1c
github.com/acme/shop/internal/order.TestCreateOrder(0xc000103520)
	/home/dev/shop/internal/order/service_test.go:30 +0x45
testing.tRunner(0xc000103520, 0x6f1e88)
	/usr/local/go/src/testing/testing.go:1689 +0xfb
created by testing.(*T).Run in goroutine 1
	/usr/local/go/src/testing/testing.go:1742 +0x390
FAIL	github.com/acme/shop/internal/order	0.015s
# github.com/acme/shop/internal/invoice [github.com/acme/shop/internal/invoice.test]
internal/invoice/pdf.go:42:17: undefined: renderTotal
internal/invoice/pdf.go:57:9: cannot use req.Quantity (variable of type string) as int value in assignment
FAIL	github.com/acme/shop/internal/invoice [build failed]
ok  \tgithub.com/acme/shop/internal/pricing\t0.104s
FAIL`.split('\n').map((l) => l.replace(/\\t/g, '\t')));
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------------------------
// tsc / eslint

function tscFail() {
  const L = [];
  const files = ['src/cart/cart.ts', 'src/orders/orderService.ts', 'src/api/client.ts', 'src/refunds/policy.ts'];
  L.push("src/cart/cart.ts(22,23): error TS2339: Property 'reduce' does not exist on type 'CartItems'.");
  L.push("src/orders/orderService.ts(57,9): error TS2322: Type 'string' is not assignable to type 'number'.");
  L.push("src/orders/orderService.ts(88,5): error TS2345: Argument of type '{ id: string; }' is not assignable to parameter of type 'Order'.");
  L.push("  Type '{ id: string; }' is missing the following properties from type 'Order': total, items, customer");
  for (let i = 0; i < 60; i++) L.push(`src/generated/api/model${i}.ts(${3 + i},14): error TS2307: Cannot find module '@acme/contracts' or its corresponding type declarations.`);
  for (let i = 0; i < 25; i++) L.push(`src/api/client.ts(${100 + i * 3},${7 + (i % 4)}): error TS7006: Parameter 'res' implicitly has an 'any' type.`);
  L.push("src/refunds/policy.ts(14,3): error TS2741: Property 'rate' is missing in type '{ name: string; }' but required in type 'FeePolicy'.");
  void files;
  return L.join('\n') + '\n';
}

function tscPretty() {
  return `src/cart/cart.ts:22:23 - error TS2339: Property 'reduce' does not exist on type 'CartItems'.

22     return this.items.reduce((s, i) => s + i.price, 0);
                         ~~~~~~

src/orders/orderService.ts:57:9 - error TS2322: Type 'string' is not assignable to type 'number'.

57         qty = request.quantity;
           ~~~

src/orders/orderService.ts:88:5 - error TS2345: Argument of type '{ id: string; }' is not assignable to parameter of type 'Order'.
  Type '{ id: string; }' is missing the following properties from type 'Order': total, items, customer

88     save({ id });
       ~~~~~~~~~~~~


Found 3 errors in 2 files.

Errors  Files
     1  src/cart/cart.ts:22
     2  src/orders/orderService.ts:57
`;
}

function eslintFail() {
  const L = [];
  const files = 40;
  let errors = 0;
  let warnings = 0;
  for (let f = 0; f < files; f++) {
    L.push(`/home/dev/shop/src/${domains[f % domains.length]}/${pick(nouns)}${f}.ts`);
    const k = 2 + (f % 5);
    for (let i = 0; i < k; i++) {
      const isErr = f === 3 || f === 17 ? i === 0 : false;
      if (isErr) {
        errors++;
        L.push(`  ${12 + i}:7  error    'unusedHelper' is assigned a value but never used  @typescript-eslint/no-unused-vars`);
      } else {
        warnings++;
        const [msg, rule] = pick([
          ['Unexpected any. Specify a different type', '@typescript-eslint/no-explicit-any'],
          ['Unexpected console statement', 'no-console'],
          ["React Hook useEffect has a missing dependency: 'load'", 'react-hooks/exhaustive-deps'],
        ]);
        L.push(`  ${20 + i * 3}:${5 + i}  warning  ${msg}  ${rule}`);
      }
    }
    L.push('');
  }
  L.push('/home/dev/shop/src/api/client.ts');
  L.push("  10:5  error  Parsing error: ';' expected");
  errors++;
  L.push('');
  L.push(`✖ ${errors + warnings} problems (${errors} errors, ${warnings} warnings)`);
  L.push('  0 errors and 12 warnings potentially fixable with the `--fix` option.');
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------------------------
// npm

function npmInstall() {
  const L = [];
  for (let i = 0; i < 18; i++) L.push(`npm warn deprecated ${pick(['inflight@1.0.6', 'glob@7.2.3', 'rimraf@3.0.2', 'abab@2.0.6', 'domexception@4.0.0', 'w3c-hr-time@1.0.2'])}: ${pick(['This module is not supported, and leaks memory. Do not use it.', 'Glob versions prior to v9 are no longer supported', 'Rimraf versions prior to v4 are no longer supported', 'Use your platform\'s native atob() and btoa() methods instead'])}`);
  L.push('', 'added 1324 packages, and audited 1325 packages in 32s', '', '187 packages are looking for funding', '  run `npm fund` for details', '', '12 vulnerabilities (4 moderate, 8 high)', '', 'To address issues that do not require attention, run:', '  npm audit fix', '', 'To address all issues (including breaking changes), run:', '  npm audit fix --force', '', 'Run `npm audit` for details.');
  return L.join('\n') + '\n';
}

function npmRunBuildFail() {
  const L = ['', '> shop-web@2.3.0 build', '> vite build', '', 'vite v5.2.11 building for production...', 'transforming...'];
  for (let i = 0; i < 120; i++) L.push(`src/components/${pick(['Cart', 'Order', 'Invoice'])}${i}.tsx (${i + 1}/${300}) transformed`);
  L.push(...`✓ 412 modules transformed.
x Build failed in 3.41s
error during build:
[vite:esbuild] Transform failed with 1 error:
/home/dev/shop/src/pages/Checkout.tsx:88:14: ERROR: Expected ")" but found "total"
file: /home/dev/shop/src/pages/Checkout.tsx:88:14

Expected ")" but found "total"
86 |    return (
87 |      <Summary
88 |        amount={cart total}
   |                     ^
89 |      />
90 |    );

    at failureErrorWithLog (/home/dev/shop/node_modules/esbuild/lib/main.js:1651:15)
    at /home/dev/shop/node_modules/esbuild/lib/main.js:849:29
    at responseCallbacks.<computed> (/home/dev/shop/node_modules/esbuild/lib/main.js:704:9)
    at handleIncomingPacket (/home/dev/shop/node_modules/esbuild/lib/main.js:764:9)
    at Socket.readFromStdout (/home/dev/shop/node_modules/esbuild/lib/main.js:680:7)
    at Socket.emit (node:events:519:28)
    at addChunk (node:internal/streams/readable:559:12)
npm error Lifecycle script \`build\` failed with error:
npm error code 1
npm error path /home/dev/shop
npm error workspace shop-web@2.3.0
npm error location /home/dev/shop
npm error command failed
npm error command sh -c vite build
npm error A complete log of this run can be found in: /home/dev/.npm/_logs/2026-10-09T08_15_42_123Z-debug-0.log`.split('\n'));
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------------------------
// cargo

function cargoCompiling() {
  const crates = ['proc-macro2 v1.0.86', 'unicode-ident v1.0.12', 'libc v0.2.155', 'cfg-if v1.0.0', 'autocfg v1.3.0', 'serde v1.0.204', 'quote v1.0.36', 'syn v2.0.72', 'once_cell v1.19.0', 'memchr v2.7.4', 'itoa v1.0.11', 'ryu v1.0.18', 'serde_json v1.0.120', 'tokio v1.39.2', 'bytes v1.6.1', 'mio v1.0.1', 'pin-project-lite v0.2.14', 'tracing v0.1.40', 'hyper v1.4.1', 'axum v0.7.5', 'sqlx v0.8.0', 'chrono v0.4.38', 'uuid v1.10.0', 'rust_decimal v1.35.0'];
  const L = ['    Updating crates.io index', '     Locking 214 packages to latest compatible versions'];
  for (let i = 0; i < 8; i++) for (const c of crates) L.push(`   Compiling ${c.replace(/v(\d+)\.(\d+)\.(\d+)/, (m, a, b, d) => `v${a}.${b}.${Number(d) + i}`)}`);
  return L;
}

function cargoTestPass() {
  const L = cargoCompiling();
  L.push('   Compiling shop v0.4.0 (/home/dev/shop)', '    Finished `test` profile [unoptimized + debuginfo] target(s) in 48.21s', '     Running unittests src/lib.rs (target/debug/deps/shop-1a2b3c4d5e6f7a8b)', '', 'running 186 tests');
  for (let i = 0; i < 186; i++) L.push(`test ${pick(domains)}::tests::${pick(verbs)}_${pick(nouns)}_${i} ... ok`);
  L.push('', 'test result: ok. 186 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out; finished in 0.42s', '');
  L.push('     Running tests/api.rs (target/debug/deps/api-9f8e7d6c5b4a3f2e)', '', 'running 24 tests');
  for (let i = 0; i < 24; i++) L.push(`test api_${pick(verbs)}_${pick(nouns)}_${i} ... ok`);
  L.push('', 'test result: ok. 24 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.07s', '', '   Doc-tests shop', '', 'running 3 tests', 'test src/pricing.rs - pricing::round_half_even (line 12) ... ok', 'test src/cart.rs - cart::Cart::total (line 40) ... ok', 'test src/refund.rs - refund::compute (line 8) ... ok', '', 'test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.31s', '');
  return L.join('\n') + '\n';
}

function cargoBuildFail() {
  const L = cargoCompiling();
  L.push(...`   Compiling shop v0.4.0 (/home/dev/shop)
warning: unused variable: \`fee\`
  --> src/refund.rs:31:9
   |
31 |     let fee = policy.fee(order);
   |         ^^^ help: if this is intentional, prefix it with an underscore: \`_fee\`
   |
   = note: \`#[warn(unused_variables)]\` on by default

warning: unused import: \`std::collections::HashMap\`
 --> src/cart.rs:3:5
  |
3 | use std::collections::HashMap;
  |     ^^^^^^^^^^^^^^^^^^^^^^^^^
  |
  = note: \`#[warn(unused_imports)]\` on by default

error[E0425]: cannot find function \`compute_total\` in this scope
  --> src/order.rs:42:17
   |
42 |     let total = compute_total(&items);
   |                 ^^^^^^^^^^^^^ not found in this scope
   |
help: consider importing this function
   |
1  + use crate::pricing::compute_total;
   |

error[E0308]: mismatched types
  --> src/order.rs:57:20
   |
57 |     order.quantity = req.quantity;
   |     --------------   ^^^^^^^^^^^^ expected \`u32\`, found \`String\`
   |     |
   |     expected due to the type of this binding

Some errors have detailed explanations: E0308, E0425.
For more information about an error, try \`rustc --explain E0308\`.
warning: \`shop\` (lib) generated 2 warnings
error: could not compile \`shop\` (lib) due to 2 previous errors; 2 warnings emitted`.split('\n'));
  return L.join('\n') + '\n';
}

function cargoTestFail() {
  const L = ['   Compiling shop v0.4.0 (/home/dev/shop)', '    Finished `test` profile [unoptimized + debuginfo] target(s) in 3.21s', '     Running unittests src/lib.rs (target/debug/deps/shop-1a2b3c4d5e6f7a8b)', '', 'running 120 tests'];
  for (let i = 0; i < 120; i++) L.push(i === 57 ? 'test refund::tests::refund_partial ... FAILED' : `test ${pick(domains)}::tests::${pick(verbs)}_${pick(nouns)}_${i} ... ok`);
  L.push(...`
failures:

---- refund::tests::refund_partial stdout ----
thread 'refund::tests::refund_partial' panicked at src/refund.rs:142:9:
assertion \`left == right\` failed: refund amount
  left: 60.00
 right: 70.00
note: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace


failures:
    refund::tests::refund_partial

test result: FAILED. 119 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.05s

error: test failed, to rerun pass \`--lib\``.split('\n'));
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------------------------
// git

function gitLog() {
  const L = [];
  const authors = ['Jane Doe <jane@acme.com>', 'Marc Petit <marc@acme.com>', 'Ana Silva <ana@acme.com>'];
  for (let i = 0; i < 60; i++) {
    const sha = Array.from({ length: 40 }, () => '0123456789abcdef'[Math.floor(rnd() * 16)]).join('');
    L.push(`commit ${sha}${i === 0 ? ' (HEAD -> main, origin/main)' : ''}`);
    if (i % 17 === 5) L.push(`Merge: ${sha.slice(0, 7)} ${sha.slice(7, 14)}`);
    L.push(`Author: ${pick(authors)}`);
    L.push(`Date:   ${pick(['Mon', 'Tue', 'Wed', 'Thu', 'Fri'])} Oct ${String(1 + (i % 9))} ${10 + (i % 9)}:${String(10 + i).slice(-2)}:00 2026 +0200`);
    L.push('');
    L.push(`    ${pick(['Fix', 'Add', 'Refactor', 'Speed up', 'Document'])} ${pick(nouns)} ${pick(['handling', 'validation', 'rounding', 'caching'])} in ${pick(domains)}`);
    L.push('');
    if (i % 3 === 0) {
      L.push(`    The previous implementation ${pick(verbs)} the ${pick(nouns)} twice when the`);
      L.push(`    ${pick(nouns)} was ${pick(['empty', 'expired', 'missing'])}. This change makes it idempotent and adds`);
      L.push('    regression tests.');
      L.push('');
      L.push(`    Refs: SHOP-${1000 + i}`);
      L.push('');
    }
  }
  return L.join('\n') + '\n';
}

function gitDiff() {
  const L = [];
  L.push('diff --git a/src/refunds/policy.ts b/src/refunds/policy.ts', 'index 3f2a1b4..9b1c2d3 100644', '--- a/src/refunds/policy.ts', '+++ b/src/refunds/policy.ts');
  L.push('@@ -10,7 +10,9 @@ export class FeePolicy {', '   constructor(private readonly rate: number) {}', ' ', '   fee(order: Order): Money {', '-    return order.total.times(this.rate);', '+    const base = order.total.minus(order.shipping);', '+    // shipping is never refundable, so it does not carry a fee either', '+    return base.times(this.rate).round(2);', '   }', ' ', '   describe(): string {');
  L.push('@@ -40,6 +42,7 @@ export function defaultPolicy(): FeePolicy {', '   return new FeePolicy(0.1);', ' }', ' ', '+export const NO_FEE = new FeePolicy(0);', ' export function policyFor(customer: Customer): FeePolicy {', '   if (customer.tier === "gold") return NO_FEE;', '   return defaultPolicy();');
  L.push('diff --git a/src/refunds/service.ts b/src/refunds/service.ts', 'index 1111111..2222222 100644', '--- a/src/refunds/service.ts', '+++ b/src/refunds/service.ts');
  for (let h = 0; h < 14; h++) {
    L.push(`@@ -${20 + h * 40},8 +${20 + h * 40},9 @@ export class RefundService {`);
    for (let k = 0; k < 3; k++) L.push(`   ${pick(['const', 'let'])} ${pick(nouns)}${h}${k} = this.${pick(nouns)}Repo.find(${pick(nouns)}Id);`);
    L.push(`-    return this.compute(${pick(nouns)}, ${pick(nouns)});`);
    L.push(`+    const policy = policyFor(order.customer);`);
    L.push(`+    return this.compute(${pick(nouns)}, policy);`);
    for (let k = 0; k < 3; k++) L.push(`   // ${pick(verbs)} ${pick(nouns)} ${pick(nouns)}`);
  }
  L.push('diff --git a/package-lock.json b/package-lock.json', 'index aaaaaaa..bbbbbbb 100644', '--- a/package-lock.json', '+++ b/package-lock.json');
  for (let h = 0; h < 30; h++) {
    L.push(`@@ -${1000 + h * 50},7 +${1000 + h * 50},7 @@`, `     "node_modules/${pick(nouns)}-${h}": {`, `-      "version": "1.${h}.0",`, `+      "version": "1.${h}.1",`, `-      "resolved": "https://registry.npmjs.org/${pick(nouns)}/-/x-1.${h}.0.tgz",`, `+      "resolved": "https://registry.npmjs.org/${pick(nouns)}/-/x-1.${h}.1.tgz",`, `       "dev": true`, '     },');
  }
  L.push('diff --git a/docs/architecture.png b/docs/architecture.png', 'index 0123abc..4567def 100644', 'Binary files a/docs/architecture.png and b/docs/architecture.png differ');
  L.push('diff --git a/src/refunds/legacy.ts b/src/refunds/legacy.ts', 'deleted file mode 100644', 'index 7777777..0000000', '--- a/src/refunds/legacy.ts', '+++ /dev/null', '@@ -1,5 +0,0 @@', '-// deprecated, see policy.ts', '-export function legacyFee(total: number) {', '-  return total * 0.1;', '-}', '-');
  return L.join('\n') + '\n';
}

function gitStatus() {
  const L = ['On branch feature/refund-fees', "Your branch is ahead of 'origin/feature/refund-fees' by 2 commits.", '  (use "git push" to publish your local commits)', '', 'Changes to be committed:', '  (use "git restore --staged <file>..." to unstage)', '\tmodified:   src/refunds/policy.ts', '\tnew file:   src/refunds/fees.test.ts', '', 'Changes not staged for commit:', '  (use "git add <file>..." to update what will be committed)', '  (use "git restore <file>..." to discard changes in working directory)', '\tmodified:   src/refunds/service.ts', '\tdeleted:    src/refunds/legacy.ts', '', 'Untracked files:', '  (use "git add <file>..." to include in what will be committed)'];
  for (let i = 0; i < 45; i++) L.push(`\tsrc/generated/api/model${i}.ts`);
  L.push('\tnotes.md', '');
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------------------------
// generic

function genericFail() {
  const L = ['Running data migration 2026_10_09_add_refund_fees', 'Connecting to postgres://localhost:5432/shop_dev'];
  for (let i = 0; i < 300; i++) L.push(`migrated batch ${i + 1}/300: ${1000 + i * 37} rows in ${(rnd() * 0.5).toFixed(3)}s`);
  L.push(...`Traceback (most recent call last):
  File "/home/dev/shop/scripts/migrate.py", line 88, in <module>
    main()
  File "/home/dev/shop/scripts/migrate.py", line 80, in main
    apply_fees(conn, batch)
  File "/home/dev/shop/shop/refunds/migrations.py", line 41, in apply_fees
    cur.execute(SQL_UPDATE, params)
  File "/home/dev/shop/.venv/lib/python3.11/site-packages/psycopg2/extras.py", line 146, in execute
    return super().execute(query, vars)
psycopg2.errors.NotNullViolation: null value in column "fee" of relation "refunds" violates not-null constraint
DETAIL:  Failing row contains (1042, 17, 60.00, null, 2026-10-09 10:15:42).`.split('\n'));
  return L.join('\n') + '\n';
}

function genericPass() {
  const L = [];
  for (let i = 0; i < 400; i++) L.push(`[2026-10-09T10:${String(10 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z] processed shard ${i} (${100 + i} documents) in ${Math.floor(rnd() * 900)}ms`);
  L.push('reindex complete: 400 shards, 119800 documents, 0 errors');
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------------------------
// mocha

function mochaTree(suites, failAt = new Map()) {
  const L = [''];
  let passing = 0;
  for (let f = 0; f < suites; f++) {
    const d = domains[f % domains.length];
    L.push(`  ${d} ${pick(nouns)}${f}`);
    const k = 4 + Math.floor(rnd() * 5);
    for (let t = 0; t < k; t++) {
      const key = `${f}:${t}`;
      if (failAt.has(key)) L.push(`    ${failAt.get(key)}) ${pick(verbs)} ${pick(nouns)}`);
      else {
        L.push(`    ✔ ${pick(verbs)} ${pick(nouns)} when ${pick(nouns)} is ${pick(['empty', 'valid', 'missing', 'expired'])}${t % 4 === 0 ? ` (${Math.floor(rnd() * 90) + 10}ms)` : ''}`);
        passing++;
      }
    }
    L.push('');
  }
  return { L, passing };
}

function mochaPass() {
  const { L, passing } = mochaTree(70);
  L.push('', `  ${passing} passing (4s)`, '  3 pending', '');
  return L.join('\n') + '\n';
}

function mochaFail() {
  const { L, passing } = mochaTree(40, new Map([['3:1', 1], ['17:2', 2], ['29:0', 3]]));
  L.push(
    '',
    `  ${passing} passing (3s)`,
    '  1 pending',
    '  3 failing',
    '',
    '  1) cart item3',
    '       computes total with discount:',
    '',
    '      AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
    '',
    '100 !== 90',
    '',
    '      + expected - actual',
    '',
    '      -100',
    '      +90',
    '',
    '      at Context.<anonymous> (test/cart/cart.test.js:14:12)',
    '      at callFn (node_modules/mocha/lib/runnable.js:366:21)',
    '      at Runnable.run (node_modules/mocha/lib/runnable.js:354:5)',
    '      at Runner.runTest (node_modules/mocha/lib/runner.js:666:10)',
    '      at process.processImmediate (node:internal/timers:483:21)',
    '',
    '  2) orders order17',
    '       rejects an empty order:',
    '     TypeError: Cannot read properties of undefined (reading \'length\')',
    '      at OrderService.create (src/orders/service.js:22:31)',
    '      at Context.<anonymous> (test/orders/service.test.js:33:20)',
    '      at callFn (node_modules/mocha/lib/runnable.js:366:21)',
    '      at Runnable.run (node_modules/mocha/lib/runnable.js:354:5)',
    '      at process.processImmediate (node:internal/timers:483:21)',
    '',
    '  3) refunds refund29',
    '       "before each" hook for "refunds the full amount":',
    '     TypeError: Cannot read properties of undefined (reading \'length\')',
    '      at OrderService.create (src/orders/service.js:22:31)',
    '      at Context.<anonymous> (test/refunds/refund.test.js:12:18)',
    '      at process.processImmediate (node:internal/timers:483:21)',
    '',
    '',
  );
  return L.join('\n');
}

function mochaJsonFail() {
  const tests = [];
  for (let i = 0; i < 160; i++) {
    const d = domains[i % domains.length];
    tests.push({ title: `${pick(verbs)} ${pick(nouns)} ${i}`, fullTitle: `${d} ${pick(verbs)} ${pick(nouns)} ${i}`, file: `/home/dev/shop/test/${d}/${d}.test.js`, duration: Math.floor(rnd() * 40), currentRetry: 0, speed: 'fast', err: {} });
  }
  const failures = [
    {
      title: 'computes total with discount', fullTitle: 'Cart computes total with discount', file: '/home/dev/shop/test/cart/cart.test.js', duration: 3, currentRetry: 0,
      err: {
        stack: 'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\n100 !== 90\n\n    at Context.<anonymous> (/home/dev/shop/test/cart/cart.test.js:14:12)\n    at callFn (/home/dev/shop/node_modules/mocha/lib/runnable.js:366:21)\n    at process.processImmediate (node:internal/timers:483:21)',
        message: 'Expected values to be strictly equal:\n\n100 !== 90\n', generatedMessage: true, name: 'AssertionError', code: 'ERR_ASSERTION', actual: '100', expected: '90', operator: 'strictEqual',
      },
    },
    {
      title: 'rejects an empty order', fullTitle: 'Orders rejects an empty order', file: '/home/dev/shop/test/orders/service.test.js', duration: 1, currentRetry: 0,
      err: { stack: "TypeError: Cannot read properties of undefined (reading 'length')\n    at OrderService.create (/home/dev/shop/src/orders/service.js:22:31)\n    at Context.<anonymous> (/home/dev/shop/test/orders/service.test.js:33:20)\n    at callFn (/home/dev/shop/node_modules/mocha/lib/runnable.js:366:21)", message: "Cannot read properties of undefined (reading 'length')" },
    },
  ];
  const doc = { stats: { suites: 42, tests: 162, passes: 160, pending: 0, failures: 2, start: '2026-10-09T10:12:01.123Z', end: '2026-10-09T10:12:04.567Z', duration: 3444 }, tests: [...tests, ...failures], pending: [], failures, passes: tests };
  return JSON.stringify(doc, null, 2) + '\n';
}

// ---------------------------------------------------------------------------------------------------------------
// rspec

function rspecFail() {
  const L = ['Randomized with seed 41587', ''];
  // documentation format: one line per example
  for (let f = 0; f < 45; f++) {
    const d = domains[f % domains.length];
    L.push(`${d.replace(/^./, (c) => c.toUpperCase())}::${pick(nouns).replace(/^./, (c) => c.toUpperCase())}`);
    for (let t = 0; t < 6; t++) {
      if (f === 7 && t === 2) L.push('  #total applies the discount (FAILED - 1)');
      else if (f === 21 && t === 0) L.push('  POST /orders rejects empty orders (FAILED - 2)');
      else if (f === 30 && t === 4) L.push('  #refund refunds the full amount (PENDING: Not yet implemented)');
      else L.push(`  ${pick(verbs)} ${pick(nouns)} when ${pick(nouns)} is ${pick(['empty', 'valid', 'missing', 'expired'])}`);
    }
    L.push('');
  }
  L.push(
    'Pending: (Failures listed here are expected and do not affect your suite\'s status)',
    '',
    '  1) Refunds::Refund#refund refunds the full amount',
    '     # Not yet implemented',
    '     # ./spec/models/refund_spec.rb:40',
    '',
    'Failures:',
    '',
    '  1) Cart#total applies the discount',
    '     Failure/Error: expect(cart.total).to eq(90)',
    '',
    '       expected: 90',
    '            got: 100',
    '',
    '       (compared using ==)',
    "     # ./spec/models/cart_spec.rb:14:in `block (3 levels) in <top (required)>'",
    "     # /usr/local/bundle/gems/rspec-core-3.13.0/lib/rspec/core/example.rb:263:in `instance_exec'",
    "     # /usr/local/bundle/gems/rspec-core-3.13.0/lib/rspec/core/example.rb:263:in `block in run'",
    '',
    '  2) OrdersController POST /orders rejects empty orders',
    '     Failure/Error: order.items.each { |item| reserve(item) }',
    '',
    '     NoMethodError:',
    "       undefined method `items' for nil",
    "     # ./app/controllers/orders_controller.rb:22:in `create'",
    "     # /usr/local/bundle/gems/actionpack-7.1.3/lib/action_controller/metal/basic_implicit_render.rb:6:in `send_action'",
    "     # /usr/local/bundle/gems/actionpack-7.1.3/lib/abstract_controller/base.rb:224:in `process_action'",
    "     # ./spec/requests/orders_spec.rb:31:in `block (3 levels) in <top (required)>'",
    '',
    'Finished in 12.34 seconds (files took 2.1 seconds to load)',
    '270 examples, 2 failures, 1 pending',
    '',
    'Failed examples:',
    '',
    'rspec ./spec/models/cart_spec.rb:12 # Cart#total applies the discount',
    'rspec ./spec/requests/orders_spec.rb:29 # OrdersController POST /orders rejects empty orders',
    '',
    'Randomized with seed 41587',
    '',
  );
  return L.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// phpunit / pest

function phpunitFail() {
  const dots = [];
  for (let i = 0; i < 6; i++) {
    let row = '';
    for (let k = 0; k < 63; k++) row += i === 1 && k === 15 ? 'F' : i === 3 && k === 40 ? 'E' : i === 4 && k === 2 ? 'S' : '.';
    dots.push(`${row} ${String((i + 1) * 63).padStart(3)} / 400 (${String(Math.round(((i + 1) * 63 * 100) / 400)).padStart(3)}%)`);
  }
  dots.push(`${'.'.repeat(22)}                                         400 / 400 (100%)`);
  return `PHPUnit 10.5.2 by Sebastian Bergmann and contributors.

Runtime:       PHP 8.3.0
Configuration: /home/dev/shop/phpunit.xml

${dots.join('\n')}

Time: 00:04.512, Memory: 38.00 MB

There was 1 error:

1) Tests\\Unit\\OrderServiceTest::testCreateRejectsEmptyCart
TypeError: App\\Services\\OrderService::create(): Argument #1 ($items) must be of type array, null given, called in /home/dev/shop/tests/Unit/OrderServiceTest.php on line 41

/home/dev/shop/app/Services/OrderService.php:22
/home/dev/shop/tests/Unit/OrderServiceTest.php:41
/home/dev/shop/vendor/phpunit/phpunit/src/Framework/TestCase.php:1188

--

There was 1 failure:

1) Tests\\Unit\\CartTest::testTotalWithDiscount
Failed asserting that 100 matches expected 90.

/home/dev/shop/tests/Unit/CartTest.php:28

FAILURES!
Tests: 400, Assertions: 1132, Errors: 1, Failures: 1, Skipped: 1.
`;
}

function pestFail() {
  const L = [];
  for (let f = 0; f < 50; f++) {
    const d = domains[f % domains.length].replace(/^./, (c) => c.toUpperCase());
    if (f === 12) {
      L.push('   FAIL  Tests\\Feature\\OrderTest');
      L.push('  ✓ it lists orders                                                       0.08s');
      L.push('  ⨯ it creates an order                                                   0.12s');
      L.push('');
      continue;
    }
    L.push(`   PASS  Tests\\${f % 3 ? 'Unit' : 'Feature'}\\${d}${f}Test`);
    for (let t = 0; t < 5; t++) L.push(`  ✓ it ${pick(verbs)} ${pick(nouns)}${' '.repeat(40)}0.0${t}s`);
    L.push('');
  }
  L.push(
    '  ────────────────────────────────────────────────────────────────────────────────────────────',
    '   FAILED  Tests\\Feature\\OrderTest > it creates an order',
    '  Expected response status code [201] but received 500.',
    'Failed asserting that 500 is identical to 201.',
    '',
    '  at tests/Feature/OrderTest.php:22',
    '     18▕         $response = $this->postJson(\'/api/orders\', [',
    '     19▕             \'items\' => [[\'sku\' => \'A-1\', \'quantity\' => 2]],',
    '     20▕         ]);',
    '     21▕',
    '  ➜  22▕         $response->assertCreated();',
    '     23▕     });',
    '',
    '  1   tests/Feature/OrderTest.php:22',
    '',
    '',
    '  Tests:    1 failed, 251 passed (744 assertions)',
    '  Duration: 6.21s',
    '',
  );
  return L.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// sbt / scalatest

function sbtBanner() {
  return `[info] welcome to sbt 1.9.7 (Eclipse Adoptium Java 17.0.9)
[info] loading settings for project shop-build from plugins.sbt ...
[info] loading project definition from /home/dev/shop/project
[info] loading settings for project root from build.sbt ...
[info] set current project to shop (in build file:/home/dev/shop/)`;
}

function sbtTestFail() {
  const L = [sbtBanner(), '[info] compiling 42 Scala sources to /home/dev/shop/target/scala-2.13/classes ...', '[info] done compiling', '[info] compiling 18 Scala sources to /home/dev/shop/target/scala-2.13/test-classes ...', '[info] done compiling'];
  for (let f = 0; f < 30; f++) {
    const d = domains[f % domains.length].replace(/^./, (c) => c.toUpperCase());
    L.push(`[info] ${f === 4 ? 'CartSpec' : f === 11 ? 'OrderSpec' : `${d}${f}Spec`}:`);
    L.push(`[info] ${d}`);
    for (let t = 0; t < 6; t++) {
      if (f === 4 && t === 3) {
        L.push('[info] - should compute the total with discount *** FAILED ***');
        L.push('[info]   100 did not equal 90 (CartSpec.scala:14)');
      } else if (f === 11 && t === 1) {
        L.push('[info] - should reject empty orders *** FAILED ***');
        L.push('[info]   java.lang.IllegalStateException: no items');
        L.push('[info]   at com.acme.shop.orders.OrderService.create(OrderService.scala:22)');
        L.push('[info]   at com.acme.shop.orders.OrderSpec.$anonfun$new$2(OrderSpec.scala:31)');
        L.push('[info]   at org.scalatest.OutcomeOf.outcomeOf(OutcomeOf.scala:85)');
        L.push('[info]   at org.scalatest.OutcomeOf.outcomeOf$(OutcomeOf.scala:83)');
        L.push('[info]   at org.scalatest.Transformer.apply(Transformer.scala:22)');
        L.push('[info]   ...');
      } else L.push(`[info] - should ${pick(verbs)} ${pick(nouns)} when ${pick(nouns)} is ${pick(['empty', 'valid', 'missing'])}`);
    }
  }
  L.push(
    '[info] Run completed in 3 seconds, 120 milliseconds.',
    '[info] Total number of tests run: 180',
    '[info] Suites: completed 30, aborted 0',
    '[info] Tests: succeeded 178, failed 2, canceled 0, ignored 0, pending 0',
    '[info] *** 2 TESTS FAILED ***',
    '[error] Failed tests:',
    '[error] \tcom.acme.shop.cart.CartSpec',
    '[error] \tcom.acme.shop.orders.OrderSpec',
    '[error] (Test / test) sbt.TestsFailedException: Tests unsuccessful',
    '[error] Total time: 24 s, completed Oct 9, 2026, 10:12:01 AM',
    '',
  );
  return L.join('\n');
}

function sbtCompileFail() {
  const L = [sbtBanner()];
  for (let i = 0; i < 40; i++) L.push(`[info] Fetched artifacts of ${pick(['shop-core', 'shop-api', 'shop-web'])}`);
  L.push(
    '[info] compiling 42 Scala sources to /home/dev/shop/core/target/scala-2.13/classes ...',
    '[error] /home/dev/shop/core/src/main/scala/com/acme/shop/cart/Cart.scala:22:20: type mismatch;',
    '[error]  found   : String("x")',
    '[error]  required: Int',
    '[error]     val total: Int = "x"',
    '[error]                    ^',
    '[error] /home/dev/shop/core/src/main/scala/com/acme/shop/orders/OrderService.scala:57:9: not found: value computeTotal',
    '[error]     computeTotal(items)',
    '[error]     ^',
    '[warn] /home/dev/shop/core/src/main/scala/com/acme/shop/Main.scala:3:8: Unused import',
    '[warn] import scala.util.Try',
    '[warn]        ^',
    '[warn] one warning found',
    '[error] two errors found',
    '[info] compiling 12 Scala sources to /home/dev/shop/api/target/scala-3.3.1/classes ...',
    '[error] -- [E007] Type Mismatch Error: /home/dev/shop/api/src/main/scala/com/acme/shop/api/Routes.scala:31:24 ----------',
    '[error] 31 |    val port: Int = config.getString("port")',
    '[error]    |                    ^^^^^^^^^^^^^^^^^^^^^^^^',
    '[error]    |                    Found:    String',
    '[error]    |                    Required: Int',
    '[error]    |',
    '[error]    | longer explanation available when compiling with `-explain`',
    '[error] one error found',
    '[error] (core / Compile / compileIncremental) Compilation failed',
    '[error] (api / Compile / compileIncremental) Compilation failed',
    '[error] Total time: 18 s, completed Oct 9, 2026, 10:14:31 AM',
    '',
  );
  return L.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// .NET runners: xUnit console, NUnit console, Microsoft.Testing.Platform

function xunitConsoleFail() {
  const L = ['xUnit.net Console Runner v2.6.6+5bfa3b4b8e (64-bit .NET 8.0.1)', '  Discovering: Shop.Tests', '  Discovered:  Shop.Tests', '  Starting:    Shop.Tests'];
  L.push(
    '    Shop.Tests.CartTests.Total_WithDiscount [FAIL]',
    '      Assert.Equal() Failure: Values differ',
    '      Expected: 90',
    '      Actual:   100',
    '      Stack Trace:',
    '        /home/dev/shop/tests/Shop.Tests/CartTests.cs(28,0): at Shop.Tests.CartTests.Total_WithDiscount()',
    '           at System.RuntimeMethodHandle.InvokeMethod(Object target, Void** arguments, Signature sig, Boolean isConstructor)',
    '           at System.Reflection.MethodBaseInvoker.InvokeWithNoArgs(Object obj, BindingFlags invokeAttr)',
    '    Shop.Tests.OrderTests.Create_RejectsEmpty [FAIL]',
    '      System.NullReferenceException : Object reference not set to an instance of an object.',
    '      Stack Trace:',
    '        /home/dev/shop/src/Shop/Services/OrderService.cs(22,0): at Shop.Services.OrderService.Create(List`1 items)',
    '        /home/dev/shop/tests/Shop.Tests/OrderTests.cs(41,0): at Shop.Tests.OrderTests.Create_RejectsEmpty()',
    '           at System.RuntimeMethodHandle.InvokeMethod(Object target, Void** arguments, Signature sig, Boolean isConstructor)',
    '      Output:',
    '        creating order for customer 42',
    '  Finished:    Shop.Tests',
    '=== TEST EXECUTION SUMMARY ===',
    '   Shop.Tests  Total: 412, Errors: 0, Failed: 2, Skipped: 1, Time: 3.481s',
    '',
  );
  return L.join('\n');
}

function nunitConsoleFail() {
  return `NUnit Console 3.17.0 (Release)
Copyright (c) 2022 Charlie Poole, Rob Prouse
Thursday, October 9, 2026 10:12:01 AM

Runtime Environment
   OS Version: Linux 6.5.0.1015
   Runtime: .NET 8.0.1

Test Files
    tests/Shop.Tests/bin/Debug/net8.0/Shop.Tests.dll

Errors, Failures and Warnings

1) Failed : Shop.Tests.CartTests.TotalWithDiscount
  Expected: 90
  But was:  100

   at Shop.Tests.CartTests.TotalWithDiscount() in /home/dev/shop/tests/Shop.Tests/CartTests.cs:line 28

2) Error : Shop.Tests.OrderTests.CreateRejectsEmpty
System.NullReferenceException : Object reference not set to an instance of an object.
   at Shop.Services.OrderService.Create(List\`1 items) in /home/dev/shop/src/Shop/Services/OrderService.cs:line 22
   at Shop.Tests.OrderTests.CreateRejectsEmpty() in /home/dev/shop/tests/Shop.Tests/OrderTests.cs:line 41
   at System.RuntimeMethodHandle.InvokeMethod(Object target, Void** arguments, Signature sig, Boolean isConstructor)

Run Settings
    DisposeRunners: True
    WorkDirectory: /home/dev/shop
    ImageRuntimeVersion: 4.0.30319
    ImageTargetFrameworkName: .NETCoreApp,Version=v8.0
    ImageRequiresX86: False
    ImageRequiresDefaultAppDomainAssemblyResolver: False
    TargetRuntimeFramework: netcore-8.0
    NumberOfTestWorkers: 8

Test Run Summary
  Overall result: Failed
  Test Count: 412, Passed: 409, Failed: 2, Warnings: 0, Inconclusive: 0, Skipped: 1
    Failed Tests - Failures: 1, Errors: 1, Invalid: 0
    Skipped Tests - Ignored: 1, Explicit: 0, Other: 0
  Start time: 2026-10-09 10:12:01Z
    End time: 2026-10-09 10:12:05Z
    Duration: 3.912 seconds

Results (nunit3) saved as TestResult.xml
`;
}

function dotnetMtpFail() {
  const L = ['  Determining projects to restore...', '  All projects are up-to-date for restore.'];
  for (const p of ['Shop.Domain', 'Shop.Infrastructure', 'Shop.Api', 'Shop.Tests']) L.push(`  ${p} -> /home/dev/shop/src/${p}/bin/Debug/net8.0/${p}.dll`);
  L.push(
    'Running tests from /home/dev/shop/tests/Shop.Tests/bin/Debug/net8.0/Shop.Tests.dll (net8.0|x64)',
    'failed Shop.Tests.CartTests.Total_WithDiscount (12ms)',
    '  Assert.Equal() Failure: Values differ',
    '  Expected: 90',
    '  Actual:   100',
    '    at Shop.Tests.CartTests.Total_WithDiscount() in /home/dev/shop/tests/Shop.Tests/CartTests.cs:28',
    '    at System.RuntimeMethodHandle.InvokeMethod(Object target, Void** arguments, Signature sig, Boolean isConstructor)',
    '/home/dev/shop/tests/Shop.Tests/bin/Debug/net8.0/Shop.Tests.dll (net8.0|x64) failed with 1 error(s) (3s 481ms)',
    '',
    'Test run summary: Failed! - /home/dev/shop/tests/Shop.Tests/bin/Debug/net8.0/Shop.Tests.dll (net8.0|x64)',
    '  total: 412',
    '  failed: 1',
    '  succeeded: 410',
    '  skipped: 1',
    '  duration: 3s 481ms',
    '',
  );
  return L.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// bazel

function bazelTestFail() {
  const L = ['INFO: Invocation ID: 7d3c4c1e-2f3b-4a8e-9b51-0f1c2d3e4f5a', 'Computing main repo mapping: ', 'Loading: ', 'Loading: 0 packages loaded', 'Analyzing: 64 targets (312 packages loaded, 9841 targets configured)', 'INFO: Analyzed 64 targets (512 packages loaded, 14532 targets configured).', 'INFO: Found 44 targets and 20 test targets...'];
  for (let i = 1; i <= 60; i++) L.push(`[${(i * 41).toLocaleString('en-US')} / 2,412] Compiling src/main/java/com/acme/shop/${pick(domains)}/${pick(nouns)}${i}.java; ${i % 5}s linux-sandbox ... (8 actions running)`);
  L.push(
    'ERROR: /home/dev/shop/src/main/java/com/acme/shop/cart/BUILD.bazel:12:13: Building src/main/java/com/acme/shop/cart/libcart.jar (14 source files) failed: (Exit 1): java failed: error executing Javac command (from target //src/main/java/com/acme/shop/cart:cart) external/remotejdk17_linux/bin/java -XX:+UseParallelOldGC -XX:-CompactStrings --add-exports=jdk.compiler/com.sun.tools.javac.api=ALL-UNNAMED ... (remaining 42 arguments skipped)',
    'src/main/java/com/acme/shop/cart/Cart.java:22: error: cannot find symbol',
    '    return computeTotal(items);',
    '           ^',
    '  symbol:   method computeTotal(List<Item>)',
    '  location: class Cart',
    'INFO: From Compiling src/main/java/com/acme/shop/api/Routes.java:',
    'warning: [options] source value 8 is obsolete and will be removed in a future release',
    'FAIL: //src/test/java/com/acme/shop/orders:OrderServiceTest (see /home/dev/.cache/bazel/_bazel_dev/1f2e3d4c/execroot/_main/bazel-out/k8-fastbuild/testlogs/src/test/java/com/acme/shop/orders/OrderServiceTest/test.log)',
    'INFO: From Testing //src/test/java/com/acme/shop/orders:OrderServiceTest:',
    '==================== Test output for //src/test/java/com/acme/shop/orders:OrderServiceTest:',
    'JUnit4 Test Runner',
    '.....E',
    'Time: 0.412',
    'There was 1 failure:',
    '1) rejectsEmptyOrder(com.acme.shop.orders.OrderServiceTest)',
    'java.lang.AssertionError: expected:<0> but was:<1>',
    '\tat org.junit.Assert.fail(Assert.java:89)',
    '\tat org.junit.Assert.failNotEquals(Assert.java:835)',
    '\tat com.acme.shop.orders.OrderServiceTest.rejectsEmptyOrder(OrderServiceTest.java:33)',
    '\tat java.base/jdk.internal.reflect.DirectMethodHandleAccessor.invoke(DirectMethodHandleAccessor.java:103)',
    '',
    'FAILURES!!!',
    'Tests run: 6,  Failures: 1',
    '',
    '================================================================================',
    'INFO: Elapsed time: 48.221s, Critical Path: 31.07s',
    'INFO: 812 processes: 214 internal, 598 linux-sandbox.',
    'FAILED: Build did NOT complete successfully',
  );
  for (let i = 0; i < 18; i++) L.push(`//src/test/java/com/acme/shop/${domains[i % domains.length]}:${nouns[i % nouns.length].replace(/^./, (c) => c.toUpperCase())}Test${' '.repeat(30)}PASSED in ${(rnd() * 5).toFixed(1)}s`);
  L.push(
    '//src/test/java/com/acme/shop/orders:OrderServiceTest                    FAILED in 2.3s',
    '  /home/dev/.cache/bazel/_bazel_dev/1f2e3d4c/execroot/_main/bazel-out/k8-fastbuild/testlogs/src/test/java/com/acme/shop/orders/OrderServiceTest/test.log',
    '//src/test/java/com/acme/shop/cart:CartTest                              NO STATUS',
    '',
    'Executed 19 out of 20 tests: 18 tests pass, 1 fails locally and 1 was skipped.',
    'There were tests whose specified size is too big. Use the --test_verbose_timeout_warnings command line option to see which ones these are.',
    'FAILED: Build did NOT complete successfully',
    '',
  );
  return L.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// JSON reporters

function jestJsonFail() {
  const testResults = [];
  for (let f = 0; f < 60; f++) {
    const d = domains[f % domains.length];
    const assertionResults = [];
    for (let t = 0; t < 6; t++) {
      const failed = (f === 3 && t === 2) || (f === 41 && t === 0);
      const message = f === 3
        ? 'Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: 90\nReceived: 100\n    at Object.toBe (/home/dev/shop/src/cart/cart.test.ts:14:26)\n    at Promise.then.completed (/home/dev/shop/node_modules/jest-circus/build/utils.js:298:28)\n    at new Promise (<anonymous>)\n    at callAsyncCircusFn (/home/dev/shop/node_modules/jest-circus/build/utils.js:231:10)'
        : "TypeError: Cannot read properties of undefined (reading 'items')\n    at OrderService.create (/home/dev/shop/src/orders/service.ts:22:31)\n    at Object.<anonymous> (/home/dev/shop/src/orders/service.test.ts:33:20)\n    at Promise.then.completed (/home/dev/shop/node_modules/jest-circus/build/utils.js:298:28)";
      assertionResults.push({
        ancestorTitles: [d.replace(/^./, (c) => c.toUpperCase())], duration: Math.floor(rnd() * 30), failureDetails: failed ? [{ matcherResult: { actual: 100, expected: 90, message: '...', name: 'toBe', pass: false } }] : [],
        failureMessages: failed ? [message] : [],
        fullName: `${d} ${pick(verbs)} ${pick(nouns)}`, invocations: 1, location: null, numPassingAsserts: failed ? 0 : 1, retryReasons: [], status: failed ? 'failed' : 'passed', title: failed ? (f === 3 ? 'computes total with discount' : 'rejects an order without items') : `${pick(verbs)} ${pick(nouns)} ${t}`,
      });
    }
    const anyFailed = assertionResults.some((a) => a.status === 'failed');
    const name = f === 3 ? 'cart/cart' : f === 41 ? 'orders/service' : `${d}/${pick(nouns)}${f}`;
    testResults.push({ assertionResults, endTime: 1760004724000 + f, message: anyFailed ? '● ...' : '', name: `/home/dev/shop/src/${name}.test.ts`, startTime: 1760004721000 + f, status: anyFailed ? 'failed' : 'passed', summary: '' });
  }
  const doc = { numFailedTestSuites: 2, numFailedTests: 2, numPassedTestSuites: 58, numPassedTests: 358, numPendingTestSuites: 0, numPendingTests: 0, numRuntimeErrorTestSuites: 0, numTodoTests: 0, numTotalTestSuites: 60, numTotalTests: 360, openHandles: [], snapshot: { added: 0, didUpdate: false, failure: false, filesAdded: 0, filesRemoved: 0, filesRemovedList: [], filesUnmatched: 0, filesUpdated: 0, matched: 32, total: 32, unchecked: 0, uncheckedKeysByFile: [], unmatched: 0, updated: 0 }, startTime: 1760004720000, success: false, testResults, wasInterrupted: false };
  return `\n> shop@1.0.0 test\n> jest --json\n\n${JSON.stringify(doc)}\n`;
}

function goTestJsonFail() {
  const L = [];
  let t = 0;
  const ev = (o) => L.push(JSON.stringify({ Time: `2026-10-09T10:12:${String(Math.floor(t++ / 40) % 60).padStart(2, '0')}.${String(t % 1000).padStart(3, '0')}Z`, ...o }));
  for (const pkg of ['cart', 'catalog', 'customer', 'order']) {
    const P = `github.com/acme/shop/internal/${pkg}`;
    ev({ Action: 'start', Package: P });
    for (let i = 0; i < 30; i++) {
      const name = `Test${pkg.replace(/^./, (c) => c.toUpperCase())}${pick(nouns).replace(/^./, (c) => c.toUpperCase())}${i}`;
      ev({ Action: 'run', Package: P, Test: name });
      ev({ Action: 'output', Package: P, Test: name, Output: `=== RUN   ${name}\n` });
      if (pkg === 'order' && i === 7) {
        ev({ Action: 'output', Package: P, Test: name, Output: '    service_test.go:42: compute total: got 60.00, want 70.00\n' });
        ev({ Action: 'output', Package: P, Test: name, Output: `--- FAIL: ${name} (0.00s)\n` });
        ev({ Action: 'fail', Package: P, Test: name, Elapsed: 0 });
      } else {
        ev({ Action: 'output', Package: P, Test: name, Output: `--- PASS: ${name} (0.00s)\n` });
        ev({ Action: 'pass', Package: P, Test: name, Elapsed: 0 });
      }
    }
    if (pkg === 'order') {
      ev({ Action: 'output', Package: P, Output: 'FAIL\n' });
      ev({ Action: 'output', Package: P, Output: `FAIL\t${P}\t0.015s\n` });
      ev({ Action: 'fail', Package: P, Elapsed: 0.015 });
    } else {
      ev({ Action: 'output', Package: P, Output: 'PASS\n' });
      ev({ Action: 'output', Package: P, Output: `ok  \t${P}\t0.0${pkg.length}1s\n` });
      ev({ Action: 'pass', Package: P, Elapsed: 0.02 });
    }
  }
  return L.join('\n') + '\n';
}

function eslintJson() {
  const files = [];
  for (let f = 0; f < 120; f++) {
    const d = domains[f % domains.length];
    const messages = [];
    if (f % 9 === 0) messages.push({ ruleId: 'no-unused-vars', severity: 2, message: `'${pick(nouns)}' is defined but never used.`, line: 3 + f, column: 7, nodeType: 'Identifier', messageId: 'unusedVar', endLine: 3 + f, endColumn: 12 });
    if (f % 13 === 0) messages.push({ ruleId: 'eqeqeq', severity: 1, message: "Expected '===' and instead saw '=='.", line: 20, column: 15, nodeType: 'BinaryExpression', messageId: 'unexpected', endLine: 20, endColumn: 17 });
    files.push({ filePath: `/home/dev/shop/src/${d}/${pick(nouns)}${f}.ts`, messages, suppressedMessages: [], errorCount: messages.filter((m) => m.severity === 2).length, fatalErrorCount: 0, warningCount: messages.filter((m) => m.severity === 1).length, fixableErrorCount: 0, fixableWarningCount: 0, usedDeprecatedRules: [] });
  }
  return JSON.stringify(files) + '\n';
}

const fixtures = {
  'pytest-pass.txt': pytestPass(),
  'pytest-fail.txt': pytestFail(),
  'unittest-fail.txt': unittestFail(),
  'jest-pass.txt': jestPass(),
  'jest-fail.txt': jestFail(),
  'vitest-pass.txt': vitestPass(),
  'vitest-fail.txt': vitestFail(),
  'maven-pass.txt': mavenPass(),
  'maven-compile-fail.txt': mavenCompileFail(),
  'maven-test-fail.txt': mavenTestFail(),
  'gradle-pass.txt': gradlePass(),
  'gradle-fail.txt': gradleFail(),
  'dotnet-build-pass.txt': dotnetBuildPass(),
  'dotnet-build-fail.txt': dotnetBuildFail(),
  'dotnet-test-fail.txt': dotnetTestFail(),
  'go-test-pass.txt': goTestPass(),
  'go-test-fail.txt': goTestFail(),
  'tsc-fail.txt': tscFail(),
  'tsc-pretty-fail.txt': tscPretty(),
  'eslint-fail.txt': eslintFail(),
  'npm-install.txt': npmInstall(),
  'npm-build-fail.txt': npmRunBuildFail(),
  'cargo-test-pass.txt': cargoTestPass(),
  'cargo-build-fail.txt': cargoBuildFail(),
  'cargo-test-fail.txt': cargoTestFail(),
  'git-log.txt': gitLog(),
  'git-diff.txt': gitDiff(),
  'git-status.txt': gitStatus(),
  'generic-fail.txt': genericFail(),
  'generic-pass.txt': genericPass(),
  'mocha-pass.txt': mochaPass(),
  'mocha-fail.txt': mochaFail(),
  'mocha-json-fail.txt': mochaJsonFail(),
  'rspec-fail.txt': rspecFail(),
  'phpunit-fail.txt': phpunitFail(),
  'pest-fail.txt': pestFail(),
  'sbt-test-fail.txt': sbtTestFail(),
  'sbt-compile-fail.txt': sbtCompileFail(),
  'xunit-console-fail.txt': xunitConsoleFail(),
  'nunit-console-fail.txt': nunitConsoleFail(),
  'dotnet-mtp-fail.txt': dotnetMtpFail(),
  'bazel-test-fail.txt': bazelTestFail(),
  'jest-json-fail.txt': jestJsonFail(),
  'go-test-json-fail.txt': goTestJsonFail(),
  'eslint-json.txt': eslintJson(),
};
for (const [name, text] of Object.entries(fixtures)) out(name, text);
process.stderr.write(`wrote ${Object.keys(fixtures).length} fixtures to ${DIR}\n`);
