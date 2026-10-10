# Agent A/B run `r2`: paired analysis

Round 2 of the v0.2 agent A/B. It uses the same 21 tasks as round 1: 15 exploration tasks on 9 open-source repositories, and 6 test-run diagnosis tasks on copies of this repository with one injected bug each. One agent ran per arm and task, with the same model in both arms. This is repetition 1 of the planned 3; repetitions 2 and 3 were not run.

The kopt build is commit 8143786. That is the round-1 build (5ce628a) plus the round-1 fixes:
- `kopt read` returns named functions whole up to 6k tokens;
- `function` includes methods;
- namespace-qualified targets resolve;
- the Go resolver handles typed receivers and fields;
- `kopt refs` gives caller definition lines and a text completeness check;
- the steering is routing-only and shorter;
- `kopt run` adds source hints;
- `KOPT_SESSION` keeps the CLI dedup ledger.

How the data was checked:
- All 42 transcripts were audited. Every tool call was a Bash call through the logging wrapper, plus the final structured answer. No tool was used outside the wrapper.
- Answers come from the workflow journal.
- Measured usage comes from the transcripts, one usage block per model request after removing duplicates by message id. The same extraction reproduces round 1's `usage-r1.json` exactly for all 42 round-1 agents.

## Verdict

- **No accuracy regression.** Both arms answered every task correctly under both graders: 15/15 exploration tasks and 6/6 test tasks. Symbol recall is 100% in both arms. v0.1 scored 14/15 in both arms.
- **Exploration (15 tasks): savings are real, moderate and reproducible.**
  - **This run, B vs A:**
    - tokens read: -17% [-32%, +1%], lower in 12/15 tasks;
    - tool calls: -14%;
    - model requests: -10% (98 vs 109);
    - modeled cost12k: -16% [-35%, +4%];
    - measured session cost re-based to a 12k prefix: **-11% [-28%, +5%]**. B is lower in 10/15 tasks and the median task is -20%.
  - **Rounds 1 and 2 pooled** (two runs per arm and task, see "Against the previous run"):
    - tokens read: **-21% [-32%, -9%]**;
    - tool calls: **-20% [-33%, -4%]**;
    - cost12k: **-24% [-37%, -8%]**;
    - measured session cost re-based to 12k: **-12% [-23%, +3%]**.
  - **The baseline is stable.** Arm A did not drift between the two runs: +1% measured, -1% tokens read, -1% calls. Both runs give the same measured saving (-12% in round 1, -11% now). The effect is real, but it is still just short of significance at n = 15.
  - **The round-1 fixes did not move arm B's aggregate.** Its measured cost changed +2% [-23%, +36%] and its tokens read +10% [-5%, +31%]. Single tasks changed by up to 2.5x between runs: md-explain-compensation went from 7 to 15 calls, ms-explain-autobatch from 8 to 5.
  - **The targeted fixes did work where they apply:**
    - all 6 "who calls X" tasks now open with `kopt refs`;
    - `kopt refs NewHTTPTransport` now lists the gitproxy caller it missed in round 1, with "text check: all listed";
    - in the five usage tasks other than gt-usage, native calls after kopt dropped from 13 (6,378 tokens) to 5 (3,089 tokens);
    - kopt's extra prompt per request halved: +469 tokens (explore) and +624 (test), against +956 and +1,146 in round 1.
- **Test-run diagnosis (6 tasks): this run's session numbers are confounded and must not be read as kopt's effect.**
  - **The raw numbers:** arm B made 84 calls against 27 and cost +260% measured. Two things caused this.
    - **The leak.** The wrapper gives kopt calls `KOPT_SESSION`, the CLI session ledger. `kopt run` passes its whole environment to the command it runs (`quietEnv` in src/compress/runner.ts spreads `process.env`). kopt's own test `test/cli.test.ts` then copies `process.env` into the CLIs it spawns.
    - **The result:** "calls without a session stay stateless" failed with an assertion in 6/6 arm-B runs. It was the first failure `kopt run` printed in detail.
    - **Arm A** never saw that assertion; it saw the same test time out twice under machine load. The 6 B agents chased the extra failure: 38 calls on the session leak, 10 on load flakes, 5 on git environment checks, 32,204 tokens in all.
  - **Confound removed** (same rule applied to both arms, rules in the .json):
    - tokens read: **-45% [-55%, -29%]**, lower in 6/6 tasks;
    - cost12k: **+3% [-21%, +25%]**;
    - calls: +29% (31 vs 24).
  - **Up to the first call that showed the injected bug line:** B used 22 calls against 17, read -52% [-63%, -35%] tokens, and cost +4% [-21%, +30%].
  - **Round 1**, which had no leak, gave the same picture: tokens read -68% and measured cost -7% (not significant).
  - **Conclusion:** `kopt run` compresses test output by 93% (71,771 raw tokens down to 5,026; arm A read 32,337 tokens of test output). It does not shorten the diagnosis session, because arm B makes at least as many calls.
