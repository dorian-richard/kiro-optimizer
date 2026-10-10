# kopt bench: heldout-playframework-question

Repo `playframework` @ `3.0.12` (`316f494b2d12`) · 2 tasks · input = `question` · 3 chars/token · 2026-10-09T20:18:26.159Z

> Offline proxy: tokens = estimated tokens of tool outputs returned to the model for ONE exploration step.
> It is not a credit measurement. Savings must be confirmed by the online A/B (bench/ab) before being claimed.

Skipped strategies: kirograph, codegraph — no kirograph result line for this task; no codegraph result line for this task

## Summary per strategy

| strategy | tasks | found | file recall | symbol recall | def recall | median tok | mean tok | p90 tok | tok / found task | calls |
|---|---|---|---|---|---|---|---|---|---|---|
| native-naive | 2 | 0 (0%) | 0% | 0% | 0% | 14,059 | 14,059 | 16,557 | n/a | 4.0 |
| native-ranged | 2 | 0 (0%) | 0% | 0% | 0% | 9,338 | 9,338 | 9,486 | n/a | 4.0 |
| kopt-pack | 2 | 1 (50%) | 50% | 50% | 25% | 1,332 | 1,332 | 1,333 | 2,664 | 1.0 |
| kopt-hits+read | 2 | 0 (0%) | 50% | 25% | 25% | 1,062 | 1,062 | 1,150 | n/a | 3.0 |

`found` = every gold file path AND every gold symbol name appears in the output. `def recall` = the definition line
of the gold symbol was shown (stricter). `tok / found task` = all tokens spent (failures included) / tasks found.

## Pass-gated pairs (only tasks found by both)

| b vs a | tasks run | found by both | only a | only b | median b/a | geomean b/a | b cheaper |
|---|---|---|---|---|---|---|---|
| kopt-pack vs native-naive | 2 | 0 | 0 | 1 | n/a | n/a | 0/0 |
| kopt-pack vs native-ranged | 2 | 0 | 0 | 1 | n/a | n/a | 0/0 |
| kopt-hits+read vs native-naive | 2 | 0 | 0 | 0 | n/a | n/a | 0/0 |
| kopt-hits+read vs native-ranged | 2 | 0 | 0 | 0 | n/a | n/a | 0/0 |
| native-ranged vs native-naive | 2 | 0 | 0 | 0 | n/a | n/a | 0/0 |

## By task kind

| kind | strategy | tasks | found | median tok |
|---|---|---|---|---|
| locate | native-naive | 1 | 0 | 16,557 |
| locate | native-ranged | 1 | 0 | 9,189 |
| locate | kopt-pack | 1 | 0 | 1,333 |
| locate | kopt-hits+read | 1 | 0 | 973 |
| explain | native-naive | 1 | 0 | 11,561 |
| explain | native-ranged | 1 | 0 | 9,486 |
| explain | kopt-pack | 1 | 1 | 1,331 |
| explain | kopt-hits+read | 1 | 0 | 1,150 |

## Per task (tokens, found)

| task | kind | native-naive | native-ranged | kopt-pack | kopt-hits+read | kirograph | codegraph |
|---|---|---|---|---|---|---|---|
| ho-pf-explain-gzip | explain | 11,561 NO (miss GzipFilter.scala, shouldCompress, gzipIsAcceptedAndPreferredBy) | 9,486 NO (miss GzipFilter.scala, shouldCompress, gzipIsAcceptedAndPreferredBy) | 1,331 OK | 1,150 NO (miss gzipIsAcceptedAndPreferredBy) | skipped | skipped |
| ho-pf-locate-csp-header | locate | 16,557 NO (miss CSPResultProcessor.scala, generateHeaders) | 9,189 NO (miss CSPResultProcessor.scala, generateHeaders) | 1,333 NO (miss CSPResultProcessor.scala, generateHeaders) | 973 NO (miss CSPResultProcessor.scala, generateHeaders) | skipped | skipped |

## Settings

- grep_search emulation: 100 matches / 10,000 chars, lines cut at 250 chars; pattern = most selective keywords while the total stays under the match cap; files ordered by distinct keywords, non-test first, match count (generous to native).
- native-naive: top 3 files by visible match count, whole file capped at 2000 lines.
- native-ranged: ±60 lines around the best 4 matches (overlaps merged).
- kopt budgets: find 700, pack 2500, read 3000 tokens.
- index: reused, 1,427 files, 18,592 symbols.
- kirograph: outputs loaded from bench/competitors/results/kirograph-playframework.jsonl
- codegraph: outputs loaded from bench/competitors/results/codegraph-playframework.jsonl
- run duration: 929 ms.
