# Competitor benchmark: summary

Generated 2026-10-09 by `node bench/competitors/score.mjs` from `bench/competitors/results/`. One tool call per task (the first exploration step of an agent), scored with the `kopt bench` metrics (tokens = characters / 3, recall of the verified gold files and symbols). See `bench/competitors/README.md` for the protocol and the fairness notes. The `kopt bench` rows are copied from `bench/results/` and were measured on the host, not in the container.

## Overview (input = `search`)

Input = `search`, one call per task, default arguments. Generated 2026-10-09 by `node bench/competitors/score.mjs`.
*Italic* rows are the `kopt bench` reference strategies (host run, same tasks and metrics) where `bench/results/<repo>.json` exists.

| tool | repos | found | median tok (all tasks) | tokens / found task | total index time | failures |
|---|---|---|---|---|---|---|
| codegraph | 11 | 79/138 | 8,315 | 13,982 | 498.4 s | 0 |
| kirograph | 11 | 4/138 | 1,094 | 43,765 | 7230.9 s | 3 |
| kirograph-embeddings | 1 | 1/12 | 1,100 | 20,798 | 1538.0 s | 0 |
| *native-ranged* (kopt bench) | 11 | 54/138 | 6,675 | 31,485 | - | - |
| *kopt-pack* (kopt bench) | 11 | 43/138 | 747 | 2,722 | - | - |

Pass-gated pairs over all repos (tokens b / a on the tasks found by both; < 1 means b is cheaper):

| a | b | tasks run by both | found by both | only a | only b | median b/a | geo-mean b/a |
|---|---|---|---|---|---|---|---|
| native-ranged | codegraph | 138 | 39 | 15 | 40 | 1.41 | 1.19 |
| kopt-pack | codegraph | 138 | 27 | 16 | 52 | 10.90 | 11.84 |
| native-ranged | kirograph | 138 | 3 | 51 | 1 | 0.25 | 0.13 |
| kopt-pack | kirograph | 138 | 4 | 39 | 0 | 1.85 | 2.80 |
| native-ranged | kirograph-embeddings | 12 | 1 | 3 | 0 | 0.25 | 0.25 |
| kopt-pack | kirograph-embeddings | 12 | 1 | 2 | 0 | 2.00 | 2.00 |
| codegraph | kirograph | 138 | 3 | 76 | 1 | 0.23 | 0.25 |
| codegraph | kirograph-embeddings | 12 | 0 | 9 | 1 | - | - |
| kirograph | kirograph-embeddings | 12 | 1 | 0 | 0 | 1.00 | 1.00 |

| repo | tool | index time | index size | median query | found | file recall | symbol recall | def recall | median tok | p90 tok | tokens / found task | failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| discourse | codegraph | 38.2 s | 404 MB | 555 ms | 8/12 | 75 % | 71 % | 48 % | 7,954 | 8,328 | 11,477 | 0 |
| discourse | kirograph | 933.0 s | 160 MB | 59 ms | 1/12 | 8 % | 10 % | 4 % | 1,239 | 4,374 | 15,694 | 3 |
| discourse | *native-ranged* (kopt bench) | - | - | - | 6/12 | 63 % | 60 % | 52 % | 5,988 | 10,705 | 14,844 | - |
| discourse | *kopt-pack* (kopt bench) | - | - | - | 4/12 | 73 % | 72 % | 55 % | 860 | 1,376 | 2,483 | - |
| django | codegraph | 44.0 s | 181 MB | 205 ms | 8/15 | 90 % | 81 % | 62 % | 8,317 | 8,330 | 15,192 | 0 |
| django | kirograph | 1604.1 s | 268 MB | 98 ms | 1/15 | 40 % | 26 % | 0 % | 799 | 3,407 | 19,329 | 0 |
| django | *native-ranged* (kopt bench) | - | - | - | 8/15 | 77 % | 67 % | 54 % | 6,737 | 8,352 | 11,497 | - |
| django | *kopt-pack* (kopt bench) | - | - | - | 8/15 | 89 % | 87 % | 58 % | 627 | 1,053 | 1,143 | - |
| exposed | codegraph | 28.2 s | 101 MB | 201 ms | 9/12 | 88 % | 100 % | 55 % | 8,305 | 8,327 | 11,019 | 0 |
| exposed | kirograph | 228.1 s | 94 MB | 67 ms | 1/12 | 51 % | 24 % | 10 % | 1,100 | 4,523 | 20,798 | 0 |
| exposed | kirograph-embeddings | 1538.0 s | 132 MB | 436 ms | 1/12 | 51 % | 24 % | 10 % | 1,100 | 4,523 | 20,798 | 0 |
| exposed | *native-ranged* (kopt bench) | - | - | - | 4/12 | 71 % | 61 % | 41 % | 9,659 | 18,199 | 85,522 | - |
| exposed | *kopt-pack* (kopt bench) | - | - | - | 3/12 | 53 % | 81 % | 35 % | 658 | 2,059 | 3,888 | - |
| gitea | codegraph | 12.1 s | 176 MB | 262 ms | 6/12 | 80 % | 69 % | 31 % | 8,257 | 8,328 | 15,262 | 0 |
| gitea | kirograph | 243.7 s | 80 MB | 42 ms | 0/12 | 8 % | 9 % | 0 % | 482 | 1,109 | - | 0 |
| gitea | *native-ranged* (kopt bench) | - | - | - | 3/12 | 73 % | 64 % | 54 % | 6,266 | 7,746 | 30,561 | - |
| gitea | *kopt-pack* (kopt bench) | - | - | - | 2/12 | 63 % | 77 % | 48 % | 537 | 2,025 | 4,979 | - |
| jellyfin | codegraph | 6.0 s | 109 MB | 122 ms | 8/12 | 92 % | 79 % | 47 % | 8,316 | 8,330 | 12,058 | 0 |
| jellyfin | kirograph | 293.6 s | 74 MB | 113 ms | 0/12 | 28 % | 9 % | 0 % | 865 | 1,245 | - | 0 |
| jellyfin | *native-ranged* (kopt bench) | - | - | - | 5/12 | 96 % | 76 % | 63 % | 6,578 | 8,871 | 16,238 | - |
| jellyfin | *kopt-pack* (kopt bench) | - | - | - | 1/12 | 47 % | 66 % | 31 % | 929 | 1,270 | 11,060 | - |
| laravel | codegraph | 20.4 s | 197 MB | 347 ms | 5/12 | 78 % | 70 % | 49 % | 8,308 | 8,319 | 19,017 | 0 |
| laravel | kirograph | 249.1 s | 67 MB | 70 ms | 0/12 | 15 % | 17 % | 4 % | 1,382 | 1,806 | - | 0 |
| laravel | *native-ranged* (kopt bench) | - | - | - | 4/12 | 78 % | 62 % | 43 % | 4,786 | 171,419 | 102,016 | - |
| laravel | *kopt-pack* (kopt bench) | - | - | - | 7/12 | 86 % | 82 % | 61 % | 881 | 1,307 | 1,565 | - |
| medusa | codegraph | 30.5 s | 328 MB | 299 ms | 7/12 | 87 % | 74 % | 36 % | 8,317 | 8,329 | 13,900 | 0 |
| medusa | kirograph | 959.5 s | 162 MB | 126 ms | 0/12 | 11 % | 10 % | 0 % | 1,269 | 1,565 | - | 0 |
| medusa | *native-ranged* (kopt bench) | - | - | - | 3/12 | 58 % | 46 % | 30 % | 6,994 | 9,825 | 27,520 | - |
| medusa | *kopt-pack* (kopt bench) | - | - | - | 3/12 | 61 % | 79 % | 40 % | 857 | 1,779 | 3,745 | - |
| meilisearch | codegraph | 8.1 s | 79 MB | 122 ms | 5/12 | 69 % | 68 % | 32 % | 8,318 | 8,327 | 19,337 | 0 |
| meilisearch | kirograph | 93.9 s | 67 MB | 44 ms | 0/12 | 36 % | 9 % | 0 % | 1,058 | 2,770 | - | 0 |
| meilisearch | *native-ranged* (kopt bench) | - | - | - | 3/12 | 67 % | 53 % | 35 % | 6,194 | 7,821 | 25,791 | - |
| meilisearch | *kopt-pack* (kopt bench) | - | - | - | 1/12 | 70 % | 54 % | 36 % | 983 | 1,294 | 11,211 | - |
| playframework | codegraph | 9.7 s | 103 MB | 152 ms | 10/12 | 92 % | 85 % | 51 % | 8,319 | 8,330 | 9,839 | 0 |
| playframework | kirograph | 103.7 s | 78 MB | 44 ms | 0/12 | 17 % | 10 % | 3 % | 1,307 | 2,238 | - | 0 |
| playframework | *native-ranged* (kopt bench) | - | - | - | 5/12 | 92 % | 52 % | 43 % | 7,631 | 9,495 | 24,245 | - |
| playframework | *kopt-pack* (kopt bench) | - | - | - | 3/12 | 83 % | 54 % | 28 % | 909 | 1,151 | 3,619 | - |
| spring-framework | codegraph | 130.2 s | 863 MB | 858 ms | 8/15 | 80 % | 76 % | 47 % | 8,307 | 8,324 | 14,584 | 0 |
| spring-framework | kirograph | 1948.6 s | 851 MB | 200 ms | 0/15 | 27 % | 21 % | 0 % | 1,208 | 1,655 | - | 0 |
| spring-framework | *native-ranged* (kopt bench) | - | - | - | 8/15 | 82 % | 70 % | 57 % | 7,378 | 9,517 | 14,080 | - |
| spring-framework | *kopt-pack* (kopt bench) | - | - | - | 5/15 | 72 % | 75 % | 43 % | 807 | 1,363 | 2,538 | - |
| webpack | codegraph | 171.0 s | 152 MB | 243 ms | 5/12 | 58 % | 67 % | 41 % | 8,325 | 8,331 | 19,976 | 0 |
| webpack | kirograph | 573.7 s | 111 MB | 99 ms | 1/12 | 19 % | 17 % | 8 % | 752 | 5,023 | 19,095 | 0 |
| webpack | *native-ranged* (kopt bench) | - | - | - | 5/12 | 75 % | 61 % | 49 % | 5,649 | 7,586 | 40,465 | - |
| webpack | *kopt-pack* (kopt bench) | - | - | - | 6/12 | 67 % | 75 % | 64 % | 693 | 1,130 | 1,391 | - |

