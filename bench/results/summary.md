# kopt bench: multi-language summary

11 repositories (11 measured) · input = `search` · 2026-10-09T22:39:50.625Z · node v22.23.3 · darwin-arm64

> Offline proxy: tokens = estimated tokens of the tool outputs returned to the model for ONE exploration step.
> It is not a credit measurement; savings must be confirmed by the online A/B (bench/ab).

## Index and extraction quality

| language | repo | KLOC | files indexed (skipped) | index time | symbols | symbols/KLOC | files with parse errors | refs resolved | resolved of in-repo names | precision sample | gold issues |
|---|---|---|---|---|---|---|---|---|---|---|---|
| java | spring-framework@v7.0.9 | 1501 | 9,552 (0) | 20.2 s | 138,619 | 90.4 | 1.0% | 51% | 68% | 100% (n=30) | 0 |
| python | django@6.1.2 | 525 | 2,964 (0) | 6.8 s | 51,183 | 97.4 | 0.0% | 44% | 59% | 100% (n=30) | 0 |
| typescript | medusa@v2.21.2 | 932 | 11,970 (9) | 12.8 s | 40,269 | 34.9 | 0.1% | 25% | 36% | 100% (n=30) | 0 |
| javascript | webpack@v5.111.1 | 582 | 14,902 (50) | 5.0 s | 22,575 | 27.2 | 1.9% | 20% | 32% | 100% (n=30) | 0 |
| c_sharp | jellyfin@v10.11.11 | 278 | 1,922 (0) | 2.1 s | 17,980 | 77.5 | 0.7% | 49% | 73% | 97% (n=30) | 0 |
| go | gitea@v28.1.0 | 505 | 3,402 (3) | 6.3 s | 32,905 | 63.4 | 1.3% | 61% | 73% | 100% (n=30) | 0 |
| kotlin | exposed@1.5.0 | 142 | 864 (2) | 2.1 s | 12,962 | 91.1 | 1.2% | 51% | 73% | 97% (n=30) | 0 |
| rust | meilisearch@v1.54.3 | 268 | 715 (0) | 2.2 s | 18,280 | 68.2 | 0.1% | 39% | 52% | 100% (n=30) | 0 |
| php | laravel@v13.35.0 | 574 | 3,114 (2) | 4.4 s | 40,979 | 71.3 | 0.3% | 55% | 72% | 100% (n=30) | 0 |
| ruby | discourse@v2026.9.0 | 1422 | 15,517 (5) | 10.4 s | 82,698 | 44.0 | 0.0% | 21% | 28% | 100% (n=30) | 0 |
| scala | playframework@3.0.12 | 114 | 1,427 (0) | 2.2 s | 18,592 | 105.7 | 0.0% | 38% | 57% | 100% (n=30) | 0 |

Quality columns are for the primary language of each repo; see `quality-<repo>.md` for every language and the failed samples.

## Tasks found per strategy

| language | repo | tasks | native-naive | native-ranged | kopt-pack | kopt-hits+read | kirograph | codegraph |
|---|---|---|---|---|---|---|---|---|
| java | spring-framework | 15 | 9/15 | 8/15 | 11/15 | 5/15 | 0/15 | 8/15 |
| python | django | 15 | 7/15 | 8/15 | 13/15 | 7/15 | 1/15 | 8/15 |
| typescript | medusa | 12 | 5/12 | 3/12 | 9/12 | 4/12 | 0/12 | 7/12 |
| javascript | webpack | 12 | 6/12 | 5/12 | 11/12 | 7/12 | 1/12 | 5/12 |
| c_sharp | jellyfin | 12 | 5/12 | 5/12 | 10/12 | 2/12 | 0/12 | 8/12 |
| go | gitea | 12 | 4/12 | 3/12 | 11/12 | 5/12 | 0/12 | 6/12 |
| kotlin | exposed | 12 | 4/12 | 4/12 | 8/12 | 2/12 | 1/12 | 9/12 |
| rust | meilisearch | 12 | 7/12 | 3/12 | 7/12 | 4/12 | 0/12 | 5/12 |
| php | laravel | 12 | 6/12 | 4/12 | 9/12 | 6/12 | 0/12 | 5/12 |
| ruby | discourse | 12 | 3/12 | 6/12 | 11/12 | 7/12 | 1/12 | 8/12 |
| scala | playframework | 12 | 9/12 | 5/12 | 8/12 | 5/12 | 0/12 | 10/12 |
| **all** |  | 138 | **65/138 (47%)** | **54/138 (39%)** | **108/138 (78%)** | **54/138 (39%)** | **4/138 (3%)** | **79/138 (57%)** |

## Median tokens per task

