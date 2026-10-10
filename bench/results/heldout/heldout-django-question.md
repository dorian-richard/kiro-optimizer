# kopt bench: heldout-django-question

Repo `django` @ `6.1.2` (`2212534bae39`) · 2 tasks · input = `question` · 3 chars/token · 2026-10-09T20:18:04.035Z

> Offline proxy: tokens = estimated tokens of tool outputs returned to the model for ONE exploration step.
> It is not a credit measurement. Savings must be confirmed by the online A/B (bench/ab) before being claimed.

Skipped strategies: kirograph, codegraph — no kirograph result line for this task; no codegraph result line for this task

## Summary per strategy

| strategy | tasks | found | file recall | symbol recall | def recall | median tok | mean tok | p90 tok | tok / found task | calls |
|---|---|---|---|---|---|---|---|---|---|---|
| native-naive | 2 | 0 (0%) | 75% | 67% | 17% | 39,825 | 39,825 | 47,309 | n/a | 4.0 |
| native-ranged | 2 | 0 (0%) | 75% | 67% | 42% | 7,336 | 7,336 | 8,737 | n/a | 3.5 |
| kopt-pack | 2 | 1 (50%) | 75% | 75% | 42% | 1,155 | 1,155 | 1,352 | 2,309 | 1.0 |
| kopt-hits+read | 2 | 0 (0%) | 42% | 42% | 42% | 2,469 | 2,469 | 4,139 | n/a | 3.0 |

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
| explain | native-naive | 1 | 0 | 47,309 |
| explain | native-ranged | 1 | 0 | 8,737 |
| explain | kopt-pack | 1 | 0 | 957 |
| explain | kopt-hits+read | 1 | 0 | 4,139 |
| usage | native-naive | 1 | 0 | 32,340 |
| usage | native-ranged | 1 | 0 | 5,934 |
| usage | kopt-pack | 1 | 1 | 1,352 |
| usage | kopt-hits+read | 1 | 0 | 799 |

## Per task (tokens, found)

| task | kind | native-naive | native-ranged | kopt-pack | kopt-hits+read | kirograph | codegraph |
|---|---|---|---|---|---|---|---|
| ho-dj-explain-bulk-batches | explain | 47,309 NO (miss operations.py) | 8,737 NO (miss operations.py) | 957 NO (miss operations.py, bulk_batch_size) | 4,139 NO (miss operations.py, bulk_batch_size) | skipped | skipped |
| ho-dj-usage-validate-password | usage | 32,340 NO (miss handle, handle) | 5,934 NO (miss handle, handle) | 1,352 OK | 799 NO (miss changepassword.py, createsuperuser.py, handle, handle) | skipped | skipped |

## Settings

- grep_search emulation: 100 matches / 10,000 chars, lines cut at 250 chars; pattern = most selective keywords while the total stays under the match cap; files ordered by distinct keywords, non-test first, match count (generous to native).
- native-naive: top 3 files by visible match count, whole file capped at 2000 lines.
- native-ranged: ±60 lines around the best 4 matches (overlaps merged).
- kopt budgets: find 700, pack 2500, read 3000 tokens.
- index: reused, 2,964 files, 51,183 symbols.
- kirograph: outputs loaded from bench/competitors/results/kirograph-django.jsonl
- codegraph: outputs loaded from bench/competitors/results/codegraph-django.jsonl
- run duration: 1,502 ms.