## discourse

ruby · v2026.9.0 · 12 tasks

| tool | version | mode | index time | index size | fixed overhead per request | median query | errors |
|---|---|---|---|---|---|---|---|
| codegraph | 1.6.2 | default | 38.2 s | 404 MB | 2,815 tok (1 tools) | 555 ms | 0 |
| kirograph | 1.4.0 | default | 933.0 s | 160 MB | 1,473 tok (7 tools) | 59 ms | 2 |

### discourse, input = `search`

| strategy | source | found | file recall | symbol recall | def recall | median tok | p90 tok | tokens / found task | calls |
|---|---|---|---|---|---|---|---|---|---|
| codegraph | container | 8/12 | 75 % | 71 % | 48 % | 7,954 | 8,328 | 11,477 | 1.0 |
| kirograph | container | 1/12 (3 err) | 8 % | 10 % | 4 % | 1,239 | 4,374 | 15,694 | 1.0 |
| native-naive | kopt bench 2026-10-09 | 3/12 | 67 % | 48 % | 41 % | 22,658 | 45,865 | 108,903 | 3.8 |
| native-ranged | kopt bench 2026-10-09 | 6/12 | 63 % | 60 % | 52 % | 5,988 | 10,705 | 14,844 | 4.8 |
| kopt-pack | kopt bench 2026-10-09 | 4/12 | 73 % | 72 % | 55 % | 860 | 1,376 | 2,483 | 1.0 |
| kopt-hits+read | kopt bench 2026-10-09 | 6/12 | 81 % | 76 % | 69 % | 1,039 | 1,465 | 2,183 | 3.0 |

Pass-gated pairs (tokens b / a over tasks found by both; < 1 means b is cheaper):

| a | b | found by both | only a | only b | median b/a | geo-mean b/a |
|---|---|---|---|---|---|---|
| kopt-pack | codegraph | 3/12 | 1 | 5 | 6.53 | 7.27 |
| native-ranged | codegraph | 3/12 | 3 | 5 | 1.46 | 1.10 |
| kopt-pack | kirograph | 1/12 | 3 | 0 | 1.70 | 1.70 |
| native-ranged | kirograph | 0/12 | 6 | 1 | - | - |

| task | kind | codegraph | kirograph | native-ranged | kopt-pack |
|---|---|---|---|---|---|
| ds-locate-mcp-pkce | locate | miss 8,292 | miss 453 | found 6,644 | found 1,376 |
| ds-locate-nested-hot-score | locate | found 6,497 | miss 991 | found 10,705 | found 1,078 |
| ds-locate-auto-silence | locate | miss 8,328 | miss 1,841 | miss 10,506 | miss 482 |
| ds-locate-login-code-verify | locate | found 7,101 | found 1,239 | miss 6,291 | found 728 |
| ds-explain-mcp-refresh-rotation | explain | found 7,402 | miss 2,112 | miss 5,325 | found 1,133 |
| ds-explain-upcoming-promotion | explain | found 8,332 | miss 2,830 | miss 18,538 | miss 1,681 |
| ds-explain-rate-limit-create | explain | found 7,672 | miss 805 | miss 6,800 | miss 991 |
| ds-usage-disable-rate-limits | usage | miss 5,892 | miss 12 | found 4,490 | miss 330 |
| ds-usage-prevent-posting | usage | miss 8,235 | miss 4,374 | found 4,650 | miss 225 |
| ds-usage-hot-score-fallback | usage | found 7,459 | miss 1,049 | found 4,930 | miss 1,034 |
| ds-impact-require-consent | impact | found 8,309 | miss 12 | found 5,685 | miss 450 |
| ds-impact-consume-login-code | impact | found 8,295 | miss 12 | miss 4,502 | miss 424 |

### discourse, input = `question`

| strategy | source | found | file recall | symbol recall | def recall | median tok | p90 tok | tokens / found task | calls |
|---|---|---|---|---|---|---|---|---|---|
| codegraph | container | 1/12 | 25 % | 19 % | 4 % | 7,870 | 8,319 | 88,781 | 1.0 |
| kirograph | container | 0/12 (6 err) | 0 % | 0 % | 0 % | 1,962 | 2,893 | - | 1.0 |

| task | kind | codegraph | kirograph |
|---|---|---|---|
| ds-locate-mcp-pkce | locate | miss 8,219 | miss 1,225 |
| ds-locate-nested-hot-score | locate | miss 8,253 | miss 2,712 |
| ds-locate-auto-silence | locate | miss 8,319 | miss 1,870 |
| ds-locate-login-code-verify | locate | miss 8,138 | miss 811 |
| ds-explain-mcp-refresh-rotation | explain | found 6,661 | miss 2,053 |
| ds-explain-upcoming-promotion | explain | miss 8,165 | miss 2,893 |
| ds-explain-rate-limit-create | explain | miss 5,473 | miss 12 |
| ds-usage-disable-rate-limits | usage | miss 5,545 | miss 12 |
| ds-usage-prevent-posting | usage | miss 7,601 | miss 12 |
| ds-usage-hot-score-fallback | usage | miss 8,323 | miss 12 |
| ds-impact-require-consent | impact | miss 7,389 | miss 12 |
| ds-impact-consume-login-code | impact | miss 6,695 | miss 12 |

## django

python · 6.1.2 · 15 tasks

| tool | version | mode | index time | index size | fixed overhead per request | median query | errors |
|---|---|---|---|---|---|---|---|
| codegraph | 1.6.2 | default | 44.0 s | 181 MB | 2,815 tok (1 tools) | 205 ms | 0 |
| kirograph | 1.4.0 | default | 1604.1 s | 268 MB | 1,473 tok (7 tools) | 98 ms | 1 |

### django, input = `search`

| strategy | source | found | file recall | symbol recall | def recall | median tok | p90 tok | tokens / found task | calls |
|---|---|---|---|---|---|---|---|---|---|
| codegraph | container | 8/15 | 90 % | 81 % | 62 % | 8,317 | 8,330 | 15,192 | 1.0 |
| kirograph | container | 1/15 | 40 % | 26 % | 0 % | 799 | 3,407 | 19,329 | 1.0 |
| native-naive | kopt bench 2026-10-09 | 7/15 | 77 % | 63 % | 61 % | 43,715 | 65,803 | 83,575 | 3.5 |
| native-ranged | kopt bench 2026-10-09 | 8/15 | 77 % | 67 % | 54 % | 6,737 | 8,352 | 11,497 | 4.5 |
| kopt-pack | kopt bench 2026-10-09 | 8/15 | 89 % | 87 % | 58 % | 627 | 1,053 | 1,143 | 1.0 |
| kopt-hits+read | kopt bench 2026-10-09 | 5/15 | 89 % | 68 % | 63 % | 795 | 1,734 | 2,748 | 3.0 |

Pass-gated pairs (tokens b / a over tasks found by both; < 1 means b is cheaper):

| a | b | found by both | only a | only b | median b/a | geo-mean b/a |
|---|---|---|---|---|---|---|
| kopt-pack | codegraph | 4/15 | 4 | 4 | 24.40 | 20.91 |
| native-ranged | codegraph | 5/15 | 3 | 3 | 1.04 | 1.36 |
| kopt-pack | kirograph | 1/15 | 7 | 0 | 14.56 | 14.56 |
| native-ranged | kirograph | 1/15 | 7 | 0 | 0.62 | 0.62 |

