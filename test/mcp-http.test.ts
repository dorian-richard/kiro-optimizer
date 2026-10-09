import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { createServer as createHttp, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { defaultConfig } from '../src/core/config.js';
import { estimateTokens } from '../src/core/tokens.js';
import type { ToolResult } from '../src/core/types.js';
import { META } from '../src/store/schema.js';
import { Store, symbolHandle } from '../src/store/store.js';
import { serveHttp, type HttpHandle } from '../src/mcp/http.js';
import { toEmf } from '../src/mcp/emf.js';
import type { RetrievalModule } from '../src/mcp/modules.js';

const TEXT = 'export function computeRefund(order: Order): number {\n  return order.total - order.fees;\n}\n';

function seedSnapshot(path: string, symbol: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const s = Store.open(path);
  s.transaction(() => {
    s.prepare('INSERT INTO files(id, path, lang, hash, size, line_count, mtime_ms, rank, indexed_at) VALUES (1,?,?,?,?,?,0,0.5,?)').run(
      'src/refund.ts', 'typescript', 'h', TEXT.length, 3, Date.now(),
    );
    s.prepare(
      `INSERT INTO symbols(id, file_id, name, qname, kind, start_line, end_line, start_byte, end_byte, signature, exported, rank)
       VALUES (7, 1, ?, ?, 'function', 1, 3, 0, ?, ?, 1, 0.5)`,
    ).run(symbol, symbol, TEXT.length, `export function ${symbol}(order: Order): number`);
    s.prepare('INSERT INTO blobs(file_id, content) VALUES (1, ?)').run(gzipSync(TEXT));
  });
  s.setMeta(META.indexedAt, String(Date.now()));
  s.setMeta(META.origin, 'snapshot');
  s.db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');
  s.close();
}

/** Contract-shaped retrieval stand-in: proves the call reached the right snapshot (reads the blob). */
const retrieval: RetrievalModule = {
  find(store, p) {
    const rows = store.prepare('SELECT s.id, s.name, s.start_line, s.end_line, f.path FROM symbols s JOIN files f ON f.id = s.file_id').all() as any[];
    const text = `find "${p.query}" · ${rows.length} hits\n` + rows.map((r) => `${r.path}:${r.start_line}-${r.end_line} ${symbolHandle(r.id)} ${r.name}`).join('\n');
    return { text, tokens: estimateTokens(text) } satisfies ToolResult;
  },
  read(store, p) {
    const text = `src/refund.ts:1-3\n${store.readText('src/refund.ts') ?? ''}`;
    return { text: p.target ? text : '', tokens: estimateTokens(text) };
  },
  outline: () => ({ text: 'outline', tokens: 3 }),
  refs: () => ({ text: 'refs', tokens: 2 }),
};

let dir: string;
let jwks: Server;
let issuer: string;
let privateKey: CryptoKey;
let h: HttpHandle;
const RESOURCE = 'https://kopt.example.com';

async function token(claims: Record<string, unknown>, opts: { iss?: string; exp?: string } = {}): Promise<string> {
  return new SignJWT({ client_id: 'kiro-client', scope: 'openid kopt/read', token_use: 'access', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(opts.iss ?? issuer)
    .setSubject(String(claims.username ?? 'anon'))
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '5m')
    .sign(privateKey);
}

async function mcpClient(bearer: string): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(`${h.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(transport);
  return { client, transport };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kopt-http-'));
  seedSnapshot(join(dir, 'repos', 'billing', 'index.db'), 'computeRefund');
  seedSnapshot(join(dir, 'repos', 'docs', 'index.db'), 'renderDocs');
  const acl = join(dir, 'acl.json');
  (await import('node:fs')).writeFileSync(acl, JSON.stringify({ 'team-billing': ['billing'], admins: ['*'] }));

  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  jwks = createHttp((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/jwks.json') return res.end(JSON.stringify({ keys: [jwk] }));
    if (req.url === '/.well-known/openid-configuration') {
      // Cognito-like discovery: no code_challenge_methods_supported.
      return res.end(JSON.stringify({ issuer, authorization_endpoint: 'https://auth.example.com/oauth2/authorize', token_endpoint: 'https://auth.example.com/oauth2/token', jwks_uri: `${issuer}/jwks.json` }));
    }
    res.writeHead(404).end('{}');
  });
  await new Promise<void>((r) => jwks.listen(0, '127.0.0.1', r));
  issuer = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}`;

  h = await serveHttp({
    port: 0,
    host: '127.0.0.1',
    reposDir: join(dir, 'repos'),
    config: defaultConfig(dir),
    modules: { retrieval: async () => retrieval },
    telemetryFile: join(dir, 'telemetry.ndjson'),
    log: () => {},
    auth: {
      issuer,
      clientId: 'kiro-client',
      jwksUrl: `${issuer}/jwks.json`,
      requiredScopes: ['kopt/read'],
      resourceUrl: RESOURCE,
      reposAcl: acl,
    },
  });
});

afterAll(async () => {
  await h?.close();
  await new Promise<void>((r) => jwks.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

describe('HTTP server', () => {
  it('serves /healthz without auth', async () => {
    const res = await fetch(`${h.url}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', repos: 2 });
    expect(process.env.KOPT_DISABLE_RUN).toBe('1');
  });

  it('serves RFC 9728 protected resource metadata', async () => {
    const res = await fetch(`${h.url}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      resource: RESOURCE,
      authorization_servers: [issuer],
      scopes_supported: ['kopt/read'],
      bearer_methods_supported: ['header'],
      resource_name: 'KiroOptimizer',
    });
  });

  it('challenges missing and invalid tokens with WWW-Authenticate', async () => {
    const init = { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{}' };
    const r1 = await fetch(`${h.url}/mcp`, init);
    expect(r1.status).toBe(401);
    expect(r1.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${RESOURCE}/.well-known/oauth-protected-resource", scope="kopt/read"`,
    );
    const r2 = await fetch(`${h.url}/mcp`, { ...init, headers: { ...init.headers, Authorization: 'Bearer not.a.jwt' } });
    expect(r2.status).toBe(401);
    expect(r2.headers.get('www-authenticate')).toMatch(
      new RegExp(`^Bearer resource_metadata="${RESOURCE}/\\.well-known/oauth-protected-resource", error="invalid_token"`),
    );
    const expired = await token({ username: 'alice', 'cognito:groups': ['admins'] }, { exp: '-10m' });
    const r3 = await fetch(`${h.url}/mcp`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${expired}` } });
    expect(r3.status).toBe(401);
    const noExp = await new SignJWT({ client_id: 'kiro-client', scope: 'kopt/read', username: 'alice' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(issuer)
      .sign(privateKey);
    expect((await fetch(`${h.url}/mcp`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${noExp}` } })).status).toBe(401);
    const wrongIss = await token({ username: 'alice' }, { iss: 'https://evil.example.com' });
    expect((await fetch(`${h.url}/mcp`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${wrongIss}` } })).status).toBe(401);
    const wrongClient = await token({ username: 'alice', client_id: 'other' });
    const r4 = await fetch(`${h.url}/mcp`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${wrongClient}` } });
    expect(r4.status).toBe(401);
    const noScope = await token({ username: 'alice', scope: 'openid' });
    const r5 = await fetch(`${h.url}/mcp`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${noScope}` } });
    expect(r5.status).toBe(403);
    expect(r5.headers.get('www-authenticate')).toContain('error="insufficient_scope"');
  });

  it('valid token: initialize + tools/list over Streamable HTTP, no kopt_run, repo routing', async () => {
    const { client } = await mcpClient(await token({ username: 'alice', 'cognito:groups': ['admins'] }));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['kopt_find', 'kopt_read', 'kopt_outline', 'kopt_refs']);
    expect((tools[0].inputSchema as any).properties.repo).toBeDefined();
    expect(client.getInstructions()).toContain('billing, docs');

    const ambiguous = (await client.callTool({ name: 'kopt_find', arguments: { query: 'refund' } })) as any;
    expect(ambiguous.content[0].text).toBe('2 repos: billing, docs – pass repo:"<name>"');
    const hit = (await client.callTool({ name: 'kopt_find', arguments: { query: 'refund', repo: 'billing' } })) as any;
    expect(hit.content[0].text).toContain('computeRefund');
    const body = (await client.callTool({ name: 'kopt_read', arguments: { target: '#7', repo: 'billing' } })) as any;
    expect(body.content[0].text).toContain('order.total - order.fees'); // from the snapshot blob
    const run = (await client.callTool({ name: 'kopt_run', arguments: { command: 'id' } })) as any;
    expect(run.isError).toBe(true);
    await client.close();
  });

  it('uses the X-Kopt-Repo header as the session default repo', async () => {
    const bearer = await token({ username: 'alice', 'cognito:groups': ['admins'] });
    const transport = new StreamableHTTPClientTransport(new URL(`${h.url}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${bearer}`, 'X-Kopt-Repo': 'docs' } },
    });
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(transport);
    expect(client.getInstructions()).toContain('Default repo: docs');
    const r = (await client.callTool({ name: 'kopt_find', arguments: { query: 'x' } })) as any;
    expect(r.content[0].text).toContain('renderDocs');
    const other = (await client.callTool({ name: 'kopt_find', arguments: { query: 'x', repo: 'billing' } })) as any;
    expect(other.content[0].text).toContain('computeRefund');
    await client.close();
  });

  it('filters repos by group ACL and binds sessions to their principal', async () => {
    const { client, transport } = await mcpClient(await token({ username: 'bob', 'cognito:groups': ['team-billing'] }));
    const r1 = (await client.callTool({ name: 'kopt_find', arguments: { query: 'x' } })) as any;
    expect(r1.content[0].text).toContain('computeRefund'); // single visible repo is implicit
    const r2 = (await client.callTool({ name: 'kopt_find', arguments: { query: 'x', repo: 'docs' } })) as any;
    expect(r2.isError).toBe(true);
    expect(r2.content[0].text).toBe('unknown repo "docs"; available: billing');

    // Another principal cannot ride on bob's session id.
    const mallory = await token({ username: 'mallory', 'cognito:groups': ['admins'] });
    const res = await fetch(`${h.url}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${mallory}`,
        'mcp-session-id': transport.sessionId!,
        'mcp-protocol-version': '2025-06-18',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(404);
    await client.close();

    const { client: nobody } = await mcpClient(await token({ username: 'eve', 'cognito:groups': ['interns'] }));
    const r3 = (await nobody.callTool({ name: 'kopt_find', arguments: { query: 'x' } })) as any;
    expect(r3.content[0].text).toBe('no repositories available to you');
    await nobody.close();
  });

  it('reloads a snapshot replaced by rename', async () => {
    const live = join(dir, 'repos', 'docs', 'index.db');
    const next = join(dir, 'next', 'index.db');
    seedSnapshot(next, 'renderDocsV2');
    renameSync(next, live);
    h.registry.scan();
    const { client } = await mcpClient(await token({ username: 'alice', 'cognito:groups': ['admins'] }));
    const r = (await client.callTool({ name: 'kopt_find', arguments: { query: 'x', repo: 'docs' } })) as any;
    expect(r.content[0].text).toContain('renderDocsV2');
    await client.close();
  });

  it('ingests gzipped NDJSON telemetry as CloudWatch EMF on stdout', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: any) => {
      lines.push(String(chunk));
      return true;
    }) as any);
    try {
      const ndjson = [
        JSON.stringify({ ts: Date.now(), kind: 'tool', tool: 'kopt_find', repo: 'billing', tokensOut: 120, baselineTokens: 900, user: 'spoofed' }),
        'not json',
        JSON.stringify({ ts: Date.now(), kind: 'credits', credits: 1.25, session: 's' }),
      ].join('\n');
      const unauth = await fetch(`${h.url}/telemetry`, { method: 'POST', body: ndjson });
      expect(unauth.status).toBe(401);
      const res = await fetch(`${h.url}/telemetry`, {
        method: 'POST',
        headers: { 'Content-Encoding': 'gzip', 'Content-Type': 'application/x-ndjson', Authorization: `Bearer ${await token({ username: 'carol' })}` },
        body: gzipSync(ndjson),
      });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ accepted: 2, rejected: 1 });
    } finally {
      spy.mockRestore();
    }
    const emf = lines.map((l) => JSON.parse(l));
    expect(emf).toHaveLength(2);
    expect(emf[0]._aws.CloudWatchMetrics[0]).toEqual({
      Namespace: 'KiroOptimizer',
      Dimensions: [['Tool']],
      Metrics: [
        { Name: 'Calls', Unit: 'Count' },
        { Name: 'TokensOut', Unit: 'Count' },
        { Name: 'BaselineTokens', Unit: 'Count' },
      ],
    });
    expect(emf[0]).toMatchObject({ Tool: 'kopt_find', Repo: 'billing', Calls: 1, TokensOut: 120, BaselineTokens: 900, User: 'carol' });
    expect(emf[1]._aws.CloudWatchMetrics[0].Dimensions).toEqual([[]]);
    expect(emf[1].Credits).toBe(1.25);
    const sink = readFileSync(join(dir, 'telemetry.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(sink).toHaveLength(2);
    expect(sink[0].user).toBe('carol'); // authenticated identity wins
  });

  it('toEmf skips events without metrics', () => {
    expect(toEmf({ kind: 'session' })).toBeUndefined();
  });

  it('toEmf adds the [Repo] dimension only when enabled', () => {
    const e = { kind: 'tool' as const, tool: 'kopt_find', repo: 'billing', tokensOut: 5 };
    const off = JSON.parse(toEmf(e)!);
    expect(off._aws.CloudWatchMetrics[0].Dimensions).toEqual([['Tool']]);
    expect(off.Repo).toBe('billing');
    expect(JSON.parse(toEmf(e, undefined, { repoDimension: true })!)._aws.CloudWatchMetrics[0].Dimensions).toEqual([['Tool'], ['Repo']]);
    const prev = process.env.KOPT_EMF_REPO_DIMENSION;
    process.env.KOPT_EMF_REPO_DIMENSION = '1';
    try {
      expect(JSON.parse(toEmf(e)!)._aws.CloudWatchMetrics[0].Dimensions).toEqual([['Tool'], ['Repo']]);
    } finally {
      if (prev === undefined) delete process.env.KOPT_EMF_REPO_DIMENSION;
      else process.env.KOPT_EMF_REPO_DIMENSION = prev;
    }
  });
});

describe('HTTP replicas sharing a session secret', () => {
  it('resume a session created by another replica; other secrets and principals get 404', async () => {
    const d = mkdtempSync(join(tmpdir(), 'kopt-http-rep-'));
    seedSnapshot(join(d, 'billing', 'index.db'), 'computeRefund');
    const common = { port: 0, host: '127.0.0.1', reposDir: d, modules: { retrieval: async () => retrieval }, log: () => {}, emfOut: () => {} };
    const auth = { issuer, clientId: 'kiro-client', jwksUrl: `${issuer}/jwks.json`, resourceUrl: RESOURCE };
    const a = await serveHttp({ ...common, auth, sessionSecret: 'shared' });
    const b = await serveHttp({ ...common, auth, sessionSecret: 'shared' });
    const c = await serveHttp({ ...common, auth, sessionSecret: 'other' });
    try {
      const bearer = await token({ username: 'alice' });
      const transport = new StreamableHTTPClientTransport(new URL(`${a.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } });
      const client = new Client({ name: 'test', version: '0' });
      await client.connect(transport);
      const sid = transport.sessionId!;
      expect(sid).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{22}$/);
      const call = (url: string, bearerToken: string) =>
        fetch(`${url}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            Authorization: `Bearer ${bearerToken}`,
            'mcp-session-id': sid,
            'mcp-protocol-version': '2025-06-18',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'kopt_find', arguments: { query: 'refund' } } }),
        });
      const resumed = await call(b.url, bearer);
      expect(resumed.status).toBe(200);
      expect(resumed.headers.get('mcp-session-id')).toBe(sid);
      expect(JSON.stringify(await resumed.json())).toContain('computeRefund');
      expect((await call(c.url, bearer)).status).toBe(404);
      expect((await call(b.url, await token({ username: 'mallory' }))).status).toBe(404);
      await client.close();
    } finally {
      await Promise.all([a.close(), b.close(), c.close()]);
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('HTTP server with a separate telemetry scope', () => {
  it('requires telemetryScopes on /telemetry and requiredScopes on /mcp', async () => {
    const d = mkdtempSync(join(tmpdir(), 'kopt-http-tel-'));
    seedSnapshot(join(d, 'billing', 'index.db'), 'computeRefund');
    const srv = await serveHttp({
      port: 0,
      host: '127.0.0.1',
      reposDir: d,
      modules: { retrieval: async () => retrieval },
      log: () => {},
      emfOut: () => {},
      auth: { issuer, clientId: 'kiro-client', jwksUrl: `${issuer}/jwks.json`, resourceUrl: RESOURCE, requiredScopes: ['kopt/mcp'], telemetryScopes: ['kopt/telemetry'] },
    });
    try {
      const body = JSON.stringify({ ts: Date.now(), kind: 'tool', tool: 'kopt_find', tokensOut: 1 });
      const post = async (scope: string) =>
        fetch(`${srv.url}/telemetry`, { method: 'POST', body, headers: { Authorization: `Bearer ${await token({ username: 'dev', scope })}` } });
      const mcp = async (scope: string) =>
        fetch(`${srv.url}/mcp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${await token({ username: 'dev', scope })}` },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }),
        });

      expect((await post('kopt/telemetry')).status).toBe(202);
      const denied = await post('kopt/mcp');
      expect(denied.status).toBe(403);
      expect(denied.headers.get('www-authenticate')).toContain('scope="kopt/telemetry"');
      const noCode = await mcp('kopt/telemetry');
      expect(noCode.status).toBe(403);
      expect(noCode.headers.get('www-authenticate')).toContain('scope="kopt/mcp"');
      expect((await mcp('kopt/mcp')).status).toBe(200);
    } finally {
      await srv.close();
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('HTTP server with an unreachable JWKS', () => {
  it('answers 503 instead of a 401 re-login loop', async () => {
    const d = mkdtempSync(join(tmpdir(), 'kopt-http-jwks-'));
    const s = await serveHttp({
      port: 0,
      host: '127.0.0.1',
      reposDir: d,
      log: () => {},
      auth: { issuer, clientId: 'kiro-client', jwksUrl: 'http://127.0.0.1:9/jwks.json', resourceUrl: RESOURCE },
    });
    try {
      const r = await fetch(`${s.url}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${await token({ username: 'a' })}` }, body: '{}' });
      expect(r.status).toBe(503);
      expect(r.headers.get('retry-after')).toBe('5');
    } finally {
      await s.close();
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('HTTP server with authServerMetadata: self', () => {
  it('advertises itself as authorization server and serves RFC 8414 metadata derived from the issuer', async () => {
    const d = mkdtempSync(join(tmpdir(), 'kopt-http-self-'));
    const s = await serveHttp({
      port: 0,
      host: '127.0.0.1',
      reposDir: d,
      log: () => {},
      auth: { issuer, clientId: 'kiro-client', jwksUrl: `${issuer}/jwks.json`, resourceUrl: 'https://kopt.example.com/mcp', authServerMetadata: 'self' },
    });
    try {
      const prm = await (await fetch(`${s.url}/.well-known/oauth-protected-resource/mcp`)).json();
      expect(prm).toMatchObject({ resource: 'https://kopt.example.com/mcp', authorization_servers: ['https://kopt.example.com'] });
      const as = await (await fetch(`${s.url}/.well-known/oauth-authorization-server`)).json();
      expect(as).toMatchObject({
        issuer: 'https://kopt.example.com',
        authorization_endpoint: 'https://auth.example.com/oauth2/authorize',
        token_endpoint: 'https://auth.example.com/oauth2/token',
        code_challenge_methods_supported: ['S256'],
      });
      const r = await fetch(`${s.url}/mcp`, { method: 'POST', body: '{}' });
      expect(r.headers.get('www-authenticate')).toBe('Bearer resource_metadata="https://kopt.example.com/.well-known/oauth-protected-resource/mcp"');
    } finally {
      await s.close();
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('HTTP server without auth', () => {
  it('serves MCP and 404s the protected resource metadata', async () => {
    const d = mkdtempSync(join(tmpdir(), 'kopt-http-noauth-'));
    seedSnapshot(join(d, 'only', 'index.db'), 'soloFn');
    const s = await serveHttp({ port: 0, host: '127.0.0.1', reposDir: d, modules: { retrieval: async () => retrieval }, log: () => {} });
    try {
      expect((await fetch(`${s.url}/.well-known/oauth-protected-resource`)).status).toBe(404);
      const client = new Client({ name: 't', version: '0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${s.url}/mcp`)));
      const r = (await client.callTool({ name: 'kopt_find', arguments: { query: 'solo' } })) as any;
      expect(r.content[0].text).toContain('soloFn');
      await client.close();
    } finally {
      await s.close();
      rmSync(d, { recursive: true, force: true });
    }
  });
});
