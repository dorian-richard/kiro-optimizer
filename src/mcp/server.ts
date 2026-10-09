// MCP server (transport-agnostic). One Server instance per MCP session/connection, so each session gets
// its own ToolContext (and dedup ledger) per repo.
//
// We use the low-level SDK `Server` rather than `McpServer.registerTool` to control the exact tools/list
// bytes (no $schema / additionalProperties noise, no titles): they are re-billed on every model turn.

import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { KoptConfig } from '../core/config.js';
import { newToolContext, type ToolContext } from '../core/context.js';
import type { TelemetryEvent } from '../core/types.js';
import type { Store } from '../store/store.js';
import { withModules, type Modules } from './modules.js';
import {
  compileTools,
  executeTool,
  oneLine,
  parseToolArgs,
  serverInstructions,
  toolDefinitions,
  toolNeedsStore,
  type ToolName,
  type ToolSetOptions,
} from './tools.js';

export const SERVER_NAME = 'kopt';
export const SERVER_VERSION = '0.1.0';

/** A repository the server can answer for. */
export interface RepoHandle {
  readonly name: string;
  /** Repo-specific config (root/dataDir); budgets & dedup settings come from here too. */
  readonly config: KoptConfig;
  /** A store ready for queries, or a one-line status to return instead (e.g. "index building: 12/400 files – retry shortly"). */
  acquire(): Promise<Store | string>;
  /**
   * Optional: wait until the repo is known (a user-level server learns its project root after `initialize`), then
   * resolve to a one-line message when no tool can run (e.g. no project folder open), else undefined.
   */
  prepare?(): Promise<string | undefined>;
}

export interface ServerDeps {
  /** Base config (telemetry sink, defaults). */
  config: KoptConfig;
  /** Repos visible to the caller; evaluated on every call with that request's auth (ACLs, new snapshots). */
  repos: (auth?: AuthInfo) => RepoHandle[];
  /** Adds the optional `repo` tool param (HTTP multi-repo server). */
  multiRepo?: boolean;
  /** Register kopt_run / kopt_expand. Default: true unless KOPT_DISABLE_RUN=1. */
  allowRun?: boolean;
  modules?: Partial<Modules>;
  /** Telemetry sink. Default: telemetry.record() (local JSONL). */
  emit?: (e: TelemetryEvent) => void;
  /** Session id when the transport has none (stdio). */
  sessionId?: string;
  /** Auth of the request that created the session (used for the instructions' repo list). */
  auth?: AuthInfo;
  /** Multi-repo: repo used when a call omits `repo` (e.g. from the client's X-Kopt-Repo header). */
  defaultRepo?: string;
}

/** Default sink: local JSONL through telemetry.record(), loaded eagerly, never throws. `ready` settles once loaded. */
export function localTelemetrySink(config: KoptConfig, modules: Modules): ((e: TelemetryEvent) => void) & { ready: Promise<unknown> } {
  const mod: Promise<{ record: (e: TelemetryEvent, c: KoptConfig) => void } | undefined> = config.telemetry.enabled
    ? modules.telemetry().catch(() => undefined)
    : Promise.resolve(undefined);
  const sink = (e: TelemetryEvent) => {
    void mod.then((m) => {
      try {
        m?.record(e, config);
      } catch {
        // telemetry is best effort
      }
    });
  };
  return Object.assign(sink, { ready: mod });
}

function text(t: string, isError = false): CallToolResult {
  return isError ? { content: [{ type: 'text', text: t }], isError: true } : { content: [{ type: 'text', text: t }] };
}

/** A RepoHandle (as opposed to pickRepo's one-line answer). Checks behaviour, not field names. */
export function isRepoHandle(x: RepoHandle | { message: string; isError: boolean }): x is RepoHandle {
  return typeof (x as RepoHandle).acquire === 'function';
}

/** Pick the repo for a call. Returns a one-line message when the caller must choose. */
export function pickRepo(visible: RepoHandle[], requested: string | undefined, multiRepo: boolean): RepoHandle | { message: string; isError: boolean } {
  if (!multiRepo) return visible[0] ?? { message: 'no repository configured', isError: true };
  const names = () => visible.map((r) => r.name).sort().join(', ');
  if (requested) {
    const want = requested.toLowerCase();
    const hit = visible.find((r) => r.name === requested) ?? visible.find((r) => r.name.toLowerCase() === want);
    if (hit) return hit;
    return { message: visible.length ? `unknown repo "${requested}"; available: ${names()}` : 'no repositories available to you', isError: true };
  }
  if (visible.length === 1) return visible[0];
  if (visible.length === 0) return { message: 'no repositories available to you', isError: true };
  return { message: `${visible.length} repos: ${names()} – pass repo:"<name>"`, isError: false };
}

export function createServer(deps: ServerDeps): Server {
  const modules = withModules(deps.modules);
  const opts: ToolSetOptions = {
    allowRun: deps.allowRun ?? process.env.KOPT_DISABLE_RUN !== '1',
    multiRepo: !!deps.multiRepo,
  };
  const tools = compileTools(opts);
  const definitions = toolDefinitions(opts);
  const emit = deps.emit ?? localTelemetrySink(deps.config, modules);
  const fallbackSession = deps.sessionId ?? randomUUID();

  let initialRepos: string[] = [];
  if (opts.multiRepo) {
    try {
      initialRepos = deps.repos(deps.auth).map((r) => r.name).sort();
    } catch {
      initialRepos = [];
    }
  }

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: serverInstructions({ ...opts, repos: initialRepos, defaultRepo: deps.defaultRepo }) },
  );

  // One ToolContext per repo for the lifetime of this session: dedup ledger keys are per-repo symbol ids.
  const contexts = new Map<string, ToolContext>();
  const contextFor = (repo: RepoHandle, session: string): ToolContext => {
    let ctx = contexts.get(repo.name);
    if (!ctx) {
      ctx = newToolContext(repo.config, emit, session, repo.name);
      contexts.set(repo.name, ctx);
    }
    return ctx;
  };

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: definitions }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra): Promise<CallToolResult> => {
    const name = req.params.name as ToolName;
    if (!tools.has(name)) return text(`unknown tool ${req.params.name}`, true);
    const parsed = parseToolArgs(name, req.params.arguments, opts);
    if (!parsed.ok) return text(`${name}: ${parsed.message}`, true);

    let visible: RepoHandle[];
    try {
      visible = deps.repos(extra.authInfo ?? deps.auth);
    } catch (err) {
      return text(`${name} failed: ${oneLine((err as Error)?.message ?? String(err))}`, true);
    }
    const picked = pickRepo(visible, parsed.repo ?? deps.defaultRepo, opts.multiRepo);
    if (!isRepoHandle(picked)) return text(picked.message, picked.isError);
    const repo = picked;
    if (repo.prepare) {
      const unavailable = await repo.prepare().catch((err: unknown) => `${name} failed: ${oneLine((err as Error)?.message ?? String(err))}`);
      if (unavailable) return text(unavailable);
    }

    const ctx = contextFor(repo, extra.sessionId ?? fallbackSession);
    let store: Store | undefined;
    if (toolNeedsStore(name)) {
      let s: Store | string;
      try {
        s = await repo.acquire();
      } catch (err) {
        return text(`${name} failed: index unavailable: ${oneLine((err as Error)?.message ?? String(err))}`, true);
      }
      if (typeof s === 'string') return text(s);
      store = s;
    }
    const r = await executeTool(name, parsed.args, { modules, ctx, store });
    return text(r.text, r.isError);
  });

  return server;
}
