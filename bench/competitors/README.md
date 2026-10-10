# Competitor benchmark (sandboxed)

This folder runs the two closest competitors of kopt, **KiroGraph** and **CodeGraph**, on the same
benchmark tasks as `kopt bench` (`bench/tasks/<repo>.json`), and scores their output with the same
metrics (`dist/bench/metrics.js`). kopt itself can run through the same harness (opt-in), so that
index and query timings can come from the same machine, container and MCP client.

**Sandbox rule.** Competitor code never runs on the host. It runs only inside containers built from
the Dockerfiles here, with no network (`docker run --network none` for the whole run: index and
queries). The checkout and the task files are mounted read-only. The only thing that comes back is
`results/`. The host only reads the text files the tools produced (`score.mjs`).

**Status (2026-10-09).** Both tools ran in their default mode on all 11 repositories that have a
task file and a checkout (138 tasks), with the `docker` engine. See [Results](#results) below and
[`results/summary.md`](results/summary.md) for the per-repo, pass-gated and per-task tables.

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

| tool | package (pinned by `package-lock.json`) | index command | MCP command (as its installer writes it) | tool called | arguments |
|---|---|---|---|---|---|
| KiroGraph | `kirograph@1.4.0` (npm, `sha512-Bh9Ae+kf…vqRl3Q==`), SQLite through `node-sqlite3-wasm` 0.8.60, runs on the image's Node 22.23.3 | `kirograph init <root>` then `kirograph index <root>` | `kirograph serve --mcp --path <root>` | `kirograph_context` | `{task: <input>}` |
| CodeGraph | `@colbymchenry/codegraph@1.6.2` (npm shim, `sha512-hODH/mGn…zUH6Q==`) + `@colbymchenry/codegraph-linux-arm64@1.6.2` (`sha512-4sUICiYz…Pvnw==`), which ships its own Node v24.16.0 | `codegraph init --yes <root>` | `codegraph serve --mcp` (cwd = root) | `codegraph_explore` | `{query: <input>}` |
| kopt (opt-in) | this repository (`kopt-bench/kopt:local`) | `kopt index --root <root>` | `kopt mcp --root <root>` | `kopt_find` | `{query: <input>, mode: "pack"}` |

`<input>` is the task's `search` field. This is the phrase an agent would derive from the question,
and `kopt bench` uses it by default. A second pass uses the raw `question` field, which matches
`kopt bench --input question` (`<label>-<repo>-question.jsonl`).

### Modes

The results use each tool's **default mode**. KiroGraph's embeddings mode was also tried on one
repo, as a side measurement (see [KiroGraph embeddings](#kirograph-embeddings)).

- **KiroGraph `default`**: what `kirograph init` writes (`.kirograph/config.json`), with every opt-in
  feature off: `enableEmbeddings: false`, `trackCallSites: false`, `extractDocstrings: false`,
  `enableArchitecture: false`, `enableMemory: false`, and so on. The MCP server then lists only its
  7 core tools. **Embeddings are off by default** with `kirograph init`. The interactive installer
  (`kirograph install`) does pre-select "Semantic embeddings: yes" (`nomic-ai/nomic-embed-text-v1.5`,
  768 dimensions, `cosine` engine). The harness has a `kirograph:embeddings` mode that patches the
  config the same way, and the image bakes the model (523 MB) at build time so it can run offline.
- **CodeGraph `default`**: the only mode. CodeGraph has no embeddings: it uses lexical FTS plus graph
  ranking. Since 1.6, `codegraph_explore` is the only tool it lists. The others are hidden unless
  `CODEGRAPH_MCP_TOOLS` is set.
- **kopt `default`** (opt-in, not run here): the same call as the `kopt-pack` strategy of `kopt bench`.
  The kopt reference rows in the tables come from `bench/results/<repo>.json` (host run).

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
    "Not shown above" list of names. Every repo here is above 500 files, so CodeGraph's output sits
    at its cap (about 8,300 tokens) on almost every task.
  - **kopt** `kopt_find` pack: 2,500 tokens (`budgets.pack`), which is about 7,500 characters.
- **Tokens** are `ceil(chars / 3)` for every tool (`src/core/tokens.ts`), with no tokenizer. Ratios
  are more robust than absolute values.
- **Recall uses the `kopt bench` matching** (`computeRecall` in `src/bench/metrics.ts`): file recall
  = the full gold path appears in the output; symbol recall = the gold name appears as a whole
  identifier; def recall = the gold definition line is shown; `found` = every gold path and every
  gold name is present.
- **Recall is generous to name-dropping outputs.** CodeGraph's relationship map and its "Not shown
  above" list, and KiroGraph's "Related Symbols" list, name many symbols without showing their code.
  They score name recall without giving the agent the code. `def recall`, which requires the
  definition line to be shown, is the stricter column.
- **Fixed overhead per request.** Kiro sends every MCP tool schema with every request, unless Tool
  Search is on (kirodocs `mcp/tool-search`). The saved Kiro docs do not say whether Kiro forwards
  MCP server `instructions` to the model. Both figures are reported separately in `meta.surface`.
  The summary adds them up, so read that column as an upper bound.
- **One session per task.** CodeGraph keeps per-session state: its cross-call dedup is off by
  default, and its budget decay applies from the second call onwards. A fresh session per task gives
  every tool its best first-call behaviour. Multi-step agent behaviour is not measured here. That
  needs the online A/B in `bench/ab/`.
- **Timings.**
  - Hardware: Docker Desktop 4.94.0 (engine 29.8.2), Linux VM on an Apple Silicon Mac with 16 GB
    of RAM (VM: linux/arm64, 10 vCPU, 7.65 GiB, 1 GiB swap). Each container is limited with
    `--cpus 8` and `--memory 6g` (CodeGraph) or `--memory 3g` (KiroGraph: its highest recorded
    cgroup peak, page cache included, was 1.8 GB on discourse). The limits are recorded in each
    `meta.json` (`limits`, and `cgroupMemory` for the runs made after it was added).
  - **CodeGraph ran alone.** Every reported CodeGraph number comes from a final pass that ran the
    11 repos one after the other with no other benchmark container in the VM. A first pass, run
    next to KiroGraph containers, gave **byte-identical outputs on all 138 tasks** but index times
    up to 2.8 times longer (spring-framework: 365 s versus 130 s), which is why it was redone.
  - **KiroGraph mostly did not run alone.** Its indexing is single-threaded and takes minutes to
    half an hour per repo, so 2 to 4 KiroGraph containers ran side by side (next to the first
    CodeGraph pass for medusa, webpack, spring-framework and django). Only discourse,
    playframework and meilisearch were indexed alone. Two calibration points: meilisearch took
    118 s next to 3 other KiroGraph containers and 94 s alone (same outputs, byte for byte);
    django took 1,604 s next to 2 or 3 other benchmark containers and 1,041 s mostly alone in an
    earlier run of this harness (`buildkit` engine, same day; same output sizes on the 2 tasks it
    ran). **Read KiroGraph's index times for the 8 other repos as upper bounds, 25 to 55 % above
    an idle machine.** jellyfin also overlapped a CPU-heavy embedding run for 5 minutes. The run
    windows are in the [Run log](#run-log-2026-10-09).
  - Index time is the wall clock of the tool's CLI and includes everything it does: parsing,
    resolution, FTS, embeddings.
  - CodeGraph's own summary line ("N nodes, M edges in 4.0s") counts only the parse phase. The rest
    of `codegraph init` (reference resolution, dynamic-dispatch linking) is in our `indexMs`.
  - KiroGraph's index time includes `kirograph init` (under 1 s) and `kirograph index`.
  - `queryMs` is the `tools/call` round trip, measured once the session is initialized.
    `startupMs` (spawn + `initialize`) is reported separately.
- **Telemetry and network.** Containers run without network. `CODEGRAPH_TELEMETRY=0`,
  `DO_NOT_TRACK=1`, `CODEGRAPH_NO_DOWNLOAD=1`, `HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1` are
  set, so the tools do not even try to reach the network.
- **Index location and size.** Every index lives inside the container's copy of the repo and is
  thrown away afterwards. Index sizes are measured with `du` on the tool's data directory
  (`.kirograph/`, `.codegraph/`). For KiroGraph embeddings, the shared model is counted separately
  (`modelBytes`).
- **What each tool indexes.** Each tool uses its own default include/exclude rules (KiroGraph: every
  supported language including HTML, CSS, YAML and shell, minus `node_modules`, `dist`, `build`,
  minified files; CodeGraph: its own language list and `.gitignore`). Tests are indexed by both, as
  they are by kopt. The gold only contains production code.

## Running it

Requirements: Docker with buildx (Docker Desktop on macOS or Windows, or Docker Engine on Linux)
and bash. Node 22 on the host is only needed for `score.mjs`, which imports `dist/bench`, so run
`npm run build` once. Network access is needed only when the images are built (npm install, model
download).

```bash
# checkouts + tasks: see bench/README.md (bench/repos/<repo>, bench/tasks/<repo>.json)
bench/competitors/run.sh                                   # KiroGraph + CodeGraph (default modes) x every repo with tasks
bench/competitors/run.sh --tools codegraph --repos django  # one tool, one repo
bench/competitors/run.sh --runs kirograph:embeddings --repos jellyfin   # opt-in: KiroGraph with embeddings
bench/competitors/run.sh --runs kopt:default --repos django             # opt-in: kopt through the same harness
bench/competitors/run.sh --inputs search --only dj-locate-db-cache-cull,dj-locate-test-shuffle
bench/competitors/run.sh --no-score                        # several run.sh in parallel: score once at the end
bench/competitors/run.sh --engine buildkit                 # no `docker run` needed (see below)
node bench/competitors/score.mjs                           # re-score results/ -> summary.md/json + the README table
```

The exact commands used for the 2026-10-09 results (repos run one after the other inside a "lane"):

```bash
# KiroGraph: 2 to 4 lanes in parallel (discourse, playframework and meilisearch: alone)
BENCH_MEMORY=3g BENCH_INDEX_TIMEOUT=18000 bench/competitors/run.sh --tools kirograph --repos <repo> --no-score
# CodeGraph: final pass, one repo at a time, nothing else running
BENCH_MEMORY=6g BENCH_INDEX_TIMEOUT=14400 bench/competitors/run.sh --runs codegraph:default --repos <repo> --no-score
# KiroGraph with embeddings (opt-in mode), alone
BENCH_MEMORY=4g BENCH_INDEX_TIMEOUT=3600 bench/competitors/run.sh --runs kirograph:embeddings --repos exposed --no-score
node bench/competitors/score.mjs   # summary.md/json + the table below
```

Two engines run the same image and the same harness:

- **`docker` (default, used for the results)**: the sandbox flags are
  `docker run --rm --init --name kopt-bench-<tool>-<mode>-<repo> --network none --cap-drop ALL
  --security-opt no-new-privileges --memory 6g --cpus 8 --pids-limit 4096 -v <repo>:/src:ro
  -v bench/tasks:/tasks:ro -v results:/results -v harness/run-tool.mjs:/opt/harness/run-tool.mjs:ro`.
  The driver is bind-mounted read-only over the image's copy, so editing it never forces a rebuild
  (the KiroGraph image would otherwise download its model again). On Linux it also passes
  `--user $(id -u):$(id -g)`. The image name and ID are recorded in each `meta.json`.
- **`buildkit`**: `docker buildx build --target results`. The benchmark runs as a
  `RUN --network=none` build step. The checkout and the tasks are read-only bind mounts of named
  build contexts (`--build-context repo=… tasks=…`). The results are exported with
  `--output type=local`. Nothing runs through `docker run`, and no image is left behind. Use it when
  `docker run` is not available (CI without privileged containers). It has no cgroup memory or CPU
  limit: the step gets the builder's resources. Note that the step's `/work` (repo copy + index) is
  kept in the build cache: prune it afterwards (`docker buildx prune --filter id=<record>`).

Resources: with the default `--memory 6g`, run **one container at a time** on a 16 GB Mac. CodeGraph
needs more than 4 GB on spring-framework (it was OOM-killed at 4 GB, see Known issues). Running 3
KiroGraph containers plus an embedding run at once crashed Docker Desktop's VM on the measurement
machine (see Run log).

Images: `kopt-bench/kirograph:1.4.0` (4.9 GB on disk with the baked model; `--build-arg
BAKE_EMBEDDING_MODEL=0` gives a `default`-only image), `kopt-bench/codegraph:1.6.2` (1.2 GB),
`kopt-bench/kopt:local` (opt-in). `run.sh --clean` removes them. Environment knobs: `BENCH_ENGINE`,
`BENCH_BUILDER`, `BENCH_MEMORY`, `BENCH_CPUS`, `BENCH_INDEX_TIMEOUT` (default 5400 s),
`BENCH_QUERY_TIMEOUT` (default 300 s).

Windows: run `run.sh` from WSL2 or Git Bash with Docker Desktop. The script sets
`MSYS_NO_PATHCONV=1`. The containers are Linux in every case.

## Output files

| file | content |
|---|---|
| `results/<tool>-<repo>.jsonl` (gitignored: verbatim third-party source) | one line per task, input = `search`: `{taskId, input, output, toolCalls: 1, indexMs, queryMs, durationMs, kind, inputField, tool, args, startupMs, isError, error, chars, estTokens}`. `durationMs` = `queryMs` (the name `src/bench/competitors.ts` reads), so `kopt bench` can show these rows too |
| `results/<tool>-<repo>-question.jsonl` (gitignored) | the same, input = `question` |
| `results/<tool>-<repo>.meta.json` | tool version, mode, image and image ID, limits, repo commit check, container (node, arch, cpus, mem), index time/steps/size, the tool's own status output, MCP surface sizes, per-input query medians, errors |
| `results/<tool>.surface.json` | the exact `tools/list` and server `instructions` the agent sees |
| `results/summary.md`, `summary.json` | scores (`score.mjs`): cross-repo overview, then per repo, next to the `kopt bench` reference rows |
| `results/logs/<tool>-<repo>.log` | commands, exit codes, output tails, server stderr (gitignored) |

`<tool>` is the run label: `kirograph`, `codegraph`, `kirograph-embeddings` or `kopt`.

## Results

<!-- results:start (generated by score.mjs) -->
Input = `search`, one call per task, default arguments. Generated 2026-10-09 by `node bench/competitors/score.mjs`.
*Italic* rows are the `kopt bench` reference strategies (host run, same tasks and metrics) where `bench/results/<repo>.json` exists.

| tool | repos | found | median tok (all tasks) | tokens / found task | total index time | failures |
|---|---|---|---|---|---|---|
| codegraph | 11 | 79/138 | 8,315 | 13,982 | 498.4 s | 0 |
| kirograph | 11 | 4/138 | 1,094 | 43,765 | 7230.9 s | 3 |
| kirograph-embeddings | 1 | 1/12 | 1,100 | 20,798 | 1538.0 s | 0 |
| *native-ranged* (kopt bench) | 11 | 54/138 | 6,675 | 31,485 | - | - |
| *kopt-pack* (kopt bench) | 11 | 43/138 | 747 | 2,722 | - | - |

Pass-gated pairs over all repos (tokens b / a on the tasks found by both; < 1 means b is cheaper):

| a | b | tasks run by both | found by both | only a | only b | median b/a | geo-mean b/a |
|---|---|---|---|---|---|---|---|
| native-ranged | codegraph | 138 | 39 | 15 | 40 | 1.41 | 1.19 |
| kopt-pack | codegraph | 138 | 27 | 16 | 52 | 10.90 | 11.84 |
| native-ranged | kirograph | 138 | 3 | 51 | 1 | 0.25 | 0.13 |
| kopt-pack | kirograph | 138 | 4 | 39 | 0 | 1.85 | 2.80 |
| native-ranged | kirograph-embeddings | 12 | 1 | 3 | 0 | 0.25 | 0.25 |
| kopt-pack | kirograph-embeddings | 12 | 1 | 2 | 0 | 2.00 | 2.00 |
| codegraph | kirograph | 138 | 3 | 76 | 1 | 0.23 | 0.25 |
| codegraph | kirograph-embeddings | 12 | 0 | 9 | 1 | - | - |
| kirograph | kirograph-embeddings | 12 | 1 | 0 | 0 | 1.00 | 1.00 |

| repo | tool | index time | index size | median query | found | file recall | symbol recall | def recall | median tok | p90 tok | tokens / found task | failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| discourse | codegraph | 38.2 s | 404 MB | 555 ms | 8/12 | 75 % | 71 % | 48 % | 7,954 | 8,328 | 11,477 | 0 |
| discourse | kirograph | 933.0 s | 160 MB | 59 ms | 1/12 | 8 % | 10 % | 4 % | 1,239 | 4,374 | 15,694 | 3 |
| discourse | *native-ranged* (kopt bench) | - | - | - | 6/12 | 63 % | 60 % | 52 % | 5,988 | 10,705 | 14,844 | - |
| discourse | *kopt-pack* (kopt bench) | - | - | - | 4/12 | 73 % | 72 % | 55 % | 860 | 1,376 | 2,483 | - |
| django | codegraph | 44.0 s | 181 MB | 205 ms | 8/15 | 90 % | 81 % | 62 % | 8,317 | 8,330 | 15,192 | 0 |
| django | kirograph | 1604.1 s | 268 MB | 98 ms | 1/15 | 40 % | 26 % | 0 % | 799 | 3,407 | 19,329 | 0 |
| django | *native-ranged* (kopt bench) | - | - | - | 8/15 | 77 % | 67 % | 54 % | 6,737 | 8,352 | 11,497 | - |
| django | *kopt-pack* (kopt bench) | - | - | - | 8/15 | 89 % | 87 % | 58 % | 627 | 1,053 | 1,143 | - |
| exposed | codegraph | 28.2 s | 101 MB | 201 ms | 9/12 | 88 % | 100 % | 55 % | 8,305 | 8,327 | 11,019 | 0 |
| exposed | kirograph | 228.1 s | 94 MB | 67 ms | 1/12 | 51 % | 24 % | 10 % | 1,100 | 4,523 | 20,798 | 0 |
| exposed | kirograph-embeddings | 1538.0 s | 132 MB | 436 ms | 1/12 | 51 % | 24 % | 10 % | 1,100 | 4,523 | 20,798 | 0 |
| exposed | *native-ranged* (kopt bench) | - | - | - | 4/12 | 71 % | 61 % | 41 % | 9,659 | 18,199 | 85,522 | - |
| exposed | *kopt-pack* (kopt bench) | - | - | - | 3/12 | 53 % | 81 % | 35 % | 658 | 2,059 | 3,888 | - |
| gitea | codegraph | 12.1 s | 176 MB | 262 ms | 6/12 | 80 % | 69 % | 31 % | 8,257 | 8,328 | 15,262 | 0 |
| gitea | kirograph | 243.7 s | 80 MB | 42 ms | 0/12 | 8 % | 9 % | 0 % | 482 | 1,109 | - | 0 |
| gitea | *native-ranged* (kopt bench) | - | - | - | 3/12 | 73 % | 64 % | 54 % | 6,266 | 7,746 | 30,561 | - |
| gitea | *kopt-pack* (kopt bench) | - | - | - | 2/12 | 63 % | 77 % | 48 % | 537 | 2,025 | 4,979 | - |
| jellyfin | codegraph | 6.0 s | 109 MB | 122 ms | 8/12 | 92 % | 79 % | 47 % | 8,316 | 8,330 | 12,058 | 0 |
| jellyfin | kirograph | 293.6 s | 74 MB | 113 ms | 0/12 | 28 % | 9 % | 0 % | 865 | 1,245 | - | 0 |
| jellyfin | *native-ranged* (kopt bench) | - | - | - | 5/12 | 96 % | 76 % | 63 % | 6,578 | 8,871 | 16,238 | - |
| jellyfin | *kopt-pack* (kopt bench) | - | - | - | 1/12 | 47 % | 66 % | 31 % | 929 | 1,270 | 11,060 | - |
| laravel | codegraph | 20.4 s | 197 MB | 347 ms | 5/12 | 78 % | 70 % | 49 % | 8,308 | 8,319 | 19,017 | 0 |
| laravel | kirograph | 249.1 s | 67 MB | 70 ms | 0/12 | 15 % | 17 % | 4 % | 1,382 | 1,806 | - | 0 |
| laravel | *native-ranged* (kopt bench) | - | - | - | 4/12 | 78 % | 62 % | 43 % | 4,786 | 171,419 | 102,016 | - |
| laravel | *kopt-pack* (kopt bench) | - | - | - | 7/12 | 86 % | 82 % | 61 % | 881 | 1,307 | 1,565 | - |
| medusa | codegraph | 30.5 s | 328 MB | 299 ms | 7/12 | 87 % | 74 % | 36 % | 8,317 | 8,329 | 13,900 | 0 |
| medusa | kirograph | 959.5 s | 162 MB | 126 ms | 0/12 | 11 % | 10 % | 0 % | 1,269 | 1,565 | - | 0 |
| medusa | *native-ranged* (kopt bench) | - | - | - | 3/12 | 58 % | 46 % | 30 % | 6,994 | 9,825 | 27,520 | - |
| medusa | *kopt-pack* (kopt bench) | - | - | - | 3/12 | 61 % | 79 % | 40 % | 857 | 1,779 | 3,745 | - |
| meilisearch | codegraph | 8.1 s | 79 MB | 122 ms | 5/12 | 69 % | 68 % | 32 % | 8,318 | 8,327 | 19,337 | 0 |
| meilisearch | kirograph | 93.9 s | 67 MB | 44 ms | 0/12 | 36 % | 9 % | 0 % | 1,058 | 2,770 | - | 0 |
| meilisearch | *native-ranged* (kopt bench) | - | - | - | 3/12 | 67 % | 53 % | 35 % | 6,194 | 7,821 | 25,791 | - |
| meilisearch | *kopt-pack* (kopt bench) | - | - | - | 1/12 | 70 % | 54 % | 36 % | 983 | 1,294 | 11,211 | - |
| playframework | codegraph | 9.7 s | 103 MB | 152 ms | 10/12 | 92 % | 85 % | 51 % | 8,319 | 8,330 | 9,839 | 0 |
| playframework | kirograph | 103.7 s | 78 MB | 44 ms | 0/12 | 17 % | 10 % | 3 % | 1,307 | 2,238 | - | 0 |
| playframework | *native-ranged* (kopt bench) | - | - | - | 5/12 | 92 % | 52 % | 43 % | 7,631 | 9,495 | 24,245 | - |
| playframework | *kopt-pack* (kopt bench) | - | - | - | 3/12 | 83 % | 54 % | 28 % | 909 | 1,151 | 3,619 | - |
| spring-framework | codegraph | 130.2 s | 863 MB | 858 ms | 8/15 | 80 % | 76 % | 47 % | 8,307 | 8,324 | 14,584 | 0 |
| spring-framework | kirograph | 1948.6 s | 851 MB | 200 ms | 0/15 | 27 % | 21 % | 0 % | 1,208 | 1,655 | - | 0 |
| spring-framework | *native-ranged* (kopt bench) | - | - | - | 8/15 | 82 % | 70 % | 57 % | 7,378 | 9,517 | 14,080 | - |
| spring-framework | *kopt-pack* (kopt bench) | - | - | - | 5/15 | 72 % | 75 % | 43 % | 807 | 1,363 | 2,538 | - |
| webpack | codegraph | 171.0 s | 152 MB | 243 ms | 5/12 | 58 % | 67 % | 41 % | 8,325 | 8,331 | 19,976 | 0 |
| webpack | kirograph | 573.7 s | 111 MB | 99 ms | 1/12 | 19 % | 17 % | 8 % | 752 | 5,023 | 19,095 | 0 |
| webpack | *native-ranged* (kopt bench) | - | - | - | 5/12 | 75 % | 61 % | 49 % | 5,649 | 7,586 | 40,465 | - |
| webpack | *kopt-pack* (kopt bench) | - | - | - | 6/12 | 67 % | 75 % | 64 % | 693 | 1,130 | 1,391 | - |
<!-- results:end -->

The full tables (input = `question` too, pass-gated pairs per repo, per-task found/miss and tokens)
are in [`results/summary.md`](results/summary.md). The `kopt bench` rows are read from
`bench/results/<repo>.json` as they were when `score.mjs` last ran (2026-10-09, 16:40 CEST); they
were produced on the host by other runs and change when `kopt bench` is re-run. The figures quoted
below are from that snapshot.

### Reading the results

- **CodeGraph has the best single-call recall measured here, at a fixed price of about 8,300
  tokens.** It found 79 of 138 tasks, against 54 for the 4-call `native-ranged` baseline and 43 for
  `kopt-pack`. Its output sits at its 24,000-character cap on almost every task (median 8,315
  tokens, p90 8,331), whatever the question. On the tasks found by both, it costs about 11 times
  `kopt-pack` (median ratio 10.9, geometric mean 11.8) and about 1.2 to 1.4 times `native-ranged`
  in one call instead of about 4. Its definition recall (31 to 62 % per repo) is far below its name
  recall: part of its `found` comes from names listed in its relationship map and "Not shown above"
  list, not from code it shows. Indexing takes 6 s to 171 s (webpack), 79 to 863 MB on disk, and
  more than 4 GB of RAM on spring-framework.
- **KiroGraph in its default mode finds almost nothing from a search phrase: 4 of 138.** Its entry
  points are symbols whose *name* is one of the query words. When a gold name is literally in the
  phrase (55 cases), it does return it (53; the 2 others hit the FTS5 bug below). But most phrases
  describe behaviour in words, and then it returns symbols named after common words: for medusa's
  "inventory item available quantity…", six constants named `inventory` in admin UI components and
  four variables named `item` in integration tests. Its output is small (median 1,094 tokens, capped
  at 15,000 characters plus a trailer), so its tokens per found task are the worst of all (43,765).
  Indexing is slow and single-threaded: 94 s (meilisearch, alone) to 32 minutes (spring-framework,
  in parallel).
- **KiroGraph fails on some inputs.** `kirograph_context` passes the task text to SQLite FTS5
  without escaping it. Any `!`, `` ` ``, `@`, `[` or `$` makes the call return
  `Error: fts5: syntax error near "…"` (`isError: true`). That hit 3 of the 138 search phrases
  (discourse, Ruby method names ending in `!`) and 78 of the 138 raw questions (mostly identifiers
  quoted in backticks). These count as failures (`failures` column, and "err" in
  `summary.md`).
- **Fixed overhead per request** (`*.surface.json`): KiroGraph lists 7 tools, 1,473 tokens of
  schemas and no server instructions. CodeGraph lists 1 tool, 575 tokens of schema plus 2,240 tokens
  of server instructions (paid only if Kiro forwards `instructions` to the model).
- **For kopt**: on the tasks both find, `kopt-pack` returns about a tenth of CodeGraph's tokens, but
  CodeGraph finds 52 tasks that `kopt-pack` misses, and `kopt-pack` finds 16 that CodeGraph misses.
  This offline proxy cannot say which costs fewer credits over a whole session (a miss costs extra
  turns, an 8,300-token result is billed again on every later turn). That is the online A/B's job.
- **Determinism.** CodeGraph's two passes, and KiroGraph's two meilisearch runs, gave byte-identical
  outputs on every task, so the recall numbers do not depend on machine load. Only the timings do.

### Run log (2026-10-09)

Times are CEST. The lane logs themselves are not kept in the repository.

| tool | repos | when | conditions |
|---|---|---|---|
| CodeGraph, pass 1 | all 11 | 14:16 to 15:33 | next to 1 to 3 KiroGraph containers (discourse, playframework: alone). **Replaced** by pass 2 (identical outputs). spring-framework was OOM-killed at `--memory 4g` after 256 s (`codegraph init` exit 1, no message), then passed at 6 GB |
| KiroGraph | medusa, webpack | 14:17 to 14:34 | next to each other, 2 more KiroGraph containers from 14:28, and CodeGraph pass 1 |
| KiroGraph | spring-framework, django | 14:28 to 15:01 | next to 1 to 3 other KiroGraph containers and CodeGraph pass 1 (spring-framework, medusa, webpack) |
| KiroGraph | exposed, laravel, gitea | 14:55 to 15:06 | next to 2 or 3 other KiroGraph containers |
| KiroGraph | jellyfin | 15:06 to 15:11 | next to 2 other KiroGraph containers and the embedding run below (up to 8 cores busy) |
| KiroGraph `embeddings` | exposed | 15:06 to 15:13 | **lost**: the VM crashed (below) |
| KiroGraph | discourse, playframework | 14:55 to 15:13 | **lost**: the VM crashed, then re-run alone |
| KiroGraph | playframework, discourse | 15:30 to 15:49 | alone |
| CodeGraph, pass 2 (reported) | all 11 | 15:50 to 16:06 | alone, `--memory 6g` |
| KiroGraph | meilisearch | 16:06 to 16:08 | alone (replaces the 15:04 run: 94 s instead of 118 s, identical outputs) |
| KiroGraph `embeddings` | exposed | 16:08 to 16:35 | alone, `--memory 4g` |

**Docker Desktop VM crash.** At 15:13:43 Docker Desktop's VM stopped with "Internal
Virtualization error. The virtual machine stopped unexpectedly", while 3 KiroGraph containers and
one KiroGraph embedding container were running, and the Mac (16 GB) was using about 9 GB of swap.
Docker Desktop restarted the VM, but its daemon never came back, and the guest powered off at 15:19.
`docker desktop restart` brought it back at about 15:28. Every container in the VM was stopped by the
crash, not only the benchmark's. After that, the remaining runs went strictly one container at a
time. On a 16 GB Mac, do the same.

## KiroGraph embeddings

**Off by default.** `kirograph init`, which is what the harness and KiroGraph's README use, writes
`enableEmbeddings: false`. The interactive installer (`kirograph install`) pre-selects "Semantic
embeddings: yes". So the reported `kirograph` rows are the `init` default, and the `embeddings`
mode was tried once, on exposed (Kotlin, 5,218 files), alone:

```bash
BENCH_MEMORY=4g BENCH_INDEX_TIMEOUT=3600 bench/competitors/run.sh --runs kirograph:embeddings --repos exposed --no-score
```

| exposed | index time | index size | server startup | median query | found | outputs |
|---|---|---|---|---|---|---|
| `kirograph` (default) | 228 s (in parallel) | 94 MB | 0.20 s | 67 ms | 1/12 | - |
| `kirograph-embeddings` | 1,538 s (alone) | 132 MB + 548 MB model | 1.45 s | 436 ms | 1/12 | **byte-identical to default on all 24 calls** (search and question) |

All 8,992 embeddable symbols (functions, methods, classes, interfaces…) were embedded with
`nomic-ai/nomic-embed-text-v1.5` on the CPU, which multiplied the index time by at least 7 (the
default run shared the machine, the embedding run did not). The MCP
server loads the model at startup and embeds each query (longer startup and query times), but no
semantic hit reached the `kirograph_context` output. `ContextBuilder.findRelevantContext` ranks
exact name matches first, then semantic hits, then FTS hits, and trims to `maxNodes` (20), so
semantic hits should at least have displaced some FTS hits. We did not find out why they did not
(the status output reports "Semantic Search: enabled, Indexed 8992 / 8992"). We did not run the other
repos with embeddings: on this evidence they would cost 7 times the index time or more for the
same output.

## Known issues

- **KiroGraph: unescaped FTS5 query.** See above: `!`, `` ` ``, `@`, `[` and `$` in the task text
  make `kirograph_context` fail.
- **KiroGraph: slow, single-threaded indexing.** Most of the time goes to the "resolving" phase.
  For every reference without an exact name match, `ReferenceResolver.resolveUnresolvedRefs` runs a
  fuzzy match against *all* nodes, unless the graph has more than 200,000 nodes
  (`FUZZY_ALL_NODES_LIMIT`). So django (122k symbols, 431k references) took 3.7 ms per reference
  and discourse (62k symbols, 271k references) 3.4 ms, but spring-framework (293k symbols, above the
  limit, 1.14M references) only 1.7 ms. KiroGraph also prints one progress line per reference when stdout
  is not a terminal (hundreds of thousands of lines); the harness keeps only the last 20,000
  characters in `results/logs/`.
- **KiroGraph's `turbovec-node` optional dependency** is declared as `file:native/turbovec-node`,
  but that directory is not in the published tarball. npm skips it, and only the opt-in `turbovec`
  engine needs it.
- **CodeGraph needs more than 4 GB of RAM on spring-framework** (peak cgroup usage 5.5 GB,
  page cache included, at `--memory 6g`). When the OOM killer kills its bundled runtime, the npm shim
  exits with status 1 and prints nothing. The harness now reads the container's
  `/sys/fs/cgroup/memory.events` before and after each index step and reports such a kill in
  `errors` and `indexSteps[].oomKills`.
- **CodeGraph's first query after the server starts is slow on large repos** (cold caches): 4.5 s
  on spring-framework, 12.6 s on webpack, against medians of 0.86 s and 0.24 s. Medians are reported.
- The previous `buildkit` results (django and spring-framework, 2026-10-09 morning) were replaced
  by this run. The two containers that were stuck in `Created` at the time no longer exist.
