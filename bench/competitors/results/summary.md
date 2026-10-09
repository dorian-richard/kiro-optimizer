# Competitor benchmark: summary

Generated 2026-10-09 by `node bench/competitors/score.mjs` from `bench/competitors/results/`. One tool call per task (the first exploration step of an agent), scored with the `kopt bench` metrics (tokens = characters / 3, recall of the verified gold files and symbols). See `bench/competitors/README.md` for the protocol and the fairness notes. The `kopt bench` rows are copied from `bench/results/` and were measured on the host, not in the container.

## django

python · 6.1.2 · 15 tasks

| tool | version | mode | index time | index size | fixed overhead per request | median query | errors |
|---|---|---|---|---|---|---|---|
| codegraph | 1.6.2 | default | 53.2 s | 181 MB | 2,815 tok (1 tools) | 192 ms | 0 |
| kirograph | 1.4.0 | default | 1040.9 s | 268 MB | 1,473 tok (7 tools) | 967 ms | 0 |
| kopt | 0.1.0 | default | 7.3 s | 54 MB | 1,062 tok (6 tools) | 140 ms | 0 |

### django, input = `search`

| strategy | source | found | file recall | symbol recall | def recall | median tok | p90 tok | tokens / found task | calls |
|---|---|---|---|---|---|---|---|---|---|
| codegraph | container | 8/15 | 90 % | 81 % | 62 % | 8,317 | 8,330 | 15,192 | 1.0 |
| kirograph | container | 0/2 | 50 % | 17 % | 0 % | 886 | 1,040 | - | 1.0 |
| kopt | container | 8/15 | 89 % | 87 % | 58 % | 626 | 1,053 | 1,143 | 1.0 |
| native-naive | kopt bench 2026-10-09 | 7/15 | 77 % | 63 % | 61 % | 43,715 | 65,803 | 83,575 | 3.5 |
| native-ranged | kopt bench 2026-10-09 | 8/15 | 77 % | 67 % | 54 % | 6,737 | 8,352 | 11,497 | 4.5 |
| kopt-pack | kopt bench 2026-10-09 | 8/15 | 89 % | 89 % | 58 % | 627 | 1,053 | 1,153 | 1.0 |
| kopt-hits+read | kopt bench 2026-10-09 | 5/15 | 89 % | 68 % | 63 % | 729 | 1,734 | 2,731 | 3.0 |

Pass-gated pairs (tokens b / a over tasks found by both; < 1 means b is cheaper):

| a | b | found by both | only a | only b | median b/a | geo-mean b/a |
|---|---|---|---|---|---|---|
| kopt-pack | codegraph | 4/15 | 4 | 4 | 24.40 | 20.91 |
| native-ranged | codegraph | 5/15 | 3 | 3 | 1.04 | 1.36 |
| kopt-pack | kirograph | 0/2 | 1 | 0 | - | - |
| native-ranged | kirograph | 0/2 | 0 | 0 | - | - |
| kopt-pack | kopt | 8/15 | 0 | 0 | 1.00 | 1.00 |
| native-ranged | kopt | 6/15 | 2 | 2 | 0.09 | 0.08 |

| task | kind | codegraph | kirograph | kopt | native-ranged | kopt-pack |
|---|---|---|---|---|---|---|
| dj-locate-db-cache-cull | locate | miss 8,330 | miss 732 | miss 1,050 | miss 6,737 | miss 1,050 |
| dj-locate-accept-language | locate | found 8,315 | - | found 1,053 | found 7,992 | found 1,053 |
| dj-locate-test-shuffle | locate | found 8,319 | miss 1,040 | found 626 | miss 7,757 | found 627 |
| dj-locate-session-vary-cookie | locate | miss 8,299 | - | found 1,385 | miss 7,674 | found 1,385 |
| dj-explain-migration-optimizer | explain | miss 7,132 | - | found 584 | found 5,219 | found 584 |
| dj-explain-template-lookup | explain | found 8,313 | - | found 234 | found 5,505 | found 234 |
| dj-explain-password-upgrade | explain | miss 8,317 | - | miss 465 | miss 788 | miss 476 |
| dj-explain-autoreload-stat | explain | found 8,330 | - | miss 679 | found 8,352 | miss 679 |
| dj-usage-add-new-csrf-cookie | usage | miss 6,251 | - | found 251 | found 3,485 | found 251 |
| dj-usage-construct-instance | usage | miss 8,311 | - | found 681 | found 4,854 | found 681 |
| dj-usage-same-domain | usage | miss 8,317 | - | miss 775 | miss 7,988 | miss 779 |
| dj-usage-resolve-callables | usage | found 8,332 | - | miss 229 | miss 5,566 | miss 229 |
| dj-impact-naive-now | impact | found 8,324 | - | found 162 | found 2,892 | found 162 |
| dj-impact-same-field-operation | impact | found 8,323 | - | miss 645 | miss 9,094 | miss 710 |
| dj-impact-migrations-module | impact | found 8,319 | - | miss 323 | found 8,073 | miss 323 |

