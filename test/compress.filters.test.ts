import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compressOutput, isCacheableCommand, parseCommand, relativizeRoot } from '../src/compress/index.js';
import { collapseSimilar, trimStack } from '../src/compress/filters/common.js';
import { normalizeOutput } from '../src/compress/normalize.js';
import { estimateTokens } from '../src/core/tokens.js';

const FIX = join(import.meta.dirname, 'fixtures', 'compress');
const ROOT = '/home/dev/shop';
const BUDGET = 900;

function load(name: string): string {
  return readFileSync(join(FIX, name), 'utf8');
}

/** Same path as runCommand: normalize, make repo paths relative, compress. */
function run(name: string, command: string, exitCode: number, maxTokens = BUDGET) {
  const raw = load(name);
  const normalized = normalizeOutput(raw);
  // fixtures are POSIX tool outputs: relativize them the same way on every OS
  const r = compressOutput(command, relativizeRoot(normalized, [ROOT], 'linux'), exitCode, maxTokens);
  const ratio = 1 - estimateTokens(r.text) / estimateTokens(normalized);
  return { ...r, ratio, tokens: estimateTokens(r.text), baseline: estimateTokens(normalized) };
}

const ratios: Record<string, string> = {};
function track(name: string, r: { ratio: number; tokens: number; baseline: number }) {
  ratios[name] = `${r.baseline} -> ${r.tokens} tok (${(r.ratio * 100).toFixed(1)}%)`;
}

