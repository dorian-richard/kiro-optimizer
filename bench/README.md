# kopt benchmarks

This folder measures whether kopt really reduces what Kiro bills. The results, with charts, are in
[docs/BENCHMARKS.md](../docs/BENCHMARKS.md) and [docs/benchmarks.html](../docs/benchmarks.html) (published at
<https://dorian-richard.github.io/kiro-optimizer/benchmarks.html>), both generated from
`bench/results` by `npm run bench:page` (`scripts/build-benchmarks-page.mjs`). There are four
levels:

| level | tool | what it measures | cost | status |
|---|---|---|---|---|
| **Offline** (proxy) | `kopt bench` | tokens returned to the model for ONE exploration step, and recall of verified gold items | free, a few seconds | working: 11 languages, 138 tasks + 22 held-out |
| **Compression** | `bench/compress/run.mjs` | what `kopt_run`'s filters return for the committed test, build and git outputs | free, under a second | working: 50 fixtures |
| **Agent A/B** | `bench/agentab` | tokens that really entered each agent's context, calls, a modeled session cost and graded answers, real agents on 21 tasks | agent runs | final v0.2 run committed (`results/agent-ab-final.md`): exploration -23% [-38%, -8%], test diagnosis +16% [-31%, +67%] |
| **Online** (A/B) | `kopt bench ab` | real Kiro credits per task (headless kiro-cli on your own repository), with graded answers | Kiro credits | preflight verified live against kiro-cli 2.28; its one headless request was refused by Kiro (account suspended by anti-abuse, 0 credits); everything else tested with a kiro-cli simulator; no credit measured yet |

**Communication rule.** A saving is only claimed if the online A/B shows it: the 95% CI of the mean credit
difference lies entirely below 0, on the tasks solved by both arms, and the success rate is not lower.
The offline benchmark is a diagnostic tool and a regression guard. It is not enough to claim a saving.

## Why such a strict protocol

Competing tools have published figures that do not hold up:

- **KiroGraph** compares its answer with an *assumed* counterfactual: the whole codebase divided by 4, or 1,500
  tokens per file "that would have been read". A failed query counts as a 100% saving, and negative savings are not
  recorded.
- **CodeGraph** runs a real A/B, but on 7 "how does X work" questions about famous repositories, without checking
  the answers. Its tokens are mostly cache reads. By its own measurement, it leaves 82% more resident context.
- **SDL-MCP** claims at least 50% savings in an offline simulation. Its own live runs show −170% to −516% on solved
  tasks. An offline proxy can therefore point in the opposite direction from reality.

Our rules follow from this:

1. The baseline is **measured**, never assumed.
2. The baseline is **strong**, even generous: it emulates a competent agent.
3. The gold is verified by reading the code, then re-verified mechanically.
4. Failures count: we report tokens per found task, failures included.
5. Comparisons are *pass-gated*: only tasks solved by both strategies count.
6. Tasks are pre-registered: they are committed before any kopt measurement.
7. Raw outputs are published (`--raw`).

## Offline benchmark (`kopt bench`)

### Strategies

Every strategy receives the same input text. By default, it is the task's `search` field (see below).

| strategy | emulates | calls |
|---|---|---|
| `native-naive` | Kiro's `grep_search`, then `read_file` of the 3 most-hit files (by number of visible matches), whole file capped at 2,000 lines (Kiro's default read cap) | 1 + ≤3 |
| `native-ranged` | the same grep, then a read of ±60 lines around the 4 best matches, overlapping windows merged: a disciplined agent that uses offset/limit | 1 + ≤4 |
| `kopt-pack` | one `kopt_find` call with mode=pack, default budget (`budgets.pack`) | 1 |
| `kopt-hits+read` | `kopt_find` (hits), then `kopt_read` of the first 2 results, in the same session (shared dedup ledger) | 3 |

The `grep_search` emulation deliberately favors the native strategies, so the measured savings are conservative:

- Kiro's caps: 100 matches and about 10,000 characters. Lines are cut at 250 characters.
- **Pattern choice.** The input's keywords (whole identifiers, words outside the English/French stop-word lists)
  are sorted from most to least selective. They are added as long as the total stays under 100 matches. The emulated
  agent therefore searches for `getImportedBy`, not `ConfigurationClass|getImportedBy`.
- **Display order.** Files containing the most distinct keywords come first, then non-test files, then the files
  with the most matches. A real agent sees ripgrep's traversal order instead, and often has to run 2 to 4 more greps.
- Reads return raw content: no line numbers, no explanatory text.
- Search uses `git grep -I -i -E` (honors `.gitignore`), or `rg` when the repository is not a git repository.

### Metrics

- **tokens** = `estimateTokens` from `src/core/tokens.ts` (3.0 characters per token by default, adjustable with
  `--chars-per-token`), summed over all calls. The raw character count is reported too.
- **tool calls**.
- **file recall**: the full gold path appears in the output.
- **symbol recall**: the gold simple name appears as a whole identifier, case-sensitive.
- **definition recall**: stricter. The gold definition line is shown, meaning its sequence of identifiers up to the
  name (`public void refresh`, `def rotate_token`) appears on one output line. Annotations and decorators are ignored.
- **found**: all gold files AND all gold names are present.
- **Aggregates**: median, mean and p90 of tokens, mean recalls, found rate, **tokens per found task** (total tokens,
  failures included, divided by the number of found tasks), and a breakdown by task type.
- **Pass-gated pairs**: median ratio and geometric ratio (b/a) of tokens, computed only on the tasks found by both
  strategies. The report also gives the number of tasks found by only one of the two.

### Gold tasks

The corpus is `bench/langs.json` (one repository per language) and `bench/tasks/<repo>.json`; the held-out tasks are
in `bench/tasks-heldout/`.

