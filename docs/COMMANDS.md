# Tools and commands

The 4 tools the Kiro agent uses, then every `kopt` command with all its options. Start with the [README](../README.md) for the overview.

## Tools the agent uses (MCP)

`kopt mcp` lists 4 tools. Every request carries their specs and the always-on steering, so each spec is one line
and lists only the parameters of the common calls: 348 tokens in all (chars / 3), against 852 for the 6 tools of
v0.1 (`test/mcp.test.ts` keeps it under 350). In the agent A/B, kopt's prompt added a median of
<!--v:ab.koptPrompt-->+282<!--/v--> tokens per request, measured with the model's own tokenizer. The other parameters are still accepted, and the outputs name them where
they help. `kopt_outline` and `kopt_expand` are reached through `kopt_read` (a directory, `mode: "outline"`, a
`kopt_run` log handle) and still answer by name. The three read-only tools are auto-approved in `mcp.json`, so
`kopt_read` refuses, in one line, files excluded by `.gitignore`, `.git/info/exclude` or `.kiroignore` (whatever the
spelling: `debug.log`, `./id_rsa`, a symlink to one), anything under `.git`, and paths or symlinks that leave the
project; the same check applies to every line kopt quotes from disk (`kopt_find` bodies, `kopt_refs` code lines). `kopt_run` executes commands, so Kiro still asks before running it. Every tool
returns compact text and accepts `maxTokens`, clamped to 50-8000. Handles such as `#sn` (symbols) and `o3fad54`
(command outputs) can be passed from one tool to another.

| Tool | Purpose | Listed parameters | Also accepted | Default budget | Example of output |
|---|---|---|---|---|---|
| `kopt_find` | Ranked search by identifiers or plain words (case- and camelCase-insensitive). Each listed file ends with an `also:` line naming its other relevant symbols. `mode: "pack"` adds the bodies of the best symbols, the callers (`path: L<line> in <caller>`) of the symbols the query names and the callees of the best body: "how does X work" in one call. | `query`, `mode` (`pack`; hits by default) | `kinds` (e.g. `["class","function"]`), `path` (prefix or glob), `limit` (12, max 100; pack: 8 with signatures then compact ones), `maxTokens`, `fresh` (resend bodies already shown) | 700 (hits), 2,500 (`pack`) | `#qz 252-279 function export function loadConfig(root: string = process.cwd(), opts: LoadConfigOptions = {}): KoptConfig` |
| `kopt_read` | Exact code by `#handle`, `Class.method`, `path` or `path:start-end`; code already shown returns `unchanged`. A directory, a glob or `.` (the repo), or `mode: "outline"` on a file: the structure map with the line of each member (on a type: its skeleton). A `kopt_run` log handle (`o3fad54`, `o3fad54:120-180`): that log, filtered by `grep` (regex, 2 lines of context) when given. | `target`, `mode` (`outline`) | `mode` `body` (default), `skeleton` (signatures only), `card` (≈ 60 tokens); `focus` (outline: task words ranked first); `grep`, `startLine`, `endLine` (logs); `maxTokens`, `fresh` | code 3,000 (a function whole up to 6,000, a file up to 4,000), outline 1,200, log 1,500 | `src/core/config.ts:252-279 #qz` then the 28 lines of code; `outline src/compress/runner.ts · 67 symbols · 566 lines` then `L60 export function quietEnv(...)` lines |
| `kopt_refs` | Callers/usages (`in`), callees (`out`) or `both` of a `#handle`, `Class.method` or field. One line per caller: the call line, the caller's handle and declaration lines, then the code of the call line; the readers and writers of a field are tagged `read` / `write`. The callers of a thin wrapper (a small function that only forwards to the target) follow under `via wrapper`. A last line says whether the list is `complete` (every reference to the name resolved, every function whose code names it listed) or `incomplete`, and what may be missing (unresolved same-name references are listed under `possible`). | `target` | `direction` (`in` default, `out` = callees, `both`), `depth` (`2` = callers of callers), `maxTokens` | 900 | `src/cli.ts:26 in #1r6 config (defined 24-27): return loadConfig(root ? resolve(root) : findRoot());` + `incomplete: 1 function names loadConfig with no reference linked: src/mcp/local.ts:635 in #2aw AutoRepo.setDecision (defined 635-654)` |
| `kopt_run` | Runs a test, build or lint command in the repo and returns only the verdict, failures and errors (a short output as it is, a short passing test run as its verdict line). The full log is stored. An identical re-run with no file change returns the stored result without running again; an identical command still running is joined, not started twice. Commands that never exit by themselves (watch modes, dev servers, `tail -f`) are refused in one line unless `timeoutSec` is given. Cancelling the call kills the command. On Linux and macOS the command's `PATH` also holds the folder of kopt's Node, your login shell's `PATH` and the common bin folders; a program still not found (exit 127) gets one `kopt:` line naming it and the `PATH` sources. When the failures of a test run do not all fit in detail, every failing test is listed first (grouped by file, tests with the same error on one line), then as many failures in detail as the budget holds. When a run fails and the project index is ready, up to 200 more tokens say where the failure points in the source: the function around each stack frame in the repo, the deepest first; for each failing test, the product function it calls, followed through thin wrappers down to the function that sets the field its diff shows or the one the test is named after; and the one function that has the failure message as a string literal. | `command` | `cwd` (relative to the repo root), `timeoutSec` (600 default, max 21600), `maxTokens`, `fresh` (force a re-run) | 900 (+200 of source context) | `exit 1 · 8.2s · raw ~4562 tok` then the failures, then `full output: kopt_read o3fad54 (grep=<regex> filters it)`, then `source (kopt index):` lines such as `test test/a.test.ts:57 (test L49-64) calls #nc runCommand src/compress/index.ts:351 > #nr execute src/compress/index.ts:425 (sets stored)` |

