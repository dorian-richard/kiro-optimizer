# kopt bench: exposed

Repo `exposed` @ `1.5.0` (`84361204b663`) · 12 tasks · input = `search` · 3 chars/token · 2026-10-09T22:38:28.346Z

> Offline proxy: tokens = estimated tokens of tool outputs returned to the model for ONE exploration step.
> It is not a credit measurement. Savings must be confirmed by the online A/B (bench/ab) before being claimed.

## Summary per strategy

| strategy | tasks | found | file recall | symbol recall | def recall | median tok | mean tok | p90 tok | tok / found task | calls |
|---|---|---|---|---|---|---|---|---|---|---|
| native-naive | 12 | 4 (33%) | 71% | 57% | 37% | 15,910 | 29,524 | 67,535 | 88,573 | 3.8 |
| native-ranged | 12 | 4 (33%) | 71% | 61% | 41% | 9,659 | 28,507 | 18,199 | 85,522 | 4.0 |
| kopt-pack | 12 | 8 (67%) | 83% | 91% | 35% | 1,302 | 1,136 | 1,622 | 1,703 | 1.0 |
| kopt-hits+read | 12 | 2 (17%) | 62% | 62% | 32% | 906 | 994 | 1,497 | 5,963 | 3.0 |
| kirograph | 12 | 1 (8%) | 51% | 24% | 10% | 1,100 | 1,733 | 4,523 | 20,798 | 1.0 |
| codegraph | 12 | 9 (75%) | 88% | 100% | 55% | 8,305 | 8,265 | 8,327 | 11,019 | 1.0 |

`found` = every gold file path AND every gold symbol name appears in the output. `def recall` = the definition line
of the gold symbol was shown (stricter). `tok / found task` = all tokens spent (failures included) / tasks found.

## Pass-gated pairs (only tasks found by both)

| b vs a | tasks run | found by both | only a | only b | median b/a | geomean b/a | b cheaper |
|---|---|---|---|---|---|---|---|
| kopt-pack vs native-naive | 12 | 4 | 0 | 4 | 0.05× | 0.05× | 4/4 |
| kopt-pack vs native-ranged | 12 | 4 | 0 | 4 | 0.10× | 0.10× | 4/4 |
| kopt-hits+read vs native-naive | 12 | 2 | 2 | 0 | 0.03× | 0.02× | 2/2 |
| kopt-hits+read vs native-ranged | 12 | 2 | 2 | 0 | 0.06× | 0.06× | 2/2 |
| kopt-pack vs kirograph | 12 | 1 | 0 | 7 | 0.30× | 0.30× | 1/1 |
| kopt-pack vs codegraph | 12 | 6 | 3 | 2 | 0.09× | 0.10× | 6/6 |
| kopt-hits+read vs kirograph | 12 | 1 | 0 | 1 | 0.28× | 0.28× | 1/1 |
| kopt-hits+read vs codegraph | 12 | 1 | 8 | 1 | 0.09× | 0.09× | 1/1 |
| kirograph vs native-ranged | 12 | 1 | 3 | 0 | 0.25× | 0.25× | 1/1 |
| codegraph vs native-ranged | 12 | 3 | 1 | 6 | 1.06× | 0.98× | 1/3 |
| native-ranged vs native-naive | 12 | 3 | 1 | 1 | 0.66× | 0.48× | 3/3 |

## By task kind

| kind | strategy | tasks | found | median tok |
|---|---|---|---|---|
| locate | native-naive | 4 | 2 | 38,855 |
| locate | native-ranged | 4 | 2 | 13,599 |
| locate | kopt-pack | 4 | 3 | 1,365 |
| locate | kopt-hits+read | 4 | 2 | 1,171 |
| locate | kirograph | 4 | 1 | 1,019 |
| locate | codegraph | 4 | 2 | 8,303 |
| explain | native-naive | 3 | 0 | 62,999 |
| explain | native-ranged | 3 | 0 | 10,690 |
| explain | kopt-pack | 3 | 0 | 1,373 |
| explain | kopt-hits+read | 3 | 0 | 1,028 |
| explain | kirograph | 3 | 0 | 1,078 |
| explain | codegraph | 3 | 2 | 8,316 |
| usage | native-naive | 3 | 1 | 9,655 |
| usage | native-ranged | 3 | 1 | 5,910 |
| usage | kopt-pack | 3 | 3 | 794 |
| usage | kopt-hits+read | 3 | 0 | 658 |
| usage | kirograph | 3 | 0 | 1,131 |
| usage | codegraph | 3 | 3 | 8,302 |
| impact | native-naive | 2 | 1 | 8,273 |
| impact | native-ranged | 2 | 1 | 5,418 |
| impact | kopt-pack | 2 | 2 | 576 |
| impact | kopt-hits+read | 2 | 0 | 520 |
| impact | kirograph | 2 | 0 | 2,755 |
| impact | codegraph | 2 | 2 | 8,305 |

## Per task (tokens, found)