| language | repo | tasks | native-naive | native-ranged | kopt-pack | kopt-hits+read | kirograph | codegraph |
|---|---|---|---|---|---|---|---|---|
| java | spring-framework | 15 | 19,851 | 7,378 | 1,327 | 1,884 | 1,208 | 8,307 |
| python | django | 15 | 43,715 | 6,737 | 1,206 | 861 | 799 | 8,317 |
| typescript | medusa | 12 | 28,854 | 6,994 | 1,300 | 995 | 1,269 | 8,317 |
| javascript | webpack | 12 | 32,203 | 5,649 | 1,110 | 1,315 | 752 | 8,325 |
| c_sharp | jellyfin | 12 | 13,681 | 6,578 | 1,299 | 1,310 | 865 | 8,316 |
| go | gitea | 12 | 14,142 | 6,266 | 1,132 | 752 | 482 | 8,257 |
| kotlin | exposed | 12 | 15,910 | 9,659 | 1,302 | 906 | 1,100 | 8,305 |
| rust | meilisearch | 12 | 28,385 | 6,194 | 1,325 | 832 | 1,058 | 8,318 |
| php | laravel | 12 | 22,327 | 4,786 | 1,298 | 1,007 | 1,382 | 8,308 |
| ruby | discourse | 12 | 22,658 | 5,988 | 1,310 | 1,166 | 1,020 | 7,954 |
| scala | playframework | 12 | 21,802 | 7,631 | 1,319 | 1,346 | 1,307 | 8,319 |
| **all** |  | 138 | **25,055** | **6,675** | **1,299** | **1,092** | **1,085** | **8,315** |

## Tokens per found task (failures included)

| language | repo | tasks | native-naive | native-ranged | kopt-pack | kopt-hits+read | kirograph | codegraph |
|---|---|---|---|---|---|---|---|---|
| java | spring-framework | 15 | 38,303 | 14,080 | 1,778 | 6,935 | n/a | 14,584 |
| python | django | 15 | 83,575 | 11,497 | 1,173 | 2,415 | 19,329 | 15,192 |
| typescript | medusa | 12 | 81,032 | 27,520 | 1,628 | 4,488 | n/a | 13,900 |
| javascript | webpack | 12 | 67,104 | 40,465 | 1,152 | 2,870 | 19,095 | 19,976 |
| c_sharp | jellyfin | 12 | 46,284 | 16,238 | 1,369 | 10,631 | n/a | 12,058 |
| go | gitea | 12 | 137,331 | 30,561 | 1,196 | 2,107 | n/a | 15,262 |
| kotlin | exposed | 12 | 88,573 | 85,522 | 1,703 | 5,963 | 20,798 | 11,019 |
| rust | meilisearch | 12 | 53,591 | 25,791 | 2,204 | 3,339 | n/a | 19,337 |
| php | laravel | 12 | 58,428 | 102,016 | 1,646 | 2,706 | n/a | 19,017 |
| ruby | discourse | 12 | 108,903 | 14,844 | 1,307 | 2,040 | 15,730 | 11,477 |
| scala | playframework | 12 | 30,723 | 24,245 | 2,006 | 3,762 | n/a | 9,839 |
| **all** |  | 138 | **64,638** | **31,485** | **1,512** | **3,630** | **43,774** | **13,982** |

## Mean symbol recall

| language | repo | tasks | native-naive | native-ranged | kopt-pack | kopt-hits+read | kirograph | codegraph |
|---|---|---|---|---|---|---|---|---|
| java | spring-framework | 15 | 71% | 70% | 93% | 71% | 21% | 76% |
| python | django | 15 | 63% | 67% | 97% | 74% | 26% | 81% |
| typescript | medusa | 12 | 58% | 46% | 92% | 58% | 10% | 74% |
| javascript | webpack | 12 | 76% | 61% | 92% | 67% | 17% | 67% |
| c_sharp | jellyfin | 12 | 71% | 76% | 90% | 44% | 9% | 79% |
| go | gitea | 12 | 64% | 64% | 96% | 67% | 9% | 69% |
| kotlin | exposed | 12 | 57% | 61% | 91% | 62% | 24% | 100% |
| rust | meilisearch | 12 | 71% | 53% | 77% | 65% | 9% | 68% |
| php | laravel | 12 | 71% | 62% | 94% | 84% | 17% | 70% |
| ruby | discourse | 12 | 48% | 60% | 98% | 78% | 10% | 71% |
| scala | playframework | 12 | 79% | 52% | 90% | 69% | 10% | 85% |
| **all** |  | 138 | **66%** | **61%** | **92%** | **67%** | **15%** | **76%** |

## Found by task kind