- **Against v0.1 (ab2, same 15 exploration tasks):**
  - tokens read, B vs A: -15% in v0.1, -17% now, -21% pooled with round 1;
  - cost12k, B vs A: -3% in v0.1, -16% now, -24% pooled;
  - kopt calls: 11 in v0.1, all failed; 69 now, 0 errors and 0 governor blocks.
  - Arm A's cost12k is 27% higher than in v0.1 on the same tasks. Treat run-to-run differences of that size as noise.

In short: on code questions in large repositories, kopt reliably reduces what enters the context, by about 20% of tokens read and 20% of tool calls, with no loss of accuracy. The measured session cost falls by about 12%, the same in two independent runs. On test diagnosis it removes over 90% of test output, but the session cost does not fall yet. On large enterprise stacks, expect the same pattern: the saving is in tool output and in the number of exploration turns, not in the fixed prompt.

## Why the saving on the bill is smaller than the saving on tokens

- **The fixed prompt is most of the cost.**
  - Every request re-sends the fixed prefix. That prefix is 73-74% of cost12k (12k tokens per call) and 55-56% of the measured re-based cost, in both arms.
  - So cutting tokens read by 21% moves the session cost by only about 6%. The rest of the saving has to come from fewer requests.
  - Arm B saved 11 of 109 requests (-10%). It made fewer requests than A in 8 tasks, more in 4, and as many in 3.
- **kopt adds a little to every request.** Its extra prompt is +469 tokens per request, about 46k tokens over B's 98 exploration requests, or 2% of its session cost.
- **The round-1 split by task length did not replicate.** In round 1, long explorations saved and short ones cost more. Here the tasks where A needed 9 or more calls are -8% measured, and those where A needed 5 or fewer are -15%.

## What still blocks bigger savings

Evidence comes from the round-2 logs and transcripts. Fixes are listed in order of expected value.

1. **The `KOPT_SESSION` leak in `kopt run`.** This invalidated this run's test tasks, and it would leak an agent's session into any command it runs.
   - Fix: drop `KOPT_SESSION` from the child environment in `quietEnv` (src/compress/runner.ts:48).
   - Fix: set `KOPT_SESSION: ''` in `env()` of test/cli.test.ts:20, so kopt's suite stays hermetic.
   - Then re-run the 6 test tasks.
2. **Calls, not tokens, after `kopt run`.** With the confound removed, B still makes 29% more calls than A. A typically runs the tests, then 2-3 grep/sed calls. B runs `kopt run`, then a `kopt find --pack` of about 1.3k tokens, or 1-2 `kopt expand` calls, then reads. Three issues:
   - **Only 4 failures are printed in detail.** The rest are folded into "+N more failures". Agents then paged through the log with `kopt expand --grep` (4 calls, 4,437 tokens). Fix: print one line per failure, every test with its assertion line, before any detail, and order details by test file so a shared cause is visible.
   - **The source hints have false matches.** In 4/6 runs, "is written in" mapped an assertion literal ("return total", from a test fixture) to unrelated code: `dirSize` in bench/competitors/harness/run-tool.mjs, and `sumCredits`. Fix: require an exact quoted string literal in the symbol's source, and skip bench/, fixtures and test files.
   - **The hints stop one level above the bug.** They name the test's direct callees: runCommand instead of execute (rt1), handleHook instead of preToolUse (rt6), expand instead of expandOutput (rt4). Fix: follow the callee chain to the function that assigns or compares the asserted field (`stored`, `toolCalls`), or show the callees of the first suspect.