| task | kind | codegraph | kirograph | native-ranged | kopt-pack |
|---|---|---|---|---|---|
| dj-locate-db-cache-cull | locate | miss 8,330 | miss 732 | miss 6,737 | miss 1,050 |
| dj-locate-accept-language | locate | found 8,315 | miss 879 | found 7,992 | found 1,053 |
| dj-locate-test-shuffle | locate | found 8,319 | miss 1,040 | miss 7,757 | found 627 |
| dj-locate-session-vary-cookie | locate | miss 8,299 | miss 747 | miss 7,674 | found 1,389 |
| dj-explain-migration-optimizer | explain | miss 7,132 | miss 802 | found 5,219 | found 584 |
| dj-explain-template-lookup | explain | found 8,313 | found 3,407 | found 5,505 | found 234 |
| dj-explain-password-upgrade | explain | miss 8,317 | miss 2,307 | miss 788 | miss 465 |
| dj-explain-autoreload-stat | explain | found 8,330 | miss 1,019 | found 8,352 | miss 679 |
| dj-usage-add-new-csrf-cookie | usage | miss 6,251 | miss 680 | found 3,485 | found 251 |
| dj-usage-construct-instance | usage | miss 8,311 | miss 724 | found 4,854 | found 681 |
| dj-usage-same-domain | usage | miss 8,317 | miss 632 | miss 7,988 | miss 775 |
| dj-usage-resolve-callables | usage | found 8,332 | miss 4,203 | miss 5,566 | miss 229 |
| dj-impact-naive-now | impact | found 8,324 | miss 676 | found 2,892 | found 162 |
| dj-impact-same-field-operation | impact | found 8,323 | miss 682 | miss 9,094 | miss 645 |
| dj-impact-migrations-module | impact | found 8,319 | miss 799 | found 8,073 | miss 323 |

### django, input = `question`

| strategy | source | found | file recall | symbol recall | def recall | median tok | p90 tok | tokens / found task | calls |
|---|---|---|---|---|---|---|---|---|---|
| codegraph | container | 8/15 | 69 % | 57 % | 36 % | 8,317 | 8,330 | 15,218 | 1.0 |
| kirograph | container | 0/15 (7 err) | 0 % | 0 % | 0 % | 834 | 1,845 | - | 1.0 |
| native-naive | kopt bench 2026-10-09 | 4/15 | 63 % | 44 % | 36 % | 45,933 | 65,961 | 175,178 | 3.8 |
| native-ranged | kopt bench 2026-10-09 | 4/15 | 63 % | 47 % | 38 % | 7,388 | 8,999 | 27,083 | 4.7 |
| kopt-pack | kopt bench 2026-10-09 | 5/15 | 79 % | 76 % | 52 % | 824 | 2,218 | 2,708 | 1.0 |
| kopt-hits+read | kopt bench 2026-10-09 | 2/15 | 79 % | 59 % | 53 % | 1,102 | 1,696 | 9,084 | 3.0 |

Pass-gated pairs (tokens b / a over tasks found by both; < 1 means b is cheaper):

| a | b | found by both | only a | only b | median b/a | geo-mean b/a |
|---|---|---|---|---|---|---|
| kopt-pack | codegraph | 3/15 | 2 | 5 | 27.01 | 19.37 |
| native-ranged | codegraph | 3/15 | 1 | 5 | 1.51 | 1.63 |
| kopt-pack | kirograph | 0/15 | 5 | 0 | - | - |
| native-ranged | kirograph | 0/15 | 4 | 0 | - | - |

| task | kind | codegraph | kirograph | native-ranged | kopt-pack |
|---|---|---|---|---|---|
| dj-locate-db-cache-cull | locate | miss 8,330 | miss 874 | miss 7,006 | miss 991 |
| dj-locate-accept-language | locate | found 8,318 | miss 663 | miss 7,376 | found 1,080 |
| dj-locate-test-shuffle | locate | found 8,313 | miss 12 | miss 6,111 | miss 489 |
| dj-locate-session-vary-cookie | locate | miss 8,319 | miss 793 | miss 9,294 | found 2,218 |
| dj-explain-migration-optimizer | explain | miss 7,486 | miss 1,582 | miss 8,999 | miss 2,460 |
| dj-explain-template-lookup | explain | found 8,317 | miss 12 | found 5,505 | found 238 |
| dj-explain-password-upgrade | explain | miss 8,331 | miss 1,845 | miss 7,014 | miss 843 |
| dj-explain-autoreload-stat | explain | miss 8,322 | miss 1,036 | found 8,458 | miss 1,142 |
| dj-usage-add-new-csrf-cookie | usage | miss 6,509 | miss 12 | miss 7,943 | found 696 |
| dj-usage-construct-instance | usage | found 8,314 | miss 12 | miss 7,689 | miss 824 |
| dj-usage-same-domain | usage | miss 8,330 | miss 753 | miss 7,988 | miss 938 |
| dj-usage-resolve-callables | usage | found 8,238 | miss 12 | miss 7,388 | miss 287 |
| dj-impact-naive-now | impact | found 8,320 | miss 12 | found 2,892 | found 308 |
| dj-impact-same-field-operation | impact | found 8,294 | miss 784 | miss 6,597 | miss 690 |
| dj-impact-migrations-module | impact | found 8,006 | miss 12 | found 8,073 | miss 335 |

## exposed

kotlin · 1.5.0 · 12 tasks

| tool | version | mode | index time | index size | fixed overhead per request | median query | errors |
|---|---|---|---|---|---|---|---|
| codegraph | 1.6.2 | default | 28.2 s | 101 MB | 2,815 tok (1 tools) | 201 ms | 0 |
| kirograph | 1.4.0 | default | 228.1 s | 94 MB | 1,473 tok (7 tools) | 67 ms | 1 |
| kirograph-embeddings | 1.4.0 | embeddings | 1538.0 s | 132 MB (+ 548 MB model) | 1,473 tok (7 tools) | 436 ms | 1 |

### exposed, input = `search`

| strategy | source | found | file recall | symbol recall | def recall | median tok | p90 tok | tokens / found task | calls |
|---|---|---|---|---|---|---|---|---|---|
| codegraph | container | 9/12 | 88 % | 100 % | 55 % | 8,305 | 8,327 | 11,019 | 1.0 |
| kirograph | container | 1/12 | 51 % | 24 % | 10 % | 1,100 | 4,523 | 20,798 | 1.0 |
| kirograph-embeddings | container | 1/12 | 51 % | 24 % | 10 % | 1,100 | 4,523 | 20,798 | 1.0 |
| native-naive | kopt bench 2026-10-09 | 4/12 | 71 % | 57 % | 37 % | 15,910 | 67,535 | 88,573 | 3.8 |
| native-ranged | kopt bench 2026-10-09 | 4/12 | 71 % | 61 % | 41 % | 9,659 | 18,199 | 85,522 | 4.0 |
| kopt-pack | kopt bench 2026-10-09 | 3/12 | 53 % | 81 % | 35 % | 658 | 2,059 | 3,888 | 1.0 |
| kopt-hits+read | kopt bench 2026-10-09 | 1/12 | 62 % | 53 % | 40 % | 1,049 | 2,023 | 13,313 | 3.0 |

Pass-gated pairs (tokens b / a over tasks found by both; < 1 means b is cheaper):

| a | b | found by both | only a | only b | median b/a | geo-mean b/a |
|---|---|---|---|---|---|---|
| kopt-pack | codegraph | 2/12 | 1 | 7 | 19.91 | 19.87 |
| native-ranged | codegraph | 3/12 | 1 | 6 | 1.06 | 0.98 |
| kopt-pack | kirograph | 1/12 | 2 | 0 | 2.00 | 2.00 |
| native-ranged | kirograph | 1/12 | 3 | 0 | 0.25 | 0.25 |
| kopt-pack | kirograph-embeddings | 1/12 | 2 | 0 | 2.00 | 2.00 |
| native-ranged | kirograph-embeddings | 1/12 | 3 | 0 | 0.25 | 0.25 |

| task | kind | codegraph | kirograph | kirograph-embeddings | native-ranged | kopt-pack |
|---|---|---|---|---|---|---|
| ex-locate-retry | locate | found 8,297 | miss 1,043 | miss 1,043 | found 13,960 | miss 2,059 |
| ex-locate-upsert-sql | locate | miss 8,262 | found 4,556 | found 4,556 | found 18,199 | found 2,276 |
| ex-locate-lifecycle-flush | locate | found 8,327 | miss 994 | miss 994 | miss 13,237 | miss 683 |
| ex-locate-hashed-column | locate | miss 8,308 | miss 948 | miss 948 | miss 9,849 | miss 876 |
| ex-explain-entity-flush | explain | miss 8,324 | miss 990 | miss 990 | miss 8,290 | miss 1,400 |
| ex-explain-nested-tx | explain | found 8,316 | miss 1,078 | miss 1,078 | miss 10,690 | miss 633 |
| ex-explain-table-order | explain | found 7,804 | miss 1,157 | miss 1,157 | miss 236,185 | miss 1,505 |
| ex-usage-sort-tables | usage | found 8,295 | miss 1,131 | miss 1,131 | miss 9,468 | miss 632 |
| ex-usage-entity-lifecycle | usage | found 8,330 | miss 2,270 | miss 2,270 | miss 5,910 | miss 348 |
| ex-usage-resolve-database | usage | found 8,302 | miss 1,121 | miss 1,121 | found 5,466 | found 445 |
| ex-impact-check-cycle | impact | found 8,316 | miss 987 | miss 987 | found 7,876 | miss 416 |
| ex-impact-upsert-alias | impact | found 8,294 | miss 4,523 | miss 4,523 | miss 2,959 | found 392 |

