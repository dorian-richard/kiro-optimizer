// kopt_run's source context: stack frames, failing tests and failure messages mapped onto the index.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { estimateTokens } from '../src/core/tokens.js';
import { failureContext, frameLocations, messagePieces } from '../src/retrieval/failures.js';
import { setReextract } from '../src/retrieval/index.js';
import { symbolHandle } from '../src/store/store.js';
import { type Seeded, seedStore } from './helpers/seed.js';

let s: Seeded;
const hd = (key: string) => symbolHandle(s.ids[key]);
const RS = 'src/main/java/com/acme/billing/RefundService.java';
const TEST = 'src/test/java/com/acme/billing/RefundServiceTest.java';

beforeAll(() => {
  setReextract(false);
  s = seedStore();
});
afterAll(() => s.cleanup());

describe('frameLocations', () => {
  it('reads path:line frames of the common runners', () => {
    const out = [
      ' ❯ test/hooks.test.ts:157:91',
      '  File "/srv/app/billing/refunds.py", line 42, in compute',
      '\tat com.acme.billing.RefundService.computeRefund(RefundService.java:22)',
      '   at Acme.Billing.Refunds.Compute() in /src/Acme/Billing/Refunds.cs:line 17',
      'src/a.go:12: undefined: x',
      '    at Object.<anonymous> (web/src/api/refunds.ts:10:5)',
      'see https://example.com/page.html:80 for details',
    ].join('\n');
    const locs = frameLocations(out);
    expect(locs).toEqual(
      expect.arrayContaining([
        { path: 'test/hooks.test.ts', line: 157, jvmSuffix: undefined },
        { path: '/srv/app/billing/refunds.py', line: 42, jvmSuffix: undefined },
        { path: 'RefundService.java', line: 22, jvmSuffix: 'com/acme/billing/RefundService.java' },
        { path: '/src/Acme/Billing/Refunds.cs', line: 17, jvmSuffix: undefined },
        { path: 'src/a.go', line: 12, jvmSuffix: undefined },
        { path: 'web/src/api/refunds.ts', line: 10, jvmSuffix: undefined },
      ]),
    );
  });

  it('takes the literal parts of failure messages', () => {
    const out = [
      `AssertionError: .env: expected '.env: not readable through kopt (a link that leaves the project)' to be '...'`,
      'Expected: "order is refundable today"',
      'some unrelated "quoted text that is long" line',
    ].join('\n');
    expect(messagePieces(out)).toEqual(['not readable through kopt', 'a link that leaves the project', 'order is refundable today']);
  });
});

describe('failureContext', () => {
  it('maps product frames to their enclosing symbol, JVM frames by package path', () => {
    const out = `java.lang.IllegalStateException: boom\n\tat com.acme.billing.RefundService.computeRefund(RefundService.java:22)\n\tat ${TEST.replace(/\.java$/, '')}`;
    const ctx = failureContext(s.store, out, 200)!;
    expect(ctx.split('\n')[0]).toBe('source (kopt index):');
    expect(ctx).toContain(`  at ${RS}:22 in ${hd('RefundService.computeRefund')} RefundService.computeRefund (def L19)`);
  });

  it('follows a failing test to the product code it calls', () => {
    const out = `FAIL computeRefundCapsAmountAtPolicyLimit\n  expected 100 but was 400\n    at ${TEST}:21`;
    const ctx = failureContext(s.store, out, 200)!;
    expect(ctx).toMatch(new RegExp(`test ${TEST.replace(/[/.]/g, '\\$&')}:21 in ${hd('RefundServiceTest.computeRefundCapsAmountAtPolicyLimit')} \\S+ calls ${hd('RefundService.computeRefund')} RefundService\\.computeRefund ${RS.replace(/[/.]/g, '\\$&')}:19`));
  });

  it('points at the function whose text holds the failure message', () => {
    const out = 'Error: order not refundable: o1\n    at somewhere (node:internal/x:1:1)';
    const ctx = failureContext(s.store, out, 200)!;
    expect(ctx).toContain(`"order not refundable" is written in ${hd('RefundService.validateRequest')} RefundService.validateRequest ${RS}:43`);
  });

  it('stays within its budget and says nothing when nothing maps', () => {
    expect(failureContext(s.store, 'exit 1\nsomething failed somewhere', 200)).toBeUndefined();
    const out = `\tat com.acme.billing.RefundService.computeRefund(RefundService.java:22)\nError: order not refundable: o1\n    at ${TEST}:21`;
    for (const max of [10, 30, 60, 200]) {
      const c = failureContext(s.store, out, max);
      if (c) expect(estimateTokens(c)).toBeLessThanOrEqual(max);
    }
  });
});
