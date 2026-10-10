import { appendFileSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { defaultConfig, indexPath, type KoptConfig } from '../src/core/config.js';
import type { ToolContext } from '../src/core/context.js';
import { estimateTokens } from '../src/core/tokens.js';
import type { TelemetryEvent, ToolResult } from '../src/core/types.js';
import { META } from '../src/store/schema.js';
import { Store, symbolHandle } from '../src/store/store.js';
import { createServer, type RepoHandle } from '../src/mcp/server.js';
import { createAutoServer, fileUriToPath, LocalRepo, NO_PROJECT_MESSAGE, retryDelayMs } from '../src/mcp/local.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Indexes of temp repos go to a temp cache, never the developer's real one.
process.env.KOPT_CACHE_DIR = mkdtempSync(join(tmpdir(), 'kopt-mcp-cache-'));
import { toolDefinitions, serverInstructions } from '../src/mcp/tools.js';
import type { IndexerModule, IndexPhase, IndexStats, Modules, RetrievalModule } from '../src/mcp/modules.js';

const REFUND_TS = `export interface Refund { id: string; amount: number }

/** Compute the refundable amount of an order. */
export function computeRefund(order: Order, reason: string): Refund {
  const amount = order.total - order.fees;
  return { id: order.id, amount };
}
`;

/** Minimal index following src/store/schema.ts. */
function seedStore(path: string): void {
  const s = Store.open(path);
  s.transaction(() => {
    s.prepare('INSERT INTO files(id, path, lang, hash, size, line_count, mtime_ms, rank, indexed_at) VALUES (?,?,?,?,?,?,?,?,?)').run(
      1, 'src/billing/refund.ts', 'typescript', 'h1', REFUND_TS.length, 8, 0, 0.5, Date.now(),
    );
    const sym = s.prepare(
      'INSERT INTO symbols(id, file_id, name, qname, kind, start_line, end_line, start_byte, end_byte, signature, doc, parent_id, exported, rank) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    );
    sym.run(1, 1, 'Refund', 'Refund', 'interface', 1, 1, 0, 50, 'export interface Refund', null, null, 1, 0.3);
    sym.run(2, 1, 'computeRefund', 'computeRefund', 'function', 3, 7, 52, 230, 'export function computeRefund(order: Order, reason: string): Refund', 'Compute the refundable amount of an order.', null, 1, 0.6);
    const fts = s.prepare('INSERT INTO symbols_fts(rowid, name_terms, sig_terms, path_terms, doc, body_terms) VALUES (?,?,?,?,?,?)');
    fts.run(1, 'refund', 'refund', 'src billing refund ts', '', 'id amount');
    fts.run(2, 'computerefund compute refund', 'order reason refund', 'src billing refund ts', 'compute the refundable amount of an order', 'order total fees amount');
  });
  s.setMeta(META.indexedAt, String(Date.now()));
  s.close();
}

/** Contract-shaped stand-in for retrieval/ (used when the real module is absent or for plumbing assertions). */
function fakeRetrieval(calls: { ctx: ToolContext[] } = { ctx: [] }): RetrievalModule {
  const result = (text: string): ToolResult => ({ text, tokens: estimateTokens(text) });
  return {
    find(store, p, ctx) {
      ctx.ledger.tick();
      calls.ctx.push(ctx);
      const rows = store
        .prepare(`SELECT s.id, s.name, s.start_line, s.end_line, f.path FROM symbols s JOIN files f ON f.id = s.file_id WHERE lower(s.name) LIKE ? ORDER BY s.rank DESC`)
        .all(`%${p.query.toLowerCase()}%`) as { id: number; name: string; start_line: number; end_line: number; path: string }[];
      const lines = rows.map((r) => `${r.path}:${r.start_line}-${r.end_line} ${symbolHandle(r.id)} ${r.name}`);
      const body = lines.join('\n');
      return result(`find "${p.query}" · ${rows.length} hits · ~${estimateTokens(body)} tok\n${body}`);
    },
    read: (_s, p) => result(`read ${p.target}`),
    outline: () => result('outline'),
    refs: () => result('refs'),
  };
}

async function connect(server: ReturnType<typeof createServer>): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await server.connect(a);
  await client.connect(b);
  return client;
}

function staticRepo(name: string, config: KoptConfig, store: Store): RepoHandle {
  return { name, config, acquire: async () => store };
}

let dir: string;
let config: KoptConfig;
let store: Store;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'kopt-mcp-'));
  config = defaultConfig(dir);
  config.telemetry.enabled = false;
  seedStore(indexPath(config));
  store = Store.open(indexPath(config), { root: dir });
});

afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('tools/list', () => {
  it('lists 4 tools with one-line descriptions, the parameters of the common calls and no instructions', async () => {
    const client = await connect(createServer({ config, repo: staticRepo('r', config, store) }));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['kopt_find', 'kopt_read', 'kopt_refs', 'kopt_run']);
    for (const t of tools) {
      expect(t.description!.length).toBeLessThan(90);
      expect(JSON.stringify(t.inputSchema)).not.toMatch(/\$schema|additionalProperties|required/);
      expect(t).not.toHaveProperty('title');
    }
    expect(tools.map((t) => Object.keys((t.inputSchema as any).properties))).toEqual([['query', 'mode'], ['target', 'mode'], ['target'], ['command']]);
    expect(tools.find((t) => t.name === 'kopt_find')!.annotations).toEqual({ readOnlyHint: true });
    expect(tools.find((t) => t.name === 'kopt_run')!.annotations).toBeUndefined();
    expect(client.getInstructions()).toBeUndefined();
    expect(serverInstructions()).toBe('');
    expect(JSON.stringify({ tools })).toBe(JSON.stringify({ tools: toolDefinitions() }));
    await client.close();
  });

  it("keeps kopt's fixed prompt (tool specs as Kiro sends them + always-on steering) within 350 tokens", () => {
    // What every model request carries because kopt is installed: each listed tool as a model tool spec, under the
    // name Kiro IDE gives MCP tools (mcp_<server>_<tool>; longer than Kiro CLI's), the server instructions and the
    // always-on steering body (front matter is metadata). Tokens = chars / 3, the estimate kopt uses everywhere.
    const specs = toolDefinitions().map((d) => JSON.stringify({ name: `mcp_kopt_${d.name}`, description: d.description, input_schema: d.inputSchema }));
    const steering = readFileSync(join(__dirname, '..', 'templates', 'steering', 'kopt.md'), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '');
    const chars = specs.join('').length + serverInstructions().length + steering.length;
    process.stderr.write(`[size] fixed prompt: tools ${specs.join('').length} + instructions ${serverInstructions().length} + steering ${steering.length} = ${chars} chars ~${Math.ceil(chars / 3)} tok\n`);
    expect(Math.ceil(chars / 3)).toBeLessThanOrEqual(350);
    expect(steering.trim().split(/\s+/).length).toBeLessThanOrEqual(80);
  });
});

