import { mkdtempSync, rmSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
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
import { createAutoServer, fileUriToPath, LocalRepo, NO_PROJECT_MESSAGE } from '../src/mcp/local.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Indexes of temp repos go to a temp cache, never the developer's real one.
process.env.KOPT_CACHE_DIR = mkdtempSync(join(tmpdir(), 'kopt-mcp-cache-'));
import { toolDefinitions, serverInstructions } from '../src/mcp/tools.js';
import type { IndexerModule, IndexStats, Modules, RetrievalModule } from '../src/mcp/modules.js';

const REFUND_TS = `export interface Refund { id: string; amount: number }

/** Compute the refundable amount of an order. */
export function computeRefund(order: Order, reason: string): Refund {
  const amount = order.total - order.fees;
  return { id: order.id, amount };
}
`;

/** Minimal index following src/store/schema.ts. */
function seedStore(path: string, withBlobs = false): void {
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
    if (withBlobs) s.prepare('INSERT INTO blobs(file_id, content) VALUES (?, ?)').run(1, gzipSync(REFUND_TS));
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
  it('stdio mode exposes exactly the 6 tools with short descriptions and tiny instructions', async () => {
    const client = await connect(createServer({ config, repos: () => [staticRepo('r', config, store)], allowRun: true }));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['kopt_find', 'kopt_read', 'kopt_outline', 'kopt_refs', 'kopt_run', 'kopt_expand']);
    for (const t of tools) {
      expect(t.description!.length).toBeLessThan(350);
      expect(JSON.stringify(t.inputSchema)).not.toContain('$schema');
      expect(t).not.toHaveProperty('title');
    }
    expect(tools.find((t) => t.name === 'kopt_find')!.annotations).toEqual({ readOnlyHint: true });
    expect(tools.find((t) => t.name === 'kopt_run')!.annotations).toBeUndefined();
    const instructions = client.getInstructions()!;
    expect(instructions.length).toBeLessThan(600);

    const listJson = JSON.stringify({ tools });
    const httpJson = JSON.stringify({ tools: toolDefinitions({ allowRun: false, multiRepo: true }) });
    // Re-billed on every model turn: keep an eye on it.
    process.stderr.write(
      `[size] tools/list stdio: ${listJson.length} chars ~${estimateTokens(listJson)} tok; http: ${httpJson.length} chars ~${estimateTokens(httpJson)} tok; ` +
        `instructions: ${instructions.length} chars ~${estimateTokens(instructions)} tok\n`,
    );
    expect(estimateTokens(listJson)).toBeLessThan(1100);
    await client.close();
  });

  it('honours KOPT_DISABLE_RUN and multi-repo instructions', () => {
    expect(toolDefinitions({ allowRun: false, multiRepo: false }).map((t) => t.name)).toEqual(['kopt_find', 'kopt_read', 'kopt_outline', 'kopt_refs']);
    const defs = toolDefinitions({ allowRun: false, multiRepo: true });
    expect((defs[0].inputSchema as any).properties.repo).toEqual({ type: 'string' });
    const text = serverInstructions({ allowRun: false, multiRepo: true, repos: ['a', 'b'] });
    expect(text).toContain('a, b');
    expect(text).not.toContain('kopt_run');
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
      repos: () => [staticRepo('r', config, store)],
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
    const client = await connect(createServer({ config, repos: () => [staticRepo('r', config, store)], modules: { retrieval: async () => fakeRetrieval() }, emit: () => {} }));
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
    const client = await connect(createServer({ config, repos: () => [staticRepo('r', config, store)], modules: { retrieval: async () => retrieval }, emit: () => {} }));
    const r1 = (await client.callTool({ name: 'kopt_read', arguments: { target: '#2' } })) as any;
    expect(r1.isError).toBe(true);
    expect(r1.content[0].text).toBe('kopt_read failed: boom stack line');
    const r2 = (await client.callTool({ name: 'kopt_outline', arguments: { maxTokens: 300 } })) as any;
    expect(estimateTokens(r2.content[0].text)).toBeLessThanOrEqual(300);
    await client.close();
  });

  it('gives each session its own ToolContext (per-session dedup ledger)', async () => {
    const calls = { ctx: [] as ToolContext[] };
    const retrieval = fakeRetrieval(calls);
    const mk = () => createServer({ config, repos: () => [staticRepo('r', config, store)], modules: { retrieval: async () => retrieval }, emit: () => {} });
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

  it('multi-repo: lists repos when ambiguous and routes by repo param', async () => {
    const repos = [staticRepo('billing', config, store), staticRepo('docs', config, store)];
    const client = await connect(
      createServer({ config, repos: () => repos, multiRepo: true, allowRun: false, modules: { retrieval: async () => fakeRetrieval() }, emit: () => {} }),
    );
    const r1 = (await client.callTool({ name: 'kopt_find', arguments: { query: 'refund' } })) as any;
    expect(r1.isError).toBeFalsy();
    expect(r1.content[0].text).toBe('2 repos: billing, docs – pass repo:"<name>"');
    const r2 = (await client.callTool({ name: 'kopt_find', arguments: { query: 'refund', repo: 'Billing' } })) as any;
    expect(r2.content[0].text).toContain('computeRefund');
    const r3 = (await client.callTool({ name: 'kopt_find', arguments: { query: 'refund', repo: 'nope' } })) as any;
    expect(r3.isError).toBe(true);
    expect(r3.content[0].text).toContain('available: billing, docs');
    await client.close();
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
    expect(await repo.acquire()).toBe('index building: 3/10 files – retry shortly');
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

  it('reports a failed build in one line', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kopt-local-'));
    const cfg = defaultConfig(root);
    const repo = new LocalRepo(cfg, {
      modules: { indexer: async () => ({ indexRepo: async () => { throw new Error('parser exploded'); }, refreshIndex: async () => { throw new Error('x'); } }) } as Partial<Modules>,
      log: () => {},
    });
    const msg = await repo.acquire();
    expect(msg).toMatch(/^index unavailable: parser exploded – run 'kopt index'/);
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
