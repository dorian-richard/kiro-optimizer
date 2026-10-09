import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { estimateTokens } from '../src/core/tokens.js';
import { grepKeywords, isTestPath, nativeGrep } from '../src/bench/grep.js';
import { aggregate, compare, computeRecall, defSignature, median, mentionsName, mentionsPath, percentile } from '../src/bench/metrics.js';
import { renderMarkdown, writeResults } from '../src/bench/report.js';
import { extractTargets, nativeNaive, nativeRanged, pickWindows, topVisibleFiles, type KoptModules } from '../src/bench/strategies.js';
import { goldDefSignatures, validateTaskFile, verifyTasks } from '../src/bench/tasks.js';
import { runBench } from '../src/bench/index.js';
import type { BenchTask, TaskStrategyResult } from '../src/bench/types.js';

let root: string;

function write(rel: string, text: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kopt-bench-'));
  write(
    'src/orders/refund.py',
    [
      '"""Refund computation."""',
      '',
      'class RefundPolicy:',
      '    max_days = 30',
      '',
      '',
      'def compute_refund(order, policy):',
      '    """Return the refunded amount for an order."""',
      '    if order.age_days > policy.max_days:',
      '        return 0',
      '    return order.total',
      '',
    ].join('\n'),
  );
  write('src/orders/service.py', ['from .refund import compute_refund', '', 'def cancel(order):', '    return compute_refund(order, None)', ''].join('\n'));
  write(
    'src/java/RefundService.java',
    ['package demo;', '', 'public class RefundService {', '    @Override', '    public long computeRefund(Order order) {', '        return order.total();', '    }', '}', ''].join('\n'),
  );
  // big file: 2500 lines, keyword near the top and near the end
  const big = Array.from({ length: 2500 }, (_, i) => (i === 10 || i === 2400 ? `refund_ledger_entry = ${i}` : `line_${i} = ${i}`));
  write('src/ledger/big.py', big.join('\n'));
  // test file with many keyword matches: must rank after implementation files
  write('tests/test_refund.py', Array.from({ length: 40 }, (_, i) => `def test_refund_${i}(): compute_refund(None, None)  # refund`).join('\n'));
  // noise: 300 matching lines for cap tests
  write('docs/noise.txt', Array.from({ length: 300 }, (_, i) => `noise line ${i} ${'x'.repeat(60)}`).join('\n'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('grepKeywords', () => {
  it('keeps identifiers whole, drops EN/FR stopwords, identifiers first, dedupes', () => {
    expect(grepKeywords('Where is `compute_refund` computed? Où est le remboursement du Refund refund')).toEqual([
      'compute_refund',
      'computed',
      'remboursement',
      'refund',
    ]);
    expect(grepKeywords('OrderService.placeOrder HTTPClient')).toEqual(['OrderService', 'placeOrder', 'HTTPClient']);
    expect(grepKeywords('a b of the')).toEqual([]);
  });
});

describe('nativeGrep', () => {
  it('caps at maxMatches and maxChars like Kiro', () => {
    const g = nativeGrep(root, ['noise']);
    expect(g.visible.length).toBeLessThanOrEqual(100);
    expect(g.truncated).toBe(true);
    const body = g.text.split('\n').slice(1).join('\n');
    expect(body.length).toBeLessThanOrEqual(10_000);
    expect(g.text.split('\n')[0]).toMatch(/^Found 300 matches in 1 files \(showing first \d+\)$/);

    const small = nativeGrep(root, ['noise'], { maxMatches: 1000, maxChars: 500, maxLineChars: 250 });
    expect(small.text.split('\n').slice(1).join('\n').length).toBeLessThanOrEqual(500);
  });

  it('cuts long lines', () => {
    const g = nativeGrep(root, ['noise'], { maxMatches: 5, maxChars: 10_000, maxLineChars: 20 });
    expect(g.visible[0].text.length).toBeLessThanOrEqual(21);
    expect(g.visible[0].text.endsWith('…')).toBe(true);
  });

  it('greps the most selective keywords first and broadens while under the cap', () => {
    const g = nativeGrep(root, ['refund', 'compute_refund'], { maxMatches: 20, maxChars: 10_000, maxLineChars: 250 });
    // compute_refund is rarer; adding `refund` (60+ lines) would exceed 20 matches
    expect(g.keywords).toEqual(['compute_refund']);
    expect(g.candidates.find((c) => c.keyword === 'refund')!.matches).toBeGreaterThan(20);
    const wide = nativeGrep(root, ['refund', 'compute_refund']);
    expect(wide.keywords).toEqual(['refund', 'compute_refund']);
  });

  it('ranks implementation files before test files', () => {
    const g = nativeGrep(root, ['compute_refund']);
    expect(isTestPath('tests/test_refund.py')).toBe(true);
    expect(isTestPath('src/orders/refund.py')).toBe(false);
    const order = g.files.map((f) => f.path);
    expect(order.indexOf('src/orders/refund.py')).toBeLessThan(order.indexOf('tests/test_refund.py'));
    expect(order.indexOf('src/orders/service.py')).toBeLessThan(order.indexOf('tests/test_refund.py'));
    expect(g.visible[0].path).not.toBe('tests/test_refund.py');
  });

  it('reports no matches without throwing', () => {
    const g = nativeGrep(root, ['zzz_does_not_exist']);
    expect(g.text).toBe('No matches found');
    expect(g.visible).toEqual([]);
  });
});

describe('native strategies', () => {
  it('native-naive: grep + whole-file reads of the top 3 files, capped at 2000 lines', () => {
    const out = nativeNaive(root, 'refund ledger entry');
    expect(out.calls[0].tool).toBe('grep');
    const reads = out.calls.filter((c) => c.tool === 'read_file');
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.length).toBeLessThanOrEqual(3);
    const big = reads.find((c) => c.args === 'src/ledger/big.py');
    expect(big).toBeDefined();
    expect(out.text).toContain('[truncated: showing lines 1-2000 of 2500]');
    expect(out.text).not.toContain('line_2001 = 2001');
    for (const c of out.calls) expect(c.tokens).toBe(estimateTokens(c.chars ? 'x'.repeat(c.chars) : ''));
  });

  it('native-ranged: ±context windows around the best matches, overlaps merged', () => {
    const out = nativeRanged(root, 'refund ledger entry', { rangedContext: 5 });
    const reads = out.calls.filter((c) => c.tool === 'read_file');
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) expect(r.args).toMatch(/^[\w./-]+:\d+-\d+$/);
    const bigRead = reads.find((r) => r.args.startsWith('src/ledger/big.py:'));
    expect(bigRead?.args).toMatch(/^src\/ledger\/big\.py:(6-16|2396-2406)$/);
  });

  it('pickWindows merges overlapping windows of one file and clips to the file', () => {
    const visible = [
      { path: 'a.py', line: 10, text: 'def foo', terms: 1 },
      { path: 'a.py', line: 30, text: 'foo()', terms: 1 },
      { path: 'b.py', line: 3, text: 'foo', terms: 1 },
    ];
    const w = pickWindows(visible, 4, 15, (p) => (p === 'a.py' ? 100 : 5));
    expect(w).toEqual([
      { path: 'a.py', start: 1, end: 45 },
      { path: 'b.py', start: 1, end: 5 },
    ]);
  });

  it('topVisibleFiles orders by visible match count', () => {
    const v = [
      { path: 'x', line: 1, text: '', terms: 1 },
      { path: 'y', line: 1, text: '', terms: 1 },
      { path: 'y', line: 2, text: '', terms: 1 },
    ];
    expect(topVisibleFiles(v, 2)).toEqual(['y', 'x']);
  });

  it('extractTargets prefers handles, falls back to ranges, skips the header', () => {
    const text = ['find "refund" · 3 hits · ~90 tok', 'src/a.py:1-9 #3mv compute_refund(order)', 'src/b.py:4-8 cancel', 'src/a.py:1-9 #3mv dup'].join('\n');
    expect(extractTargets(text, 2)).toEqual(['#3mv', 'src/b.py:4-8']);
    expect(extractTargets('header #zz', 2)).toEqual([]);
  });
});

describe('recall metrics', () => {
  it('matches whole paths and whole identifiers only', () => {
    expect(mentionsPath('see src/a/b.py:10', 'src/a/b.py')).toBe(true);
    expect(mentionsPath('see x/src/a/b.py', 'src/a/b.py')).toBe(false);
    expect(mentionsPath('see src/a/b.pyc', 'src/a/b.py')).toBe(false);
    expect(mentionsPath('src/a/b.py.', 'src/a/b.py')).toBe(true);
    expect(mentionsName('compute_refund(x)', 'compute_refund')).toBe(true);
    expect(mentionsName('compute_refund_v2(x)', 'compute_refund')).toBe(false);
    expect(mentionsName('ComputeRefund', 'computeRefund')).toBe(false);
  });

  it('defSignature drops annotations and keeps the prefix up to the name', () => {
    expect(defSignature('    @Override public long computeRefund(Order o) {', 'computeRefund')).toEqual(['public', 'long', 'computeRefund']);
    expect(defSignature('def compute_refund(order, policy):', 'compute_refund')).toEqual(['def', 'compute_refund']);
    expect(defSignature('x = 1', 'compute_refund')).toBeUndefined();
  });

  it('computeRecall: files, names, definitions, found', () => {
    const gold: BenchTask['gold'] = {
      files: ['src/orders/refund.py', 'src/orders/service.py'],
      symbols: [
        { name: 'compute_refund', file: 'src/orders/refund.py', line: 7 },
        { name: 'cancel', file: 'src/orders/service.py', line: 3 },
      ],
    };
    const sigs = goldDefSignatures(root, [{ id: 't', kind: 'usage', question: 'q', verifiedBy: 'v', gold }]);
    // name mentioned at a call site only: name recall yes, def recall no
    const callOnly = computeRecall('src/orders/service.py:4:return compute_refund(order, None) cancel', gold, sigs);
    expect(callOnly.fileRecall).toBe(0.5);
    expect(callOnly.symbolRecall).toBe(1);
    expect(callOnly.defRecall).toBe(0);
    expect(callOnly.found).toBe(false);
    expect(callOnly.filesMissed).toEqual(['src/orders/refund.py']);
    const full = computeRecall('src/orders/refund.py:7\ndef compute_refund(order, policy):\nsrc/orders/service.py\ndef cancel(order):', gold, sigs);
    expect(full).toMatchObject({ fileRecall: 1, symbolRecall: 1, defRecall: 1, found: true });
  });
});

function res(taskId: string, strategy: TaskStrategyResult['strategy'], tokens: number, found: boolean, skipped?: string): TaskStrategyResult {
  return {
    taskId,
    kind: 'locate',
    strategy,
    tokens,
    chars: tokens * 3,
    toolCalls: 2,
    durationMs: 1,
    skipped,
    calls: [],
    recall: { fileRecall: found ? 1 : 0, symbolRecall: found ? 1 : 0.5, defRecall: 0, filesMissed: [], symbolsMissed: [], found },
  };
}

describe('aggregates', () => {
  it('median / percentile', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBe(0);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
  });

  it('aggregate counts skipped separately and charges failures to found tasks', () => {
    const rs = [res('a', 'native-naive', 100, true), res('b', 'native-naive', 300, false), res('c', 'native-naive', 0, false, 'missing')];
    const a = aggregate('native-naive', rs);
    expect(a).toMatchObject({ tasks: 2, skipped: 1, medianTokens: 200, meanTokens: 200, totalTokens: 400, found: 1, foundRate: 0.5, tokensPerFound: 400 });
    expect(a.meanSymbolRecall).toBe(0.75);
    expect(aggregate('kopt-pack', rs).tokensPerFound).toBeNull();
  });

  it('compare is pass-gated', () => {
    const rs = [
      res('a', 'native-naive', 1000, true),
      res('a', 'kopt-pack', 250, true),
      res('b', 'native-naive', 1000, true),
      res('b', 'kopt-pack', 2000, true),
      res('c', 'native-naive', 1000, false),
      res('c', 'kopt-pack', 10, true),
      res('d', 'native-naive', 1000, true),
      res('d', 'kopt-pack', 0, false, 'missing'),
    ];
    const p = compare('native-naive', 'kopt-pack', rs);
    expect(p).toMatchObject({ nRun: 3, nBoth: 2, onlyA: 0, onlyB: 1, bCheaper: 1 });
    expect(p.medianRatio).toBeCloseTo(1.125);
    expect(p.geoMeanRatio).toBeCloseTo(Math.sqrt(0.25 * 2));
  });
});

