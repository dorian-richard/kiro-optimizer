# Session governor and configuration

What the free command hooks do, every config key, every environment variable, and where kopt keeps its data.

## Session governor

Kiro hooks cannot rewrite tool output. A hook can only block the call (exit 2: stderr goes to the model, which costs
one extra turn) or add context (stdout, only on session start and prompt submit). kopt therefore blocks only where the
expected gain far exceeds one turn. The big-read, verbose-command and duplicate-run rules block once each. Once the
tool-call budget is reached, every further tool call is blocked until the next user prompt. Every block is a single
line that names the cheaper alternative. When it allows a call, it prints nothing.

| Kiro event | What kopt does |
|---|---|
| SessionStart (CLI 2.x `agentSpawn`) | one line with the index status and a hint (250 characters max); once the first build is complete, starts a background `kopt index --refresh --if-idle` (at most once a minute) |
| UserPromptSubmit | re-arms the tool-call budget once it has been reached; adds a few `#handle` pointers for the prompt when prompt pointers are on (off by default), only when retrieval is confident |
| PreToolUse | the four rules below |
| PostToolUse | records the size of every tool response (`kopt stats` "context intake"); write tools mark files as changed |
| PostFileSave / Create / Delete | records the file written: unblocks re-runs and feeds the incremental index refresh |
| Stop | records the end of the turn; drops usage log days older than 90 days |

