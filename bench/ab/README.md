# Online A/B: kiro-cli, stock Kiro vs Kiro + kopt

> **NOT TESTED against a real kiro-cli.** kiro-cli was not installed where this harness was written.
> The flags come from the official docs (kiro.dev/docs/cli/headless). The credit fields of the stream and of the
> session files are undocumented: they come from captures published by third parties (kiro-cli 2.27).
> Only the plumbing (plan, isolation, parsing, grading, statistics) is tested, with stubs, in
> `test/bench-ab.test.ts`. **Run a probe before any campaign** (see below).

## Arms

| arm | agent | tools | workspace setup |
|---|---|---|---|
| **A** (control) | `agents/kopt-ab-a.json` | `read` (built-in read/grep/glob) | no trace of kopt; the script refuses to run if `.kiro/steering`, `mcp.json` or `.kopt` exist |
| **B** (treatment) | `agents/kopt-ab-b.json` | `read` + `@kopt` | `kopt init --force` (MCP, hooks, steering, explorer agent) + `kopt index` |
| **M** (memory probe, optional) | `agents/kopt-ab-m.json` | none | nothing |

- Every arm shares the same system prompt, the same question suffix (see `buildPrompt` in `ab-lib.mjs`) and the
  same model (`--model`, required), with an optional effort (`--effort`).
- If arm M answers a task correctly, the task is flagged "memorized". `--exclude-memorized` drops it from the
  comparison.

## Isolation (lessons from CodeGraph and SDL-MCP)

- **One `git worktree` per arm** (`work/<repo>/<arm>`): the steering, hooks and `mcp.json` of arm B cannot leak
  into arm A.
- **A fresh HOME per run** (`AB_ISOLATE_HOME=1`, the default): no global steering or agents, no user-level MCP
  servers. Kiro's session files land in the run folder. Authentication uses `KIRO_API_KEY` (Pro, Pro+, Pro Max or
  Power subscription).
- **Every run is a new session**: an independent `kiro-cli chat --no-interactive` process.
- **Random, interleaved order**: tasks are shuffled on every repetition, the arm order is drawn at random for each
  task, with a fixed seed (`SEED`). No arm systematically benefits from a warm cache.
- Arm A has no `shell`: it cannot reach the kopt CLI.
- After each run, a modified worktree is recorded (`dirty` in `meta.json`) and then restored.
- Every attempt is kept, failures and timeouts included. No best-of. The script can resume: a run that already has
  its `exit_code` is not run again.

## Running it

```bash
# prerequisites: kiro-cli >= 2.27 (stream-json V2/V3), Node 22, kopt built (npm run build), checkouts in bench/repos/*
export KIRO_API_KEY=...                   # Kiro API key
export KOPT="node $PWD/dist/cli.js"       # or "kopt" if it is on the PATH

# 1. Probe: one task, one run per arm. Check that runs.csv contains credits and a non-empty answer.
MODEL=claude-sonnet-4.5 N=1 ONLY=dj-usage-resolve-callables bench/ab/run-kiro-cli-ab.sh django probe
column -s, -t < bench/ab/runs/probe/runs.csv | less -S
# if credits is empty: open stream.jsonl and home/.kiro/sessions to find the fields, then adapt ab-lib.mjs

# 2. Campaign: 15 tasks x 2 arms x 3 repetitions = 90 runs per repository (+ ARMS="A B M" for the memory probe)
MODEL=claude-sonnet-4.5 N=3 bench/ab/run-kiro-cli-ab.sh django django-sonnet
MODEL=claude-sonnet-4.5 N=3 bench/ab/run-kiro-cli-ab.sh spring-framework spring-sonnet

# re-parse / re-analyze without running again
node bench/ab/ab-lib.mjs parse --tasks bench/tasks/django.json --runs bench/ab/runs/django-sonnet > runs.csv
node bench/ab/analyze.mjs runs.csv --exclude-memorized --json analysis.json
```

Variables: `MODEL` (required), `EFFORT`, `N=3`, `ARMS="A B"`, `ONLY=id1,id2`, `SEED=42`, `ENGINE=v3`,
`TIMEOUT_S=900`, `AB_ISOLATE_HOME=1`, `KIRO_CLI`, `KOPT`, `TRUST_A`/`TRUST_B`/`TRUST_M` (lists for
`--trust-tools`), `PASS_RATIO=0.6`, `AB_TASKS`/`AB_SRC`/`AB_OUT`/`AB_WORK` (paths).

