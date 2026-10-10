# kopt bench: django

Repo `django` @ `6.1.2` (`2212534bae39`) · 15 tasks · input = `search` · 3 chars/token · 2026-10-09T22:21:37.795Z

> Offline proxy: tokens = estimated tokens of tool outputs returned to the model for ONE exploration step.
> It is not a credit measurement. Savings must be confirmed by the online A/B (bench/ab) before being claimed.

## Summary per strategy

| strategy | tasks | found | file recall | symbol recall | def recall | median tok | mean tok | p90 tok | tok / found task | calls |
|---|---|---|---|---|---|---|---|---|---|---|
| native-naive | 15 | 7 (47%) | 77% | 63% | 61% | 43,715 | 39,002 | 65,803 | 83,575 | 3.5 |
| native-ranged | 15 | 8 (53%) | 77% | 67% | 54% | 6,737 | 6,132 | 8,352 | 11,497 | 4.5 |
| kopt-pack | 15 | 13 (87%) | 100% | 97% | 58% | 1,206 | 1,017 | 1,362 | 1,173 | 1.0 |
| kopt-hits+read | 15 | 7 (47%) | 89% | 74% | 61% | 861 | 1,127 | 1,877 | 2,415 | 3.0 |
| kirograph | 15 | 1 (7%) | 40% | 26% | 0% | 799 | 1,289 | 3,407 | 19,329 | 1.0 |
| codegraph | 15 | 8 (53%) | 90% | 81% | 62% | 8,317 | 8,102 | 8,330 | 15,192 | 1.0 |

`found` = every gold file path AND every gold symbol name appears in the output. `def recall` = the definition line
of the gold symbol was shown (stricter). `tok / found task` = all tokens spent (failures included) / tasks found.

## Pass-gated pairs (only tasks found by both)

| b vs a | tasks run | found by both | only a | only b | median b/a | geomean b/a | b cheaper |
|---|---|---|---|---|---|---|---|
| kopt-pack vs native-naive | 15 | 6 | 1 | 7 | 0.02× | 0.02× | 6/6 |
| kopt-pack vs native-ranged | 15 | 7 | 1 | 6 | 0.17× | 0.16× | 7/7 |
| kopt-hits+read vs native-naive | 15 | 3 | 4 | 4 | 0.04× | 0.04× | 3/3 |
| kopt-hits+read vs native-ranged | 15 | 4 | 4 | 3 | 0.24× | 0.21× | 4/4 |
| kopt-pack vs kirograph | 15 | 1 | 0 | 12 | 0.28× | 0.28× | 1/1 |
| kopt-pack vs codegraph | 15 | 7 | 1 | 6 | 0.11× | 0.09× | 7/7 |
| kopt-hits+read vs kirograph | 15 | 1 | 0 | 6 | 0.55× | 0.55× | 1/1 |
| kopt-hits+read vs codegraph | 15 | 4 | 4 | 3 | 0.13× | 0.13× | 4/4 |
| kirograph vs native-ranged | 15 | 1 | 7 | 0 | 0.62× | 0.62× | 1/1 |
| codegraph vs native-ranged | 15 | 5 | 3 | 3 | 1.04× | 1.36× | 1/5 |
| native-ranged vs native-naive | 15 | 5 | 2 | 3 | 0.13× | 0.17× | 5/5 |

## By task kind

| kind | strategy | tasks | found | median tok |
|---|---|---|---|---|
| locate | native-naive | 4 | 1 | 42,989 |
| locate | native-ranged | 4 | 1 | 7,716 |
| locate | kopt-pack | 4 | 4 | 1,299 |
| locate | kopt-hits+read | 4 | 3 | 1,152 |
| locate | kirograph | 4 | 0 | 813 |
| locate | codegraph | 4 | 2 | 8,317 |
| explain | native-naive | 4 | 2 | 37,585 |
| explain | native-ranged | 4 | 3 | 5,362 |
| explain | kopt-pack | 4 | 2 | 1,265 |
| explain | kopt-hits+read | 4 | 2 | 1,762 |
| explain | kirograph | 4 | 1 | 1,663 |
| explain | codegraph | 4 | 2 | 8,315 |
| usage | native-naive | 4 | 3 | 47,373 |
| usage | native-ranged | 4 | 2 | 5,210 |
| usage | kopt-pack | 4 | 4 | 729 |
| usage | kopt-hits+read | 4 | 1 | 608 |
| usage | kirograph | 4 | 0 | 702 |
| usage | codegraph | 4 | 1 | 8,314 |
| impact | native-naive | 3 | 1 | 43,715 |
| impact | native-ranged | 3 | 2 | 8,073 |
| impact | kopt-pack | 3 | 3 | 568 |
| impact | kopt-hits+read | 3 | 1 | 730 |
| impact | kirograph | 3 | 0 | 682 |
| impact | codegraph | 3 | 3 | 8,323 |

## Per task (tokens, found)

