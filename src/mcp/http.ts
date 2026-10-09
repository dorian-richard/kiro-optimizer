// Central HTTP mode: Streamable HTTP MCP over multiple repo snapshots, OAuth bearer auth, telemetry ingest.
//
// Layout: <reposDir>/<repo>/index.db (snapshots built with `kopt index --snapshot`, blobs included since the
// server has no checkout). Snapshots are reloaded when index.db changes; publish them by rename, not in place.
// No command execution here: kopt_run / kopt_expand are not registered and KOPT_DISABLE_RUN=1.

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { defaultConfig, type KoptConfig } from '../core/config.js';
import { META, SCHEMA_VERSION } from '../store/schema.js';
import { Store } from '../store/store.js';
import { Authenticator, principalOf, repoAllowed, type AuthOptions, type Principal } from './auth.js';
import { toEmf } from './emf.js';
import type { Modules } from './modules.js';
import { createServer, type RepoHandle } from './server.js';

const MAX_MCP_BODY = 4 * 1024 * 1024;
const MAX_TELEMETRY_BODY = 8 * 1024 * 1024;
const MAX_TELEMETRY_INFLATED = 64 * 1024 * 1024;

type Log = (msg: string) => void;
const stderrLog: Log = (m) => process.stderr.write(`kopt: ${m}\n`);

/** A read-only snapshot repo. */
class SnapshotRepo implements RepoHandle {
  constructor(
    readonly name: string,
    readonly config: KoptConfig,
    public store: Store,
    public stamp: string,
  ) {}

  async acquire(): Promise<Store | string> {
    return this.store;
  }
}

function dbStamp(path: string): string | undefined {
  try {
    const s = statSync(path);
    return s.isFile() ? `${s.ino}:${s.mtimeMs}:${s.size}` : undefined;
  } catch {
    return undefined;
  }
}

/** Repos = subdirectories of `dir` holding an index.db. Rescanned periodically; changed snapshots are reopened. */
export class RepoRegistry {
  private repos = new Map<string, SnapshotRepo>();

  constructor(
    readonly dir: string,
    private readonly base: KoptConfig,
    private readonly log: Log = stderrLog,
  ) {}

  scan(): void {
    let entries: string[] = [];
    try {
      entries = readdirSync(this.dir, { withFileTypes: true })
        .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith('.'))
        .map((d) => d.name);
    } catch (err) {
      this.log(`cannot read repos dir ${this.dir}: ${(err as Error).message}`);
    }
    const seen = new Set<string>();
    for (const name of entries) {
      const path = join(this.dir, name, 'index.db');
      const stamp = dbStamp(path);
      if (!stamp) continue;
      seen.add(name);
      const cur = this.repos.get(name);
      if (cur && cur.stamp === stamp) continue;
      let store: Store | undefined;
      try {
        store = Store.open(path, { readonly: true });
        const v = store.getMeta(META.schemaVersion);
        if (v !== undefined && Number(v) !== SCHEMA_VERSION) throw new Error(`schema v${v}, expected v${SCHEMA_VERSION}`);
      } catch (err) {
        try {
          store?.close();
        } catch {
          // ignore
        }
        // Keep serving the previous snapshot, if any (e.g. a copy still in progress).
        this.log(`skipping snapshot ${path}: ${(err as Error).message}`);
        continue;
      }
      if (cur) {
        // Retrieval calls are synchronous, so no query is in flight on the old handle here.
        const old = cur.store;
        cur.store = store;
        cur.stamp = stamp;
        try {
          old.close();
        } catch {
          // ignore
        }
        this.log(`reloaded ${name}`);
      } else {
        const root = join(this.dir, name);
        const config: KoptConfig = { ...this.base, root, dataDir: root, central: { ...this.base.central, repoName: name } };
        this.repos.set(name, new SnapshotRepo(name, config, store, stamp));
        this.log(`loaded ${name}`);
      }
    }
    for (const [name, repo] of this.repos) {
      if (seen.has(name)) continue;
      try {
        repo.store.close();
      } catch {
        // ignore
      }
      this.repos.delete(name);
      this.log(`removed ${name}`);
    }
  }

  list(): RepoHandle[] {
    return [...this.repos.values()];
  }

  get size(): number {
    return this.repos.size;
  }

  close(): void {
    for (const r of this.repos.values()) {
      try {
        r.store.close();
      } catch {
        // ignore
      }
    }
    this.repos.clear();
  }
}