Valid `kinds`: `class`, `interface`, `enum`, `type`, `record`, `struct`, `trait`, `module`, `namespace`, `function`,
`method`, `constructor`, `field`, `property`, `constant`. `function`, `method` and `constructor` match each other,
`class` also matches structs and records, `field` also matches properties. When the `kinds` or `path` filter leaves
no hit, `kopt_find` returns the hits without that filter, under a `note:` line.

A typical exchange, as the agent sees it:

```text
kopt_find {"query": "load config", "kinds": ["function"]}
find "load config" · 12 hits · ~679 tok
src/core/config.ts
  #qz 252-279 function export function loadConfig(root: string = process.cwd(), opts: LoadConfigOptions = {}): KoptConfig — Load config: ...
  #qu 203-223 function export function defaultConfig(root: string): KoptConfig
  also: indexPath L281 #r0, pathFor L104 #qk, usesProjectDataDir L199 #qt, ...
...

kopt_find {"query": "who calls loadConfig", "mode": "pack"}
pack "who calls loadConfig" · 3 hits · 2 bodies · ~1093 tok
...                                    -> pointers, then the bodies of loadConfig and LoadConfigOptions
callers of #qz loadConfig · 17 refs in 9 files · complete:
  src/cli.ts: L26 in #1r6 config (defined 24-27); L116 in #1rg hookMain (defined 89-133); L358 in #1rw main (defined 322-542)
  src/hooks/index.ts: L29 import; L609 in #35h runHookCli (defined 585-618)
  ...
  tests: test/bench-ab.test.ts (2), test/hooks-shell.test.ts (2), test/setup.test.ts (2), +1 file
  via wrapper #1r6 config · 3 refs:
    src/cli.ts: L170 in #1rk tool (defined 169-176); L212 in #1rq cmdIndex (defined 211-230); L233 in #1rr cmdCredits (defined 232-253)
callees of #qz loadConfig:
  src/core/config.ts: #qu defaultConfig, #qw merge
  ...

kopt_read {"target": "#qz"}            -> the 28 lines of loadConfig
kopt_refs {"target": "#qz"}            -> 17 usages in 9 files (+3 through the config() wrapper), one line per usage
kopt_run  {"command": "npm test"}      -> verdict + failures (a median of 188 tokens on the 35 failing fixtures, 738 per kopt run in the agent A/B)
kopt_read {"target": "o3fad54", "grep": "TypeError"}
kopt_read {"target": "src/core", "mode": "outline"}  -> map of src/core: the main symbols of each file
```