describe('tools/call', () => {
  it('kopt_find returns plain text and emits telemetry', async () => {
    let retrieval: RetrievalModule;
    try {
      retrieval = (await import('../src/retrieval/index.js' as string)) as RetrievalModule;
      retrieval.find(store, { query: 'refund' }, (await import('../src/core/context.js')).newToolContext(config));
    } catch {
      retrieval = fakeRetrieval();
    }
    const events: TelemetryEvent[] = [];
    const server = createServer({
      config,
      repo: staticRepo('r', config, store),
      modules: { retrieval: async () => retrieval },
      emit: (e) => events.push(e),
      sessionId: 's1',
    });
    const client = await connect(server);
    const res = (await client.callTool({ name: 'kopt_find', arguments: { query: 'refund' } })) as any;
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toBeUndefined();
    expect(res.content).toHaveLength(1);
    expect(res.content[0].type).toBe('text');
    expect(res.content[0].text).toMatch(/computeRefund|refund\.ts/);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'tool', tool: 'kopt_find', session: 's1', repo: 'r' });
    expect(events[0].tokensOut).toBeGreaterThan(0);
    expect(typeof events[0].durationMs).toBe('number');
    await client.close();
  });

  it('rejects bad arguments with a one-line isError', async () => {
    const client = await connect(createServer({ config, repo: staticRepo('r', config, store), modules: { retrieval: async () => fakeRetrieval() }, emit: () => {} }));
    const r1 = (await client.callTool({ name: 'kopt_find', arguments: {} })) as any;
    expect(r1.isError).toBe(true);
    expect(r1.content[0].text).toMatch(/^kopt_find: invalid arguments: query/);
    expect(r1.content[0].text).not.toContain('\n');
    const r2 = (await client.callTool({ name: 'kopt_find', arguments: { query: 'x', kinds: ['klass'] } })) as any;
    expect(r2.isError).toBe(true);
    expect(r2.content[0].text).toContain('invalid kinds klass');
    const r3 = (await client.callTool({ name: 'kopt_nope', arguments: {} })) as any;
    expect(r3.isError).toBe(true);
    await client.close();
  });

  it('turns module failures into one-line errors and caps oversized output', async () => {
    const huge = Array.from({ length: 3000 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
    const retrieval: RetrievalModule = {
      ...fakeRetrieval(),
      read: () => {
        throw new Error('boom\nstack line');
      },
      outline: () => ({ text: huge, tokens: estimateTokens(huge) }),
    };
    const client = await connect(createServer({ config, repo: staticRepo('r', config, store), modules: { retrieval: async () => retrieval }, emit: () => {} }));
    const r1 = (await client.callTool({ name: 'kopt_read', arguments: { target: '#2' } })) as any;
    expect(r1.isError).toBe(true);
    expect(r1.content[0].text).toBe('kopt_read failed: boom stack line');
    const r2 = (await client.callTool({ name: 'kopt_outline', arguments: { maxTokens: 300 } })) as any;
    expect(estimateTokens(r2.content[0].text)).toBeLessThanOrEqual(300);
    await client.close();
  });

  it('passes the request cancellation signal to kopt_run', async () => {
    let seen: AbortSignal | undefined;
    const compress = {
      runCommand: (_p: unknown, _ctx: ToolContext, opts?: { signal?: AbortSignal }) =>
        new Promise<ToolResult>((res) => {
          seen = opts?.signal;
          opts?.signal?.addEventListener('abort', () => res({ text: 'exit 130 · cancelled', tokens: 5 }), { once: true });
        }),
      expand: () => ({ text: '', tokens: 0 }),
    };
    const client = await connect(createServer({ config, repo: staticRepo('r', config, store), modules: { compress: async () => compress }, emit: () => {} }));
    const ac = new AbortController();
    const call = client.callTool({ name: 'kopt_run', arguments: { command: 'mvn test' } }, undefined, { signal: ac.signal }).catch((e: Error) => e);
    for (let i = 0; i < 50 && !seen; i++) await new Promise((r) => setTimeout(r, 10));
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen!.aborted).toBe(false);
    ac.abort();
    expect(await call).toBeInstanceOf(Error);
    for (let i = 0; i < 50 && !seen!.aborted; i++) await new Promise((r) => setTimeout(r, 10));
    expect(seen!.aborted).toBe(true);
    await client.close();
  });

  it('appends the source context of a failing kopt_run when the index is ready, not of a passing or cached one', async () => {
    const results: ToolResult[] = [
      { text: 'exit 1 · raw ~900 tok\nFAIL a > b\n  ❯ test/a.test.ts:12:3', tokens: 12, meta: { exitCode: 1 } },
      { text: 'exit 0\nok', tokens: 3, meta: { exitCode: 0 } },
      { text: 'exit 1 · same as run o1', tokens: 6, meta: { exitCode: 1, cached: true } },
    ];
    const compress = { runCommand: async () => results.shift()!, expand: () => ({ text: '', tokens: 0 }) };
    const seen: string[] = [];
    const retrieval = { ...fakeRetrieval(), failureContext: (_s: Store, out: string, max: number) => (seen.push(out), max >= 100 ? 'source (kopt index):\n  at src/a.ts:3 in #1 a (def L1)' : undefined) };
    const repo: RepoHandle = { ...staticRepo('r', config, store), peek: () => store };
    const client = await connect(createServer({ config, repo, modules: { compress: async () => compress, retrieval: async () => retrieval }, emit: () => {} }));
    const call = async () => ((await client.callTool({ name: 'kopt_run', arguments: { command: 'npm test' } })).content as Array<{ text: string }>)[0].text;
    expect(await call()).toBe('exit 1 · raw ~900 tok\nFAIL a > b\n  ❯ test/a.test.ts:12:3\nsource (kopt index):\n  at src/a.ts:3 in #1 a (def L1)');
    expect(await call()).toBe('exit 0\nok');
    expect(await call()).toBe('exit 1 · same as run o1');
    expect(seen).toHaveLength(1);
    // without a ready index (peek undefined) the run answers alone
    results.push({ text: 'exit 1\nboom', tokens: 3, meta: { exitCode: 1 } });
    const bare = await connect(createServer({ config, repo: staticRepo('r', config, store), modules: { compress: async () => compress, retrieval: async () => retrieval }, emit: () => {} }));
    expect(((await bare.callTool({ name: 'kopt_run', arguments: { command: 'npm test' } })).content as Array<{ text: string }>)[0].text).toBe('exit 1\nboom');
    await client.close();
    await bare.close();
  });

  it('gives each session its own ToolContext (per-session dedup ledger)', async () => {
    const calls = { ctx: [] as ToolContext[] };
    const retrieval = fakeRetrieval(calls);
    const mk = () => createServer({ config, repo: staticRepo('r', config, store), modules: { retrieval: async () => retrieval }, emit: () => {} });
    const c1 = await connect(mk());
    const c2 = await connect(mk());
    await c1.callTool({ name: 'kopt_find', arguments: { query: 'refund' } });
    await c1.callTool({ name: 'kopt_find', arguments: { query: 'refund' } });
    await c2.callTool({ name: 'kopt_find', arguments: { query: 'refund' } });
    expect(calls.ctx[0]).toBe(calls.ctx[1]);
    expect(calls.ctx[2]).not.toBe(calls.ctx[0]);
    expect(calls.ctx[0].ledger.callCount).toBe(2);
    expect(calls.ctx[2].ledger.callCount).toBe(1);
    await c1.close();
    await c2.close();
  });
});

