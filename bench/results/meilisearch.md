# kopt bench: meilisearch

Repo `meilisearch` @ `v1.54.3` (`7ebd97e38c36`) · 12 tasks · input = `search` · 3 chars/token · 2026-10-09T22:38:36.388Z

> Offline proxy: tokens = estimated tokens of tool outputs returned to the model for ONE exploration step.
> It is not a credit measurement. Savings must be confirmed by the online A/B (bench/ab) before being claimed.

## Summary per strategy

| strategy | tasks | found | file recall | symbol recall | def recall | median tok | mean tok | p90 tok | tok / found task | calls |
|---|---|---|---|---|---|---|---|---|---|---|
| native-naive | 12 | 7 (58%) | 67% | 71% | 49% | 28,385 | 31,261 | 49,448 | 53,591 | 3.8 |
| native-ranged | 12 | 3 (25%) | 67% | 53% | 35% | 6,194 | 6,448 | 7,821 | 25,791 | 3.9 |
| kopt-pack | 12 | 7 (58%) | 78% | 77% | 41% | 1,325 | 1,286 | 1,391 | 2,204 | 1.0 |
| kopt-hits+read | 12 | 4 (33%) | 70% | 65% | 37% | 832 | 1,113 | 1,157 | 3,339 | 3.0 |
| kirograph | 12 | 0 (0%) | 36% | 9% | 0% | 1,058 | 1,447 | 2,770 | n/a | 1.0 |
| codegraph | 12 | 5 (42%) | 69% | 68% | 32% | 8,318 | 8,057 | 8,327 | 19,337 | 1.0 |

`found` = every gold file path AND every gold symbol name appears in the output. `def recall` = the definition line
of the gold symbol was shown (stricter). `tok / found task` = all tokens spent (failures included) / tasks found.

## Pass-gated pairs (only tasks found by both)

| b vs a | tasks run | found by both | only a | only b | median b/a | geomean b/a | b cheaper |
|---|---|---|---|---|---|---|---|
| kopt-pack vs native-naive | 12 | 3 | 4 | 4 | 0.08× | 0.06× | 3/3 |
| kopt-pack vs native-ranged | 12 | 3 | 0 | 4 | 0.28× | 0.27× | 3/3 |
| kopt-hits+read vs native-naive | 12 | 1 | 6 | 3 | 0.06× | 0.06× | 1/1 |
| kopt-hits+read vs native-ranged | 12 | 1 | 2 | 3 | 0.18× | 0.18× | 1/1 |
| kopt-pack vs kirograph | 12 | 0 | 0 | 7 | n/a | n/a | 0/0 |
| kopt-pack vs codegraph | 12 | 4 | 1 | 3 | 0.16× | 0.16× | 4/4 |
| kopt-hits+read vs kirograph | 12 | 0 | 0 | 4 | n/a | n/a | 0/0 |
| kopt-hits+read vs codegraph | 12 | 2 | 3 | 2 | 0.09× | 0.09× | 2/2 |
| kirograph vs native-ranged | 12 | 0 | 3 | 0 | n/a | n/a | 0/0 |
| codegraph vs native-ranged | 12 | 2 | 1 | 3 | 1.93× | 1.92× | 0/2 |
| native-ranged vs native-naive | 12 | 3 | 4 | 0 | 0.31× | 0.21× | 3/3 |

## By task kind

| kind | strategy | tasks | found | median tok |
|---|---|---|---|---|
| locate | native-naive | 4 | 1 | 31,264 |
| locate | native-ranged | 4 | 1 | 6,459 |
| locate | kopt-pack | 4 | 4 | 1,340 |
| locate | kopt-hits+read | 4 | 4 | 757 |
| locate | kirograph | 4 | 0 | 955 |
| locate | codegraph | 4 | 2 | 8,312 |
| explain | native-naive | 3 | 1 | 27,555 |
| explain | native-ranged | 3 | 0 | 7,106 |
| explain | kopt-pack | 3 | 1 | 1,334 |
| explain | kopt-hits+read | 3 | 0 | 860 |
| explain | kirograph | 3 | 0 | 1,335 |
| explain | codegraph | 3 | 0 | 8,298 |
| usage | native-naive | 3 | 3 | 22,871 |
| usage | native-ranged | 3 | 1 | 5,146 |
| usage | kopt-pack | 3 | 1 | 1,260 |
| usage | kopt-hits+read | 3 | 0 | 971 |
| usage | kirograph | 3 | 0 | 1,068 |
| usage | codegraph | 3 | 2 | 8,326 |
| impact | native-naive | 2 | 2 | 39,712 |
| impact | native-ranged | 2 | 1 | 5,091 |
| impact | kopt-pack | 2 | 1 | 1,235 |
| impact | kopt-hits+read | 2 | 0 | 2,312 |
| impact | kirograph | 2 | 0 | 1,809 |
| impact | codegraph | 2 | 1 | 8,327 |

## Per task (tokens, found)

