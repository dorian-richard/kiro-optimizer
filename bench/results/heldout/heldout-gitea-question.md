# kopt bench: heldout-gitea-question

Repo `gitea` @ `v28.1.0` (`4ebd5e319b6a`) · 2 tasks · input = `question` · 3 chars/token · 2026-10-09T20:18:09.398Z

> Offline proxy: tokens = estimated tokens of tool outputs returned to the model for ONE exploration step.
> It is not a credit measurement. Savings must be confirmed by the online A/B (bench/ab) before being claimed.

Skipped strategies: kirograph, codegraph — no kirograph result line for this task; no codegraph result line for this task

## Summary per strategy

| strategy | tasks | found | file recall | symbol recall | def recall | median tok | mean tok | p90 tok | tok / found task | calls |
|---|---|---|---|---|---|---|---|---|---|---|
| native-naive | 2 | 1 (50%) | 100% | 50% | 50% | 22,323 | 22,323 | 36,164 | 44,645 | 4.0 |
| native-ranged | 2 | 1 (50%) | 100% | 50% | 50% | 5,253 | 5,253 | 6,855 | 10,505 | 4.5 |
| kopt-pack | 2 | 2 (100%) | 100% | 100% | 67% | 1,353 | 1,353 | 1,365 | 1,353 | 1.0 |
| kopt-hits+read | 2 | 1 (50%) | 83% | 83% | 67% | 2,420 | 2,420 | 2,557 | 4,839 | 3.0 |

`found` = every gold file path AND every gold symbol name appears in the output. `def recall` = the definition line
of the gold symbol was shown (stricter). `tok / found task` = all tokens spent (failures included) / tasks found.

## Pass-gated pairs (only tasks found by both)

| b vs a | tasks run | found by both | only a | only b | median b/a | geomean b/a | b cheaper |
|---|---|---|---|---|---|---|---|
| kopt-pack vs native-naive | 2 | 1 | 0 | 1 | 0.16× | 0.16× | 1/1 |
| kopt-pack vs native-ranged | 2 | 1 | 0 | 1 | 0.37× | 0.37× | 1/1 |
| kopt-hits+read vs native-naive | 2 | 0 | 1 | 1 | n/a | n/a | 0/0 |
| kopt-hits+read vs native-ranged | 2 | 0 | 1 | 1 | n/a | n/a | 0/0 |
| native-ranged vs native-naive | 2 | 1 | 0 | 0 | 0.43× | 0.43× | 1/1 |

## By task kind

| kind | strategy | tasks | found | median tok |
|---|---|---|---|---|
| locate | native-naive | 1 | 0 | 36,164 |
| locate | native-ranged | 1 | 0 | 6,855 |
| locate | kopt-pack | 1 | 1 | 1,365 |
| locate | kopt-hits+read | 1 | 1 | 2,557 |
| usage | native-naive | 1 | 1 | 8,481 |
| usage | native-ranged | 1 | 1 | 3,650 |
| usage | kopt-pack | 1 | 1 | 1,341 |
| usage | kopt-hits+read | 1 | 0 | 2,282 |

## Per task (tokens, found)

| task | kind | native-naive | native-ranged | kopt-pack | kopt-hits+read | kirograph | codegraph |
|---|---|---|---|---|---|---|---|
| ho-gt-locate-webhook-signature | locate | 36,164 NO (miss addDefaultHeaders) | 6,855 NO (miss addDefaultHeaders) | 1,365 OK | 2,557 OK | skipped | skipped |
| ho-gt-usage-default-headers | usage | 8,481 OK | 3,650 OK | 1,341 OK | 2,282 NO (miss matrix.go, newMatrixRequest) | skipped | skipped |

## Settings

- grep_search emulation: 100 matches / 10,000 chars, lines cut at 250 chars; pattern = most selective keywords while the total stays under the match cap; files ordered by distinct keywords, non-test first, match count (generous to native).
- native-naive: top 3 files by visible match count, whole file capped at 2000 lines.
- native-ranged: ±60 lines around the best 4 matches (overlaps merged).
- kopt budgets: find 700, pack 2500, read 3000 tokens.
- index: reused, 3,402 files, 32,905 symbols.
- kirograph: outputs loaded from bench/competitors/results/kirograph-gitea.jsonl
- codegraph: outputs loaded from bench/competitors/results/codegraph-gitea.jsonl
- run duration: 1,216 ms.
