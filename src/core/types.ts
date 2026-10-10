// Shared domain types. This file is a contract between modules: change it only deliberately.

export type Lang =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'python'
  | 'java'
  | 'c_sharp'
  | 'go'
  | 'kotlin'
  | 'rust'
  | 'php'
  | 'ruby'
  | 'scala';

export type SymbolKind =
  | 'class'
  | 'interface'
  | 'enum'
  | 'type'
  | 'record'
  | 'struct'
  | 'trait'
  | 'module'
  | 'namespace'
  | 'function'
  | 'method'
  | 'constructor'
  | 'field'
  | 'property'
  | 'constant';

/** Container kinds can own other symbols (methods, fields...). */
export const CONTAINER_KINDS: ReadonlySet<SymbolKind> = new Set([
  'class', 'interface', 'enum', 'record', 'struct', 'trait', 'module', 'namespace',
]);

/** `read` / `write`: a member access that is not a call (`obj.field`, `this.x = v`, `x.count++`). */
export type RefKind = 'call' | 'new' | 'inherit' | 'implement' | 'import' | 'type_ref' | 'read' | 'write';

/** A symbol as produced by the parser for one file (before persistence). */
export interface ExtractedSymbol {
  name: string;
  /** Dotted path inside the file's namespace, e.g. `com.acme.OrderService.place` or `OrderService.place`. */
  qualifiedName: string;
  kind: SymbolKind;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  startByte: number;
  endByte: number;
  /** Declaration header on one line, whitespace-normalized, body removed, max ~300 chars. */
  signature: string;
  /** First sentence of the doc comment / docstring, max ~200 chars. */
  doc?: string;
  /** Index (in the same ExtractedFile.symbols array) of the enclosing symbol. */
  parent?: number;
  exported: boolean;
  /** Up to ~200 distinct identifiers used inside the body (lower-cased), for lexical recall. */
  bodyTerms?: string[];
}

export interface ExtractedRef {
  /** Index of the enclosing symbol in ExtractedFile.symbols; undefined = file level. */
  fromSymbol?: number;
  /** Referenced simple name (case preserved). */
  name: string;
  /** Receiver / qualifier text when available (e.g. `orderRepo` in `orderRepo.save()`), or import source. */
  qualifier?: string;
  kind: RefKind;
  line: number;
}

export interface ExtractedFile {
  path: string; // repo-relative, forward slashes
  lang: Lang;
  lineCount: number;
  symbols: ExtractedSymbol[];
  refs: ExtractedRef[];
  /** Raw import specifiers (module paths, packages) declared by the file. */
  imports: string[];
  /** Package / namespace declared by the file, if any (Java package, C# namespace, Go package...). */
  namespace?: string;
}

/** Result returned by every user-facing tool (MCP or CLI). */
export interface ToolResult {
  /** Compact plain text that goes into the model context. */
  text: string;
  /** Estimated tokens of `text` (see core/tokens.ts). */
  tokens: number;
  /**
   * Tokens the agent would have consumed with the obvious native alternative, ONLY when it is
   * exactly computable (e.g. the raw command output we compressed, or the full file we outlined).
   * Never a guess. Undefined when there is no honest counterfactual.
   */
  baselineTokens?: number;
  /** Small structured facts for telemetry (never sent to the model). */
  meta?: Record<string, unknown>;
}

export type TelemetryKind = 'tool' | 'hook' | 'session' | 'credits' | 'index';

export interface TelemetryEvent {
  ts: number;
  kind: TelemetryKind;
  /** Kiro session / MCP session id when known. */
  session?: string;
  /** Project folder name. */
  repo?: string;
  /** Tool name (kopt_* or a Kiro built-in observed through hooks). */
  tool?: string;
  /** Tokens actually returned to the model. */
  tokensOut?: number;
  /** Exact counterfactual (see ToolResult.baselineTokens). */
  baselineTokens?: number;
  bytes?: number;
  durationMs?: number;
  /** For credits events collected from Kiro session files. */
  credits?: number;
  /** Hook decision: allow | block | warn. */
  decision?: string;
  meta?: Record<string, unknown>;
}