export interface HttpOptions {
  port: number;
  host?: string;
  reposDir: string;
  auth?: AuthOptions;
  /** Remote command execution is never allowed in HTTP mode. */
  allowRun?: false;
  /** Base config (budgets, dedup). Default: defaults for reposDir. */
  config?: KoptConfig;
  /** Optional NDJSON file receiving every ingested telemetry event. */
  telemetryFile?: string;
  modules?: Partial<Modules>;
  repoCheckMs?: number;
  sessionIdleMs?: number;
  maxSessions?: number;
  /** EMF line writer. Default: stdout (free in HTTP mode: MCP does not use it). */
  emfOut?: (line: string) => void;
  /** Shared by all replicas so any of them can resume a session (default env KOPT_SESSION_SECRET; unset = per process). */
  sessionSecret?: string;
  log?: Log;
}

export interface HttpHandle {
  server: HttpServer;
  port: number;
  url: string;
  registry: RepoRegistry;
  close(): Promise<void>;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  owner: string;
  lastSeen: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > limit) {
      req.resume();
      return reject(new HttpError(413, 'payload too large'));
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on('data', (c: Buffer) => {
      if (failed) return;
      size += c.length;
      if (size > limit) {
        failed = true;
        reject(new HttpError(413, 'payload too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => !failed && resolve(Buffer.concat(chunks)));
    req.on('error', (err) => !failed && reject(err));
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers });
  res.end(data);
}

function rpcError(res: ServerResponse, status: number, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null });
}

const ownerKey = (p?: Principal) => (p ? `${p.sub ?? ''}|${p.user ?? ''}` : '');

export async function serveHttp(o: HttpOptions): Promise<HttpHandle> {
  process.env.KOPT_DISABLE_RUN = '1';
  const log = o.log ?? stderrLog;
  const emfOut = o.emfOut ?? ((line: string) => void process.stdout.write(line + '\n'));
  const base = o.config ?? defaultConfig(o.reposDir);
  if (!existsSync(o.reposDir)) throw new Error(`repos dir not found: ${o.reposDir}`);
  const auth = o.auth ? new Authenticator(o.auth) : undefined;
  if (!auth) log('WARNING: no auth configured; every client can query every repo');
  else if (!o.auth!.audience && !o.auth!.clientId) log('WARNING: no audience/client id configured; any token from the issuer is accepted');

  const registry = new RepoRegistry(o.reposDir, base, log);
  registry.scan();
  const scanTimer = setInterval(() => registry.scan(), o.repoCheckMs ?? 60_000);
  scanTimer.unref();

  const sessions = new Map<string, Session>();
  const idleMs = o.sessionIdleMs ?? 30 * 60_000;
  const maxSessions = o.maxSessions ?? 2000;
  const reaper = setInterval(() => {
    const cutoff = Date.now() - idleMs;
    for (const s of sessions.values()) if (s.lastSeen < cutoff) void s.transport.close().catch(() => {});
  }, Math.min(60_000, idleMs));
  reaper.unref();

  const visibleRepos = (info?: AuthInfo): RepoHandle[] => {
    const p = principalOf(info);
    return registry.list().filter((r) => repoAllowed(p, r.name));
  };

  /** Returns the auth result, or undefined after having answered 401/403. */
  const authenticate = async (
    req: IncomingMessage,
    res: ServerResponse,
    route: 'mcp' | 'telemetry' = 'mcp',
  ): Promise<{ info?: AuthInfo; principal?: Principal } | undefined> => {
    if (!auth) return {};
    const out = await auth.authenticate(req.headers, route);
    if (out.ok) return { info: out.info, principal: out.principal };
    res.writeHead(out.status, out.headers);
    res.end(out.body);
    return undefined;
  };

  // Session ids are HMAC-bound to the principal. With a secret shared by all replicas (KOPT_SESSION_SECRET), any
  // replica can resume a session it has never seen (ALB without stickiness, rolling deploys): the client keeps
  // working instead of hitting 404 + re-initialize; only the per-session dedup ledger starts empty.
  const secret = o.sessionSecret ?? process.env.KOPT_SESSION_SECRET;
  const key = secret ? Buffer.from(secret, 'utf8') : randomBytes(32);
  const mac = (id: string, owner: string) => createHmac('sha256', key).update(`${id}\0${owner}`).digest('base64url').slice(0, 22);
  const newSid = (owner: string) => {
    const id = randomUUID();
    return `${id}.${mac(id, owner)}`;
  };
  const sidValid = (sid: string, owner: string) => {
    const [id, tag] = sid.split('.');
    if (!id || !tag) return false;
    const want = Buffer.from(mac(id, owner));
    const got = Buffer.from(tag);
    return got.length === want.length && timingSafeEqual(want, got);
  };

  const openSession = async (req: IncomingMessage, a: { info?: AuthInfo; principal?: Principal }, resumeSid?: string): Promise<Session | undefined> => {
    if (sessions.size >= maxSessions) {
      const oldest = [...sessions.values()].sort((x, y) => x.lastSeen - y.lastSeen)[0];
      await oldest?.transport.close().catch(() => {});
    }
    const owner = ownerKey(a.principal);
    const user = a.principal?.user;
    // Workspace-level default repo, set by `kopt init --remote` in mcp.json headers: saves a `repo` arg per call.
    const hdr = req.headers['x-kopt-repo'];
    const defaultRepo = typeof hdr === 'string' && hdr.trim() ? hdr.trim() : undefined;
    const mcp = createServer({
      defaultRepo,
      config: base,
      repos: visibleRepos,
      multiRepo: true,
      allowRun: false,
      modules: o.modules,
      auth: a.info,
      emit: (e) => {
        const line = toEmf(e, user);
        if (line) emfOut(line);
      },
    });
    let session: Session | undefined;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => resumeSid ?? newSid(owner),
      // Plain JSON responses: tools never stream, and JSON survives ALB/API Gateway buffering and timeouts.
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        sessions.set(id, session!);
      },
    });
    session = { transport, server: mcp, owner, lastSeen: Date.now() };
    transport.onclose = () => {
      if (transport.sessionId && sessions.get(transport.sessionId) === session) sessions.delete(transport.sessionId);
    };
    if (resumeSid) {
      // The SDK has no public "resume" API: mark the transport as already initialized for this id.
      const inner = (transport as unknown as { _webStandardTransport?: { _initialized?: boolean; sessionId?: string } })._webStandardTransport;
      if (!inner || inner._initialized !== false) return undefined;
      inner._initialized = true;
      inner.sessionId = resumeSid;
      sessions.set(resumeSid, session);
      log(`resumed session ${resumeSid.slice(0, 8)}`);
    }
    await mcp.connect(transport);
    return session;
  };

  const handleMcp = async (req: IncomingMessage, res: ServerResponse, a: { info?: AuthInfo; principal?: Principal }) => {
    const sid = req.headers['mcp-session-id'];
    const owner = ownerKey(a.principal);
    if (a.info) (req as IncomingMessage & { auth?: AuthInfo }).auth = a.info;
    /** Live session of this principal, or a resumed one when the id is ours (signed for this principal). */
    const sessionFor = async (id: string, resume: boolean): Promise<Session | undefined> => {
      const s = sessions.get(id);
      // Sessions are bound to the principal that created them (no session hijacking with another token).
      if (s) return s.owner === owner ? s : undefined;
      return resume && sidValid(id, owner) ? openSession(req, a, id) : undefined;
    };

    if (req.method === 'POST') {
      let body: unknown;
      try {
        body = JSON.parse((await readBody(req, MAX_MCP_BODY)).toString('utf8'));
      } catch (err) {
        if (err instanceof HttpError) return rpcError(res, err.status, -32600, err.message);
        return rpcError(res, 400, -32700, 'Parse error');
      }
      const isInit = Array.isArray(body) ? body.some((m) => isInitializeRequest(m)) : isInitializeRequest(body);
      if (typeof sid === 'string' && !isInit) {
        const s = await sessionFor(sid, true);
        if (!s) return rpcError(res, 404, -32001, 'Session not found');
        s.lastSeen = Date.now();
        return s.transport.handleRequest(req, res, body);
      }
      if (!isInit) return rpcError(res, 400, -32000, 'Bad Request: No valid session ID provided');
      const s = await openSession(req, a);
      return s!.transport.handleRequest(req, res, body);
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      if (typeof sid !== 'string') return rpcError(res, 400, -32000, 'Bad Request: Mcp-Session-Id header is required');
      const s = await sessionFor(sid, req.method === 'GET');
      if (!s) return rpcError(res, 404, -32001, 'Session not found');
      s.lastSeen = Date.now();
      return s.transport.handleRequest(req, res);
    }

    res.writeHead(405, { Allow: 'GET, POST, DELETE' });
    res.end();
  };

  const handleTelemetry = async (req: IncomingMessage, res: ServerResponse, a: { principal?: Principal }) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' });
      return res.end();
    }
    let raw: Buffer;
    try {
      raw = await readBody(req, MAX_TELEMETRY_BODY);
      const enc = String(req.headers['content-encoding'] ?? '').toLowerCase();
      if (enc.includes('gzip') || (raw[0] === 0x1f && raw[1] === 0x8b)) raw = gunzipSync(raw, { maxOutputLength: MAX_TELEMETRY_INFLATED });
    } catch (err) {
      return sendJson(res, err instanceof HttpError ? err.status : 400, { error: (err as Error).message });
    }
    const text = raw.toString('utf8');
    let items: unknown[];
    const trimmed = text.trimStart();
    if (trimmed.startsWith('[')) {
      try {
        items = JSON.parse(trimmed);
      } catch {
        return sendJson(res, 400, { error: 'invalid JSON array' });
      }
    } else {
      items = [];
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          items.push(JSON.parse(t));
        } catch {
          items.push(undefined);
        }
      }
    }
    // The authenticated identity wins over whatever the client claims.
    const user = a.principal?.user;
    let accepted = 0;
    let rejected = 0;
    const sinkLines: string[] = [];
    for (const ev of items) {
      if (!ev || typeof ev !== 'object' || Array.isArray(ev)) {
        rejected++;
        continue;
      }
      const e = user ? { ...(ev as Record<string, unknown>), user } : (ev as Record<string, unknown>);
      const line = toEmf(e, user);
      if (line) emfOut(line);
      if (o.telemetryFile) sinkLines.push(JSON.stringify(e));
      accepted++;
    }
    if (o.telemetryFile && sinkLines.length) {
      try {
        await appendFile(o.telemetryFile, sinkLines.join('\n') + '\n');
      } catch (err) {
        log(`telemetry sink: ${(err as Error).message}`);
      }
    }
    sendJson(res, 202, { accepted, rejected });
  };

  const server = createHttpServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/\/+$/, '') || '/';
      try {
        if (path === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
          return sendJson(res, 200, { status: 'ok', repos: registry.size, sessions: sessions.size });
        }
        if (path.startsWith('/.well-known/oauth-protected-resource')) {
          if (!auth) return sendJson(res, 404, { error: 'auth not configured' });
          return sendJson(res, 200, auth.protectedResourceMetadata(), { 'Cache-Control': 'public, max-age=3600' });
        }
        if (auth?.servesAuthServerMetadata && (path.startsWith('/.well-known/oauth-authorization-server') || path === '/.well-known/openid-configuration')) {
          return sendJson(res, 200, await auth.authorizationServerMetadata(), { 'Cache-Control': 'public, max-age=3600' });
        }
        if (path === '/mcp') {
          const a = await authenticate(req, res);
          if (a) await handleMcp(req, res, a);
          return;
        }
        if (path === '/telemetry') {
          const a = await authenticate(req, res, 'telemetry');
          if (a) await handleTelemetry(req, res, a);
          return;
        }
        sendJson(res, 404, { error: 'not found' });
      } catch (err) {
        log(`${req.method} ${path}: ${(err as Error)?.stack ?? err}`);
        if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
        else res.end();
      }
    })();
  });
  server.keepAliveTimeout = 65_000; // above ALB's 60s idle timeout, avoids 502s on reused connections

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, o.host ?? '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const host = o.host && o.host !== '0.0.0.0' && o.host !== '::' ? o.host : 'localhost';
  log(`serving ${registry.size} repo(s) from ${o.reposDir} on http://${host}:${port}/mcp${auth ? ' (auth on)' : ''}`);

  return {
    server,
    port,
    url: `http://${host}:${port}`,
    registry,
    close: async () => {
      clearInterval(scanTimer);
      clearInterval(reaper);
      await Promise.all([...sessions.values()].map((s) => s.transport.close().catch(() => {})));
      sessions.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      registry.close();
    },
  };
}
