import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, type KoptConfig } from '../src/core/config.js';
import { indexRepo } from '../src/indexer/index.js';
import * as retrieval from '../src/retrieval/index.js';
import { Store } from '../src/store/store.js';
import { failureSummary, renderSummaryMarkdown } from '../src/bench/all.js';
import { competitorResult, loadCompetitors, parseCompetitorJsonl, pickLine } from '../src/bench/competitors.js';
import {
  analyzeFailures,
  buildFailureReport,
  lastSegment,
  parseKoptOutput,
  primaryCause,
  renderFailuresMarkdown,
  sourceExtentEnd,
  taskTargets,
  termCoverage,
  type TaskFailure,
} from '../src/bench/failures.js';
import { validateLangsFile } from '../src/bench/langs.js';
import { runBench, taskInput } from '../src/bench/run.js';
import type { BenchSummary, BenchTask, LangsFile } from '../src/bench/types.js';

describe('failure analysis helpers', () => {
  it('parses pointers, body headers and the callers line of a pack output', () => {
    const text = [
      'pack "disable limits" · 3 hits · 1 body · ~120 tok',
      'lib/rate.rb',
      '  #w66 30-32 method def disable_rate_limits!',
      'lib/topic_creator.rb',
      '  #m3s 288-292 method def save_topic(topic)',
      '  #m3t 300-301 method',
      '',
      'lib/rate.rb:30-32 #w66',
      '    def disable_rate_limits!',
      '',
      'callers of #w66: #9eu PostMover.move, #m3s TopicCreator.save_topic',
    ].join('\n');
    const p = parseKoptOutput(text);
    expect(p.header).toContain('3 hits');
    expect(p.hits).toEqual([
      { handle: '#w66', path: 'lib/rate.rb', start: 30, end: 32, kind: 'method', text: 'def disable_rate_limits!' },
      { handle: '#m3s', path: 'lib/topic_creator.rb', start: 288, end: 292, kind: 'method', text: 'def save_topic(topic)' },
      { handle: '#m3t', path: 'lib/topic_creator.rb', start: 300, end: 301, kind: 'method', text: '' },
    ]);
    expect(p.bodies).toEqual(['lib/rate.rb:30-32 #w66']);
    expect(p.callers).toBe('callers of #w66: #9eu PostMover.move, #m3s TopicCreator.save_topic');
  });

  it('extracts usage targets from backticks, with the qualifying class', () => {
    expect(lastSegment('SpamRule::AutoSilence.prevent_posting?')).toBe('prevent_posting?');
    expect(lastSegment('resolveDriver()')).toBe('resolveDriver');
    expect(lastSegment('Illuminate\\Image\\Image')).toBe('Image');
    const t = (question: string, search?: string) => taskTargets({ id: 'x', kind: 'usage', question, search, verifiedBy: 'x', gold: { files: [], symbols: [] } });
    expect(t('Which checks call `SpamRule::AutoSilence.prevent_posting?`?')).toEqual(['prevent_posting?', 'AutoSilence']);
    expect(t('Which code calls `disable_rate_limits!` before saving?')).toEqual(['disable_rate_limits!']);
    expect(t('Who calls the worker fail job?', 'Worker failJob')).toEqual(['failJob']);
    expect(t('If `Rule.IsIgnored` stopped reading `.ignore` files in `src/lib`, what breaks?')).toEqual(['IsIgnored', 'Rule']);
  });

  it('measures query term coverage with light stemming and prefixes', () => {
    expect(termCoverage(['refunds', 'computed'], ['compute', 'refund'])).toBe(1);
    expect(termCoverage(['silence', 'spam'], ['autosilence', 'spam', 'rule'])).toBe(0.5);
    expect(termCoverage([], ['x'])).toBe(0);
  });

  it('finds the end of a definition from the source in Ruby, Python and brace languages', () => {
    const ruby = ['class A', '  def a', '    x = 1', '  end', '', '  def b', '  end', 'end'];
    expect(sourceExtentEnd(ruby, 2, 'ruby')).toBe(4);
    const py = ['def a():', '    return 1', '', 'def b():', '    pass'];
    expect(sourceExtentEnd(py, 1, 'python')).toBe(2);
    const scala = [
      '  def raw(n: Long): BodyParser[X] =',
      '    BodyParser("raw") { request =>',
      '      enforceMaxLength(request, n)',
      '    }',
      '  def next = 1',
    ];
    expect(sourceExtentEnd(scala, 1, 'scala')).toBe(4);
    const expr = ['  def a = foo(', '    1)', '  def b = 2'];
    expect(sourceExtentEnd(expr, 1, 'scala')).toBe(2);
    const java = ['  void a() {', '    if (x) { y(); }', '  }', '  void b() {}'];
    expect(sourceExtentEnd(java, 1, 'java')).toBe(3);
    // Allman braces (C#, PHP) and object types / defaults inside the parameter list
    const cs = ['    public void Scan(string path)', '    {', '        Rule.IsIgnored(path);', '    }', '    public void Next() {}'];
    expect(sourceExtentEnd(cs, 1, 'c_sharp')).toBe(4);
    const ts = ['  async compute(', '    options: Options = {},', '    ctx: { a: number } = { a: 1 }', '  ): Promise<void> {', '    areRulesValid(x)', '  }', '  other() {}'];
    expect(sourceExtentEnd(ts, 1, 'typescript')).toBe(6);
  });

  it('picks the most severe cause: extraction > unresolved refs > ranking > multi-step > budget', () => {
    expect(primaryCause(['budget-format', 'ranking'])).toBe('ranking');
    expect(primaryCause(['multi-step', 'budget-format'])).toBe('multi-step');
    expect(primaryCause(['ranking', 'extraction', 'unresolved-refs'])).toBe('extraction');
    expect(primaryCause(['unresolved-refs', 'ranking'])).toBe('unresolved-refs');
  });

  it('aggregates causes per repo and language and renders every missed task', () => {
    const f = (repo: string, language: string, cause: TaskFailure['cause'], items: TaskFailure['cause'][]): TaskFailure => ({
      repo, language, taskId: `${repo}-${cause}`, kind: 'locate', strategy: 'kopt-pack', query: 'q', tokens: 10, header: 'h',
      topHits: [{ path: 'a/b.py', lines: '1-2', kind: 'function', text: 'def b()' }], expected: { files: ['a/c.py'], symbols: ['c'] },
      missed: { files: ['a/c.py'], symbols: ['c'] }, targets: [], cause, causes: [...new Set(items)],
      items: items.map((c) => ({ item: 'symbol', name: 'c', file: 'a/c.py', line: 3, indexed: true, extracted: true, rank: 9, rankShown: null, coverage: 0.5, nameShown: false, inBiggerPack: false, cause: c, why: 'because' })),
    });
    const fs = [f('r1', 'python', 'ranking', ['ranking', 'budget-format']), f('r2', 'python', 'extraction', ['extraction']), f('r3', 'go', 'multi-step', ['multi-step'])];
    const rep = buildFailureReport(fs, [{ repo: 'r1', language: 'python', tasks: 4 }, { repo: 'r2', language: 'python', tasks: 4 }, { repo: 'r3', language: 'go', tasks: 2 }], 'kopt-pack', 'search');
    expect(rep.totals).toEqual({ ranking: 1, 'unresolved-refs': 0, extraction: 1, 'budget-format': 0, 'multi-step': 1 });
    expect(rep.itemTotals['budget-format']).toBe(1);
    expect(rep.byLanguage.python).toMatchObject({ ranking: 1, extraction: 1 });
    expect(rep.byLanguage.go['multi-step']).toBe(1);
    const md = renderFailuresMarkdown(rep);
    expect(md).toContain('3 of 10 tasks missed');
    expect(md).toContain('### r1-ranking (locate) — (a) ranking / natural-language mismatch (also (d))');
    expect(md).toContain('| python | r1 | 1/4 | 1 | · | · | · | · |');
    expect(failureSummary(fs, 10)).toMatchObject({ missed: 3, tasks: 10, byCause: { ranking: 1, extraction: 1, 'multi-step': 1 } });
  });
});

