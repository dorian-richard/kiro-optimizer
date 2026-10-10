# kopt bench: heldout-django

Repo `django` @ `6.1.2` (`2212534bae39`) · 2 tasks · input = `search` · 3 chars/token · 2026-10-09T20:18:02.471Z

> Offline proxy: tokens = estimated tokens of tool outputs returned to the model for ONE exploration step.
> It is not a credit measurement. Savings must be confirmed by the online A/B (bench/ab) before being claimed.

Skipped strategies: kirograph, codegraph — no kirograph result line for this task; no codegraph result line for this task

## Summary per strategy

| strategy | tasks | found | file recall | symbol recall | def recall | median tok | mean tok | p90 tok | tok / found task | calls |
|---|---|---|---|---|---|---|---|---|---|---|
| native-naive | 2 | 0 (0%) | 75% | 67% | 17% | 38,625 | 38,625 | 44,909 | n/a | 4.0 |
| native-ranged | 2 | 0 (0%) | 75% | 42% | 17% | 6,211 | 6,211 | 6,487 | n/a | 3.5 |
| kopt-pack | 2 | 2 (100%) | 100% | 100% | 67% | 1,168 | 1,168 | 1,419 | 1,168 | 1.0 |
| kopt-hits+read | 2 | 1 (50%) | 67% | 67% | 67% | 1,807 | 1,807 | 2,865 | 3,613 | 3.0 |

`found` = every gold file path AND every gold symbol name appears in the output. `def recall` = the definition line
of the gold symbol was shown (stricter). `tok / found task` = all tokens spent (failures included) / tasks found.

## Pass-gated pairs (only tasks found by both)

| b vs a | tasks run | found by both | only a | only b | median b/a | geomean b/a | b cheaper |
|---|---|---|---|---|---|---|---|
| kopt-pack vs native-naive | 2 | 0 | 0 | 2 | n/a | n/a | 0/0 |
| kopt-pack vs native-ranged | 2 | 0 | 0 | 2 | n/a | n/a | 0/0 |
| kopt-hits+read vs native-naive | 2 | 0 | 0 | 1 | n/a | n/a | 0/0 |
| kopt-hits+read vs native-ranged | 2 | 0 | 0 | 1 | n/a | n/a | 0/0 |
| native-ranged vs native-naive | 2 | 0 | 0 | 0 | n/a | n/a | 0/0 |

## By task kind

| kind | strategy | tasks | found | median tok |
|---|---|---|---|---|
| explain | native-naive | 1 | 0 | 44,909 |
| explain | native-ranged | 1 | 0 | 6,487 |
| explain | kopt-pack | 1 | 1 | 1,419 |
| explain | kopt-hits+read | 1 | 1 | 2,865 |
| usage | native-naive | 1 | 0 | 32,340 |
| usage | native-ranged | 1 | 0 | 5,934 |
| usage | kopt-pack | 1 | 1 | 917 |
| usage | kopt-hits+read | 1 | 0 | 748 |

## Per task (tokens, found)

| task | kind | native-naive | native-ranged | kopt-pack | kopt-hits+read | kirograph | codegraph |
|---|---|---|---|---|---|---|---|
| ho-dj-explain-bulk-batches | explain | 44,909 NO (miss operations.py) | 6,487 NO (miss operations.py, _batched_insert) | 1,419 OK | 2,865 OK | skipped | skipped |
| ho-dj-usage-validate-password | usage | 32,340 NO (miss handle, handle) | 5,934 NO (miss handle, handle) | 917 OK | 748 NO (miss changepassword.py, createsuperuser.py, handle, handle) | skipped | skipped |

## Settings

- grep_search emulation: 100 matches / 10,000 chars, lines cut at 250 chars; pattern = most selective keywords while the total stays under the match cap; files ordered by distinct keywords, non-test first, match count (generous to native).
- native-naive: top 3 files by visible match count, whole file capped at 2000 lines.
- native-ranged: ±60 lines around the best 4 matches (overlaps merged).
- kopt budgets: find 700, pack 2500, read 3000 tokens.
- index: reused, 2,964 files, 51,183 symbols.
- kirograph: outputs loaded from bench/competitors/results/kirograph-django.jsonl
- codegraph: outputs loaded from bench/competitors/results/codegraph-django.jsonl
- run duration: 1,222 ms.