describe('compress filters on realistic outputs', () => {
  const cases: [string, string, number][] = [
    ['pytest-pass.txt', 'pytest -v', 0],
    ['pytest-fail.txt', 'python -m pytest -v', 1],
    ['unittest-fail.txt', 'python manage.py test', 1],
    ['jest-pass.txt', 'npx jest --verbose', 0],
    ['jest-fail.txt', 'npm test', 1],
    ['vitest-pass.txt', 'npx vitest run', 0],
    ['vitest-fail.txt', 'pnpm vitest run', 1],
    ['maven-pass.txt', 'mvn -B verify', 0],
    ['maven-compile-fail.txt', 'mvn -B verify', 1],
    ['maven-test-fail.txt', './mvnw test', 1],
    ['gradle-pass.txt', './gradlew build', 0],
    ['gradle-fail.txt', './gradlew build --continue', 1],
    ['dotnet-build-pass.txt', 'dotnet build', 0],
    ['dotnet-build-fail.txt', 'dotnet build', 1],
    ['dotnet-test-fail.txt', 'dotnet test', 1],
    ['go-test-pass.txt', 'go test -v ./...', 0],
    ['go-test-fail.txt', 'go test -v ./...', 1],
    ['tsc-fail.txt', 'npx tsc --noEmit', 2],
    ['tsc-pretty-fail.txt', 'npx tsc --noEmit --pretty', 2],
    ['eslint-fail.txt', 'npx eslint src', 1],
    ['npm-install.txt', 'npm install', 0],
    ['npm-build-fail.txt', 'npm run build', 1],
    ['cargo-test-pass.txt', 'cargo test', 0],
    ['cargo-build-fail.txt', 'cargo build', 101],
    ['cargo-test-fail.txt', 'cargo test', 101],
    ['git-log.txt', 'git log', 0],
    ['git-diff.txt', 'git diff', 0],
    ['git-status.txt', 'git status', 0],
    ['generic-fail.txt', 'python scripts/migrate.py', 1],
    ['generic-pass.txt', './reindex.sh', 0],
    ['mocha-pass.txt', 'npx mocha', 0],
    ['mocha-fail.txt', 'npm test', 1],
    ['mocha-json-fail.txt', 'npx mocha --reporter json', 1],
    ['rspec-fail.txt', 'bundle exec rspec --format documentation', 1],
    ['phpunit-fail.txt', 'vendor/bin/phpunit', 2],
    ['pest-fail.txt', 'php artisan test', 1],
    ['sbt-test-fail.txt', 'sbt test', 1],
    ['sbt-compile-fail.txt', 'sbt compile', 1],
    ['xunit-console-fail.txt', 'dotnet tools/xunit.console.dll tests/Shop.Tests.dll', 1],
    ['nunit-console-fail.txt', 'nunit3-console tests/Shop.Tests.dll', 1],
    ['dotnet-mtp-fail.txt', 'dotnet test', 1],
    ['bazel-test-fail.txt', 'bazel test //...', 3],
    ['jest-json-fail.txt', 'npm test', 1],
    ['go-test-json-fail.txt', 'go test -json ./...', 1],
    ['eslint-json.txt', 'npx eslint -f json src', 1],
    // real runs of this repository (paths rewritten to the fixture root)
    ['vitest-kopt-pass.txt', 'npx vitest run', 0],
    ['vitest-kopt-fail.txt', 'npx vitest run', 1],
    ['build-kopt-fail.txt', 'npm run build', 2],
  ];

  it.each(cases)('%s respects the budget at %s', (name, command, code) => {
    for (const budget of [BUDGET, 250, 80]) {
      const r = run(name, command, code, budget);
      expect(r.tokens, `${name} @${budget}`).toBeLessThanOrEqual(budget);
      expect(r.text.trim().length).toBeGreaterThan(0);
      // never cut in the middle of a line: every output line exists in the input or is a marker/summary line
      if (budget === BUDGET) track(name, r);
    }
  });

  it('passing runs compress by more than 90%', () => {
    for (const [name, command] of [
      ['pytest-pass.txt', 'pytest -v'], ['jest-pass.txt', 'npx jest'], ['vitest-pass.txt', 'vitest run'],
      ['maven-pass.txt', 'mvn verify'], ['gradle-pass.txt', './gradlew build'], ['dotnet-build-pass.txt', 'dotnet build'],
      ['go-test-pass.txt', 'go test -v ./...'], ['cargo-test-pass.txt', 'cargo test'], ['generic-pass.txt', './reindex.sh'],
      ['npm-install.txt', 'npm install'], ['mocha-pass.txt', 'npx mocha'],
    ]) {
      const r = run(name, command, 0);
      expect(r.ratio, name).toBeGreaterThan(0.9);
      expect(r.text.split('\n').length, name).toBeLessThanOrEqual(5);
    }
  });

  it('pytest: verdict only on success; failures keep assertion, repo frames, dedup of identical errors', () => {
    const pass = run('pytest-pass.txt', 'pytest -v', 0);
    expect(pass.filter).toBe('pytest');
    expect(pass.text).toBe('407 passed, 5 skipped, 2 warnings in 12.34s (0:00:12)');

    const r = run('pytest-fail.txt', 'python -m pytest -v', 1);
    expect(r.filter).toBe('pytest');
    expect(r.text.split('\n')[0]).toBe('2 failed, 373 passed, 5 errors in 14.87s (0:00:14)');
    expect(r.text).toContain('FAILED tests/refunds/test_refunds.py::test_refund_partial');
    expect(r.text).toContain("E AssertionError: assert Decimal('60.00') == Decimal('70.00')");
    expect(r.text).toContain('tests/refunds/test_refunds.py:42: assert refund.amount == Decimal("70.00")');
    expect(r.text).toContain('FAILED tests/api/test_api.py::test_create_order');
    expect(r.text).toContain('shop/customers/loader.py:12: customer_id = payload["customer_id"]');
    expect(r.text).toContain("E KeyError: 'customer_id'");
    // 5 identical fixture errors -> one block + names
    expect(r.text).toContain('ImportError: libpq.so.5');
    expect(r.text.match(/ImportError: libpq/g)).toHaveLength(1);
    expect(r.text).toContain('same error in 4 more: test_repository_query_1');
    // library frames and captured output dropped
    expect(r.text).not.toContain('site-packages');
    expect(r.text).not.toContain('computing refund for order 1');
    expect(r.ratio).toBeGreaterThan(0.9);
  });

  it('unittest/Django: failing tests with in-repo frames only', () => {
    const r = run('unittest-fail.txt', 'python manage.py test', 1);
    expect(r.filter).toBe('unittest');
    expect(r.text).toMatch(/^Ran 466 tests in 8\.512s · FAILED \(failures=1, errors=1, skipped=1\)/);
    expect(r.text).toContain('FAIL: test_refund_rounding (billing.tests.test_refunds.RefundTests.test_refund_rounding)');
    expect(r.text).toContain('File "billing/tests/test_refunds.py", line 31, in test_refund_rounding');
    expect(r.text).toContain("AssertionError: Decimal('33.33') != Decimal('33.34')");
    expect(r.text).toContain("OSError: cannot load library 'gobject-2.0-0'");
    expect(r.text).not.toContain('weasyprint');
    expect(r.text).not.toContain('^^^^');
  });

  it('jest: message, expected/received, failing line and repo frames; no console output, no jest-circus frames', () => {
    expect(run('jest-pass.txt', 'npx jest', 0).text).toBe('Test Suites: 120 passed, 120 total · Tests: 593 passed, 593 total · Time: 45.67 s');
    const r = run('jest-fail.txt', 'npm test', 1);
    expect(r.filter).toBe('jest');
    expect(r.text).toContain('Tests: 3 failed, 412 passed, 415 total');
    expect(r.text).toContain('Snapshots: 1 failed, 31 passed, 32 total');
    expect(r.text).toContain('FAIL src/cart/cart.test.ts › Cart › computes total with discount');
    expect(r.text).toContain('Expected: 90');
    expect(r.text).toContain('Received: 100');
    expect(r.text).toContain('> expect(cart.total()).toBe(90);');
    expect(r.text).toContain('src/cart/cart.test.ts:14:26');
    expect(r.text).toContain('at Cart.total (src/cart/cart.ts:22:23)');
    expect(r.text).toContain('+   Total: $100.00');
    expect(r.text).not.toContain('jest-circus');
    expect(r.text).not.toContain('cart created with 0 items');
    // "Summary of all failing tests" repeats every failure: must not be duplicated
    expect(r.text.match(/computes total with discount/g)).toHaveLength(1);
  });

  it('vitest: grouped identical failures, diff and source location', () => {
    expect(run('vitest-pass.txt', 'npx vitest run', 0).text).toMatch(/^Test Files 140 passed \(140\) · Tests \d+ passed \(\d+\) · Duration 6\.52s$/);
    const r = run('vitest-fail.txt', 'pnpm vitest run', 1);
    expect(r.filter).toBe('vitest');
    expect(r.text).toContain('Tests 2 failed | 498 passed (500)');
    expect(r.text).toContain('FAIL src/cart/cart.test.ts > Cart > computes total with discount');
    expect(r.text).toContain('AssertionError: expected 100 to be 90');
    expect(r.text).toContain('❯ src/cart/cart.test.ts:14:26');
    expect(r.text).toContain('> expect(cart.total()).toBe(90);');
    expect(r.text).toContain('same error in 1 more: computes total with coupon');
    expect(r.text).not.toMatch(/✓ src\//);
  });

  it('maven: summed test counts, deduplicated compile errors grouped by file, no boilerplate', () => {
    const raw = load('maven-pass.txt');
    const expected = [...raw.matchAll(/^\[INFO\] Tests run: (\d+), Failures: 0, Errors: 0, Skipped: 0$/gm)].reduce((n, m) => n + Number(m[1]), 0);
    const pass = run('maven-pass.txt', 'mvn verify', 0);
    expect(pass.text).toBe(`BUILD SUCCESS · Total time: 01:12 min · Tests run: ${expected}, Failures: 0, Errors: 0, Skipped: 0 · 6 modules · 5 warnings`);

    const r = run('maven-compile-fail.txt', 'mvn -B verify', 1);
    expect(r.filter).toBe('maven');
    expect(r.text).toMatch(/^BUILD FAILURE · Total time: 14\.902 s/);
    expect(r.text).toContain('failed: shop-core');
    expect(r.text).toContain('skipped: shop-persistence, shop-api, shop-web');
    expect(r.text).toContain('shop-core/src/main/java/com/acme/shop/orders/OrderService.java: 2 errors');
    expect(r.text).toContain('42:17: cannot find symbol');
    expect(r.text).toContain('symbol:   method computeTotal(java.util.List<com.acme.shop.model.Item>)');
    expect(r.text).toContain('57:29: incompatible types: java.lang.String cannot be converted to int');
    expect(r.text).toContain('shop-core/src/main/java/com/acme/shop/refunds/RefundService.java:88:9: method does not override or implement a method from a supertype');
    expect(r.text.match(/cannot find symbol/g)).toHaveLength(1);
    expect(r.text).toContain('resume with: mvn <args> -rf :shop-core');
    expect(r.text).not.toMatch(/Help 1|Downloading|re-run Maven/);

    const t = run('maven-test-fail.txt', './mvnw test', 1);
    expect(t.text).toContain('Tests run: 312, Failures: 1, Errors: 1, Skipped: 0');
    expect(t.text).toContain('FAILED com.acme.shop.refunds.RefundServiceTest.refundPartial');
    expect(t.text).toContain('org.opentest4j.AssertionFailedError: expected: <70.00> but was: <60.00>');
    expect(t.text).toContain('at com.acme.shop.refunds.RefundServiceTest.refundPartial(RefundServiceTest.java:42)');
    expect(t.text).toContain('ERROR com.acme.shop.refunds.RefundServiceTest.refundForUnknownOrder');
    expect(t.text).toContain('at com.acme.shop.refunds.RefundService.refund(RefundService.java:57)');
    expect(t.text).not.toMatch(/org\.junit\.jupiter|surefire\.booter|jdk\.internal/);
    expect(t.ratio).toBeGreaterThan(0.85);
  });

  it('gradle: compile errors, failing tests with repo frames, failed tasks', () => {
    expect(run('gradle-pass.txt', './gradlew build', 0).text).toBe('BUILD SUCCESSFUL in 1m 4s · 64 actionable tasks: 64 executed · 240 tests passed');
    const r = run('gradle-fail.txt', './gradlew build --continue', 1);
    expect(r.filter).toBe('gradle');
    expect(r.text).toMatch(/^BUILD FAILED in 41s/);
    expect(r.text).toContain('248 tests completed, 2 failed, 3 skipped');
    expect(r.text).toContain('failed tasks: :api:compileJava, :core:test');
    expect(r.text).toContain('api/src/main/java/com/acme/shop/api/OrderController.java: 2 errors');
    expect(r.text).toContain('42: cannot find symbol');
    expect(r.text).toContain('location: variable calculator of type PriceCalculator');
    expect(r.text).toContain('FAILED RefundServiceTest > refundPartial()');
    expect(r.text).toContain('at com.acme.shop.refunds.RefundServiceTest.refundPartial(RefundServiceTest.java:42)');
    expect(r.text).not.toMatch(/app\/\/|AssertionFailureBuilder|\* Try:|help\.gradle\.org/);
  });

  it('dotnet: deduplicated MSBuild errors, warnings by code, failing tests with repo frames', () => {
    expect(run('dotnet-build-pass.txt', 'dotnet build', 0).text).toMatch(/^Build succeeded · 0 errors, 40 warnings \(CS\d+ x\d+, CS\d+ x\d+, CS\d+ x\d+\) · 00:00:18\.42$/);
    const b = run('dotnet-build-fail.txt', 'dotnet build', 1);
    expect(b.filter).toBe('dotnet');
    expect(b.text).toMatch(/^Build FAILED · 3 errors, 1 warning \(CS8602\)/);
    expect(b.text).toContain('src/Shop.Core/Orders/OrderService.cs: 2 errors');
    expect(b.text).toContain("42:17: CS0103 The name 'ComputeTotal' does not exist in the current context");
    expect(b.text.match(/CS0103/g)).toHaveLength(1);
    expect(b.text).not.toContain('.csproj]');

    const t = run('dotnet-test-fail.txt', 'dotnet test', 1);
    expect(t.text).toContain('Failed! Failed: 2, Passed: 338, Skipped: 1, Total: 341');
    expect(t.text).toContain('FAILED Shop.Tests.Refunds.RefundServiceTests.RefundPartial');
    expect(t.text).toContain('Expected: 70.00');
    expect(t.text).toContain('src/Shop.Tests/Refunds/RefundServiceTests.cs:42');
    expect(t.text).toContain('src/Shop.Core/Orders/OrderService.cs:57');
    expect(t.text).not.toMatch(/System\.RuntimeMethodHandle|customer lookup returned null/);
  });

  it('go: per-test log lines, subtests, panics without runtime frames, build errors', () => {
    expect(run('go-test-pass.txt', 'go test -v ./...', 0).text).toBe('ok: 12 packages · 2 without tests · 264 tests passed');
    const r = run('go-test-fail.txt', 'go test -v ./...', 1);
    expect(r.filter).toBe('go');
    expect(r.text).toContain('3 tests failed');
    expect(r.text).toContain('FAIL github.com/acme/shop/internal/order 0.015s');
    expect(r.text).toContain('FAIL github.com/acme/shop/internal/invoice [build failed]');
    expect(r.text).toContain('--- FAIL: TestRefundPartial\n  refund_test.go:42: compute refund: got 60.00, want 70.00');
    expect(r.text).toContain('--- FAIL: TestRefundTable/negative_amount\n  refund_test.go:88: expected ErrInvalidAmount, got <nil>');
    expect(r.text).toContain('panic: runtime error: invalid memory address or nil pointer dereference');
    expect(r.text).toContain('internal/order/service.go:57 order.(*Service).Create');
    expect(r.text).toContain('internal/invoice/pdf.go: 2 errors');
    expect(r.text).toContain('42:17: undefined: renderTotal');
    expect(r.text).not.toMatch(/\/usr\/local\/go|TestOrderLookup|=== RUN/);
  });

  it('tsc: grouped by file, identical messages merged, cross-file repeats hoisted', () => {
    const r = run('tsc-fail.txt', 'npx tsc --noEmit', 2);
    expect(r.filter).toBe('tsc');
    expect(r.text).toContain("TS2307 Cannot find module '@acme/contracts' or its corresponding type declarations. (x60 in 60 files)");
    // a file with one error: one line
    expect(r.text).toContain("\nsrc/cart/cart.ts:22:23: TS2339 Property 'reduce' does not exist on type 'CartItems'.\n");
    expect(r.text).toContain('src/api/client.ts: 25 errors');
    expect(r.text).toMatch(/100:7, 103:8, .*TS7006 Parameter 'res' implicitly has an 'any' type\./);
    expect(r.text).toContain("is missing the following properties from type 'Order': total, items, customer");
    const p = run('tsc-pretty-fail.txt', 'tsc --pretty', 2);
    expect(p.text.split('\n')[0]).toBe('Found 3 errors in 2 files.');
    expect(p.text).toContain("57:9: TS2322 Type 'string' is not assignable to type 'number'.");
    expect(p.text).not.toMatch(/~~~|Errors {2}Files/);
  });

  it('eslint: errors listed by file, warnings summarized by rule', () => {
    const r = run('eslint-fail.txt', 'npx eslint src', 1);
    expect(r.filter).toBe('eslint');
    expect(r.text.split('\n')[0]).toBe('✖ 161 problems (3 errors, 158 warnings)');
    expect(r.text).toContain('0 errors and 12 warnings potentially fixable with the `--fix` option.');
    expect(r.text).toMatch(/warnings by rule: \S+ \d+/);
    expect(r.text).toContain("src/api/client.ts:10:5: Parsing error: ';' expected");
    expect(r.text).toContain("12:7: 'unusedHelper' is assigned a value but never used (@typescript-eslint/no-unused-vars)");
    expect(r.text).not.toContain('Unexpected console statement');
    expect(r.ratio).toBeGreaterThan(0.9);
  });

  it('npm: install summary; failing script keeps the error and code frame, drops npm noise', () => {
    expect(run('npm-install.txt', 'npm install', 0).text).toBe(
      'added 1324 packages, and audited 1325 packages in 32s · 12 vulnerabilities (4 moderate, 8 high) · 18 deprecation warnings',
    );
    const r = run('npm-build-fail.txt', 'npm run build', 1);
    expect(r.filter).toBe('npm');
    expect(r.text).toContain('> vite build');
    expect(r.text).toContain('src/pages/Checkout.tsx:88:14: ERROR: Expected ")" but found "total"');
    expect(r.text).toContain('88 |        amount={cart total}');
    expect(r.text).toContain('Lifecycle script `build` failed with error:');
    expect(r.text).not.toMatch(/A complete log|npm error path|\/home\/dev/);
    expect((r.text.match(/transformed$/gm) ?? []).length).toBeLessThanOrEqual(2);
  });

  it('cargo: aggregated test results, rustc diagnostics, panics', () => {
    expect(run('cargo-test-pass.txt', 'cargo test', 0).text).toBe('test result: ok. 213 passed; 0 failed; 2 ignored (3 suites) in 1.80s');
    const b = run('cargo-build-fail.txt', 'cargo build', 101);
    expect(b.filter).toBe('cargo');
    expect(b.text).toContain('error[E0425]: cannot find function `compute_total` in this scope --> src/order.rs:42:17');
    expect(b.text).toContain('42 |     let total = compute_total(&items);');
    expect(b.text).toContain('error[E0308]: mismatched types --> src/order.rs:57:20');
    expect(b.text).toContain('2 warnings: unused variable: `fee`');
    expect(b.text).not.toContain('Compiling');
    const t = run('cargo-test-fail.txt', 'cargo test', 101);
    expect(t.text).toContain('test result: FAILED. 119 passed; 1 failed; 0 ignored');
    expect(t.text).toContain('FAILED refund::tests::refund_partial');
    expect(t.text).toContain("panicked at src/refund.rs:142:9:");
    expect(t.text).toContain('left: 60.00');
    expect(t.text).not.toContain('RUST_BACKTRACE');
  });

  it('git: one line per commit, diff hunks kept without index lines, compact status', () => {
    const log = run('git-log.txt', 'git log', 0);
    expect(log.filter).toBe('git');
    const lines = log.text.split('\n');
    expect(lines[0]).toMatch(/^[0-9a-f]{9} \(HEAD -> main, origin\/main\) 2026-10-01 \S+ \S+: .+/);
    expect(lines.slice(0, -1).every((l) => /^[0-9a-f]{9} /.test(l))).toBe(true);
    expect(log.text).toMatch(/… \+\d+ more commits/);
    expect(log.text).not.toMatch(/Author:|Date:/);

    const diff = run('git-diff.txt', 'git diff', 0);
    expect(diff.text).toContain('diff --git a/src/refunds/policy.ts b/src/refunds/policy.ts');
    expect(diff.text).toContain('+    const base = order.total.minus(order.shipping);');
    expect(diff.text).toContain('@@ -10,7 +10,9 @@ export class FeePolicy {');
    expect(diff.text).not.toMatch(/^index [0-9a-f]/m);
    expect(diff.text).not.toMatch(/^\+\+\+ b\//m);
    expect(diff.text).toContain('Binary files differ');
    expect(diff.text).toContain('(generated/lockfile: +60 -60 in 30 hunks, omitted)');
    expect(diff.text).toContain('-export function legacyFee(total: number) {');
    expect(diff.text).toMatch(/… \+\d+ hunks \(\+\d+ -\d+\) omitted/);

    const st = run('git-status.txt', 'git status', 0);
    expect(st.text).toContain('staged (2): M src/refunds/policy.ts, A src/refunds/fees.test.ts');
    expect(st.text).toContain('unstaged (2): M src/refunds/service.ts, D src/refunds/legacy.ts');
    expect(st.text).toContain('untracked (46): src/generated/ (45 files), notes.md');
    expect(st.text).not.toContain('(use "git');
    const short = compressOutput('git status -sb', '## main...origin/main\n M src/a.ts\n?? src/b.ts\n', 0, 900);
    expect(short.text).toBe('## main...origin/main\n M src/a.ts\n?? src/b.ts');
    const longShort = Array.from({ length: 400 }, (_, i) => `?? gen/file${i}.ts`).join('\n');
    const ls = compressOutput('git status --short', longShort, 0, 200);
    expect(ls.text.split('\n')[0]).toBe('?? gen/file0.ts');
    expect(estimateTokens(ls.text)).toBeLessThanOrEqual(200);
  });

  it('generic: error context with whole traceback (repo frames kept), head+tail on success', () => {
    const r = run('generic-fail.txt', 'python scripts/migrate.py', 1);
    expect(r.filter).toBe('generic');
    expect(r.text).toContain('File "shop/refunds/migrations.py", line 41, in apply_fees');
    expect(r.text).toContain('psycopg2.errors.NotNullViolation: null value in column "fee"');
    expect(r.text).toContain('DETAIL:  Failing row contains');
    expect(r.text).not.toContain('extras.py');
    expect(r.text).not.toContain('migrated batch 10/300');
    const ok = run('generic-pass.txt', './reindex.sh', 0);
    expect(ok.text).toContain('reindex complete: 400 shards');
    expect(ok.text).toContain('… 398 similar lines');
  });

  it('mocha: verdict, each failure with message, diff and repo frames; passing tree dropped', () => {
    expect(run('mocha-pass.txt', 'npx mocha', 0).text).toMatch(/^\d+ passing \(4s\) · 3 pending$/);
    const r = run('mocha-fail.txt', 'npm test', 1);
    expect(r.filter).toBe('mocha');
    expect(r.text.split('\n')[0]).toMatch(/^\d+ passing \(3s\) · 1 pending · 3 failing$/);
    expect(r.text).toContain('FAIL cart item3 › computes total with discount');
    expect(r.text).toContain('100 !== 90');
    expect(r.text).toContain('at Context.<anonymous> (test/cart/cart.test.js:14:12)');
    expect(r.text).toContain('at OrderService.create (src/orders/service.js:22:31)');
    // identical error in a hook: merged, status word not repeated
    expect(r.text).toContain('same error in 1 more: refunds refund29 › "before each" hook for "refunds the full amount"');
    expect(r.text).not.toMatch(/node_modules|node:internal|✔/);
    expect(r.ratio).toBeGreaterThan(0.9);
  });

  it('rspec: failures with expected/got, repo frames and rerun location; dots, gems and pending list dropped', () => {
    const r = run('rspec-fail.txt', 'bundle exec rspec --format documentation', 1);
    expect(r.filter).toBe('rspec');
    expect(r.text.split('\n')[0]).toBe('270 examples, 2 failures, 1 pending · Finished in 12.34 seconds');
    expect(r.text).toContain('FAILED Cart#total applies the discount\n  Failure/Error: expect(cart.total).to eq(90)\n  expected: 90\n  got: 100');
    expect(r.text).toContain('at spec/models/cart_spec.rb:14\n  rerun: rspec ./spec/models/cart_spec.rb:12');
    expect(r.text).toContain("undefined method `items' for nil");
    expect(r.text).toContain('at app/controllers/orders_controller.rb:22 in create');
    expect(r.text).not.toMatch(/gems\/|Randomized|Not yet implemented|compared using/);
    expect(r.ratio).toBeGreaterThan(0.9);
  });

  it('phpunit and pest: verdict, errors and failures with repo locations; vendor and source excerpts dropped', () => {
    const r = run('phpunit-fail.txt', 'vendor/bin/phpunit', 2);
    expect(r.filter).toBe('phpunit');
    expect(r.text.split('\n')[0]).toBe('FAILURES! Tests: 400, Assertions: 1132, Errors: 1, Failures: 1, Skipped: 1. · Time: 00:04.512');
    expect(r.text).toContain('ERROR Tests\\Unit\\OrderServiceTest::testCreateRejectsEmptyCart');
    expect(r.text).toContain('at app/Services/OrderService.php:22');
    expect(r.text).toContain('FAILED Tests\\Unit\\CartTest::testTotalWithDiscount\n  Failed asserting that 100 matches expected 90.\n  at tests/Unit/CartTest.php:28');
    expect(r.text).not.toMatch(/vendor\/|Runtime:|\.\.\.\.\.\.\./);
    const p = run('pest-fail.txt', 'php artisan test', 1);
    expect(p.filter).toBe('phpunit');
    expect(p.text).toBe(
      [
        'Tests: 1 failed, 251 passed (744 assertions) · Duration: 6.21s',
        'FAILED Tests\\Feature\\OrderTest > it creates an order',
        '  Expected response status code [201] but received 500.',
        '  Failed asserting that 500 is identical to 201.',
        '  at tests/Feature/OrderTest.php:22',
      ].join('\n'),
    );
  });

  it('sbt: ScalaTest failures with repo frames, scalac 2 and 3 errors by file, failed suites and tasks', () => {
    const t = run('sbt-test-fail.txt', 'sbt test', 1);
    expect(t.filter).toBe('sbt');
    expect(t.text.split('\n')[0]).toBe('Tests: succeeded 178, failed 2, canceled 0, ignored 0, pending 0 · *** 2 TESTS FAILED *** · Total time: 24 s');
    expect(t.text).toContain('failed suites: com.acme.shop.cart.CartSpec, com.acme.shop.orders.OrderSpec');
    expect(t.text).toContain('FAILED CartSpec › should compute the total with discount\n  100 did not equal 90 (CartSpec.scala:14)');
    expect(t.text).toContain('at com.acme.shop.orders.OrderService.create(OrderService.scala:22)');
    expect(t.text).not.toMatch(/org\.scalatest|\[info\]|loading settings|Tests unsuccessful/);
    expect(t.ratio).toBeGreaterThan(0.9);
    const c = run('sbt-compile-fail.txt', 'sbt compile', 1);
    expect(c.text).toContain('3 compile errors, 1 warning');
    expect(c.text).toContain('core/src/main/scala/com/acme/shop/cart/Cart.scala:22:20: type mismatch;\n  found   : String("x")\n  required: Int');
    expect(c.text).toContain('api/src/main/scala/com/acme/shop/api/Routes.scala:31:24: Found:    String\n  Required: Int');
    expect(c.text).toContain('failed: core / Compile / compileIncremental: Compilation failed');
  });

  it('xUnit console, NUnit console and Microsoft.Testing.Platform: summary and failures with repo frames', () => {
    const x = run('xunit-console-fail.txt', 'dotnet tools/xunit.console.dll tests/Shop.Tests.dll', 1);
    expect(x.filter).toBe('xunit');
    expect(x.text.split('\n')[0]).toBe('Shop.Tests: Total 412, Errors 0, Failed 2, Skipped 1, 3.481s');
    expect(x.text).toContain('FAILED Shop.Tests.CartTests.Total_WithDiscount\n  Assert.Equal() Failure: Values differ\n  Expected: 90\n  Actual:   100');
    expect(x.text).toContain('at Shop.Tests.CartTests.Total_WithDiscount() in tests/Shop.Tests/CartTests.cs:28');
    expect(x.text).toContain('at Shop.Services.OrderService.Create(List`1 items) in src/Shop/Services/OrderService.cs:22');
    expect(x.text).not.toMatch(/System\.RuntimeMethodHandle|creating order for customer|Discovering/);
    const n = run('nunit-console-fail.txt', 'nunit3-console tests/Shop.Tests.dll', 1);
    expect(n.text.split('\n')[0]).toBe('Overall result: Failed · Test Count: 412, Passed: 409, Failed: 2, Warnings: 0, Inconclusive: 0, Skipped: 1 · 3.912 seconds');
    expect(n.text).toContain('FAILED Shop.Tests.CartTests.TotalWithDiscount\n  Expected: 90\n  But was:  100');
    expect(n.text).toContain('ERROR Shop.Tests.OrderTests.CreateRejectsEmpty');
    expect(n.text).not.toMatch(/Run Settings|DisposeRunners|Runtime Environment/);
    // `dotnet test` on Microsoft.Testing.Platform: no VSTest blocks, the dotnet filter reads the MTP format
    const m = run('dotnet-mtp-fail.txt', 'dotnet test', 1);
    expect(m.filter).toBe('dotnet');
    expect(m.text).toContain('Test run summary: Failed! · total: 412 · failed: 1 · succeeded: 410 · skipped: 1 · duration: 3s 481ms');
    expect(m.text).toContain('FAILED Shop.Tests.CartTests.Total_WithDiscount');
    expect(m.text).toContain('at Shop.Tests.CartTests.Total_WithDiscount() in tests/Shop.Tests/CartTests.cs:28');
  });

  it('bazel: build errors with their diagnostics, failing test targets with the failing part of their log', () => {
    const r = run('bazel-test-fail.txt', 'bazel test //...', 3);
    expect(r.filter).toBe('bazel');
    expect(r.text.split('\n')[0]).toBe('Build did NOT complete successfully · Executed 19 out of 20 tests: 18 tests pass, 1 fails locally and 1 was skipped. · Elapsed time: 48.221s');
    expect(r.text).toContain('ERROR src/main/java/com/acme/shop/cart/BUILD.bazel:12: Building src/main/java/com/acme/shop/cart/libcart.jar (14 source files) failed: (Exit 1): java failed: error executing Javac command');
    expect(r.text).toContain('src/main/java/com/acme/shop/cart/Cart.java:22: error: cannot find symbol');
    expect(r.text).toContain('symbol:   method computeTotal(List<Item>)');
    expect(r.text).toContain('FAILED //src/test/java/com/acme/shop/orders:OrderServiceTest in 2.3s');
    expect(r.text).toContain('java.lang.AssertionError: expected:<0> but was:<1>');
    expect(r.text).toContain('at com.acme.shop.orders.OrderServiceTest.rejectsEmptyOrder(OrderServiceTest.java:33)');
    expect(r.text).toContain('NO STATUS //src/test/java/com/acme/shop/cart:CartTest');
    expect(r.text).not.toMatch(/\[\d[\d,]* \/ |Analyzing|PASSED in|remaining 42 arguments|test\.log|org\.junit\.Assert/);
    expect(r.ratio).toBeGreaterThan(0.9);
  });

  it('JSON reporters: jest --json, mocha json, go test -json and eslint -f json render like text reports', () => {
    const j = run('jest-json-fail.txt', 'npm test', 1);
    expect(j.filter).toBe('json');
    expect(j.text.split('\n')[0]).toBe('Test Suites: 2 failed, 58 passed, 60 total · Tests: 2 failed, 358 passed, 360 total');
    expect(j.text).toContain('FAIL src/cart/cart.test.ts › Payments › computes total with discount\n  Error: expect(received).toBe(expected) // Object.is equality\n  Expected: 90\n  Received: 100\n  at Object.toBe (src/cart/cart.test.ts:14:26)');
    expect(j.text).toContain('at OrderService.create (src/orders/service.ts:22:31)');
    expect(j.text).not.toMatch(/jest-circus|numPassedTests|"status"/);
    // the runner's own command match does not win over its JSON output
    expect(run('jest-json-fail.txt', 'npx jest --json', 1).filter).toBe('json');
    const m = run('mocha-json-fail.txt', 'npx mocha --reporter json', 1);
    expect(m.text.split('\n')[0]).toBe('160 passing (3444ms) · 2 failing');
    expect(m.text).toContain('FAIL test/cart/cart.test.js › Cart computes total with discount');
    expect(m.text).toContain('expected "90", got "100"');
    const g = run('go-test-json-fail.txt', 'go test -json ./...', 1);
    expect(g.filter).toBe('json');
    expect(g.text).toContain('FAIL github.com/acme/shop/internal/order 0.015s');
    expect(g.text).toMatch(/--- FAIL: TestOrder\w+7\n {2}service_test\.go:42: compute total: got 60\.00, want 70\.00/);
    expect(g.text).not.toMatch(/"Action"|=== RUN/);
    const e = run('eslint-json.txt', 'npx eslint -f json src', 1);
    expect(e.text.split('\n')[0]).toMatch(/^✖ \d+ problems \(\d+ errors, \d+ warnings\)$/);
    expect(e.text).toMatch(/^warnings by rule: eqeqeq 10$/m);
    expect(e.text).toMatch(/'\w+' is defined but never used\. \(no-unused-vars\)/);
    expect(e.text).not.toContain("Expected '==='");
    for (const x of [j, m, g, e]) expect(x.ratio).toBeGreaterThan(0.9);
    // JSON that is not a known report is left to the generic filter
    const other = compressOutput('kubectl get pods -o json', JSON.stringify({ items: Array.from({ length: 200 }, (_, i) => ({ name: `pod-${i}`, messages: [] })) }, null, 2), 0, 300);
    expect(other.filter).toBe('json>generic');
  });

  it('real runs of this repository: vitest pass/fail and a tsc build broken by a type change', () => {
    expect(run('vitest-kopt-pass.txt', 'npx vitest run', 0).text).toBe('Test Files 23 passed (23) · Tests 548 passed | 1 skipped (549) · Duration 17.94s');
    const f = run('vitest-kopt-fail.txt', 'npx vitest run', 1);
    expect(f.filter).toBe('vitest');
    expect(f.text).toBe(
      [
        'Test Files 1 failed | 22 passed (23) · Tests 1 failed | 547 passed | 1 skipped (549) · Duration 18.48s',
        'FAIL test/compress.command.test.ts > longRunningReason > names the reason in a few words',
        "  AssertionError: expected '--watch never exits' to be '--watch runs forever' // Object.is equality",
        '  Expected: "--watch runs forever"',
        '  Received: "--watch never exits"',
        "  > expect(longRunningReason('npx tsc --watch')).toBe('--watch runs fo…",
        '  ❯ test/compress.command.test.ts:109:50',
      ].join('\n'),
    );
    expect(f.ratio).toBeGreaterThan(0.95);
    const b = run('build-kopt-fail.txt', 'npm run build', 2);
    expect(b.filter).toBe('tsc');
    expect(b.text.split('\n')[0]).toBe('9 errors in 4 files');
    expect(b.text).toContain(
      "TS2353 Object literal may only specify known properties, and 'tokens' does not exist in type 'ToolResult'. (x8 in 3 files)\n" +
        '  at src/compress/expand.ts:15:18, 78:20, 98:18; src/compress/index.ts:143:18, 390:7, 419:20, 436:18; src/retrieval/common.ts:57:36',
    );
    expect(b.text).toContain('\nsrc/mcp/tools.ts:288:94: TS2322 ');
    expect(b.text).not.toContain('> tsc -p tsconfig.json');
  });

  it('real failing runs of this repository: every failing test named, as many in detail as the budget holds', () => {
    // 19 failures in 4 files: all named, grouped by file, then details
    const many = run('vitest-kopt-many-fail.txt', 'npx vitest run', 1);
    expect(many.tokens).toBeLessThanOrEqual(BUDGET);
    const lines = many.text.split('\n');
    expect(lines[1]).toBe('19 failures in 4 files:');
    expect(lines[2]).toBe('  test/retrieval.access.test.ts:');
    expect(many.text).toContain('\n    outline and find output carry no CR\n');
    expect(many.text).toContain('\n    resolveTarget > classifies targets\n');
    expect(many.text).not.toMatch(/\+\d+ more/);
    const details = lines.filter((l) => l.startsWith('FAIL '));
    expect(details.length).toBeGreaterThanOrEqual(3);
    expect(details[0]).toBe('FAIL test/retrieval.access.test.ts > access rules > refuses git-ignored and kiro-ignored files, nested rules included, in one line');
    // the runner's cut assertion line is dropped when the full values follow; a custom message stays
    expect(many.text).toContain('\n  AssertionError: .env\n  Expected: ".env: not readable through kopt (excluded by .gitignore or .kiroignore)"');
    expect(many.text).not.toContain("expected '.env: not readable through kopt (a li…'");

    // 5 failures with object diffs: all of them in detail, no overview needed
    const diff = run('vitest-kopt-diff-fail.txt', 'npx vitest run', 1);
    expect(diff.text.split('\n').filter((l) => l.startsWith('FAIL '))).toHaveLength(5);
    expect(diff.text).not.toMatch(/failures in|\+\d+ more/);
    expect(diff.text).not.toContain('matching properties omitted');
    expect(diff.text).toContain('  -   "stored": true,\n  +   "stored": false,');
    expect(diff.tokens).toBeLessThanOrEqual(BUDGET);
  });

  it('a tight budget lists every failing test first, same-error tests on one line', () => {
    const r = run('pytest-fail.txt', 'python -m pytest -v', 1, 260);
    expect(r.tokens).toBeLessThanOrEqual(260);
    expect(r.text).toContain(
      '7 failures in 3 files:\n' +
        '  tests/db/test_repository.py: test_repository_query_0 · test_repository_query_1 · test_repository_query_2 · test_repository_query_3 · test_repository_query_4 (same error)\n' +
        '  tests/refunds/test_refunds.py: test_refund_partial\n' +
        '  tests/api/test_api.py: test_create_order',
    );
    const many = run('vitest-kopt-many-fail.txt', 'npx vitest run', 1, 300);
    expect(many.tokens).toBeLessThanOrEqual(300);
    expect(many.text).toMatch(/\n {2}\+\d+ more\n/);
  });

  it('selects the new filters by output signature behind opaque commands', () => {
    expect(compressOutput('make test', load('mocha-fail.txt'), 1, BUDGET).filter).toBe('mocha');
    expect(compressOutput('make test', load('rspec-fail.txt'), 1, BUDGET).filter).toBe('rspec');
    expect(compressOutput('./ci/test.sh', load('phpunit-fail.txt'), 1, BUDGET).filter).toBe('phpunit');
    expect(compressOutput('composer test', load('pest-fail.txt'), 1, BUDGET).filter).toBe('phpunit');
    expect(compressOutput('./ci/test.sh', load('sbt-test-fail.txt'), 1, BUDGET).filter).toBe('sbt');
    expect(compressOutput('./ci/test.sh', load('nunit-console-fail.txt'), 1, BUDGET).filter).toBe('xunit');
    expect(compressOutput('./ci/test.sh', load('bazel-test-fail.txt'), 1, BUDGET).filter).toBe('bazel');
    expect(compressOutput('make lint', load('eslint-json.txt'), 1, BUDGET).filter).toBe('json');
  });

  it('selects filters by output signature when the command is opaque', () => {
    expect(compressOutput('make test', load('pytest-fail.txt'), 2, BUDGET).filter).toBe('pytest');
    expect(compressOutput('npm test', load('jest-pass.txt'), 0, BUDGET).filter).toBe('jest');
    expect(compressOutput('bash -c "cd api && ./gradlew test"', load('gradle-fail.txt'), 1, BUDGET).filter).toBe('gradle');
    expect(compressOutput('./ci/build.sh', load('maven-compile-fail.txt'), 1, BUDGET).filter).toBe('maven');
    expect(compressOutput('yarn typecheck', load('tsc-fail.txt'), 2, BUDGET).filter).toBe('tsc');
  });

  it('works on unrelativized absolute paths and is robust to garbage', () => {
    const r = compressOutput('mvn verify', load('maven-compile-fail.txt'), 1, BUDGET);
    expect(r.text).toContain('/home/dev/shop/shop-core/src/main/java/com/acme/shop/orders/OrderService.java: 2 errors');
    const garbage = Array.from({ length: 2000 }, (_, i) => `\x00\x07${'x'.repeat(i % 50)}\u0001${i}`).join('\n');
    const g = compressOutput('cat blob.bin', garbage, 0, 300);
    expect(estimateTokens(g.text)).toBeLessThanOrEqual(300);
    expect(compressOutput('true', '', 0, 100)).toEqual({ text: '(no output)', filter: 'none' });
    expect(compressOutput('echo hi', 'hi\n', 0, 100)).toEqual({ text: 'hi', filter: 'raw' });
  });

  it('a failing filter on the wrong kind of output falls back to generic', () => {
    const r = compressOutput('pytest', Array.from({ length: 400 }, (_, i) => `line ${i} fatal: something odd`).join('\n'), 3, 200);
    expect(r.filter).toBe('pytest>generic');
    expect(estimateTokens(r.text)).toBeLessThanOrEqual(200);
  });

  it('prints the compression ratios', () => {
    // Keeps the measured ratios visible in the test log (vitest --reporter=verbose).
    const lines = Object.entries(ratios).map(([k, v]) => `${k.padEnd(24)} ${v}`);
    process.stderr.write(`\ncompression @${BUDGET} tok:\n${lines.join('\n')}\n`);
    expect(lines.length).toBeGreaterThan(20);
  });
});

describe('normalizeOutput', () => {
  it('strips ANSI, resolves carriage returns and cursor-up redraws', () => {
    const raw = '\x1b[32m✓ ok\x1b[0m\r\nDownloading 10%\rDownloading 50%\rDone\nstep 1\n\x1b[1A\x1b[2Kstep 2\n';
    expect(normalizeOutput(raw)).toBe('✓ ok\nDone\nstep 2');
  });

  it('drops progress bars, spinners and download chatter; keeps pytest progress lines', () => {
    const raw = [
      '[INFO] Downloading from central: https://repo.maven.apache.org/x.pom',
      '[INFO] Downloaded from central: https://repo.maven.apache.org/x.pom (2 kB at 4 kB/s)',
      'Progress (1): 12/45 kB',
      '<===========--> 85% EXECUTING [12s]',
      ' ━━━━━━━━━━━━━━━━━━━━ 1.2/1.2 MB 3.4 MB/s eta 0:00:00',
      '⠙ resolving',
      'tests/test_a.py ......................                                  [ 45%]',
      'real line',
    ].join('\n');
    expect(normalizeOutput(raw)).toBe('tests/test_a.py ......................                                  [ 45%]\nreal line');
  });

  it('collapses identical runs and blank runs, idempotently', () => {
    const raw = 'a\na\na\n\n\n\nb\nwarn x\nwarn x\n';
    const once = normalizeOutput(raw);
    expect(once).toBe('a (x3)\n\nb\nwarn x (x2)');
    expect(normalizeOutput(once)).toBe(once);
  });

  it('collapseSimilar keeps first/last of near-identical runs but never error lines', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `processed /data/shard-${i}.json in ${i * 3}ms`);
    expect(collapseSimilar(lines)).toEqual([lines[0], '… 48 similar lines', lines[49]]);
    const errs = Array.from({ length: 6 }, (_, i) => `error: file ${i} failed`);
    expect(collapseSimilar(errs)).toEqual(errs);
  });

  it('trimStack keeps up to 3 in-repo frames', () => {
    const t = trimStack([
      'Error: boom',
      '    at a (src/a.ts:1:1)',
      '    at b (node_modules/x/index.js:2:2)',
      '    at c (src/c.ts:3:3)',
      '    at d (node:internal/process/task_queues:95:5)',
      '    at e (src/e.ts:5:5)',
      '    at f (src/f.ts:6:6)',
    ]);
    expect(t).toEqual(['Error: boom', '    at a (src/a.ts:1:1)', '    at c (src/c.ts:3:3)', '    at e (src/e.ts:5:5)', '    … 3 frames omitted']);
  });
});

describe('command parsing and cacheability', () => {
  it('unwraps env assignments, runners and compound commands', () => {
    const progs = (c: string) => parseCommand(c).segments.map((s) => s.program);
    expect(progs('FOO=1 npx jest --ci')).toEqual(['jest']);
    expect(progs('python -m pytest -x tests')).toEqual(['pytest']);
    expect(progs('cd api && ./gradlew test | tee build.log')).toEqual(['cd', 'gradlew', 'tee']);
    expect(progs('uv run pytest')).toEqual(['uv', 'pytest']);
    expect(progs('bash -c "mvn -q test"')).toEqual(['mvn']);
    expect(progs('yarn jest src')).toEqual(['yarn', 'jest']);
    expect(progs('timeout 60 go test ./...')).toEqual(['go']);
    expect(progs('C:\\tools\\mvnw.cmd verify')).toEqual(['mvnw']);
  });

  it('caches only workspace-deterministic commands', () => {
    for (const c of ['pytest -q', 'npm test', 'npm run build', 'yarn lint', 'pnpm vitest run', './gradlew test', 'mvn -q verify', 'go test ./...', 'cargo test', 'git log -5', 'git diff HEAD~1', 'npx tsc --noEmit', 'dotnet test', 'cd api && mvn test', 'cargo build --release', 'dotnet build -c Release', 'yarn jest']) {
      expect(isCacheableCommand(c), c).toBe(true);
    }
    for (const c of ['npm install', 'npm ci', 'npm run dev', 'yarn start', 'docker compose up -d && pytest', 'git push', 'git pull', 'mvn deploy', './gradlew bootRun', 'jest --watch', 'echo hi', 'curl https://x', 'make test', 'cargo run', 'go run .', 'npm publish', 'python script.py', 'mvn release:prepare', './gradlew publishToMavenLocal', 'cargo publish', 'npm run deploy']) {
      expect(isCacheableCommand(c), c).toBe(false);
    }
  });
});
