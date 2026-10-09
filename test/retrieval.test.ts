import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultConfig } from '../src/core/config.js';
import { newToolContext, type ToolContext } from '../src/core/context.js';
import { estimateTokens } from '../src/core/tokens.js';
import type { ToolResult } from '../src/core/types.js';
import { symbolHandle } from '../src/store/store.js';
import { find, outline, read, refs, resolveTarget, setReextract } from '../src/retrieval/index.js';
import { type Seeded, seedStore } from './helpers/seed.js';

let s: Seeded;
let ctx: ToolContext;
const J = 'src/main/java/com/acme';
const RS = `${J}/billing/RefundService.java`;
const LEGACY = `${J}/legacy/LegacyBillingEngine.java`;
const hd = (key: string) => symbolHandle(s.ids[key]);
const fileText = (p: string) => readFileSync(join(s.root, p), 'utf8');
const lines = (p: string, a: number, b: number) => fileText(p).split('\n').slice(a - 1, b).join('\n');

/** Handles of hit lines, in output order. */
const hitHandles = (r: ToolResult) => [...r.text.matchAll(/^ {2}(#[0-9a-z]+) /gm)].map((m) => m[1]);

function expectValid(r: ToolResult, maxTokens: number) {
  expect(r.tokens).toBe(estimateTokens(r.text));
  expect(r.tokens).toBeLessThanOrEqual(maxTokens);
  expect(r.text.length).toBeGreaterThan(0);
}

beforeAll(() => {
  setReextract(false);
  s = seedStore();
});
afterAll(() => s.cleanup());
beforeEach(() => {
  ctx = newToolContext(defaultConfig(s.root));
});

describe('find (hits)', () => {
  it('ranks the exact identifier first', () => {
    const r = find(s.store, { query: 'computeRefund' }, ctx);
    expect(hitHandles(r)[0]).toBe(hd('RefundService.computeRefund'));
    expect(r.meta?.top).toBe(s.ids['RefundService.computeRefund']);
  });

  it('matches names case-insensitively', () => {
    expect(hitHandles(find(s.store, { query: 'computerefund' }, ctx))[0]).toBe(hd('RefundService.computeRefund'));
    expect(hitHandles(find(s.store, { query: 'REFUNDPOLICY' }, ctx))[0]).toBe(hd('RefundPolicy'));
  });

  it('ranks computeRefund first for natural-language queries', () => {
    for (const q of ['compute refund amount', 'where are refunds computed?', 'how is the refund amount computed']) {
      expect(hitHandles(find(s.store, { query: q }, ctx))[0], q).toBe(hd('RefundService.computeRefund'));
    }
  });

  it('demotes test files unless the query mentions tests', () => {
    const hits = hitHandles(find(s.store, { query: 'compute refund amount' }, ctx));
    const test1 = hits.indexOf(hd('RefundServiceTest.computeRefundReturnsRequestedAmountUnderCap'));
    expect(test1).toBeGreaterThan(hits.indexOf(hd('RefundService.computeRefund')));
    expect(test1).toBeGreaterThan(hits.indexOf(hd('computeRefundPreview')));
    const withTests = hitHandles(find(s.store, { query: 'compute refund test' }, ctx));
    expect([hd('RefundServiceTest.computeRefundReturnsRequestedAmountUnderCap'), hd('RefundServiceTest.computeRefundCapsAmountAtPolicyLimit')]).toContain(withTests[0]);
  });

  it('resolves qualified names with . :: # separators', () => {
    for (const q of ['RefundService.approveRefund', 'RefundService::approveRefund', 'RefundService#approveRefund', 'com.acme.billing.RefundService.approveRefund']) {
      expect(hitHandles(find(s.store, { query: q }, ctx))[0], q).toBe(hd('RefundService.approveRefund'));
    }
  });

  it('supports globs on names and members', () => {
    const hits = find(s.store, { query: 'compute*' }, ctx);
    const names = [...hits.text.matchAll(/^ {2}#\w+ \d+-\d+ \w+ (.*)$/gm)].map((m) => m[1]);
    expect(names.length).toBeGreaterThanOrEqual(4);
    for (const n of names) expect(n).toMatch(/\bcompute\w*\(/);
    const members = hitHandles(find(s.store, { query: 'RefundPolicy.*', limit: 20 }, ctx));
    expect(members).toEqual(expect.arrayContaining([hd('RefundPolicy.maxRefundFor'), hd('RefundPolicy.isRefundable')]));
    expect(hitHandles(find(s.store, { query: 'validate*Request' }, ctx))).toContain(hd('RefundService.validateRequest'));
    const qualGlob = hitHandles(find(s.store, { query: 'RefundService.*Refund' }, ctx));
    expect(qualGlob.slice(0, 3).sort()).toEqual([hd('RefundService.approveRefund'), hd('RefundService.computeRefund'), hd('RefundService.rejectRefund')].sort());
  });

  it('applies kinds and path filters (prefix and glob)', () => {
    const classes = find(s.store, { query: 'refund', kinds: ['class'] }, ctx);
    for (const m of classes.text.matchAll(/^ {2}#\w+ \d+-\d+ (\w+) /gm)) expect(m[1]).toBe('class');
    const web = find(s.store, { query: 'refund', path: 'web/' }, ctx);
    const paths = web.text.split('\n').slice(1).filter((l) => !l.startsWith(' '));
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) expect(p.startsWith('web/')).toBe(true);
    const java = find(s.store, { query: 'refund', path: '**/*.java' }, ctx);
    for (const p of java.text.split('\n').slice(1).filter((l) => !l.startsWith(' '))) expect(p).toMatch(/\.java$/);
    const none = find(s.store, { query: 'refund', path: 'nope/' }, ctx);
    expect(none.text).toMatch(/0 hits/);
    expect(none.text).toMatch(/without path\/kinds filters/);
  });

  it('formats: header, path once per file, indented hits with docs', () => {
    const r = find(s.store, { query: 'compute refund amount' }, ctx);
    const [head, ...body] = r.text.split('\n');
    expect(head).toMatch(/^find "compute refund amount" · \d+ hits · ~\d+ tok/);
    expect(Number(/~(\d+) tok/.exec(head)![1])).toBe(r.tokens);
    const pathLines = body.filter((l) => !l.startsWith(' '));
    expect(new Set(pathLines).size).toBe(pathLines.length);
    for (const l of body.filter((x) => x.startsWith(' '))) expect(l).toMatch(/^ {2}#[0-9a-z]+ \d+-\d+ \w+ \S/);
    expect(r.text).toContain(`${RS}\n  ${hd('RefundService.computeRefund')} 19-27 method public BigDecimal computeRefund(Order order, RefundRequest request) — Computes the refund amount`);
  });

  it('caps hits per file unless the query targets that file', () => {
    const r = find(s.store, { query: 'step', limit: 30 }, ctx);
    const groups = r.text.split('\n').slice(1);
    let count = 0;
    let cur = '';
    for (const l of groups) {
      if (!l.startsWith(' ')) cur = l;
      else if (cur === LEGACY) count++;
    }
    expect(count).toBeLessThanOrEqual(3);
    const targeted = find(s.store, { query: 'LegacyBillingEngine step', limit: 30, maxTokens: 3000 }, ctx);
    const n = targeted.text.split('\n').filter((l) => l.startsWith('  #')).length;
    expect(n).toBeGreaterThan(3);
  });

  it('drops constructors when their class is listed', () => {
    const r = find(s.store, { query: 'RefundService' }, ctx);
    expect(hitHandles(r)[0]).toBe(hd('RefundService'));
    expect(hitHandles(r)).not.toContain(hd('RefundService.RefundService'));
  });

  it('respects maxTokens and limit, reporting what was cut', () => {
    for (const maxTokens of [20, 60, 120, 250, 700]) {
      const r = find(s.store, { query: 'compute refund amount', maxTokens }, ctx);
      expectValid(r, maxTokens);
    }
    const small = find(s.store, { query: 'compute refund amount', maxTokens: 120 }, ctx);
    expect(small.text.split('\n')[0]).toMatch(/· \+\d+ more \(raise maxTokens or narrow query\)$/);
    const two = find(s.store, { query: 'compute refund amount', limit: 2 }, ctx);
    expect(hitHandles(two)).toHaveLength(2);
  });

  it('is deterministic', () => {
    const a = find(s.store, { query: 'refund ledger' }, ctx).text;
    const b = find(s.store, { query: 'refund ledger' }, newToolContext(defaultConfig(s.root))).text;
    expect(a).toBe(b);
  });

  it('never throws on bad input', () => {
    expect(find(s.store, { query: '' }, ctx).text).toMatch(/query is required/);
    expect(find(s.store, { query: 'the of and' }, ctx).text).toMatch(/no searchable terms/);
    expect(find(s.store, { query: 'zzqxv' }, ctx).text).toMatch(/0 hits/);
    expect(find(s.store, { query: '"unbalanced ( * OR' }, ctx).tokens).toBeGreaterThan(0);
    expect(find(s.store, { query: undefined as unknown as string }, ctx).text).toMatch(/query is required/);
  });

  it('ticks the ledger once per call', () => {
    find(s.store, { query: 'refund' }, ctx);
    read(s.store, { target: 'Order' }, ctx);
    outline(s.store, { path: '' }, ctx);
    refs(s.store, { target: 'Order' }, ctx);
    expect(ctx.ledger.callCount).toBe(4);
  });
});

describe('find (pack)', () => {
  it('returns pointers, the best bodies and a callers line', () => {
    const r = find(s.store, { query: 'compute refund amount', mode: 'pack' }, ctx);
    expectValid(r, ctx.config.budgets.pack);
    expect(r.text.split('\n')[0]).toMatch(/^pack "compute refund amount" · \d+ hits · \d+ bodies · ~\d+ tok/);
    expect(r.text).toContain(`${RS}:19-27 ${hd('RefundService.computeRefund')}\n${lines(RS, 19, 27)}`);
    expect(r.text).toMatch(new RegExp(`^callers of ${hd('RefundService.computeRefund')}: .*${hd('RefundService.approveRefund')} RefundService.approveRefund`, 'm'));
    expect(r.text).toContain(`${hd('RefundController.preview')} RefundController.preview`);
  });

  it('dedups bodies across calls; fresh resends', () => {
    find(s.store, { query: 'compute refund amount', mode: 'pack' }, ctx);
    const again = find(s.store, { query: 'compute refund amount', mode: 'pack' }, ctx);
    expect(again.text).toContain(`${RS}:19-27 ${hd('RefundService.computeRefund')} unchanged (shown in call 1) – pass fresh:true to resend`);
    expect(again.text).not.toContain('BigDecimal cap = policy.maxRefundFor(order);');
    const fresh = find(s.store, { query: 'compute refund amount', mode: 'pack', fresh: true }, ctx);
    expect(fresh.text).toContain('BigDecimal cap = policy.maxRefundFor(order);');
  });

  it('packs containers and long symbols as skeletons', () => {
    const r = find(s.store, { query: 'RefundService', mode: 'pack' }, ctx);
    expect(r.text).toContain(`${RS}:9-49 ${hd('RefundService')} skeleton`);
    expect(r.text).toContain('  L19 public BigDecimal computeRefund(Order order, RefundRequest request)');
    const long = find(s.store, { query: 'reconcileAll', mode: 'pack' }, ctx);
    expect(long.text).toMatch(new RegExp(`${hd('LegacyBillingEngine.reconcileAll')} skeleton\\npublic BigDecimal reconcileAll\\(Order order\\)\\ncalls: step01`));
    expect(long.text).not.toContain('acc = acc.add(step01(order));');
  });

  it('respects the budget', () => {
    for (const maxTokens of [40, 150, 400, 900, 2500]) expectValid(find(s.store, { query: 'refund approval ledger', mode: 'pack', maxTokens, fresh: true }, ctx), maxTokens);
  });
});

describe('read', () => {
  it('returns a symbol body verbatim under one header', () => {
    const r = read(s.store, { target: hd('RefundService.computeRefund') }, ctx);
    expect(r.text).toBe(`${RS}:19-27 ${hd('RefundService.computeRefund')}\n${lines(RS, 19, 27)}`);
    expectValid(r, ctx.config.budgets.read);
  });

  it('dedups repeated reads and resends with fresh', () => {
    read(s.store, { target: 'RefundService.computeRefund' }, ctx);
    const again = read(s.store, { target: 'RefundService.computeRefund' }, ctx);
    expect(again.text).toBe(`${RS}:19-27 ${hd('RefundService.computeRefund')} unchanged (shown in call 1) – pass fresh:true to resend`);
    const fresh = read(s.store, { target: 'RefundService.computeRefund', fresh: true }, ctx);
    expect(fresh.text).toContain(lines(RS, 19, 27));
  });

  it('treats a symbol inside an already-sent range as unchanged', () => {
    const file = read(s.store, { target: RS }, ctx);
    expect(file.text.startsWith(`${RS}:1-49\n`)).toBe(true);
    const sym = read(s.store, { target: 'approveRefund' }, ctx);
    expect(sym.text).toMatch(/unchanged \(shown in call 1\)/);
  });

  it('lists candidates for ambiguous names and resolves qualified ones', () => {
    const r = read(s.store, { target: 'validateRequest' }, ctx);
    expect(r.text.split('\n')[0]).toMatch(/^read "validateRequest" · 2 candidates · ~\d+ tok$/);
    expect(r.text).toContain(hd('RefundService.validateRequest'));
    expect(r.text).toContain(hd('InvoiceService.validateRequest'));
    expect(r.text).toMatch(/^next: kopt_read #/m);
    const q = read(s.store, { target: 'InvoiceService.validateRequest' }, ctx);
    expect(q.text.split('\n')[0]).toBe(`${J}/billing/InvoiceService.java:15-17 ${hd('InvoiceService.validateRequest')}`);
  });

  it('picks a clearly dominant candidate and prefers exact case', () => {
    const r = read(s.store, { target: 'formatAmount' }, ctx);
    expect(r.text.split('\n')[0]).toBe(`web/src/utils/format.ts:2-4 ${hd('formatAmount')}`);
    // "Refund" (record) wins over the case-insensitive "refund" method.
    expect(read(s.store, { target: 'Refund' }, ctx).text.split('\n')[0]).toContain(hd('Refund'));
    // A class and its constructor are one target.
    expect(read(s.store, { target: 'Order' }, ctx).text.split('\n')[0]).toContain(hd('Order'));
  });

  it('reads ranges, reversed ranges, single lines and line:col', () => {
    const p = 'web/src/api/refunds.ts';
    expect(read(s.store, { target: `${p}:10-13` }, ctx).text).toBe(`${p}:10-13\n${lines(p, 10, 13)}`);
    expect(read(s.store, { target: `./${p}:13-10`, fresh: true }, ctx).text).toBe(`${p}:10-13\n${lines(p, 10, 13)}`);
    expect(read(s.store, { target: `${RS}:22` }, ctx).text.split('\n')[0]).toBe(`${RS}:19-27 ${hd('RefundService.computeRefund')}`);
    expect(read(s.store, { target: `${RS}:31:9` }, ctx).text.split('\n')[0]).toBe(`${RS}:30-35 ${hd('RefundService.approveRefund')}`);
    expect(read(s.store, { target: `${p}:500-600` }, ctx).text).toMatch(/has 18 lines/);
    expect(read(s.store, { target: `${p}#L2-L3` }, ctx).text).toBe(`${p}:2-3\n${lines(p, 2, 3)}`);
  });

  it('cuts long ranges at line boundaries with a continuation hint', () => {
    const r = read(s.store, { target: `${LEGACY}:1-278`, maxTokens: 300 }, ctx);
    expectValid(r, 300);
    const m = /^next: kopt_read .*:(\d+)-278$/m.exec(r.text);
    expect(m).not.toBeNull();
    const shown = /^\S+:1-(\d+)$/m.exec(r.text)!;
    expect(Number(m![1])).toBe(Number(shown[1]) + 1);
    expect(r.text).toContain(lines(LEGACY, 1, Number(shown[1])));
  });

  it('returns short files verbatim and long files as skeletons with an exact baseline', () => {
    const p = 'web/src/api/refunds.ts';
    expect(read(s.store, { target: p }, ctx).text).toBe(`${p}:1-18\n${lines(p, 1, 18)}`);
    const r = read(s.store, { target: LEGACY }, ctx);
    expect(r.text.split('\n')[0]).toBe(`${LEGACY}:1-278 skeleton`);
    expect(r.text).toContain('  L178 public BigDecimal reconcileAll(Order order)');
    expect(r.baselineTokens).toBe(estimateTokens(fileText(LEGACY)));
    expect(r.tokens).toBeLessThan(r.baselineTokens! / 3);
    expect(read(s.store, { target: 'RefundService.java' }, ctx).text.startsWith(`${RS}:1-49\n`)).toBe(true);
  });

  it('renders container and function skeletons', () => {
    const c = read(s.store, { target: 'RefundService', mode: 'skeleton' }, ctx);
    expect(c.text).toBe(
      [
        `${RS}:9-49 ${hd('RefundService')} skeleton`,
        'L9 public class RefundService — Application service for customer refunds.',
        '  L10 private final RefundPolicy policy',
        '  L11 private final LedgerClient ledger',
        '  L13 public RefundService(RefundPolicy policy, LedgerClient ledger)',
        '  L19 public BigDecimal computeRefund(Order order, RefundRequest request)',
        '  L30 public Refund approveRefund(Order order, RefundRequest request)',
        '  L37 public Refund rejectRefund(Order order, String reason)',
        '  L43 private void validateRequest(Order order, RefundRequest request)',
      ].join('\n'),
    );
    const f = read(s.store, { target: 'computeRefund', mode: 'skeleton' }, ctx);
    expect(f.text).toBe(
      [
        `${RS}:19-27 ${hd('RefundService.computeRefund')} skeleton`,
        'public BigDecimal computeRefund(Order order, RefundRequest request)',
        '// Computes the refund amount for an order, capped by the refund policy.',
        'calls: validateRequest, request.amount, policy.maxRefundFor, requested.compareTo',
      ].join('\n'),
    );
  });

  it('renders a compact card', () => {
    const r = read(s.store, { target: 'computeRefund', mode: 'card' }, ctx);
    expect(r.text).toMatch(/^#\w+ method RefundService\.computeRefund · .*RefundService\.java:19-27 \(9 lines\)$/m);
    expect(r.text).toContain('callers 4 in 3 files · callees 4');
    expect(r.tokens).toBeLessThanOrEqual(100);
    expect(read(s.store, { target: RS, mode: 'card' }, ctx).text).toMatch(/· java · 49 lines · 8 symbols · imports 2 · imported by 1/);
  });

  it('falls back to a skeleton + parts hint when the body exceeds the budget', () => {
    const r = read(s.store, { target: 'reconcileAll', maxTokens: 300 }, ctx);
    expectValid(r, 300);
    expect(r.text).toContain(`${hd('LegacyBillingEngine.reconcileAll')} skeleton`);
    expect(r.text).toMatch(/body ~\d+ tok > maxTokens 300; raise maxTokens to ~\d+ or read in parts: \S+:178-\d+, \d+-\d+/);
    const cls = read(s.store, { target: 'LegacyBillingEngine', maxTokens: 600 }, ctx);
    expectValid(cls, 600);
    expect(cls.text).toMatch(/read a member with kopt_read \S+LegacyBillingEngine\.java:<L>/);
  });

  it('respects budgets for every target kind', () => {
    const targets = [hd('RefundService.computeRefund'), 'RefundService', LEGACY, `${LEGACY}:1-200`, 'validateRequest', 'README.md', 'nope'];
    for (const target of targets) {
      for (const maxTokens of [8, 30, 80, 200, 2000]) {
        for (const mode of [undefined, 'body', 'skeleton', 'card'] as const) {
          expectValid(read(s.store, { target, maxTokens, mode, fresh: true }, ctx), maxTokens);
        }
      }
    }
  });

  it('explains misses in one line with suggestions', () => {
    const miss = read(s.store, { target: 'computeRefunds' }, ctx);
    expect(miss.text).toMatch(new RegExp(`^no symbol matches "computeRefunds"; did you mean ${hd('RefundService.computeRefund')} RefundService.computeRefund`));
    expect(miss.text.split('\n')).toHaveLength(1);
    expect(read(s.store, { target: '#zzzzz' }, ctx).text).toMatch(/unknown handle #zzzzz/);
    expect(read(s.store, { target: 'src/nope/Missing.java' }, ctx).text).toMatch(/no file "src\/nope\/Missing.java"/);
    expect(read(s.store, { target: 'web' }, ctx).text).toBe('web is a directory; use kopt_outline web');
    expect(read(s.store, { target: '' }, ctx).text).toMatch(/empty target/);
    expect(read(s.store, { target: 'Order', mode: 'zzz' as never }, ctx).text).toMatch(/unknown mode/);
    expect(read(s.store, { target: '../../../../etc/passwd' }, ctx).text).toMatch(/no file/);
    expect(read(s.store, {} as never, ctx).text).toMatch(/empty target/);
  });

  it('reads from snapshot blobs when there is no checkout', () => {
    const snap = seedStore({ root: false, blobs: true });
    try {
      const c = newToolContext(defaultConfig(snap.root));
      const r = read(snap.store, { target: 'RefundService.computeRefund' }, c);
      expect(r.text).toContain('BigDecimal cap = policy.maxRefundFor(order);');
    } finally {
      snap.cleanup();
    }
  });
});

describe('outline', () => {
  it('outlines a file with line-prefixed members and an exact baseline', () => {
    const r = outline(s.store, { path: RS }, ctx);
    expect(r.text.split('\n')[0]).toMatch(new RegExp(`^outline ${RS} · 8 symbols · 49 lines · ~\\d+ tok$`));
    expect(r.text).toContain('\n  L19 public BigDecimal computeRefund(Order order, RefundRequest request)');
    expect(r.baselineTokens).toBe(estimateTokens(fileText(RS)));
  });

  it('drops private members and fields first when over budget', () => {
    const r = outline(s.store, { path: RS, maxTokens: 110 }, ctx);
    expectValid(r, 110);
    expect(r.text).not.toContain('private final RefundPolicy policy');
    expect(r.text).toContain('L19 public BigDecimal computeRefund');
    expect(r.text.split('\n')[0]).toMatch(/\+\d+ more/);
  });

  it('builds a ranked repo map grouped by directory', () => {
    const r = outline(s.store, { path: '' }, ctx);
    const out = r.text.split('\n');
    expect(out[0]).toMatch(/^repo map · \d+ files · ~\d+ tok$/);
    expect(out[1]).toBe(`${J}/billing/`);
    expect(out[2]).toBe('  Order.java: Order{getId,getTotal,isPaid,ageInDays}');
    expect(r.text).toContain('  RefundService.java: RefundService{computeRefund,approveRefund,rejectRefund}');
    expect(r.text).not.toContain('README.md');
    const dirs = out.slice(1).filter((l) => !l.startsWith(' '));
    expect(new Set(dirs).size).toBe(dirs.length);
    expect(outline(s.store, { path: '.' }, ctx).text).toBe(r.text);
  });

  it('personalizes the map with focus and reports omitted files', () => {
    const r = outline(s.store, { path: '', focus: 'refund amount', maxTokens: 160 }, ctx);
    expectValid(r, 160);
    expect(r.text).toContain('refunds.ts:');
    expect(r.text).toContain('RefundService.java:');
    expect(r.text).not.toContain('LegacyBillingEngine');
    expect(r.text.split('\n')[0]).toMatch(/^repo map focus "refund amount" · \d+ files · ~\d+ tok · \+\d+ more/);
    const ledger = outline(s.store, { path: '', focus: 'ledger record', maxTokens: 120 }, ctx);
    expect(ledger.text.split('\n').slice(1, 3).join('\n')).toContain('LedgerClient.java');
  });

  it('outlines a directory, a glob, a markdown file and a symbol', () => {
    const web = outline(s.store, { path: 'web/' }, ctx);
    expect(web.text.split('\n')[0]).toMatch(/^outline web\/ · 6 files/);
    for (const l of web.text.split('\n').slice(1).filter((x) => !x.startsWith(' '))) expect(l.startsWith('web/')).toBe(true);
    const ts = outline(s.store, { path: '**/*.ts' }, ctx);
    expect(ts.text.split('\n')[0]).toMatch(/^repo map "\*\*\/\*\.ts" · 5 files/);
    expect(ts.text).toContain('format.ts');
    expect(ts.text).not.toContain('.java');
    const md = outline(s.store, { path: 'README.md' }, ctx);
    expect(md.text).toContain('  L5 Architecture\n    L7 Billing domain');
    const sym = outline(s.store, { path: 'RefundPolicy' }, ctx);
    expect(sym.text).toContain(`${hd('RefundPolicy')} skeleton`);
    expect(outline(s.store, { path: 'nope/dir' }, ctx).text).toMatch(/no file or directory "nope\/dir"/);
  });

  it('respects budgets', () => {
    for (const path of ['', RS, LEGACY, 'web', 'README.md']) {
      for (const maxTokens of [10, 40, 120, 400, 1200]) expectValid(outline(s.store, { path, maxTokens, focus: path ? undefined : 'refund' }, ctx), maxTokens);
    }
  });
});

describe('refs', () => {
  it('lists resolved usages grouped by file, then possible unresolved ones', () => {
    const r = refs(s.store, { target: 'RefundService.computeRefund' }, ctx);
    const out = r.text.split('\n');
    expect(out[0]).toMatch(new RegExp(`^refs ${hd('RefundService.computeRefund')} RefundService.computeRefund · 4 usages in 3 files · 1 possible · ~\\d+ tok$`));
    expect(r.text).toContain(`${J}/api/RefundController.java: L25 in ${hd('RefundController.preview')} RefundController.preview`);
    expect(r.text).toContain(`${RS}: L31 in ${hd('RefundService.approveRefund')} RefundService.approveRefund`);
    expect(r.text).toContain('possible (unresolved refs named computeRefund):');
    expect(r.text).toContain(`? ${J}/jobs/BillingJob.java: L21 in ${hd('BillingJob.retry')} BillingJob.retry`);
    // Test files come after production files.
    expect(r.text.indexOf('RefundServiceTest.java')).toBeGreaterThan(r.text.indexOf('RefundController.java'));
    expect(r.text.indexOf('RefundServiceTest.java')).toBeLessThan(r.text.indexOf('possible ('));
  });

  it('lists callees with handles (out)', () => {
    const r = refs(s.store, { target: hd('RefundService.computeRefund'), direction: 'out' }, ctx);
    expect(r.text.split('\n')[0]).toMatch(/^refs out #\w+ RefundService\.computeRefund · 4 callees \(2 resolved\)/);
    expect(r.text).toContain(`${J}/billing/RefundPolicy.java: ${hd('RefundPolicy.maxRefundFor')} RefundPolicy.maxRefundFor`);
    expect(r.text).toContain(`${hd('RefundService.validateRequest')} RefundService.validateRequest`);
    expect(r.text).toContain('unresolved/external: request.amount, requested.compareTo');
    const cls = refs(s.store, { target: 'RefundService', direction: 'out' }, ctx);
    expect(cls.text).toContain(`${hd('LedgerClient.record')} LedgerClient.record`);
    expect(cls.text).not.toContain(`${hd('RefundService.computeRefund')} RefundService.computeRefund`);
  });

  it('aggregates callers of callers at depth 2', () => {
    const r = refs(s.store, { target: 'RefundService.computeRefund', depth: 2 }, ctx);
    expect(r.text.split('\n')[0]).toMatch(/^impact #\w+ RefundService\.computeRefund · 5 usages in 3 files \(depth 2: 4 direct, 1 indirect\)/);
    expect(r.text).toContain('direct:\n');
    expect(r.text).toContain(`indirect (callers of callers):\n${J}/api/RefundController.java: 1 ref · ${hd('RefundController.refund')} RefundController.refund`);
    const job = refs(s.store, { target: 'RefundService.approveRefund', depth: 2 }, ctx);
    expect(job.text).toContain(`${J}/jobs/BillingJob.java: 1 ref · ${hd('BillingJob.run')} BillingJob.run`);
  });

  it('supports both directions, classes (via constructors) and files', () => {
    const both = refs(s.store, { target: 'RefundService.computeRefund', direction: 'both' }, ctx);
    expect(both.text).toMatch(/^in:$/m);
    expect(both.text).toMatch(/^out:$/m);
    const cls = refs(s.store, { target: 'RefundService' }, ctx);
    expect(cls.text).toContain(`L9 new in ${hd('RefundServiceTest.service')}`);
    expect(cls.text).toContain(`${J}/api/RefundController.java: L6 import`);
    const file = refs(s.store, { target: `${J}/billing/Order.java`, direction: 'both' }, ctx);
    expect(file.text.split('\n')[0]).toMatch(/· 6 using files · 0 imports/);
    expect(file.text).toContain(`${J}/billing/RefundPolicy.java (3 refs)`);
    expect(file.text).toContain(`${J}/api/OrderRepository.java (import)`);
  });

  it('groups repeated usages by caller', () => {
    const r = refs(s.store, { target: 'step01' }, ctx);
    expect(r.text).toMatch(new RegExp(`L\\d+,L\\d+,L\\d+,L\\d+ in ${hd('LegacyBillingEngine.reconcileAll')} LegacyBillingEngine\\.reconcileAll`));
  });

  it('handles misses, ambiguity and budgets', () => {
    expect(refs(s.store, { target: 'computeRefunds' }, ctx).text).toMatch(/^no symbol matches "computeRefunds"; did you mean/);
    expect(refs(s.store, { target: 'validateRequest' }, ctx).text).toMatch(/next: kopt_refs #/);
    expect(refs(s.store, { target: 'Order', direction: 'sideways' as never }, ctx).text).toMatch(/unknown direction/);
    for (const maxTokens of [10, 40, 100, 300, 900]) {
      for (const direction of ['in', 'out', 'both'] as const) {
        for (const depth of [1, 2] as const) expectValid(refs(s.store, { target: 'Order.getTotal', direction, depth, maxTokens }, ctx), maxTokens);
      }
    }
  });
});

describe('robustness', () => {
  it('turns store failures into one-line answers', () => {
    const broken = seedStore();
    broken.store.close();
    try {
      const c = newToolContext(defaultConfig(broken.root));
      expect(find(broken.store, { query: 'refund' }, c).text).toMatch(/^find failed: /);
      expect(read(broken.store, { target: 'Order' }, c).text).toMatch(/^read failed: /);
      expect(outline(broken.store, { path: '' }, c).text).toMatch(/^outline failed: /);
      expect(refs(broken.store, { target: 'Order' }, c).text).toMatch(/^refs failed: /);
    } finally {
      broken.cleanup();
    }
  });
});

describe('resolveTarget', () => {
  it('classifies targets', () => {
    expect(resolveTarget(s.store, hd('Order')).kind).toBe('symbol');
    expect(resolveTarget(s.store, `${RS}:1-5`)).toMatchObject({ kind: 'range', path: RS, start: 1, end: 5 });
    expect(resolveTarget(s.store, RS)).toMatchObject({ kind: 'file', path: RS });
    expect(resolveTarget(s.store, join(s.root, RS))).toMatchObject({ kind: 'file', path: RS });
    expect(resolveTarget(s.store, 'web/src')).toMatchObject({ kind: 'dir', path: 'web/src' });
    expect(resolveTarget(s.store, 'Order.getTotal')).toMatchObject({ kind: 'symbol', symbol: { id: s.ids['Order.getTotal'] } });
    expect(resolveTarget(s.store, 'validateRequest').kind).toBe('ambiguous');
    expect(resolveTarget(s.store, 'Nope').kind).toBe('none');
    expect(resolveTarget(s.store, 'refunds.computeRefundPreview')).toMatchObject({ kind: 'symbol', symbol: { id: s.ids['computeRefundPreview'] } });
    // Members are found through their (case-insensitive) qualifier, even for common names.
    expect(resolveTarget(s.store, 'order.getid')).toMatchObject({ kind: 'symbol', symbol: { id: s.ids['Order.getId'] } });
    expect(resolveTarget(s.store, 'ApiClient.get')).toMatchObject({ kind: 'symbol', symbol: { id: s.ids['ApiClient.get'] } });
  });
});
