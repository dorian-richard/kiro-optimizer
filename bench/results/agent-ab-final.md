# Agent A/B run `final`: paired analysis

The final run of the v0.2 agent A/B. It uses the same 21 tasks as rounds 1 and 2: 15 exploration tasks on 9 open-source repositories, and 6 test-run diagnosis tasks on copies of this repository with one injected bug each. This time each arm ran each task twice, interleaved, with the same model in both arms: 84 agents in all.

The kopt build is commit 983e221. That is the round-2 build (8143786) plus the round-3 changes:
- `kopt_run` lists every failing test, gives deeper source hints, and no longer matches messages to the wrong code;
- `kopt_run` commands no longer inherit kopt's own `KOPT_*` variables, and the wrapper's npx/npm shims enforce this in both arms. This removes the round-2 confound;
- `kopt refs` and pack callers show the call line, the caller's definition, the callers of thin wrappers and a completeness check;
- member reads and writes are indexed as references;
- the fixed prompt is down to 4 listed tools and a routing steering (852 to 348 tokens);
- the grammars are vendored, and the run snapshot now includes them.

How the data was checked:
- All 84 transcripts were audited. There were 667 tool calls, every one a Bash call through the logging wrapper for the agent's own arm, task and repetition, plus the final structured answer. No call went outside the wrapper.
- The wrapper logs match the transcripts call for call.
- Answers come from the workflow journal, with test-task paths made repository-relative.
- Measured usage comes from the transcripts: one usage block per model request, after removing duplicates by message id, as in round 2.

## Verdict

- **No accuracy regression.** Both arms answered every run correctly under both graders: 30/30 exploration runs and 12/12 test runs, with 100% symbol recall.
- **Every kopt call worked.** Arm B made 106 kopt calls (find 20, read 49, refs 21, run 16):
  - every find, read and refs call exited 0;
  - every `kopt run` call returned the exit status of the test command it ran (14 failing suites, 2 passing targeted runs);
  - there were 0 refused calls, 0 governor blocks and no error text in any kopt output.
  - Two outputs are flagged in the .json (`diagnosis.koptCalls`):
    - one `kopt run` hit the agent harness's 120 s Bash timeout (B-rt5-r1). This is not a kopt failure, but see blocker 3;
    - 6 of the 21 `kopt refs` answers said "incomplete" (blockers 4 and 5).
- **Exploration (15 tasks, 2 runs per arm): this is the first v0.2 run where kopt's session saving is significant.**

  | measure, B vs A (pooled reps, paired by task) | B/A, 95% CI | B lower in | sign test |
  |---|---|---|---|
  | **measured session cost, re-based to a 12k prefix (primary)** | **-23% [-38%, -8%]** | 13/15 | p = 0.007 |
  | modeled cost, 12k prefix + kopt's measured prompt on arm B | -27% [-41%, -11%] | 12/15 | p = 0.035 |
  | modeled cost12k (v0.1 formula) | -28% [-42%, -13%] | 13/15 | p = 0.007 |
  | tokens read | -23% [-39%, -10%] | 13/15 | p = 0.007 |
  | model requests (125 vs 103 per run of the 15 tasks) | -18% [-29%, -5%] | 11/15 (2 ties) | p = 0.022 |
  | tool calls (150 vs 114) | -24% [-36%, -10%] | 11/15 (1 tie) | p = 0.057 |

  - The mean per task is -18% [-29%, -7%] and the median task is -16%.
  - kopt's own prompt is now +282 tokens per request (median first-request context, B minus A). It was +469 in round 2 and +956 in round 1. This is about 1% of arm B's session cost.
  - A round-3 fix shows where it applies: gt-usage-egress-transport went from +74% (round 2) to -26%. `kopt refs NewHTTPTransport` now answers "6 usages · +11 via 2 wrappers · complete", where the round-2 agent grepped the wrapper's callers.
  - The two tasks where B costs more are ms-explain-autobatch (+26%, 9.5 calls vs 7.5) and wp-impact-legacy-is-circular (+7%). On wp-impact, arm B made no kopt call at all in either run.
- **The baseline was costlier in this run, so the cross-run figures are smaller.**
  - Arm A, with an unchanged prompt and wrapper, cost +26% [+13%, +39%] more than in round 1 and +25% [-3%, +57%] more than in round 2. It made 150 calls per pass over the 15 tasks, against 125-126 before.
  - The cause is unknown. The model and the agent harness version are the same as in round 2, but the harness's fixed prefix is 183 tokens shorter here (33,706 against 33,889).
  - Against the mean of both A runs, this run's B is -14% [-29%, +1%] against r1 and -15% [-27%, -2%] against r2.
  - **Pooled over every v0.2 run** (r1 + r2 + final, 4 runs per arm and task, three kopt builds):

    | measure | B/A, 95% CI | B lower in | sign test |
    |---|---|---|---|
    | measured re-based | -18% [-31%, -5%] | 10/15 | p = 0.30 |
    | cost12k + kopt prompt | -24% [-37%, -10%] | 12/15 | p = 0.035 |
    | tokens read | -22% [-35%, -12%] | 14/15 | p < 0.001 |
    | requests | -14% [-24%, -3%] | 8/15 (2 ties) | p = 0.58 |
    | tool calls | -22% [-33%, -9%] | 9/15 (2 ties) | p = 0.27 |

  - The within-run comparison stays the valid one: both arms ran interleaved in the same conditions.
