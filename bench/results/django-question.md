# kopt bench: django-question

Repo `django` @ `6.1.2` (`2212534bae39`) · 15 tasks · input = `question` · 3 chars/token · 2026-10-09T11:37:47.292Z

> Offline proxy: tokens = estimated tokens of tool outputs returned to the model for ONE exploration step.
> It is not a credit measurement. Savings must be confirmed by the online A/B (bench/ab) before being claimed.

## Summary per strategy

| strategy | tasks | found | file recall | symbol recall | def recall | median tok | mean tok | p90 tok | tok / found task | calls |
|---|---|---|---|---|---|---|---|---|---|---|
| native-naive | 15 | 4 (27%) | 63% | 44% | 36% | 45,933 | 46,714 | 65,961 | 175,178 | 3.8 |
| native-ranged | 15 | 4 (27%) | 63% | 47% | 38% | 7,388 | 7,222 | 8,999 | 27,083 | 4.7 |
| kopt-pack | 15 | 5 (33%) | 79% | 76% | 52% | 824 | 903 | 2,218 | 2,708 | 1.0 |
| kopt-hits+read | 15 | 2 (13%) | 79% | 59% | 53% | 1,102 | 1,211 | 1,696 | 9,084 | 3.0 |

`found` = every gold file path AND every gold symbol name appears in the output. `def recall` = the definition line
of the gold symbol was shown (stricter). `tok / found task` = all tokens spent (failures included) / tasks found.

## Pass-gated pairs (only tasks found by both)

| b vs a | tasks run | found by both | only a | only b | median b/a | geomean b/a | b cheaper |
|---|---|---|---|---|---|---|---|
| kopt-pack vs native-naive | 15 | 2 | 2 | 3 | 0.01× | 0.01× | 2/2 |
| kopt-pack vs native-ranged | 15 | 2 | 2 | 3 | 0.07× | 0.07× | 2/2 |
| kopt-hits+read vs native-naive | 15 | 1 | 3 | 1 | 0.04× | 0.04× | 1/1 |
| kopt-hits+read vs native-ranged | 15 | 1 | 3 | 1 | 0.31× | 0.31× | 1/1 |
| native-ranged vs native-naive | 15 | 3 | 1 | 1 | 0.13× | 0.14× | 3/3 |

## By task kind

| kind | strategy | tasks | found | median tok |
|---|---|---|---|---|
| locate | native-naive | 4 | 1 | 44,118 |
| locate | native-ranged | 4 | 0 | 7,191 |
| locate | kopt-pack | 4 | 2 | 1,036 |
| locate | kopt-hits+read | 4 | 1 | 1,145 |
| explain | native-naive | 4 | 2 | 44,991 |
| explain | native-ranged | 4 | 2 | 7,736 |
| explain | kopt-pack | 4 | 1 | 993 |
| explain | kopt-hits+read | 4 | 1 | 1,621 |
| usage | native-naive | 4 | 0 | 58,026 |
| usage | native-ranged | 4 | 0 | 7,816 |
| usage | kopt-pack | 4 | 1 | 760 |
| usage | kopt-hits+read | 4 | 0 | 828 |
| impact | native-naive | 3 | 1 | 33,839 |
| impact | native-ranged | 3 | 2 | 6,597 |
| impact | kopt-pack | 3 | 1 | 335 |
| impact | kopt-hits+read | 3 | 0 | 903 |

## Per task (tokens, found)

