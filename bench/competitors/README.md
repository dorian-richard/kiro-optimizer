# Competitor benchmark (sandboxed)

This folder runs the two closest competitors of kopt, **KiroGraph** and **CodeGraph**, on the same
benchmark tasks as `kopt bench` (`bench/tasks/<repo>.json`), and scores their output with the same
metrics. kopt itself can run through the same harness, so that index and query timings come from
the same machine, container and MCP client.

**Sandbox rule.** Competitor code never runs on the host. It runs only inside containers built from
the Dockerfiles here. The network is cut while it runs (`--network none`, or `RUN --network=none`).
The checkout and the task files are mounted read-only. The only thing that comes back is
`results/`. The host only reads the text files the tools produced (`score.mjs`).

**Status.** For the results, the commands that produced them and the known issues, see
[`results/summary.md`](results/summary.md) and the [Results](#results-2026-10-09) section below.

## What is measured

For each task the harness reproduces the first exploration step of an agent:

1. It copies the read-only checkout to a writable directory inside the container. Every tool writes
   its index next to the code (`.kirograph/`, `.codegraph/`, `.kopt/`). The copy is not timed.
2. It builds the index with the tool's own CLI, the way its README tells a user to. This is timed as
   `indexMs` (wall clock, all index commands added up).
3. For each task it starts a **fresh MCP server over stdio**, using the command line that the tool's
   own installer writes into Kiro's `mcp.json`. It sends `initialize`, then calls the tool's
   **primary context tool once**, with the task's input as the only argument, so every other argument
   keeps the tool's default value. Then it closes the session. Each task gets its own session, which
   matches "first step of a new agent session": no cross-call dedup or session budget decay applies.
4. It records the **exact text the agent receives**: the `text` items of the `CallToolResult`, joined
   in order. It also records the tool-call latency (`queryMs`), the time to start and initialize the
   session (`startupMs`), and `isError`.
5. It records what the agent pays on **every request** whatever the task: the `tools/list` schemas
   and the server `instructions`. These go to `<label>.surface.json` and to `meta.surface`.

The MCP client is the official `@modelcontextprotocol/sdk` 1.32.1 (`harness/run-tool.mjs`), which is
pinned by `harness/package-lock.json`. It advertises no client capabilities (no `roots`). So each
server falls back to `--path` or to its working directory, which is the project root.

| tool | package (pinned) | index command | MCP command (as its installer writes it) | tool called | arguments |
|---|---|---|---|---|---|
| KiroGraph | `kirograph@1.4.0` (npm, gitHead `3457727b`) | `kirograph init <root>` then `kirograph index <root>` | `kirograph serve --mcp --path <root>` | `kirograph_context` | `{task: <input>}` |
| CodeGraph | `@colbymchenry/codegraph@1.6.2` (npm shim + `codegraph-linux-<arch>` bundle) | `codegraph init --yes <root>` | `codegraph serve --mcp` (cwd = root) | `codegraph_explore` | `{query: <input>}` |
| kopt | this repository (`kopt-bench/kopt:local`) | `kopt index --root <root>` | `kopt mcp --root <root>` | `kopt_find` | `{query: <input>, mode: "pack"}` |

`<input>` is the task's `search` field. This is the phrase an agent would derive from the question,
and `kopt bench` uses it by default. A second pass uses the raw `question` field, which matches
`kopt bench --input question`.

### Modes

- **KiroGraph `default`**: what `kirograph init` writes, with every opt-in feature off, embeddings
  included. The MCP server then lists only the core tools.
- **KiroGraph `embeddings`**: the interactive installer (`kirograph install`) pre-selects
  "Core only" and then **"Semantic embeddings: yes"**, with `nomic-ai/nomic-embed-text-v1.5`
  (768 dimensions) and the `cosine` engine (`src/bin/installer/config-prompt.ts`, where
  `askToggle(..., defaultEnabled = true)`). This mode patches `.kirograph/config.json` the same way
  before indexing. KiroGraph's own loader downloads the model (523 MB, `dtype: auto`) into
  `~/.kirograph/models` **at image build time**, so the run itself stays offline.
- **CodeGraph `default`**: the only mode. CodeGraph has no embeddings: it uses lexical FTS plus graph
  ranking. Since 1.6, `codegraph_explore` is the only tool it lists. The others are hidden unless
  `CODEGRAPH_MCP_TOOLS` is set.
- **kopt `default`**: the same call as the `kopt-pack` strategy of `kopt bench`.

## Fairness notes (read before quoting a number)

- **Same input, one call, default budget.** No tool gets tuned arguments. Default output limits:
  - **KiroGraph** `kirograph_context`:
    - `maxNodes` 20: the first 10 are "entry points", and the first 10 nodes overall get their full
      source body with no per-snippet cap.
    - `detail: "full"`.
    - Hard cap of 15,000 characters (`MAX_OUTPUT`), followed by `…[truncated]` and a trailer
      `[kirograph_metrics: before=N after=M saved=X%]`. The trailer is part of the text the agent
      receives. Its "before" figure is KiroGraph's own estimate of a naive cost, not a measurement.
  - **CodeGraph** `codegraph_explore`: an adaptive budget by repo size. For repos with 500 files or
    more, it caps output at 24,000 characters, includes 8 files by default, and allows 6,500
    characters per file (500 to 5,000 files) or 7,000 characters per file (5,000 files or more). Its
    output is line-numbered verbatim source, plus a "blast radius", a relationship map and a
    "Not shown above" list of names.
  - **kopt** `kopt_find` pack: 2,500 tokens (`budgets.pack`), which is about 7,500 characters.
- **Tokens** are `ceil(chars / 3)` for every tool (`src/core/tokens.ts`), with no tokenizer. Ratios
  are more robust than absolute values.
- **Recall is generous to name-dropping outputs.** `found` means every gold path and every gold
  symbol *name* appears somewhere in the text. CodeGraph's relationship map and its "Not shown above"
  list, and KiroGraph's "Related Symbols" list, name many symbols without showing their code. They
  score name recall without giving the agent the code. `def recall`, which requires the definition
  line to be shown, is the stricter column.
- **Fixed overhead per request.** Kiro sends every MCP tool schema with every request, unless Tool
  Search is on (kirodocs `mcp/tool-search`). The saved Kiro docs do not say whether Kiro forwards
  MCP server `instructions` to the model. Both figures are reported separately in `meta.surface`.
  The summary adds them up, so read that column as an upper bound.
- **One session per task.** CodeGraph keeps per-session state: its cross-call dedup is off by
  default, and its budget decay applies from the second call onwards. A fresh session per task gives
  every tool its best first-call behaviour. Multi-step agent behaviour is not measured here. That
  needs the online A/B in `bench/ab/`.
- **Timings.**
  - Hardware: Docker Desktop's Linux VM on Apple Silicon (linux/arm64, 10 vCPU, 8 GB). The container
    runs Node 22.23.3. CodeGraph runs on the Node 24 that ships in its own bundle.
  - Index time is the wall clock of the tool's CLI and includes everything it does: parsing,
    resolution, FTS, embeddings.
  - CodeGraph's own summary line ("N nodes, M edges in 2.7s") counts only the parse phase. On django
    the reference-resolution phase takes about 34 s more (seen with `codegraph init --verbose`).
  - `queryMs` is the `tools/call` round trip, measured once the session is initialized.
- **Telemetry and network.** Containers run without network. `CODEGRAPH_TELEMETRY=0`,
  `DO_NOT_TRACK=1` and `CODEGRAPH_NO_DOWNLOAD=1` are set, so the tools do not even try to reach the
  network. No index step waited on a network timeout: CodeGraph's verbose log shows every phase
  doing work.
- **Index location.** Every index lives inside the container's copy of the repo and is thrown away
  afterwards. Index sizes are measured with `du` on the tool's data directory. For KiroGraph
  embeddings, the shared model is counted separately (`modelBytes`).

## Running it

Requirements: Docker with buildx (Docker Desktop on macOS or Windows, or Docker Engine on Linux)
and bash. Node 22 on the host is only needed for `score.mjs`, which imports `dist/bench`, so run
`npm run build` once. Network access is needed only when the images are built (npm install, model
download).

```bash
# checkouts + tasks: see bench/README.md (bench/repos/<repo>, bench/tasks/<repo>.json)
bench/competitors/run.sh                                   # all tools x all repos that have tasks
bench/competitors/run.sh --tools codegraph --repos django  # one tool, one repo
bench/competitors/run.sh --runs kirograph:embeddings --repos spring-framework
bench/competitors/run.sh --inputs search --only dj-locate-db-cache-cull,dj-locate-test-shuffle
bench/competitors/run.sh --engine buildkit                 # no `docker run` needed (see below)
node bench/competitors/score.mjs                           # re-score results/ -> summary.md/json
```

Two engines run the same image and the same harness:

- **`docker` (default)**: the sandbox flags are
  `docker run --rm --init --network none --cap-drop ALL --security-opt no-new-privileges --memory 6g
  --cpus 8 --pids-limit 4096 -v <repo>:/src:ro -v bench/tasks:/tasks:ro -v results:/results`.
  On Linux it also passes `--user $(id -u):$(id -g)`.
- **`buildkit`**: `docker buildx build --target results`. The benchmark runs as a
  `RUN --network=none` build step. The checkout and the tasks are read-only bind mounts of named
  build contexts (`--build-context repo=… tasks=…`). The results are exported with
  `--output type=local`. Nothing runs through `docker run`, and no image is left behind. Use it when
  `docker run` is not available (CI without privileged containers), or when Docker Desktop cannot
  start containers, as happened on the measurement machine (see Known issues). It has no cgroup
  memory or CPU limit: the step gets the builder's resources.

Images: `kopt-bench/kirograph:1.4.0`, about 1.4 GB with the model (`--build-arg
BAKE_EMBEDDING_MODEL=0` gives a `default`-only image). `kopt-bench/codegraph:1.6.2`, about 0.5 GB.
`kopt-bench/kopt:local`. `run.sh --clean` removes them. Environment knobs: `BENCH_ENGINE`,
`BENCH_BUILDER`, `BENCH_MEMORY`, `BENCH_CPUS`, `BENCH_INDEX_TIMEOUT` (default 5400 s),
`BENCH_QUERY_TIMEOUT` (default 300 s).

Windows: run `run.sh` from WSL2 or Git Bash with Docker Desktop. The script sets
`MSYS_NO_PATHCONV=1`. The containers are Linux in every case.

## Output files

| file | content |
|---|---|
| `results/<label>-<repo>.jsonl` | one line per task, input = `search`: `{taskId, input, output, toolCalls: 1, indexMs, queryMs, kind, inputField, tool, args, startupMs, isError, error, chars, estTokens}` |
| `results/<label>-<repo>-question.jsonl` | the same, input = `question` |
| `results/<label>-<repo>.meta.json` | tool version, mode, repo commit check, container (node, arch, cpus, mem), index time/steps/size, the tool's own status output, MCP surface sizes, per-input query medians, errors |
| `results/<label>.surface.json` | the exact `tools/list` and server `instructions` the agent sees |
| `results/summary.md`, `summary.json` | scores (`score.mjs`), next to the `kopt bench` reference rows |
| `results/logs/<label>-<repo>.log` | commands, exit codes, output tails, server stderr (gitignored) |

`<label>` is `kirograph`, `kirograph-embeddings`, `codegraph` or `kopt`.

## Results (2026-10-09)

See `results/summary.md` for the tables, which `score.mjs` regenerates.

## Known issues

- **Docker Desktop on the measurement machine could not start containers.** From 2026-10-09 10:34
  UTC, every `docker run` stayed in `Created`, including a plain `node -v` and other agents'
  containers. `docker rm -f` and `docker rmi` timed out too. Builds and `RUN` steps kept working, so
  every number here comes from the `buildkit` engine. Docker Desktop was **not** restarted, because
  the user had unrelated containers running. Two of my containers are still stuck in `Created`
  (`3bd8c306030c`, `d5b54182a891`). Remove them after a Docker Desktop restart with
  `docker rm -f 3bd8c306030c d5b54182a891`.
- **KiroGraph's `turbovec-node` optional dependency** is declared as `file:native/turbovec-node`,
  but that directory is not in the published tarball. npm skips it, and only the opt-in `turbovec`
  engine needs it.
- **KiroGraph indexing is single-threaded**, because it uses SQLite through `node-sqlite3-wasm`. It
  keeps one core busy for its whole index time. CodeGraph parses and resolves with worker threads.