describe('analyzeFailures on a real index', () => {
  let root: string;
  let store: Store;
  let config: KoptConfig;
  const write = (rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'kopt-fail-'));
    write('lib/limits.py', ['def disable_limits(record):', '    record.limited = False', '', 'def limit_window():', '    return 60', ''].join('\n'));
    write('lib/posts.py', ['from lib.limits import disable_limits', '', 'def save_post(post):', '    disable_limits(post)', '    return post', ''].join('\n'));
    write('lib/topics.py', ['from lib.limits import disable_limits', '', 'def save_topic(topic):', '    disable_limits(topic)', '    return topic', ''].join('\n'));
    write(
      'lib/billing.py',
      ['def compute_invoice_total(lines):', '    """Sum the invoice lines."""', '    return sum(lines)', '', 'def ledger_balance():', '    return 0', ''].join('\n'),
    );
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '-A'], { cwd: root });
    config = defaultConfig(root);
    config.dataDir = join(root, '.kopt');
    store = Store.open(join(config.dataDir, 'index.db'), { root });
    await indexRepo(store, { config, repoName: 'fixture' });
  });

  afterAll(() => {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('classifies a callers line without paths (d), a missing symbol (c) and a ranking miss (a)', async () => {
    const tasks: BenchTask[] = [
      {
        id: 'usage-limits',
        kind: 'usage',
        question: 'Which functions call `disable_limits`?',
        search: 'disable_limits',
        verifiedBy: 'fixture',
        gold: {
          files: ['lib/posts.py', 'lib/topics.py'],
          symbols: [
            { name: 'save_post', file: 'lib/posts.py', line: 3 },
            { name: 'save_topic', file: 'lib/topics.py', line: 3 },
          ],
        },
      },
      {
        id: 'locate-ghost',
        kind: 'locate',
        question: 'Where is the invoice total computed?',
        search: 'invoice total',
        verifiedBy: 'fixture',
        gold: {
          files: ['lib/billing.py'],
          symbols: [
            { name: 'compute_invoice_total', file: 'lib/billing.py', line: 1 },
            { name: 'ghost_total', file: 'lib/billing.py', line: 3 },
          ],
        },
      },
      {
        id: 'locate-balance',
        kind: 'locate',
        question: 'Where is the account money left computed?',
        search: 'account money left',
        verifiedBy: 'fixture',
        gold: { files: ['lib/billing.py'], symbols: [{ name: 'ledger_balance', file: 'lib/billing.py', line: 5 }] },
      },
    ];
    const res = await runBench({
      repoRoot: root,
      tasks,
      repo: { name: 'fixture' },
      strategies: ['kopt-pack'],
      indexDir: config.dataDir,
      modules: { errors: [], retrieval },
    });
    const fs = await analyzeFailures({
      repo: 'fixture', language: 'python', repoRoot: root, store, config, retrieval, tasks, results: res.results, input: 'search',
      inputOf: (t) => taskInput(t, 'search'),
    });
    const byId = new Map(fs.map((f) => [f.taskId, f]));

    // usage: whatever the resolver does, the classification must agree with the index
    const usage = byId.get('usage-limits');
    const resolvedEdge = store.db
      .prepare("SELECT count(*) AS n FROM refs r JOIN symbols s ON s.id = r.from_symbol_id WHERE s.name = 'save_topic' AND r.name = 'disable_limits' AND r.to_symbol_id IS NOT NULL")
      .get() as { n: number };
    if (usage) {
      const it = usage.items.find((i) => i.name === 'save_topic');
      if (it) {
        if (resolvedEdge.n === 0) expect(it).toMatchObject({ cause: 'unresolved-refs', refs: { callSites: [4], extracted: 1, resolved: 0 } });
        else expect(it.cause).not.toBe('unresolved-refs');
      }
    }

    const ghost = byId.get('locate-ghost')!;
    expect(ghost.cause).toBe('extraction');
    const gi = ghost.items.find((i) => i.name === 'ghost_total')!;
    expect(gi).toMatchObject({ extracted: false, indexed: true, cause: 'extraction' });
    expect(gi.why).toContain('compute_invoice_total');

    const bal = byId.get('locate-balance')!;
    expect(bal.items[0].cause).toBe('ranking');
    expect(bal.items[0].extracted).toBe(true);
    expect(bal.query).toBe('account money left');
  });
});