describe('task files', () => {
  const tasks: BenchTask[] = [
    {
      id: 'ok',
      kind: 'usage',
      question: 'who calls compute_refund?',
      verifiedBy: 'test',
      gold: { files: ['src/orders/refund.py', 'src/orders/service.py'], symbols: [{ name: 'cancel', file: 'src/orders/service.py', line: 3 }] },
    },
    {
      id: 'bad',
      kind: 'locate',
      question: 'where?',
      verifiedBy: 'test',
      gold: { files: ['src/nope.py'], symbols: [{ name: 'cancel', file: 'src/orders/service.py', line: 1 }] },
    },
  ];

  it('validates structure', () => {
    expect(validateTaskFile({ repo: { name: 'r' }, tasks })).toEqual([]);
    const problems = validateTaskFile({ repo: { name: '' }, tasks: [{ ...tasks[0], kind: 'other' as never }, tasks[0]] });
    expect(problems.join('\n')).toMatch(/repo.name/);
    expect(problems.join('\n')).toMatch(/kind must be/);
    expect(problems.join('\n')).toMatch(/duplicate id/);
  });

  it('verifyTasks checks files, definition lines and gold.files coverage', () => {
    const issues = verifyTasks(root, tasks);
    expect(issues.filter((i) => i.taskId === 'ok')).toEqual([]);
    const msgs = issues.filter((i) => i.taskId === 'bad').map((i) => i.message);
    expect(msgs.some((m) => m.includes('gold file missing: src/nope.py'))).toBe(true);
    expect(msgs.some((m) => m.includes('cancel not found at src/orders/service.py:1'))).toBe(true);
    expect(msgs.some((m) => m.includes('not listed in gold.files'))).toBe(true);
  });
});