### exposed, input = `question`

| strategy | source | found | file recall | symbol recall | def recall | median tok | p90 tok | tokens / found task | calls |
|---|---|---|---|---|---|---|---|---|---|
| codegraph | container | 4/12 | 60 % | 70 % | 30 % | 8,315 | 8,324 | 24,674 | 1.0 |
| kirograph | container | 0/12 (7 err) | 13 % | 5 % | 0 % | 1,053 | 1,121 | - | 1.0 |
| kirograph-embeddings | container | 0/12 (7 err) | 13 % | 5 % | 0 % | 1,053 | 1,121 | - | 1.0 |

| task | kind | codegraph | kirograph | kirograph-embeddings |
|---|---|---|---|---|
| ex-locate-retry | locate | miss 8,316 | miss 1,070 | miss 1,070 |
| ex-locate-upsert-sql | locate | miss 7,325 | miss 1,053 | miss 1,053 |
| ex-locate-lifecycle-flush | locate | miss 8,324 | miss 12 | miss 12 |
| ex-locate-hashed-column | locate | miss 8,314 | miss 1,012 | miss 1,012 |
| ex-explain-entity-flush | explain | miss 8,306 | miss 1,011 | miss 1,011 |
| ex-explain-nested-tx | explain | miss 8,315 | miss 12 | miss 12 |
| ex-explain-table-order | explain | miss 8,322 | miss 1,121 | miss 1,121 |
| ex-usage-sort-tables | usage | found 8,328 | miss 12 | miss 12 |
| ex-usage-entity-lifecycle | usage | found 8,324 | miss 12 | miss 12 |
| ex-usage-resolve-database | usage | found 8,302 | miss 12 | miss 12 |
| ex-impact-check-cycle | impact | found 8,287 | miss 12 | miss 12 |
| ex-impact-upsert-alias | impact | miss 8,231 | miss 12 | miss 12 |

## gitea

go · v28.1.0 · 12 tasks

| tool | version | mode | index time | index size | fixed overhead per request | median query | errors |
|---|---|---|---|---|---|---|---|
| codegraph | 1.6.2 | default | 12.1 s | 176 MB | 2,815 tok (1 tools) | 262 ms | 0 |
| kirograph | 1.4.0 | default | 243.7 s | 80 MB | 1,473 tok (7 tools) | 42 ms | 1 |

### gitea, input = `search`

| strategy | source | found | file recall | symbol recall | def recall | median tok | p90 tok | tokens / found task | calls |
|---|---|---|---|---|---|---|---|---|---|
| codegraph | container | 6/12 | 80 % | 69 % | 31 % | 8,257 | 8,328 | 15,262 | 1.0 |
| kirograph | container | 0/12 | 8 % | 9 % | 0 % | 482 | 1,109 | - | 1.0 |
| native-naive | kopt bench 2026-10-09 | 4/12 | 73 % | 64 % | 54 % | 14,142 | 42,955 | 137,331 | 3.8 |
| native-ranged | kopt bench 2026-10-09 | 3/12 | 73 % | 64 % | 54 % | 6,266 | 7,746 | 30,561 | 4.3 |
| kopt-pack | kopt bench 2026-10-09 | 2/12 | 63 % | 77 % | 48 % | 537 | 2,025 | 4,979 | 1.0 |
| kopt-hits+read | kopt bench 2026-10-09 | 4/12 | 67 % | 53 % | 48 % | 760 | 1,555 | 2,450 | 3.0 |

Pass-gated pairs (tokens b / a over tasks found by both; < 1 means b is cheaper):

| a | b | found by both | only a | only b | median b/a | geo-mean b/a |
|---|---|---|---|---|---|---|
| kopt-pack | codegraph | 1/12 | 1 | 5 | 3.92 | 3.92 |
| native-ranged | codegraph | 2/12 | 1 | 4 | 1.51 | 1.46 |
| kopt-pack | kirograph | 0/12 | 2 | 0 | - | - |
| native-ranged | kirograph | 0/12 | 3 | 0 | - | - |

| task | kind | codegraph | kirograph | native-ranged | kopt-pack |
|---|---|---|---|---|---|
| gt-locate-git-proxy | locate | miss 8,318 | miss 507 | found 1,143 | found 983 |
| gt-locate-runner-pick | locate | miss 8,324 | miss 1,820 | miss 7,746 | miss 2,281 |
| gt-locate-protected-branch | locate | found 7,944 | miss 572 | found 6,975 | found 2,025 |
| gt-locate-audit-origin | locate | found 8,210 | miss 368 | miss 6,277 | miss 518 |
| gt-explain-egress | explain | miss 7,118 | miss 1,034 | miss 6,448 | miss 555 |
| gt-explain-audit | explain | miss 6,255 | miss 371 | miss 6,256 | miss 1,036 |
| gt-explain-globallock | explain | found 3,925 | miss 366 | miss 32,075 | miss 869 |
| gt-usage-egress-transport | usage | miss 8,203 | miss 85 | miss 6,276 | miss 303 |
| gt-usage-automerge-check | usage | found 8,330 | miss 498 | found 4,429 | miss 389 |
| gt-usage-pull-working-lock | usage | found 8,303 | miss 466 | miss 6,140 | miss 218 |
| gt-impact-remove-scheduled-automerge | impact | found 8,311 | miss 137 | miss 4,113 | miss 398 |
| gt-impact-migration-policy | impact | miss 8,328 | miss 1,109 | miss 3,806 | miss 383 |

### gitea, input = `question`

| strategy | source | found | file recall | symbol recall | def recall | median tok | p90 tok | tokens / found task | calls |
|---|---|---|---|---|---|---|---|---|---|
| codegraph | container | 3/12 | 69 % | 57 % | 29 % | 8,322 | 8,329 | 32,596 | 1.0 |
| kirograph | container | 0/12 (7 err) | 4 % | 2 % | 0 % | 481 | 1,862 | - | 1.0 |

| task | kind | codegraph | kirograph |
|---|---|---|---|
| gt-locate-git-proxy | locate | miss 8,328 | miss 12 |
| gt-locate-runner-pick | locate | miss 8,326 | miss 1,862 |
| gt-locate-protected-branch | locate | found 8,332 | miss 12 |
| gt-locate-audit-origin | locate | miss 8,308 | miss 347 |
| gt-explain-egress | explain | miss 8,328 | miss 1,099 |
| gt-explain-audit | explain | miss 6,336 | miss 481 |
| gt-explain-globallock | explain | found 8,324 | miss 337 |
| gt-usage-egress-transport | usage | miss 8,329 | miss 12 |
| gt-usage-automerge-check | usage | miss 8,315 | miss 12 |
| gt-usage-pull-working-lock | usage | miss 8,319 | miss 12 |
| gt-impact-remove-scheduled-automerge | impact | found 8,319 | miss 12 |
| gt-impact-migration-policy | impact | miss 8,224 | miss 12 |

## jellyfin

c_sharp · v10.11.11 · 12 tasks

| tool | version | mode | index time | index size | fixed overhead per request | median query | errors |
|---|---|---|---|---|---|---|---|
| codegraph | 1.6.2 | default | 6.0 s | 109 MB | 2,815 tok (1 tools) | 122 ms | 0 |
| kirograph | 1.4.0 | default | 293.6 s | 74 MB | 1,473 tok (7 tools) | 113 ms | 1 |

### jellyfin, input = `search`

| strategy | source | found | file recall | symbol recall | def recall | median tok | p90 tok | tokens / found task | calls |
|---|---|---|---|---|---|---|---|---|---|
| codegraph | container | 8/12 | 92 % | 79 % | 47 % | 8,316 | 8,330 | 12,058 | 1.0 |
| kirograph | container | 0/12 | 28 % | 9 % | 0 % | 865 | 1,245 | - | 1.0 |
| native-naive | kopt bench 2026-10-09 | 5/12 | 96 % | 71 % | 63 % | 13,681 | 26,362 | 46,284 | 4.0 |
| native-ranged | kopt bench 2026-10-09 | 5/12 | 96 % | 76 % | 63 % | 6,578 | 8,871 | 16,238 | 4.5 |
| kopt-pack | kopt bench 2026-10-09 | 1/12 | 47 % | 66 % | 31 % | 929 | 1,270 | 11,060 | 1.0 |
| kopt-hits+read | kopt bench 2026-10-09 | 1/12 | 55 % | 33 % | 33 % | 1,371 | 2,045 | 16,115 | 3.0 |

Pass-gated pairs (tokens b / a over tasks found by both; < 1 means b is cheaper):

