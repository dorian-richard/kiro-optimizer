# Module contracts

Runtime: Node >= 22.13, ESM (`"type": "module"`), TypeScript strict, imports with `.js` suffix
(`import { x } from '../core/tokens.js'`). **Zero native dependencies**: SQLite = `node:sqlite`
(FTS5 available), parsing = `web-tree-sitter@0.25` + `tree-sitter-wasms` grammars. Tests: vitest in `test/`.
Never write to stdout from library code (stdout is the MCP stdio channel); log to stderr.

Shared, already written (do not change signatures without coordination):
- `src/core/types.ts` – domain types (`ExtractedFile`, `ToolResult`, `TelemetryEvent`...).
- `src/core/api.ts` – parameter shapes of the 6 tools.
- `src/core/config.ts` – `KoptConfig`, `loadConfig(root)`, `indexPath(cfg)`, plus the location helpers below.
- `src/core/tokens.ts` – `estimateTokens`, `truncateLines`, `truncateMiddle`, `packSections`.
- `src/core/context.ts` – `Ledger` (dedup), `ToolContext`, `newToolContext`.
- `src/store/schema.ts`, `src/store/store.ts` – SQLite schema + `Store` (open, prepare, transaction, meta, readText, `symbolHandle`/`parseSymbolHandle`).

### Where kopt keeps its data (`src/core/config.ts`)
```ts
/** Parent of every per-repo data dir: macOS ~/Library/Caches/kopt, Linux $XDG_CACHE_HOME/kopt (~/.cache/kopt),
 *  Windows %LOCALAPPDATA%\kopt. KOPT_CACHE_DIR overrides it. */
export function cacheRoot(o?: PlatformEnv): string;
/** `<basename>-<sha1(realpath)[:8]>` (case-folded on Windows): the per-repo folder name under cacheRoot(). */
export function repoCacheKey(root: string, platform?: NodeJS.Platform): string;
/** KOPT_DATA_DIR, else <root>/.kopt when that folder already exists (per-project mode), else cacheRoot()/<key>. */
export function defaultDataDir(root: string): string;
/** Per-user dir (telemetry, governor sessions, install state): KOPT_HOME, else ~/.kopt. */
export function userDirFor(o?: PlatformEnv): string;
/** Nearest ancestor with .git (or a per-project .kopt/index.db), never climbing into HOME. */
export function findProjectRoot(start: string, home?: string): string;
/** HOME or a filesystem root: never indexed, never written to. */
export function isUnsafeRoot(root: string, home?: string): boolean;
export function usesProjectDataDir(cfg: Pick<KoptConfig, 'root' | 'dataDir'>): boolean;
```
Nothing is written into a repository by default: the index (`index.db`) and the `kopt_run` logs live in
`defaultDataDir(root)`. A config file's `dataDir` and `KOPT_DATA_DIR` still win.

## Output conventions (everything that reaches the model)

Token cost is the product. Every byte returned to the model is re-billed on every later turn of the session
(Kiro bills credits per request ≈ f(model, total tokens); cache hits do not appear to be discounted).

1. **Plain text, never JSON.** One header line, then content. No banners, no emojis, no timestamps,
   no "metrics trailers". Deterministic ordering (stable across calls → cache friendly).
2. **Locations** as `path:start-end` (repo-relative, forward slashes). Symbols referenced by short handles
   `#<base36 id>` (see `symbolHandle`) so follow-up calls are cheap: `kopt_read #3mv`.
3. **Header** format: `<what> · <n> results · ~<tokens> tok` (e.g. `find "refund" · 7 hits · ~310 tok`).
   When something was cut: append ` · +<k> more (raise maxTokens or narrow query)`.
4. **Code** is returned verbatim (never paraphrased) under a single header line `path:start-end`
   – no per-line numbers (they cost ~15% more tokens); the header gives the start line.
5. **Budgets** are hard caps: every tool takes `maxTokens` (defaults in `config.budgets`) and must return
   `ToolResult.tokens <= maxTokens` (use `packSections` / `truncateLines`). Never cut in the middle of a
   line; prefer dropping whole low-ranked sections.
6. **Dedup**: before sending a symbol body / file range, check `ctx.ledger.wasShown(key, digest)`;
   if so, emit one line `path:start-end #id unchanged (shown in call N) – pass fresh:true to resend`.
   Keys: `sym:<id>` / `range:<path>:<start>-<end>`; digest = sha1 of the text sent.
   Always `ctx.ledger.tick()` once at the start of each tool call.
7. **Hints**: at most one trailing line, only when actionable (`next: kopt_read #3mv` or `narrow with path:`).
8. **Honest baselines**: set `ToolResult.baselineTokens` only when the counterfactual is exactly
   computable (full raw command output for `run`, full file tokens for `outline`/`read skeleton` of a file).