| repository | pinned version | commit | tasks |
|---|---|---|---|
| spring-framework (Java) | `v7.0.9` | `82a6b40b9366` | 15: 4 locate, 4 explain, 4 usage, 3 impact |
| django (Python) | `6.1.2` | `2212534bae39` | 15: 4 locate, 4 explain, 4 usage, 3 impact |
| medusa (TypeScript) | `v2.21.2` | `020565398e43` | 12 |
| webpack (JavaScript) | `v5.111.1` | `5a106753839f` | 12 |
| jellyfin (C#) | `v10.11.11` | `1fbd8739292c` | 12 |
| gitea (Go) | `v28.1.0` | `4ebd5e319b6a` | 12 |
| exposed (Kotlin) | `1.5.0` | `84361204b663` | 12 |
| meilisearch (Rust) | `v1.54.3` | `7ebd97e38c36` | 12 |
| laravel (PHP) | `v13.35.0` | `a413a9da9488` | 12 |
| discourse (Ruby) | `v2026.9.0` | `343b20f97ef5` | 12 |
| playframework (Scala) | `3.0.12` | `316f494b2d12` | 12 |

The 12-task repositories have 4 locate, 3 explain, 3 usage and 2 impact tasks; 22 held-out tasks add two per
repository.

- Prompts are phrased the way a developer would ask. Some contain exact identifiers, others are pure natural
  language.
- `search` holds the search phrase an agent would derive from the question. It contains no identifier the developer
  did not give. Every strategy receives this same text, and therefore the same information. `--input question`
  measures the case where the raw question is passed instead.
- The gold only covers production code (tests excluded). Every file and every symbol (with its definition line) was
  checked by reading the code at the pinned commit. The `verifiedBy` field describes what was read.
  `kopt bench <repo> --verify` re-checks everything mechanically: files exist, the name is on the definition line,
  and the symbol's file is listed in `gold.files`.
- **Against model memory**: the Spring tasks mostly target 7.0 APIs (`core.retry`, `resilience` with `@Retryable`
  and `@ConcurrencyLimit`, API versioning), which postdate much of the training data. The Django tasks target poorly
  documented internals (migration optimizer, DB cache culling, test shuffler). The real memory test is arm M of the
  online A/B (see below).

### Running it

```bash
# checkouts (read-only, gitignored; their code is never executed)
git clone --depth 1 --branch v7.0.9 https://github.com/spring-projects/spring-framework.git bench/repos/spring-framework
git clone --depth 1 --branch 6.1.2  https://github.com/django/django.git bench/repos/django

kopt bench --all --verify                       # re-checks the gold (exit 1 if an item moved)
kopt bench --all                                # every strategy, every repository (or: npm run bench -- --all)
kopt bench django --strategies native-ranged,kopt-pack --raw
kopt bench spring-framework --input question    # raw question instead of the search phrase -> spring-framework-question.md
kopt bench django --tasks dj-usage-same-domain,dj-locate-db-cache-cull
```

Results go to `bench/results/<label>.md` and `<label>.json`. With `--raw`, every full output goes to
`<label>.raw.json` (gitignored).

The kopt index is built on the first run in `bench/repos/.kopt-<repo>/index.db`, never inside the checkout. To
rebuild it: `--rebuild-index`. If the `retrieval` or `indexer` modules are missing, the kopt strategies are marked
"skipped" with the exact reason. The native strategies still run.

Performance: the native strategies on the 30 tasks of both repositories (11,362 and 7,071 files tracked by git) take
about 11 s. Each emulated grep is a single `git grep -o` pass, whose result is reused by both native strategies.

### Results: v0.2 against v0.1 (2026-10-09, 11 languages, 138 tasks)

`kopt bench all` on the corpus of `bench/langs.json` (`bench/results/summary.md`; indexes rebuilt from scratch,
`input = search`). Native strategies and competitors do not depend on the kopt build; v0.1 is the summary committed in
`08d8184`.

| language | repo | tasks | kopt-pack found, v0.1 -> v0.2 | kopt-pack median tok, v0.1 -> v0.2 | kopt-pack tok / found task, v0.1 -> v0.2 | native-ranged found (median tok) | codegraph found |
|---|---|---|---|---|---|---|---|
| java | spring-framework | 15 | 5 -> **11** | 807 -> 1,314 | 2,538 -> 1,766 | 8 (7,378) | 8 |
| python | django | 15 | 8 -> **13** | 627 -> 1,203 | 1,143 -> 1,181 | 8 (6,737) | 8 |
| typescript | medusa | 12 | 3 -> **9** | 857 -> 1,318 | 3,745 -> 1,680 | 3 (6,994) | 7 |
| javascript | webpack | 12 | 6 -> **10** | 693 -> 1,100 | 1,391 -> 1,298 | 5 (5,649) | 5 |
| c_sharp | jellyfin | 12 | 1 -> **10** | 929 -> 1,283 | 11,060 -> 1,473 | 5 (6,578) | 8 |
| go | gitea | 12 | 2 -> **9** | 537 -> 1,269 | 4,979 -> 1,508 | 3 (6,266) | 6 |
| kotlin | exposed | 12 | 3 -> **8** | 658 -> 1,300 | 3,888 -> 1,728 | 4 (9,659) | 9 |
| rust | meilisearch | 12 | 1 -> **7** | 983 -> 1,314 | 11,211 -> 2,206 | 3 (6,194) | 5 |
| php | laravel | 12 | 7 -> **9** | 881 -> 1,323 | 1,565 -> 1,622 | 4 (4,786) | 5 |
| ruby | discourse | 12 | 4 -> **11** | 860 -> 1,271 | 2,483 -> 1,277 | 6 (5,988) | 8 |
| scala | playframework | 12 | 3 -> **8** | 909 -> 1,330 | 3,619 -> 1,997 | 5 (7,631) | 10 |
| **all** | | **138** | **43 (31%) -> 105 (76%)** | **747 -> 1,289** | **2,722 -> 1,572** | **54 (39%), 6,675** | **79 (57%)** |

Mean recall over the 138 tasks (v0.1 -> v0.2): symbol 73% -> 91%, file 70% -> 91%, definition line 46% -> 50%
(native-ranged: 61%, 76%, 48%). With the raw question instead of the derived search phrase (`--input question`):
kopt-pack 90/138 (65%) at 1,313 median tokens, native-ranged 30/138 (22%) at 7,474. CodeGraph finds 56/102 on the
8 repositories it had in v0.1, as before, and 79/138 on all 11.

An honest reading:

- On one exploration step, kopt-pack now finds the gold more often than every other strategy, with about 5 times fewer
  tokens than the disciplined native baseline (median 1,289 vs 6,675) and 20 times fewer tokens per found task.
- The pack grew (747 -> 1,289 median tokens): more bodies, callers and callees per answer. That is the price of the
  recall gain, and it is paid once per question, not per turn of re-reading.
- **These tasks are not held out.** The v0.2 retrieval work was driven by the failure analysis of this same corpus
  (`bench/results/failures.md`), so the in-corpus gain is optimistic. The raw-question run is less tuned (no
  keyword derivation), and the agent A/B below uses real agent behaviour. The held-out tasks of round 2 (below) are
  the unseen test.
- The 33 remaining misses: 10 need a second step (`kopt_refs` or a read), 9 are shown but over budget or without
  their path, 6 are ranked out of the pack, 5 are unresolved references, 3 are extraction gaps.
- Index build (Apple silicon): 1.5 s (jellyfin) to 11.1 s (spring-framework, 9,552 files, 139k
  symbols).

### Round 2: held-out tasks, and the corpus again (2026-10-09)

The round-2 build (refs with caller definition lines and a text check, typed Go receivers, whole reads of named
functions, kinds and namespace fixes, joined-word name candidates) on the same corpus: kopt-pack finds **106/138
(77%)** at a median of 1,292 tokens (105/138 and 1,289 before), references resolved on gitea 51% -> 57% (in-repo names
65% -> 72%). The one new find is the gitea caller kopt missed in the agent A/B (`newServer`, a call on a
`*policy.Policy` parameter). Re-run on the final round-2 build with every index rebuilt from scratch: the same
found counts in every repository (106/138), medians within 2 tokens (1,293), so the figures do not depend on an
index left over from an earlier build.

**Held-out tasks** (`bench/tasks-heldout/`, 22 tasks, two per repository, written and committed before any kopt
measurement on them, not derived from `failures.md`; results in `bench/results/heldout/`):

| input | strategy | found | median tokens | tokens per found task | symbol / file / definition recall |
|---|---|---|---|---|---|
| search phrase | **kopt-pack** | **19/22 (86%)** | **1,303** | **1,389** | 89% / 91% / 54% |
| search phrase | kopt-hits+read | 13/22 (59%) | 886 | 2,093 | 71% / 78% / 55% |
| search phrase | native-ranged | 5/22 (23%) | 6,420 | 56,232 | 36% / 61% / 24% |
| search phrase | native-naive | 8/22 (36%) | 22,960 | 115,737 | 47% / 61% / 33% |
| raw question | **kopt-pack** | **15/22 (68%)** | **1,332** | **1,803** | 77% / 80% / 53% |
| raw question | native-ranged | 4/22 (18%) | 7,836 | 74,252 | 27% / 50% / 17% |

Read with care: 22 tasks are few, most have their gold in one or two files, and the same team wrote the tasks and
the tool. They are not tuned on, which is the point: the corpus' 77% is not an artefact of tuning (86% here), and the
raw-question gap (15 vs 19) is where kopt still depends on the agent's choice of words.

**Scale** (`bench/scale/run.mjs`, results in `bench/results/scale-elasticsearch.md`): `kopt mcp` over stdio, as Kiro
starts it, on Elasticsearch (50,285 tracked files, 33,090 indexed, 573k symbols, 3.8M references), Apple silicon:

| step | result |
|---|---|
| first build: search answers / references resolved | 31.5 s / 82.3 s (calls made meanwhile get the progress at once) |
| server peak memory, worker thread included; index on disk | 2.0 GB; 1.07 GB |
| `kopt index` typed during that build | waits for the server's pass, then catches up (exit 0); it failed with "database is locked" before this round |
| query latency on the built index (11 calls) | median 54 ms, max 496 ms |
| 20 files written by the agent (hook dirty list) | indexed by the next call (593 ms), all 20 found |
| 200 files changed by a pull, `kopt index --refresh` / nothing changed | 4.4 s / 0.9 s |

### Round 3: member reads and writes, wrappers, 4 listed tools (2026-10-10)

The round-3 build indexes member reads and writes (`obj.field`, `this.x = v`, initializer keys) as references,
lists the callers of thin wrappers and says whether a caller list is complete. It also cuts the fixed prompt (tool
specs as Kiro sends them plus the always-on steering) from 852 to 348 tokens (chars / 3) by listing 4 tools instead
of 6. The corpus was re-run with every index rebuilt from scratch.

| repo | kopt-pack found | median tokens | references in the index |
|---|---|---|---|
| spring-framework | 11 -> 11 /15 | 1,328 -> 1,327 | 683k -> 762k |
| django | 13 -> 13 /15 | 1,203 -> 1,206 | 164k -> 232k |
| medusa | 9 -> 9 /12 | 1,296 -> 1,300 | 205k -> 253k |
| webpack | **10 -> 11** /12 | 1,037 -> 1,110 | 93k -> 129k |
| jellyfin | 10 -> 10 /12 | 1,297 -> 1,299 | 55k -> 87k |
| gitea | **10 -> 11** /12 | 1,121 -> 1,132 | 143k -> 226k |
| exposed | 8 -> 8 /12 | 1,299 -> 1,302 | 65k -> 78k |
| meilisearch | 7 -> 7 /12 | 1,311 -> 1,325 | 79k -> 99k |
| laravel | 9 -> 9 /12 | 1,294 -> 1,298 | 173k -> 193k |
| discourse | 11 -> 11 /12 | 1,289 -> 1,310 | 470k -> 507k |
| playframework | 8 -> 8 /12 | 1,319 -> 1,319 | 68k -> 82k |
| **all** | **106 -> 108 /138 (78%)** | **1,292 -> 1,299** | |

- The two new finds are the webpack `buildInfo.isCircular` task (found through the property reads) and the gitea
  migration-policy task (found through a wrapper). No task found in round 2 is lost.
- The "refs resolved" column of `summary.md` now counts member reads and writes too, so it does not compare with
  round 2.
- The index times of this run were measured under heavy machine load (load average above 60) and are not
  comparable either. Three builds of each version, alternated, measured +5% index time on spring-framework and
  medusa, and +5% to +11% index size.
- The held-out tasks were not re-run.

### Limitations (read before quoting a number)

1. **Proxy ≠ credits.** Kiro bills each request as f(model, total request tokens). The proxy only sees one
   exploration step. It does not see:
   - the number of turns;
   - the model's reasoning and output;
   - the context being billed again on every turn: a result of T tokens that stays for R turns costs about T×R;
   - compaction;
   - the fixed cost of MCP tool schemas and steering, paid on every request;
   - the agent's real behavior, which may ignore kopt, chain greps or re-read files.
2. **Token estimate.** It is characters/3, for lack of a local Claude tokenizer. The error on absolute values can
   reach ±25 to 45%. Ratios between strategies are more robust, because they all use the same estimator.
3. **The native baseline is an emulation.** Ripgrep's ordering, the exact format of Kiro's outputs, any line numbers
   and refinement greps are not reproduced. The bias deliberately favors the native strategies.
4. **A name being present is not a correct answer.** `found` is an optimistic bound. Definition recall is stricter
   but remains a proxy.
5. **Small sample**: 138 tasks on 11 repositories (12 to 15 per language) plus 22 held-out tasks, a single team for
   the gold, and tasks chosen by the team building the tool. No offline inferential statistics. Hence the
   pre-registration of the tasks and the held-out set.
6. **The proxy can point the wrong way** (the SDL-MCP case). Any claimed saving must come from `bench/ab`. On every
   A/B campaign, check that the offline ranking predicts the live ranking. If it does not, the proxy is what needs
   fixing.

## Agent A/B with logged tool calls (`bench/agentab`)

Between the offline proxy and real Kiro credits: real agents solve real tasks, and every command they run goes through
a wrapper that logs exactly what entered their context. Arm A = stock Kiro (read-only shell tools, capped like
Kiro's built-ins: search 100 matches / 10k chars, reads 2,000 lines, command output 2,000 lines / 100k chars). Arm B =
Kiro with kopt: the same tools, plus the kopt CLI (same output as the MCP tools), the steering file, the server
instructions and the tool descriptions in the prompt, and kopt's real session governor (`kopt hook`), which blocks
once, as in Kiro, a verbose test run outside `kopt run` and a whole read of a big file.

| file | role |
|---|---|
| `tasks-explore.json` | 15 exploration tasks (explain / usage / impact / locate) from `bench/tasks`, 9 repositories |
| `tasks-run.json` | 6 test-run diagnosis tasks: one realistic bug injected into a copy of this repository (missing await, wrong default, swapped arguments, off-by-one line range, wrong regex in a filter, wrong boundary in a budget check) |
| `prepare.mjs` | snapshots the kopt build (`dist/`, `templates/`, the vendored grammars), creates an isolated HOME / `~/.kopt` / `~/.kiro` / kopt cache, runs the real `kopt setup --no-global` in it, indexes the repositories, builds the test-task copies (one per arm, a single git commit holding the buggy tree, `bench/agentab` and the published A/B results removed, no earlier answer and, outside this table, no description of the injected bugs left) and checks the expected failing test files, then smoke-tests every command an agent may use. A run is usable only when all of it passed. `--reps n`: n pairs of test-task copies, each arm B copy with its own index, so no `kopt run` result is cached across repetitions |
| `run.mjs` | the wrapper: read-only guard (quote-aware; no redirections, substitutions, `find -exec`, `sed -i`, paths outside the repository), caps, governor for arm B, one JSONL log line per call (refused calls included) in `logs/<run>/`. `--rep k`: repetition k, with its own log file, governor session and (test tasks) repository copies. kopt calls carry the run's `KOPT_SESSION`, so the CLI dedups code already sent in that session as the MCP server would; `kopt read/find --fresh` (the tools' `fresh: true`, which the CLI lacks) runs that call outside the session's ledger, so the code comes back in full. Test commands never see a `KOPT_*` variable, run directly or through `kopt run`, in either arm (npx/npm shims first on `PATH`): round 2 leaked `KOPT_SESSION` into kopt's own test suite through `kopt run` |
| `prompts.mjs` | writes the exact prompt of every agent (`<arm>-<task>`, `<arm>-<task>-r<k>` with repetitions), with a seeded interleaved order: one shuffled block per repetition, so both arms of every task run once before any runs again |
| `score.mjs` | calls, kopt calls and errors, governor blocks, tokens read, test-output tokens, a modeled session cost, and the graded answers; pass-gated pairs (per-task means of the runs) with a paired bootstrap 95% CI |
| `analyze.mjs` | the paired analysis of a run (results in `bench/results/agent-ab-<run>.md/.json`): lenient and strict grades, the session cost as **measured input context re-based to a 12k prefix (primary)** next to the modeled cost12k (12k prefix + tokens read so far, per call) and cost12k + kopt's measured prompt on every arm-B call, tokens read, model requests, a variant with the first request and each arm's prompt, the raw measured context (`--usage`), bootstrap CIs over tasks of the relative B/A difference (each task = the mean of its runs) with an exact sign test, each arm's run-to-run spread, kopt usage per run, comparison with v0.1 (`--v01`) and with earlier runs of the same tasks (`--prev`, repeatable, each with its own `--prev-kinds`; with several, every run pooled), and "as delivered" token counts for calls the agent did not receive in full (`--seen`) |

```bash
npm run build
# round 2: 3 interleaved runs per arm and task (126 agents: 15 exploration + 6 test tasks x 2 arms x 3)
node bench/agentab/prepare.mjs --run r2 --reps 3 --from-index <dir of .kopt-<repo> indexes>
node bench/agentab/prompts.mjs --run r2 --mode explore --out prompts-r2.json
node bench/agentab/prompts.mjs --run r2 --mode test --out prompts-run-r2.json
# run one fresh agent per prompt, in the file's "order" (same model); save each final answer to
# bench/agentab/logs/r2/answers/<id>.md
node bench/agentab/score.mjs --prompts prompts-r2.json --prompts prompts-run-r2.json --out bench/agentab/logs/r2/score.md
# answers.json: {"<id>": {answer, files, symbols}}; usage.json: measured input context per agent (needed for the
# primary session-cost metric)
node bench/agentab/analyze.mjs --prompts prompts-r2.json --prompts prompts-run-r2.json --answers answers.json \
  --usage usage.json [--v01 ab2-summary.json] [--prev bench/results/agent-ab-r1.json [--prev-kinds explore]] \
  [--seen seen.json] --out bench/results/agent-ab-r2.md
```

Round 1 (`r1`, one run per arm and task) showed why repetitions are needed: arm A alone moved +12% in tokens read
and +32% in cost12k between two runs of the same tasks with the same tools, as much as the whole session-cost
effect. The primary session-cost metric is the measured context re-based to a 12k prefix (what the agents' model
really processed, with the harness's 34k-token prefix replaced by a Kiro-sized one): the closest proxy here to what
Kiro bills. cost12k stays as the v0.1-comparable model.

Modeled session cost: request k (k = 0..n for n tool calls) bills base + prompt + k x 150 + the outputs of calls
0..k-1 (`--base`, default 8,000 tokens for Kiro's own system prompt and tool schemas; `--per-turn`). It shows the
trade-off the proxy cannot: an output saved early is saved on every later request, an extra call costs a whole
request. It is a model, not credits.

Known differences with Kiro: arm B's tool descriptions are in its prompt in CLI spelling (Kiro sends the MCP
schemas); before round 2 the CLI had no dedup ledger across calls (rounds 1 and ab2 re-sent code MCP would have
deduplicated, which penalized arm B; `KOPT_SESSION` now keeps it); the shell cap of arm A is an assumption (Kiro does
not document it) chosen large enough never to favour arm B.

**The v0.1 run `ab2` measured nothing about kopt.** In its logs, all 11 kopt calls of arm B exited with status 1 and
a 39-token error, most likely because the indexes it pointed to did not exist yet (they were written after the
last logged call), so the agents fell back to grep. Its
"-15% tokens read" is steering plus noise. This is why `prepare.mjs` now refuses to mark a run ready unless every
kopt command works through the wrapper, and why `score.mjs` reports kopt errors.

### Agent A/B results

| run | build | runs per arm and task | exploration, measured session cost re-based (15 tasks) | test diagnosis (6 tasks) | report |
|---|---|---|---|---|---|
| v0.1 `ab2` | v0.1 | 1 | invalid: all 11 kopt calls failed | not run | not committed |
| round 1 `r1` | `5ce628a` | 1 | -12% [-26%, +8%] | -7% [-21%, +10%] | [`results/agent-ab-r1.md`](results/agent-ab-r1.md) |
| round 2 `r2` | `8143786` | 3 | -11% [-28%, +5%] | confounded (kopt's variables leaked into the test commands) | [`results/agent-ab-r2.md`](results/agent-ab-r2.md) |
| **final** | `983e221` | 2 | **-23% [-38%, -8%]**, lower in 13/15 (p = 0.007) | +16% [-31%, +67%] | [`results/agent-ab-final.md`](results/agent-ab-final.md) |

Every answer of the final run is correct in both arms; pooled over r1, r2 and final, exploration is -18% [-31%, -5%].
Arm A cost 26% more in the final run than in round 1 with the same prompt, model and harness version: compare arms
within a run. The final report lists the remaining blockers (kopt use halved with the shorter prompt, flaky timing
tests under load, the one-line re-run answer, unresolved TypeScript and Rust receivers, a completeness check that
counts comments). The extraction and labelling scripts of each round (transcript usage, "as delivered" tokens,
test-task labels) are kept outside the repository; their outputs are the `--usage` and `--seen` inputs of
`analyze.mjs` and the `diagnosis` section of each `.json`.

## Compression benchmark (`bench/compress/run.mjs`)

```bash
npm run build && node bench/compress/run.mjs     # -> results/compression.md and results/compression.json
```

It runs `kopt_run`'s filters (from `dist/compress`) on the 50 committed outputs of `test/fixtures/compress`, the same
way `test/compress.filters.test.ts` does (normalize, make repository paths relative, compress at the default
900-token budget), and reports the raw and returned tokens per fixture, per tool family and in total. 45 fixtures are
generated in each tool's CI format (`test/fixtures/compress/generate.mjs`), 5 are real runs of this repository's suite
and build. The figures cover the filter output, not the one-line header, log handle and source hints a real answer
adds.

## Benchmark pages (`scripts/build-benchmarks-page.mjs`)

`npm run bench:page` rewrites the generated blocks and marked numbers of `docs/BENCHMARKS.md` (and the marked
numbers of `README.md`, `docs/ARCHITECTURE.md`, `docs/COMMANDS.md`, `docs/HOW-IT-WORKS.md` and
`docs/CONFIGURATION.md`) from the result files, then converts `docs/BENCHMARKS.md` into the
self-contained `docs/benchmarks.html` (inline SVG charts, light and dark themes, a data table next to every chart).
`npm run bench:page -- --check` exits with 1 when a generated file is out of date; `test/benchmarks-page.test.ts`
runs that check and a sanity check of the HTML page in CI. After a new result file, run `npm run bench:page` and
commit the regenerated pages with it.

## Online benchmark (kiro-cli A/B)

`kopt bench ab --repo <your repo> --tasks <your tasks> --max-credits <N>`. Step-by-step guide:
[`ab/README.md`](ab/README.md). The principle:

- Arm A: stock Kiro. Arm B: Kiro with the kopt MCP server, its hooks and its steering. Optional arm C: the kopt MCP
  server only, to separate the effect of the tools from the effect of the hooks and steering.
- The model is pinned. Each run is a fresh headless session, in a git worktree per arm with its own `KIRO_HOME`;
  the user's login is reused, never replaced.
- Runs follow a seeded, counterbalanced order (A B, B A, ...), with N repetitions, under a credit budget, after an
  optional smoke run (`--smoke`) that must yield credits in every arm. The guide starts with a warning about Kiro's
  anti-abuse checks: log in yourself, never let a script log in, keep automated sessions few.
- Credits are read from the session files and the stream; a run without credits is invalid and reported. kopt usage
  is proven by kopt's own telemetry and the stream's tool calls.
- The answer is graded on the gold files and symbols it names, or by hand.
- The comparison is paired, restricted to pairs both arms answered correctly (an all-runs view is shown too), with a
  bootstrap CI, a sign test, and a fixed decision rule: at least 20% fewer credits at equal correctness.