The `kopt-explorer` sub-agent (on `claude-haiku-4.5` by default) can use `kopt_find`, `kopt_read` and `kopt_refs` for "where / how is X
done" questions. It answers with `path:start-end` spans, not code dumps. Kiro CLI loads it; from a reading of the IDE
bundles (0.12 and 1.2), Kiro IDE skips agent files that carry CLI-only fields such as `allowedTools`, which this one
has. Whether agents delegate to it, and what it saves, is not measured.

## Command reference

Every command except `hook` accepts `-h, --help` (`kopt --help`, `kopt <command> --help`). `kopt hook --help`
prints nothing (a hook must stay silent), so use `kopt help hook`. `kopt help <command>` works for the other commands
too, except `bench`: use `kopt bench --help`. `kopt -V, --version` prints the version.

| Command | For | Purpose |
|---|---|---|
| [`setup`](#kopt-setup) | you | one-time setup for every project |
| [`doctor`](#kopt-doctor) | you | check the installation |
| [`uninstall`](#kopt-uninstall) | you | remove what kopt wrote |
| [`init`](#kopt-init) | you | optional per-project install |
| [`index`](#kopt-index) | you | build or update a project's index |
| [`find`](#kopt-find), [`read`](#kopt-read), [`outline`](#kopt-outline), [`refs`](#kopt-refs) | you, scripts, other agents | the code tools from a terminal |
| [`run`](#kopt-run), [`expand`](#kopt-expand) | you, scripts, other agents | compact command output from a terminal |
| [`stats`](#kopt-stats), [`credits`](#kopt-credits) | you | token savings (gross) and Kiro credits report |
| [`bench`](#kopt-bench) | maintainers | offline benchmark (from a clone of this repository) |
| [`mcp`](#kopt-mcp) | **called by Kiro** | the MCP server |
| [`hook`](#kopt-hook) | **called by Kiro** | the session governor hook entry point |

The code and output commands (`find`, `read`, `outline`, `refs`, `run`, `expand`) print the same text as the MCP
tools. They exit with 1 on invalid arguments or an internal failure. When the command fails, `kopt run` exits with the
command's own exit code (124 after `--timeout`, 127 when the command cannot be started). A lookup that finds nothing
(unknown handle, missing file, no matching symbol) prints a one-line message and exits 0. `find`, `read`, `outline`
and `refs` build the index on first use when there is none. The `--root <dir>` option of these commands sets the
project root. By default it is `KOPT_ROOT` (used as is), else the nearest folder (the current one included) that holds
`.git` or `.kopt/index.db` (never above your home folder), else the current folder.

### `kopt setup`

One-time setup. It installs kopt globally if needed and configures Kiro IDE and Kiro CLI for every project. It
installs kopt globally with npm unless the running copy is already the global install or you pass `--no-global`; a
development checkout is left alone unless you pass `--global`. It packs the running copy (the one npx already built,
or your checkout) and installs it with `npm install -g`. It then detects the installed Kiro surfaces, writes the
user-level files, and ends with the user-level `doctor` checks.

```text
kopt setup [options]
```

| Option | Argument | Default | Meaning |
|---|---|---|---|
| `--surface` | `<surface>`: `ide`, `cli`, `all` | the detected surfaces (all of them when none is detected) | configure these surfaces whatever is detected |
| `--no-global` | | global install on | do not install kopt globally with npm. When the running copy is npx's, setup installs a private copy in `~/.kopt/runtime` instead: Kiro never runs kopt from the npx cache, which npm purges |
| `--global` | | off from a checkout | install kopt globally with npm even from a development checkout (from npx it is the default) |
| `--dry-run` | | off | show what would be written |
| `--force` | | off | overwrite kopt files edited by hand and make kopt the Kiro CLI default agent. Your `env`, `disabled`, `disabledTools` and `autoApprove` edits in the `kopt` entry of `mcp.json` are kept |
| `--no-doctor` | | checks on | skip the final checks |
| `--explorer-model` | `<id>` | `claude-haiku-4.5` | model for the read-only explorer agent |

```bash
npx -y github:dorian-richard/kiro-optimizer setup     # first install
kopt setup --dry-run                                   # preview after a Kiro upgrade
kopt setup --surface cli --force                       # Kiro CLI only, and make kopt the default agent
```

### `kopt doctor`

It checks Node, `PATH`, the Kiro surfaces, the config files, the MCP server and the index status. It also checks
that the hooks run silently: it runs the configured hook command the way Kiro does and checks that an allowed call
prints nothing and a blocked call exits 2. It starts the MCP server and lists its tools. These checks run in a
scratch folder, so nothing of yours is touched. It prints one `ok` / `warn` / `fail` line per check, with a fix, and
exits with 1 when a check fails.

```text
kopt doctor [options]
```

| Option | Argument | Default | Meaning |
|---|---|---|---|
| `--root` | `<dir>` | current folder | folder whose index status to report |
| `--quick` | | off | skip the checks that start processes (hook, MCP server) |

```bash
kopt doctor
kopt doctor --quick --root ~/code/my-service
```

### `kopt uninstall`

It removes what `kopt setup` / `kopt init` wrote, and the index caches. Only kopt's own entries are removed: the
`kopt` server in `mcp.json`, kopt's hook, agent and steering files (an edited copy is kept and listed; `--force`
removes it), its marked block in `kiroignore`, `chat.defaultAgent` if it is still `kopt`, and the `.kiroignore` IDE
setting if setup added it. It also removes the IDE 0.x workspace hooks. Running it twice is harmless.

```text
kopt uninstall [options]
```

| Option | Argument | Default | Meaning |
|---|---|---|---|
| `--keep-index` | | off | keep the index caches |
| `--purge` | | off | also delete `~/.kopt` (telemetry, governor state) |
| `--user` | | user and workspace | only the user-level configuration |
| `--workspace` | | user and workspace | only the files `kopt init` wrote in this project |
| `--force` | | off | also remove kopt files you edited since kopt wrote them |
| `--dry-run` | | off | show what would be removed |
| `--root` | `<dir>` | project root of the current folder | project whose `kopt init` files are removed |

```bash
kopt uninstall --dry-run
kopt uninstall --purge && npm uninstall -g kiro-optimizer
```

### `kopt init`

Optional per-project install, for a team that commits kopt's Kiro files instead of running `setup`. It writes
`.kiro/settings/mcp.json` (server pinned to this root), `.kiro/hooks/kopt.json`, `.kiro/steering/kopt*.md`,
`.kiro/agents/kopt-explorer.json`, a `.kiroignore` block suggested from an analysis of the repository, and the
`.vscode/settings.json` ignore setting. Existing files are skipped unless you pass `--force`. `kopt setup` already
covers every project.

```text
kopt init [options]
```

| Option | Argument | Default | Meaning |
|---|---|---|---|
| `--user` | | workspace (`<root>/.kiro`) | install for the user (`~/.kiro`): same files as `kopt setup`, without the npm install |
| `--dry-run` | | off | show what would be written |
| `--force` | | off | overwrite existing files |
| `--explorer-model` | `<id>` | `claude-haiku-4.5` | model for the read-only explorer agent |
| `--root` | `<dir>` | project root of the current folder | project to install into |

```bash
cd ~/code/my-service && kopt init --dry-run
kopt init --root ~/code/my-service --force
```

`.kiro/settings/mcp.json` always pins this checkout's absolute path (`kopt mcp --root /abs/path`) and, by default,
the absolute paths of `node` and `bin.js` (whether or not kopt is on `PATH`); `.kiro/hooks/kopt.json` runs the
absolute path of the `~/.kopt/bin/kopt` launcher. Keep `.kiro/settings/mcp.json` and `.kiro/hooks/kopt.json` out of
git (or set `KOPT_HOOK_COMMAND=shim` for the bare `kopt` command, which must then be on the `PATH` Kiro sees; the
`--root` path stays); commit the steering, agent, `.kiroignore` and `.vscode/settings.json` files. `kopt init` prints
the same advice.

### `kopt index`

Build or update the local index of a project. Unchanged files are skipped. The MCP server does this by itself in the
background; run it by hand to pre-build a big repository or after a large pull. When another kopt process is
indexing the same project (a Kiro window's MCP server), it waits for it, then only catches up.

On a large repository expect, for the first build, about 1.5 minutes and up to 2 GB of memory for 30k Java files
(search answers after about 30 s; 30 s in all for 15k TypeScript files), and an index of about 1 GB on disk
(`kopt doctor` shows the size); see `bench/results/scale-elasticsearch.md` for a measured 33k-file build, refreshes
and query latencies. Each checkout or
worktree has its own index; `kopt uninstall` removes them all.

```text
kopt index [options]
```

| Option | Argument | Default | Meaning |
|---|---|---|---|
| `--root` | `<dir>` | nearest git root | repo root |
| `--refresh` | | off | only re-index files changed since the last run (cheap check: git listing plus mtime/size) |
| `--if-idle` | | off | do nothing when another kopt process is indexing this project (default: wait for it) |

```bash
kopt index
kopt index --refresh --root ~/code/my-service
# indexed 206 files (1 parsed, 205 unchanged, 0 deleted) · 4941 symbols · 30900 refs · 0.4s
```

### `kopt find`

Search code (`kopt_find`). The query words are joined with spaces.

```text
kopt find [options] <query...>
```

| Option | Argument | Default | Meaning |
|---|---|---|---|
| `<query...>` | | required | identifiers or plain words |
| `--pack` | | off (`hits` mode) | include bodies of the best symbols, their callers (path:line) and callees |
| `--max-tokens` | `<n>` | 700 (2,500 with `--pack`) | token budget |
| `--path` | `<prefix>` | whole repo | restrict to a path prefix or glob |
| `--kinds` | `<list>` | all kinds | symbol kinds, e.g. `class,function` |
| `--limit` | `<n>` | 12 | max hits (with `--pack`, the first 8 with signatures, the rest compact) |
| `--root` | `<dir>` | see above | project root |

```bash
kopt find "where is the refund amount computed" --pack
kopt find OrderService place --kinds class,method --path src/billing --limit 5
```

### `kopt read`

Read a symbol, file or range, the outline of a directory, or a `kopt run` log (`kopt_read`).

```text
kopt read [options] <target>
```

| Option | Argument | Default | Meaning |
|---|---|---|---|
| `<target>` | | required | `#handle`, `Class.method`, `path`, `path:start-end`, a directory, `.` (the repo), or a `kopt run` log handle (`o1a2b3c`, `o1a2b3c:40-90`) |
| `--mode` | `<mode>`: `body`, `skeleton`, `card`, `outline` | `body`; a file or type over 4,000 tokens gets its skeleton, a function over 6,000 its first part and the range of the rest | what to return (`outline`: the structure map of a file, the members of a type) |
| `--focus` | `<words>` | none | (outline) rank files/symbols relevant to these words first |
| `--grep` | `<regex>` | none | (log) filter lines (case-insensitive, with 2 lines of context) |
| `--start`, `--end` | `<line>` | whole log | (log) line range |
| `--max-tokens` | `<n>` | 3,000 for ranges; a named function comes whole up to 6,000, a file or type up to 4,000; outline 1,200; log 1,500 | token budget |
| `--root` | `<dir>` | see above | project root |

```bash
kopt read "#3mv"
kopt read OrderService.place --mode card
kopt read src/billing/refund.ts:40-90
kopt read src/billing --focus refund
kopt read o1a2b3c --grep "FAIL|Exception"
```

Quote `#handles`: an unquoted `#` starts a comment in most shells. `kopt outline` and `kopt expand` below do the same
as `kopt read` of a directory and of a log handle.

### `kopt outline`

Structure map of the repo, a directory or a file (`kopt_outline`).

```text
kopt outline [options] [path]
```

| Option | Argument | Default | Meaning |
|---|---|---|---|
| `[path]` | | whole repo | folder or file to map |
| `--focus` | `<words>` | none | rank files/symbols relevant to these words first |
| `--max-tokens` | `<n>` | 1,200 | token budget |
| `--root` | `<dir>` | see above | project root |

```bash
kopt outline src/billing --focus refund
kopt outline --focus "session governor" --max-tokens 600
```

### `kopt refs`

Callers / callees of a symbol (`kopt_refs`).

```text
kopt refs [options] <target>
```

| Option | Argument | Default | Meaning |
|---|---|---|---|
| `<target>` | | required | `#handle`, `Class.method` or a field (a plain name works when it is unambiguous) |
| `--direction` | `<dir>`: `in`, `out`, `both` | `in` | callers/usages, callees, or both |
| `--depth` | `<n>`: `1`, `2` | `1` | `2` adds callers of callers (impact) |
| `--max-tokens` | `<n>` | 900 | token budget |
| `--root` | `<dir>` | see above | project root |

```bash
kopt refs OrderService.place --depth 2
kopt refs "#1rb" --direction out
```

### `kopt run`

Run a command and print compact output (`kopt_run`). Options go **before** the command. A single argument is passed
to the shell as is, so pipes work. Several arguments are quoted for the shell. A cacheable command (a test, build,
lint or read-only git command) re-run with no file change in the repo returns the stored result.

```text
kopt run [options] <command...>
```

| Option | Argument | Default | Meaning |
|---|---|---|---|
| `<command...>` | | required | one argument = a shell command line as is; several = argv |
| `--cwd` | `<dir>` | repo root | working directory relative to the repo root |
| `--timeout` | `<sec>` | 600 (max 21600) | timeout in seconds; the whole process tree is killed. Also the way to run a command that never exits (dev server, watch mode) for a bounded time |
| `--max-tokens` | `<n>` | 900 | token budget |
| `--fresh` | | off | bypass the identical-command cache |
| `--root` | `<dir>` | see above | project root |

```bash
kopt run -- mvn -q test
kopt run --cwd services/api --timeout 900 "npm test && npm run lint"
```

kopt sets quiet environment variables for the child process: no color, no progress bars, Maven batch mode, and
similar.

### `kopt expand`

Show more of a `kopt_run` output (`kopt_expand`). `--grep` and the line range can be combined.

```text
kopt expand [options] <handle>
```

| Option | Argument | Default | Meaning |
|---|---|---|---|
| `<handle>` | | required | output handle printed by `kopt run` (`full output: kopt_read <handle>`) |
| `--grep` | `<regex>` | none | filter lines (case-insensitive, with 2 lines of context) |
| `--start` | `<line>` | 1 | first line |
| `--end` | `<line>` | last line | last line |
| `--max-tokens` | `<n>` | 1,500 | token budget |
| `--root` | `<dir>` | see above | project root |

```bash
kopt expand o1a2b3c --grep "FAIL|Exception"
kopt expand o1a2b3c --start 1 --end 40
```

### `kopt stats`

Token savings (gross) and Kiro credits report, from the local usage log. It shows a **kopt tools** table (calls,
tokens returned, and the exact baseline where it is known: raw command output, full file), one **governor blocks**
line by rule (`governor blocks: budget 4 · verbose-cmd 1 · …`), and a **context intake by tool** table (what each tool
put into the context) once hooks have recorded tool responses. Last come the per-request Kiro credits found in local
session files.

```text
kopt stats [options]
```

| Option | Argument | Default | Meaning |
|---|---|---|---|
| `--days` | `<n>` | 7 | window in days |
| `--root` | `<dir>` | see above | project whose config to use |

```bash
kopt stats
kopt stats --days 30
```

### `kopt credits`

Collect Kiro session credits and print a summary. It reads, without changing them, Kiro CLI 2.x session files
(`~/.kiro/sessions/cli/*.json`) and IDE 1.x / CLI V3 sessions (`~/.kiro/sessions/*/*/messages.jsonl`). It prints the
credits collected since the last collection, per day (30 most recent days), and adds them to the usage log:
`kopt stats` shows the full history.

```text
kopt credits [options]
```

| Option | Argument | Default | Meaning |
|---|---|---|---|
| `--root` | `<dir>` | see above | project whose config to use |

```bash
kopt credits
```

### `kopt bench`

Offline proxy benchmark. It compares the tokens returned to the model and the recall of verified gold items: native
Kiro exploration (`grep_search` + `read_file`) against kopt (`kopt_find` / `kopt_read`) and recorded competitor
outputs. It runs from a clone of this repository, because it reads `bench/` and needs the checkouts listed in
[bench/README.md](../bench/README.md).

```text
kopt bench [<repo-name|tasks.json> ...] [options]
kopt bench quality <repo-name> ... [options]
kopt bench failures [<repo-name> ...] [options]
kopt bench all [options]
```

| Form | Meaning |
|---|---|
| (default) | run the strategies on `bench/tasks/<repo>.json` (all task files when none is given) |
| `quality <repo> ...` | index the repo and measure extraction quality per language -> `bench/results/quality-<repo>.{md,json}` |
| `failures [<repo> ...]` | run `kopt-pack` and classify every miss (ranking, unresolved refs, extraction gap, budget/format, multi-step) with evidence from the index; all repos of `bench/langs.json` by default -> `bench/results/failures.{md,json}` (`failures-<repo>.*` when repos are named) |
| `all` | every repo of `bench/langs.json`: verify + index + quality + strategies + failures -> `bench/results/<repo>.{md,json}`, `quality-<repo>.*`, `failures.*`, `summary.{md,json}` |

| Option | Argument | Default | Meaning |
|---|---|---|---|
| `--all` | | | run every `bench/tasks/*.json` (default command) |
| `--repo` | `<path>` | `bench/repos/<name>` | checkout to explore |
| `--strategies` | `<list>` | the built-ins + competitors that have a results file | comma list of `native-naive`, `native-ranged`, `kopt-pack`, `kopt-hits+read`, `kirograph`, `codegraph` |
| `--input` | `search`, `question`, `natural` | `search` | feed the agent-derived search phrase, the raw prompt, or the identifier-free paraphrase (falls back to the prompt) |
| `--tasks` | `<ids>` | all | comma list of task ids |
| `--only` | `<names>` | all | (`all`) comma list of repo names from `bench/langs.json` |
| `--label` | `<name>` | repo name | results file name |
| `--out` | `<dir>` | `bench/results` | output directory |
| `--index-dir` | `<dir>` | `bench/repos/.kopt-<name>` | kopt index location; with several repos (and for `all`) the parent folder: one `<dir>/.kopt-<name>` per repo |
| `--rebuild-index` | | off | delete and rebuild the kopt index first |
| `--competitors` | `<dir>` | `bench/competitors/results` | competitor results directory |
| `--parse-sample` | `<n>` | 1000 | (`quality`) files re-parsed per language |
| `--precision-sample` | `<n>` | 30 | (`quality`) symbols checked per language |
| `--no-quality` | | off | (`all`) skip the quality pass |
| `--no-failures` | | off | (`all`) skip the failure analysis |
| `--clone` | | off | (`all`) clone missing checkouts at their pinned tag |
| `--langs` | `<file>` | `bench/langs.json` | (`all`) corpus file |
| `--chars-per-token` | `<n>` | 3.0 | token estimate calibration |
| `--raw` | | off | also write `<label>.raw.json` with every output |
| `--verify` | | off | only check gold items against the checkout (exit code 1 on issues) |

```bash
kopt bench --all --verify
kopt bench django --strategies native-ranged,kopt-pack --raw
```

#### `kopt bench ab`

Online A/B on your own repository: the same questions run through the real Kiro CLI in a stock arm and a kopt arm,
and the report compares the credits Kiro bills, at equal correctness. It spends real credits under a budget
(`--max-credits`; a single run can overshoot it, see the guide). It works from an installed kopt too (it does not
need `bench/`). Step-by-step guide, cost and isolation details:
[bench/ab/README.md](../bench/ab/README.md).

**Read the guide's account warning first.** Kiro's anti-abuse checks can suspend an account that sends automated
requests (it happened to a Free account on its first headless request, after a script had triggered a login). Log in
yourself, never let a script log in, avoid many logins, logouts and headless sessions in a short time, and prefer a
paid account for A/B campaigns. Support: <https://support.aws.amazon.com/#/contacts/kiro>.

```text
kopt bench ab --check --repo <path> --tasks <file>                  preflight, no prompt sent
kopt bench ab --repo <path> --tasks <file> --max-credits <N>        the campaign
kopt bench ab report --out <dir>                                    rebuild the report (keeps manual grades)
kopt bench ab clean --out <dir>                                     remove worktrees, KIRO_HOMEs, kopt indexes
```

Main options: `--arms A,B[,C]`, `--reps <n>` (2), `--model <id>` (`claude-sonnet-4.5`), `--engine v2|v3` (`v2`),
`--credits-per-run <n>` (2), `--max-run-credits <n>`, `--timeout <s>` (600), `--out <dir>`, `--resume`, `--smoke`
(opt-in smoke run), `--list-models` (opt-in model-list request). `kopt bench ab --help` lists them all, with the exit
codes. Measure one task on the cheapest model before a campaign: the guide has the recipe.

### `kopt mcp`

**Called by Kiro**, through the `mcp.json` entry that `setup` writes. It runs the MCP server over stdio. Without
`--root` it serves the project Kiro opens (see [How kopt works](HOW-IT-WORKS.md), step 3). Any other MCP client can run it
the same way.

```text
kopt mcp [options]
```

| Option | Argument | Default | Meaning |
|---|---|---|---|
| `--root` | `<dir>` | from the MCP client roots, `KOPT_ROOT`, then the git root of the cwd | fixed repo root |

```json
{ "mcpServers": { "kopt": { "command": "/usr/local/bin/node", "args": ["/usr/local/lib/node_modules/kiro-optimizer/dist/bin.js", "mcp"], "timeout": 900000, "requestTimeout": 900000 } } }
```

`kopt setup` writes absolute paths like these, and 900 s timeouts because Kiro CLI cuts MCP calls at 120 s by default
(a long `kopt_run` build would fail). `"command": "kopt", "args": ["mcp"]` also works when `kopt` is on the `PATH`
that Kiro sees.

### `kopt hook`

**Called by Kiro command hooks**: the session governor. Kiro pipes the event JSON to its stdin. It exits 0 silently
when it allows the call. It exits 2 with a one-line message on stderr to block. Any internal error is a silent exit
0, so a kopt bug never breaks your session. Errors in the event handler are logged to `~/.kopt/hook-errors.log`; an
unreadable payload (invalid JSON, no `hook_event_name`) is reported only with `KOPT_DEBUG=1`.

```text
kopt hook [options] [event]
```

| Option | Argument | Default | Meaning |
|---|---|---|---|
| `[event]` | | from the payload | event name used when the payload has no `hook_event_name` |
| `--source` | `<name>` | none | which hook configuration runs it (`global`, `workspace`, `agent`, `legacy`). Duplicate events from two sources are handled once |
| `--legacy` | | off | Kiro IDE 0.x `.kiro.hook` invocation (data in `USER_PROMPT`, no stdin) |

```bash
# what Kiro runs: global hooks (IDE 1.x, CLI V3), the CLI 2.x agent, the IDE 0.x workspace hook
kopt hook --source global
kopt hook --source agent
kopt hook promptSubmit --legacy --source legacy
# try it by hand (this writes governor state to ~/.kopt; kopt doctor runs the same check in a scratch folder)
echo '{"hook_event_name":"PreToolUse","session_id":"t1","tool_name":"execute_bash","tool_input":{"command":"npm test"}}' | kopt hook
```