| a | b | found by both | only a | only b | median b/a | geo-mean b/a |
|---|---|---|---|---|---|---|
| kopt-pack | codegraph | 1/12 | 0 | 7 | 8.74 | 8.74 |
| native-ranged | codegraph | 4/12 | 1 | 4 | 1.48 | 1.45 |
| kopt-pack | kirograph | 0/12 | 1 | 0 | - | - |
| native-ranged | kirograph | 0/12 | 5 | 0 | - | - |

| task | kind | codegraph | kirograph | native-ranged | kopt-pack |
|---|---|---|---|---|---|
| jf-locate-lockout | locate | miss 6,840 | miss 868 | miss 9,261 | miss 1,774 |
| jf-locate-auth-header | locate | miss 8,316 | miss 949 | miss 8,871 | miss 1,133 |
| jf-locate-password-migration | locate | found 7,281 | miss 235 | miss 6,532 | miss 1,159 |
| jf-locate-media-segments | locate | found 8,320 | miss 1,198 | found 5,391 | found 952 |
| jf-explain-quick-connect | explain | found 8,318 | miss 952 | found 6,798 | miss 1,270 |
| jf-explain-trickplay | explain | miss 8,326 | miss 1,245 | miss 8,468 | miss 906 |
| jf-explain-syncplay-wait | explain | miss 8,330 | miss 286 | found 7,801 | miss 1,040 |
| jf-usage-refresh-trickplay | usage | found 8,316 | miss 861 | found 5,027 | miss 555 |
| jf-usage-authorization-info | usage | found 8,332 | miss 1,259 | miss 4,124 | miss 588 |
| jf-usage-create-backup | usage | found 7,471 | miss 81 | miss 6,441 | miss 539 |
| jf-impact-trickplay-resolutions | impact | found 8,305 | miss 141 | miss 6,623 | miss 546 |
| jf-impact-dot-ignore | impact | found 8,306 | miss 236 | found 5,854 | miss 598 |

### jellyfin, input = `question`

| strategy | source | found | file recall | symbol recall | def recall | median tok | p90 tok | tokens / found task | calls |
|---|---|---|---|---|---|---|---|---|---|
| codegraph | container | 7/12 | 79 % | 71 % | 28 % | 8,206 | 8,331 | 13,519 | 1.0 |
| kirograph | container | 0/12 (7 err) | 8 % | 0 % | 0 % | 896 | 1,258 | - | 1.0 |

| task | kind | codegraph | kirograph |
|---|---|---|---|
| jf-locate-lockout | locate | miss 6,859 | miss 887 |
| jf-locate-auth-header | locate | miss 8,121 | miss 12 |
| jf-locate-password-migration | locate | found 7,320 | miss 896 |
| jf-locate-media-segments | locate | found 8,322 | miss 12 |
| jf-explain-quick-connect | explain | found 7,729 | miss 1,003 |
| jf-explain-trickplay | explain | miss 8,331 | miss 1,258 |
| jf-explain-syncplay-wait | explain | miss 8,299 | miss 310 |
| jf-usage-refresh-trickplay | usage | miss 8,314 | miss 12 |
| jf-usage-authorization-info | usage | found 6,905 | miss 12 |
| jf-usage-create-backup | usage | found 8,291 | miss 12 |
| jf-impact-trickplay-resolutions | impact | found 8,331 | miss 12 |
| jf-impact-dot-ignore | impact | found 7,812 | miss 12 |

## laravel

php · v13.35.0 · 12 tasks

| tool | version | mode | index time | index size | fixed overhead per request | median query | errors |
|---|---|---|---|---|---|---|---|
| codegraph | 1.6.2 | default | 20.4 s | 197 MB | 2,815 tok (1 tools) | 347 ms | 0 |
| kirograph | 1.4.0 | default | 249.1 s | 67 MB | 1,473 tok (7 tools) | 70 ms | 1 |

### laravel, input = `search`

| strategy | source | found | file recall | symbol recall | def recall | median tok | p90 tok | tokens / found task | calls |
|---|---|---|---|---|---|---|---|---|---|
| codegraph | container | 5/12 | 78 % | 70 % | 49 % | 8,308 | 8,319 | 19,017 | 1.0 |
| kirograph | container | 0/12 | 15 % | 17 % | 4 % | 1,382 | 1,806 | - | 1.0 |
| native-naive | kopt bench 2026-10-09 | 6/12 | 78 % | 71 % | 60 % | 22,327 | 71,442 | 58,428 | 3.8 |
| native-ranged | kopt bench 2026-10-09 | 4/12 | 78 % | 62 % | 43 % | 4,786 | 171,419 | 102,016 | 4.6 |
| kopt-pack | kopt bench 2026-10-09 | 7/12 | 86 % | 82 % | 61 % | 881 | 1,307 | 1,565 | 1.0 |
| kopt-hits+read | kopt bench 2026-10-09 | 4/12 | 86 % | 67 % | 60 % | 834 | 1,299 | 2,951 | 3.0 |

Pass-gated pairs (tokens b / a over tasks found by both; < 1 means b is cheaper):

| a | b | found by both | only a | only b | median b/a | geo-mean b/a |
|---|---|---|---|---|---|---|
| kopt-pack | codegraph | 4/12 | 3 | 1 | 16.94 | 15.79 |
| native-ranged | codegraph | 3/12 | 1 | 2 | 2.17 | 2.35 |
| kopt-pack | kirograph | 0/12 | 7 | 0 | - | - |
| native-ranged | kirograph | 0/12 | 4 | 0 | - | - |

| task | kind | codegraph | kirograph | native-ranged | kopt-pack |
|---|---|---|---|---|---|
| lv-locate-cache-flexible | locate | miss 6,131 | miss 1,080 | miss 6,161 | miss 1,301 |
| lv-locate-image-processing | locate | miss 8,307 | miss 1,062 | miss 171,650 | found 1,601 |
| lv-locate-pwned | locate | miss 8,309 | miss 1,493 | miss 4,211 | found 1,307 |
| lv-locate-cache-failover | locate | found 7,869 | miss 1,634 | found 2,529 | found 722 |
| lv-explain-http-batch | explain | found 8,319 | miss 937 | miss 171,419 | miss 473 |
| lv-explain-concurrency | explain | miss 8,305 | miss 234 | miss 21,531 | miss 1,229 |
| lv-explain-throttles-exceptions | explain | miss 6,331 | miss 1,831 | miss 4,083 | found 895 |
| lv-usage-image-driver | usage | found 8,332 | miss 1,528 | found 3,832 | found 480 |
| lv-usage-fail-job | usage | found 8,246 | miss 1,806 | miss 4,814 | found 415 |
| lv-usage-batch-record | usage | miss 8,313 | miss 916 | miss 4,757 | miss 1,164 |
| lv-impact-max-exceptions | impact | found 8,315 | miss 1,312 | found 4,337 | found 503 |
| lv-impact-flexible-prefix | impact | miss 8,309 | miss 1,452 | found 8,741 | miss 866 |

### laravel, input = `question`

| strategy | source | found | file recall | symbol recall | def recall | median tok | p90 tok | tokens / found task | calls |
|---|---|---|---|---|---|---|---|---|---|
| codegraph | container | 4/12 | 76 % | 70 % | 37 % | 8,225 | 8,325 | 22,574 | 1.0 |
| kirograph | container | 0/12 (10 err) | 0 % | 0 % | 0 % | 1,379 | 1,638 | - | 1.0 |

| task | kind | codegraph | kirograph |
|---|---|---|---|
| lv-locate-cache-flexible | locate | miss 6,698 | miss 1,120 |
| lv-locate-image-processing | locate | miss 5,334 | miss 12 |
| lv-locate-pwned | locate | miss 7,953 | miss 1,638 |
| lv-locate-cache-failover | locate | miss 8,141 | miss 12 |
| lv-explain-http-batch | explain | found 8,325 | miss 12 |
| lv-explain-concurrency | explain | miss 5,025 | miss 12 |
| lv-explain-throttles-exceptions | explain | miss 7,229 | miss 12 |
| lv-usage-image-driver | usage | found 8,316 | miss 12 |
| lv-usage-fail-job | usage | found 8,320 | miss 12 |
| lv-usage-batch-record | usage | miss 8,317 | miss 12 |
| lv-impact-max-exceptions | impact | found 8,308 | miss 12 |
| lv-impact-flexible-prefix | impact | miss 8,328 | miss 12 |

## medusa

typescript · v2.21.2 · 12 tasks

| tool | version | mode | index time | index size | fixed overhead per request | median query | errors |
|---|---|---|---|---|---|---|---|
| codegraph | 1.6.2 | default | 30.5 s | 328 MB | 2,815 tok (1 tools) | 299 ms | 0 |
| kirograph | 1.4.0 | default | 959.5 s | 162 MB | 1,473 tok (7 tools) | 126 ms | 1 |

### medusa, input = `search`