| task | kind | native-naive | native-ranged | kopt-pack | kopt-hits+read | kirograph | codegraph |
|---|---|---|---|---|---|---|---|
| dj-locate-db-cache-cull | locate | 48,894 NO (miss _base_set) | 6,737 NO (miss _base_set) | 1,377 OK | 970 NO (miss _base_set) | 732 NO (miss db.py, operations.py, _cull, _base_set, +1) | 8,330 NO (miss operations.py, _cull, _base_set, cache_key_culling_sql) |
| dj-locate-accept-language | locate | 48,259 NO (miss get_language_from_request) | 7,992 OK | 1,362 OK | 1,333 OK | 879 NO (miss parse_accept_lang_header) | 8,315 OK |
| dj-locate-test-shuffle | locate | 37,719 OK | 7,757 NO (miss shuffle_tests) | 1,236 OK | 794 OK | 1,040 NO (miss Shuffler, shuffle_tests) | 8,319 OK |
| dj-locate-session-vary-cookie | locate | 15,045 NO (miss cache.py, SessionMiddleware, process_response, patch_vary_headers) | 7,674 NO (miss cache.py, SessionMiddleware, process_response, patch_vary_headers) | 1,206 OK | 1,803 OK | 747 NO (miss middleware.py, cache.py, SessionMiddleware, process_response, +1) | 8,299 NO (miss cache.py) |
| dj-explain-migration-optimizer | explain | 31,689 NO (miss optimize_inner, reduce) | 5,219 OK | 1,283 OK | 1,647 OK | 802 NO (miss optimizer.py, base.py, MigrationOptimizer, optimize, +1) | 7,132 NO (miss base.py) |
| dj-explain-template-lookup | explain | 43,481 OK | 5,505 OK | 951 OK | 1,877 OK | 3,407 OK | 8,313 OK |
| dj-explain-password-upgrade | explain | 788 NO (miss hashers.py, check_password, verify_password, identify_hasher, +1) | 788 NO (miss hashers.py, check_password, verify_password, identify_hasher, +1) | 1,246 NO (miss identify_hasher) | 789 NO (miss verify_password, identify_hasher) | 2,307 NO (miss hashers.py, check_password, verify_password, identify_hasher, +1) | 8,317 NO (miss check_password, verify_password, identify_hasher) |
| dj-explain-autoreload-stat | explain | 46,394 OK | 8,352 OK | 1,291 NO (miss snapshot_files) | 3,547 NO (miss snapshot_files) | 1,019 NO (miss StatReloader, tick, snapshot_files) | 8,330 OK |
| dj-usage-add-new-csrf-cookie | usage | 6,602 OK | 3,485 OK | 661 OK | 354 OK | 680 NO (miss csrf.py, rotate_token, process_request) | 6,251 NO (miss process_request) |
| dj-usage-construct-instance | usage | 44,674 OK | 4,854 OK | 796 OK | 894 NO (miss _post_clean, BaseModelForm) | 724 NO (miss models.py, _post_clean, BaseModelForm) | 8,311 NO (miss BaseModelForm) |
| dj-usage-same-domain | usage | 65,803 NO (miss http.py, request.py, csrf.py, is_same_domain, +3) | 7,988 NO (miss http.py, request.py, csrf.py, is_same_domain, +3) | 1,314 OK | 861 NO (miss csrf.py, _origin_verified, _check_referer) | 632 NO (miss http.py, csrf.py, is_same_domain, validate_host, +2) | 8,317 NO (miss is_same_domain, validate_host) |
| dj-usage-resolve-callables | usage | 50,072 OK | 5,566 NO (miss _add_items) | 358 OK | 265 NO (miss query.py, related_descriptors.py, get_or_create, update_or_create, +1) | 4,203 NO (miss utils.py, query.py, related_descriptors.py, get_or_create, +2) | 8,332 OK |
| dj-impact-naive-now | impact | 23,996 OK | 2,892 OK | 568 OK | 262 NO (miss _check_fix_default_value) | 676 NO (miss _check_if_value_fixed, _check_fix_default_value) | 8,324 OK |
| dj-impact-same-field-operation | impact | 77,892 NO (miss fields.py, is_same_field_operation, AddField, AlterField) | 9,094 NO (miss fields.py, is_same_field_operation, AddField, AlterField) | 1,113 OK | 730 OK | 682 NO (miss fields.py, is_same_field_operation, AddField, AlterField) | 8,323 OK |
| dj-impact-migrations-module | impact | 43,715 NO (miss basedir) | 8,073 OK | 488 OK | 778 NO (miss questioner.py, writer.py, ask_initial, basedir) | 799 NO (miss questioner.py, load_disk, ask_initial, basedir) | 8,319 OK |

## Settings

- grep_search emulation: 100 matches / 10,000 chars, lines cut at 250 chars; pattern = most selective keywords while the total stays under the match cap; files ordered by distinct keywords, non-test first, match count (generous to native).
- native-naive: top 3 files by visible match count, whole file capped at 2000 lines.
- native-ranged: ±60 lines around the best 4 matches (overlaps merged).
- kopt budgets: find 700, pack 2500, read 3000 tokens.
- index: reused, 2,964 files, 51,183 symbols.
- kirograph: outputs loaded from bench/competitors/results/kirograph-django.jsonl
- codegraph: outputs loaded from bench/competitors/results/codegraph-django.jsonl
- run duration: 15,170 ms.
