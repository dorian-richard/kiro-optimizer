# kopt benchmarks

This folder measures whether kopt really reduces what Kiro bills. There are two levels:

| level | tool | what it measures | cost | status |
|---|---|---|---|---|
| **Offline** (proxy) | `kopt bench` | tokens returned to the model for ONE exploration step, and recall of verified gold items | free, a few seconds | working |
| **Online** (A/B) | `bench/ab/run-kiro-cli-ab.sh` | real Kiro credits per task (headless kiro-cli), with graded answers | Kiro credits | **UNTESTED** (kiro-cli was not available where it was written) |

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

| repository | pinned version | commit | tasks |
|---|---|---|---|
| spring-projects/spring-framework (Java) | `v7.0.9` | `82a6b40b9366` | 15: 4 locate, 4 explain, 4 usage, 3 impact |
| django/django (Python) | `6.1.2` | `2212534bae39` | 15: 4 locate, 4 explain, 4 usage, 3 impact |

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

### Results snapshot (2026-10-09, `input = search`)

These figures were taken while the `indexer` and `retrieval` modules were still being written. They are therefore
not a final result: they are the starting point to track for regressions.

| repository | strategy | found | file recall | symbol recall | median tokens | tokens / found task | calls |
|---|---|---|---|---|---|---|---|
| django | native-naive | 7/15 | 77% | 63% | 43,715 | 83,575 | 3.5 |
| django | native-ranged | 8/15 | 77% | 67% | 6,737 | 11,497 | 4.5 |
| django | kopt-pack | 8/15 | 89% | 89% | 627 | 1,153 | 1 |
| django | kopt-hits+read | 5/15 | 89% | 68% | 729 | 2,731 | 3 |
| spring-framework | native-naive | 9/15 | 82% | 71% | 19,851 | 38,303 | 3.8 |
| spring-framework | native-ranged | 8/15 | 82% | 70% | 7,378 | 14,080 | 4.2 |
| spring-framework | kopt-pack | 5/15 | 72% | 75% | 776 | 2,503 | 1 |
| spring-framework | kopt-hits+read | 5/15 | 74% | 59% | 1,436 | 4,358 | 3 |

An honest reading:

- kopt returns about 10 times fewer tokens per step than the disciplined native baseline (`native-ranged`).
- On recall, kopt is not better: it ties on django and is clearly behind on spring-framework (5/15 versus 8/15).
- On the tasks found by both strategies, `kopt-pack` costs 0.08 to 0.09 times `native-ranged`. But an agent that
  does not find the answer makes more calls: a missed step costs extra turns, which the proxy does not see.
- The work items for `retrieval` are visible task by task in `bench/results/*.md`: usage/impact tasks (callers),
  and ranking on natural-language queries.
- With `--input question` (raw question, no keyword derivation; rerun 2026-10-09 on the English questions, with
  the current indexer and retrieval, so not directly comparable with the `input = search` snapshot above):

  | repository | native-naive | native-ranged | kopt-pack | kopt-hits+read |
  |---|---|---|---|---|
  | django | 4/15 | 4/15 | 5/15 | 2/15 |
  | spring-framework | 6/15 | 4/15 | 4/15 | 2/15 |

Measured durations (Node 22, Apple silicon Mac):

- kopt index: 9.5 s for django (2,964 files indexed, 51k symbols), 25.7 s for spring-framework (9,552 files,
  139k symbols).
- `kopt_find`: 12 to 77 ms median per query.
- Emulated grep: 0.1 to 0.7 s.

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
5. **Small sample**: 30 tasks, 2 repositories, a single author for the gold, and tasks chosen by the team building
   the tool. No offline inferential statistics. Hence the pre-registration of the tasks.
6. **The proxy can point the wrong way** (the SDL-MCP case). Any claimed saving must come from `bench/ab`. On every
   A/B campaign, check that the offline ranking predicts the live ranking. If it does not, the proxy is what needs
   fixing.

## Online benchmark (kiro-cli A/B)

See [`ab/README.md`](ab/README.md). The principle:

- Arm A: stock Kiro. Arm B: Kiro with the kopt MCP server, its hooks and its steering. Optional arm M: no tools at
  all (memory probe).
- The model is pinned; each run has its own session, a worktree per arm and an isolated HOME.
- Runs are randomized and interleaved, with N repetitions.
- Credits are read from the stream and from the session files.
- The answer is graded on the gold names it mentions.
- The comparison is paired and pass-gated, with a bootstrap CI.