| language | repo | native-ranged locate | native-ranged explain | native-ranged usage | native-ranged impact | kopt-pack locate | kopt-pack explain | kopt-pack usage | kopt-pack impact | kirograph locate | kirograph explain | kirograph usage | kirograph impact | codegraph locate | codegraph explain | codegraph usage | codegraph impact |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| java | spring-framework | 1/4 | 2/4 | 4/4 | 1/3 | 2/4 | 2/4 | 4/4 | 3/3 | 0/4 | 0/4 | 0/4 | 0/3 | 2/4 | 2/4 | 2/4 | 2/3 |
| python | django | 1/4 | 3/4 | 2/4 | 2/3 | 4/4 | 2/4 | 4/4 | 3/3 | 0/4 | 1/4 | 0/4 | 0/3 | 2/4 | 2/4 | 1/4 | 3/3 |
| typescript | medusa | 1/4 | 0/3 | 2/3 | 0/2 | 4/4 | 1/3 | 3/3 | 1/2 | 0/4 | 0/3 | 0/3 | 0/2 | 2/4 | 1/3 | 3/3 | 1/2 |
| javascript | webpack | 1/4 | 2/3 | 1/3 | 1/2 | 4/4 | 3/3 | 2/3 | 2/2 | 1/4 | 0/3 | 0/3 | 0/2 | 1/4 | 1/3 | 2/3 | 1/2 |
| c_sharp | jellyfin | 1/4 | 2/3 | 1/3 | 1/2 | 3/4 | 2/3 | 3/3 | 2/2 | 0/4 | 0/3 | 0/3 | 0/2 | 2/4 | 1/3 | 3/3 | 2/2 |
| go | gitea | 2/4 | 0/3 | 1/3 | 0/2 | 4/4 | 2/3 | 3/3 | 2/2 | 0/4 | 0/3 | 0/3 | 0/2 | 2/4 | 1/3 | 2/3 | 1/2 |
| kotlin | exposed | 2/4 | 0/3 | 1/3 | 1/2 | 3/4 | 0/3 | 3/3 | 2/2 | 1/4 | 0/3 | 0/3 | 0/2 | 2/4 | 2/3 | 3/3 | 2/2 |
| rust | meilisearch | 1/4 | 0/3 | 1/3 | 1/2 | 4/4 | 1/3 | 1/3 | 1/2 | 0/4 | 0/3 | 0/3 | 0/2 | 2/4 | 0/3 | 2/3 | 1/2 |
| php | laravel | 1/4 | 0/3 | 1/3 | 2/2 | 3/4 | 1/3 | 3/3 | 2/2 | 0/4 | 0/3 | 0/3 | 0/2 | 1/4 | 1/3 | 2/3 | 1/2 |
| ruby | discourse | 2/4 | 0/3 | 3/3 | 1/2 | 4/4 | 2/3 | 3/3 | 2/2 | 1/4 | 0/3 | 0/3 | 0/2 | 2/4 | 3/3 | 1/3 | 2/2 |
| scala | playframework | 1/4 | 1/3 | 1/3 | 2/2 | 3/4 | 1/3 | 2/3 | 2/2 | 0/4 | 0/3 | 0/3 | 0/2 | 3/4 | 2/3 | 3/3 | 2/2 |

## Why kopt-pack misses (primary cause per missed task)

| language | repo | missed | (a) ranking / natural-language mismatch | (b) unresolved references | (c) extraction gap | (d) budget / format | (e) needs multi-step exploration |
|---|---|---|---|---|---|---|---|
| java | spring-framework | 4/15 | 1 | · | · | 3 | · |
| python | django | 2/15 | 1 | · | · | · | 1 |
| typescript | medusa | 3/12 | · | 1 | · | 1 | 1 |
| javascript | webpack | 1/12 | · | 1 | · | · | · |
| c_sharp | jellyfin | 2/12 | · | · | · | 1 | 1 |
| go | gitea | 1/12 | · | · | · | · | 1 |
| kotlin | exposed | 4/12 | 1 | · | · | · | 3 |
| rust | meilisearch | 5/12 | · | 2 | 1 | 2 | · |
| php | laravel | 3/12 | · | · | · | 2 | 1 |
| ruby | discourse | 1/12 | 1 | · | · | · | · |
| scala | playframework | 4/12 | 2 | · | 1 | · | 1 |
| **all** |  | **30/138** | **6** | **4** | **2** | **9** | **9** |

Per-task evidence (query, what kopt returned, what was expected, mechanical checks): `bench/results/failures.md`.

## Notes

- `found` = every gold file path and every gold symbol name appears in the output. Gold items are verified by
  reading the code (`verifiedBy` in each task) and re-checked mechanically (`kopt bench <repo> --verify`).
- Competitor strategies (kirograph, codegraph) appear only when `bench/competitors/results/<tool>-<repo>.jsonl` exists.

Per-repo details: `bench/results/spring-framework.md`, `bench/results/quality-spring-framework.md`; `bench/results/django.md`, `bench/results/quality-django.md`; `bench/results/medusa.md`, `bench/results/quality-medusa.md`; `bench/results/webpack.md`, `bench/results/quality-webpack.md`; `bench/results/jellyfin.md`, `bench/results/quality-jellyfin.md`; `bench/results/gitea.md`, `bench/results/quality-gitea.md`; `bench/results/exposed.md`, `bench/results/quality-exposed.md`; `bench/results/meilisearch.md`, `bench/results/quality-meilisearch.md`; `bench/results/laravel.md`, `bench/results/quality-laravel.md`; `bench/results/discourse.md`, `bench/results/quality-discourse.md`; `bench/results/playframework.md`, `bench/results/quality-playframework.md`.