| strategy | source | found | file recall | symbol recall | def recall | median tok | p90 tok | tokens / found task | calls |
|---|---|---|---|---|---|---|---|---|---|
| codegraph | container | 7/12 | 87 % | 74 % | 36 % | 8,317 | 8,329 | 13,900 | 1.0 |
| kirograph | container | 0/12 | 11 % | 10 % | 0 % | 1,269 | 1,565 | - | 1.0 |
| native-naive | kopt bench 2026-10-09 | 5/12 | 58 % | 58 % | 45 % | 28,854 | 50,387 | 81,032 | 3.5 |
| native-ranged | kopt bench 2026-10-09 | 3/12 | 58 % | 46 % | 30 % | 6,994 | 9,825 | 27,520 | 4.0 |
| kopt-pack | kopt bench 2026-10-09 | 3/12 | 61 % | 79 % | 40 % | 857 | 1,779 | 3,745 | 1.0 |
| kopt-hits+read | kopt bench 2026-10-09 | 3/12 | 61 % | 49 % | 45 % | 1,147 | 2,213 | 5,721 | 3.0 |

Pass-gated pairs (tokens b / a over tasks found by both; < 1 means b is cheaper):

| a | b | found by both | only a | only b | median b/a | geo-mean b/a |
|---|---|---|---|---|---|---|
| kopt-pack | codegraph | 1/12 | 2 | 6 | 4.68 | 4.68 |
| native-ranged | codegraph | 3/12 | 0 | 4 | 1.79 | 1.63 |
| kopt-pack | kirograph | 0/12 | 3 | 0 | - | - |
| native-ranged | kirograph | 0/12 | 3 | 0 | - | - |

| task | kind | codegraph | kirograph | native-ranged | kopt-pack |
|---|---|---|---|---|---|
| md-locate-permanent-failure | locate | found 8,300 | miss 1,565 | miss 9,042 | miss 297 |
| md-locate-available-quantity | locate | miss 8,329 | miss 1,090 | miss 7,149 | found 978 |
| md-locate-capture-payment | locate | miss 8,321 | miss 1,045 | miss 10,316 | found 969 |
| md-locate-lock-renewal | locate | found 8,320 | miss 1,342 | found 7,969 | found 1,779 |
| md-explain-compensation | explain | miss 8,328 | miss 1,025 | miss 9,668 | miss 1,060 |
| md-explain-buy-get | explain | found 8,316 | miss 1,750 | miss 6,839 | miss 1,913 |
| md-explain-price-lists | explain | miss 8,317 | miss 1,137 | miss 9,825 | miss 1,126 |
| md-usage-cancel-transaction | usage | found 8,308 | miss 1,313 | found 4,640 | miss 665 |
| md-usage-refund-hook | usage | found 8,224 | miss 1,149 | found 3,552 | miss 733 |
| md-usage-rules-valid | usage | found 8,316 | miss 1,224 | miss 4,668 | miss 745 |
| md-impact-budget-exceeded | impact | miss 5,891 | miss 1,556 | miss 3,045 | miss 592 |
| md-impact-transaction-key | impact | found 8,331 | miss 1,319 | miss 5,848 | miss 378 |

### medusa, input = `question`

| strategy | source | found | file recall | symbol recall | def recall | median tok | p90 tok | tokens / found task | calls |
|---|---|---|---|---|---|---|---|---|---|
| codegraph | container | 4/12 | 75 % | 56 % | 22 % | 8,319 | 8,327 | 24,718 | 1.0 |
| kirograph | container | 0/12 (6 err) | 0 % | 0 % | 0 % | 1,129 | 2,584 | - | 1.0 |

| task | kind | codegraph | kirograph |
|---|---|---|---|
| md-locate-permanent-failure | locate | miss 8,164 | miss 12 |
| md-locate-available-quantity | locate | miss 8,332 | miss 1,205 |
| md-locate-capture-payment | locate | miss 8,323 | miss 1,023 |
| md-locate-lock-renewal | locate | found 8,311 | miss 950 |
| md-explain-compensation | explain | miss 8,327 | miss 1,053 |
| md-explain-buy-get | explain | miss 8,313 | miss 1,789 |
| md-explain-price-lists | explain | miss 8,320 | miss 2,584 |
| md-usage-cancel-transaction | usage | found 8,320 | miss 12 |
| md-usage-refund-hook | usage | miss 8,318 | miss 12 |
| md-usage-rules-valid | usage | found 8,319 | miss 12 |
| md-impact-budget-exceeded | impact | found 8,297 | miss 12 |
| md-impact-transaction-key | impact | miss 7,529 | miss 12 |

## meilisearch

rust · v1.54.3 · 12 tasks

| tool | version | mode | index time | index size | fixed overhead per request | median query | errors |
|---|---|---|---|---|---|---|---|
| codegraph | 1.6.2 | default | 8.1 s | 79 MB | 2,815 tok (1 tools) | 122 ms | 0 |
| kirograph | 1.4.0 | default | 93.9 s | 67 MB | 1,473 tok (7 tools) | 44 ms | 1 |

### meilisearch, input = `search`

| strategy | source | found | file recall | symbol recall | def recall | median tok | p90 tok | tokens / found task | calls |
|---|---|---|---|---|---|---|---|---|---|
| codegraph | container | 5/12 | 69 % | 68 % | 32 % | 8,318 | 8,327 | 19,337 | 1.0 |
| kirograph | container | 0/12 | 36 % | 9 % | 0 % | 1,058 | 2,770 | - | 1.0 |
| native-naive | kopt bench 2026-10-09 | 7/12 | 67 % | 71 % | 49 % | 28,385 | 49,448 | 53,591 | 3.8 |
| native-ranged | kopt bench 2026-10-09 | 3/12 | 67 % | 53 % | 35 % | 6,194 | 7,821 | 25,791 | 3.9 |
| kopt-pack | kopt bench 2026-10-09 | 1/12 | 70 % | 54 % | 36 % | 983 | 1,294 | 11,211 | 1.0 |
| kopt-hits+read | kopt bench 2026-10-09 | 2/12 | 80 % | 50 % | 43 % | 852 | 1,126 | 5,574 | 3.0 |

Pass-gated pairs (tokens b / a over tasks found by both; < 1 means b is cheaper):

| a | b | found by both | only a | only b | median b/a | geo-mean b/a |
|---|---|---|---|---|---|---|
| kopt-pack | codegraph | 1/12 | 0 | 4 | 8.47 | 8.47 |
| native-ranged | codegraph | 2/12 | 1 | 3 | 1.93 | 1.92 |
| kopt-pack | kirograph | 0/12 | 1 | 0 | - | - |
| native-ranged | kirograph | 0/12 | 3 | 0 | - | - |

| task | kind | codegraph | kirograph | native-ranged | kopt-pack |
|---|---|---|---|---|---|
| ms-locate-tenant-token | locate | miss 5,282 | miss 862 | miss 6,705 | miss 700 |
| ms-locate-filter-precedence | locate | found 8,317 | miss 1,047 | miss 5,705 | miss 1,162 |
| ms-locate-disabled-typos | locate | found 8,318 | miss 824 | miss 7,821 | found 982 |
| ms-locate-index-eviction | locate | miss 8,307 | miss 3,456 | found 6,212 | miss 995 |
| ms-explain-autobatch | explain | miss 8,318 | miss 977 | miss 11,543 | miss 1,294 |
| ms-explain-dynamic-rules | explain | miss 8,249 | miss 2,468 | miss 7,106 | miss 481 |
| ms-explain-bucket-sort | explain | miss 8,298 | miss 1,335 | miss 6,176 | miss 1,848 |
| ms-usage-is-exact | usage | found 8,326 | miss 533 | miss 5,146 | miss 524 |
| ms-usage-close-for-resize | usage | found 8,283 | miss 1,176 | found 4,767 | miss 697 |
| ms-usage-facet-bounds | usage | miss 8,333 | miss 1,068 | miss 6,010 | miss 986 |
| ms-impact-bucket-sort | impact | found 8,327 | miss 848 | found 3,917 | miss 558 |
| ms-impact-search-rules | impact | miss 8,327 | miss 2,770 | miss 6,264 | miss 984 |

### meilisearch, input = `question`

| strategy | source | found | file recall | symbol recall | def recall | median tok | p90 tok | tokens / found task | calls |
|---|---|---|---|---|---|---|---|---|---|
| codegraph | container | 3/12 | 63 % | 54 % | 32 % | 8,317 | 8,331 | 32,037 | 1.0 |
| kirograph | container | 0/12 (6 err) | 3 % | 0 % | 0 % | 2,493 | 5,023 | - | 1.0 |

| task | kind | codegraph | kirograph |
|---|---|---|---|
| ms-locate-tenant-token | locate | miss 6,228 | miss 890 |
| ms-locate-filter-precedence | locate | miss 8,331 | miss 2,488 |
| ms-locate-disabled-typos | locate | found 8,322 | miss 12 |
| ms-locate-index-eviction | locate | miss 8,320 | miss 1,486 |
| ms-explain-autobatch | explain | miss 8,300 | miss 5,023 |
| ms-explain-dynamic-rules | explain | miss 7,188 | miss 2,518 |
| ms-explain-bucket-sort | explain | miss 8,322 | miss 2,497 |
| ms-usage-is-exact | usage | miss 8,314 | miss 12 |
| ms-usage-close-for-resize | usage | found 8,322 | miss 12 |
| ms-usage-facet-bounds | usage | miss 8,295 | miss 12 |
| ms-impact-bucket-sort | impact | found 8,331 | miss 12 |
| ms-impact-search-rules | impact | miss 7,839 | miss 12 |