| task | kind | native-naive | native-ranged | kopt-pack | kopt-hits+read | kirograph | codegraph |
|---|---|---|---|---|---|---|---|
| ms-locate-tenant-token | locate | 20,726 NO (miss mod.rs, authenticate_tenant_token, tenant_token_validation, extract_key_id) | 6,705 NO (miss mod.rs, authenticate_tenant_token, tenant_token_validation, extract_key_id) | 1,249 OK | 674 OK | 862 NO (miss mod.rs, authenticate_tenant_token, tenant_token_validation, extract_key_id) | 5,282 NO (miss mod.rs, authenticate_tenant_token, tenant_token_validation, extract_key_id) |
| ms-locate-filter-precedence | locate | 41,802 NO (miss parse_or, parse_and, parse_not) | 5,705 NO (miss parse_or, parse_and, parse_not) | 1,352 OK | 804 OK | 1,047 NO (miss parse_or, parse_and, parse_not) | 8,317 OK |
| ms-locate-disabled-typos | locate | 49,448 NO (miss disabled_typos_terms.rs) | 7,821 NO (miss disabled_typos_terms.rs, is_exact) | 1,327 OK | 709 OK | 824 NO (miss disabled_typos_terms.rs, is_exact, DisabledTyposTerms) | 8,318 OK |
| ms-locate-index-eviction | locate | 18,816 OK | 6,212 OK | 1,444 OK | 1,145 OK | 3,456 NO (miss index_map.rs, lru.rs, create, insert) | 8,307 NO (miss lru.rs) |
| ms-explain-autobatch | explain | 53,895 NO (miss autobatcher.rs, create_batch.rs, accumulate, create_next_batch_unprioritized) | 11,543 NO (miss autobatcher.rs, create_batch.rs, accumulate, BatchKind, +1) | 1,332 OK | 1,157 NO (miss create_next_batch_unprioritized) | 977 NO (miss autobatch, accumulate, BatchKind, create_next_batch_unprioritized) | 8,318 NO (miss autobatcher.rs, autobatch, accumulate, BatchKind) |
| ms-explain-dynamic-rules | explain | 15,806 NO (miss mod.rs, condition.rs, action.rs, resolve_actions, +3) | 7,106 NO (miss mod.rs, condition.rs, action.rs, resolve_actions, +3) | 1,391 NO (miss condition.rs, action.rs, active_rules_for_query, apply_time_conditions, +1) | 667 NO (miss condition.rs, action.rs, active_rules_for_query, apply_time_conditions, +1) | 2,468 NO (miss condition.rs, action.rs, resolve_actions, active_rules_for_query, +2) | 8,249 NO (miss mod.rs, condition.rs, action.rs, resolve_actions, +3) |
| ms-explain-bucket-sort | explain | 27,555 OK | 6,176 NO (miss maybe_add_to_results) | 1,334 NO (miss ranking_rules.rs) | 860 NO (miss ranking_rules.rs) | 1,335 NO (miss bucket_sort.rs, ranking_rules.rs, bucket_sort, maybe_add_to_results, +2) | 8,298 NO (miss bucket_sort.rs, maybe_add_to_results) |
| ms-usage-is-exact | usage | 29,215 OK | 5,146 NO (miss extract_document_change, extract_document_from_settings_change) | 947 NO (miss extract_word_docids.rs, extract_word_docids.rs, extract_word_docids, extract_document_change, +1) | 592 NO (miss extract_word_docids.rs, extract_word_docids.rs, extract_word_docids, extract_document_change, +1) | 533 NO (miss extract_word_docids.rs, extract_word_docids.rs, mod.rs, extract_word_docids, +3) | 8,326 OK |
| ms-usage-close-for-resize | usage | 15,580 OK | 4,767 OK | 1,323 OK | 971 NO (miss rollback_index) | 1,176 NO (miss resize_index, close_index, rollback_index) | 8,283 OK |
| ms-usage-facet-bounds | usage | 22,871 OK | 6,010 NO (miss evaluate_operator, explore_facet_levels) | 1,260 NO (miss evaluate_operator, explore_facet_levels) | 1,153 NO (miss condition.rs, index_filter.rs, apply_time_conditions, apply_filter_conditions, +3) | 1,068 NO (miss condition.rs, apply_time_conditions, apply_filter_conditions, resolve_constraints, +2) | 8,333 NO (miss evaluate_operator, explore_facet_levels) |
| ms-impact-bucket-sort | impact | 43,839 OK | 3,917 OK | 1,183 OK | 4,107 NO (miss execute_vector_search) | 848 NO (miss mod.rs, execute_vector_search, execute_search) | 8,327 OK |
| ms-impact-search-rules | impact | 35,584 OK | 6,264 NO (miss legacy_search_with_post) | 1,287 NO (miss search.rs, facet_search.rs, similar.rs, legacy_search_with_url_query, +3) | 517 NO (miss search.rs, facet_search.rs, similar.rs, legacy_search_with_url_query, +3) | 2,770 NO (miss lib.rs, search.rs, facet_search.rs, similar.rs, +3) | 8,327 NO (miss similar.rs, legacy_search_with_url_query, legacy_search_with_post) |

## Settings

- grep_search emulation: 100 matches / 10,000 chars, lines cut at 250 chars; pattern = most selective keywords while the total stays under the match cap; files ordered by distinct keywords, non-test first, match count (generous to native).
- native-naive: top 3 files by visible match count, whole file capped at 2000 lines.
- native-ranged: ±60 lines around the best 4 matches (overlaps merged).
- kopt budgets: find 700, pack 2500, read 3000 tokens.
- index: reused, 715 files, 18,280 symbols.
- kirograph: outputs loaded from bench/competitors/results/kirograph-meilisearch.jsonl
- codegraph: outputs loaded from bench/competitors/results/codegraph-meilisearch.jsonl
- run duration: 3,713 ms.