### django, input = `question`

| strategy | source | found | file recall | symbol recall | def recall | median tok | p90 tok | tokens / found task | calls |
|---|---|---|---|---|---|---|---|---|---|
| codegraph | container | 8/15 | 69 % | 57 % | 36 % | 8,317 | 8,330 | 15,218 | 1.0 |
| kopt | container | 5/15 | 79 % | 76 % | 52 % | 824 | 2,218 | 2,710 | 1.0 |
| native-naive | kopt bench 2026-10-09 | 5/15 | 60 % | 44 % | 38 % | 45,933 | 65,803 | 132,750 | 3.8 |
| native-ranged | kopt bench 2026-10-09 | 5/15 | 60 % | 49 % | 38 % | 7,006 | 8,458 | 20,304 | 4.5 |
| kopt-pack | kopt bench 2026-10-09 | 4/15 | 76 % | 65 % | 40 % | 696 | 1,344 | 2,996 | 1.0 |
| kopt-hits+read | kopt bench 2026-10-09 | 1/15 | 76 % | 46 % | 42 % | 917 | 1,714 | 16,123 | 3.0 |

Pass-gated pairs (tokens b / a over tasks found by both; < 1 means b is cheaper):

| a | b | found by both | only a | only b | median b/a | geo-mean b/a |
|---|---|---|---|---|---|---|
| kopt-pack | codegraph | 3/15 | 1 | 5 | 34.95 | 26.70 |
| native-ranged | codegraph | 4/15 | 1 | 4 | 1.46 | 1.38 |
| kopt-pack | kopt | 3/15 | 1 | 2 | 1.00 | 1.21 |
| native-ranged | kopt | 2/15 | 3 | 3 | 0.05 | 0.05 |

| task | kind | codegraph | kopt | native-ranged | kopt-pack |
|---|---|---|---|---|---|
| dj-locate-db-cache-cull | locate | miss 8,330 | miss 990 | miss 7,006 | miss 991 |
| dj-locate-accept-language | locate | found 8,318 | found 1,080 | miss 4,962 | miss 865 |
| dj-locate-test-shuffle | locate | found 8,313 | miss 487 | miss 6,111 | miss 489 |
| dj-locate-session-vary-cookie | locate | miss 8,319 | found 2,218 | miss 3,545 | miss 577 |
| dj-explain-migration-optimizer | explain | miss 7,486 | miss 2,469 | miss 8,999 | miss 2,479 |
| dj-explain-template-lookup | explain | found 8,317 | found 238 | found 5,505 | found 238 |
| dj-explain-password-upgrade | explain | miss 8,331 | miss 843 | miss 8,191 | miss 1,344 |
| dj-explain-autoreload-stat | explain | miss 8,322 | miss 1,145 | found 8,458 | miss 1,142 |
| dj-usage-add-new-csrf-cookie | usage | miss 6,509 | found 696 | miss 7,943 | found 696 |
| dj-usage-construct-instance | usage | found 8,314 | miss 824 | found 4,854 | found 738 |
| dj-usage-same-domain | usage | miss 8,330 | miss 938 | miss 7,988 | miss 938 |
| dj-usage-resolve-callables | usage | found 8,238 | miss 287 | miss 7,388 | miss 287 |
| dj-impact-naive-now | impact | found 8,320 | found 308 | found 5,901 | found 172 |
| dj-impact-same-field-operation | impact | found 8,294 | miss 690 | miss 6,597 | miss 696 |
| dj-impact-migrations-module | impact | found 8,006 | miss 335 | found 8,073 | miss 332 |

## spring-framework

java · v7.0.9 · 15 tasks

| tool | version | mode | index time | index size | fixed overhead per request | median query | errors |
|---|---|---|---|---|---|---|---|
| codegraph | 1.6.2 | default | 138.5 s | 863 MB | 2,815 tok (1 tools) | 866 ms | 0 |

### spring-framework, input = `search`

| strategy | source | found | file recall | symbol recall | def recall | median tok | p90 tok | tokens / found task | calls |
|---|---|---|---|---|---|---|---|---|---|
| codegraph | container | 8/15 | 80 % | 76 % | 47 % | 8,307 | 8,324 | 14,584 | 1.0 |
| native-naive | kopt bench 2026-10-09 | 9/15 | 82 % | 71 % | 63 % | 19,851 | 40,375 | 38,303 | 3.8 |
| native-ranged | kopt bench 2026-10-09 | 8/15 | 82 % | 70 % | 57 % | 7,378 | 9,517 | 14,080 | 4.2 |
| kopt-pack | kopt bench 2026-10-09 | 5/15 | 72 % | 75 % | 43 % | 776 | 1,363 | 2,503 | 1.0 |
| kopt-hits+read | kopt bench 2026-10-09 | 5/15 | 74 % | 59 % | 52 % | 1,436 | 2,425 | 4,358 | 3.0 |

Pass-gated pairs (tokens b / a over tasks found by both; < 1 means b is cheaper):

