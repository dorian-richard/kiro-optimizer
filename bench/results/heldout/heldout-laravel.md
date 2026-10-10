# kopt bench: heldout-laravel

Repo `laravel` @ `v13.35.0` (`a413a9da9488`) · 2 tasks · input = `search` · 3 chars/token · 2026-10-09T20:18:12.198Z

> Offline proxy: tokens = estimated tokens of tool outputs returned to the model for ONE exploration step.
> It is not a credit measurement. Savings must be confirmed by the online A/B (bench/ab) before being claimed.

Skipped strategies: kirograph, codegraph — no kirograph result line for this task; no codegraph result line for this task

## Summary per strategy

| strategy | tasks | found | file recall | symbol recall | def recall | median tok | mean tok | p90 tok | tok / found task | calls |
|---|---|---|---|---|---|---|---|---|---|---|
| native-naive | 2 | 1 (50%) | 50% | 50% | 50% | 20,325 | 20,325 | 26,048 | 40,650 | 4.0 |
| native-ranged | 2 | 0 (0%) | 50% | 25% | 25% | 6,837 | 6,837 | 7,376 | n/a | 4.5 |
| kopt-pack | 2 | 1 (50%) | 100% | 75% | 50% | 1,273 | 1,273 | 1,322 | 2,546 | 1.0 |
| kopt-hits+read | 2 | 1 (50%) | 100% | 75% | 33% | 912 | 912 | 1,032 | 1,823 | 3.0 |

`found` = every gold file path AND every gold symbol name appears in the output. `def recall` = the definition line
of the gold symbol was shown (stricter). `tok / found task` = all tokens spent (failures included) / tasks found.

## Pass-gated pairs (only tasks found by both)

| b vs a | tasks run | found by both | only a | only b | median b/a | geomean b/a | b cheaper |
|---|---|---|---|---|---|---|---|
| kopt-pack vs native-naive | 2 | 0 | 1 | 1 | n/a | n/a | 0/0 |
| kopt-pack vs native-ranged | 2 | 0 | 0 | 1 | n/a | n/a | 0/0 |
| kopt-hits+read vs native-naive | 2 | 0 | 1 | 1 | n/a | n/a | 0/0 |
| kopt-hits+read vs native-ranged | 2 | 0 | 0 | 1 | n/a | n/a | 0/0 |
| native-ranged vs native-naive | 2 | 0 | 1 | 0 | n/a | n/a | 0/0 |

## By task kind

| kind | strategy | tasks | found | median tok |
|---|---|---|---|---|
| locate | native-naive | 1 | 0 | 14,602 |
| locate | native-ranged | 1 | 0 | 6,298 |
| locate | kopt-pack | 1 | 1 | 1,322 |
| locate | kopt-hits+read | 1 | 1 | 1,032 |
| explain | native-naive | 1 | 1 | 26,048 |
| explain | native-ranged | 1 | 0 | 7,376 |
| explain | kopt-pack | 1 | 0 | 1,224 |
| explain | kopt-hits+read | 1 | 0 | 791 |

## Per task (tokens, found)

| task | kind | native-naive | native-ranged | kopt-pack | kopt-hits+read | kirograph | codegraph |
|---|---|---|---|---|---|---|---|
| ho-lv-explain-job-backoff | explain | 26,048 OK | 7,376 NO (miss handleJobException) | 1,224 NO (miss handleJobException) | 791 NO (miss handleJobException) | skipped | skipped |
| ho-lv-locate-signed-url | locate | 14,602 NO (miss UrlGenerator.php, hasValidSignature, hasCorrectSignature, signatureHasNotExpired) | 6,298 NO (miss UrlGenerator.php, hasValidSignature, hasCorrectSignature, signatureHasNotExpired) | 1,322 OK | 1,032 OK | skipped | skipped |

## Settings

- grep_search emulation: 100 matches / 10,000 chars, lines cut at 250 chars; pattern = most selective keywords while the total stays under the match cap; files ordered by distinct keywords, non-test first, match count (generous to native).
- native-naive: top 3 files by visible match count, whole file capped at 2000 lines.
- native-ranged: ±60 lines around the best 4 matches (overlaps merged).
- kopt budgets: find 700, pack 2500, read 3000 tokens.
- index: reused, 3,114 files, 40,979 symbols.
- kirograph: outputs loaded from bench/competitors/results/kirograph-laravel.jsonl
- codegraph: outputs loaded from bench/competitors/results/codegraph-laravel.jsonl
- run duration: 1,001 ms.