## playframework

scala · 3.0.12 · 12 tasks

| tool | version | mode | index time | index size | fixed overhead per request | median query | errors |
|---|---|---|---|---|---|---|---|
| codegraph | 1.6.2 | default | 9.7 s | 103 MB | 2,815 tok (1 tools) | 152 ms | 0 |
| kirograph | 1.4.0 | default | 103.7 s | 78 MB | 1,473 tok (7 tools) | 44 ms | 1 |

### playframework, input = `search`

| strategy | source | found | file recall | symbol recall | def recall | median tok | p90 tok | tokens / found task | calls |
|---|---|---|---|---|---|---|---|---|---|
| codegraph | container | 10/12 | 92 % | 85 % | 51 % | 8,319 | 8,330 | 9,839 | 1.0 |
| kirograph | container | 0/12 | 17 % | 10 % | 3 % | 1,307 | 2,238 | - | 1.0 |
| native-naive | kopt bench 2026-10-09 | 9/12 | 92 % | 79 % | 75 % | 21,802 | 30,592 | 30,723 | 3.9 |
| native-ranged | kopt bench 2026-10-09 | 5/12 | 92 % | 52 % | 43 % | 7,631 | 9,495 | 24,245 | 4.5 |
| kopt-pack | kopt bench 2026-10-09 | 3/12 | 83 % | 54 % | 28 % | 909 | 1,151 | 3,619 | 1.0 |
| kopt-hits+read | kopt bench 2026-10-09 | 3/12 | 83 % | 40 % | 31 % | 1,171 | 1,748 | 4,898 | 3.0 |

Pass-gated pairs (tokens b / a over tasks found by both; < 1 means b is cheaper):

| a | b | found by both | only a | only b | median b/a | geo-mean b/a |
|---|---|---|---|---|---|---|
| kopt-pack | codegraph | 3/12 | 0 | 7 | 8.46 | 9.60 |
| native-ranged | codegraph | 5/12 | 0 | 5 | 1.02 | 0.77 |
| kopt-pack | kirograph | 0/12 | 3 | 0 | - | - |
| native-ranged | kirograph | 0/12 | 5 | 0 | - | - |

| task | kind | codegraph | kirograph | native-ranged | kopt-pack |
|---|---|---|---|---|---|
| pf-locate-evolution-conflict | locate | found 8,330 | miss 658 | found 36,185 | found 985 |
| pf-locate-csrf-body-token | locate | miss 8,333 | miss 972 | miss 8,263 | miss 1,143 |
| pf-locate-jwt-session | locate | found 8,299 | miss 1,348 | miss 6,863 | miss 770 |
| pf-locate-routes-validation | locate | found 7,795 | miss 1,094 | miss 6,891 | miss 586 |
| pf-explain-gzip | explain | miss 7,764 | miss 1,405 | miss 9,495 | miss 1,151 |
| pf-explain-forwarded | explain | found 8,322 | miss 1,284 | found 8,979 | miss 833 |
| pf-explain-cached | explain | found 8,318 | miss 1,329 | miss 6,746 | miss 1,286 |
| pf-usage-prepare-cookies | usage | found 8,329 | miss 2,238 | miss 7,284 | miss 739 |
| pf-usage-enforce-max-length | usage | found 8,325 | miss 2,514 | found 7,175 | miss 1,077 |
| pf-usage-assets-digest | usage | found 7,946 | miss 1,143 | miss 7,184 | miss 568 |
| pf-impact-requires-csrf-check | impact | found 8,306 | miss 1,097 | found 8,181 | found 579 |
| pf-impact-get-handler-for | impact | found 8,319 | miss 2,238 | found 7,978 | found 1,141 |

### playframework, input = `question`

| strategy | source | found | file recall | symbol recall | def recall | median tok | p90 tok | tokens / found task | calls |
|---|---|---|---|---|---|---|---|---|---|
| codegraph | container | 3/12 | 88 % | 56 % | 31 % | 8,307 | 8,329 | 33,186 | 1.0 |
| kirograph | container | 0/12 (6 err) | 8 % | 0 % | 0 % | 1,304 | 1,437 | - | 1.0 |

| task | kind | codegraph | kirograph |
|---|---|---|---|
| pf-locate-evolution-conflict | locate | miss 8,315 | miss 1,284 |
| pf-locate-csrf-body-token | locate | miss 8,325 | miss 1,197 |
| pf-locate-jwt-session | locate | miss 8,329 | miss 1,389 |
| pf-locate-routes-validation | locate | found 8,150 | miss 1,127 |
| pf-explain-gzip | explain | miss 8,311 | miss 1,437 |
| pf-explain-forwarded | explain | miss 8,295 | miss 1,324 |
| pf-explain-cached | explain | miss 8,331 | miss 12 |
| pf-usage-prepare-cookies | usage | miss 8,285 | miss 12 |
| pf-usage-enforce-max-length | usage | found 8,297 | miss 12 |
| pf-usage-assets-digest | usage | miss 8,317 | miss 12 |
| pf-impact-requires-csrf-check | impact | miss 8,303 | miss 12 |
| pf-impact-get-handler-for | impact | found 8,301 | miss 12 |

## spring-framework

java · v7.0.9 · 15 tasks

| tool | version | mode | index time | index size | fixed overhead per request | median query | errors |
|---|---|---|---|---|---|---|---|
| codegraph | 1.6.2 | default | 130.2 s | 863 MB | 2,815 tok (1 tools) | 858 ms | 0 |
| kirograph | 1.4.0 | default | 1948.6 s | 851 MB | 1,473 tok (7 tools) | 200 ms | 1 |

### spring-framework, input = `search`

| strategy | source | found | file recall | symbol recall | def recall | median tok | p90 tok | tokens / found task | calls |
|---|---|---|---|---|---|---|---|---|---|
| codegraph | container | 8/15 | 80 % | 76 % | 47 % | 8,307 | 8,324 | 14,584 | 1.0 |
| kirograph | container | 0/15 | 27 % | 21 % | 0 % | 1,208 | 1,655 | - | 1.0 |
| native-naive | kopt bench 2026-10-09 | 9/15 | 82 % | 71 % | 63 % | 19,851 | 40,375 | 38,303 | 3.8 |
| native-ranged | kopt bench 2026-10-09 | 8/15 | 82 % | 70 % | 57 % | 7,378 | 9,517 | 14,080 | 4.2 |
| kopt-pack | kopt bench 2026-10-09 | 5/15 | 72 % | 75 % | 43 % | 807 | 1,363 | 2,538 | 1.0 |
| kopt-hits+read | kopt bench 2026-10-09 | 5/15 | 81 % | 64 % | 54 % | 1,471 | 2,425 | 4,368 | 3.0 |

Pass-gated pairs (tokens b / a over tasks found by both; < 1 means b is cheaper):

| a | b | found by both | only a | only b | median b/a | geo-mean b/a |
|---|---|---|---|---|---|---|
| kopt-pack | codegraph | 5/15 | 0 | 3 | 14.54 | 12.71 |
| native-ranged | codegraph | 6/15 | 2 | 2 | 1.13 | 1.08 |
| kopt-pack | kirograph | 0/15 | 5 | 0 | - | - |
| native-ranged | kirograph | 0/15 | 8 | 0 | - | - |

| task | kind | codegraph | kirograph | native-ranged | kopt-pack |
|---|---|---|---|---|---|
| sf-locate-retry-loop | locate | miss 8,320 | miss 1,172 | miss 8,971 | miss 1,041 |
| sf-locate-api-version | locate | miss 8,307 | miss 1,149 | miss 9,466 | miss 1,363 |
| sf-locate-sqlstate-lock | locate | found 8,028 | miss 935 | miss 6,511 | miss 499 |
| sf-locate-advice-order | locate | found 3,938 | miss 1,127 | found 7,360 | found 935 |
| sf-explain-concurrency-limit | explain | found 8,321 | miss 1,806 | found 9,115 | miss 829 |
| sf-explain-retryable | explain | miss 7,384 | miss 1,370 | miss 7,682 | miss 2,168 |
| sf-explain-config-full-lite | explain | miss 8,315 | miss 1,337 | miss 9,933 | miss 595 |
| sf-explain-exponential-backoff | explain | found 7,799 | miss 1,138 | found 6,864 | found 1,142 |
| sf-usage-fail-early | usage | found 8,314 | miss 1,655 | found 4,794 | found 265 |
| sf-usage-trigger-flush | usage | miss 8,274 | miss 1,139 | found 6,597 | miss 749 |
| sf-usage-imported-by | usage | miss 6,406 | miss 1,289 | found 3,582 | miss 464 |
| sf-usage-lru-drain | usage | found 8,324 | miss 1,304 | found 5,850 | miss 807 |
| sf-impact-shortcut | impact | found 8,316 | miss 1,208 | miss 9,517 | found 572 |
| sf-impact-primary-conflict | impact | miss 8,297 | miss 1,165 | miss 9,017 | miss 931 |
| sf-impact-cleanup-txinfo | impact | found 8,330 | miss 1,222 | found 7,378 | found 329 |