| a | b | found by both | only a | only b | median b/a | geo-mean b/a |
|---|---|---|---|---|---|---|
| kopt-pack | codegraph | 5/15 | 0 | 3 | 14.54 | 13.10 |
| native-ranged | codegraph | 6/15 | 2 | 2 | 1.13 | 1.08 |

| task | kind | codegraph | native-ranged | kopt-pack |
|---|---|---|---|---|
| sf-locate-retry-loop | locate | miss 8,320 | miss 8,971 | miss 1,041 |
| sf-locate-api-version | locate | miss 8,307 | miss 9,466 | miss 1,363 |
| sf-locate-sqlstate-lock | locate | found 8,028 | miss 6,511 | miss 499 |
| sf-locate-advice-order | locate | found 3,938 | found 7,360 | found 805 |
| sf-explain-concurrency-limit | explain | found 8,321 | found 9,115 | miss 813 |
| sf-explain-retryable | explain | miss 7,384 | miss 7,682 | miss 2,168 |
| sf-explain-config-full-lite | explain | miss 8,315 | miss 9,933 | miss 594 |
| sf-explain-exponential-backoff | explain | found 7,799 | found 6,864 | found 1,142 |
| sf-usage-fail-early | usage | found 8,314 | found 4,794 | found 265 |
| sf-usage-trigger-flush | usage | miss 8,274 | found 6,597 | miss 749 |
| sf-usage-imported-by | usage | miss 6,406 | found 3,582 | miss 478 |
| sf-usage-lru-drain | usage | found 8,324 | found 5,850 | miss 776 |
| sf-impact-shortcut | impact | found 8,316 | miss 9,517 | found 572 |
| sf-impact-primary-conflict | impact | miss 8,297 | miss 9,017 | miss 921 |
| sf-impact-cleanup-txinfo | impact | found 8,330 | found 7,378 | found 329 |

### spring-framework, input = `question`

| strategy | source | found | file recall | symbol recall | def recall | median tok | p90 tok | tokens / found task | calls |
|---|---|---|---|---|---|---|---|---|---|
| codegraph | container | 7/15 | 68 % | 69 % | 43 % | 8,293 | 8,325 | 17,131 | 1.0 |
| native-naive | kopt bench 2026-10-09 | 6/15 | 53 % | 49 % | 42 % | 19,851 | 43,980 | 52,241 | 3.6 |
| native-ranged | kopt bench 2026-10-09 | 4/15 | 53 % | 43 % | 29 % | 7,534 | 9,333 | 25,991 | 4.2 |
| kopt-pack | kopt bench 2026-10-09 | 5/15 | 68 % | 67 % | 34 % | 961 | 1,547 | 2,941 | 1.0 |
| kopt-hits+read | kopt bench 2026-10-09 | 2/15 | 70 % | 44 % | 36 % | 1,061 | 1,822 | 8,557 | 3.0 |

Pass-gated pairs (tokens b / a over tasks found by both; < 1 means b is cheaper):

| a | b | found by both | only a | only b | median b/a | geo-mean b/a |
|---|---|---|---|---|---|---|
| kopt-pack | codegraph | 5/15 | 0 | 2 | 11.27 | 13.96 |
| native-ranged | codegraph | 3/15 | 1 | 4 | 1.26 | 1.25 |

| task | kind | codegraph | native-ranged | kopt-pack |
|---|---|---|---|---|
| sf-locate-retry-loop | locate | found 8,293 | miss 921 | miss 1,058 |
| sf-locate-api-version | locate | miss 7,770 | miss 8,853 | miss 1,179 |
| sf-locate-sqlstate-lock | locate | miss 8,270 | miss 6,354 | miss 527 |
| sf-locate-advice-order | locate | miss 8,332 | miss 8,537 | miss 1,274 |
| sf-explain-concurrency-limit | explain | miss 8,309 | miss 6,661 | miss 961 |
| sf-explain-retryable | explain | miss 8,278 | miss 7,758 | miss 2,171 |
| sf-explain-config-full-lite | explain | miss 7,704 | miss 9,556 | miss 1,547 |
| sf-explain-exponential-backoff | explain | found 8,275 | miss 7,534 | found 949 |
| sf-usage-fail-early | usage | found 8,317 | found 4,794 | found 738 |
| sf-usage-trigger-flush | usage | found 8,306 | found 6,597 | found 1,062 |
| sf-usage-imported-by | usage | miss 6,417 | found 3,582 | miss 775 |
| sf-usage-lru-drain | usage | found 8,320 | miss 8,546 | miss 822 |
| sf-impact-shortcut | impact | found 8,305 | miss 7,270 | found 374 |
| sf-impact-primary-conflict | impact | miss 6,694 | miss 7,666 | miss 998 |
| sf-impact-cleanup-txinfo | impact | found 8,325 | found 9,333 | found 268 |

Cells of the per-task tables: `found`/`miss` (all gold files and symbol names present) and the estimated tokens returned by the single call.