## Modules and required exports

### indexer — `src/indexer/`
```ts
// src/indexer/index.ts
export interface IndexOptions {
  config: KoptConfig;
  /** Restrict to these repo-relative paths (incremental). Default: walk the whole repo. */
  paths?: string[];
  onProgress?: (done: number, total: number) => void;
}
export interface IndexStats {
  filesSeen: number; filesIndexed: number; filesUnchanged: number; filesDeleted: number;
  symbols: number; refs: number; durationMs: number; commit?: string;
}
export async function indexRepo(store: Store, opts: IndexOptions): Promise<IndexStats>;
/** Cheap freshness check (git status + mtime/size compare); re-indexes only changed files. */
export async function refreshIndex(store: Store, opts: IndexOptions & { maxFiles?: number }): Promise<IndexStats>;
/** Parse one file's text (pure; used by tests and the indexer). */
export async function extractFile(path: string, text: string): Promise<ExtractedFile | undefined>;
export function languageForPath(path: string): Lang | undefined;
/** Code-aware term splitting used for FTS columns AND for queries (retrieval must use the same function). */
export function splitIdentifier(name: string): string[];   // "parseHTTPRequest_v2" -> ["parse","http","request","v2"]
export function termsForText(text: string): string[];      // identifiers + their sub-words, lower-cased, deduped
```
After a full or incremental pass: resolve `refs.to_symbol_id` (name + qualifier + imports + same file/dir/namespace
heuristics; prefer unresolved over wrong), resolve `file_imports.target_file_id`, compute `files.rank` and
`symbols.rank` (PageRank on the file graph / normalized weighted in-degree for symbols), set meta `commit`, `indexed_at`.
Must handle 10k+ files: batch inserts in transactions, skip files > `config.maxFileBytes`, respect `.gitignore`,
`.kiroignore` and `config.exclude`, skip binary/minified files (very long lines).

### retrieval — `src/retrieval/`
```ts
// src/retrieval/index.ts
export function find(store: Store, p: FindParams, ctx: ToolContext): ToolResult;
export function read(store: Store, p: ReadParams, ctx: ToolContext): ToolResult;
export function outline(store: Store, p: OutlineParams, ctx: ToolContext): ToolResult;
export function refs(store: Store, p: RefsParams, ctx: ToolContext): ToolResult;
/** Resolve a target string (handle, qualified name, name, path, path:range) to symbols/files. */
export function resolveTarget(store: Store, target: string): ResolvedTarget;
```
`find` = hybrid lexical ranking: FTS5 bm25 (weights `FTS_WEIGHTS`) on terms from `termsForText(query)`
(OR of terms, prefix match on long terms) + exact/case-insensitive name match boost + `symbols.rank` +
`files.rank` prior + kind prior (types/functions > fields). `pack` mode: top pointers + bodies of the best 1-3
symbols (skeleton for containers) within `budgets.pack`.

### compress — `src/compress/`
```ts
// src/compress/index.ts
export async function runCommand(p: RunParams, ctx: ToolContext): Promise<ToolResult>;
export function expand(p: ExpandParams, ctx: ToolContext): ToolResult;
/** Pure: pick a filter by command/output signature and compress. */
export function compressOutput(command: string, output: string, exitCode: number, maxTokens: number): { text: string; filter: string };
/** Workspace fingerprint used to detect "same command, nothing changed". */
export function workspaceFingerprint(root: string): string;
```
Full raw output saved under `<dataDir>/outputs/<handle>.log` (handle = `o` + 6 hex chars); result text ends
with `full output: kopt_expand <handle>` when something was elided.