- **Test-run diagnosis (6 tasks, 2 runs per arm): no measurable session saving.** Once flaky-test chasing is removed, `kopt run` cuts what the agent reads by 40-48%, but it does not reduce the number of calls.

  | measure, B vs A | B/A, 95% CI | B lower in |
  |---|---|---|
  | **measured session cost, re-based to 12k (primary)** | **+16% [-31%, +67%]** (median task -7%) | 4/6 (p = 0.69) |
  | cost12k + kopt prompt (wrapper count) | -24% [-57%, +14%] | 4/6 |
  | tokens read (wrapper count, which models a Kiro shell with a 100k-character cap) | -65% [-82%, -37%] | 6/6 (p = 0.031) |
  | tokens read, as delivered to the agents | -26% [-61%, +22%] | 4/6 |
  | requests | +17% [-18%, +52%] | 2/6 |
  | tool calls | +17% [-23%, +56%] | 3/6 |

  - **Two confounds, the same for both arms, explain most of the spread.**
    - **Machine load.** 24 agents ran the 813-test suite at the same time. One full run took 26-116 s (vitest's own duration), against 17.6 s on an idle machine. The timing-dependent tests of kopt's own suite then failed in 9 of 24 runs:
      - a `· 1.1s` duration in the kopt_run header;
      - the hooks fingerprint timeout;
      - the CLI ledger test's 30 s timeout.

      Arm B investigated these extra failures in 5/12 runs (16 calls, 14.5k tokens delivered); arm A did so in 4/12 runs (4 calls, 1.4k tokens). `kopt run` names every failing test, while arm A's output was cut (next point). The two outliers are B-rt2-r1 (7 failures, 6 of them flaky, 14 calls) and B-rt5-r1 (12 calls).
    - **The agent harness, not Kiro.** It cuts the output of a failing command to about 10k characters and moves calls over 120 s to the background.
      - Arm A received 90.0k of the 192.6k tokens the wrapper logged. Its 11 raw full test runs longer than 10k characters reached the agent cut to 10,040 characters (3.3k tokens) each.
      - 3 full runs hit the timeout (2 in A, 1 in B).
      - The same cap cut arm A's test output in 3 of the 6 runs of round 1 and 3 of the 6 runs of round 2. Their test-task "tokens read" figures also overstate arm A's reading, by less.
  - **With the same removal rules for both arms** (labels per call in `diagnosis.testTasks`): calls +2% [-16%, +19%], delivered tokens -40% [-65%, +11%], cost12k + kopt prompt -11% [-30%, +14%], B lower in 5/6.
  - **Up to the first call that shows the injected bug line:** 18.5 calls in both arms, delivered tokens -48% [-65%, -22%], cost -12% [-39%, +21%].
  - **Where the source hints worked:** rt1 (-40% measured), rt4 (-50%) and rt6 (-11%). There, `kopt run` led straight to the buggy function (`execute`, `expandOutput`, `preToolUse`).
  - **Compression:** `kopt run` turned 152k tokens of raw test output into 15.2k (-90%). Arm B received 14.4k tokens of test output, against 53.1k for arm A (-73%).
- **Against round 1** (test tasks; round 2's are confounded and left out): measured -7% [-21%, +10%] in round 1, +16% now, +9% [-19%, +38%] pooled. Tokens read -68%, -65%, and -66% pooled. The test copies changed since round 1: rt3 now fails 20 tests and rt4 4. Treat this comparison as indicative.
- **Against v0.1 (ab2): not a valid kopt comparison.** All 11 kopt calls of v0.1's arm B failed, so its B/A (-15% tokens read, -3% cost12k) compares stock tools with stock tools. It is shown only as a noise reference.

In short: on code exploration in large repositories, kopt v0.2 reduces the session cost by about a fifth with no loss of accuracy:
- -23% [-38%, -8%] measured in this run;
- -18% [-31%, -5%] over every v0.2 run;
- with about 20% fewer requests and tool calls.

On test diagnosis it cuts what the agent reads (by 40-48% once flaky-test chasing is removed), but not the session. In this run, flaky tests under load and the agent harness's caps hid any effect. For large enterprise stacks, expect the saving in the number of exploration turns and in tool output, not in the fixed prompt.

## Why the bill moves less than the token count

- **The fixed prompt is most of the cost.** Every request re-sends the 12k prefix: 50% of arm A's re-based session cost and 55% of arm B's. kopt saved 18% of requests and 23% of tokens read, so the bill fell 23%.
- **kopt's own prompt is no longer a factor.** +282 tokens per request, about 58k tokens over arm B's 205 exploration requests, or 1.3% of its session cost.
- **Exploration saves the most where `kopt refs` answers a "who calls X" question:**
  - md-usage -65%;
  - dj-usage -44%;
  - gt-usage -26%;
  - lv-usage -24%;
  - lv-locate -43%, with one kopt call per run.

## What still blocks bigger savings

Evidence comes from the final run's logs and transcripts. Fixes are listed in order of expected value.

1. **kopt adoption halved with the shorter prompt.**
   - The round-3 prompt dropped the line "Other code questions: `kopt find "<words>" --pack`, then `kopt read "#id"`. No grep or whole-file reads."
   - Arm B's use of kopt fell compared with round 2:

     | arm B, exploration | round 2 | final |
     |---|---|---|
     | kopt calls per run | 4.6 | 2.2 |
     | kopt share of tokens read | 68% | 34% |
     | runs that started with kopt | 15/15 | 27/30 |
     | runs with no kopt call | 0 | 3 (wp-impact twice, dj-explain once) |
     | native calls (tokens), per 15 tasks | 38 (24.6k) | 81.5 (59.7k) |

   - The native calls of the final run include whole-file `cat` reads (4.5 per 15 tasks, 11.8k tokens; 0 in round 2) and `sed` ranges.
   - The saving held anyway, so whether the old line would add to it is untested. Fix: restore one routing line, "read code with `kopt read #id|path:a-b`, not cat/sed" (about 20 tokens). Then run arm B with and without it in the same session.
2. **Flaky timing tests in kopt's own suite under load.** They made 9/24 test-task runs show extra failures, and arm B chased them (16 calls).
   - Fix: make `test/compress.lifecycle.test.ts` "result size" independent of wall time (inject the clock or the 1 s threshold), and do the same for the hooks fingerprint timeout and the CLI ledger test timeout.
   - Fix: run the test tasks at a lower concurrency.
   - Fix: in `kopt run`, group failures that share one assertion diff, so 6 identical "`· 1.1s` in the header" failures read as one cause.
3. **A repeated `kopt run` after an undelivered result says only "same as run X".**
   - In B-rt5-r1, the first run timed out in the agent harness. The re-run answered "same as run oe3b8f0 (call 1), no file changed since", with only the summary counts (84 tokens).
   - The agent then paged the log in 4 reads (5.9k tokens) to find the failures.
   - Fix: a failing re-run repeats its compact failure list (under 1k tokens), not only the verdict line.
4. **Unresolved receivers in TypeScript and Rust.**
   - `kopt refs LocalWorkflow.cancel` answered 0 usages, with 36 unresolved `cancel` calls. The call is `flow.cancel(...)` with `const flow = new LocalWorkflow(...)`. Arm B grepped instead in both md-usage runs: 7 and 5 native calls, 3.8k and 2.5k tokens.
   - Rust `self.create_next_batch_unprioritized(...)` inside `impl IndexScheduler` was listed only as "possible".
   - Fix: type TS/JS locals initialized with `new X(...)` and typed parameters, as round 3 did for Go, Java, C# and Kotlin. Resolve Rust `self.` calls to the impl type.
5. **The completeness check counts comments.** `kopt refs autobatch` said "incomplete: 19 functions name autobatch with no reference linked". These are test functions whose comments say "we can autobatch". Fix: skip comments and string literals in the text check.
6. **Callers are read with `sed` after a complete `kopt refs`.**
   - In sf-usage-fail-early run 2, a complete 237-token refs answer was followed by 8.6k tokens of `sed` ranges (one refused) to read `processCommit` and `processRollback`.
   - Each caller already carries its `#id`. Fix: one steering line, "read a caller: `kopt read #id`". Or, for 3 callers or fewer, add their bodies under the existing budget.
7. **Measurement.**
   - The baseline moved +25% between runs, with the same model and harness version, for no identified reason. Keep both arms interleaved in the same session window, as here, and do not compare B across runs without its own A.
   - Report test-task tokens both as logged and as delivered: the harness caps failing output at about 10k characters, which Kiro may or may not do.
   - With 15 exploration tasks, the pooled CI is ±13 points. Add tasks before comparing kopt builds against each other.

## Data and reproduction

- **Inputs:**
  - prompts: `abfinal/prompts-final.json` and `abfinal/prompts-run-final.json` (2 interleaved repetitions);
  - wrapper logs: `bench/agentab/logs/final`;
  - answers and measured usage: extracted from the workflow journal and the 84 agent transcripts.
- **Delivered tokens:** `--seen` lists the 14 calls whose output the agent did not receive in full (11 output caps, 3 Bash timeouts). It covers every call where the transcript holds less than 80% of the logged output.
- **Test-task labels:** the rules, the per-call labels and the bootstrap results are under `diagnosis.testTasks` in the .json.
- **Earlier runs:** comparisons with `agent-ab-r1.json` (explore and test tasks) and `agent-ab-r2.json` (explore only).

## Method

Tables generated by `bench/agentab/analyze.mjs` from the wrapper logs (`bench/agentab/logs/final`), the agents' answers and their
measured token usage. Tokens read = characters of tool output / 3 (wrapper count). 2 interleaved runs per arm and task; a task's value is the mean of its runs, and it counts as found when every run found it. Graders: **lenient** =
the orchestrator's (case-insensitive substring, a file may match by basename); **strict** = score.mjs (whole-word symbols, full
paths, test tasks graded on the ROOT CAUSE line). Cost measures:

- **cost12k** (the v0.1 formula, as in ab2-summary.json "cum"): sum over tool calls of (12,000-token fixed prefix + all tokens read so far). One call = one request; same prefix for both arms, so kopt's own prompt overhead is ignored.
- **cost12k + kopt prompt** (cost12kKopt): cost12k with kopt's measured fixed prompt added to every arm-B call: explore +282 tokens per call (median first-request context of arm B minus arm A), run +315 tokens per call (median first-request context of arm B minus arm A). Same 12k prefix for both arms otherwise.
- **costFull**: sum over model requests 0..n of (12,000 + the arm's prompt + tokens read so far). Arm B's prompt carries kopt's steering, server instructions and command descriptions (median 757 tokens vs 548 for A, chars/3).
- **measured**: input context the agents' model really processed, summed over its requests (input + cache read + cache creation tokens, from the agent transcripts; parallel tool calls share one request). Its fixed prefix is the agent harness's (about 34k tokens), which dilutes relative differences.
- **measured, re-based**: the same with the harness prefix (explore 33,706, run 33,742 tokens, from arm A's first request) replaced by 12,000 tokens on every request; arm B keeps its extra prompt. The closest proxy here to what Kiro would bill.
- **as delivered**: tokens read and cost12k + kopt prompt counted with what the agent really received for 14 calls whose output it did not get in full (the agent harness cut the command's output; the call hit the agent harness's timeout and its output never reached the agent; --seen). The wrapper count models Kiro's shell (2,000 lines / 100k characters).
- **sign test**: exact two-sided binomial test of "B lower" against "B higher" over the tasks that differ (ties dropped).

## Exploration tasks (15)

**Session cost, B vs A** (primary, measured context re-based to a 12k prefix): -23% [-38%, -8%], B lower (CI below 0), B lower in 13/15 tasks (sign test p=0.007); modeled cost12k + kopt prompt: -27% [-41%, -11%]; modeled cost12k: -28% [-42%, -13%]; tokens read: -23% [-39%, -10%].

| arm | found (lenient / strict) | symbol recall (lenient / strict) | tool calls (median) | model requests | kopt calls (tasks >1) | tokens read | of which kopt | test output | cost12k | cost12k + kopt prompt | costFull | measured | measured, re-based | read, as delivered |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | 30/30 / 30/30 | 100% / 100% | 300 (8.5) | 249 | 0 (0) | 235,283 | 0 | 0 | 5,315,428 | 5,315,428 | 5,855,192 | 11,361,044 | 5,956,250 | 235,283 |
| B | 30/30 / 30/30 | 100% / 100% | 228 (7.5) | 205 | 65 (16) | 181,166 | 61,841 | 0 | 3,822,713 | 3,887,009 | 4,377,197 | 9,017,940 | 4,568,210 | 181,166 |

- both found (lenient): the same 15 tasks as "all tasks" (both arms answered every task correctly), so the pass-gated comparison is identical.
- both found (strict): the same 15 tasks as "all tasks" (both arms answered every task correctly), so the pass-gated comparison is identical.

Paired B vs A (relative = B/A - 1; 95% CI from 10,000 seeded bootstrap resamples of tasks):

| task set | metric | n | A total | B total | B/A total | 95% CI | mean per-task | 95% CI | median per-task | B lower / higher (sign test) | verdict (total) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| all tasks | **session cost (primary): measured context re-based to a 12k prefix** | 15 | 2,978,125 | 2,284,105 | -23% | [-38%, -8%] | -18% | [-29%, -7%] | -16% | 13 / 2 (p=0.007) | B lower (CI below 0) |
| all tasks | modeled session cost, 12k prefix + kopt's measured prompt on arm B | 15 | 2,657,714 | 1,943,505 | -27% | [-41%, -11%] | -24% | [-37%, -11%] | -27% | 12 / 3 (p=0.035) | B lower (CI below 0) |
| all tasks | modeled session cost, 12k prefix (v0.1 formula) | 15 | 2,657,714 | 1,911,357 | -28% | [-42%, -13%] | -25% | [-38%, -13%] | -28% | 13 / 2 (p=0.007) | B lower (CI below 0) |
| all tasks | tokens read (tool outputs) | 15 | 117,642 | 90,583 | -23% | [-39%, -10%] | -28% | [-43%, -13%] | -19% | 13 / 2 (p=0.007) | B lower (CI below 0) |
| all tasks | tokens read, as delivered to the agent | 15 | 117,642 | 90,583 | -23% | [-39%, -10%] | -28% | [-43%, -13%] | -19% | 13 / 2 (p=0.007) | B lower (CI below 0) |
| all tasks | modeled cost, 12k + kopt prompt, as delivered | 15 | 2,657,714 | 1,943,505 | -27% | [-41%, -11%] | -24% | [-37%, -11%] | -27% | 12 / 3 (p=0.035) | B lower (CI below 0) |
| all tasks | model requests | 15 | 125 | 103 | -18% | [-29%, -5%] | -14% | [-24%, -4%] | -13% | 11 / 2 (p=0.022) | B lower (CI below 0) |
| all tasks | tool calls | 15 | 150 | 114 | -24% | [-36%, -10%] | -21% | [-34%, -8%] | -19% | 11 / 3 (p=0.057) | B lower (CI below 0) |
| all tasks | modeled session cost incl. first request + arm prompt | 15 | 2,927,596 | 2,188,599 | -25% | [-39%, -11%] | -22% | [-34%, -10%] | -23% | 12 / 3 (p=0.035) | B lower (CI below 0) |
| all tasks | measured agent input context (sum over model requests) | 15 | 5,680,522 | 4,508,970 | -21% | [-33%, -7%] | -16% | [-26%, -6%] | -15% | 13 / 2 (p=0.007) | B lower (CI below 0) |

Run-to-run spread ((max - min) / mean over the 2 runs of a task, mean over tasks): arm A read 9%, cost12k 21%, re-based 24%; arm B read 24%, cost12k 18%, re-based 20%.

Per task (mean of the runs; found = runs that found it):

| task | arm | found (len/strict) | sym | calls | requests | kopt | read | kopt read | test out | raw test out | cost12k | cost12k + kopt prompt | measured, re-based | B/A read | B/A cost12k + kopt | B/A re-based |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| dj-explain-migration-optimizer | A | 2/2 · 2/2 | 100% | 12 | 8 | 0 | 9,036 | 0 | 0 | 0 | 200,683 | 200,683 | 177,939 |  |  |  |
| dj-explain-migration-optimizer | B | 2/2 · 2/2 | 100% | 11 | 8 | 1 | 7,645 | 657 | 0 | 0 | 180,564 | 183,666 | 162,818 | -15% | -8% | -8% |
| dj-usage-add-new-csrf-cookie | A | 2/2 · 2/2 | 100% | 7 | 7 | 0 | 3,065 | 0 | 0 | 0 | 95,687 | 95,687 | 119,580 |  |  |  |
| dj-usage-add-new-csrf-cookie | B | 2/2 · 2/2 | 100% | 3 | 4 | 2 | 1,601 | 786 | 0 | 0 | 39,015 | 39,861 | 67,121 | -48% | -58% | -44% |
| sf-explain-concurrency-limit | A | 2/2 · 2/2 | 100% | 7 | 7 | 0 | 7,281 | 0 | 0 | 0 | 116,805 | 116,805 | 138,643 |  |  |  |
| sf-explain-concurrency-limit | B | 2/2 · 2/2 | 100% | 6 | 6 | 4 | 6,713 | 5,179 | 0 | 0 | 100,513 | 102,205 | 117,771 | -8% | -12% | -15% |
| sf-usage-fail-early | A | 2/2 · 2/2 | 100% | 7 | 6 | 0 | 5,837 | 0 | 0 | 0 | 101,736 | 101,736 | 124,951 |  |  |  |
| sf-usage-fail-early | B | 2/2 · 2/2 | 100% | 6 | 6 | 1 | 6,617 | 238 | 0 | 0 | 85,378 | 86,929 | 122,343 | +13% | -15% | -2% |
| md-explain-compensation | A | 2/2 · 2/2 | 100% | 17 | 10 | 0 | 9,559 | 0 | 0 | 0 | 300,517 | 300,517 | 244,927 |  |  |  |
| md-explain-compensation | B | 2/2 · 2/2 | 100% | 12 | 9 | 5 | 9,092 | 6,231 | 0 | 0 | 207,949 | 211,192 | 219,270 | -5% | -30% | -10% |
| md-usage-cancel-transaction | A | 2/2 · 2/2 | 100% | 18 | 16 | 0 | 12,651 | 0 | 0 | 0 | 369,778 | 369,778 | 457,435 |  |  |  |
| md-usage-cancel-transaction | B | 2/2 · 2/2 | 100% | 8 | 8 | 2 | 3,660 | 496 | 0 | 0 | 114,723 | 116,979 | 158,345 | -71% | -68% | -65% |
| gt-explain-egress | A | 2/2 · 2/2 | 100% | 18 | 17 | 0 | 17,442 | 0 | 0 | 0 | 382,486 | 382,486 | 489,360 |  |  |  |
| gt-explain-egress | B | 2/2 · 2/2 | 100% | 11 | 11 | 2 | 16,195 | 1,714 | 0 | 0 | 252,696 | 255,798 | 338,704 | -7% | -33% | -31% |
| gt-usage-egress-transport | A | 2/2 · 2/2 | 100% | 9 | 5 | 0 | 4,109 | 0 | 0 | 0 | 119,548 | 119,548 | 93,561 |  |  |  |
| gt-usage-egress-transport | B | 2/2 · 2/2 | 100% | 4 | 4 | 2 | 1,725 | 912 | 0 | 0 | 46,370 | 47,357 | 69,141 | -58% | -60% | -26% |
| jf-explain-quick-connect | A | 2/2 · 2/2 | 100% | 10 | 8 | 0 | 9,105 | 0 | 0 | 0 | 173,933 | 173,933 | 176,827 |  |  |  |
| jf-explain-quick-connect | B | 2/2 · 2/2 | 100% | 10 | 7 | 3 | 7,417 | 4,447 | 0 | 0 | 172,775 | 175,595 | 145,230 | -19% | +1% | -18% |
| jf-usage-refresh-trickplay | A | 2/2 · 2/2 | 100% | 4 | 4 | 0 | 2,729 | 0 | 0 | 0 | 54,876 | 54,876 | 69,151 |  |  |  |
| jf-usage-refresh-trickplay | B | 2/2 · 2/2 | 100% | 4 | 4 | 1 | 1,845 | 236 | 0 | 0 | 51,992 | 53,120 | 66,788 | -32% | -3% | -3% |
| lv-locate-cache-flexible | A | 2/2 · 2/2 | 100% | 8 | 8 | 0 | 4,265 | 0 | 0 | 0 | 108,863 | 108,863 | 156,016 |  |  |  |
| lv-locate-cache-flexible | B | 2/2 · 2/2 | 100% | 5 | 5 | 1 | 1,807 | 991 | 0 | 0 | 60,583 | 61,852 | 88,549 | -58% | -43% | -43% |
| lv-usage-image-driver | A | 2/2 · 2/2 | 100% | 3 | 4 | 0 | 3,425 | 0 | 0 | 0 | 36,931 | 36,931 | 61,226 |  |  |  |
| lv-usage-image-driver | B | 2/2 · 2/2 | 100% | 2 | 3 | 1 | 397 | 250 | 0 | 0 | 24,647 | 25,211 | 46,784 | -88% | -32% | -24% |
| ex-impact-check-cycle | A | 2/2 · 2/2 | 100% | 13 | 12 | 0 | 9,272 | 0 | 0 | 0 | 233,570 | 233,570 | 295,278 |  |  |  |
| ex-impact-check-cycle | B | 2/2 · 2/2 | 100% | 11 | 11 | 4 | 6,560 | 2,365 | 0 | 0 | 168,083 | 171,044 | 248,269 | -29% | -27% | -16% |
| ms-explain-autobatch | A | 2/2 · 2/2 | 100% | 8 | 7 | 0 | 13,085 | 0 | 0 | 0 | 152,030 | 152,030 | 177,487 |  |  |  |
| ms-explain-autobatch | B | 2/2 · 2/2 | 100% | 10 | 9 | 6 | 11,489 | 6,421 | 0 | 0 | 179,020 | 181,699 | 223,094 | -12% | +20% | +26% |
| wp-impact-legacy-is-circular | A | 2/2 · 2/2 | 100% | 13 | 9 | 0 | 6,783 | 0 | 0 | 0 | 210,276 | 210,276 | 195,748 |  |  |  |
| wp-impact-legacy-is-circular | B | 2/2 · 2/2 | 100% | 14 | 9 | 0 | 7,824 | 0 | 0 | 0 | 227,053 | 231,001 | 209,881 | +15% | +10% | +7% |

kopt usage (arm B): 65 kopt calls in 30 runs (2.2 per task; 16/30 tasks with more than one; first call was kopt in 27/30); by command: find 16, refs 20, read 29; kopt errors: 0; governor blocks: 0. kopt output = 34% of B's tokens read; 163 native calls (119,325 tokens), 124 of them after a kopt call.

| task | kopt calls | kopt commands, in order | native calls after the first kopt call (tokens) |
|---|---|---|---|
| dj-explain-migration-optimizer (run 1) | 1 | find | 10 (5,743) |
| dj-explain-migration-optimizer (run 2) | 0 | - | 0 (0) |
| dj-usage-add-new-csrf-cookie (run 1) | 1 | refs | 2 (788) |
| dj-usage-add-new-csrf-cookie (run 2) | 2 | refs > refs | 1 (843) |
| sf-explain-concurrency-limit (run 1) | 2 | find > read | 3 (2,493) |
| sf-explain-concurrency-limit (run 2) | 6 | find > read > read > find > read > read | 1 (574) |
| sf-usage-fail-early (run 1) | 1 | refs | 4 (3,761) |
| sf-usage-fail-early (run 2) | 1 | refs | 5 (8,996) |
| md-explain-compensation (run 1) | 5 | find > read > read > read > read | 8 (2,590) |
| md-explain-compensation (run 2) | 5 | find > read > read > read > read | 5 (3,131) |
| md-usage-cancel-transaction (run 1) | 2 | refs > refs | 7 (3,839) |
| md-usage-cancel-transaction (run 2) | 2 | refs > refs | 5 (2,488) |
| gt-explain-egress (run 1) | 2 | find > read | 9 (13,947) |
| gt-explain-egress (run 2) | 2 | find > read | 9 (15,014) |
| gt-usage-egress-transport (run 1) | 2 | refs > read | 2 (773) |
| gt-usage-egress-transport (run 2) | 1 | refs | 2 (853) |
| jf-explain-quick-connect (run 1) | 2 | find > read | 8 (3,582) |
| jf-explain-quick-connect (run 2) | 4 | find > read > read > read | 6 (2,359) |
| jf-usage-refresh-trickplay (run 1) | 1 | refs | 3 (1,609) |
| jf-usage-refresh-trickplay (run 2) | 1 | refs | 3 (1,609) |
| lv-locate-cache-flexible (run 1) | 1 | read | 3 (850) |
| lv-locate-cache-flexible (run 2) | 1 | find | 4 (783) |
| lv-usage-image-driver (run 1) | 1 | refs | 1 (169) |
| lv-usage-image-driver (run 2) | 1 | refs | 1 (124) |
| ex-impact-check-cycle (run 1) | 5 | refs > read > find > find > find | 6 (2,990) |
| ex-impact-check-cycle (run 2) | 2 | refs > read | 8 (5,400) |
| ms-explain-autobatch (run 1) | 3 | find > read > refs | 5 (8,945) |
| ms-explain-autobatch (run 2) | 8 | find > read > read > read > read > refs > read > refs | 3 (1,191) |
| wp-impact-legacy-is-circular (run 1) | 0 | - | 0 (0) |
| wp-impact-legacy-is-circular (run 2) | 0 | - | 0 (0) |

## Test-run diagnosis tasks (6)

**Session cost, B vs A** (primary, measured context re-based to a 12k prefix): +16% [-31%, +67%], not significant, B lower in 4/6 tasks (sign test p=0.69); modeled cost12k + kopt prompt: -24% [-57%, +14%]; modeled cost12k: -25% [-58%, +12%]; tokens read: -65% [-82%, -37%].

| arm | found (lenient / strict) | symbol recall (lenient / strict) | tool calls (median) | model requests | kopt calls (tasks >1) | tokens read | of which kopt | test output | cost12k | cost12k + kopt prompt | costFull | measured | measured, re-based | read, as delivered |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | 12/12 / 12/12 | 100% / 100% | 64 (5) | 72 | 0 (0) | 192,576 | 0 | 155,649 | 1,661,419 | 1,661,419 | 1,847,675 | 3,187,433 | 1,622,009 | 90,013 |
| B | 12/12 / 12/12 | 100% / 100% | 75 (5) | 84 | 41 (10) | 66,902 | 39,941 | 15,176 | 1,238,067 | 1,261,692 | 1,451,058 | 3,711,242 | 1,884,914 | 66,167 |

- both found (lenient): the same 6 tasks as "all tasks" (both arms answered every task correctly), so the pass-gated comparison is identical.
- both found (strict): the same 6 tasks as "all tasks" (both arms answered every task correctly), so the pass-gated comparison is identical.

Paired B vs A (relative = B/A - 1; 95% CI from 10,000 seeded bootstrap resamples of tasks):

| task set | metric | n | A total | B total | B/A total | 95% CI | mean per-task | 95% CI | median per-task | B lower / higher (sign test) | verdict (total) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| all tasks | **session cost (primary): measured context re-based to a 12k prefix** | 6 | 811,005 | 942,457 | +16% | [-31%, +67%] | +15% | [-32%, +69%] | -7% | 4 / 2 (p=0.69) | not significant |
| all tasks | modeled session cost, 12k prefix + kopt's measured prompt on arm B | 6 | 830,710 | 630,846 | -24% | [-57%, +14%] | -24% | [-58%, +15%] | -49% | 4 / 2 (p=0.69) | not significant |
| all tasks | modeled session cost, 12k prefix (v0.1 formula) | 6 | 830,710 | 619,034 | -25% | [-58%, +12%] | -26% | [-59%, +13%] | -50% | 4 / 2 (p=0.69) | not significant |
| all tasks | tokens read (tool outputs) | 6 | 96,288 | 33,451 | -65% | [-82%, -37%] | -63% | [-82%, -37%] | -81% | 6 / 0 (p=0.031) | B lower (CI below 0) |
| all tasks | tokens read, as delivered to the agent | 6 | 45,007 | 33,084 | -26% | [-61%, +22%] | -25% | [-62%, +25%] | -54% | 4 / 2 (p=0.69) | not significant |
| all tasks | modeled cost, 12k + kopt prompt, as delivered | 6 | 553,191 | 626,436 | +13% | [-35%, +61%] | +10% | [-36%, +60%] | -11% | 4 / 2 (p=0.69) | not significant |
| all tasks | model requests | 6 | 36 | 42 | +17% | [-18%, +52%] | +16% | [-19%, +54%] | +4% | 2 / 3 (p=1.00) | not significant |
| all tasks | tool calls | 6 | 32 | 38 | +17% | [-23%, +56%] | +15% | [-25%, +57%] | 0% | 3 / 3 (p=1.00) | not significant |
| all tasks | modeled session cost incl. first request + arm prompt | 6 | 923,838 | 725,529 | -21% | [-52%, +14%] | -21% | [-52%, +14%] | -44% | 4 / 2 (p=0.69) | not significant |
| all tasks | measured agent input context (sum over model requests) | 6 | 1,593,717 | 1,855,621 | +16% | [-25%, +60%] | +16% | [-25%, +62%] | -2% | 3 / 3 (p=1.00) | not significant |

Run-to-run spread ((max - min) / mean over the 2 runs of a task, mean over tasks): arm A read 24%, cost12k 28%, re-based 19%; arm B read 59%, cost12k 56%, re-based 56%.

Per task (mean of the runs; found = runs that found it):

| task | arm | found (len/strict) | sym | calls | requests | kopt | read | kopt read | test out | raw test out | cost12k | cost12k + kopt prompt | measured, re-based | B/A read | B/A cost12k + kopt | B/A re-based |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| rt1 | A | 2/2 · 2/2 | 100% | 5 | 6 | 0 | 12,753 | 0 | 9,824 | 0 | 118,238 | 118,238 | 133,376 |  |  |  |
| rt1 | B | 2/2 · 2/2 | 100% | 4 | 5 | 3 | 2,049 | 1,696 | 823 | 10,887 | 47,499 | 48,601 | 79,678 | -84% | -59% | -40% |
| rt2 | A | 2/2 · 2/2 | 100% | 7 | 7 | 0 | 12,822 | 0 | 10,080 | 0 | 152,122 | 152,122 | 163,145 |  |  |  |
| rt2 | B | 2/2 · 2/2 | 100% | 11 | 11 | 3 | 7,270 | 1,823 | 1,897 | 11,100 | 180,927 | 184,234 | 256,173 | -43% | +21% | +57% |
| rt3 | A | 2/2 · 2/2 | 100% | 6 | 7 | 0 | 27,499 | 0 | 24,452 | 0 | 192,303 | 192,303 | 151,666 |  |  |  |
| rt3 | B | 2/2 · 2/2 | 100% | 6 | 7 | 4 | 4,908 | 3,259 | 2,549 | 18,443 | 93,135 | 95,025 | 147,328 | -82% | -51% | -3% |
| rt4 | A | 2/2 · 2/2 | 100% | 5 | 6 | 0 | 14,317 | 0 | 11,254 | 0 | 110,346 | 110,346 | 121,688 |  |  |  |
| rt4 | B | 2/2 · 2/2 | 100% | 3 | 4 | 2 | 2,525 | 1,562 | 738 | 8,430 | 34,455 | 35,243 | 61,278 | -82% | -68% | -50% |
| rt5 | A | 2/2 · 2/2 | 100% | 5 | 6 | 0 | 14,335 | 0 | 11,520 | 0 | 123,947 | 123,947 | 124,057 |  |  |  |
| rt5 | B | 2/2 · 2/2 | 100% | 10 | 11 | 8 | 13,782 | 8,957 | 1,318 | 17,551 | 193,108 | 196,258 | 294,349 | -4% | +58% | +137% |
| rt6 | A | 2/2 · 2/2 | 100% | 6 | 6 | 0 | 14,564 | 0 | 10,697 | 0 | 133,755 | 133,755 | 117,075 |  |  |  |
| rt6 | B | 2/2 · 2/2 | 100% | 5 | 6 | 3 | 2,919 | 2,675 | 264 | 9,703 | 69,911 | 71,486 | 103,653 | -80% | -47% | -11% |

kopt usage (arm B): 41 kopt calls in 12 runs (3.4 per task; 10/12 tasks with more than one; first call was kopt in 12/12); by command: run 16, read 20, find 4, refs 1; kopt errors: 0; governor blocks: 0. kopt output = 60% of B's tokens read; 34 native calls (26,961 tokens), 34 of them after a kopt call.

| task | kopt calls | kopt commands, in order | native calls after the first kopt call (tokens) |
|---|---|---|---|
| rt1 (run 1) | 3 | run > read > run | 1 (239) |
| rt1 (run 2) | 2 | run > read | 1 (467) |
| rt2 (run 1) | 1 | run | 13 (9,850) |
| rt2 (run 2) | 4 | run > read > read > find | 3 (1,044) |
| rt3 (run 1) | 5 | run > read > read > refs > read | 4 (3,168) |
| rt3 (run 2) | 2 | run > read | 1 (130) |
| rt4 (run 1) | 2 | run > read | 1 (23) |
| rt4 (run 2) | 1 | run | 1 (1,902) |
| rt5 (run 1) | 9 | run > run > read > read > read > read > find > read > run | 3 (9,619) |
| rt5 (run 2) | 6 | run > find > read > read > run > find | 2 (31) |
| rt6 (run 1) | 3 | run > read > read | 2 (342) |
| rt6 (run 2) | 3 | run > read > read | 2 (146) |

## Against v0.1 (ab2, same 15 exploration tasks)

v0.1 numbers come from `ab2-summary.json` (same wrapper count, same cost12k formula, same lenient grader).

| run | A found | B found | A read | B read | B/A read | A cost12k | B cost12k | B/A cost12k | A calls | B calls | B kopt calls |
|---|---|---|---|---|---|---|---|---|---|---|---|
| v0.1 (ab2) | 14/15 | 14/15 | 82,808 | 70,399 | -15% | 1,618,653 | 1,571,248 | -3% | 101 | 105 | 11 |
| v0.2 (final) | 15/15 | 15/15 | 117,642 | 90,583 | -23% | 2,657,714 | 1,911,357 | -28% | 150 | 114 | 32.5 |

| paired comparison (15 tasks) | B/A total | 95% CI | mean per-task | 95% CI |
|---|---|---|---|---|
| v0.1: B vs A, tokens read | -15% | [-21%, -10%] | -17% | [-25%, -10%] |
| v0.1: B vs A, cost12k | -3% | [-13%, +9%] | +3% | [-9%, +15%] |
| final: B vs A, tokens read | -23% | [-39%, -10%] | -28% | [-43%, -13%] |
| final: B vs A, cost12k | -28% | [-42%, -13%] | -25% | [-38%, -13%] |
| final B vs mean of both A runs, tokens read | -10% | [-28%, +5%] | -15% | [-33%, +3%] |
| noise floor: A(final) vs A(v0.1), tokens read | +42% | [+30%, +57%] | +53% | [+32%, +80%] |
| noise floor: A(final) vs A(v0.1), cost12k | +64% | [+37%, +91%] | +67% | [+42%, +95%] |
| B(final) vs B(v0.1), tokens read | +29% | [+5%, +54%] | +32% | [+3%, +67%] |

## Against an earlier run (`r1`, same tasks)

Paired over tasks (relative = later/earlier - 1 for drift, B/A - 1 otherwise; 95% CI from 10,000 seeded bootstrap resamples of tasks). Arm A is the same stock tooling in both runs, so its drift is the run-to-run noise. "Pooled" = per task, the mean of the two runs' values of each arm (each run's value is the mean of its repetitions). kopt's measured prompt in `r1`: explore +956, run +1,146 tokens per call.

| tasks | metric | r1: B/A | final: B/A | drift A (final vs r1) | drift B | final B vs mean of both A runs | pooled r1+final: B/A |
|---|---|---|---|---|---|---|---|
| explore (15) | session cost: measured, re-based | -12% [-26%, +8%] | -23% [-38%, -8%] | +26% [+13%, +39%] | +10% [-3%, +24%] | -14% [-29%, +1%] | -18% [-31%, -2%] |
| explore (15) | modeled cost12k + kopt prompt | -27% [-41%, -4%] | -27% [-41%, -11%] | +25% [+13%, +43%] | +25% [+7%, +41%] | -19% [-34%, 0%] | -27% [-40%, -10%] |
| explore (15) | modeled cost12k | -31% [-45%, -10%] | -28% [-42%, -13%] | +25% [+13%, +43%] | +30% [+12%, +47%] | -20% [-36%, -2%] | -29% [-42%, -14%] |
| explore (15) | tokens read | -25% [-35%, -14%] | -23% [-39%, -10%] | +27% [+15%, +44%] | +31% [+15%, +44%] | -14% [-30%, -1%] | -24% [-36%, -13%] |
| explore (15) | model requests | -8% [-21%, +8%] | -18% [-29%, -5%] | +16% [+7%, +25%] | +5% [-6%, +17%] | -11% [-23%, +1%] | -13% [-24%, -1%] |
| explore (15) | tool calls | -25% [-39%, -4%] | -24% [-36%, -10%] | +19% [+9%, +34%] | +20% [+3%, +38%] | -17% [-31%, -1%] | -24% [-36%, -10%] |
| run (6) | session cost: measured, re-based | -7% [-21%, +10%] | +16% [-31%, +67%] | +6% [-6%, +25%] | +32% [-26%, +104%] | +19% [-26%, +67%] | +5% [-13%, +24%] |
| run (6) | modeled cost12k + kopt prompt | -21% [-39%, +9%] | -24% [-57%, +14%] | +35% [+17%, +64%] | +29% [-32%, +105%] | -13% [-50%, +28%] | -23% [-41%, -3%] |
| run (6) | modeled cost12k | -27% [-43%, +1%] | -25% [-58%, +12%] | +35% [+17%, +64%] | +37% [-28%, +118%] | -14% [-51%, +26%] | -26% [-44%, -6%] |
| run (6) | tokens read | -68% [-80%, -45%] | -65% [-82%, -37%] | +47% [+17%, +123%] | +60% [-21%, +168%] | -59% [-80%, -28%] | -66% [-79%, -48%] |
| run (6) | model requests | +3% [-8%, +16%] | +17% [-18%, +52%] | +3% [-7%, +17%] | +17% [-21%, +62%] | +18% [-14%, +51%] | +10% [-2%, +22%] |
| run (6) | tool calls | +7% [-6%, +19%] | +17% [-23%, +56%] | +7% [-1%, +15%] | +17% [-28%, +70%] | +21% [-19%, +59%] | +12% [-3%, +26%] |

## Against an earlier run (`r2`, same tasks)

Paired over tasks (relative = later/earlier - 1 for drift, B/A - 1 otherwise; 95% CI from 10,000 seeded bootstrap resamples of tasks). Arm A is the same stock tooling in both runs, so its drift is the run-to-run noise. "Pooled" = per task, the mean of the two runs' values of each arm (each run's value is the mean of its repetitions). kopt's measured prompt in `r2`: explore +469, run +624 tokens per call.

| tasks | metric | r2: B/A | final: B/A | drift A (final vs r2) | drift B | final B vs mean of both A runs | pooled r2+final: B/A |
|---|---|---|---|---|---|---|---|
| explore (15) | session cost: measured, re-based | -11% [-28%, +5%] | -23% [-38%, -8%] | +25% [-3%, +57%] | +8% [-18%, +41%] | -15% [-27%, -2%] | -18% [-31%, -5%] |
| explore (15) | modeled cost12k + kopt prompt | -14% [-33%, +7%] | -27% [-41%, -11%] | +29% [+7%, +53%] | +9% [-12%, +40%] | -18% [-34%, +1%] | -21% [-37%, -7%] |
| explore (15) | modeled cost12k | -16% [-35%, +4%] | -28% [-42%, -13%] | +29% [+7%, +53%] | +11% [-11%, +41%] | -19% [-35%, -1%] | -23% [-38%, -9%] |
| explore (15) | tokens read | -17% [-32%, +1%] | -23% [-39%, -10%] | +28% [+13%, +49%] | +18% [-8%, +42%] | -14% [-28%, -2%] | -20% [-34%, -10%] |
| explore (15) | model requests | -10% [-25%, +5%] | -18% [-29%, -5%] | +14% [-4%, +34%] | +5% [-16%, +30%] | -12% [-22%, -2%] | -14% [-25%, -3%] |
| explore (15) | tool calls | -14% [-33%, +4%] | -24% [-36%, -10%] | +20% [+6%, +36%] | +7% [-14%, +35%] | -17% [-32%, +1%] | -20% [-33%, -7%] |

## Every run pooled (`r1`, `r2`, `final`)

Per task and arm, the mean over every repetition of these runs (different kopt builds: the pooled figure averages them), then paired over tasks as above.

| tasks | runs | repetitions per arm | metric | pooled B/A total | 95% CI | mean per-task | 95% CI | B lower / higher (sign test) |
|---|---|---|---|---|---|---|---|---|
| explore (15) | r1 + r2 + final | 4 | session cost: measured, re-based | -18% | [-31%, -5%] | -12% | [-24%, -2%] | 10 / 5 (p=0.30) |
| explore (15) | r1 + r2 + final | 4 | modeled cost12k + kopt prompt | -24% | [-37%, -10%] | -19% | [-31%, -8%] | 12 / 3 (p=0.035) |
| explore (15) | r1 + r2 + final | 4 | modeled cost12k | -26% | [-39%, -13%] | -21% | [-33%, -11%] | 13 / 2 (p=0.007) |
| explore (15) | r1 + r2 + final | 4 | tokens read | -22% | [-35%, -12%] | -25% | [-37%, -13%] | 14 / 1 (p<0.001) |
| explore (15) | r1 + r2 + final | 4 | model requests | -14% | [-24%, -3%] | -10% | [-20%, -1%] | 8 / 5 (p=0.58) |
| explore (15) | r1 + r2 + final | 4 | tool calls | -22% | [-33%, -9%] | -17% | [-28%, -7%] | 9 / 4 (p=0.27) |
| run (6) | r1 + final | 3 | session cost: measured, re-based | +9% | [-19%, +38%] | +7% | [-20%, +39%] | 4 / 2 (p=0.69) |
| run (6) | r1 + final | 3 | modeled cost12k + kopt prompt | -23% | [-46%, +2%] | -23% | [-46%, +1%] | 4 / 2 (p=0.69) |
| run (6) | r1 + final | 3 | modeled cost12k | -26% | [-49%, -1%] | -26% | [-48%, -2%] | 4 / 2 (p=0.69) |
| run (6) | r1 + final | 3 | tokens read | -66% | [-80%, -46%] | -63% | [-78%, -45%] | 6 / 0 (p=0.031) |
| run (6) | r1 + final | 3 | model requests | +12% | [-8%, +32%] | +11% | [-9%, +32%] | 2 / 4 (p=0.69) |
| run (6) | r1 + final | 3 | tool calls | +14% | [-10%, +36%] | +12% | [-11%, +36%] | 2 / 3 (p=1.00) |

