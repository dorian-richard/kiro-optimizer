# kopt bench: heldout-exposed-question

Repo `exposed` @ `1.5.0` (`84361204b663`) · 2 tasks · input = `question` · 3 chars/token · 2026-10-09T20:18:07.020Z

> Offline proxy: tokens = estimated tokens of tool outputs returned to the model for ONE exploration step.
> It is not a credit measurement. Savings must be confirmed by the online A/B (bench/ab) before being claimed.

Skipped strategies: kirograph, codegraph — no kirograph result line for this task; no codegraph result line for this task

## Summary per strategy

| strategy | tasks | found | file recall | symbol recall | def recall | median tok | mean tok | p90 tok | tok / found task | calls |
|---|---|---|---|---|---|---|---|---|---|---|
| native-naive | 2 | 2 (100%) | 100% | 100% | 25% | 47,965 | 47,965 | 68,380 | 47,965 | 4.0 |
| native-ranged | 2 | 2 (100%) | 100% | 100% | 50% | 16,080 | 16,080 | 18,199 | 16,080 | 4.5 |
| kopt-pack | 2 | 2 (100%) | 100% | 100% | 75% | 1,337 | 1,337 | 1,399 | 1,337 | 1.0 |
| kopt-hits+read | 2 | 2 (100%) | 100% | 100% | 75% | 1,838 | 1,838 | 1,856 | 1,838 | 3.0 |

`found` = every gold file path AND every gold symbol name appears in the output. `def recall` = the definition line
of the gold symbol was shown (stricter). `tok / found task` = all tokens spent (failures included) / tasks found.

## Pass-gated pairs (only tasks found by both)

| b vs a | tasks run | found by both | only a | only b | median b/a | geomean b/a | b cheaper |
|---|---|---|---|---|---|---|---|
| kopt-pack vs native-naive | 2 | 2 | 0 | 0 | 0.03× | 0.03× | 2/2 |
| kopt-pack vs native-ranged | 2 | 2 | 0 | 0 | 0.09× | 0.08× | 2/2 |
| kopt-hits+read vs native-naive | 2 | 2 | 0 | 0 | 0.05× | 0.04× | 2/2 |
| kopt-hits+read vs native-ranged | 2 | 2 | 0 | 0 | 0.12× | 0.12× | 2/2 |
| native-ranged vs native-naive | 2 | 2 | 0 | 0 | 0.43× | 0.37× | 2/2 |

## By task kind

| kind | strategy | tasks | found | median tok |
|---|---|---|---|---|
| locate | native-naive | 1 | 1 | 27,550 |
| locate | native-ranged | 1 | 1 | 18,199 |
| locate | kopt-pack | 1 | 1 | 1,274 |
| locate | kopt-hits+read | 1 | 1 | 1,820 |
| explain | native-naive | 1 | 1 | 68,380 |
| explain | native-ranged | 1 | 1 | 13,960 |
| explain | kopt-pack | 1 | 1 | 1,399 |
| explain | kopt-hits+read | 1 | 1 | 1,856 |

## Per task (tokens, found)

| task | kind | native-naive | native-ranged | kopt-pack | kopt-hits+read | kirograph | codegraph |
|---|---|---|---|---|---|---|---|
| ho-ex-explain-tx-retry | explain | 68,380 OK | 13,960 OK | 1,399 OK | 1,856 OK | skipped | skipped |
| ho-ex-locate-pg-upsert | locate | 27,550 OK | 18,199 OK | 1,274 OK | 1,820 OK | skipped | skipped |

## Settings

- grep_search emulation: 100 matches / 10,000 chars, lines cut at 250 chars; pattern = most selective keywords while the total stays under the match cap; files ordered by distinct keywords, non-test first, match count (generous to native).
- native-naive: top 3 files by visible match count, whole file capped at 2000 lines.
- native-ranged: ±60 lines around the best 4 matches (overlaps merged).
- kopt budgets: find 700, pack 2500, read 3000 tokens.
- index: reused, 864 files, 12,962 symbols.
- kirograph: outputs loaded from bench/competitors/results/kirograph-exposed.jsonl
- codegraph: outputs loaded from bench/competitors/results/codegraph-exposed.jsonl
- run duration: 1,480 ms.