### spring-framework, input = `question`

| strategy | source | found | file recall | symbol recall | def recall | median tok | p90 tok | tokens / found task | calls |
|---|---|---|---|---|---|---|---|---|---|
| codegraph | container | 7/15 | 68 % | 69 % | 43 % | 8,293 | 8,325 | 17,131 | 1.0 |
| kirograph | container | 0/15 (9 err) | 4 % | 2 % | 0 % | 1,126 | 1,303 | - | 1.0 |
| native-naive | kopt bench 2026-10-09 | 6/15 | 56 % | 52 % | 42 % | 19,851 | 43,980 | 54,596 | 3.6 |
| native-ranged | kopt bench 2026-10-09 | 4/15 | 56 % | 46 % | 29 % | 7,270 | 9,556 | 25,069 | 4.1 |
| kopt-pack | kopt bench 2026-10-09 | 4/15 | 63 % | 59 % | 30 % | 978 | 1,550 | 3,820 | 1.0 |
| kopt-hits+read | kopt bench 2026-10-09 | 2/15 | 68 % | 43 % | 37 % | 1,190 | 1,822 | 8,890 | 3.0 |

Pass-gated pairs (tokens b / a over tasks found by both; < 1 means b is cheaper):

| a | b | found by both | only a | only b | median b/a | geo-mean b/a |
|---|---|---|---|---|---|---|
| kopt-pack | codegraph | 4/15 | 0 | 3 | 16.74 | 15.38 |
| native-ranged | codegraph | 3/15 | 1 | 4 | 1.26 | 1.35 |
| kopt-pack | kirograph | 0/15 | 4 | 0 | - | - |
| native-ranged | kirograph | 0/15 | 4 | 0 | - | - |

| task | kind | codegraph | kirograph | native-ranged | kopt-pack |
|---|---|---|---|---|---|
| sf-locate-retry-loop | locate | found 8,293 | miss 1,223 | miss 921 | miss 1,087 |
| sf-locate-api-version | locate | miss 7,770 | miss 1,111 | miss 7,755 | miss 978 |
| sf-locate-sqlstate-lock | locate | miss 8,270 | miss 950 | miss 6,354 | miss 527 |
| sf-locate-advice-order | locate | miss 8,332 | miss 983 | miss 9,556 | miss 712 |
| sf-explain-concurrency-limit | explain | miss 8,309 | miss 12 | miss 6,661 | miss 1,182 |
| sf-explain-retryable | explain | miss 8,278 | miss 12 | miss 6,106 | miss 1,550 |
| sf-explain-config-full-lite | explain | miss 7,704 | miss 12 | miss 9,556 | miss 1,547 |
| sf-explain-exponential-backoff | explain | found 8,275 | miss 12 | miss 7,534 | found 1,150 |
| sf-usage-fail-early | usage | found 8,317 | miss 12 | found 4,794 | found 738 |
| sf-usage-trigger-flush | usage | found 8,306 | miss 12 | found 6,597 | miss 1,033 |
| sf-usage-imported-by | usage | miss 6,417 | miss 12 | found 3,582 | miss 777 |
| sf-usage-lru-drain | usage | found 8,320 | miss 1,303 | miss 8,546 | miss 877 |
| sf-impact-shortcut | impact | found 8,305 | miss 12 | miss 7,270 | found 374 |
| sf-impact-primary-conflict | impact | miss 6,694 | miss 1,140 | miss 7,666 | miss 2,481 |
| sf-impact-cleanup-txinfo | impact | found 8,325 | miss 12 | found 7,378 | found 268 |

## webpack

javascript · v5.111.1 · 12 tasks

| tool | version | mode | index time | index size | fixed overhead per request | median query | errors |
|---|---|---|---|---|---|---|---|
| codegraph | 1.6.2 | default | 171.0 s | 152 MB | 2,815 tok (1 tools) | 243 ms | 0 |
| kirograph | 1.4.0 | default | 573.7 s | 111 MB | 1,473 tok (7 tools) | 99 ms | 1 |

### webpack, input = `search`

| strategy | source | found | file recall | symbol recall | def recall | median tok | p90 tok | tokens / found task | calls |
|---|---|---|---|---|---|---|---|---|---|
| codegraph | container | 5/12 | 58 % | 67 % | 41 % | 8,325 | 8,331 | 19,976 | 1.0 |
| kirograph | container | 1/12 | 19 % | 17 % | 8 % | 752 | 5,023 | 19,095 | 1.0 |
| native-naive | kopt bench 2026-10-09 | 6/12 | 75 % | 76 % | 65 % | 32,203 | 47,931 | 67,104 | 3.8 |
| native-ranged | kopt bench 2026-10-09 | 5/12 | 75 % | 61 % | 49 % | 5,649 | 7,586 | 40,465 | 4.4 |
| kopt-pack | kopt bench 2026-10-09 | 6/12 | 67 % | 75 % | 64 % | 693 | 1,130 | 1,391 | 1.0 |
| kopt-hits+read | kopt bench 2026-10-09 | 7/12 | 71 % | 65 % | 55 % | 1,269 | 3,123 | 2,692 | 3.0 |

Pass-gated pairs (tokens b / a over tasks found by both; < 1 means b is cheaper):

| a | b | found by both | only a | only b | median b/a | geo-mean b/a |
|---|---|---|---|---|---|---|
| kopt-pack | codegraph | 2/12 | 4 | 3 | 15.10 | 11.55 |
| native-ranged | codegraph | 3/12 | 2 | 2 | 1.41 | 0.55 |
| kopt-pack | kirograph | 1/12 | 5 | 0 | 1.24 | 1.24 |
| native-ranged | kirograph | 1/12 | 4 | 0 | 0.01 | 0.01 |

| task | kind | codegraph | kirograph | native-ranged | kopt-pack |
|---|---|---|---|---|---|
| wp-locate-dotenv-expand | locate | found 8,325 | found 1,927 | found 143,254 | found 1,550 |
| wp-locate-semver-satisfy | locate | miss 8,329 | miss 729 | miss 5,853 | found 779 |
| wp-locate-case-mismatch | locate | miss 8,315 | miss 5,023 | miss 5,156 | miss 653 |
| wp-locate-circular-hints | locate | miss 8,316 | miss 732 | miss 3,763 | found 244 |
| wp-explain-lazy-barrel | explain | miss 8,329 | miss 945 | found 7,576 | found 905 |
| wp-explain-deterministic-grouping | explain | miss 8,331 | miss 669 | found 5,927 | found 816 |
| wp-explain-circular-scc | explain | found 8,324 | miss 735 | miss 7,586 | miss 1,130 |
| wp-usage-process-async-tree | usage | found 8,329 | miss 5,023 | miss 4,761 | miss 691 |
| wp-usage-unlazy-for-dependency | usage | miss 8,325 | miss 769 | miss 3,051 | miss 217 |
| wp-usage-implicit-type-fallback | usage | found 8,305 | miss 1,146 | found 5,875 | miss 695 |
| wp-impact-legacy-is-circular | impact | miss 8,332 | miss 670 | miss 5,444 | miss 328 |
| wp-impact-synchronous-target | impact | found 8,319 | miss 727 | found 4,079 | found 335 |

### webpack, input = `question`

| strategy | source | found | file recall | symbol recall | def recall | median tok | p90 tok | tokens / found task | calls |
|---|---|---|---|---|---|---|---|---|---|
| codegraph | container | 6/12 | 58 % | 65 % | 31 % | 8,323 | 8,331 | 16,628 | 1.0 |
| kirograph | container | 0/12 (7 err) | 4 % | 2 % | 2 % | 693 | 742 | - | 1.0 |

| task | kind | codegraph | kirograph |
|---|---|---|---|
| wp-locate-dotenv-expand | locate | found 8,328 | miss 12 |
| wp-locate-semver-satisfy | locate | miss 8,312 | miss 693 |
| wp-locate-case-mismatch | locate | found 8,312 | miss 742 |
| wp-locate-circular-hints | locate | miss 8,315 | miss 12 |
| wp-explain-lazy-barrel | explain | miss 8,331 | miss 684 |
| wp-explain-deterministic-grouping | explain | miss 8,218 | miss 699 |
| wp-explain-circular-scc | explain | found 8,328 | miss 670 |
| wp-usage-process-async-tree | usage | found 8,331 | miss 12 |
| wp-usage-unlazy-for-dependency | usage | miss 8,325 | miss 12 |
| wp-usage-implicit-type-fallback | usage | found 8,331 | miss 12 |
| wp-impact-legacy-is-circular | impact | miss 8,318 | miss 12 |
| wp-impact-synchronous-target | impact | found 8,320 | miss 12 |

Cells of the per-task tables: `found`/`miss` (all gold files and symbol names present) and the estimated tokens returned by the single call.
