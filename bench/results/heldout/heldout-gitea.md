# kopt bench: heldout-gitea

Repo `gitea` @ `v28.1.0` (`4ebd5e319b6a`) · 2 tasks · input = `search` · 3 chars/token · 2026-10-09T20:18:08.120Z

> Offline proxy: tokens = estimated tokens of tool outputs returned to the model for ONE exploration step.
> It is not a credit measurement. Savings must be confirmed by the online A/B (bench/ab) before being claimed.

Skipped strategies: kirograph, codegraph — no kirograph result line for this task; no codegraph result line for this task

## Summary per strategy

| strategy | tasks | found | file recall | symbol recall | def recall | median tok | mean tok | p90 tok | tok / found task | calls |
|---|---|---|---|---|---|---|---|---|---|---|
| native-naive | 2 | 1 (50%) | 100% | 50% | 50% | 9,128 | 9,128 | 9,774 | 18,255 | 4.0 |
| native-ranged | 2 | 1 (50%) | 100% | 50% | 50% | 4,152 | 4,152 | 4,653 | 8,303 | 4.0 |
| kopt-pack | 2 | 2 (100%) | 100% | 100% | 50% | 1,145 | 1,145 | 1,346 | 1,145 | 1.0 |
| kopt-hits+read | 2 | 1 (50%) | 67% | 67% | 50% | 1,155 | 1,155 | 1,415 | 2,309 | 3.0 |

`found` = every gold file path AND every gold symbol name appears in the output. `def recall` = the definition line
of the gold symbol was shown (stricter). `tok / found task` = all tokens spent (failures included) / tasks found.

## Pass-gated pairs (only tasks found by both)

| b vs a | tasks run | found by both | only a | only b | median b/a | geomean b/a | b cheaper |
|---|---|---|---|---|---|---|---|
| kopt-pack vs native-naive | 2 | 1 | 0 | 1 | 0.11× | 0.11× | 1/1 |
| kopt-pack vs native-ranged | 2 | 1 | 0 | 1 | 0.26× | 0.26× | 1/1 |
| kopt-hits+read vs native-naive | 2 | 0 | 1 | 1 | n/a | n/a | 0/0 |
| kopt-hits+read vs native-ranged | 2 | 0 | 1 | 1 | n/a | n/a | 0/0 |
| native-ranged vs native-naive | 2 | 1 | 0 | 0 | 0.43× | 0.43× | 1/1 |

## By task kind

| kind | strategy | tasks | found | median tok |
|---|---|---|---|---|
| locate | native-naive | 1 | 0 | 9,774 |
| locate | native-ranged | 1 | 0 | 4,653 |
| locate | kopt-pack | 1 | 1 | 1,346 |
| locate | kopt-hits+read | 1 | 1 | 1,415 |
| usage | native-naive | 1 | 1 | 8,481 |
| usage | native-ranged | 1 | 1 | 3,650 |
| usage | kopt-pack | 1 | 1 | 944 |
| usage | kopt-hits+read | 1 | 0 | 894 |

## Per task (tokens, found)

| task | kind | native-naive | native-ranged | kopt-pack | kopt-hits+read | kirograph | codegraph |
|---|---|---|---|---|---|---|---|
| ho-gt-locate-webhook-signature | locate | 9,774 NO (miss addDefaultHeaders) | 4,653 NO (miss addDefaultHeaders) | 1,346 OK | 1,415 OK | skipped | skipped |
| ho-gt-usage-default-headers | usage | 8,481 OK | 3,650 OK | 944 OK | 894 NO (miss matrix.go, payloader.go, newMatrixRequest, prepareJSONRequest) | skipped | skipped |

## Settings

- grep_search emulation: 100 matches / 10,000 chars, lines cut at 250 chars; pattern = most selective keywords while the total stays under the match cap; files ordered by distinct keywords, non-test first, match count (generous to native).
- native-naive: top 3 files by visible match count, whole file capped at 2000 lines.
- native-ranged: ±60 lines around the best 4 matches (overlaps merged).
- kopt budgets: find 700, pack 2500, read 3000 tokens.
- index: reused, 3,402 files, 32,905 symbols.
- kirograph: outputs loaded from bench/competitors/results/kirograph-gitea.jsonl
- codegraph: outputs loaded from bench/competitors/results/codegraph-gitea.jsonl
- run duration: 1,034 ms.