The rules, with their config keys (see [Configuration](#configuration)):

| Rule | Trigger | What the agent sees | Why it should save (not measured) | Tune / disable |
|---|---|---|---|---|
| Tool-call budget | more than `maxToolCallsPerSession` tool calls in one session. Every further call is blocked until the next user prompt, which re-arms it | `kopt governor: session tool-call budget (200) reached. Stop here: summarize what is done and what remains, and ask the user before continuing.` | circuit breaker for runaway loops; Kiro has no per-session credit cap | `governor.maxToolCallsPerSession` (200; `0` disables) |
| Big whole-file read | a read tool (`read_file`, `read_files`, `fs_read`, `read`, ...) without offset/limit, or with a range wider than `bigFileLines` lines, on a text file estimated above `bigFileTokens` tokens (a block costs one model request, so only files that clearly cost more are blocked). Once per file per session: a second identical attempt goes through | `kopt: big.txt is ~12k tokens (1200 lines). Use kopt_read big.txt mode=outline or kopt_read big.txt:<a>-<b>, or read with offset/limit.` | a whole big file stays in the context and is re-billed on every later turn | `governor.bigFileTokens` (8000; `0` disables), `governor.bigFileLines` (800) |
| Verbose command | a shell tool (`execute_bash`, `execute_pwsh`, `execute_cmd`, `shell`) running a test or build command whose output is predictably long (full test suites, Maven and Gradle without `-q`, MSBuild, cargo, make, ...). Never a quiet or narrowed run (`tsc`, `go vet`, one test file or test id, `mvn -q`), never a command that does not exit by itself (watch modes, dev servers, `run` goals), and only when `kopt_run` can be called (the kopt server is configured, not disabled, and `kopt_run` is not in `disabledTools`). Once per command and folder, at most 3 per session | `kopt: use kopt_run with command="npm test": same execution, returns only failures/errors (full log via kopt_read <handle>).` | the full log of a test run is often thousands of tokens, re-billed every turn; `kopt_run` returns the failures only | `governor.enforceRunForVerbose` (`true`) |
| Duplicate run | the same test/build shell command, in the same folder, again in the session with nothing changed since: no file written by the agent (edit tools, or a shell command that may write), no new user prompt, and the same git workspace state (so edits made outside Kiro count). Blocked once; a retry goes through | `kopt governor: identical command already ran this session and no file changed since; reuse its result (run it again to override).` | nothing kopt can see has changed (environment variables, services and flaky tests are not covered); it saves a turn of output and the build minutes | `governor.blockDuplicateRuns` (`true`) |

Prompt pointers are off by default (`budgets.frontload` `0`). On the 175 bench questions they fired on 55% of the
prompts (~126 tokens each, re-billed on every later request), and only 21% of the pointers named an expected symbol (3
of the 9 fired prompts of the agent A/B tasks; [bench/results/frontload.json](../bench/results/frontload.json)); the
agent's first `kopt_find` returns the same kind of pointers, ranked for its own query. Set `budgets.frontload` (e.g.
`200`) to turn them on: at most 4 pointers, within 400 ms. None for follow-up or conversational prompts ("yes,
continue", "fix the failing test"). A prompt that names code gets pointers only when the top hit is that code;
otherwise the top hit must cover at least 2 of the prompt's non-generic words and two thirds of them. Handles already
sent in the session are not repeated.

To turn every hook off without uninstalling, set `KOPT_HOOKS=0` in the environment Kiro runs in. Governor state lives
in `~/.kopt/sessions/<session id>.json`.

## Configuration

kopt works without configuration. To change a value, create a JSON file. Files are merged in this order, later
wins:

1. built-in defaults
2. `~/.kopt/config.json`: your defaults for every project
3. `<data dir>/config.json`: one project, in the project's cache folder, or in `<root>/.kopt/` in per-project mode
   (see below)
4. `<root>/kopt.config.json`: one project, can be committed
5. environment variables (`KOPT_TELEMETRY`, `KOPT_LEGACY_WORKSPACE_HOOKS`, `KOPT_DATA_DIR`, `KOPT_HOME`)

Objects are merged key by key; arrays (`exclude`) replace the default list. A relative `dataDir` is resolved against
the project root. Example `kopt.config.json`:

```json
{
  "budgets": { "pack": 3000 },
  "governor": { "maxToolCallsPerSession": 300, "bigFileTokens": 12000 }
}
```

### Config keys

| Key | Default | Meaning |
|---|---|---|
| `dataDir` | the project's cache folder (see below) | where the index and `kopt_run` logs live |
| `exclude` | `node_modules/`, `vendor/`, `dist/`, `build/`, `out/`, `target/`, `bin/`, `obj/`, `.git/`, `.kopt/`, `.gradle/`, `.idea/`, `.vscode/`, `__pycache__/`, `.venv/`, `venv/`, `.next/`, `.nuxt/`, `coverage/`, `*.min.js`, `*.min.css`, `*.map`, `*.lock`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `*.generated.*`, `*.g.cs`, `*.designer.cs`, `*_pb2.py`, `*.pb.go` | gitignore-syntax patterns not indexed, on top of `.gitignore`, `.kiroignore` (nested ones included) and Kiro's global `~/.kiro/settings/kiroignore`. Setting it replaces this list |
| `maxFileBytes` | `1000000` | files larger than this are not indexed |
| `budgets.find` | `700` | `kopt_find` budget (hits mode), in tokens |
| `budgets.pack` | `2500` | `kopt_find` budget in pack mode |
| `budgets.read` | `3000` | `kopt_read` budget for ranges, and for any read that passes `maxTokens` |
| `budgets.readSymbol` | `6000` | `kopt_read` of a named function or method without `maxTokens`: the whole body up to this size in one call (longer: its first part and the range of the rest) |
| `budgets.readFile` | `4000` | `kopt_read` of a file or a type without `maxTokens`: verbatim up to this size, else a skeleton |
| `budgets.outline` | `1200` | outline budget (`kopt_read` of a directory or with `mode: "outline"`, `kopt outline`) |
| `budgets.refs` | `900` | `kopt_refs` budget |
| `budgets.run` | `900` | `kopt_run` budget |
| `budgets.expand` | `1500` | `kopt_run` log budget (`kopt_read <handle>`, `kopt expand`) |
| `budgets.frontload` | `0` | prompt pointers budget; `0` (the default) disables them |
| `dedup.enabled` | `true` | do not re-send code already returned in the session (answers `unchanged`; `fresh: true` resends) |
| `dedup.windowCalls` | `40` | ... if it was returned within this many tool calls |
| `dedup.windowMinutes` | `30` | ... and within this many minutes (Kiro's compaction drops old tool results) |
| `governor.maxToolCallsPerSession` | `200` | tool-call budget per Kiro session; `0` disables |
| `governor.bigFileTokens` | `8000` | a whole-file read of a file estimated above this many tokens is blocked once; `0` disables |
| `governor.bigFileLines` | `800` | a read with a range wider than this many lines counts as a whole-file read; `0` disables the big-read rule |
| `governor.enforceRunForVerbose` | `true` | redirect verbose test/build shell commands to `kopt_run` once |
| `governor.blockDuplicateRuns` | `true` | block an identical test/build re-run with no file change once |
| `telemetry.enabled` | `true` | write the local usage log (read by `kopt stats`; never sent anywhere) |
| `charsPerToken` | `3.0` | token estimate used for every budget (conservative on purpose) |
| `kiro.legacyWorkspaceHooks` | `"auto"` | Kiro IDE 0.x workspace prompt hook: `"auto"` (when the installed IDE is 0.x), `"on"`, `"off"` |

`root` and `userDir` are derived at run time. Set them with `KOPT_ROOT` and `KOPT_HOME`, not in a config file.

**A committed `kopt.config.json` is applied as it is.** Today a repository's config file (and `.kopt/config.json` in
per-project mode) can set any key, `root`, `dataDir`, `userDir` and the governor settings included: a repository can
point kopt at another folder or turn its guards off. Check for these files in repositories you did not write.
Restricting repository files to harmless keys is planned.

### Environment variables

| Variable | Effect |
|---|---|
| `KOPT_ROOT` | project root for `kopt mcp`, the hooks and the CLI commands (used when the MCP client sends no roots) |
| `KOPT_DATA_DIR` | data folder (index, `kopt_run` logs) of the project, for this process; relative to the project root if relative |
| `KOPT_CACHE_DIR` | parent folder of all per-project data folders |
| `KOPT_HOME` | kopt's user folder (default `~/.kopt`) |
| `KOPT_KIRO_HOME`, `KIRO_HOME` | Kiro's user folder (default `~/.kiro`); `KOPT_KIRO_HOME` wins. Credit collection (`kopt credits`, `kopt stats`) reads both `KIRO_HOME` and `~/.kiro` (Kiro IDE always writes under `~/.kiro`); `KOPT_KIRO_HOME` replaces both |
| `KOPT_KIRO_USER_SETTINGS` | path of the Kiro IDE user `settings.json` that `setup` edits |
| `KOPT_KIRO_IDE_PATHS` | Kiro IDE install folders or `package.json` paths to detect (`:`-separated, `;` on Windows), replacing the default search |
| `KOPT_KIRO_CLI` | path of the `kiro-cli` executable to detect, or `none` |
| `KOPT_INSTALL_SPEC` | npm spec that `setup` installs globally (default: the copy npx is running) |
| `KOPT_HOOK_COMMAND` | `node` or `shim`: force how Kiro starts kopt (explicit `node <bin.js>`, or the `kopt` command on `PATH`) |
| `KOPT_CLI` | path of the `bin.js` to use in the Kiro configuration and for background refreshes |
| `KOPT_LEGACY_WORKSPACE_HOOKS` | `0`/`off` or `1`/`on`: Kiro IDE 0.x workspace prompt hook (overrides `kiro.legacyWorkspaceHooks`) |
| `KOPT_INDEX_ON_START` | `0`: do not start the background index build when the MCP server starts (it starts on the first tool call) |
| `KOPT_INDEX_WORKERS` | number of parse worker threads (default: up to 4, 2 with less than 12 GB of memory; `0` or `1` parses in-process) |
| `KOPT_HOOKS` | `0`: disable all kopt hooks |
| `KOPT_TELEMETRY` | `0`: no local usage log (`kopt stats` then has nothing to report); `1`: write it even when a config file turns it off |
| `KOPT_SHELL` | shell for `kopt_run` / `kopt run`: a name (`bash`, `sh`, `pwsh`, `powershell`, `cmd`) or a path |
| `KOPT_SESSION` | session id that CLI tool commands record in the usage log (default `cli`). When set, the CLI keeps that session's dedup ledger between calls (`<dataDir>/ledgers`, 30-minute window, as the MCP server within a session): an agent driving kopt through the shell gets "unchanged" for code it was already sent. Unset, every CLI call is stateless |
| `KOPT_DEBUG` | print the stack trace of CLI errors, and hook error messages, on stderr (do not leave it on: hook output reaches Kiro) |
| `KOPT_INDEX_DEBUG` | `1`: indexer debug logs on stderr |
| `KOPT_INDEX_BULK_MIN` | file count from which a first build writes in larger batches (default 2000) |
| `KOPT_NO_REEXTRACT` | `1`: do not re-parse stale files in the background when a tool reads them |
| `KOPT_CHARS_PER_TOKEN` | initial token estimate; replaced by the `charsPerToken` config value as soon as a config is loaded, so use the config key |

kopt sets `KOPT_RUN` on the commands `kopt_run` starts, and `KOPT_BACKGROUND` on its background refreshes. Do not set
them yourself. The commands `kopt_run` starts get no other `KOPT_*` variable: kopt's own settings (`KOPT_SESSION`,
`KOPT_ROOT`, `KOPT_HOME`...) never leak into your tests and builds.

### Where data lives

| Data | Linux | macOS | Windows |
|---|---|---|---|
| Per-project folder (`<name>-<hash>`): `index.db`, `kopt_run` logs (`outputs/`), optional `config.json` | `$XDG_CACHE_HOME/kopt/` (default `~/.cache/kopt/`) | `~/Library/Caches/kopt/` | `%LOCALAPPDATA%\kopt\` |
| User folder: usage log (`telemetry/<day>.jsonl`, 90 days), governor sessions, install state, `config.json`, `hook-errors.log` | `~/.kopt/` | `~/.kopt/` | `%USERPROFILE%\.kopt\` |
| Kiro configuration written by `setup` | `~/.kiro/` | `~/.kiro/` | `%USERPROFILE%\.kiro\` |

**Per-project mode.** If a project has a `.kopt/` folder at its root, kopt keeps that project's index there instead
of the user cache. Create it with `mkdir .kopt` before the first index. `kopt init` then adds `.kopt/` to
`.gitignore` and `.kiroignore`. `KOPT_DATA_DIR` or a `dataDir` key override both locations.