3. **`kopt refs` gives the caller but not the call.** Native re-checks after a complete refs output remain in 4 of 6 usage tasks:
   - md-usage: 2 calls, 895 tokens;
   - jf-usage: 2 calls, 998 tokens;
   - lv-usage: a 1,196-token grep after a 101-token refs output;
   - gt-usage: 8 calls, 7,799 tokens.

   The agents want to see the arguments at each call site (md-usage: `preventExecuteNext`), so they run `sed` around every call line. Fixes:
   - print the trimmed source of each call line (100 characters at most) after `L1346 in #7wd ... (def L1320)`;
   - reword the text check. "4 functions name resolveDriver · 3 listed · 1 call another resolveDriver" reads as a possible miss, and the agent grepped to verify it.
4. **Thin wrappers hide the real users.** In gt-usage-egress-transport, B was +74% measured. `kopt refs NewHTTPTransport` listed `NewMigrationHTTPTransport`, a 3-line wrapper, but not its 10 callers. The agent grepped them (8 native calls, 7.8k tokens). Fix: when a caller only wraps the call (small body that returns or forwards the result), also list its callers, or append "NewMigrationHTTPTransport wraps it: 10 callers (kopt refs #lg1)".
5. **Field and property reads are not references.** In wp-impact-legacy-is-circular, B was +19% measured. The pack answered "callers of Module.buildInfo: none found" for the `buildInfo.isCircular` reads, and the agent switched to grep and sed for the rest of the task (9 native calls, 4.8k tokens). Fix: index member reads and writes by name, at least as text-checked "possible" refs, as is already done for unresolved calls.
6. **Line numbers for the answer.** md-explain-compensation is B's costliest task (16 requests). After the reads, the agent grepped method declarations of a 2,000-line file 4 times (one of them refused) to fill the "path:line Name" list. `kopt outline <file>` returns this in one call, but the steering never points to it. Fix: add one steering line, "line numbers of many members of one file: `kopt outline <file>`".
7. **Measurement.** With one run per arm, single tasks vary by up to 2.5x between runs, and the pooled measured CI still crosses 0 at -12%. Two changes are needed:
   - run the planned 3 interleaved repetitions (prompts-r2.json) once fix 1 is in;
   - add exploration tasks, so a -10% session effect can be told apart from noise.

## Data and reproduction

- **Inputs:**
  - prompts: `abv2/prompts-r2-rep1.json` and `abv2/prompts-run-r2-rep1.json` (repetition 1 of `prompts-r2.json`);
  - wrapper logs: `bench/agentab/logs/r2`;
  - answers and usage: extracted from the workflow journal and the agent transcripts.
- **Classification of test-task calls:** stored under `diagnosis.testConfound` in the .json. It records the rules, the per-call labels and the bootstrap results.
- **Earlier run:** "Against the previous run" pools this run with `agent-ab-r1.json`, for the exploration tasks only (this run's test tasks are confounded).

## Method

Tables generated by `bench/agentab/analyze.mjs` from the wrapper logs (`bench/agentab/logs/r2`), the agents' answers and their
measured token usage. Tokens read = characters of tool output / 3 (wrapper count). One run per arm and task. Graders: **lenient** =
the orchestrator's (case-insensitive substring, a file may match by basename); **strict** = score.mjs (whole-word symbols, full
paths, test tasks graded on the ROOT CAUSE line). Cost measures:

- **cost12k** (the v0.1 formula, as in ab2-summary.json "cum"): sum over tool calls of (12,000-token fixed prefix + all tokens read so far). One call = one request; same prefix for both arms, so kopt's own prompt overhead is ignored.
- **costFull**: sum over model requests 0..n of (12,000 + the arm's prompt + tokens read so far). Arm B's prompt carries kopt's steering, server instructions and command descriptions (median 917 tokens vs 547 for A, chars/3).
- **measured**: input context the agents' model really processed, summed over its requests (input + cache read + cache creation tokens, from the agent transcripts; parallel tool calls share one request). Its fixed prefix is the agent harness's (about 34k tokens), which dilutes relative differences.
- **measured, re-based**: the same with the harness prefix (explore 33,889, run 33,925 tokens, from arm A's first request) replaced by 12,000 tokens on every request; arm B keeps its extra prompt. The closest proxy here to what Kiro would bill.

## Exploration tasks (15)

**Session cost, B vs A** (primary, measured context re-based to a 12k prefix): -11% [-28%, +5%], not significant; modeled cost12k: -16% [-35%, +4%]; tokens read: -17% [-32%, +1%].

| arm | found (lenient / strict) | symbol recall (lenient / strict) | tool calls (median) | model requests | kopt calls (tasks >1) | tokens read | of which kopt | test output | cost12k | costFull | measured | measured, re-based |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | 15/15 / 15/15 | 100% / 100% | 125 (7) | 109 | 0 (0) | 92,088 | 0 | 0 | 2,061,757 | 2,317,847 | 4,773,287 | 2,387,386 |
| B | 15/15 / 15/15 | 100% / 100% | 107 (6) | 98 | 69 (13) | 76,607 | 51,977 | 0 | 1,728,507 | 2,019,802 | 4,259,407 | 2,114,285 |

- both found (lenient): the same 15 tasks as "all tasks" (both arms answered every task correctly), so the pass-gated comparison is identical.
- both found (strict): the same 15 tasks as "all tasks" (both arms answered every task correctly), so the pass-gated comparison is identical.

Paired B vs A (relative = B/A - 1; 95% CI from 10,000 seeded bootstrap resamples of tasks):

| task set | metric | n | A total | B total | B/A total | 95% CI | mean per-task | 95% CI | median per-task | B lower / higher | verdict (total) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| all tasks | **session cost (primary): measured context re-based to a 12k prefix** | 15 | 2,387,386 | 2,114,285 | -11% | [-28%, +5%] | -10% | [-27%, +9%] | -20% | 10 / 5 | not significant |
| all tasks | modeled session cost, 12k prefix (v0.1 formula) | 15 | 2,061,757 | 1,728,507 | -16% | [-35%, +4%] | -14% | [-31%, +2%] | -13% | 9 / 6 | not significant |
| all tasks | tokens read (tool outputs) | 15 | 92,088 | 76,607 | -17% | [-32%, +1%] | -17% | [-36%, +7%] | -19% | 12 / 3 | not significant |
| all tasks | modeled session cost incl. first request + arm prompt | 15 | 2,317,847 | 2,019,802 | -13% | [-30%, +6%] | -10% | [-26%, +5%] | -6% | 9 / 6 | not significant |
| all tasks | measured agent input context (sum over model requests) | 15 | 4,773,287 | 4,259,407 | -11% | [-26%, +5%] | -10% | [-25%, +7%] | -18% | 10 / 5 | not significant |
| all tasks | tool calls | 15 | 125 | 107 | -14% | [-33%, +4%] | -11% | [-28%, +5%] | 0% | 7 / 4 | not significant |

Per task:

| task | arm | found (len/strict) | sym | calls | requests | kopt | read | kopt read | test out | raw test out | cost12k | costFull | measured, re-based | B/A read | B/A cost12k | B/A re-based |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| dj-explain-migration-optimizer | A | yes/yes | 100% | 7 | 6 | 0 | 5,687 | 0 | 0 | 0 | 109,880 | 126,288 | 115,975 |  |  |  |
| dj-explain-migration-optimizer | B | yes/yes | 100% | 7 | 8 | 6 | 7,149 | 6,866 | 0 | 0 | 120,280 | 139,640 | 170,678 | +26% | +9% | +47% |
| dj-usage-add-new-csrf-cookie | A | yes/yes | 100% | 6 | 6 | 0 | 1,758 | 0 | 0 | 0 | 78,358 | 94,089 | 104,482 |  |  |  |
| dj-usage-add-new-csrf-cookie | B | yes/yes | 100% | 3 | 4 | 3 | 829 | 829 | 0 | 0 | 37,521 | 53,133 | 65,873 | -53% | -52% | -37% |
| sf-explain-concurrency-limit | A | yes/yes | 100% | 5 | 6 | 0 | 5,727 | 0 | 0 | 0 | 79,646 | 94,952 | 122,039 |  |  |  |
| sf-explain-concurrency-limit | B | yes/yes | 100% | 4 | 5 | 4 | 4,086 | 4,086 | 0 | 0 | 60,322 | 76,927 | 97,790 | -29% | -24% | -20% |
| sf-usage-fail-early | A | yes/yes | 100% | 5 | 6 | 0 | 6,181 | 0 | 0 | 0 | 78,376 | 93,598 | 120,322 |  |  |  |
| sf-usage-fail-early | B | yes/yes | 100% | 6 | 5 | 6 | 2,801 | 2,801 | 0 | 0 | 82,636 | 100,978 | 92,403 | -55% | +5% | -23% |
| md-explain-compensation | A | yes/yes | 100% | 20 | 14 | 0 | 10,457 | 0 | 0 | 0 | 387,046 | 410,533 | 389,803 |  |  |  |
| md-explain-compensation | B | yes/yes | 100% | 15 | 16 | 7 | 8,435 | 5,727 | 0 | 0 | 267,187 | 293,859 | 403,206 | -19% | -31% | +3% |
| md-usage-cancel-transaction | A | yes/yes | 100% | 14 | 8 | 0 | 5,407 | 0 | 0 | 0 | 219,426 | 239,541 | 175,687 |  |  |  |
| md-usage-cancel-transaction | B | yes/yes | 100% | 4 | 5 | 2 | 1,995 | 1,100 | 0 | 0 | 51,934 | 68,484 | 87,114 | -63% | -76% | -50% |
| gt-explain-egress | A | yes/yes | 100% | 14 | 13 | 0 | 13,107 | 0 | 0 | 0 | 261,612 | 281,982 | 335,243 |  |  |  |
| gt-explain-egress | B | yes/yes | 100% | 15 | 10 | 15 | 11,621 | 11,621 | 0 | 0 | 294,509 | 321,341 | 269,234 | -11% | +13% | -20% |
| gt-usage-egress-transport | A | yes/yes | 100% | 10 | 6 | 0 | 3,772 | 0 | 0 | 0 | 141,408 | 159,227 | 116,334 |  |  |  |
| gt-usage-egress-transport | B | yes/yes | 100% | 10 | 9 | 2 | 8,131 | 332 | 0 | 0 | 151,287 | 173,176 | 202,801 | +116% | +7% | +74% |
| jf-explain-quick-connect | A | yes/yes | 100% | 9 | 6 | 0 | 8,274 | 0 | 0 | 0 | 160,436 | 177,906 | 136,729 |  |  |  |
| jf-explain-quick-connect | B | yes/yes | 100% | 8 | 5 | 8 | 4,966 | 4,966 | 0 | 0 | 124,751 | 145,004 | 100,974 | -40% | -22% | -26% |
| jf-usage-refresh-trickplay | A | yes/yes | 100% | 4 | 5 | 0 | 2,558 | 0 | 0 | 0 | 54,726 | 69,331 | 88,730 |  |  |  |
| jf-usage-refresh-trickplay | B | yes/yes | 100% | 4 | 5 | 2 | 1,428 | 430 | 0 | 0 | 51,046 | 67,501 | 86,325 | -44% | -7% | -3% |
| lv-locate-cache-flexible | A | yes/yes | 100% | 6 | 7 | 0 | 1,885 | 0 | 0 | 0 | 79,879 | 95,778 | 124,766 |  |  |  |
| lv-locate-cache-flexible | B | yes/yes | 100% | 2 | 3 | 2 | 1,647 | 1,647 | 0 | 0 | 27,135 | 41,916 | 51,069 | -13% | -66% | -59% |
| lv-usage-image-driver | A | yes/yes | 100% | 2 | 3 | 0 | 3,337 | 0 | 0 | 0 | 29,174 | 42,734 | 51,040 |  |  |  |
| lv-usage-image-driver | B | yes/yes | 100% | 2 | 3 | 1 | 1,298 | 102 | 0 | 0 | 25,400 | 40,067 | 48,100 | -61% | -13% | -6% |
| ex-impact-check-cycle | A | yes/yes | 100% | 8 | 8 | 0 | 6,889 | 0 | 0 | 0 | 130,066 | 146,800 | 172,783 |  |  |  |
| ex-impact-check-cycle | B | yes/yes | 100% | 12 | 8 | 7 | 6,581 | 3,401 | 0 | 0 | 188,948 | 212,583 | 179,553 | -4% | +45% | +4% |
| ms-explain-autobatch | A | yes/yes | 100% | 7 | 8 | 0 | 11,938 | 0 | 0 | 0 | 132,963 | 149,395 | 188,455 |  |  |  |
| ms-explain-autobatch | B | yes/yes | 100% | 5 | 4 | 3 | 9,972 | 7,247 | 0 | 0 | 94,069 | 111,613 | 86,451 | -16% | -29% | -54% |
| wp-impact-legacy-is-circular | A | yes/yes | 100% | 8 | 7 | 0 | 5,111 | 0 | 0 | 0 | 118,761 | 135,693 | 144,998 |  |  |  |
| wp-impact-legacy-is-circular | B | yes/yes | 100% | 10 | 8 | 1 | 5,668 | 822 | 0 | 0 | 151,482 | 173,580 | 172,714 | +11% | +28% | +19% |

kopt usage (arm B): 69 kopt calls in 15 tasks (4.6 per task; 13/15 tasks with more than one; first call was kopt in 15/15); by command: find 14, read 39, refs 15, outline 1; kopt errors: 0; governor blocks: 0. kopt output = 68% of B's tokens read; 38 native calls (24,630 tokens), 38 of them after a kopt call.

| task | kopt calls | kopt commands, in order | native calls after the first kopt call (tokens) |
|---|---|---|---|
| dj-explain-migration-optimizer | 6 | find > read > read > find > read > read | 1 (283) |
| dj-usage-add-new-csrf-cookie | 3 | refs > read > read | 0 (0) |
| sf-explain-concurrency-limit | 4 | find > read > read > read | 0 (0) |
| sf-usage-fail-early | 6 | refs > read > read > refs > find > read | 0 (0) |
| md-explain-compensation | 7 | find > read > read > read > refs > read > read | 8 (2,708) |
| md-usage-cancel-transaction | 2 | refs > refs | 2 (895) |
| gt-explain-egress | 15 | find > read > outline > refs > read > read > read > read > refs > refs > refs > read > read > read > read | 0 (0) |
| gt-usage-egress-transport | 2 | refs > read | 8 (7,799) |
| jf-explain-quick-connect | 8 | find > read > refs > read > read > read > read > find | 0 (0) |
| jf-usage-refresh-trickplay | 2 | refs > find | 2 (998) |
| lv-locate-cache-flexible | 2 | find > read | 0 (0) |
| lv-usage-image-driver | 1 | refs | 1 (1,196) |
| ex-impact-check-cycle | 7 | refs > read > find > read > read > find > read | 5 (3,180) |
| ms-explain-autobatch | 3 | find > read > read | 2 (2,725) |
| wp-impact-legacy-is-circular | 1 | find | 9 (4,846) |

## Test-run diagnosis tasks (6)

**Session cost, B vs A** (primary, measured context re-based to a 12k prefix): +260% [+148%, +407%], B higher (CI above 0); modeled cost12k: +195% [+96%, +346%]; tokens read: +25% [-23%, +110%].

| arm | found (lenient / strict) | symbol recall (lenient / strict) | tool calls (median) | model requests | kopt calls (tasks >1) | tokens read | of which kopt | test output | cost12k | costFull | measured | measured, re-based |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | 6/6 / 6/6 | 100% / 100% | 27 (5) | 31 | 0 (0) | 45,739 | 0 | 32,337 | 505,608 | 595,923 | 1,329,186 | 649,511 |
| B | 6/6 / 6/6 | 100% / 100% | 84 (12.5) | 87 | 41 (6) | 57,054 | 30,143 | 5,026 | 1,491,155 | 1,657,925 | 4,242,634 | 2,335,159 |

- both found (lenient): the same 6 tasks as "all tasks" (both arms answered every task correctly), so the pass-gated comparison is identical.
- both found (strict): the same 6 tasks as "all tasks" (both arms answered every task correctly), so the pass-gated comparison is identical.

Paired B vs A (relative = B/A - 1; 95% CI from 10,000 seeded bootstrap resamples of tasks):

| task set | metric | n | A total | B total | B/A total | 95% CI | mean per-task | 95% CI | median per-task | B lower / higher | verdict (total) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| all tasks | **session cost (primary): measured context re-based to a 12k prefix** | 6 | 649,511 | 2,335,159 | +260% | [+148%, +407%] | +277% | [+157%, +418%] | +268% | 0 / 6 | B higher (CI above 0) |
| all tasks | modeled session cost, 12k prefix (v0.1 formula) | 6 | 505,608 | 1,491,155 | +195% | [+96%, +346%] | +235% | [+103%, +393%] | +175% | 0 / 6 | B higher (CI above 0) |
| all tasks | tokens read (tool outputs) | 6 | 45,739 | 57,054 | +25% | [-23%, +110%] | +59% | [-9%, +135%] | +39% | 3 / 3 | not significant |
| all tasks | modeled session cost incl. first request + arm prompt | 6 | 595,923 | 1,657,925 | +178% | [+90%, +307%] | +205% | [+96%, +338%] | +162% | 0 / 6 | B higher (CI above 0) |
| all tasks | measured agent input context (sum over model requests) | 6 | 1,329,186 | 4,242,634 | +219% | [+129%, +332%] | +231% | [+137%, +337%] | +223% | 0 / 6 | B higher (CI above 0) |
| all tasks | tool calls | 6 | 27 | 84 | +211% | [+130%, +315%] | +224% | [+133%, +326%] | +210% | 0 / 6 | B higher (CI above 0) |

Per task:

| task | arm | found (len/strict) | sym | calls | requests | kopt | read | kopt read | test out | raw test out | cost12k | costFull | measured, re-based | B/A read | B/A cost12k | B/A re-based |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| rt1 | A | yes/yes | 100% | 4 | 5 | 0 | 4,983 | 0 | 2,581 | 0 | 63,801 | 78,576 | 101,144 |  |  |  |
| rt1 | B | yes/yes | 100% | 21 | 21 | 9 | 13,011 | 6,283 | 1,236 | 13,492 | 425,019 | 460,185 | 656,581 | +161% | +566% | +549% |
| rt2 | A | yes/yes | 100% | 5 | 6 | 0 | 11,235 | 0 | 8,716 | 0 | 111,714 | 127,044 | 133,210 |  |  |  |
| rt2 | B | yes/yes | 100% | 13 | 14 | 5 | 6,493 | 3,120 | 377 | 10,065 | 217,679 | 244,421 | 347,707 | -42% | +95% | +161% |
| rt3 | A | yes/yes | 100% | 5 | 6 | 0 | 10,762 | 0 | 9,447 | 0 | 104,021 | 119,351 | 130,091 |  |  |  |
| rt3 | B | yes/yes | 100% | 8 | 9 | 6 | 8,011 | 6,861 | 1,015 | 16,428 | 135,468 | 156,945 | 211,524 | -26% | +30% | +63% |
| rt4 | A | yes/yes | 100% | 5 | 5 | 0 | 4,932 | 0 | 2,192 | 0 | 77,432 | 92,762 | 101,289 |  |  |  |
| rt4 | B | yes/yes | 100% | 12 | 12 | 4 | 14,038 | 3,230 | 589 | 7,971 | 194,665 | 220,354 | 289,300 | +185% | +151% | +186% |
| rt5 | A | yes/yes | 100% | 3 | 4 | 0 | 3,905 | 0 | 2,092 | 0 | 44,211 | 58,431 | 74,598 |  |  |  |
| rt5 | B | yes/yes | 100% | 12 | 13 | 10 | 7,886 | 7,489 | 1,163 | 13,205 | 207,381 | 233,070 | 338,157 | +102% | +369% | +353% |
| rt6 | A | yes/yes | 100% | 5 | 5 | 0 | 9,922 | 0 | 7,309 | 0 | 104,429 | 119,759 | 109,179 |  |  |  |
| rt6 | B | yes/yes | 100% | 18 | 18 | 7 | 7,615 | 3,160 | 646 | 10,610 | 310,943 | 342,950 | 491,890 | -23% | +198% | +351% |

kopt usage (arm B): 41 kopt calls in 6 tasks (6.8 per task; 6/6 tasks with more than one; first call was kopt in 6/6); by command: run 10, find 7, read 14, expand 4, outline 2, refs 4; kopt errors: 0; governor blocks: 0. kopt output = 53% of B's tokens read; 43 native calls (26,911 tokens), 43 of them after a kopt call.

| task | kopt calls | kopt commands, in order | native calls after the first kopt call (tokens) |
|---|---|---|---|
| rt1 | 9 | run > find > read > expand > expand > outline > refs > run > run | 12 (6,728) |
| rt2 | 5 | run > find > read > refs > read | 8 (3,373) |
| rt3 | 6 | run > read > expand > expand > find > read | 2 (1,150) |
| rt4 | 4 | run > read > read > find | 8 (10,808) |
| rt5 | 10 | run > find > outline > read > run > read > find > read > refs > read | 2 (397) |
| rt6 | 7 | run > read > find > run > refs > read > read | 11 (4,455) |

## Against v0.1 (ab2, same 15 exploration tasks)

v0.1 numbers come from `ab2-summary.json` (same wrapper count, same cost12k formula, same lenient grader).

| run | A found | B found | A read | B read | B/A read | A cost12k | B cost12k | B/A cost12k | A calls | B calls | B kopt calls |
|---|---|---|---|---|---|---|---|---|---|---|---|
| v0.1 (ab2) | 14/15 | 14/15 | 82,808 | 70,399 | -15% | 1,618,653 | 1,571,248 | -3% | 101 | 105 | 11 |
| v0.2 (r2) | 15/15 | 15/15 | 92,088 | 76,607 | -17% | 2,061,757 | 1,728,507 | -16% | 125 | 107 | 69 |

| paired comparison (15 tasks) | B/A total | 95% CI | mean per-task | 95% CI |
|---|---|---|---|---|
| v0.1: B vs A, tokens read | -15% | [-21%, -10%] | -17% | [-25%, -10%] |
| v0.1: B vs A, cost12k | -3% | [-13%, +9%] | +3% | [-9%, +15%] |
| r2: B vs A, tokens read | -17% | [-32%, +1%] | -17% | [-36%, +7%] |
| r2: B vs A, cost12k | -16% | [-35%, +4%] | -14% | [-31%, +2%] |
| r2 B vs mean of both A runs, tokens read | -12% | [-30%, +8%] | -10% | [-33%, +19%] |
| noise floor: A(r2) vs A(v0.1), tokens read | +11% | [-2%, +24%] | +17% | [+2%, +30%] |
| noise floor: A(r2) vs A(v0.1), cost12k | +27% | [+1%, +57%] | +32% | [+9%, +56%] |
| B(r2) vs B(v0.1), tokens read | +9% | [-16%, +41%] | +28% | [-16%, +91%] |

## Against the previous run (`r1`, same tasks)

Paired over tasks (relative = later/earlier - 1 for drift, B/A - 1 otherwise; 95% CI from 10,000 seeded bootstrap resamples of tasks). Arm A is the same stock tooling in both runs, so its drift is the run-to-run noise. "Pooled" = per task, the mean of the two runs of each arm.

| tasks | metric | r1: B/A | r2: B/A | drift A (r2 vs r1) | drift B | r2 B vs mean of both A runs | pooled r1+r2: B/A |
|---|---|---|---|---|---|---|---|
| explore (15) | session cost: measured, re-based | -12% [-26%, +8%] | -11% [-28%, +5%] | +1% [-14%, +19%] | +2% [-23%, +36%] | -11% [-30%, +10%] | -12% [-23%, +3%] |
| explore (15) | modeled cost12k | -31% [-45%, -10%] | -16% [-35%, +4%] | -3% [-19%, +17%] | +18% [-11%, +46%] | -18% [-36%, 0%] | -24% [-37%, -8%] |
| explore (15) | tokens read | -25% [-35%, -14%] | -17% [-32%, +1%] | -1% [-11%, +12%] | +10% [-5%, +31%] | -17% [-32%, +1%] | -21% [-32%, -9%] |
| explore (15) | tool calls | -25% [-39%, -4%] | -14% [-33%, +4%] | -1% [-14%, +16%] | +13% [-13%, +40%] | -15% [-33%, +2%] | -20% [-33%, -4%] |