describe('LocalRepo lifecycle', () => {
  function fakeIndexer(o: { buildMs?: number; refreshMs?: number; counts: { build: number; refresh: number; paths?: (string[] | undefined)[] } }): () => Promise<IndexerModule> {
    const stats: IndexStats = { filesSeen: 1, filesIndexed: 1, filesUnchanged: 0, filesDeleted: 0, symbols: 2, refs: 0, durationMs: 1 };
    return async () => ({
      async indexRepo(s, opts) {
        o.counts.build++;
        opts.onProgress?.(3, 10);
        await new Promise((r) => setTimeout(r, o.buildMs ?? 0));
        s.setMeta(META.indexedAt, String(Date.now()));
        return stats;
      },
      async refreshIndex(_s, opts) {
        o.counts.refresh++;
        o.counts.paths?.push(opts.paths);
        await new Promise((r) => setTimeout(r, o.refreshMs ?? 0));
        return stats;
      },
    });
  }

  it('answers "index building" while the first build runs, then serves the store', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kopt-local-'));
    const cfg = defaultConfig(root);
    const counts = { build: 0, refresh: 0 };
    const repo = new LocalRepo(cfg, { modules: { indexer: fakeIndexer({ buildMs: 300, counts }) } as Partial<Modules>, buildWaitMs: 50, log: () => {} });
    expect(await repo.acquire()).toBe('index building: 3/10 files parsed – use built-in search/read tools until then');
    await new Promise((r) => setTimeout(r, 400));
    const s = await repo.acquire();
    expect(s).toBeInstanceOf(Store);
    expect(counts.build).toBe(1);
    repo.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('refreshes on dirty marker / interval, one at a time, without blocking calls on slow refreshes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kopt-local-'));
    const cfg = defaultConfig(root);
    seedStore(indexPath(cfg));
    const counts = { build: 0, refresh: 0, paths: [] as (string[] | undefined)[] };
    const repo = new LocalRepo(cfg, {
      modules: { indexer: fakeIndexer({ refreshMs: 400, counts }) } as Partial<Modules>,
      refreshWaitMs: 50,
      refreshIntervalMs: 60_000,
      log: () => {},
    });
    const t0 = Date.now();
    expect(await repo.acquire()).toBeInstanceOf(Store); // startup catch-up refresh, not awaited past 50ms
    expect(Date.now() - t0).toBeLessThan(300);
    expect(counts.build).toBe(0);
    expect(counts.refresh).toBe(1);
    await repo.acquire(); // joins the running refresh
    expect(counts.refresh).toBe(1);
    await new Promise((r) => setTimeout(r, 450));
    await repo.acquire(); // nothing changed, interval not elapsed
    expect(counts.refresh).toBe(1);
    mkdirSync(cfg.dataDir, { recursive: true });
    writeFileSync(join(cfg.dataDir, 'dirty'), 'src/a.ts\nsrc/b.ts\nsrc/a.ts\nsrc/partial');
    utimesSync(join(cfg.dataDir, 'dirty'), new Date(), new Date(Date.now() + 5000));
    await repo.acquire();
    expect(counts.refresh).toBe(2);
    expect(counts.paths).toEqual([undefined, ['src/a.ts', 'src/b.ts']]); // startup = full check, then only hook-reported paths
    repo.close();
    rmSync(root, { recursive: true, force: true });
  });

  // Acceptance test of v0.2.0: idle, `git add`, a call (full check started, not awaited), a write + PostToolUse hook,
  // a call: it answered from the old index, because a running full refresh was never awaited.
  it('a call right after a write waits for a pass that includes it, queued after a running full refresh', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kopt-local-'));
    const cfg = defaultConfig(root);
    seedStore(indexPath(cfg));
    const passes: Array<{ paths?: string[]; start: number; end: number }> = [];
    let active = 0;
    let maxActive = 0;
    const stats: IndexStats = { filesSeen: 1, filesIndexed: 1, filesUnchanged: 0, filesDeleted: 0, symbols: 2, refs: 0, durationMs: 1 };
    const indexer = async (): Promise<IndexerModule> => ({
      async indexRepo() {
        return stats;
      },
      async refreshIndex(_s, opts) {
        const pass = { paths: opts.paths, start: Date.now(), end: 0 };
        passes.push(pass);
        maxActive = Math.max(maxActive, ++active);
        // a slow full check (listing + stat of every file), a quick targeted pass
        await new Promise((r) => setTimeout(r, opts.paths ? 30 : 500));
        active--;
        pass.end = Date.now();
        return stats;
      },
    });
    const repo = new LocalRepo(cfg, { modules: { indexer } as Partial<Modules>, refreshIntervalMs: 50, fullRefreshIntervalMs: 0, log: () => {} });
    const dirty = join(cfg.dataDir, 'dirty');
    const report = (path: string, bump: number) => {
      mkdirSync(cfg.dataDir, { recursive: true });
      appendFileSync(dirty, `${path}\n`);
      utimesSync(dirty, new Date(), new Date(Date.now() + bump));
    };
    await repo.acquire(); // start-up catch-up (awaited)
    expect(passes.map((p) => p.paths)).toEqual([undefined]);
    await new Promise((r) => setTimeout(r, 80));
    const t0 = Date.now();
    await repo.acquire(); // interval due: a full check starts and is not awaited
    expect(Date.now() - t0).toBeLessThan(300);
    expect(passes).toHaveLength(2);
    // the agent writes two files (PostToolUse hooks) and searches while the full check still runs
    report('src/new.ts', 5_000);
    const a = repo.acquire();
    report('src/other.ts', 10_000);
    const b = repo.acquire();
    await Promise.all([a, b]);
    const full = passes[1];
    const targeted = passes[2];
    expect(targeted?.paths).toEqual(['src/new.ts', 'src/other.ts']); // one pass for both, after the full one
    expect(targeted.end).toBeGreaterThan(0); // done before the calls answered
    expect(targeted.start).toBeGreaterThanOrEqual(full.end);
    expect(maxActive).toBe(1);
    expect(Date.now() - t0).toBeLessThan(2_000);
    // no file reported since: the next call does not wait (a periodic full check may start, never a targeted pass)
    const t1 = Date.now();
    await repo.acquire();
    expect(Date.now() - t1).toBeLessThan(200);
    expect(passes.slice(3).every((p) => p.paths === undefined)).toBe(true);
    repo.close();
    rmSync(root, { recursive: true, force: true });
  });

  // Acceptance test of v0.2.1: idle for 2 minutes (or a `git add` meanwhile), then a write + PostToolUse hook and a
  // call. A full check was due, the written file went into it, and the call did not wait for it: stale answer.
  it('a write when a full check is due too: the written file first (waited for), then the full check (not waited for)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kopt-local-'));
    const cfg = defaultConfig(root);
    seedStore(indexPath(cfg));
    const passes: Array<{ paths?: string[]; start: number; end: number }> = [];
    let active = 0;
    let maxActive = 0;
    const stats: IndexStats = { filesSeen: 1, filesIndexed: 1, filesUnchanged: 0, filesDeleted: 0, symbols: 2, refs: 0, durationMs: 1 };
    const indexer = async (): Promise<IndexerModule> => ({
      async indexRepo() {
        return stats;
      },
      async refreshIndex(_s, opts) {
        const pass = { paths: opts.paths, start: Date.now(), end: 0 };
        passes.push(pass);
        maxActive = Math.max(maxActive, ++active);
        // a full check longer than a call may wait (refreshWaitMs), a quick targeted pass
        await new Promise((r) => setTimeout(r, opts.paths ? 30 : 1_500));
        active--;
        pass.end = Date.now();
        return stats;
      },
    });
    const repo = new LocalRepo(cfg, { modules: { indexer } as Partial<Modules>, refreshIntervalMs: 50, fullRefreshIntervalMs: 100, refreshWaitMs: 1_000, log: () => {} });
    const dirty = join(cfg.dataDir, 'dirty');
    await repo.acquire(); // start-up catch-up: waited for at most refreshWaitMs
    for (let i = 0; i < 200 && !passes[0]?.end; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 150)); // idle: the next look is due for a full check
    mkdirSync(cfg.dataDir, { recursive: true });
    appendFileSync(dirty, 'src/new.ts\n');
    utimesSync(dirty, new Date(), new Date(Date.now() + 5_000));
    const t0 = Date.now();
    await repo.acquire();
    const answered = Date.now();
    expect(passes.map((p) => p.paths)).toEqual([undefined, ['src/new.ts'], undefined]);
    const [, targeted, full] = passes;
    expect(targeted.end).toBeGreaterThan(0);
    expect(targeted.end).toBeLessThanOrEqual(answered); // the call answered with the written file indexed
    expect(answered - t0).toBeLessThan(900); // and did not wait for the full check
    expect(full.start).toBeGreaterThanOrEqual(targeted.end);
    expect(full.end).toBe(0);
    // a call while the full check runs, nothing written since: no wait
    const t1 = Date.now();
    await repo.acquire();
    expect(Date.now() - t1).toBeLessThan(300);
    expect(maxActive).toBe(1);
    repo.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('the wait for a written file is bounded (refreshWaitMs) when the running refresh is slower', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kopt-local-'));
    const cfg = defaultConfig(root);
    seedStore(indexPath(cfg));
    const counts = { build: 0, refresh: 0, paths: [] as (string[] | undefined)[] };
    const repo = new LocalRepo(cfg, { modules: { indexer: fakeIndexer({ refreshMs: 900, counts }) } as Partial<Modules>, refreshWaitMs: 150, refreshIntervalMs: 60_000, log: () => {} });
    await repo.acquire(); // start-up full check: waited for at most 150 ms, still running
    mkdirSync(cfg.dataDir, { recursive: true });
    writeFileSync(join(cfg.dataDir, 'dirty'), 'src/a.ts\n');
    utimesSync(join(cfg.dataDir, 'dirty'), new Date(), new Date(Date.now() + 5000));
    const t0 = Date.now();
    await repo.acquire();
    expect(Date.now() - t0).toBeLessThan(700);
    for (let i = 0; i < 100 && counts.paths.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    expect(counts.paths).toEqual([undefined, ['src/a.ts']]); // the queued pass still runs
    repo.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('reports a failed build in one line, records it for kopt doctor, and does not retry on every call', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kopt-local-'));
    const cfg = defaultConfig(root);
    let attempts = 0;
    const repo = new LocalRepo(cfg, {
      modules: { indexer: async () => ({ indexRepo: async () => { attempts++; throw new Error('parser exploded'); }, refreshIndex: async () => { throw new Error('x'); } }) } as Partial<Modules>,
      log: () => {},
    });
    const msg = await repo.acquire();
    expect(msg).toMatch(/^index unavailable: parser exploded – run 'kopt index'/);
    expect(await repo.acquire()).toBe(msg);
    expect(attempts).toBe(1);
    expect(JSON.parse(readFileSync(join(cfg.dataDir, 'last-error.json'), 'utf8'))).toMatchObject({ message: 'parser exploded', attempts: 1 });
    expect([1, 2, 3, 6, 9].map(retryDelayMs)).toEqual([60_000, 120_000, 240_000, 1_800_000, 1_800_000]);
    repo.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** An indexer whose build goes through `phases`, each held `stepMs`, reporting through onPhase. */
  function phasedIndexer(phases: IndexPhase[], stepMs: number): () => Promise<IndexerModule> {
    const stats: IndexStats = { filesSeen: 1, filesIndexed: 1, filesUnchanged: 0, filesDeleted: 0, symbols: 2, refs: 0, durationMs: 1 };
    return async () => ({
      async indexRepo(s, opts) {
        for (const p of phases) {
          opts.onPhase?.(p);
          await new Promise((r) => setTimeout(r, stepMs));
        }
        s.setMeta(META.indexedAt, String(Date.now()));
        return stats;
      },
      async refreshIndex() {
        return stats;
      },
    });
  }

  it('serves search, read and outline once symbols are written, before references are resolved', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kopt-local-'));
    const cfg = defaultConfig(root);
    const repo = new LocalRepo(cfg, {
      modules: { indexer: phasedIndexer([{ phase: 'parse', done: 10, total: 10 }, { phase: 'resolve', done: 0, total: 1000 }, { phase: 'resolve', done: 400, total: 1000 }], 300) } as Partial<Modules>,
      buildWaitMs: 100,
      log: () => {},
    });
    repo.start();
    await new Promise((r) => setTimeout(r, 400));
    const t0 = Date.now();
    expect(await repo.acquire('kopt_find')).toBeInstanceOf(Store);
    expect(await repo.acquire('kopt_outline')).toBeInstanceOf(Store);
    expect(Date.now() - t0).toBeLessThan(200);
    const refs = await repo.acquire('kopt_refs');
    expect(refs).toMatch(/^kopt_refs: references are being resolved \(\d+\/1000.*\) – kopt_find and kopt_read already answer$/);
    await new Promise((r) => setTimeout(r, 700));
    expect(await repo.acquire('kopt_refs')).toBeInstanceOf(Store);
    repo.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('answers at once with an estimate when the build will take longer than a call may wait', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kopt-local-'));
    const cfg = defaultConfig(root);
    const repo = new LocalRepo(cfg, {
      modules: { indexer: phasedIndexer([{ phase: 'parse', done: 1, total: 20_000 }, { phase: 'parse', done: 10, total: 20_000 }, { phase: 'parse', done: 20, total: 20_000 }], 1_200) } as Partial<Modules>,
      log: () => {},
    });
    const t0 = Date.now();
    const msg = await repo.acquire('kopt_find');
    // two 1.2 s progress steps, far from the 15 s buildWaitMs; Windows runners add seconds to the first store open
    expect(Date.now() - t0).toBeLessThan(process.platform === 'win32' ? 7_500 : 2_600);
    expect(msg).toMatch(/^index building: \d+\/20000 files parsed, ~\d+ min left – use built-in search\/read tools until then$/);
    repo.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('runs the full freshness check only when git state moved (or every fullRefreshIntervalMs)', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kopt-local-git-')));
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'one'], { cwd: root });
    const cfg = defaultConfig(root);
    seedStore(indexPath(cfg));
    const counts = { build: 0, refresh: 0, paths: [] as (string[] | undefined)[] };
    const repo = new LocalRepo(cfg, {
      modules: { indexer: fakeIndexer({ counts }) } as Partial<Modules>,
      refreshIntervalMs: 50,
      fullRefreshIntervalMs: 60_000,
      log: () => {},
    });
    await repo.acquire(); // start-up catch-up: full
    expect(counts.paths).toEqual([undefined]);
    await new Promise((r) => setTimeout(r, 120));
    await repo.acquire(); // interval due, git state unchanged: nothing
    expect(counts.refresh).toBe(1);
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'two'], { cwd: root });
    await new Promise((r) => setTimeout(r, 120));
    await repo.acquire(); // HEAD moved: full check
    await new Promise((r) => setTimeout(r, 20));
    expect(counts.paths).toEqual([undefined, undefined]);
    repo.close();
    rmSync(root, { recursive: true, force: true });
  });
});


