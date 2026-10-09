# kiro-optimizer: architecture and design decisions

> Status: prototype v0.1 (October 2026). This document explains why the tool is built the way it is.
> The detailed sources (repositories read, Kiro docs, published benchmarks) are summarized in the appendix.

## 1. The problem as it actually exists in Kiro

### 1.1 How Kiro bills
- Kiro bills **credits per request**, metered to 0.01. The amount is multiplied by the model factor:
  Auto 1.0x, Haiku 4.5 0.4x, Sonnet 1.3x, Opus 5.5 2.0x, Opus 5 2.2x, Qwen3 Coder Next 0.05x.
- Consumption depends on the total request size (tokens), on the generated output and on the reasoning effort.
  A third-party probe found that a prefix already in cache is billed **the same**. So caching improves latency,
  not the bill. This should be confirmed on your own Kiro plan (see §7).
- **Key consequence:** every token that enters the context is billed again on **every later turn** of the session.
  Real cost ≈ Σ(turns) × (fixed prefix + resident history) + outputs. We must therefore reduce three things:
  **what enters** the context, **how long it stays there**, and **the number of turns**.

### 1.2 What Kiro does not allow
- **No LLM proxy.** Traffic goes to the Kiro API, and no option redirects it to a gateway or to your own Bedrock
  (issue #34 has been open since 07/2025). The pricing FAQ also forbids third-party harnesses that route requests
  outside Kiro. This rules out compression proxies such as Headroom, the caveman proxy or lean-ctx.
- **Hooks cannot rewrite anything.** A hook can only do two things:
  - *block*: exit 2, and stderr is sent to the model, which costs one extra turn;
  - *add context*: stdout, and only on SessionStart and UserPromptSubmit.

  So built-in tool outputs cannot be compressed transparently.
- `command` hooks consume **no credits**. `agent` hooks do, because they start a new agent loop.

### 1.3 What we fully control
1. **The output of our MCP tools.** It enters the context verbatim, and the client does not truncate it.
2. The **fixed prefix**: steering (`always` / `auto` / `fileMatch` / `manual`), tool schemas and MCP instructions.
3. **Command hooks** (free): count, gate, block where it pays off, and measure.
4. **Custom agents**: the model per sub-agent and the tool allow-list.
5. **`.kiroignore`**: a deterministic filter on reads and searches that costs no extra turn.

## 2. Why KiroGraph and CodeGraph save little (verified in their source code)

| Finding | KiroGraph 1.4 | CodeGraph 1.6 |
|---|---|---|
| Lexical search | **broken**: the FTS5 join `TEXT id = rowid` always returns 0 rows; exact, case-sensitive lookups of lower-cased words | correct (FTS5) |
| Response size | up to 10 full symbol bodies, cut at 15,000 chars in the middle of a code block | up to 25,000 chars (~11k tokens) per call, verbatim line-numbered code |
| Cross-call dedup | no | off by default |
| Fixed prefix | 127 tools (~6-13k tokens of schemas), plus `always` steering of 1-8k tokens | 1 tool (good) |
| Freshness | sync on Stop via `git status`; misses pulls and commits; inactive on the CLI | daemon and watcher (good), 4.3% edge drift |
| Measurement | hard-coded counterfactuals (1,500 tokens per "avoided" file); failures counted as 100% savings | real A/B, but 1 question on famous repos, with cache reads counted as tokens; at 3 turns: −24%, and **+17% on Django** |
| Output / loop levers | none (only optional "caveman" steering) | none |

CodeGraph also leaves on average **+82% more retrieval context resident** at the end of a session, and that context
is billed again on every turn.

**Core lesson.** Code retrieval is a small share of the spend. Most of it comes from:
- turns × resident history;
- verbose and repeated build and test logs;
- whole-file reads;
- the fixed prefix;
- runaway loops.

Kiro's issue tracker shows a session of more than 1,000 credits that included 42 pytest runs, and review→fix loops
with no circuit breaker.

## 3. Architecture

Everything runs on the developer machine:

```mermaid
flowchart LR
  subgraph Developer machine
    K[Kiro IDE / Kiro CLI] -- MCP stdio --> L[kopt mcp<br/>project index, refreshed from the files the agent writes]
    K -- command hooks, free --> H[kopt hook<br/>session governor]
    K -. steering under 140 words .-> K
    T2[Any terminal / agent] -- shell --> C2[kopt CLI<br/>same tools, same output]
    L --> I[(index.db per project<br/>user cache folder)]
    C2 --> I
    H --> T[(local usage log JSONL<br/>kopt stats)]
    L --> T
    KS[Kiro session files<br/>per-request credits] -. read by kopt stats / kopt credits .-> T
  end
```

### 3.1 The five levers, by expected impact

1. **Compressed command outputs (`kopt_run` / `kopt_expand`).** Tests, builds and linters return only the verdict,
   the failures and the errors, with file:line and the frames that belong to the repo. The full log is stored and
   available by handle. **An identical command re-run with no file change is not executed again**: the previous
   result is returned, which saves both a turn and the build minutes. The savings are measured exactly, since the
   raw output is known.
2. **Session governor (command hooks, free):**
   - a circuit breaker on tool calls per session (Kiro has no credit budget);
   - a *one-time* block of whole-file reads above N lines, with a precise alternative (outline or line range);
   - a *one-time* redirect of verbose test/build commands to `kopt_run`;
   - a block on identical re-runs with no file change;
   - per-tool measurement of built-in tool output sizes (PostToolUse). This is the observability that is missing
     today to see where context goes.

   "One-time" matters: a block costs a turn, so we only block where the expected gain far exceeds that cost, and we
   never block the same thing twice (no blocking loops).
3. **Budgeted code navigation (`kopt_find` / `kopt_read` / `kopt_outline` / `kopt_refs`):**
   - a hard token cap on every response, compact text (never JSON), short `#3mv` handles;
   - per-session dedup, with a bounded window because Kiro's compaction erases MCP results;
   - a `pack` mode that returns task-level context in a single call (fewer turns);
   - hybrid search with code-aware tokenization (camelCase/snake_case), column-weighted BM25, centrality (PageRank)
     and demotion of tests;
   - `outline` for file skeletons and an aider-style repo map personalized by the task focus.
4. **Minimal fixed prefix:**
   - 6 tools with short descriptions and MCP instructions under 600 chars;
   - `always` steering under 140 words, with spec guidance in `auto` mode (loaded only when relevant);
   - a generated `.kiroignore` covering lockfiles, minified bundles, generated code, snapshots and large data files.
5. **Output levers and model routing:**
   - "output" steering: don't restate code or the plan, edit with minimal replacements, no unrequested summaries,
     stop at the acceptance criteria. Measured gain in the literature: about −8% output tokens, not the −65% some
     tools advertise;
   - a `kopt-explorer` sub-agent on Haiku 4.5 (0.4x) for exploration, returning file:line spans rather than code.

### 3.2 Why no server
kopt is a local tool on purpose: everything runs on the developer machine and nothing leaves it.
- **Kiro already runs there.** The levers that pay most (`kopt_run`, the governor, whole-file read redirects) need the
  checkout, the developer's shell and Kiro's hooks, which only exist on that machine.
- **Local indexing is cheap enough.** The first build runs once per project in a background worker thread; after
  that, only the files the agent writes (reported by the hooks) and the files changed by a pull are re-indexed.
- **Nothing to operate.** No accounts, tokens, secrets, network access or cloud bill: one `npx` command installs it,
  `kopt uninstall` removes it.
- **Privacy.** The code index and the usage log stay in the user's cache and `~/.kopt` folders. `kopt stats` reads
  them locally; there is no upload. Kiro prompts still go to the Kiro service, which is outside kopt's scope.

## 4. Surface compatibility

One command (`npx -y github:dorian-richard/kiro-optimizer setup`) installs kopt globally and writes **user-level**
Kiro configuration only, so kopt starts by itself in every project; nothing is written into repositories. The index
of each project lives in the per-user cache folder (macOS `~/Library/Caches/kopt`, Linux `~/.cache/kopt`, Windows
`%LOCALAPPDATA%\kopt`), keyed by the repository path. The user-level MCP server learns its project from the client's
MCP roots, else `KOPT_ROOT`, else the git root of the folder Kiro starts it in, and never indexes HOME or `/`.

| Capability | Kiro IDE 1.x | Kiro IDE 0.x (0.12) | Kiro CLI V3 | Kiro CLI 2.x (legacy) | Standalone `kopt` CLI |
|---|---|---|---|---|---|
| Written by `kopt setup` | `~/.kiro/settings/mcp.json`, `~/.kiro/hooks/kopt.json`, global steering, `~/.kiro/settings/kiroignore`, IDE user setting `kiroAgent.agentIgnoreFiles` | same files (0.x ignores the global hooks) | `mcp.json`, `~/.kiro/hooks/kopt.json` | `~/.kiro/agents/kopt.json` (hooks embedded, `includeMcpJson`) set as `chat.defaultAgent` | the global `kopt` command |
| MCP tools | `mcp.json` (+ `autoApprove`) | same | `mcp.json` through the agent (`includeMcpJson`) + `allowedTools` | same as V3 | n/a: same operations as commands (`kopt find/read/outline/refs/run/expand`) |
| Hooks | global v1 hooks (`~/.kiro/hooks/kopt.json`) | workspace `.kiro.hook` files only; the MCP server writes one `promptSubmit` hook per workspace (no tool-call governor, see below) | same file as IDE 1.x | object form in the agent: `agentSpawn`, `userPromptSubmit`, `preToolUse`, `postToolUse`, `stop` (the only triggers `kiro-cli agent validate` 2.28 accepts) | n/a |
| Block semantics | exit 2 (the IDE also treats other non-zero codes as blocking) | n/a | exit 2 only | exit 2 | n/a |
| Allow path | **must be silent**: in the IDE, any PreToolUse output intercepts the tool call | n/a | silent | silent | n/a |
| Steering | all inclusion modes | all modes | all modes | only `always` loads automatically | n/a |
| `.kiroignore` | yes (+ `kiroAgent.agentIgnoreFiles` setting) | yes (+ setting) | yes (workspace) | no | the indexer honors it |
| Built-in tool names | `read_file`, `read_code`, `grep_search`, … | same as 1.x | `read`, `grep`, `glob`, `shell`, `write`, … | `fs_read`, `execute_bash`, `fs_write`, … | n/a |
| Credit telemetry | daily admin export | daily admin export | per request (session files) | per request (session files) | n/a |

The governor normalizes tool names and payload shapes across surfaces, and de-duplicates events in case both hook
formats are active (events tagged with different `--source` values within 2 s are handled once).

Kiro IDE 0.x limits (verified in the 0.12.318 bundle): hooks load only from `<workspace>/.kiro/hooks`; `runCommand`
hooks get no stdin (data comes in env `USER_PROMPT`); and any matched `preToolUse` hook blocks the tool call even
when it prints nothing (one extra model turn per call), while `postToolUse` output is appended to every matched tool
result. kopt therefore installs only the `promptSubmit` pointer hook there, listed in `.git/info/exclude`. The full
governor needs IDE 1.x.

## 5. Technical choices
- **TypeScript / Node ≥ 22, zero native dependencies**: SQLite through `node:sqlite` (FTS5 included) and tree-sitter
  as WASM. It installs on locked-down laptops (no native prebuild to download).
- **One SQLite file per project**, in the user cache folder (WAL mode): a writer connection for indexing and a reader
  connection for queries, so tool calls keep answering while a refresh runs. File text is always read from disk.
- **Tree-sitter** for 12 languages (Java, TS/JS, Python, C#, Go, Kotlin, Rust, PHP, Ruby, Scala). Reference
  resolution favors precision: an ambiguous reference stays unresolved. Planned next step: SCIP indexers
  (scip-java, scip-typescript, scip-dotnet), run locally, for exact resolution on Java and .NET stacks.
- **No embeddings in v0.1.** Well-done code-aware lexical search plus centrality covers most agent queries, because
  agents query with identifiers. A small local embedding model is a v0.2 option if the benchmark shows a recall gap
  on natural-language queries.

## 6. Measurement: prove before claiming
- **Offline benchmark** (`kopt bench`) on two large repositories (spring-framework, django), with verified gold
  answers. It compares 4 strategies on tokens returned and recall:
  - Kiro-style grep plus whole-file reads;
  - grep plus line ranges;
  - `kopt_find pack`;
  - `kopt_find` plus `read`.

  This is an indicator, **not** a credit saving.
- **Online A/B** (`bench/ab/`) with `kiro-cli --no-interactive --output-format stream-json`:
  - same tasks, N repetitions, stock arm vs kopt arm;
  - credits read from the stream;
  - paired comparison restricted to tasks both arms solved;
  - bootstrap 95% CI.

  **Only this number** supports a savings claim.
- **Day to day**: `kopt stats` reports, from the local usage log, the tokens kopt returned against exact baselines,
  governor blocks, built-in tool output sizes and per-request Kiro CLI credits. A team that wants a cohort
  comparison can use Kiro's own usage export (credits per user per day).
- Rule: `baselineTokens` is only set when the counterfactual is exactly computable (raw command output, full file).

## 7. Open questions before a team rollout
1. Target stacks: languages (Java/Spring? .NET?), monorepo or polyrepo, number and size of repositories.
2. Surfaces in use: Kiro IDE 1.x, CLI 2.x or CLI V3? Some levers differ: Tool Search and `.kiroignore` exist only in
   CLI V3, and `read_code` only in the IDE.
3. The Kiro plan (Pro or Enterprise with IAM Identity Center). It determines MCP governance (registry), the usage
   export and OTel telemetry.
4. A one-day probe on the organization's Kiro account: fixed prompts with varying prefix and output sizes, reading
   the credits of each request. Goal: establish the real weighting of input, output and cache.
5. Default model (Auto or pinned) and the sub-agent policy.

## 8. Roadmap
- **v0.1 (this prototype)**: local index, 6 budgeted tools, output compression, governor, Kiro setup for IDE and CLI,
  local usage report (`kopt stats`), benchmark harness.
- **v0.2**:
  - SCIP indexers for Java, TS and .NET, run locally;
  - search across several local repositories;
  - optional local embeddings;
  - "Code Mode": the model writes a script that queries the local index, and only the result enters context.
- **v0.3**:
  - a "fast apply" step: snippet edits with `// ... existing code ...`, for fewer output tokens;
  - impacted-test selection (Gradle, Maven, Jest, pytest);
  - a learned output pruner.

## Appendix: main sources
- Source code read: KiroGraph v1.4.0 (commit 3457727), CodeGraph v1.6.2 (b635dd4), sdl-mcp, CodeGraphContext,
  codegraph-rust.
- Kiro docs (258 pages, IDE 1.2 and CLI 2.28/V3): hooks, MCP (Tool Search), steering, `.kiroignore`, models and
  credits, enterprise governance.
- Read-only analysis of the installed Kiro IDE bundle (0.12 and 1.2.56):
  - hook semantics;
  - MCP instructions injected into context, capped at 2,048 chars;
  - the 2,000-line `read_file` cap;
  - compaction of MCP results.
- Literature: The Complexity Trap (NeurIPS 2025: observation masking ≈ −50% cost), SWE-Pruner, AgentDiet, the
  JetBrains study on terse output (−8.5% output tokens), and Anthropic Tool Search (−85% of schema tokens).
- Kiro issues: #11786 (a session of more than 1,000 credits), #11477 (no circuit breaker), #9576 (hooks cannot
  rewrite input), #7557 (no admin-enforced steering).
