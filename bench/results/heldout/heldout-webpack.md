# kopt bench: heldout-webpack

Repo `webpack` @ `v5.111.1` (`5a106753839f`) · 2 tasks · input = `search` · 3 chars/token · 2026-10-09T20:18:37.399Z

> Offline proxy: tokens = estimated tokens of tool outputs returned to the model for ONE exploration step.
> It is not a credit measurement. Savings must be confirmed by the online A/B (bench/ab) before being claimed.

Skipped strategies: kirograph, codegraph — no kirograph result line for this task; no codegraph result line for this task

## Summary per strategy

| strategy | tasks | found | file recall | symbol recall | def recall | median tok | mean tok | p90 tok | tok / found task | calls |
|---|---|---|---|---|---|---|---|---|---|---|
| native-naive | 2 | 1 (50%) | 100% | 50% | 50% | 29,014 | 29,014 | 38,156 | 58,027 | 4.0 |
| native-ranged | 2 | 1 (50%) | 100% | 50% | 50% | 5,177 | 5,177 | 5,734 | 10,353 | 4.0 |
| kopt-pack | 2 | 2 (100%) | 100% | 100% | 75% | 835 | 835 | 1,013 | 835 | 1.0 |
| kopt-hits+read | 2 | 2 (100%) | 100% | 100% | 100% | 936 | 936 | 1,564 | 936 | 3.0 |

`found` = every gold file path AND every gold symbol name appears in the output. `def recall` = the definition line
of the gold symbol was shown (stricter). `tok / found task` = all tokens spent (failures included) / tasks found.

## Pass-gated pairs (only tasks found by both)

| b vs a | tasks run | found by both | only a | only b | median b/a | geomean b/a | b cheaper |
|---|---|---|---|---|---|---|---|
| kopt-pack vs native-naive | 2 | 1 | 0 | 1 | 0.03× | 0.03× | 1/1 |
| kopt-pack vs native-ranged | 2 | 1 | 0 | 1 | 0.18× | 0.18× | 1/1 |
| kopt-hits+read vs native-naive | 2 | 1 | 0 | 1 | 0.04× | 0.04× | 1/1 |
| kopt-hits+read vs native-ranged | 2 | 1 | 0 | 1 | 0.27× | 0.27× | 1/1 |
| native-ranged vs native-naive | 2 | 1 | 0 | 0 | 0.15× | 0.15× | 1/1 |

## By task kind

| kind | strategy | tasks | found | median tok |
|---|---|---|---|---|
| locate | native-naive | 1 | 0 | 19,871 |
| locate | native-ranged | 1 | 0 | 4,619 |
| locate | kopt-pack | 1 | 1 | 656 |
| locate | kopt-hits+read | 1 | 1 | 308 |
| explain | native-naive | 1 | 1 | 38,156 |
| explain | native-ranged | 1 | 1 | 5,734 |
| explain | kopt-pack | 1 | 1 | 1,013 |
| explain | kopt-hits+read | 1 | 1 | 1,564 |

## Per task (tokens, found)

| task | kind | native-naive | native-ranged | kopt-pack | kopt-hits+read | kirograph | codegraph |
|---|---|---|---|---|---|---|---|
| ho-wp-locate-ignore-plugin | locate | 19,871 NO (miss checkIgnore) | 4,619 NO (miss checkIgnore) | 656 OK | 308 OK | skipped | skipped |
| ho-wp-explain-banner | explain | 38,156 OK | 5,734 OK | 1,013 OK | 1,564 OK | skipped | skipped |

## Settings

- grep_search emulation: 100 matches / 10,000 chars, lines cut at 250 chars; pattern = most selective keywords while the total stays under the match cap; files ordered by distinct keywords, non-test first, match count (generous to native).
- native-naive: top 3 files by visible match count, whole file capped at 2000 lines.
- native-ranged: ±60 lines around the best 4 matches (overlaps merged).
- kopt budgets: find 700, pack 2500, read 3000 tokens.
- index: reused, 14,902 files, 22,575 symbols.
- kirograph: outputs loaded from bench/competitors/results/kirograph-webpack.jsonl
- codegraph: outputs loaded from bench/competitors/results/codegraph-webpack.jsonl
- run duration: 3,137 ms.