| task | kind | native-naive | native-ranged | kopt-pack | kopt-hits+read |
|---|---|---|---|---|---|
| dj-locate-db-cache-cull | locate | 65,961 NO (miss operations.py, _base_set, cache_key_culling_sql) | 7,006 NO (miss operations.py, _cull, _base_set, cache_key_culling_sql) | 991 NO (miss operations.py, cache_key_culling_sql) | 917 NO (miss operations.py, cache_key_culling_sql) |
| dj-locate-accept-language | locate | 24,066 NO (miss trans_real.py, get_language_from_request, parse_accept_lang_header) | 7,376 NO (miss trans_real.py, get_language_from_request, parse_accept_lang_header) | 1,080 OK | 1,360 OK |
| dj-locate-test-shuffle | locate | 45,933 OK | 6,111 NO (miss shuffle_tests) | 489 NO (miss shuffle_tests) | 1,188 NO (miss shuffle_tests) |
| dj-locate-session-vary-cookie | locate | 42,302 NO (miss middleware.py) | 9,294 NO (miss middleware.py, SessionMiddleware, process_response) | 2,218 OK | 1,102 NO (miss SessionMiddleware) |
| dj-explain-migration-optimizer | explain | 59,173 NO (miss base.py, MigrationOptimizer, optimize, optimize_inner, +1) | 8,999 NO (miss base.py, MigrationOptimizer, optimize_inner) | 2,460 NO (miss optimizer.py, base.py, MigrationOptimizer, optimize, +1) | 1,425 NO (miss optimizer.py, base.py, MigrationOptimizer, optimize, +1) |
| dj-explain-template-lookup | explain | 43,481 OK | 5,505 OK | 238 OK | 1,696 OK |
| dj-explain-password-upgrade | explain | 31,181 NO (miss hashers.py, check_password, verify_password, identify_hasher, +1) | 7,014 NO (miss hashers.py, check_password, verify_password, identify_hasher, +1) | 843 NO (miss identify_hasher) | 1,546 NO (miss identify_hasher) |
| dj-explain-autoreload-stat | explain | 46,500 OK | 8,458 OK | 1,142 NO (miss get_reloader, StatReloader, tick, snapshot_files) | 2,426 NO (miss get_reloader, StatReloader, tick, snapshot_files) |
| dj-usage-add-new-csrf-cookie | usage | 50,171 NO (miss get_token, rotate_token, process_request) | 7,943 NO (miss process_request) | 696 OK | 893 NO (miss get_token) |
| dj-usage-construct-instance | usage | 74,341 NO (miss _post_clean, BaseModelForm) | 7,689 NO (miss _post_clean) | 824 NO (miss _post_clean) | 763 NO (miss _post_clean) |
| dj-usage-same-domain | usage | 65,803 NO (miss http.py, request.py, csrf.py, is_same_domain, +3) | 7,988 NO (miss http.py, request.py, csrf.py, is_same_domain, +3) | 938 NO (miss csrf.py) | 989 NO (miss csrf.py, _origin_verified, _check_referer) |
| dj-usage-resolve-callables | usage | 50,249 NO (miss get_or_create, update_or_create, _add_items) | 7,388 NO (miss get_or_create, update_or_create, _add_items) | 287 NO (miss query.py, related_descriptors.py, _add_items) | 695 NO (miss query.py, related_descriptors.py, get_or_create, update_or_create, +1) |
| dj-impact-naive-now | impact | 23,996 OK | 2,892 OK | 308 OK | 903 NO (miss _check_fix_default_value) |
| dj-impact-same-field-operation | impact | 33,839 NO (miss fields.py, is_same_field_operation, AddField, AlterField) | 6,597 NO (miss fields.py, is_same_field_operation, AddField, AlterField) | 690 NO (miss AddField) | 1,528 NO (miss AddField) |
| dj-impact-migrations-module | impact | 43,715 NO (miss basedir) | 8,073 OK | 335 NO (miss questioner.py, writer.py) | 737 NO (miss questioner.py, writer.py, ask_initial, basedir) |

## Settings

- grep_search emulation: 100 matches / 10,000 chars, lines cut at 250 chars; pattern = most selective keywords while the total stays under the match cap; files ordered by distinct keywords, non-test first, match count (generous to native).
- native-naive: top 3 files by visible match count, whole file capped at 2000 lines.
- native-ranged: ±60 lines around the best 4 matches (overlaps merged).
- kopt budgets: find 700, pack 2500, read 2000 tokens.
- index: reused in 0 ms, 2,964 files, 50,978 symbols.
- run duration: 10,948 ms.
