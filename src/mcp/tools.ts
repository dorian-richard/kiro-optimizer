// The 6 kopt tools: model-facing definitions (names, descriptions, input schemas) and the shared
// execution path used by both the MCP server and the CLI (identical output either way).
//
// Every byte of tools/list + instructions is re-sent to the model on every turn, so descriptions are
// terse, param descriptions are rare, and JSON Schema noise ($schema, additionalProperties) is stripped.

import { z, type ZodRawShape, type ZodTypeAny } from 'zod';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
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

export const TOOL_NAMES = ['kopt_find', 'kopt_read', 'kopt_outline', 'kopt_refs', 'kopt_run', 'kopt_expand'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** Tools that execute commands on the local machine: never registered on the central HTTP server. */
export const RUN_TOOLS: ReadonlySet<ToolName> = new Set(['kopt_run', 'kopt_expand']);

const SYMBOL_KINDS: readonly SymbolKind[] = [
  'class', 'interface', 'enum', 'type', 'record', 'struct', 'trait', 'module', 'namespace',
  'function', 'method', 'constructor', 'field', 'property', 'constant',
];
const SYMBOL_KIND_SET: ReadonlySet<string> = new Set(SYMBOL_KINDS);

/** Upper bound for any caller-provided maxTokens: protects the context from "maxTokens: 100000". */
export const MAX_TOKENS_CAP = 8000;
const MIN_TOKENS = 50;

const int = () => z.coerce.number().int();

interface ToolSpec {
  name: ToolName;
  description: string;
  shape: ZodRawShape;
  readOnly: boolean;
  /** Needs an index (store). */
  needsStore: boolean;
  /** Default budget used by the safety-net cap when the call omits maxTokens. */
  budget: (b: Budgets, args: Record<string, any>) => number;
  run: (m: Modules, store: Store | undefined, args: Record<string, any>, ctx: ToolContext) => Promise<ToolResult>;
}

const SPECS: Record<ToolName, ToolSpec> = {
  kopt_find: {
    name: 'kopt_find',
    description:
      'Search code by identifiers or plain words (case- and camelCase-insensitive). Use before grep or opening files. ' +
      'Returns ranked path:lines + #handles. mode "pack" adds the best bodies (task context in one call). ' +
      'path: prefix/glob; kinds: e.g. ["class","function"].',
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
    readOnly: true,
    needsStore: true,
    budget: (b, a) => (a.mode === 'pack' ? b.pack : b.find),
    run: async (m, store, a, ctx) => (await m.retrieval()).find(store!, a as any, ctx),
  },
  kopt_read: {
    name: 'kopt_read',
    description:
      'Read exact code by #handle, Class.method, path or path:start-end. ' +
      'mode: body (default), skeleton (signatures only; big files/classes), card (~60 tok). ' +
      "Use instead of whole-file reads. Already-shown code returns 'unchanged' (fresh:true resends).",
    shape: {
      target: z.string(),
      mode: z.enum(['body', 'skeleton', 'card']).optional(),
      maxTokens: int().optional(),
      fresh: z.boolean().optional(),
    },
    readOnly: true,
    needsStore: true,
    budget: (b) => b.read,
    run: async (m, store, a, ctx) => (await m.retrieval()).read(store!, a as any, ctx),
  },
  kopt_outline: {
    name: 'kopt_outline',
    description:
      'Structure map with #handles of the repo (no path), a directory or a file (much cheaper than reading it). ' +
      'focus: task words ranked first.',
    shape: {
      path: z.string().optional(),
      focus: z.string().optional(),
      maxTokens: int().optional(),
    },
    readOnly: true,
    needsStore: true,
    budget: (b) => b.outline,
    run: async (m, store, a, ctx) => (await m.retrieval()).outline(store!, a as any, ctx),
  },
  kopt_refs: {
    name: 'kopt_refs',
    description:
      'Callers/usages (direction in, default), callees (out) or both of a #handle or Class.method. ' +
      'depth 2 = transitive impact.',
    shape: {
      target: z.string(),
      direction: z.enum(['in', 'out', 'both']).optional(),
      depth: z.union([z.literal(1), z.literal(2)], { errorMap: () => ({ message: 'expected 1 or 2' }) }).optional(),
      maxTokens: int().optional(),
    },
    readOnly: true,
    needsStore: true,
    budget: (b) => b.refs,
    run: async (m, store, a, ctx) => (await m.retrieval()).refs(store!, a as any, ctx),
  },
  kopt_run: {
    name: 'kopt_run',
    description:
      `Run a ${runShellName()} command (tests, build, lint) in the repo; returns only failures, errors and summary. ` +
      'Use instead of the shell for verbose commands. An identical re-run with no file change returns the cached ' +
      'verdict (fresh:true forces). Full log: kopt_expand.',
    shape: {
      command: z.string(),
      cwd: z.string().optional(),
      timeoutSec: int().optional(),
      maxTokens: int().optional(),
      fresh: z.boolean().optional(),
    },
    readOnly: false,
    needsStore: false,
    budget: (b) => b.run,
    run: async (m, _store, a, ctx) => (await m.compress()).runCommand(a as any, ctx),
  },
  kopt_expand: {
    name: 'kopt_expand',
    description:
      'More of a kopt_run log by handle: grep (regex, with context) or startLine/endLine.',
    shape: {
      handle: z.string(),
      grep: z.string().optional(),
      startLine: int().optional(),
      endLine: int().optional(),
      maxTokens: int().optional(),
    },
    readOnly: true,
    needsStore: false,
    budget: (b) => b.expand,
    run: async (m, _store, a, ctx) => (await m.compress()).expand(a as any, ctx),
  },
};

export interface ToolSetOptions {
  /** Register kopt_run / kopt_expand (local mode only). */
  allowRun: boolean;
  /** Add an optional `repo` param (multi-repo HTTP server). */
  multiRepo: boolean;
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

const compiledCache = new Map<string, Map<ToolName, CompiledTool>>();

function stripSchemaNoise(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _s, additionalProperties: _a, ...rest } = schema;
  return rest;
}

/** Tools enabled for a server flavour, in stable order (stable tools/list bytes = cache friendly). */
export function compileTools(o: ToolSetOptions): Map<ToolName, CompiledTool> {
  const key = `${o.allowRun ? 1 : 0}${o.multiRepo ? 1 : 0}`;
  const hit = compiledCache.get(key);
  if (hit) return hit;
  const out = new Map<ToolName, CompiledTool>();
  for (const name of TOOL_NAMES) {
    const spec = SPECS[name];
    if (RUN_TOOLS.has(name) && !o.allowRun) continue;
    const shape: Record<string, ZodTypeAny> = { ...spec.shape };
    if (o.multiRepo) shape.repo = z.string().optional();
    const schema = z.object(shape);
    const json = stripSchemaNoise(toJsonSchemaCompat(schema, { strictUnions: true, pipeStrategy: 'input' }) as Record<string, unknown>);
    const definition: ToolDefinition = { name, description: spec.description, inputSchema: json };
    if (spec.readOnly) definition.annotations = { readOnlyHint: true };
    out.set(name, { spec, schema, definition });
  }
  compiledCache.set(key, out);
  return out;
}

export function toolDefinitions(o: ToolSetOptions): ToolDefinition[] {
  return [...compileTools(o).values()].map((t) => t.definition);
}

/** Server instructions. Kiro injects them into context on every turn: keep them tiny. */
export function serverInstructions(o: ToolSetOptions & { repos?: string[]; defaultRepo?: string }): string {
  const lines = [
    'kopt = budgeted code index, the cheapest way to get context. Flow: kopt_find (search) -> kopt_read #handle ' +
      '(exact code; skeleton for big files) / kopt_refs (callers) / kopt_outline (structure).',
    'Prefer these over grep, directory listings and whole-file reads. Reuse #handles; shown code is not re-sent.',
  ];
  if (o.allowRun) lines.push('Run tests/builds via kopt_run (compact output); re-run only after edits.');
  if (o.multiRepo) {
    const repos = o.repos ?? [];
    if (repos.length > 1) {
      const list = repos.join(', ');
      const which = list.length <= 200 ? `one of ${list}` : `<name> (${repos.length} repos; omit it to list them)`;
      lines.push(o.defaultRepo ? `Default repo: ${o.defaultRepo}; pass repo: ${which} for another.` : `Pass repo: ${which}.`);
    }
  }
  return lines.join('\n');
}

export interface ExecuteOptions {
  modules: Modules;
  ctx: ToolContext;
  /** Required for retrieval tools. */
  store?: Store;
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

export type ParsedArgs = { ok: true; args: Record<string, any>; repo?: string } | { ok: false; message: string };

/** Validate + normalize raw tool arguments. `repo` is split off (it is routing, not a tool param). */
export function parseToolArgs(name: ToolName, raw: unknown, o: ToolSetOptions): ParsedArgs {
  const tool = compileTools(o).get(name);
  if (!tool) return { ok: false, message: `unknown tool ${name}` };
  // Models often send null / "" for optional params; z.coerce would turn them into 0.
  const input: Record<string, unknown> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) if (v !== null && !(v === '' && !REQUIRED_STRINGS.includes(k))) input[k] = v;
  }
  const parsed = tool.schema.safeParse(input);
  if (!parsed.success) return { ok: false, message: `invalid arguments: ${zodMessage(parsed.error)}` };
  const { repo, ...args } = parsed.data as Record<string, any>;
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
  return { ok: true, args, repo: typeof repo === 'string' && repo.trim() ? repo.trim() : undefined };
}

export function toolNeedsStore(name: ToolName): boolean {
  return SPECS[name].needsStore;
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
    if (spec.needsStore && !o.store) throw new Error('index not available');
    const result = await spec.run(o.modules, o.store, args, o.ctx);
    if (!result || typeof result.text !== 'string') throw new Error('tool returned no result');
    // Modules must honour budgets; this cap only guards the context against a misbehaving module.
    const cap = args.maxTokens ?? spec.budget(o.ctx.config.budgets, args);
    let text = result.text;
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
