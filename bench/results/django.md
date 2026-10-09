# kopt bench: django

Repo `django` @ `6.1.2` (`2212534bae39`) · 15 tasks · input = `search` · 3 chars/token · 2026-10-09T09:44:21.509Z

> Offline proxy: tokens = estimated tokens of tool outputs returned to the model for ONE exploration step.
> It is not a credit measurement. Savings must be confirmed by the online A/B (bench/ab) before being claimed.

## Summary per strategy

| strategy | tasks | found | file recall | symbol recall | def recall | median tok | mean tok | p90 tok | tok / found task | calls |
|---|---|---|---|---|---|---|---|---|---|---|
| native-naive | 15 | 7 (47%) | 77% | 63% | 61% | 43,715 | 39,002 | 65,803 | 83,575 | 3.5 |
| native-ranged | 15 | 8 (53%) | 77% | 67% | 54% | 6,737 | 6,132 | 8,352 | 11,497 | 4.5 |
| kopt-pack | 15 | 8 (53%) | 89% | 89% | 58% | 627 | 615 | 1,053 | 1,153 | 1.0 |
| kopt-hits+read | 15 | 5 (33%) | 89% | 68% | 63% | 729 | 910 | 1,734 | 2,731 | 3.0 |

`found` = every gold file path AND every gold symbol name appears in the output. `def recall` = the definition line
of the gold symbol was shown (stricter). `tok / found task` = all tokens spent (failures included) / tasks found.

## Pass-gated pairs (only tasks found by both)

| b vs a | tasks run | found by both | only a | only b | median b/a | geomean b/a | b cheaper |
|---|---|---|---|---|---|---|---|
| kopt-pack vs native-naive | 15 | 5 | 2 | 3 | 0.02× | 0.01× | 5/5 |
| kopt-pack vs native-ranged | 15 | 6 | 2 | 2 | 0.09× | 0.08× | 6/6 |
| kopt-hits+read vs native-naive | 15 | 2 | 5 | 3 | 0.03× | 0.03× | 2/2 |
| kopt-hits+read vs native-ranged | 15 | 3 | 5 | 2 | 0.30× | 0.25× | 3/3 |
| native-ranged vs native-naive | 15 | 5 | 2 | 3 | 0.13× | 0.17× | 5/5 |

## By task kind

| kind | strategy | tasks | found | median tok |
|---|---|---|---|---|
| locate | native-naive | 4 | 1 | 42,989 |
| locate | native-ranged | 4 | 1 | 7,716 |
| locate | kopt-pack | 4 | 3 | 1,052 |
| locate | kopt-hits+read | 4 | 3 | 1,091 |
| explain | native-naive | 4 | 2 | 37,585 |
| explain | native-ranged | 4 | 3 | 5,362 |
| explain | kopt-pack | 4 | 2 | 530 |
| explain | kopt-hits+read | 4 | 2 | 1,179 |
| usage | native-naive | 4 | 3 | 47,373 |
| usage | native-ranged | 4 | 2 | 5,210 |
| usage | kopt-pack | 4 | 2 | 466 |
| usage | kopt-hits+read | 4 | 0 | 721 |
| impact | native-naive | 3 | 1 | 43,715 |
| impact | native-ranged | 3 | 2 | 8,073 |
| impact | kopt-pack | 3 | 1 | 323 |
| impact | kopt-hits+read | 3 | 0 | 705 |

## Per task (tokens, found)

| task | kind | native-naive | native-ranged | kopt-pack | kopt-hits+read |
|---|---|---|---|---|---|
| dj-locate-db-cache-cull | locate | 48,894 NO (miss _base_set) | 6,737 NO (miss _base_set) | 1,050 NO (miss _base_set) | 904 NO (miss _base_set) |
| dj-locate-accept-language | locate | 48,259 NO (miss get_language_from_request) | 7,992 OK | 1,053 OK | 1,277 OK |
| dj-locate-test-shuffle | locate | 37,719 OK | 7,757 NO (miss shuffle_tests) | 627 OK | 715 OK |
| dj-locate-session-vary-cookie | locate | 15,045 NO (miss cache.py, SessionMiddleware, process_response, patch_vary_headers) | 7,674 NO (miss cache.py, SessionMiddleware, process_response, patch_vary_headers) | 1,385 OK | 1,734 OK |
| dj-explain-migration-optimizer | explain | 31,689 NO (miss optimize_inner, reduce) | 5,219 OK | 584 OK | 1,562 OK |
| dj-explain-template-lookup | explain | 43,481 OK | 5,505 OK | 234 OK | 1,800 OK |
| dj-explain-password-upgrade | explain | 788 NO (miss hashers.py, check_password, verify_password, identify_hasher, +1) | 788 NO (miss hashers.py, check_password, verify_password, identify_hasher, +1) | 476 NO (miss verify_password, identify_hasher) | 652 NO (miss verify_password, identify_hasher) |
| dj-explain-autoreload-stat | explain | 46,394 OK | 8,352 OK | 679 NO (miss snapshot_files) | 795 NO (miss snapshot_files) |
| dj-usage-add-new-csrf-cookie | usage | 6,602 OK | 3,485 OK | 251 OK | 713 NO (miss get_token) |
| dj-usage-construct-instance | usage | 44,674 OK | 4,854 OK | 681 OK | 872 NO (miss _post_clean, BaseModelForm) |
| dj-usage-same-domain | usage | 65,803 NO (miss http.py, request.py, csrf.py, is_same_domain, +3) | 7,988 NO (miss http.py, request.py, csrf.py, is_same_domain, +3) | 779 NO (miss csrf.py) | 729 NO (miss csrf.py, _origin_verified, _check_referer) |
| dj-usage-resolve-callables | usage | 50,072 OK | 5,566 NO (miss _add_items) | 229 NO (miss query.py, related_descriptors.py, _add_items) | 265 NO (miss query.py, related_descriptors.py, get_or_create, update_or_create, +1) |
| dj-impact-naive-now | impact | 23,996 OK | 2,892 OK | 162 OK | 217 NO (miss _check_if_value_fixed, _check_fix_default_value) |
| dj-impact-same-field-operation | impact | 77,892 NO (miss fields.py, is_same_field_operation, AddField, AlterField) | 9,094 NO (miss fields.py, is_same_field_operation, AddField, AlterField) | 710 NO (miss AddField) | 717 NO (miss AddField) |
| dj-impact-migrations-module | impact | 43,715 NO (miss basedir) | 8,073 OK | 323 NO (miss questioner.py, writer.py) | 705 NO (miss questioner.py, writer.py, ask_initial, basedir) |

## Settings

- grep_search emulation: 100 matches / 10,000 chars, lines cut at 250 chars; pattern = most selective keywords while the total stays under the match cap; files ordered by distinct keywords, non-test first, match count (generous to native).
- native-naive: top 3 files by visible match count, whole file capped at 2000 lines.
- native-ranged: ±60 lines around the best 4 matches (overlaps merged).
- kopt budgets: find 700, pack 2500, read 2000 tokens.
- index: reused in 0 ms, 2,964 files, 50,978 symbols.
- run duration: 6,329 ms.
