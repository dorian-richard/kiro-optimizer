# kopt bench: heldout-medusa

Repo `medusa` @ `v2.21.2` (`020565398e43`) · 2 tasks · input = `search` · 3 chars/token · 2026-10-09T20:18:17.349Z

> Offline proxy: tokens = estimated tokens of tool outputs returned to the model for ONE exploration step.
> It is not a credit measurement. Savings must be confirmed by the online A/B (bench/ab) before being claimed.

Skipped strategies: kirograph, codegraph — no kirograph result line for this task; no codegraph result line for this task

## Summary per strategy

| strategy | tasks | found | file recall | symbol recall | def recall | median tok | mean tok | p90 tok | tok / found task | calls |
|---|---|---|---|---|---|---|---|---|---|---|
| native-naive | 2 | 0 (0%) | 50% | 25% | 25% | 218,577 | 218,577 | 408,838 | n/a | 4.0 |
| native-ranged | 2 | 0 (0%) | 50% | 0% | 0% | 64,332 | 64,332 | 124,257 | n/a | 4.5 |
| kopt-pack | 2 | 2 (100%) | 100% | 100% | 25% | 997 | 997 | 1,380 | 997 | 1.0 |
| kopt-hits+read | 2 | 1 (50%) | 50% | 50% | 50% | 738 | 738 | 758 | 1,475 | 3.0 |

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
| explain | native-naive | 1 | 0 | 408,838 |
| explain | native-ranged | 1 | 0 | 124,257 |
| explain | kopt-pack | 1 | 1 | 1,380 |
| explain | kopt-hits+read | 1 | 1 | 758 |
| usage | native-naive | 1 | 0 | 28,316 |
| usage | native-ranged | 1 | 0 | 4,407 |
| usage | kopt-pack | 1 | 1 | 614 |
| usage | kopt-hits+read | 1 | 0 | 717 |

## Per task (tokens, found)

| task | kind | native-naive | native-ranged | kopt-pack | kopt-hits+read | kirograph | codegraph |
|---|---|---|---|---|---|---|---|
| ho-md-explain-tax-inclusive | explain | 408,838 NO (miss index.ts, calculateAmountsWithTax, calculateTaxTotal) | 124,257 NO (miss index.ts, calculateAmountsWithTax, calculateTaxTotal) | 1,380 OK | 758 OK | skipped | skipped |
| ho-md-usage-amounts-with-tax | usage | 28,316 NO (miss wrapProductsWithTaxPrices) | 4,407 NO (miss wrapVariantsWithTaxPrices, wrapProductsWithTaxPrices) | 614 OK | 717 NO (miss helpers.ts, helpers.ts, wrapVariantsWithTaxPrices, wrapProductsWithTaxPrices) | skipped | skipped |

## Settings

- grep_search emulation: 100 matches / 10,000 chars, lines cut at 250 chars; pattern = most selective keywords while the total stays under the match cap; files ordered by distinct keywords, non-test first, match count (generous to native).
- native-naive: top 3 files by visible match count, whole file capped at 2000 lines.
- native-ranged: ±60 lines around the best 4 matches (overlaps merged).
- kopt budgets: find 700, pack 2500, read 3000 tokens.
- index: reused, 11,970 files, 40,269 symbols.
- kirograph: outputs loaded from bench/competitors/results/kirograph-medusa.jsonl
- codegraph: outputs loaded from bench/competitors/results/codegraph-medusa.jsonl
- run duration: 4,118 ms.
