// Kiro built-in tool names as they appear in hook payloads (`tool_name`).
//
// Sources (verified 2026-10-09):
//  - kiro.dev/docs/tools, /docs/reference/built-in-tools, /docs/hooks/types (canonical names + aliases).
//  - Kiro IDE 0.12.318 bundle (extensions/kiro.kiro-agent/dist/extension.js, @kiro/agent harness):
//    tool ids read_file {path, offset, limit} | legacy read_file {path, start_line, end_line},
//    read_files {paths, start_line, end_line}, read_code {path, selector} (whole file only < 10k chars),
//    execute_bash / execute_pwsh {command, cwd}, fs_write, fs_append, str_replace, delete_file,
//    grep_search, file_search, list_directory; MCP tools are exposed as `mcp_<server>_<tool>`
//    (sanitized, lower-cased) while the CLI uses `@server/tool`.
//  - Kiro CLI 2.x `fs_read` payload: {operations: [{mode: "Line" | "Directory" | "Image", path, offset?, limit?}]}
//    (2.28 tool schema in the kiro-cli-chat binary; older builds used start_line/end_line). 2.28 agent configs
//    also use the short names read / write / shell / glob / grep; Windows shell = execute_cmd.
//  - Kiro IDE 0.12 tool ids also include edit_code, semantic_rename, smart_relocate (writes), read_code, grep_search,
//    file_search, list_directory (never gated).
// Matching is case-insensitive on purpose: legacy IDE action names are camelCase (readFile, fsWrite...).

const lc = (xs: string[]) => new Set(xs.map((x) => x.toLowerCase()));

/** Tools that return file contents and may read a whole file when no range is given. */
export const READ_TOOLS = lc(['read_file', 'read_files', 'fs_read', 'read', 'readFile', 'readFiles', 'fsRead', 'read_multiple_files']);

/** Shell execution tools. */
export const SHELL_TOOLS = lc(['execute_bash', 'execute_pwsh', 'execute_cmd', 'shell', 'executeBash', 'executePwsh', 'run_shell']);

/** Tools that modify files (fallback dirty tracking when file events are not available, e.g. CLI 2.x). */
export const WRITE_TOOLS = lc([
  'fs_write', 'fs_append', 'str_replace', 'delete_file', 'write', 'fsWrite', 'fsAppend', 'strReplace', 'deleteFile',
  'create', 'append', 'replace', 'edit', 'editCode', 'edit_code', 'semantic_rename', 'smart_relocate',
]);

export type ToolClass = 'kopt' | 'read' | 'shell' | 'write' | 'other';

/** kopt MCP tools: `mcp_kopt_kopt_find` (IDE), `@kopt/kopt_find` (CLI), or bare `kopt_find`. */
const KOPT_RE = /(^|[^a-z0-9])kopt_(find|read|outline|refs|run|expand)$/i;

export function classifyTool(name: string | undefined): ToolClass {
  if (!name) return 'other';
  if (KOPT_RE.test(name) || /^mcp_kopt_/i.test(name) || /^@kopt\//i.test(name)) return 'kopt';
  const n = name.toLowerCase();
  if (READ_TOOLS.has(n)) return 'read';
  if (SHELL_TOOLS.has(n)) return 'shell';
  if (WRITE_TOOLS.has(n)) return 'write';
  return 'other';
}

/** Short kopt tool name (`kopt_find`) from any namespaced form, else undefined. */
export function koptToolName(name: string | undefined): string | undefined {
  const m = name ? /kopt_(find|read|outline|refs|run|expand)$/i.exec(name) : null;
  return m ? `kopt_${m[1].toLowerCase()}` : undefined;
}

export interface ReadRequest {
  path: string;
  /** True when the call reads the whole file (no usable range). */
  whole: boolean;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * Extract the files a read tool call targets and whether each read is "whole file".
 * A read is ranged when it carries offset/limit or a start/end line other than the defaults
 * (start_line 1 / end_line -1 mean "whole file" in the IDE schema). A range wider than
 * `maxSpan` lines is treated as whole, since it costs the same.
 */
export function readRequests(input: any, maxSpan: number): ReadRequest[] {
  if (!input || typeof input !== 'object') return [];
  const out: ReadRequest[] = [];
  const ranged = (o: any): boolean => {
    const offset = num(o?.offset);
    const limit = num(o?.limit);
    if (limit !== undefined) return limit <= maxSpan;
    if (offset !== undefined) return offset > 0;
    const s = num(o?.start_line) ?? num(o?.startLine);
    const e = num(o?.end_line) ?? num(o?.endLine);
    const start = s === undefined || s === 0 ? 1 : s;
    const end = e === undefined ? -1 : e;
    if (start === 1 && end === -1) return false;
    if (start < 0 || end < 0) return true; // tail reads ("last N lines")
    return end - start + 1 <= maxSpan;
  };
  const push = (p: unknown, o: any) => {
    if (typeof p === 'string' && p) out.push({ path: p, whole: !ranged(o) });
  };
  if (Array.isArray(input.operations)) {
    // CLI 2.x fs_read
    for (const op of input.operations) {
      if (!op || typeof op !== 'object') continue;
      const mode = String(op.mode ?? 'Line').toLowerCase();
      if (mode === 'line') push(op.path, op);
    }
    return out;
  }
  if (Array.isArray(input.paths)) {
    for (const p of input.paths) push(p, input);
    return out;
  }
  if (Array.isArray(input.files)) {
    for (const f of input.files) push(typeof f === 'string' ? f : f?.path, typeof f === 'string' ? input : f);
    return out;
  }
  push(input.path ?? input.file_path ?? input.filePath, input);
  return out;
}

/** Paths written by a write tool call (best effort, for dirty tracking). */
export function writtenPaths(input: any): string[] {
  if (!input || typeof input !== 'object') return [];
  const out: string[] = [];
  for (const k of ['path', 'file_path', 'filePath', 'targetFile', 'target_file']) {
    if (typeof input[k] === 'string') out.push(input[k]);
  }
  if (Array.isArray(input.paths)) for (const p of input.paths) if (typeof p === 'string') out.push(p);
  return out;
}