**Indicative budget**: at 2 to 5 credits per run (an assumption), 180 runs (2 repositories x 15 tasks x 2 arms x 3
repetitions) cost 360 to 900 credits, or about $15 to $36 at the overage rate ($0.04 per credit).

## Outputs (`runs/<label>/`)

- `plan.tsv`, then for each run `<task>/<arm>-<rep>/`: `stream.jsonl`, `stderr.log`, `exit_code`, `meta.json`,
  `stop-hook.json` and `home/.kiro/sessions/**`.
- `runs.csv`: one row per run. Columns `credits`, `credits_source`, `credits_stream_v2`, `credits_stream_v3`,
  `credits_session`, `requests`, `tool_calls`, `builtin_tool_uses`, `kopt_calls`, `ctx_pct_max`, `answer_chars`,
  `answer_source`, `gold_mentioned`, `symbol_recall`, `pass`, etc.
- `report.md` and `analysis.json`.

### Where the credits come from (in order of preference)

1. V2 session file `~/.kiro/sessions/cli/<id>.json`: the sum of `user_turn_metadatas[].metering_usage[].value`
   (unit `credit`), i.e. one counter per model request. The same file also gives `total_request_count`,
   `builtin_tool_uses`, `context_usage_percentage` and `turn_duration`.
2. V3 stream: the last `session_info_update` that contains `_meta.kiro.promptTurnSummaries[].usage`.
3. V2 stream: `metadata` events that contain `meteringUsage: [{value, unit: "credit"}]`.
4. V3 session `~/.kiro/sessions/<ws>/sess_<id>/`: `usage_summary.promptTurnSummaries[].usage`.

All four values stay visible in the CSV so they can be cross-checked. Kiro does not report a token count (the token
fields of the sidecar files are 0).

### Grading (pre-registered)

- The final answer is read from the Stop hook payload (`assistant_response`), otherwise from the
  `agent_message_chunk` events of the stream.
- A task is **passed** if the answer names at least ⌈0.6 × n⌉ of the n gold symbols, as whole identifiers
  (that is 2/2, 2/3 or 3/4). Adjustable with `PASS_RATIO`.
- For a given task and arm, the result is "passed" if at least half of the repetitions pass.

### Analysis (`analyze.mjs`)

- The median over repetitions is taken for each task and each arm. Failures are kept.
- Tasks passed by **both** arms give the paired difference B − A. The report gives the median and the mean, the
  95% CI by bootstrap over tasks (10,000 resamples, fixed seed), the geometric ratio B/A with its CI, and a sign test.
- For each arm: success rate, tasks passed, total credits, **cost per passed run**, requests, tool calls, duration.
- **Verdict**: a saving is concluded only if the upper bound of the CI of the mean difference is < 0 AND B passes at
  least as many tasks as A minus one. Otherwise: "no saving can be claimed".

## To confirm on the first real run (TODO)

- The exact schema of `--output-format stream-json` in V2 and V3. `ab-lib.mjs` walks every JSON object to tolerate
  variations, but this must be confirmed on a probe.
- The `stop` hook declared in the agent JSON (2.x format): is it still executed in V3? As a fallback,
  `capture-hook.json` is installed in `.kiro/hooks/` (v1 format, `Stop` trigger). Does the V3 Stop payload contain
  `assistant_response`?
- The `--trust-tools` syntax expected for MCP tools (`@kopt` or `@kopt/kopt_find`). `allowedTools` is also set in
  the agents.
- `usedTools` in the turn summaries: is it a number of calls or a list of distinct tools? In the second case,
  `tool_calls` is a lower bound.
- Is an isolated HOME enough for kiro-cli, or do some settings have to be copied (for example `chat.defaultModel`)?
  If not, use `AB_ISOLATE_HOME=0`: the script then only copies the session files written during the run.
- Add a "kopt steering without tools" arm to separate the effect of the prompt from the effect of the tools, a bias
  noticed in CodeGraph's benchmark.
