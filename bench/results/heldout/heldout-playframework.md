# kopt bench: heldout-playframework

Repo `playframework` @ `3.0.12` (`316f494b2d12`) · 2 tasks · input = `search` · 3 chars/token · 2026-10-09T20:18:25.169Z

> Offline proxy: tokens = estimated tokens of tool outputs returned to the model for ONE exploration step.
> It is not a credit measurement. Savings must be confirmed by the online A/B (bench/ab) before being claimed.

Skipped strategies: kirograph, codegraph — no kirograph result line for this task; no codegraph result line for this task

## Summary per strategy

| strategy | tasks | found | file recall | symbol recall | def recall | median tok | mean tok | p90 tok | tok / found task | calls |
|---|---|---|---|---|---|---|---|---|---|---|
| native-naive | 2 | 1 (50%) | 50% | 50% | 50% | 21,870 | 21,870 | 32,324 | 43,739 | 4.0 |
| native-ranged | 2 | 1 (50%) | 50% | 50% | 50% | 8,747 | 8,747 | 9,070 | 17,494 | 3.5 |
| kopt-pack | 2 | 1 (50%) | 50% | 50% | 25% | 1,318 | 1,318 | 1,364 | 2,635 | 1.0 |
| kopt-hits+read | 2 | 1 (50%) | 50% | 50% | 0% | 963 | 963 | 1,132 | 1,925 | 3.0 |

`found` = every gold file path AND every gold symbol name appears in the output. `def recall` = the definition line
of the gold symbol was shown (stricter). `tok / found task` = all tokens spent (failures included) / tasks found.

## Pass-gated pairs (only tasks found by both)

| b vs a | tasks run | found by both | only a | only b | median b/a | geomean b/a | b cheaper |
|---|---|---|---|---|---|---|---|
| kopt-pack vs native-naive | 2 | 1 | 0 | 0 | 0.04× | 0.04× | 1/1 |
| kopt-pack vs native-ranged | 2 | 1 | 0 | 0 | 0.15× | 0.15× | 1/1 |
| kopt-hits+read vs native-naive | 2 | 1 | 0 | 0 | 0.04× | 0.04× | 1/1 |
| kopt-hits+read vs native-ranged | 2 | 1 | 0 | 0 | 0.12× | 0.12× | 1/1 |
| native-ranged vs native-naive | 2 | 1 | 0 | 0 | 0.28× | 0.28× | 1/1 |

## By task kind

| kind | strategy | tasks | found | median tok |
|---|---|---|---|---|
| locate | native-naive | 1 | 0 | 11,415 |
| locate | native-ranged | 1 | 0 | 8,424 |
| locate | kopt-pack | 1 | 0 | 1,271 |
| locate | kopt-hits+read | 1 | 0 | 793 |
| explain | native-naive | 1 | 1 | 32,324 |
| explain | native-ranged | 1 | 1 | 9,070 |
| explain | kopt-pack | 1 | 1 | 1,364 |
| explain | kopt-hits+read | 1 | 1 | 1,132 |

## Per task (tokens, found)

| task | kind | native-naive | native-ranged | kopt-pack | kopt-hits+read | kirograph | codegraph |
|---|---|---|---|---|---|---|---|
| ho-pf-explain-gzip | explain | 32,324 OK | 9,070 OK | 1,364 OK | 1,132 OK | skipped | skipped |
| ho-pf-locate-csp-header | locate | 11,415 NO (miss CSPResultProcessor.scala, generateHeaders) | 8,424 NO (miss CSPResultProcessor.scala, generateHeaders) | 1,271 NO (miss CSPResultProcessor.scala, generateHeaders) | 793 NO (miss CSPResultProcessor.scala, generateHeaders) | skipped | skipped |

## Settings

- grep_search emulation: 100 matches / 10,000 chars, lines cut at 250 chars; pattern = most selective keywords while the total stays under the match cap; files ordered by distinct keywords, non-test first, match count (generous to native).
- native-naive: top 3 files by visible match count, whole file capped at 2000 lines.
- native-ranged: ±60 lines around the best 4 matches (overlaps merged).
- kopt budgets: find 700, pack 2500, read 3000 tokens.
- index: reused, 1,427 files, 18,592 symbols.
- kirograph: outputs loaded from bench/competitors/results/kirograph-playframework.jsonl
- codegraph: outputs loaded from bench/competitors/results/codegraph-playframework.jsonl
- run duration: 1,024 ms.
