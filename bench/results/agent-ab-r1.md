# Agent A/B run `r1`: paired analysis

Round 1 of the v0.2 agent A/B: 21 tasks (15 exploration tasks on 9 open-source repositories, 6 test-run diagnosis
tasks on copies of this repository with one injected bug each). One agent per arm and task, same model in both arms.
Every command went through the logging wrapper (the agent transcripts show no tool use outside it). kopt build:
commit 5ce628a. `src/` and `templates/` have not changed since then on improve/v0.2, so the blockers below still
apply.

## Verdict

- **No accuracy regression.** Both arms answered all 21 tasks correctly under both graders (lenient: the
  orchestrator's; strict: score.mjs, whole-word symbols, full paths, test tasks graded on the ROOT CAUSE line).
- **Exploration (15 tasks): kopt cut tokens read by 25%** (69,392 vs 92,706; 95% CI of the ratio of totals -35% to
  -14%; lower in 11/15 tasks). The modeled session cost (v0.1 formula, 12k prefix) is -31% [-45%, -10%], but the
  median task is +1%. Measured agent context is -10% [-24%, +8%], or -12% [-26%, +8%] once the agent harness's 34k
  prefix is replaced by a 12k one. Neither measured figure is significant.
  - **Long explorations save; short lookups cost more.**
    - 5 tasks where arm A needed 9 or more calls: -44% calls, -49% cost12k, -28% measured context re-based to 12k.
    - 6 tasks where arm A needed 5 calls or fewer: +12% calls, +11% cost12k, +16% measured context re-based to 12k.
- **Test-run diagnosis (6 tasks): kopt cut tokens read by 68%** (20,866 vs 65,324; [-80%, -45%]; lower in 6/6 tasks).
  - `kopt run` turned 54,585 tokens of raw test output into 2,964 (-95%). Arm A read 45,462 tokens of test output.
  - The session cost did not follow: cost12k -27% [-43%, +1%], measured context re-based to 12k -7% [-21%, +10%]
    (n = 6). Source reading was unchanged (A 19,862, B 17,902 tokens), arm B made more calls (32 vs 30), and 3 of 6
    arm-A agents already ran `vitest --reporter dot` on their own.
- **Against v0.1 (ab2):**
  - Tokens read, B vs A: -15% in v0.1, -25% now. cost12k, B vs A: -3% in v0.1, -31% now.
  - kopt calls: 11 in v0.1, all failed. 53 now, 0 errors, 3.5 per task.
  - Caveat: arm A drifted between the two runs (+12% tokens read, +32% cost12k), on the same tasks with the same
    tools. Arm B's own tokens read did not move (-1%). Against the mean of both A runs, arm B reads 21% less
    [-32%, -9%].
  - The run-to-run noise is about half the effect on tokens read and as large as the whole effect on cost12k. Treat
    the session-cost figures as indicative.
- **Round-1 targets:**
  - Exploration, at least 30% fewer tokens read: **not met** (-25%; the CI reaches -35%).
  - Exploration, more than one kopt call per task: **met** (3.5 per task; 13/15 tasks used more than one).
  - Test runs, at least 60% fewer tokens read: **met on totals** (-68%). The mean per task is -58%.
  - No correctness regression: **met**.

In short, kopt really reduces what enters the context, with no loss of accuracy. A reduction of the billed session
is shown only on long explorations. On short lookups kopt adds cost, and on test diagnosis the context saving does
not yet produce a significant session saving.

## What worked

- **No more whole-file reads.** Arm A ran 6 whole-file `cat -n` reads on exploration tasks, costing 13,060 tokens.
  Arm B ran none.
- **Arm B used kopt as intended.** It started with kopt in 15/15 exploration tasks, with 0 kopt errors and 0 governor
  blocks, and 69% of the tokens it read came from kopt.
- **A good pack ends a task early.** On lv-locate-cache-flexible, one pack plus one read answered the question in 2
  calls instead of 6 (-68% cost12k).
- **Fewer wandering sessions.** The longest arm-A sessions (md-explain: 17 calls, gt-explain: 17, md-usage: 16,
  ex-impact: 14) took 7, 11, 8 and 6 calls in arm B.

## What still blocks bigger savings

The cost is in requests, not tokens. Each request re-bills the fixed prefix plus everything read so far (about 15-17k
tokens per call in cost12k terms here). One avoidable request costs more than a dozen compact outputs save. The probes
below re-ran the logged commands on the r1 snapshot and indexes.

1. **kopt itself adds avoidable requests.**
   - **A read of a named symbol can return a card instead of the code.**
     - `kopt read "#aol"` (meilisearch `accumulate`, 300 lines) returned a 307-token card ending in "body ~4634 tok >
       maxTokens 3000; pass maxTokens 4700 to read it whole". The agent then called again and read 4,656 tokens.
     - `kopt read modules/egress/policy/policy.go` returned a 708-token skeleton. The agent re-read lines 1-252 with
       `--max-tokens 4000` (2,906 tokens).
     - Fix: when the agent names a symbol (#handle or Class.method), return its body in one call up to about 6k
       tokens. Return a whole file when it fits in about 4k.
   - **`--kinds function` excludes methods.**
     - `kopt find "reduce" --kinds function --path django/db/migrations/operations` returned 0 hits. `kopt find
       "AuthenticateDirect AuthenticateNewSessionInternal" --kinds function` also returned 0 hits.
     - With `--kinds method` they return 6 and 5 hits. The command description itself suggests `["class","function"]`.
     - Fix: make `function` include `method`. When the filter leaves nothing, return the unfiltered hits with a note.
   - **Namespace-qualified names miss.**
     - `kopt refs "Illuminate\Image\Image.resolveDriver"` answered "no symbol matches ... did you mean #9mi", which
       cost a second call. `Image.resolveDriver` resolves directly.
     - Fix: accept `\`, `::` and `.` qualifiers (PHP, C#, Java, Rust, Kotlin), and resolve a unique suggestion
       automatically.
2. **Agents re-check kopt with grep.** In all 6 "who calls X" tasks, arm B ran grep or sed after kopt, even when
   `kopt refs` was complete:
   - jellyfin: a 97-token refs output listed both callers, and 3 native calls (2,101 tokens) followed;
   - laravel: 62 tokens listed all 3 callers, and a 1,196-token grep followed;
   - medusa: 191 tokens listed every caller, and a `git grep` followed.

   There are two causes:
   - **refs gives the call line, not the caller's definition line.** The answers (and developers) want
     `path:line Name` of each caller, so agents grep for the definitions.
     Fix: print the definition line, e.g. `L417 in #9m6 Image.toBytes (def L413)`.
   - **A real miss.** The callers of `Policy.NewHTTPTransport` (pack and refs) leave out
     `services/gitproxy/server.go:63 newServer`, where the call is on a typed parameter (`p *policy.Policy`). Arm B
     found it by grep and wrote "kopt refs missed this caller". One miss like this teaches agents to always verify.
     Fix: resolve calls on typed parameters, fields and locals (Go first). Also print a completeness line from a
     cheap text cross-check (for example "text matches 6, resolved 5, unresolved: services/gitproxy/server.go:63"),
     so the agent has no reason to grep.
3. **Every task starts with a pack.** The steering says "New task: start with `kopt find --pack`", so even "who calls
   X" tasks open with a 500-1,500-token pack. `kopt refs X` answers them in 60-200 tokens. This explains part of the
   +11% on short tasks.
   Fix: add a steering line "who calls / uses X: `kopt refs X` first", and use a smaller pack for a
   single-identifier query.
4. **Fixed overhead per request.** Arm B's prompt (steering, server instructions, command descriptions) costs 956
   measured tokens more per request than arm A's, and 1,146 more on test tasks. Over arm B's 98 exploration
   requests that is about 94k tokens, about 20% of its gross measured saving (480k).
   Fix: trim the descriptions, which repeat the instructions, and move the "Output" block out of the always-on
   steering.
5. **Test diagnosis: locating the bug costs as much as before.** All of the test-task saving is test output.
   - Arm B's reading outside test output (17,902 tokens) is close to arm A's (19,862).
   - After `kopt run`, arm B ran a 1.3k-token `kopt find --pack` in 4 of 6 tasks to get from the failing tests to
     the source.
   - Fix: for each failing test, `kopt run` could list the source symbols that test calls (the index already knows
     the test function's callees), so the agent reads the right function directly.
6. **Measurement noise.** With one run per arm, arm A alone moved +12% (tokens read) and +32% (cost12k) between
   ab2 and r1. Round 2 needs at least 3 runs per arm and task (interleaved), and should report the measured context
   next to the models.

## Method

Tables generated by `bench/agentab/analyze.mjs` from the wrapper logs (`bench/agentab/logs/r1`), the agents' answers and their
measured token usage. Tokens read = characters of tool output / 3 (wrapper count). One run per arm and task. Graders: **lenient** =
the orchestrator's (case-insensitive substring, a file may match by basename); **strict** = score.mjs (whole-word symbols, full
paths, test tasks graded on the ROOT CAUSE line). Cost measures:

- **cost12k** (the v0.1 formula, as in ab2-summary.json "cum"): sum over tool calls of (12,000-token fixed prefix + all tokens read so far). One call = one request; same prefix for both arms, so kopt's own prompt overhead is ignored.
- **costFull**: sum over model requests 0..n of (12,000 + the arm's prompt + tokens read so far). Arm B's prompt carries kopt's steering, server instructions and command descriptions (median 1,341 tokens vs 544 for A, chars/3).
- **measured**: input context the agents' model really processed, summed over its requests (input + cache read + cache creation tokens, from the agent transcripts; parallel tool calls share one request). Its fixed prefix is the agent harness's (about 34k tokens), which dilutes relative differences.
- **measured, re-based**: the same with the harness prefix (explore 33,886, run 33,922 tokens, from arm A's first request) replaced by 12,000 tokens on every request; arm B keeps its extra prompt. The closest proxy here to what Kiro would bill.

## Exploration tasks (15)

| arm | found (lenient / strict) | symbol recall (lenient / strict) | tool calls (median) | model requests | kopt calls (tasks >1) | tokens read | of which kopt | test output | cost12k | costFull | measured | measured, re-based |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | 15/15 / 15/15 | 100% / 100% | 126 (7) | 107 | 0 (0) | 92,706 | 0 | 0 | 2,133,054 | 2,389,371 | 4,698,839 | 2,357,037 |
| B | 15/15 / 15/15 | 100% / 100% | 95 (6) | 98 | 53 (13) | 69,392 | 48,178 | 0 | 1,469,334 | 1,796,397 | 4,218,713 | 2,073,885 |

- both found (lenient): the same 15 tasks as "all tasks" (both arms answered every task correctly), so the pass-gated comparison is identical.
- both found (strict): the same 15 tasks as "all tasks" (both arms answered every task correctly), so the pass-gated comparison is identical.

Paired B vs A (relative = B/A - 1; 95% CI from 10,000 seeded bootstrap resamples of tasks):

| task set | metric | n | A total | B total | B/A total | 95% CI | mean per-task | 95% CI | median per-task | B lower / higher | verdict (total) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| all tasks | tokens read (tool outputs) | 15 | 92,706 | 69,392 | -25% | [-35%, -14%] | -20% | [-34%, -5%] | -21% | 11 / 4 | B lower (CI below 0) |
| all tasks | modeled session cost, 12k prefix (v0.1 formula) | 15 | 2,133,054 | 1,469,334 | -31% | [-45%, -10%] | -13% | [-31%, +3%] | +1% | 7 / 8 | B lower (CI below 0) |
| all tasks | modeled session cost incl. first request + arm prompt | 15 | 2,389,371 | 1,796,397 | -25% | [-39%, -4%] | -9% | [-26%, +7%] | +7% | 6 / 9 | B lower (CI below 0) |
| all tasks | measured agent input context (sum over model requests) | 15 | 4,698,839 | 4,218,713 | -10% | [-24%, +8%] | +0% | [-16%, +16%] | +2% | 7 / 8 | not significant |
| all tasks | measured context re-based to a 12k prefix | 15 | 2,357,037 | 2,073,885 | -12% | [-26%, +8%] | +1% | [-16%, +18%] | +6% | 7 / 8 | not significant |
| all tasks | tool calls | 15 | 126 | 95 | -25% | [-39%, -4%] | -9% | [-27%, +8%] | 0% | 5 / 5 | B lower (CI below 0) |

Per task:

| task | arm | found (len/strict) | sym | calls | requests | kopt | read | kopt read | test out | raw test out | cost12k | costFull | measured, re-based | B/A read | B/A cost12k | B/A re-based |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| dj-explain-migration-optimizer | A | yes/yes | 100% | 8 | 6 | 0 | 6,357 | 0 | 0 | 0 | 131,738 | 148,670 | 120,255 |  |  |  |
| dj-explain-migration-optimizer | B | yes/yes | 100% | 9 | 8 | 3 | 5,059 | 1,442 | 0 | 0 | 136,786 | 162,226 | 162,808 | -20% | +4% | +35% |
| dj-usage-add-new-csrf-cookie | A | yes/yes | 100% | 5 | 5 | 0 | 1,661 | 0 | 0 | 0 | 64,790 | 79,976 | 85,226 |  |  |  |
| dj-usage-add-new-csrf-cookie | B | yes/yes | 100% | 5 | 5 | 4 | 1,687 | 1,593 | 0 | 0 | 65,302 | 85,264 | 90,074 | +2% | +1% | +6% |
| sf-explain-concurrency-limit | A | yes/yes | 100% | 5 | 6 | 0 | 6,190 | 0 | 0 | 0 | 80,577 | 95,871 | 123,018 |  |  |  |
| sf-explain-concurrency-limit | B | yes/yes | 100% | 5 | 5 | 4 | 4,139 | 4,075 | 0 | 0 | 76,419 | 96,489 | 101,393 | -33% | -5% | -18% |
| sf-usage-fail-early | A | yes/yes | 100% | 4 | 4 | 0 | 4,279 | 0 | 0 | 0 | 57,573 | 72,243 | 73,408 |  |  |  |
| sf-usage-fail-early | B | yes/yes | 100% | 4 | 5 | 2 | 3,885 | 2,810 | 0 | 0 | 59,120 | 77,770 | 98,653 | -9% | +3% | +34% |
| md-explain-compensation | A | yes/yes | 100% | 17 | 11 | 0 | 9,868 | 0 | 0 | 0 | 300,102 | 321,912 | 277,669 |  |  |  |
| md-explain-compensation | B | yes/yes | 100% | 7 | 7 | 3 | 7,821 | 4,705 | 0 | 0 | 120,779 | 143,507 | 158,166 | -21% | -60% | -43% |
| md-usage-cancel-transaction | A | yes/yes | 100% | 16 | 13 | 0 | 7,075 | 0 | 0 | 0 | 268,018 | 289,164 | 297,787 |  |  |  |
| md-usage-cancel-transaction | B | yes/yes | 100% | 8 | 9 | 2 | 2,968 | 1,056 | 0 | 0 | 109,074 | 133,080 | 177,893 | -58% | -59% | -40% |
| gt-explain-egress | A | yes/yes | 100% | 17 | 13 | 0 | 16,227 | 0 | 0 | 0 | 370,938 | 392,928 | 370,729 |  |  |  |
| gt-explain-egress | B | yes/yes | 100% | 11 | 11 | 8 | 10,923 | 9,333 | 0 | 0 | 205,485 | 233,697 | 292,199 | -33% | -45% | -21% |
| gt-usage-egress-transport | A | yes/yes | 100% | 5 | 5 | 0 | 2,783 | 0 | 0 | 0 | 66,892 | 82,054 | 89,506 |  |  |  |
| gt-usage-egress-transport | B | yes/yes | 100% | 6 | 6 | 1 | 3,000 | 699 | 0 | 0 | 83,468 | 104,729 | 118,088 | +8% | +25% | +32% |
| jf-explain-quick-connect | A | yes/yes | 100% | 7 | 7 | 0 | 5,992 | 0 | 0 | 0 | 113,968 | 130,320 | 143,795 |  |  |  |
| jf-explain-quick-connect | B | yes/yes | 100% | 8 | 6 | 7 | 4,435 | 4,189 | 0 | 0 | 123,358 | 147,427 | 125,984 | -26% | +8% | -12% |
| jf-usage-refresh-trickplay | A | yes/yes | 100% | 3 | 4 | 0 | 1,899 | 0 | 0 | 0 | 39,764 | 53,840 | 67,336 |  |  |  |
| jf-usage-refresh-trickplay | B | yes/yes | 100% | 4 | 5 | 1 | 2,198 | 97 | 0 | 0 | 52,556 | 71,131 | 90,692 | +16% | +32% | +35% |
| lv-locate-cache-flexible | A | yes/yes | 100% | 6 | 6 | 0 | 3,821 | 0 | 0 | 0 | 84,582 | 100,467 | 110,318 |  |  |  |
| lv-locate-cache-flexible | B | yes/yes | 100% | 2 | 3 | 2 | 1,638 | 1,638 | 0 | 0 | 27,117 | 43,170 | 52,303 | -57% | -68% | -53% |
| lv-usage-image-driver | A | yes/yes | 100% | 2 | 3 | 0 | 3,337 | 0 | 0 | 0 | 29,174 | 42,725 | 50,959 |  |  |  |
| lv-usage-image-driver | B | yes/yes | 100% | 3 | 4 | 2 | 1,321 | 125 | 0 | 0 | 37,509 | 54,761 | 67,227 | -60% | +29% | +32% |
| ex-impact-check-cycle | A | yes/yes | 100% | 14 | 11 | 0 | 7,142 | 0 | 0 | 0 | 233,606 | 253,451 | 251,375 |  |  |  |
| ex-impact-check-cycle | B | yes/yes | 100% | 6 | 7 | 2 | 4,494 | 2,282 | 0 | 0 | 89,914 | 111,147 | 144,762 | -37% | -62% | -42% |
| ms-explain-autobatch | A | yes/yes | 100% | 8 | 7 | 0 | 12,145 | 0 | 0 | 0 | 159,339 | 176,307 | 175,384 |  |  |  |
| ms-explain-autobatch | B | yes/yes | 100% | 8 | 9 | 7 | 10,023 | 9,993 | 0 | 0 | 144,196 | 168,328 | 215,574 | -17% | -10% | +23% |
| wp-impact-legacy-is-circular | A | yes/yes | 100% | 9 | 6 | 0 | 3,930 | 0 | 0 | 0 | 131,993 | 149,443 | 120,272 |  |  |  |
| wp-impact-legacy-is-circular | B | yes/yes | 100% | 9 | 8 | 5 | 5,801 | 4,141 | 0 | 0 | 138,251 | 163,671 | 178,069 | +48% | +5% | +48% |

kopt usage (arm B): 53 kopt calls in 15 tasks (3.5 per task; 13/15 tasks with more than one; first call was kopt in 15/15); by command: find 14, read 30, refs 8, outline 1; kopt errors: 0; governor blocks: 0. kopt output = 69% of B's tokens read; 42 native calls (21,214 tokens), 42 of them after a kopt call.

| task | kopt calls | kopt commands, in order | native calls after the first kopt call (tokens) |
|---|---|---|---|
| dj-explain-migration-optimizer | 3 | find > read > find | 6 (3,617) |
| dj-usage-add-new-csrf-cookie | 4 | find > read > read > refs | 1 (94) |
| sf-explain-concurrency-limit | 4 | find > read > read > read | 1 (64) |
| sf-usage-fail-early | 2 | find > read | 2 (1,075) |
| md-explain-compensation | 3 | find > read > read | 4 (3,116) |
| md-usage-cancel-transaction | 2 | refs > refs | 6 (1,912) |
| gt-explain-egress | 8 | find > read > read > outline > read > read > read > read | 3 (1,590) |
| gt-usage-egress-transport | 1 | find | 5 (2,301) |
| jf-explain-quick-connect | 7 | find > read > refs > read > read > find > read | 1 (246) |
| jf-usage-refresh-trickplay | 1 | refs | 3 (2,101) |
| lv-locate-cache-flexible | 2 | find > read | 0 (0) |
| lv-usage-image-driver | 2 | refs > refs | 1 (1,196) |
| ex-impact-check-cycle | 2 | find > read | 4 (2,212) |
| ms-explain-autobatch | 7 | find > read > read > read > refs > read > read | 1 (30) |
| wp-impact-legacy-is-circular | 5 | find > read > read > read > read | 4 (1,660) |

## Test-run diagnosis tasks (6)

| arm | found (lenient / strict) | symbol recall (lenient / strict) | tool calls (median) | model requests | kopt calls (tasks >1) | tokens read | of which kopt | test output | cost12k | costFull | measured | measured, re-based |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | 6/6 / 6/6 | 100% / 100% | 30 (5) | 35 | 0 (0) | 65,324 | 0 | 45,462 | 615,724 | 707,596 | 1,534,468 | 767,198 |
| B | 6/6 / 6/6 | 100% / 100% | 32 (5.5) | 36 | 24 (6) | 20,866 | 19,252 | 2,964 | 452,216 | 581,482 | 1,503,697 | 714,505 |

- both found (lenient): the same 6 tasks as "all tasks" (both arms answered every task correctly), so the pass-gated comparison is identical.
- both found (strict): the same 6 tasks as "all tasks" (both arms answered every task correctly), so the pass-gated comparison is identical.

Paired B vs A (relative = B/A - 1; 95% CI from 10,000 seeded bootstrap resamples of tasks):

| task set | metric | n | A total | B total | B/A total | 95% CI | mean per-task | 95% CI | median per-task | B lower / higher | verdict (total) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| all tasks | tokens read (tool outputs) | 6 | 65,324 | 20,866 | -68% | [-80%, -45%] | -58% | [-72%, -44%] | -55% | 6 / 0 | B lower (CI below 0) |
| all tasks | modeled session cost, 12k prefix (v0.1 formula) | 6 | 615,724 | 452,216 | -27% | [-43%, +1%] | -18% | [-38%, +3%] | -12% | 4 / 2 | not significant |
| all tasks | modeled session cost incl. first request + arm prompt | 6 | 707,596 | 581,482 | -18% | [-35%, +8%] | -10% | [-30%, +9%] | -4% | 3 / 3 | not significant |
| all tasks | measured agent input context (sum over model requests) | 6 | 1,534,468 | 1,503,697 | -2% | [-14%, +13%] | +1% | [-13%, +16%] | +4% | 3 / 3 | not significant |
| all tasks | measured context re-based to a 12k prefix | 6 | 767,198 | 714,505 | -7% | [-21%, +10%] | -3% | [-18%, +13%] | +0% | 3 / 3 | not significant |
| all tasks | tool calls | 6 | 30 | 32 | +7% | [-6%, +19%] | +8% | [-6%, +21%] | +10% | 1 / 3 | not significant |

Per task:

| task | arm | found (len/strict) | sym | calls | requests | kopt | read | kopt read | test out | raw test out | cost12k | costFull | measured, re-based | B/A read | B/A cost12k | B/A re-based |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| rt1 | A | yes/yes | 100% | 4 | 5 | 0 | 8,257 | 0 | 5,925 | 0 | 77,011 | 91,771 | 104,767 |  |  |  |
| rt1 | B | yes/yes | 100% | 5 | 6 | 4 | 4,375 | 3,709 | 729 | 6,854 | 73,890 | 94,932 | 121,569 | -47% | -4% | +16% |
| rt2 | A | yes/yes | 100% | 6 | 7 | 0 | 7,699 | 0 | 1,511 | 0 | 104,731 | 120,595 | 161,205 |  |  |  |
| rt2 | B | yes/yes | 100% | 6 | 6 | 4 | 3,406 | 2,910 | 169 | 8,596 | 84,850 | 107,399 | 117,841 | -56% | -19% | -27% |
| rt3 | A | yes/yes | 100% | 6 | 7 | 0 | 26,803 | 0 | 25,514 | 0 | 180,006 | 195,870 | 167,282 |  |  |  |
| rt3 | B | yes/yes | 100% | 6 | 7 | 4 | 3,567 | 3,423 | 873 | 15,351 | 84,656 | 107,205 | 140,470 | -87% | -53% | -16% |
| rt4 | A | yes/yes | 100% | 4 | 4 | 0 | 5,396 | 0 | 1,758 | 0 | 61,602 | 76,362 | 78,122 |  |  |  |
| rt4 | B | yes/yes | 100% | 5 | 5 | 4 | 2,465 | 2,442 | 379 | 7,602 | 67,366 | 88,408 | 95,534 | -54% | +9% | +22% |
| rt5 | A | yes/yes | 100% | 5 | 6 | 0 | 12,063 | 0 | 9,243 | 0 | 114,851 | 130,163 | 134,447 |  |  |  |
| rt5 | B | yes/yes | 100% | 4 | 5 | 4 | 3,484 | 3,484 | 650 | 9,941 | 56,324 | 75,859 | 97,705 | -71% | -51% | -27% |
| rt6 | A | yes/yes | 100% | 5 | 6 | 0 | 5,106 | 0 | 1,511 | 0 | 77,523 | 92,835 | 121,375 |  |  |  |
| rt6 | B | yes/yes | 100% | 6 | 7 | 4 | 3,569 | 3,284 | 164 | 6,241 | 85,130 | 107,679 | 141,386 | -30% | +10% | +16% |

kopt usage (arm B): 24 kopt calls in 6 tasks (4.0 per task; 6/6 tasks with more than one; first call was kopt in 6/6); by command: run 6, find 5, read 10, expand 2, outline 1; kopt errors: 0; governor blocks: 0. kopt output = 92% of B's tokens read; 8 native calls (1,614 tokens), 8 of them after a kopt call.

| task | kopt calls | kopt commands, in order | native calls after the first kopt call (tokens) |
|---|---|---|---|
| rt1 | 4 | run > find > read > read | 1 (666) |
| rt2 | 4 | run > read > find > read | 2 (496) |
| rt3 | 4 | run > read > expand > expand | 2 (144) |
| rt4 | 4 | run > read > find > read | 1 (23) |
| rt5 | 4 | run > find > outline > read | 0 (0) |
| rt6 | 4 | run > read > find > read | 2 (285) |

## Against v0.1 (ab2, same 15 exploration tasks)

v0.1 numbers come from `ab2-summary.json` (same wrapper count, same cost12k formula, same lenient grader).

| run | A found | B found | A read | B read | B/A read | A cost12k | B cost12k | B/A cost12k | A calls | B calls | B kopt calls |
|---|---|---|---|---|---|---|---|---|---|---|---|
| v0.1 (ab2) | 14/15 | 14/15 | 82,808 | 70,399 | -15% | 1,618,653 | 1,571,248 | -3% | 101 | 105 | 11 |
| v0.2 (r1) | 15/15 | 15/15 | 92,706 | 69,392 | -25% | 2,133,054 | 1,469,334 | -31% | 126 | 95 | 53 |

| paired comparison (15 tasks) | B/A total | 95% CI | mean per-task | 95% CI |
|---|---|---|---|---|
| v0.1: B vs A, tokens read | -15% | [-21%, -10%] | -17% | [-25%, -10%] |
| v0.1: B vs A, cost12k | -3% | [-13%, +9%] | +3% | [-9%, +15%] |
| r1: B vs A, tokens read | -25% | [-35%, -14%] | -20% | [-34%, -5%] |
| r1: B vs A, cost12k | -31% | [-45%, -10%] | -13% | [-31%, +3%] |
| r1 B vs mean of both A runs, tokens read | -21% | [-32%, -9%] | -17% | [-31%, -2%] |
| noise floor: A(r1) vs A(v0.1), tokens read | +12% | [0%, +24%] | +17% | [-1%, +44%] |
| noise floor: A(r1) vs A(v0.1), cost12k | +32% | [+3%, +59%] | +28% | [+4%, +55%] |
| B(r1) vs B(v0.1), tokens read | -1% | [-17%, +17%] | +11% | [-11%, +38%] |

