import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/core/config.js';
import { newToolContext, type ToolContext } from '../src/core/context.js';
import type { ToolResult } from '../src/core/types.js';
import { joinedNames, parseQuery } from '../src/indexer/terms.js';
import { symbolHandle } from '../src/store/store.js';
import { isTestPath } from '../src/retrieval/common.js';
import { find, refs, setReextract } from '../src/retrieval/index.js';
import { pairInfixCandidates, selectFtsTerms } from '../src/retrieval/search.js';
import { Store } from '../src/store/store.js';
import { type FileSpec, type Seeded, seedStore } from './helpers/seed.js';

const hitHandles = (r: ToolResult) => [...r.text.matchAll(/^ {2}(#[0-9a-z]+) /gm)].map((m) => m[1]);

describe('query parsing', () => {
  it('keeps identifier-like stopwords as weak terms and the raw word order', () => {
    const q = parseQuery('get or create the queryset');
    expect(q.terms).toEqual(['create', 'queryset']);
    expect(q.weak).toEqual(['get', 'or']);
    expect(q.words).toEqual(['get', 'or', 'create', 'the', 'queryset']);
  });

  it('spells names from consecutive words, stopwords included', () => {
    const j = joinedNames(['get', 'or', 'create', 'queryset']);
    expect(j).toEqual(expect.arrayContaining(['getorcreate', 'get_or_create', 'createqueryset']));
    expect(joinedNames(['is', 'the'])).toEqual([]);
  });
});

describe('test and non-product paths', () => {
  it('demotes fixtures, sbt scripted tests, documentation snippets, examples and benchmarks', () => {
    for (const p of [
      'dev-mode/sbt-plugin/src/sbt-test/routes/app/controllers/Application.scala',
      'documentation/manual/working/javaGuide/main/http/code/javaguide/http/JavaActions.java',
      'packages/core/src/__fixtures__/order.ts',
      'spring-core/src/jmh/java/org/springframework/util/ConcurrentLruCacheBenchmark.java',
      'examples/code-splitting/webpack.config.js',
      'pkg/testdata/sample.go',
    ]) {
      expect(isTestPath(p), p).toBe(true);
    }
    expect(isTestPath('src/main/java/com/acme/billing/RefundService.java')).toBe(false);
    expect(isTestPath('lib/optimize/SplitChunksPlugin.js')).toBe(false);
  });
});

describe('ranking on the fixture', () => {
  let s: Seeded;
  let ctx: ToolContext;
  const hd = (key: string) => symbolHandle(s.ids[key]);
  beforeAll(() => {
    setReextract(false);
    s = seedStore();
  });
  afterAll(() => s.cleanup());
  beforeEach(() => {
    ctx = newToolContext(defaultConfig(s.root));
  });

  it('finds names whose parts are stopwords ("get total", "is paid")', () => {
    expect(hitHandles(find(s.store, { query: 'get total' }, ctx))[0]).toBe(hd('Order.getTotal'));
    expect(hitHandles(find(s.store, { query: 'is paid' }, ctx))[0]).toBe(hd('Order.isPaid'));
    expect(hitHandles(find(s.store, { query: 'get id of the order' }, ctx))[0]).toBe(hd('Order.getId'));
  });

  it('names the cut that applies in "+k more"', () => {
    const r = find(s.store, { query: 'refund', limit: 2 }, ctx);
    expect(r.text.split('\n')[0]).toMatch(/· \+\d+ more \(raise limit or narrow query\)$/);
  });

  it('pack: callers of the method the query names, not of its class, with path and line', () => {
    const r = find(s.store, { query: 'RefundService computeRefund', mode: 'pack' }, ctx);
    expect(r.text).toContain(`callers of ${hd('RefundService.computeRefund')} RefundService.computeRefund · 4 refs in 3 files · 1 unresolved same-name ref:`);
    expect(r.text).not.toMatch(new RegExp(`^callers of ${hd('RefundService')} `, 'm'));
    expect(r.text).toContain(`  src/main/java/com/acme/api/RefundController.java: L25 in ${hd('RefundController.preview')} RefundController.preview`);
    // Test callers: one summary line (which test files cover it).
    expect(r.text).toContain('  tests: src/test/java/com/acme/billing/RefundServiceTest.java (2)');
  });

  it('pack: one callers section per named identifier', () => {
    const r = find(s.store, { query: 'computeRefund rejectRefund', mode: 'pack' }, ctx);
    expect(r.text).toMatch(new RegExp(`^callers of ${hd('RefundService.computeRefund')} `, 'm'));
    expect(r.text).toMatch(new RegExp(`^callers of ${hd('RefundService.rejectRefund')} `, 'm'));
  });

  it('pack: never packs test bodies unless the query is about tests', () => {
    const r = find(s.store, { query: 'compute refund amount', mode: 'pack' }, ctx);
    expect(r.text).not.toMatch(/^src\/test\/java\/\S+:\d+-\d+ #/m);
    const t = find(s.store, { query: 'compute refund test', mode: 'pack' }, ctx);
    expect(t.text).toMatch(/^src\/test\/java\/\S+:\d+-\d+ #/m);
  });
});

// Compound names and interface/implementation families need their own small codebase.
const extra: FileSpec[] = [
  {
    path: 'db/query.py',
    lang: 'python',
    namespace: 'db.query',
    rank: 0.5,
    text: `class QuerySet:
    def create(self, **kwargs):
        return self.model(**kwargs)

    def get_or_create(self, defaults=None, **kwargs):
        return self.create(**kwargs)
`,
    symbols: [
      { key: 'QuerySet', kind: 'class', exported: true, at: 'class QuerySet' },
      { key: 'QuerySet.create', kind: 'method', exported: true, at: 'def create(' },
      { key: 'QuerySet.get_or_create', kind: 'method', exported: true, at: 'def get_or_create(' },
    ],
  },
  {
    path: 'src/spam/SpamRules.java',
    lang: 'java',
    namespace: 'spam',
    rank: 0.5,
    text: `package spam;

public class SpamRules {
    public boolean shouldAutosilence(User user) {
        return user.flags > 3;
    }

    public void notifyModerators(User user) {
        log(user);
    }
}
`,
    symbols: [
      { key: 'SpamRules', kind: 'class', exported: true },
      { key: 'SpamRules.shouldAutosilence', kind: 'method', exported: true },
      { key: 'SpamRules.notifyModerators', kind: 'method', exported: true },
    ],
  },
  {
    path: 'src/store/Store.java',
    lang: 'java',
    namespace: 'store',
    rank: 0.5,
    text: `package store;

public interface Store {
    void save(Item item);
}
`,
    symbols: [
      { key: 'Store', kind: 'interface', exported: true },
      { key: 'Store.save', kind: 'method', exported: true, at: 'void save(' },
    ],
  },
  {
    path: 'src/store/DbStore.java',
    lang: 'java',
    namespace: 'store',
    rank: 0.5,
    text: `package store;

public class DbStore implements Store {
    public void save(Item item) {
        insert(item);
    }
}
`,
    symbols: [
      { key: 'DbStore', kind: 'class', exported: true },
      { key: 'DbStore.save', kind: 'method', exported: true },
    ],
    refs: [{ from: 'DbStore', name: 'Store', kind: 'implement', to: 'Store', at: 'implements Store' }],
  },
  {
    path: 'src/app/Checkout.java',
    lang: 'java',
    namespace: 'app',
    rank: 0.5,
    text: `package app;

public class Checkout {
    private final Store store;

    public void complete(Item item) {
        store.save(item);
    }
}
`,
    symbols: [
      { key: 'Checkout', kind: 'class', exported: true },
      { key: 'Checkout.store', kind: 'field', at: 'Store store;' },
      { key: 'Checkout.complete', kind: 'method', exported: true },
    ],
    refs: [{ from: 'Checkout.complete', name: 'save', qualifier: 'store', to: 'Store.save', at: 'save(' }],
  },
];

describe('compounds and families', () => {
  let s: Seeded;
  let ctx: ToolContext;
  const hd = (key: string) => symbolHandle(s.ids[key]);
  beforeAll(() => {
    setReextract(false);
    s = seedStore({ specs: extra });
  });
  afterAll(() => s.cleanup());
  beforeEach(() => {
    ctx = newToolContext(defaultConfig(s.root));
  });

  it('matches a word inside a compound name (silence -> shouldAutosilence)', () => {
    expect(hitHandles(find(s.store, { query: 'auto silence' }, ctx))).toContain(hd('SpamRules.shouldAutosilence'));
    expect(hitHandles(find(s.store, { query: 'silence' }, ctx))).toContain(hd('SpamRules.shouldAutosilence'));
  });

  it('ranks a name spelled with stopwords above the shorter name it contains', () => {
    expect(hitHandles(find(s.store, { query: 'get or create queryset' }, ctx))[0]).toBe(hd('QuerySet.get_or_create'));
  });

  it('counts calls through the interface as callers of the implementation (pack and refs)', () => {
    const p = find(s.store, { query: 'DbStore.save', mode: 'pack' }, ctx);
    expect(p.text).toMatch(new RegExp(`callers of ${hd('DbStore.save')} DbStore\\.save \\(\\+1 related decl\\) · 1 ref in 1 file · (complete|\\d+ unresolved same-name refs?):`));
    expect(p.text).toContain(`  src/app/Checkout.java: L7 in ${hd('Checkout.complete')} Checkout.complete`);
    const r = refs(s.store, { target: 'DbStore.save' }, ctx);
    expect(r.text).toContain(`src/app/Checkout.java:7 in ${hd('Checkout.complete')} Checkout.complete`);
  });
});

describe('names holding two query words joined', () => {
  it('finds a longer name spelled by two consecutive words, never by two stopwords', () => {
    const s = seedStore();
    try {
      const names = (words: string[]) => pairInfixCandidates(s.store, words).map((r) => r.name);
      expect(names(['how', 'is', 'the', 'refund', 'preview', 'computed'])).toContain('computeRefundPreview');
      expect(names(['legacy', 'billing', 'engine'])).toContain('LegacyBillingEngine');
      // short pairs and pairs of stopwords are not searched (a full scan of the names each)
      expect(names(['is', 'the'])).toEqual([]);
      expect(names(['get', 'id'])).toEqual([]);
    } finally {
      s.cleanup();
    }
  });
});

describe('dubious callee resolutions', () => {
  it('flags a receiver that names nothing like the target in another top-level folder', async () => {
    const { dubiousCall } = await import('../src/retrieval/usage.js');
    expect(dubiousCall('authorizations', 'app/models/mcp_oauth_authorization.rb', 'lib/nested_replies/post_preloader.rb', 'PostsArray.where')).toBe(true);
    expect(dubiousCall('policy', 'src/billing/RefundService.java', 'lib/policy/RefundPolicy.java', 'billing.RefundPolicy.maxRefundFor')).toBe(false);
    expect(dubiousCall('ledgers', 'app/a.rb', 'lib/ledger.rb', 'Ledger.record')).toBe(false);
    expect(dubiousCall('p', 'services/a.go', 'modules/egress/policy.go', 'policy.Policy.NewHTTPTransport')).toBe(false);
    expect(dubiousCall('repo', 'app/a.rb', 'app/b.rb', 'Other.save')).toBe(false);
    expect(dubiousCall(null, 'app/a.rb', 'lib/b.rb', 'B.c')).toBe(false);
  });
});

describe('full-text candidate terms on a large index', () => {
  it('keeps the rarest terms up to a match budget, never only terms that match nothing', () => {
    const store = Store.open(':memory:');
    // 6000 symbols: alpha in 10, gamma in 100, eps in 200, beta in 3000 (50%), delta in 4000; zzz in none
    store.db.exec(`
      WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 6000)
      INSERT INTO symbols_fts(rowid, name_terms, sig_terms, path_terms, doc, body_terms)
      SELECT x, 'w' || x || (CASE WHEN x <= 10 THEN ' alpha' ELSE '' END) || (CASE WHEN x <= 100 THEN ' gamma' ELSE '' END)
        || (CASE WHEN x <= 200 THEN ' eps' ELSE '' END) || (CASE WHEN x <= 3000 THEN ' beta' ELSE '' END) || (CASE WHEN x <= 4000 THEN ' delta' ELSE '' END), '', '', '', '' FROM c;
      WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 6000)
      INSERT INTO files(id, path, hash, size, line_count) SELECT 1, 'a.ts', 'h', 1, 1 FROM c WHERE x = 1;
      WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 6000)
      INSERT INTO symbols(id, file_id, name, qname, kind, start_line, end_line, start_byte, end_byte, signature) SELECT x, 1, 'w' || x, 'w' || x, 'function', 1, 1, 0, 1, '' FROM c;
    `);
    try {
      expect(selectFtsTerms(store, ['beta', 'alpha', 'gamma'])).toEqual(['alpha', 'gamma']);
      expect(selectFtsTerms(store, ['zzz', 'beta'])).toEqual(['zzz', 'beta']);
      expect(selectFtsTerms(store, ['delta', 'beta'])).toEqual(['delta', 'beta']);
      expect(selectFtsTerms(store, ['eps', 'alpha', 'gamma'], 150)).toEqual(['alpha', 'gamma']);
      expect(selectFtsTerms(store, ['eps', 'alpha', 'gamma'])).toEqual(['eps', 'alpha', 'gamma']);
    } finally {
      store.close();
    }
  });
});
