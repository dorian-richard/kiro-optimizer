// MCP server (transport-agnostic; kopt serves it over stdio). One Server instance per MCP session, so each session
// gets its own ToolContext (and dedup ledger) per repo.
//
// We use the low-level SDK `Server` rather than `McpServer.registerTool` to control the exact tools/list
// bytes (no $schema / additionalProperties noise, no titles): they are re-billed on every model turn.

import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { KoptConfig } from '../core/config.js';
import { newToolContext, type ToolContext } from '../core/context.js';
import type { TelemetryEvent } from '../core/types.js';
import type { Store } from '../store/store.js';
import { withModules, type Modules } from './modules.js';
import { compileTools, executeTool, oneLine, parseToolArgs, serverInstructions, toolDefinitions, toolNeedsStore, type ToolName } from './tools.js';

export const SERVER_NAME = 'kopt';
export const SERVER_VERSION = '0.2.0';

/** The repository the server answers for. */
export interface RepoHandle {
  readonly name: string;
  /** Repo-specific config (root/dataDir); budgets & dedup settings come from here too. */
  readonly config: KoptConfig;
  /**
   * A store ready for queries, or a one-line status to return instead (e.g. "index building: 12/400 files parsed").
   * `tool`: the tool about to run (during a first build, search answers before references are resolved).
   */
  acquire(tool?: string): Promise<Store | string>;
  /**
   * Optional: wait until the repo is known (a user-level server learns its project root after `initialize`), then
   * resolve to a one-line message when no tool can run (e.g. no project folder open), else undefined.
   */
  prepare?(): Promise<string | undefined>;
  /** Optional: the index when it is ready now, without waiting or refreshing (kopt_run's source context). */
  peek?(): Store | undefined;
}

export interface ServerDeps {
  /** Base config (telemetry sink, defaults). */
  config: KoptConfig;
  /** The project: fixed (`kopt mcp --root`) or decided after initialize (user-level server). */
  repo: RepoHandle;
  modules?: Partial<Modules>;
  /** Telemetry sink. Default: telemetry.record() (local JSONL). */
  emit?: (e: TelemetryEvent) => void;
  /** Session id when the transport has none (stdio). */
  sessionId?: string;
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

export function createServer(deps: ServerDeps): Server {
  const modules = withModules(deps.modules);
  const tools = compileTools();
  const definitions = toolDefinitions();
  const emit = deps.emit ?? localTelemetrySink(deps.config, modules);
  const fallbackSession = deps.sessionId ?? randomUUID();
  const repo = deps.repo;

  const instructions = serverInstructions();
  const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} }, ...(instructions ? { instructions } : {}) });

  // One ToolContext per repo for the lifetime of this session: dedup ledger keys are per-repo symbol ids (the repo
  // of a user-level server changes when Kiro opens another folder).
  const contexts = new Map<string, ToolContext>();
  const contextFor = (session: string): ToolContext => {
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
    const parsed = parseToolArgs(name, req.params.arguments);
    if (!parsed.ok) return text(`${name}: ${parsed.message}`, true);
    if (repo.prepare) {
      const unavailable = await repo.prepare().catch((err: unknown) => `${name} failed: ${oneLine((err as Error)?.message ?? String(err))}`);
      if (unavailable) return text(unavailable);
    }

    const ctx = contextFor(extra.sessionId ?? fallbackSession);
    let store: Store | undefined;
    if (toolNeedsStore(name, parsed.args)) {
      let s: Store | string;
      try {
        s = await repo.acquire(name);
      } catch (err) {
        return text(`${name} failed: index unavailable: ${oneLine((err as Error)?.message ?? String(err))}`, true);
      }
      if (typeof s === 'string') return text(s);
      store = s;
    } else if (name === 'kopt_run') {
      try {
        store = repo.peek?.();
      } catch {
        store = undefined;
      }
    }
    const r = await executeTool(name, parsed.args, { modules, ctx, store, signal: extra.signal });
    return text(r.text, r.isError);
  });

  return server;
}