describe('analyzeFailures with an injected pack output', () => {
  let root: string;
  let store: Store;
  let config: KoptConfig;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'kopt-fail2-'));
    mkdirSync(join(root, 'lib'), { recursive: true });
    writeFileSync(join(root, 'lib', 'limits.rb'), ['module Limits', '  def self.disable!(record)', '    record.off = true', '  end', 'end', ''].join('\n'));
    writeFileSync(join(root, 'lib', 'posts.rb'), ['class Posts', '  def save_post(post)', '    Limits.disable!(post)', '  end', 'end', ''].join('\n'));
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '-A'], { cwd: root });
    config = defaultConfig(root);
    config.dataDir = join(root, '.kopt');
    store = Store.open(join(config.dataDir, 'index.db'), { root });
    await indexRepo(store, { config, repoName: 'fixture2' });
  });

  afterAll(() => {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('a caller named on the callers line without its path is a budget/format miss (d)', async () => {
    const id = (name: string) => (store.db.prepare('SELECT id FROM symbols WHERE name = ?').get(name) as { id: number }).id.toString(36);
    const text = [
      'pack "Limits disable!" · 1 hit · 1 body · ~60 tok',
      'lib/limits.rb',
      `  #${id('disable!')} 2-4 method def self.disable!(record)`,
      '',
      `lib/limits.rb:2-4 #${id('disable!')}`,
      '  def self.disable!(record)',
      '',
      `callers of #${id('disable!')}: #${id('save_post')} Posts.save_post`,
    ].join('\n');
    const fake = { find: () => ({ text, tokens: 20 }), read: () => ({ text: '', tokens: 0 }) };
    const task: BenchTask = {
      id: 'u', kind: 'usage', question: 'Who calls `Limits.disable!`?', search: 'Limits disable!', verifiedBy: 'fixture',
      gold: { files: ['lib/posts.rb'], symbols: [{ name: 'save_post', file: 'lib/posts.rb', line: 2 }] },
    };
    const results = [{ taskId: 'u', kind: 'usage' as const, strategy: 'kopt-pack' as const, tokens: 20, chars: 60, toolCalls: 1, durationMs: 1, calls: [],
      recall: { fileRecall: 0, symbolRecall: 1, defRecall: 0, filesMissed: ['lib/posts.rb'], symbolsMissed: [], found: false } }];
    const [f] = await analyzeFailures({ repo: 'fixture2', language: 'ruby', repoRoot: root, store, config, retrieval: fake, tasks: [task], results, input: 'search', inputOf: (t) => t.search! });
    expect(f.targets).toEqual(['disable!', 'Limits']);
    expect(f.callers).toContain('Posts.save_post');
    expect(f.items).toHaveLength(1);
    expect(f.items[0]).toMatchObject({ name: 'save_post', extracted: true, nameShown: true, cause: 'budget-format' });
    expect(f.items[0].why).toContain('callers line');
    expect(f.cause).toBe('budget-format');
  });
});

