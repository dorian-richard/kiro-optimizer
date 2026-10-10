# kopt bench: heldout-spring-framework-question

Repo `spring-framework` @ `v7.0.9` (`82a6b40b9366`) · 2 tasks · input = `question` · 3 chars/token · 2026-10-09T20:18:34.201Z

> Offline proxy: tokens = estimated tokens of tool outputs returned to the model for ONE exploration step.
> It is not a credit measurement. Savings must be confirmed by the online A/B (bench/ab) before being claimed.

Skipped strategies: kirograph, codegraph — no kirograph result line for this task; no codegraph result line for this task

## Summary per strategy

| strategy | tasks | found | file recall | symbol recall | def recall | median tok | mean tok | p90 tok | tok / found task | calls |
|---|---|---|---|---|---|---|---|---|---|---|
| native-naive | 2 | 0 (0%) | 0% | 25% | 0% | 32,538 | 32,538 | 34,745 | n/a | 4.0 |
| native-ranged | 2 | 0 (0%) | 0% | 25% | 0% | 10,330 | 10,330 | 10,543 | n/a | 5.0 |
| kopt-pack | 2 | 0 (0%) | 50% | 25% | 25% | 1,134 | 1,134 | 1,381 | n/a | 1.0 |
| kopt-hits+read | 2 | 0 (0%) | 50% | 25% | 25% | 1,308 | 1,308 | 1,987 | n/a | 3.0 |

`found` = every gold file path AND every gold symbol name appears in the output. `def recall` = the definition line
of the gold symbol was shown (stricter). `tok / found task` = all tokens spent (failures included) / tasks found.

## Pass-gated pairs (only tasks found by both)

| b vs a | tasks run | found by both | only a | only b | median b/a | geomean b/a | b cheaper |
|---|---|---|---|---|---|---|---|
| kopt-pack vs native-naive | 2 | 0 | 0 | 0 | n/a | n/a | 0/0 |
| kopt-pack vs native-ranged | 2 | 0 | 0 | 0 | n/a | n/a | 0/0 |
| kopt-hits+read vs native-naive | 2 | 0 | 0 | 0 | n/a | n/a | 0/0 |
| kopt-hits+read vs native-ranged | 2 | 0 | 0 | 0 | n/a | n/a | 0/0 |
| native-ranged vs native-naive | 2 | 0 | 0 | 0 | n/a | n/a | 0/0 |

## By task kind

| kind | strategy | tasks | found | median tok |
|---|---|---|---|---|
| locate | native-naive | 1 | 0 | 34,745 |
| locate | native-ranged | 1 | 0 | 10,543 |
| locate | kopt-pack | 1 | 0 | 1,381 |
| locate | kopt-hits+read | 1 | 0 | 1,987 |
| explain | native-naive | 1 | 0 | 30,330 |
| explain | native-ranged | 1 | 0 | 10,117 |
| explain | kopt-pack | 1 | 0 | 887 |
| explain | kopt-hits+read | 1 | 0 | 629 |

## Per task (tokens, found)

| task | kind | native-naive | native-ranged | kopt-pack | kopt-hits+read | kirograph | codegraph |
|---|---|---|---|---|---|---|---|
| ho-sf-explain-rollback-rules | explain | 30,330 NO (miss RuleBasedTransactionAttribute.java, RollbackRuleAttribute.java, getDepth) | 10,117 NO (miss RuleBasedTransactionAttribute.java, RollbackRuleAttribute.java, getDepth) | 887 NO (miss RuleBasedTransactionAttribute.java, RollbackRuleAttribute.java, rollbackOn, getDepth) | 629 NO (miss RuleBasedTransactionAttribute.java, RollbackRuleAttribute.java, rollbackOn, getDepth) | skipped | skipped |
| ho-sf-locate-response-converter | locate | 34,745 NO (miss AbstractMessageConverterMethodProcessor.java, writeWithMessageConverters, getMostSpecificMediaType) | 10,543 NO (miss AbstractMessageConverterMethodProcessor.java, writeWithMessageConverters, getMostSpecificMediaType) | 1,381 NO (miss getMostSpecificMediaType) | 1,987 NO (miss getMostSpecificMediaType) | skipped | skipped |

## Settings

- grep_search emulation: 100 matches / 10,000 chars, lines cut at 250 chars; pattern = most selective keywords while the total stays under the match cap; files ordered by distinct keywords, non-test first, match count (generous to native).
- native-naive: top 3 files by visible match count, whole file capped at 2000 lines.
- native-ranged: ±60 lines around the best 4 matches (overlaps merged).
- kopt budgets: find 700, pack 2500, read 3000 tokens.
- index: reused, 9,552 files, 138,619 symbols.
- kirograph: outputs loaded from bench/competitors/results/kirograph-spring-framework.jsonl
- codegraph: outputs loaded from bench/competitors/results/codegraph-spring-framework.jsonl
- run duration: 3,891 ms.