describe('user-level server: project root after initialize', () => {
  const stats: IndexStats = { filesSeen: 1, filesIndexed: 1, filesUnchanged: 0, filesDeleted: 0, symbols: 2, refs: 0, durationMs: 1 };
  const modules = {
    retrieval: async () => fakeRetrieval(),
    indexer: async (): Promise<IndexerModule> => ({
      async indexRepo(s) {
        s.setMeta(META.indexedAt, String(Date.now()));
        return stats;
      },
      async refreshIndex() {
        return stats;
      },
    }),
  } as Partial<Modules>;

  function gitRepo(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kopt-auto-')));
    execFileSync('git', ['init', '-q'], { cwd: root });
    mkdirSync(join(root, 'src', 'billing'), { recursive: true });
    return root;
  }

  async function connectAuto(o: Parameters<typeof createAutoServer>[1], roots?: string[]) {
    const base = defaultConfig(o?.cwd ?? tmpdir());
    base.telemetry.enabled = false;
    const auto = createAutoServer(base, { modules, initFallbackMs: 60_000, repo: { log: () => {} }, configFor: (r) => ({ ...defaultConfig(r), telemetry: { ...base.telemetry } }), ...o });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'kiro-test', version: '0' }, roots ? { capabilities: { roots: { listChanged: true } } } : {});
    let current = roots ?? [];
    if (roots) client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: current.map((r) => ({ uri: pathToFileURL(r).href, name: 'ws' })) }));
    await auto.server.connect(a);
    await client.connect(b);
    return { ...auto, client, setRoots: (r: string[]) => (current = r) };
  }

  it('uses the first file:// root the client advertises, widened to its git root', async () => {
    const root = gitRepo();
    seedStore(indexPath(defaultConfig(root)));
    const other = gitRepo();
    const { client, repo, ready } = await connectAuto({ cwd: other, env: {} }, [join(root, 'src', 'billing')]);
    const d = await ready();
    expect(d).toEqual({ root, source: 'roots' });
    const res = (await client.callTool({ name: 'kopt_find', arguments: { query: 'computeRefund' } })) as any;
    expect(res.content[0].text).toContain('src/billing/refund.ts');
    expect(repo.root).toBe(root);
    repo.close();
    await client.close();
  });

  it('switches project when the client roots change', async () => {
    const first = gitRepo();
    const second = gitRepo();
    seedStore(indexPath(defaultConfig(second)));
    const { client, repo, ready, setRoots } = await connectAuto({ cwd: tmpdir(), env: {} }, [first]);
    await ready();
    expect(repo.root).toBe(first);
    setRoots([second]);
    await client.sendRootsListChanged();
    for (let i = 0; i < 50 && repo.root !== second; i++) await new Promise((r) => setTimeout(r, 10));
    expect(repo.root).toBe(second);
    repo.close();
    await client.close();
  });

  it('falls back to KOPT_ROOT, then to the git root of the cwd, when the client has no roots (Kiro IDE 0.12)', async () => {
    const root = gitRepo();
    const viaCwd = await connectAuto({ cwd: join(root, 'src', 'billing'), env: {} });
    expect(await viaCwd.ready()).toEqual({ root, source: 'cwd' });
    viaCwd.repo.close();
    const pinned = gitRepo();
    const viaEnv = await connectAuto({ cwd: root, env: { KOPT_ROOT: pinned } });
    expect(await viaEnv.ready()).toEqual({ root: pinned, source: 'env' });
    viaEnv.repo.close();
  });

  it('never indexes a home directory or filesystem root: tools answer one line', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'kopt-home-')));
    const { client, ready, repo } = await connectAuto({ cwd: home, env: {}, home });
    expect(await ready()).toEqual({ source: 'cwd', message: NO_PROJECT_MESSAGE });
    for (const name of ['kopt_find', 'kopt_run']) {
      const res = (await client.callTool({ name, arguments: name === 'kopt_find' ? { query: 'x' } : { command: 'echo hi' } })) as any;
      expect(res.content[0].text).toBe(NO_PROJECT_MESSAGE);
    }
    const viaRoots = await connectAuto({ cwd: tmpdir(), env: {}, home }, [home]);
    expect(await viaRoots.ready()).toMatchObject({ source: 'roots', message: NO_PROJECT_MESSAGE });
    repo.close();
    await client.close();
  });

  it('converts file:// URIs for POSIX and Windows', () => {
    expect(fileUriToPath('file:///home/u/my%20repo', 'linux')).toBe('/home/u/my repo');
    expect(fileUriToPath('file:///c%3A/Users/u/repo', 'win32')).toBe('c:\\Users\\u\\repo');
    expect(fileUriToPath('file:///C:/Users/u/repo', 'win32')).toBe('C:\\Users\\u\\repo');
    expect(fileUriToPath('file://server/share/repo', 'win32')).toBe('\\\\server\\share\\repo');
    expect(fileUriToPath('https://example.com/x', 'linux')).toBeUndefined();
    expect(fileUriToPath('not a uri', 'linux')).toBeUndefined();
  });
});