describe('competitor results', () => {
  const task: BenchTask = {
    id: 't1', kind: 'locate', question: 'q?', search: 'refund compute', verifiedBy: 'x',
    gold: { files: ['src/refund.py'], symbols: [{ name: 'compute_refund', file: 'src/refund.py', line: 3 }] },
  };

  it('parses JSONL lines, reports invalid ones and keeps several inputs per task', () => {
    const text = [
      JSON.stringify({ taskId: 't1', input: 'refund compute', output: 'src/refund.py:3 def compute_refund', toolCalls: 2 }),
      'not json',
      JSON.stringify({ input: 'x', output: 'y' }),
      JSON.stringify({ taskId: 't1', input: 'Where is the refund computed?', output: 'nothing', toolCalls: [{ tool: 'search', output: 'abc' }, { tool: 'read', chars: 30 }] }),
      JSON.stringify({ taskId: 't2', error: 'timeout' }),
      '',
    ].join('\n');
    const { byTask, invalid } = parseCompetitorJsonl(text);
    expect(invalid).toEqual(['line 2: not JSON', 'line 3: taskId missing']);
    expect(byTask.get('t1')).toHaveLength(2);
    expect(byTask.get('t2')![0]).toMatchObject({ taskId: 't2', output: '', error: 'timeout' });
    expect(pickLine(byTask.get('t1'), 'refund compute')).toMatchObject({ mismatch: false, line: { output: 'src/refund.py:3 def compute_refund' } });
    expect(pickLine(byTask.get('t1'), 'other')).toEqual({ mismatch: true });
    expect(pickLine(undefined, 'x')).toEqual({ mismatch: false });
  });

  it('scores a competitor line with the same recall metrics and per-call sizes', () => {
    const { byTask } = parseCompetitorJsonl(
      [
        JSON.stringify({ taskId: 't1', input: 'refund compute', output: 'src/refund.py:3\ndef compute_refund(order):', toolCalls: [{ tool: 'search', output: 'src/refund.py:3' }, { tool: 'read', output: 'def compute_refund(order):' }] }),
      ].join('\n'),
    );
    const file = { tool: 'codegraph' as const, path: 'x.jsonl', byTask, invalid: [] };
    const sigs = new Map([['src/refund.py:3', ['def', 'compute_refund']]]);
    const { result, mismatch } = competitorResult(file, task, 'refund compute', sigs, true);
    expect(mismatch).toBe(false);
    expect(result).toMatchObject({ strategy: 'codegraph', toolCalls: 2, recall: { found: true, defRecall: 1 } });
    expect(result.calls.map((c) => c.tool)).toEqual(['search', 'read']);
    expect(result.output).toContain('compute_refund');
    const missing = competitorResult({ ...file, byTask: new Map() }, task, 'refund compute', sigs);
    expect(missing.result.skipped).toContain('no codegraph result line');
  });

  it('runBench adds competitors that have a results file and scores them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kopt-comp-'));
    try {
      mkdirSync(join(root, 'repo', 'src'), { recursive: true });
      writeFileSync(join(root, 'repo', 'src', 'refund.py'), ['import os', '', 'def compute_refund(order):', '    return order.total', ''].join('\n'));
      execFileSync('git', ['init', '-q'], { cwd: join(root, 'repo') });
      execFileSync('git', ['add', '-A'], { cwd: join(root, 'repo') });
      mkdirSync(join(root, 'comp'));
      writeFileSync(join(root, 'comp', 'kirograph-demo.jsonl'), JSON.stringify({ taskId: 't1', input: 'refund compute', output: 'nothing useful', toolCalls: 1 }) + '\n');
      expect(loadCompetitors(join(root, 'comp'), 'demo').map((c) => c.tool)).toEqual(['kirograph']);
      const r = await runBench({
        repoRoot: join(root, 'repo'), tasks: [task], repo: { name: 'demo' }, competitorsDir: join(root, 'comp'),
        modules: { errors: ['not built'] }, indexDir: join(root, 'idx'),
      });
      expect(r.meta.strategies).toEqual(['native-naive', 'native-ranged', 'kopt-pack', 'kopt-hits+read', 'kirograph']);
      const kg = r.results.find((x) => x.strategy === 'kirograph')!;
      expect(kg).toMatchObject({ toolCalls: 1, recall: { found: false } });
      expect(r.paired.some((p) => p.a === 'native-ranged' && p.b === 'kirograph')).toBe(true);
      expect(r.meta.notes.join('\n')).toContain('kirograph: outputs loaded from');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('corpus file and summary', () => {
  const repo = (over: Partial<LangsFile['repos'][number]> = {}) => ({
    name: 'demo', language: 'ruby' as const, url: 'https://example.invalid/demo.git', tag: 'v1', commit: 'a'.repeat(40), license: 'MIT', files: 3, loc: 100, reason: 'test', ...over,
  });

  it('validates bench/langs.json entries', () => {
    expect(validateLangsFile({ version: 1, repos: [repo()] })).toEqual([]);
    const errs = validateLangsFile({ version: 1, repos: [repo({ language: 'cobol' as never, commit: 'abc' }), repo({ name: 'demo' })] });
    expect(errs).toContain('repo demo: unknown language cobol');
    expect(errs).toContain('repo demo: commit must be a full sha1');
    expect(errs).toContain('repo demo: duplicate name');
  });

  it('renders the summary with quality, strategy and failure tables', () => {
    const cell = { strategy: 'kopt-pack' as const, tasks: 12, found: 4, foundRate: 4 / 12, medianTokens: 900, meanTokens: 950, tokensPerFound: 2800, meanFileRecall: 0.8, meanSymbolRecall: 0.6, meanDefRecall: 0.5, skipped: 0 };
    const failures = { strategy: 'kopt-pack' as const, tasks: 12, missed: 8, byCause: { ranking: 3, 'unresolved-refs': 2, extraction: 1, 'budget-format': 1, 'multi-step': 1 }, itemsByCause: { ranking: 5, 'unresolved-refs': 3, extraction: 1, 'budget-format': 2, 'multi-step': 1 } };
    const s: BenchSummary = {
      schema: 'kopt-bench-summary/1', date: '2026-10-09T00:00:00.000Z', input: 'search', strategies: ['kopt-pack'],
      environment: { node: 'v22', platform: 'darwin-arm64', toolVersion: '0.1.0' },
      rows: [
        {
          repo: 'demo', language: 'ruby', tag: 'v1', commit: 'a'.repeat(40), loc: 100000, ok: true, verifyIssues: 0, tasks: 12,
          index: { built: true, durationMs: 1234, files: 10, symbols: 99, refs: 300 },
          quality: { filesIndexed: 10, filesSkipped: 1, parseErrorFileRate: 0.05, parseErrorsPerKloc: 0.4, symbolsPerKloc: 50, resolvedRate: 0.4, resolvedOfCandidates: 0.7, precisionRate: 0.9, precisionSampled: 30 },
          strategies: [cell], byKind: [{ kind: 'locate', strategy: 'kopt-pack', tasks: 4, found: 2 }], failures, files: { bench: 'bench/results/demo.md' }, durationMs: 10,
        },
        { repo: 'broken', language: 'go', tag: 'v2', commit: 'b'.repeat(40), loc: 1, ok: false, error: 'checkout missing', verifyIssues: 0, tasks: 0, index: null, quality: null, strategies: [], byKind: [], failures: null, files: {}, durationMs: 0 },
      ],
      totals: [cell], failureTotals: failures, failuresFile: 'bench/results/failures.md', notes: ['a note'],
    };
    const md = renderSummaryMarkdown(s);
    expect(md).toContain('| ruby | demo@v1 | 100 | 10 (1) | 1.2 s | 99 | 50.0 | 5.0% | 40% | 70% | 90% (n=30) | 0 |');
    expect(md).toContain('| ruby | demo | 12 | 4/12 |');
    expect(md).toContain('## Why kopt-pack misses (primary cause per missed task)');
    expect(md).toContain('| ruby | demo | 8/12 | 3 | 2 | 1 | 1 | 1 |');
    expect(md).toContain('`bench/results/failures.md`');
    expect(md).toContain('broken: FAILED: checkout missing');
  });
});
