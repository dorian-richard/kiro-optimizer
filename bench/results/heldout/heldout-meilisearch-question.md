# kopt bench: heldout-meilisearch-question

Repo `meilisearch` @ `v1.54.3` (`7ebd97e38c36`) · 2 tasks · input = `question` · 3 chars/token · 2026-10-09T20:18:24.081Z

> Offline proxy: tokens = estimated tokens of tool outputs returned to the model for ONE exploration step.
> It is not a credit measurement. Savings must be confirmed by the online A/B (bench/ab) before being claimed.

Skipped strategies: kirograph, codegraph — no kirograph result line for this task; no codegraph result line for this task

## Summary per strategy

| strategy | tasks | found | file recall | symbol recall | def recall | median tok | mean tok | p90 tok | tok / found task | calls |
|---|---|---|---|---|---|---|---|---|---|---|
| native-naive | 2 | 0 (0%) | 25% | 0% | 0% | 31,556 | 31,556 | 51,079 | n/a | 4.0 |
| native-ranged | 2 | 0 (0%) | 25% | 0% | 0% | 7,636 | 7,636 | 8,917 | n/a | 3.0 |
| kopt-pack | 2 | 2 (100%) | 100% | 100% | 50% | 1,314 | 1,314 | 1,341 | 1,314 | 1.0 |
| kopt-hits+read | 2 | 2 (100%) | 100% | 100% | 50% | 727 | 727 | 746 | 727 | 3.0 |

`found` = every gold file path AND every gold symbol name appears in the output. `def recall` = the definition line
of the gold symbol was shown (stricter). `tok / found task` = all tokens spent (failures included) / tasks found.

## Pass-gated pairs (only tasks found by both)

| b vs a | tasks run | found by both | only a | only b | median b/a | geomean b/a | b cheaper |
|---|---|---|---|---|---|---|---|
| kopt-pack vs native-naive | 2 | 0 | 0 | 2 | n/a | n/a | 0/0 |
| kopt-pack vs native-ranged | 2 | 0 | 0 | 2 | n/a | n/a | 0/0 |
| kopt-hits+read vs native-naive | 2 | 0 | 0 | 2 | n/a | n/a | 0/0 |
| kopt-hits+read vs native-ranged | 2 | 0 | 0 | 2 | n/a | n/a | 0/0 |
| native-ranged vs native-naive | 2 | 0 | 0 | 0 | n/a | n/a | 0/0 |

## By task kind

| kind | strategy | tasks | found | median tok |
|---|---|---|---|---|
| locate | native-naive | 1 | 0 | 51,079 |
| locate | native-ranged | 1 | 0 | 8,917 |
| locate | kopt-pack | 1 | 1 | 1,341 |
| locate | kopt-hits+read | 1 | 1 | 746 |
| explain | native-naive | 1 | 0 | 12,032 |
| explain | native-ranged | 1 | 0 | 6,354 |
| explain | kopt-pack | 1 | 1 | 1,287 |
| explain | kopt-hits+read | 1 | 1 | 708 |

## Per task (tokens, found)

| task | kind | native-naive | native-ranged | kopt-pack | kopt-hits+read | kirograph | codegraph |
|---|---|---|---|---|---|---|---|
| ho-ms-explain-key-value | explain | 12,032 NO (miss store.rs, lib.rs, generate_key_as_hexa, generate_key) | 6,354 NO (miss store.rs, lib.rs, generate_key_as_hexa, generate_key) | 1,287 OK | 708 OK | skipped | skipped |
| ho-ms-locate-key-authorized | locate | 51,079 NO (miss store.rs, is_key_authorized, get_expiration_date) | 8,917 NO (miss store.rs, is_key_authorized, get_expiration_date) | 1,341 OK | 746 OK | skipped | skipped |

## Settings

- grep_search emulation: 100 matches / 10,000 chars, lines cut at 250 chars; pattern = most selective keywords while the total stays under the match cap; files ordered by distinct keywords, non-test first, match count (generous to native).
- native-naive: top 3 files by visible match count, whole file capped at 2000 lines.
- native-ranged: ±60 lines around the best 4 matches (overlaps merged).
- kopt budgets: find 700, pack 2500, read 3000 tokens.
- index: reused, 715 files, 18,280 symbols.
- kirograph: outputs loaded from bench/competitors/results/kirograph-meilisearch.jsonl
- codegraph: outputs loaded from bench/competitors/results/codegraph-meilisearch.jsonl
- run duration: 670 ms.