| task | kind | native-naive | native-ranged | kopt-pack | kopt-hits+read | kirograph | codegraph |
|---|---|---|---|---|---|---|---|
| ex-locate-retry | locate | 68,380 OK | 13,960 OK | 1,686 OK | 784 OK | 1,043 NO (miss Transactions.kt, JdbcTransaction.kt, inTopLevelTransaction, getRetryInterval) | 8,297 OK |
| ex-locate-upsert-sql | locate | 27,550 OK | 18,199 OK | 1,373 OK | 1,278 OK | 4,556 OK | 8,262 NO (miss PostgreSQL.kt, MysqlDialect.kt) |
| ex-locate-lifecycle-flush | locate | 17,187 NO (miss EntityLifecycleInterceptor.kt, EntityCache.kt, flushEntities, flushCache) | 13,237 NO (miss EntityLifecycleInterceptor.kt, EntityCache.kt, flushEntities, flushCache) | 1,261 NO (miss EntityCache.kt) | 2,370 NO (miss EntityCache.kt) | 994 NO (miss beforeExecution, flushEntities, flushCache) | 8,327 OK |
| ex-locate-hashed-column | locate | 50,160 NO (miss Tables.kt, HashingTransformer.kt, Hasher.kt, hashed, +1) | 9,849 NO (miss Tables.kt, HashingTransformer.kt, Hasher.kt, hashed, +1) | 1,356 OK | 1,063 NO (miss HashingTransformer.kt, HashingTransformer) | 948 NO (miss Tables.kt, HashingTransformer.kt, Hasher.kt, hashed, +2) | 8,308 NO (miss HashingTransformer.kt) |
| ex-explain-entity-flush | explain | 62,999 NO (miss SchemaUtils.kt) | 8,290 NO (miss SchemaUtils.kt) | 1,342 NO (miss SchemaUtils.kt, sortTablesByReferences) | 1,079 NO (miss SchemaUtils.kt) | 990 NO (miss SchemaUtils.kt, flushInserts, updateEntities, sortTablesByReferences) | 8,324 NO (miss SchemaUtils.kt) |
| ex-explain-nested-tx | explain | 67,535 NO (miss newTransaction, ThreadLocalTransaction, rollback, savepointName) | 10,690 NO (miss newTransaction, ThreadLocalTransaction, rollback, savepointName) | 1,622 NO (miss ThreadLocalTransaction, savepointName) | 746 NO (miss newTransaction, ThreadLocalTransaction, savepointName) | 1,078 NO (miss TransactionManager.kt, newTransaction, ThreadLocalTransaction, savepointName) | 8,316 OK |
| ex-explain-table-order | explain | 12,884 NO (miss TableDepthGraph.kt, TableDepthGraph, sorted, hasCycle) | 236,185 NO (miss TableDepthGraph.kt, TableDepthGraph, sorted, hasCycle) | 1,373 NO (miss TableDepthGraph.kt, sorted) | 1,028 NO (miss TableDepthGraph.kt, TableDepthGraph, sorted) | 1,157 NO (miss sorted, hasCycle) | 7,804 OK |
| ex-usage-sort-tables | usage | 9,655 NO (miss flush, createStatements, drop, tableConstraints, +1) | 9,468 NO (miss flush, drop, tableConstraints, generateVersionedFiles) | 1,148 OK | 1,497 NO (miss EntityCache.kt, JdbcDatabaseMetadataImpl.kt, MigrationGenerator.kt, flush, +2) | 1,131 NO (miss EntityCache.kt, SchemaUtils.kt, MigrationGenerator.kt, flush, +4) | 8,295 OK |
| ex-usage-entity-lifecycle | usage | 14,632 NO (miss setReference) | 5,910 NO (miss updateEntities, setReference) | 519 OK | 382 NO (miss Entity.kt, EntityCache.kt, InnerTableLink.kt, getValue, +5) | 2,270 NO (miss Entity.kt, InnerTableLink.kt, getValue, delete, +4) | 8,330 OK |
| ex-usage-resolve-database | usage | 6,765 OK | 5,466 OK | 794 OK | 658 NO (miss inTopLevelSuspendTransaction) | 1,121 NO (miss transaction, inTopLevelTransaction, suspendTransaction, inTopLevelSuspendTransaction) | 8,302 OK |
| ex-impact-check-cycle | impact | 8,626 NO (miss createStatement, dropStatement) | 7,876 OK | 697 OK | 616 NO (miss Table.kt, createStatement, dropStatement) | 987 NO (miss Table.kt, createStatement, dropStatement) | 8,316 OK |
| ex-impact-upsert-alias | impact | 7,920 OK | 2,959 NO (miss upsert) | 455 OK | 424 NO (miss insertValue) | 4,523 NO (miss MariaDBDialect.kt, insertValue) | 8,294 OK |

## Settings

- grep_search emulation: 100 matches / 10,000 chars, lines cut at 250 chars; pattern = most selective keywords while the total stays under the match cap; files ordered by distinct keywords, non-test first, match count (generous to native).
- native-naive: top 3 files by visible match count, whole file capped at 2000 lines.
- native-ranged: ±60 lines around the best 4 matches (overlaps merged).
- kopt budgets: find 700, pack 2500, read 3000 tokens.
- index: reused, 864 files, 12,962 symbols.
- kirograph: outputs loaded from bench/competitors/results/kirograph-exposed.jsonl
- codegraph: outputs loaded from bench/competitors/results/codegraph-exposed.jsonl
- run duration: 11,208 ms.