### hooks + telemetry — `src/hooks/`, `src/telemetry/`
```ts
// src/hooks/index.ts – entry point `kopt hook [event] [--source <name>] [--legacy]`
//   event:    used when the payload has no hook_event_name (CLI 2.x agent hooks, IDE 0.x legacy hooks)
//   --source: global | workspace | agent | legacy; the same event from two sources within 2 s is handled once
//   --legacy: Kiro IDE 0.x `.kiro.hook` runCommand (no stdin; data in env USER_PROMPT)
export interface HookEvent { hook_event_name: string; session_id?: string; cwd?: string; tool_name?: string;
  tool_input?: any; tool_response?: any; prompt?: string; [k: string]: unknown }
export interface HookOutcome { exitCode: 0 | 2; stdout?: string; stderr?: string }
export async function handleHook(event: HookEvent, config: KoptConfig): Promise<HookOutcome>;
// src/telemetry/index.ts
export function record(event: TelemetryEvent, config: KoptConfig): void;            // sync append JSONL, never throws
export function pruneTelemetry(config: KoptConfig, now?: number): void;           // drop day files > RETAIN_DAYS (90)
export function stats(config: KoptConfig, opts?: { days?: number }): string;     // human report
export function collectKiroCredits(config: KoptConfig): TelemetryEvent[];        // ~/.kiro/sessions/**
```
Telemetry is a local log only (`<userDir>/telemetry/<YYYY-MM-DD>.jsonl`, read by `kopt stats`); nothing is sent
anywhere. Events carry the project folder name as `repo`. The Stop hook records the end of the turn and prunes old
day files; Kiro credits are collected on demand by `kopt stats` and `kopt credits`.
Event names accepted (normalized): IDE 1.x / CLI V3 v1 hook files (PascalCase `PreToolUse`…), CLI 2.x agent hooks
(only `agentSpawn`, `userPromptSubmit`, `preToolUse`, `postToolUse`, `stop`: the triggers `kiro-cli agent validate`
2.28 accepts), IDE 0.x legacy hooks (`promptSubmit` only is installed, see below). Tool names of all four surfaces
are normalized (`read_file`/`read_code`/`read`/`fs_read`, `execute_bash`/`shell`, …). The allow path is a silent
exit 0 on every surface.

### kiro integration — `src/kiro/`, `templates/`
```ts
// src/kiro/index.ts
// Per-project install (`kopt init`; `--user` = the user-level files without the npm step)
export interface InstallOptions { root: string; scope: 'workspace' | 'user'; explorerModel?: string; dryRun?: boolean; force?: boolean }
export async function installKiro(o: InstallOptions): Promise<{ written: string[]; skipped: string[]; notes: string[] }>;
export async function suggestKiroignore(root: string): Promise<{ patterns: string[]; reasons: Record<string, string> }>;
// User-level, zero-config install (`kopt setup`): global npm install from the npx copy (packed, then
// `npm install -g <tarball>`), then ~/.kiro/settings/mcp.json (`kopt mcp`, no --root), ~/.kiro/hooks/kopt.json
// (IDE 1.x, CLI V3), ~/.kiro/agents/kopt.json + chat.defaultAgent (CLI 2.x), global steering and kiroignore,
// kiroAgent.agentIgnoreFiles in the IDE user settings. Idempotent; records what it wrote in ~/.kopt.
export async function setupUser(o?: SetupOptions): Promise<SetupResult>;
export function globalInstall(o?: { want?: boolean; spec?: string; npm?: NpmRunner; pkgRoot?: string; dryRun?: boolean }): GlobalInstall;
export async function uninstallKiro(o?: UninstallOptions): Promise<InstallResult>;   // `kopt uninstall`
export async function runDoctor(o?: DoctorOptions): Promise<DoctorReport>;           // `kopt doctor`
export function detectSurfaces(h?: HostEnv, o?: { surface?: SurfaceChoice }): Surfaces; // IDE: resources/app/package.json; CLI: kiro-cli --version
export function resolveKoptCommand(o?: ResolveOptions): KoptCommand;  // `kopt` shim, else node + absolute bin.js
// IDE 0.x has no global hooks: the MCP server writes <workspace>/.kiro/hooks/kopt-prompt.kiro.hook (promptSubmit
// only; tool-call hooks would cost a model turn per call there) and lists it in .git/info/exclude.
export function ensureLegacyWorkspaceHooks(root: string, config: KoptConfig, o?: { cmd?: KoptCommand; h?: HostEnv }): LegacyResult;
```

### mcp + cli — `src/mcp/`, `src/cli.ts`
Tools: `kopt_find`, `kopt_read`, `kopt_outline`, `kopt_refs`, `kopt_run`, `kopt_expand`. Descriptions short
(< 350 chars each), server `instructions` < 600 chars. Transport: stdio only (Kiro starts `kopt mcp` locally); one
server answers for one project at a time.

```ts
// src/mcp/server.ts
export interface RepoHandle {
  readonly name: string;
  readonly config: KoptConfig;
  acquire(): Promise<Store | string>;
  /** Optional: wait until the repo is known (a user-level stdio server learns its root after `initialize`, from the
   *  client's MCP roots, else KOPT_ROOT, else the git root of its cwd), then return a one-line message when no tool
   *  can run (no project folder open: HOME or `/`), else undefined. */
  prepare?(): Promise<string | undefined>;
}
```
`kopt mcp` without `--root` resolves the root as above and starts the first index build in a worker thread as soon
as the root is known. The package's bin is `dist/bin.js`, which drops Node's SQLite ExperimentalWarning and
refuses Node < 22.13 (a hook then exits 0 silently) before loading `cli.js`.