describe('runBench', () => {
  const tasks: BenchTask[] = [
    {
      id: 'loc-refund',
      kind: 'locate',
      question: 'Where is the refund amount computed?',
      search: 'compute_refund',
      verifiedBy: 'test fixture',
      gold: { files: ['src/orders/refund.py'], symbols: [{ name: 'compute_refund', file: 'src/orders/refund.py', line: 7 }] },
    },
    {
      id: 'usage-refund',
      kind: 'usage',
      question: 'Who calls compute_refund?',
      search: 'compute_refund',
      verifiedBy: 'test fixture',
      gold: { files: ['src/orders/service.py'], symbols: [{ name: 'cancel', file: 'src/orders/service.py', line: 3 }] },
    },
  ];

  it('runs native strategies and skips kopt ones with a clear reason when modules are missing', async () => {
    const r = await runBench({
      repoRoot: root,
      tasks,
      repo: { name: 'fixture' },
      modules: { errors: ['../retrieval/index.js: not built'] },
      indexDir: join(root, '.idx-missing'),
    });
    expect(r.meta.strategies).toEqual(['native-naive', 'native-ranged', 'kopt-pack', 'kopt-hits+read']);
    const naive = r.results.filter((x) => x.strategy === 'native-naive');
    expect(naive).toHaveLength(2);
    expect(naive.every((x) => !x.skipped && x.tokens > 0)).toBe(true);
    expect(naive.find((x) => x.taskId === 'loc-refund')!.recall.found).toBe(true);
    const kopt = r.results.filter((x) => x.strategy.startsWith('kopt'));
    expect(kopt.every((x) => x.skipped?.includes('kopt retrieval module unavailable (../retrieval/index.js: not built)'))).toBe(true);
    expect(r.meta.notes.join('\n')).toContain('kopt strategies skipped');
    const agg = r.aggregates.find((a) => a.strategy === 'kopt-pack')!;
    expect(agg).toMatchObject({ tasks: 0, skipped: 2 });
    const md = renderMarkdown(r);
    expect(md).toContain('Skipped strategies: kopt-pack, kopt-hits+read');
    expect(md).toContain('| native-naive | 2 |');
  });

  it('counts a crashing strategy as a failed attempt, not a skip', async () => {
    const modules: KoptModules = {
      errors: [],
      indexer: { indexRepo: async () => ({ filesIndexed: 0, symbols: 0, durationMs: 0 }) },
      retrieval: {
        find() {
          throw new Error('boom');
        },
        read() {
          throw new Error('unreachable');
        },
      },
    };
    const r = await runBench({ repoRoot: root, tasks, strategies: ['kopt-pack'], modules, indexDir: join(root, '.idx-err') });
    expect(r.results.every((x) => x.error === 'boom' && !x.skipped && !x.recall.found)).toBe(true);
    expect(r.aggregates[0]).toMatchObject({ tasks: 2, skipped: 0, errors: 2, found: 0, tokensPerFound: null });
    expect(renderMarkdown(r)).toContain('ERROR (boom)');
  });

  it('drives kopt strategies through the retrieval contract (injected modules)', async () => {
    const calls: string[] = [];
    let indexed = 0;
    const modules: KoptModules = {
      errors: [],
      indexer: {
        async indexRepo() {
          indexed++;
          return { filesIndexed: 1, symbols: 1, durationMs: 1 };
        },
      },
      retrieval: {
        find(_store, p, ctx) {
          ctx.ledger.tick();
          calls.push(`find:${p.mode}:${p.query}`);
          const text =
            p.mode === 'pack'
              ? 'find "compute_refund" · 1 hits · ~40 tok\nsrc/orders/refund.py:7-11 #1 compute_refund\ndef compute_refund(order, policy):\n    return order.total'
              : 'find "compute_refund" · 2 hits · ~30 tok\nsrc/orders/refund.py:7-11 #1 def compute_refund(order, policy)\nsrc/orders/service.py:3-4 #2 def cancel(order)';
          return { text, tokens: estimateTokens(text) };
        },
        read(_store, p, ctx) {
          ctx.ledger.tick();
          calls.push(`read:${p.target}`);
          const text = p.target === '#2' ? 'src/orders/service.py:3-4\ndef cancel(order):\n    return compute_refund(order, None)' : 'src/orders/refund.py:7-11\ndef compute_refund(order, policy):';
          return { text, tokens: estimateTokens(text) };
        },
      },
    };
    const out = join(root, '.bench-out');
    const r = await runBench({
      repoRoot: root,
      tasks,
      repo: { name: 'fixture' },
      strategies: ['native-ranged', 'kopt-pack', 'kopt-hits+read'],
      modules,
      indexDir: join(root, '.idx'),
      keepOutputs: true,
      label: 'fixture-test',
    });
    expect(indexed).toBe(1);
    expect(r.meta.index?.built).toBe(true);
    expect(calls).toContain('find:pack:compute_refund');
    expect(calls).toContain('read:#1');
    expect(calls).toContain('read:#2');
    const hr = r.results.find((x) => x.taskId === 'usage-refund' && x.strategy === 'kopt-hits+read')!;
    expect(hr.toolCalls).toBe(3);
    expect(hr.recall.found).toBe(true);
    expect(hr.tokens).toBe(hr.calls.reduce((a, c) => a + c.tokens, 0));
    expect(r.paired.map((p) => `${p.b}/${p.a}`)).toEqual(['kopt-pack/native-ranged', 'kopt-hits+read/native-ranged']);

    const written = writeResults(r, out);
    expect(written.map((w) => basename(w))).toEqual(['fixture-test.md', 'fixture-test.json', 'fixture-test.raw.json']);
    const json = JSON.parse(readFileSync(join(out, 'fixture-test.json'), 'utf8'));
    expect(json.results[0].output).toBeUndefined();
    expect(JSON.parse(readFileSync(join(out, 'fixture-test.raw.json'), 'utf8'))[0].output).toBeTypeOf('string');
    expect(existsSync(join(root, '.idx', 'index.db'))).toBe(true);
  });
});
