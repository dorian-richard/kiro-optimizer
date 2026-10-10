// The kopt tools: model-facing definitions (names, descriptions, input schemas) and the shared execution path used by
// both the MCP server and the CLI (identical output either way).
//
// Every byte of tools/list (+ server instructions + the always-on steering) is re-sent to the model on every request,
// and the fixed prompt is most of what a session costs. So Kiro lists 4 tools, each with a one-line description and
// only the parameters that drive the common calls, written by hand (no $schema, no type on single-value enums, no
// required list: the first parameter is the obvious one). kopt_outline and kopt_expand are reached through kopt_read
// (a directory, mode outline, a kopt_run log handle) and stay callable by name for the CLI and older configurations.
// Every tool still accepts its other parameters (maxTokens, fresh, kinds, path, limit, direction, depth, cwd,
// timeoutSec, grep, startLine/endLine): output hints name them where they help.

import { statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { z, type ZodRawShape } from 'zod';
import type { Budgets } from '../core/config.js';
import type { ToolContext } from '../core/context.js';
import { estimateTokens, truncateLines } from '../core/tokens.js';
import type { SymbolKind, ToolResult } from '../core/types.js';
import type { Store } from '../store/store.js';
import type { Modules } from './modules.js';
import { resolveShell } from '../compress/runner.js';

/** Shell kopt_run uses on this machine, named in its description so the model writes matching syntax. */
function runShellName(): string {
  try {
    const kind = resolveShell().kind;
    return kind === 'powershell' ? 'PowerShell' : kind === 'cmd' ? 'cmd.exe' : 'shell';
  } catch {
    return 'shell';
  }
}

/** Every tool kopt answers, by name (the MCP server and the CLI commands). */
export const TOOL_NAMES = ['kopt_find', 'kopt_read', 'kopt_outline', 'kopt_refs', 'kopt_run', 'kopt_expand'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
/** The tools listed to the model (tools/list), in this order. */
export const LISTED_TOOLS: readonly ToolName[] = ['kopt_find', 'kopt_read', 'kopt_refs', 'kopt_run'];

const SYMBOL_KINDS: readonly SymbolKind[] = [
  'class', 'interface', 'enum', 'type', 'record', 'struct', 'trait', 'module', 'namespace',
  'function', 'method', 'constructor', 'field', 'property', 'constant',
];
const SYMBOL_KIND_SET: ReadonlySet<string> = new Set(SYMBOL_KINDS);

/** Upper bound for any caller-provided maxTokens: protects the context from "maxTokens: 100000". */
export const MAX_TOKENS_CAP = 8000;
const MIN_TOKENS = 50;

const int = () => z.coerce.number().int();
const STR = { type: 'string' } as const;

/** A kopt_run log handle, optionally with a line range: `o3fad54`, `o3fad54:120-180`, `o3fad54:120-`. */
const LOG_TARGET_RE = /^(?:kopt_(?:expand|read)\s+)?#?(o[0-9a-f]{6})(?::(\d+)(?:-(\d*))?)?$/i;

type ReadRoute =
  | { kind: 'log'; handle: string; start?: number; end?: number }
  | { kind: 'outline'; path?: string }
  | { kind: 'skeleton' }
  | { kind: 'read' };

function isDir(root: string, target: string): boolean | undefined {
  const abs = resolve(root, target);
  const rel = relative(root, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) return undefined;
  try {
    return statSync(abs).isDirectory();
  } catch {
    return undefined; // not a path (a symbol, a range)
  }
}

/**
 * What a kopt_read target asks for: a kopt_run log (kopt_expand), the outline of the repo, a directory or a glob
 * (kopt_outline), the outline of a file (mode outline), a type's members (mode outline on a symbol), else code.
 */
export function readRoute(root: string, args: { target?: unknown; mode?: unknown }): ReadRoute {
  const target = String(args.target ?? '').trim();
  const log = LOG_TARGET_RE.exec(target);
  if (log) {
    const start = log[2] ? Number(log[2]) : undefined;
    const end = log[3] ? Number(log[3]) : log[2] && log[3] === undefined ? start : undefined;
    return { kind: 'log', handle: log[1].toLowerCase(), start, end };
  }
  if (target === '.' || target === './' || target === '/') return { kind: 'outline' };
  if (/[*?]/.test(target)) return { kind: 'outline', path: target };
  const dir = isDir(root, target);
  if (dir) return { kind: 'outline', path: target };
  if (args.mode === 'outline') return dir === false ? { kind: 'outline', path: target } : { kind: 'skeleton' };
  return { kind: 'read' };
}

interface ToolSpec {
  name: ToolName;
  description: string;
  /** Accepted parameters (validation). */
  shape: ZodRawShape;
  /** Parameters listed to the model (JSON Schema properties), for a listed tool. */
  listed?: Record<string, unknown>;
  readOnly: boolean;
  /** Needs an index (store). */
  needsStore: (args: Record<string, any>) => boolean;
  /** Default budget used by the safety-net cap when the call omits maxTokens. */
  budget: (b: Budgets, args: Record<string, any>, root: string) => number;
  run: (m: Modules, store: Store | undefined, args: Record<string, any>, ctx: ToolContext, signal?: AbortSignal) => Promise<ToolResult>;
}

const always = () => true;

const SPECS: Record<ToolName, ToolSpec> = {
  kopt_find: {
    name: 'kopt_find',
    description: 'Code search: path:lines + #ids. mode pack adds bodies, callers, callees.',
    shape: {
      query: z.string(),
      mode: z.enum(['hits', 'pack']).optional(),
      // A bare string ("class") is accepted too; models often send one.
      kinds: z.preprocess((v) => (typeof v === 'string' ? [v] : v), z.array(z.string())).optional(),
      path: z.string().optional(),
      limit: int().optional(),
      maxTokens: int().optional(),
      fresh: z.boolean().optional(),
    },
    listed: { query: STR, mode: { enum: ['pack'] } },
    readOnly: true,
    needsStore: always,
    budget: (b, a) => (a.mode === 'pack' ? b.pack : b.find), // a single-identifier pack uses less (see find.ts)
    run: async (m, store, a, ctx) => (await m.retrieval()).find(store!, a as any, ctx),
  },
  kopt_read: {
    name: 'kopt_read',
    description: 'Code of #id, Class.method, path[:a-b] or dir (members with lines).',
    shape: {
      target: z.string(),
      mode: z.enum(['body', 'skeleton', 'card', 'outline']).optional(),
      maxTokens: int().optional(),
      fresh: z.boolean().optional(),
      // a directory or mode outline (kopt_outline)
      focus: z.string().optional(),
      // a kopt_run log (kopt_expand)
      grep: z.string().optional(),
      startLine: int().optional(),
      endLine: int().optional(),
    },
    listed: { target: STR, mode: { enum: ['outline'] } },
    readOnly: true,
    needsStore: (a) => !LOG_TARGET_RE.test(String(a.target ?? '').trim()),
    // Without maxTokens a named function may come whole up to readSymbol, a file or type up to readFile.
    budget: (b, a, root) => {
      const route = readRoute(root, a);
      if (route.kind === 'log') return b.expand;
      if (route.kind === 'outline') return b.outline;
      return Math.min(MAX_TOKENS_CAP, Math.max(b.read, b.readSymbol ?? 0, b.readFile ?? 0));
    },
    run: async (m, store, a, ctx) => {
      const route = readRoute(ctx.config.root, a);
      if (route.kind === 'log') {
        const p = { handle: route.handle, grep: a.grep, startLine: a.startLine ?? route.start, endLine: a.endLine ?? route.end, maxTokens: a.maxTokens };
        return (await m.compress()).expand(p, ctx);
      }
      const retrieval = await m.retrieval();
      if (route.kind === 'outline') return retrieval.outline(store!, { path: route.path, focus: a.focus, maxTokens: a.maxTokens }, ctx);
      const { focus: _f, grep: _g, startLine: _s, endLine: _e, ...p } = a;
      return retrieval.read(store!, { ...p, mode: route.kind === 'skeleton' ? 'skeleton' : p.mode } as any, ctx);
    },
  },
  kopt_outline: {
    name: 'kopt_outline',
    description: 'Structure (#handles) of the repo, a dir or a file; focus: task words first.',
    shape: {
      path: z.string().optional(),
      focus: z.string().optional(),
      maxTokens: int().optional(),
    },
    readOnly: true,
    needsStore: always,
    budget: (b) => b.outline,
    run: async (m, store, a, ctx) => (await m.retrieval()).outline(store!, a as any, ctx),
  },
  kopt_refs: {
    name: 'kopt_refs',
    description: 'Callers of #id or Class.method, with call lines.',
    shape: {
      target: z.string(),
      direction: z.enum(['in', 'out', 'both']).optional(),
      depth: z.union([z.literal(1), z.literal(2)], { errorMap: () => ({ message: 'expected 1 or 2' }) }).optional(),
      maxTokens: int().optional(),
    },
    listed: { target: STR },
    readOnly: true,
    needsStore: always,
    budget: (b) => b.refs,
    run: async (m, store, a, ctx) => (await m.retrieval()).refs(store!, a as any, ctx),
  },
  kopt_run: {
    name: 'kopt_run',
    description: `Run a ${runShellName()} command: verdict, failures, errors, source hints.`,
    shape: {
      command: z.string(),
      cwd: z.string().optional(),
      timeoutSec: int().optional(),
      maxTokens: int().optional(),
      fresh: z.boolean().optional(),
    },
    listed: { command: STR },
    readOnly: false,
    needsStore: () => false,
    budget: (b) => b.run + RUN_SOURCE_TOKENS,
    run: async (m, store, a, ctx, signal) => withSourceContext(m, store, await (await m.compress()).runCommand(a as any, ctx, { signal })),
  },
  kopt_expand: {
    name: 'kopt_expand',
    description: 'More of a kopt_run log: grep (regex) or startLine/endLine.',
    shape: {
      handle: z.string(),
      grep: z.string().optional(),
      startLine: int().optional(),
      endLine: int().optional(),
      maxTokens: int().optional(),
    },
    readOnly: true,
    needsStore: () => false,
    budget: (b) => b.expand,
    run: async (m, _store, a, ctx) => (await m.compress()).expand(a as any, ctx),
  },
};

/** Budget of the "source (kopt index):" lines appended to a failing kopt_run, beyond the run's own budget. */
export const RUN_SOURCE_TOKENS = 200;

/**
 * A failing run (not a cached answer) with an index at hand: append where its frames, failing tests and failure
 * messages point in the source, so the agent reads the suspect function instead of searching for it.
 */
async function withSourceContext(m: Modules, store: Store | undefined, r: ToolResult): Promise<ToolResult> {
  const meta = r.meta ?? {};
  if (!store || meta.cached || meta.refused || typeof meta.exitCode !== 'number' || meta.exitCode === 0) return r;
  try {
    const retrieval = await m.retrieval();
    const extra = retrieval.failureContext?.(store, r.text, RUN_SOURCE_TOKENS);
    if (!extra) return r;
    const text = `${r.text}\n${extra}`;
    return { ...r, text, tokens: estimateTokens(text), meta: { ...meta, sourceContext: true } };
  } catch {
    return r;
  }
}

export interface ToolDefinition {
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint: boolean };
}

interface CompiledTool {
  spec: ToolSpec;
  schema: z.ZodObject<ZodRawShape>;
  definition: ToolDefinition;
}

let compiled: Map<ToolName, CompiledTool> | undefined;

/** All tools in stable order (stable tools/list bytes = cache friendly), compiled once. */
export function compileTools(): Map<ToolName, CompiledTool> {
  if (compiled) return compiled;
  const out = new Map<ToolName, CompiledTool>();
  for (const name of TOOL_NAMES) {
    const spec = SPECS[name];
    const definition: ToolDefinition = { name, description: spec.description, inputSchema: { type: 'object', properties: spec.listed ?? {} } };
    if (spec.readOnly) definition.annotations = { readOnlyHint: true };
    out.set(name, { spec, schema: z.object(spec.shape), definition });
  }
  compiled = out;
  return out;
}

/** What tools/list sends: the listed tools only. */
export function toolDefinitions(): ToolDefinition[] {
  const tools = compileTools();
  return LISTED_TOOLS.map((n) => tools.get(n)!.definition);
}

/**
 * Server instructions. Kiro injects them into the context on every request: none. The tool descriptions say what
 * each tool does and the always-on steering says when to use which.
 */
export function serverInstructions(): string {
  return '';
}

export interface ExecuteOptions {
  modules: Modules;
  ctx: ToolContext;
  /** Required for retrieval tools. */
  store?: Store;
  /** The MCP request's cancellation signal: a cancelled kopt_run kills its command. */
  signal?: AbortSignal;
}

export interface ExecuteResult {
  text: string;
  isError: boolean;
  result?: ToolResult;
}

/** One-line error text: tool errors must not flood the context with stack traces. */
export function oneLine(msg: string, max = 240): string {
  const line = msg.replace(/\s+/g, ' ').trim();
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

function zodMessage(err: z.ZodError): string {
  return err.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
}

const REQUIRED_STRINGS = ['query', 'target', 'command', 'handle'];

export type ParsedArgs = { ok: true; args: Record<string, any> } | { ok: false; message: string };

/** Validate + normalize raw tool arguments. */
export function parseToolArgs(name: ToolName, raw: unknown): ParsedArgs {
  const tool = compileTools().get(name);
  if (!tool) return { ok: false, message: `unknown tool ${name}` };
  // Models often send null / "" for optional params; z.coerce would turn them into 0.
  const input: Record<string, unknown> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) if (v !== null && !(v === '' && !REQUIRED_STRINGS.includes(k))) input[k] = v;
  }
  const parsed = tool.schema.safeParse(input);
  if (!parsed.success) return { ok: false, message: `invalid arguments: ${zodMessage(parsed.error)}` };
  const args = parsed.data as Record<string, any>;
  // Required string params must be non-blank (checked here, not in the schema, to keep tools/list small).
  for (const k of REQUIRED_STRINGS) {
    if (k in args && !String(args[k]).trim()) return { ok: false, message: `invalid arguments: ${k} must not be empty` };
  }
  for (const k of Object.keys(args)) if (args[k] === undefined) delete args[k];
  if (args.maxTokens !== undefined) args.maxTokens = Math.min(MAX_TOKENS_CAP, Math.max(MIN_TOKENS, args.maxTokens));
  if (args.limit !== undefined) args.limit = Math.min(200, Math.max(1, args.limit));
  if (args.timeoutSec !== undefined) args.timeoutSec = Math.min(3600, Math.max(1, args.timeoutSec));
  if (Array.isArray(args.kinds)) {
    const kinds = [...new Set((args.kinds as string[]).flatMap((k) => k.split(/[\s,]+/)).map((k) => k.trim().toLowerCase()).filter(Boolean))];
    const bad = kinds.filter((k) => !SYMBOL_KIND_SET.has(k));
    if (bad.length) return { ok: false, message: `invalid kinds ${bad.join(',')}; valid: ${SYMBOL_KINDS.join(',')}` };
    if (kinds.length) args.kinds = kinds;
    else delete args.kinds;
  }
  return { ok: true, args };
}

