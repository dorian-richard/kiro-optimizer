# kopt bench: heldout-meilisearch

Repo `meilisearch` @ `v1.54.3` (`7ebd97e38c36`) · 2 tasks · input = `search` · 3 chars/token · 2026-10-09T20:18:23.350Z

> Offline proxy: tokens = estimated tokens of tool outputs returned to the model for ONE exploration step.
> It is not a credit measurement. Savings must be confirmed by the online A/B (bench/ab) before being claimed.

Skipped strategies: kirograph, codegraph — no kirograph result line for this task; no codegraph result line for this task

## Summary per strategy

| strategy | tasks | found | file recall | symbol recall | def recall | median tok | mean tok | p90 tok | tok / found task | calls |
|---|---|---|---|---|---|---|---|---|---|---|
| native-naive | 2 | 1 (50%) | 50% | 50% | 50% | 13,609 | 13,609 | 15,186 | 27,218 | 4.0 |
| native-ranged | 2 | 0 (0%) | 50% | 25% | 25% | 6,274 | 6,274 | 6,354 | n/a | 3.5 |
| kopt-pack | 2 | 2 (100%) | 100% | 100% | 75% | 1,334 | 1,334 | 1,368 | 1,334 | 1.0 |
| kopt-hits+read | 2 | 2 (100%) | 100% | 100% | 75% | 967 | 967 | 1,054 | 967 | 3.0 |

`found` = every gold file path AND every gold symbol name appears in the output. `def recall` = the definition line
of the gold symbol was shown (stricter). `tok / found task` = all tokens spent (failures included) / tasks found.

## Pass-gated pairs (only tasks found by both)

| b vs a | tasks run | found by both | only a | only b | median b/a | geomean b/a | b cheaper |
|---|---|---|---|---|---|---|---|
| kopt-pack vs native-naive | 2 | 1 | 0 | 1 | 0.09× | 0.09× | 1/1 |
| kopt-pack vs native-ranged | 2 | 0 | 0 | 2 | n/a | n/a | 0/0 |
| kopt-hits+read vs native-naive | 2 | 1 | 0 | 1 | 0.06× | 0.06× | 1/1 |
| kopt-hits+read vs native-ranged | 2 | 0 | 0 | 2 | n/a | n/a | 0/0 |
| native-ranged vs native-naive | 2 | 0 | 1 | 0 | n/a | n/a | 0/0 |

## By task kind

| kind | strategy | tasks | found | median tok |
|---|---|---|---|---|
| locate | native-naive | 1 | 1 | 15,186 |
| locate | native-ranged | 1 | 0 | 6,194 |
| locate | kopt-pack | 1 | 1 | 1,299 |
| locate | kopt-hits+read | 1 | 1 | 879 |
| explain | native-naive | 1 | 0 | 12,032 |
| explain | native-ranged | 1 | 0 | 6,354 |
| explain | kopt-pack | 1 | 1 | 1,368 |
| explain | kopt-hits+read | 1 | 1 | 1,054 |

## Per task (tokens, found)

| task | kind | native-naive | native-ranged | kopt-pack | kopt-hits+read | kirograph | codegraph |
|---|---|---|---|---|---|---|---|
| ho-ms-explain-key-value | explain | 12,032 NO (miss store.rs, lib.rs, generate_key_as_hexa, generate_key) | 6,354 NO (miss store.rs, lib.rs, generate_key_as_hexa, generate_key) | 1,368 OK | 1,054 OK | skipped | skipped |
| ho-ms-locate-key-authorized | locate | 15,186 OK | 6,194 NO (miss is_key_authorized) | 1,299 OK | 879 OK | skipped | skipped |

## Settings

- grep_search emulation: 100 matches / 10,000 chars, lines cut at 250 chars; pattern = most selective keywords while the total stays under the match cap; files ordered by distinct keywords, non-test first, match count (generous to native).
- native-naive: top 3 files by visible match count, whole file capped at 2000 lines.
- native-ranged: ±60 lines around the best 4 matches (overlaps merged).
- kopt budgets: find 700, pack 2500, read 3000 tokens.
- index: reused, 715 files, 18,280 symbols.
- kirograph: outputs loaded from bench/competitors/results/kirograph-meilisearch.jsonl
- codegraph: outputs loaded from bench/competitors/results/codegraph-meilisearch.jsonl
- run duration: 720 ms.