/** Does this call need the index (a kopt_read of a kopt_run log does not)? */
export function toolNeedsStore(name: ToolName, args: Record<string, any> = {}): boolean {
  return SPECS[name].needsStore(args);
}

/**
 * Texts of the modules may name kopt_outline or kopt_expand, which Kiro no longer lists: spell them as the listed
 * kopt_read call that does the same (`kopt_outline .` -> `kopt_read .`, `kopt_expand o1a2b3c` -> `kopt_read o1a2b3c`).
 */
export function listedSpelling(text: string): string {
  return text.includes('kopt_outline') || text.includes('kopt_expand') ? text.replace(/\bkopt_(?:outline|expand)\b( path=)?/g, (_m, path?: string) => (path ? 'kopt_read ' : 'kopt_read')) : text;
}

/**
 * Run a validated tool call, enforce the budget as a safety net and emit one telemetry event.
 * Never throws: failures become a one-line `isError` result.
 */
export async function executeTool(name: ToolName, args: Record<string, any>, o: ExecuteOptions): Promise<ExecuteResult> {
  const spec = SPECS[name];
  const t0 = performance.now();
  let out: ExecuteResult;
  try {
    if (spec.needsStore(args) && !o.store) throw new Error('index not available');
    const result = await spec.run(o.modules, o.store, args, o.ctx, o.signal);
    if (!result || typeof result.text !== 'string') throw new Error('tool returned no result');
    // Modules must honour budgets; this cap only guards the context against a misbehaving module.
    const cap = args.maxTokens ?? spec.budget(o.ctx.config.budgets, args, o.ctx.config.root);
    let text = listedSpelling(result.text);
    // The marker is longer than truncateLines' reserve: shrink the budget so the result, marker included, fits.
    if (estimateTokens(text) > cap * 1.1 + 16) text = truncateLines(text, cap - 8, (n) => `… ${n} more lines (budget ${cap} tok)`).text;
    out = { text, isError: false, result: text === result.text ? result : { ...result, text, tokens: estimateTokens(text) } };
  } catch (err) {
    out = { text: `${name} failed: ${oneLine((err as Error)?.message ?? String(err))}`, isError: true };
  }
  try {
    o.ctx.emit({
      ts: Date.now(),
      kind: 'tool',
      tool: name,
      session: o.ctx.session,
      repo: o.ctx.repo,
      tokensOut: estimateTokens(out.text),
      baselineTokens: out.result?.baselineTokens,
      durationMs: Math.round(performance.now() - t0),
      meta: out.isError ? { error: true } : out.result?.meta,
    });
  } catch {
    // telemetry must never break a tool call
  }
  return out;
}
