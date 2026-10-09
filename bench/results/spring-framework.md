# kopt bench: spring-framework

Repo `spring-framework` @ `v7.0.9` (`82a6b40b9366`) · 15 tasks · input = `search` · 3 chars/token · 2026-10-09T09:44:30.612Z

> Offline proxy: tokens = estimated tokens of tool outputs returned to the model for ONE exploration step.
> It is not a credit measurement. Savings must be confirmed by the online A/B (bench/ab) before being claimed.

## Summary per strategy

| strategy | tasks | found | file recall | symbol recall | def recall | median tok | mean tok | p90 tok | tok / found task | calls |
|---|---|---|---|---|---|---|---|---|---|---|
| native-naive | 15 | 9 (60%) | 82% | 71% | 63% | 19,851 | 22,982 | 40,375 | 38,303 | 3.8 |
| native-ranged | 15 | 8 (53%) | 82% | 70% | 57% | 7,378 | 7,509 | 9,517 | 14,080 | 4.2 |
| kopt-pack | 15 | 5 (33%) | 72% | 75% | 43% | 776 | 834 | 1,363 | 2,503 | 1.0 |
| kopt-hits+read | 15 | 5 (33%) | 74% | 59% | 52% | 1,436 | 1,453 | 2,425 | 4,358 | 3.0 |

`found` = every gold file path AND every gold symbol name appears in the output. `def recall` = the definition line
of the gold symbol was shown (stricter). `tok / found task` = all tokens spent (failures included) / tasks found.

## Pass-gated pairs (only tasks found by both)

| b vs a | tasks run | found by both | only a | only b | median b/a | geomean b/a | b cheaper |
|---|---|---|---|---|---|---|---|
| kopt-pack vs native-naive | 15 | 4 | 5 | 1 | 0.01× | 0.02× | 4/4 |
| kopt-pack vs native-ranged | 15 | 4 | 4 | 1 | 0.08× | 0.08× | 4/4 |
| kopt-hits+read vs native-naive | 15 | 3 | 6 | 2 | 0.10× | 0.08× | 3/3 |
| kopt-hits+read vs native-ranged | 15 | 3 | 5 | 2 | 0.26× | 0.26× | 3/3 |
| native-ranged vs native-naive | 15 | 6 | 3 | 2 | 0.37× | 0.33× | 6/6 |

## By task kind

| kind | strategy | tasks | found | median tok |
|---|---|---|---|---|
| locate | native-naive | 4 | 2 | 19,837 |
| locate | native-ranged | 4 | 1 | 8,166 |
| locate | kopt-pack | 4 | 1 | 923 |
| locate | kopt-hits+read | 4 | 2 | 1,463 |
| explain | native-naive | 4 | 1 | 14,519 |
| explain | native-ranged | 4 | 2 | 8,399 |
| explain | kopt-pack | 4 | 1 | 978 |
| explain | kopt-hits+read | 4 | 1 | 1,510 |
| usage | native-naive | 4 | 3 | 18,153 |
| usage | native-ranged | 4 | 4 | 5,322 |
| usage | kopt-pack | 4 | 1 | 614 |
| usage | kopt-hits+read | 4 | 0 | 976 |
| impact | native-naive | 3 | 3 | 40,375 |
| impact | native-ranged | 3 | 1 | 9,017 |
| impact | kopt-pack | 3 | 2 | 572 |
| impact | kopt-hits+read | 3 | 2 | 2,385 |

## Per task (tokens, found)

| task | kind | native-naive | native-ranged | kopt-pack | kopt-hits+read |
|---|---|---|---|---|---|
| sf-locate-retry-loop | locate | 23,792 NO (miss RetryTemplate.java, RetryTemplate, execute, checkIfTimeoutExceeded) | 8,971 NO (miss RetryTemplate.java, RetryTemplate, execute, checkIfTimeoutExceeded) | 1,041 NO (miss RetryTemplate.java, RetryTemplate, execute, checkIfTimeoutExceeded) | 1,773 NO (miss RetryTemplate.java, RetryTemplate, execute, checkIfTimeoutExceeded) |
| sf-locate-api-version | locate | 31,703 NO (miss ApiVersionStrategy.java, DefaultApiVersionStrategy.java, AbstractHandlerMapping.java, resolveParseAndValidateVersion, +3) | 9,466 NO (miss ApiVersionStrategy.java, DefaultApiVersionStrategy.java, AbstractHandlerMapping.java, resolveParseAndValidateVersion, +3) | 1,363 NO (miss AbstractHandlerMapping.java) | 1,152 OK |
| sf-locate-sqlstate-lock | locate | 8,382 OK | 6,511 NO (miss indicatesCannotAcquireLock) | 499 NO (miss SQLExceptionSubclassTranslator.java) | 564 NO (miss SQLExceptionSubclassTranslator.java, SQLExceptionSubclassTranslator) |
| sf-locate-advice-order | locate | 15,882 OK | 7,360 OK | 805 OK | 1,879 OK |
| sf-explain-concurrency-limit | explain | 13,248 OK | 9,115 OK | 813 NO (miss ConcurrencyLimitInterceptor, beforeAccess) | 1,584 NO (miss ConcurrencyLimitInterceptor, beforeAccess) |
| sf-explain-retryable | explain | 8,744 NO (miss RetryAnnotationBeanPostProcessor.java, AbstractRetryInterceptor.java, RetryAnnotationBeanPostProcessor, getRetrySpec, +1) | 7,682 NO (miss RetryAnnotationBeanPostProcessor.java, AbstractRetryInterceptor.java, RetryAnnotationBeanPostProcessor, getRetrySpec, +1) | 2,168 NO (miss AbstractRetryInterceptor.java, RetryTemplate.java, RetryTemplate) | 2,701 NO (miss AbstractRetryInterceptor.java, RetryTemplate.java, RetryTemplate) |
| sf-explain-config-full-lite | explain | 30,624 NO (miss checkConfigurationClassCandidate, enhanceConfigurationClasses, enhance) | 9,933 NO (miss checkConfigurationClassCandidate) | 594 NO (miss ConfigurationClassUtils.java, ConfigurationClassPostProcessor.java, checkConfigurationClassCandidate, enhanceConfigurationClasses) | 870 NO (miss ConfigurationClassUtils.java, ConfigurationClassPostProcessor.java, checkConfigurationClassCandidate, enhanceConfigurationClasses) |
| sf-explain-exponential-backoff | explain | 15,790 NO (miss computeNextInterval, applyJitter) | 6,864 OK | 1,142 OK | 1,436 OK |
| sf-usage-fail-early | usage | 19,851 OK | 4,794 OK | 265 OK | 375 NO (miss processCommit, processRollback) |
| sf-usage-trigger-flush | usage | 16,454 NO (miss DataSourceTransactionObject) | 6,597 OK | 749 NO (miss DataSourceTransactionManager.java, JtaTransactionObject.java) | 997 NO (miss DataSourceTransactionManager.java, JtaTransactionObject.java, DataSourceTransactionObject, JtaTransactionObject) |
| sf-usage-imported-by | usage | 26,310 OK | 3,582 OK | 478 NO (miss ConfigurationClassBeanDefinitionReader.java) | 1,689 NO (miss ConfigurationClassBeanDefinitionReader.java, TrackedConditionEvaluator, getEnclosingConfigurationClass) |
| sf-usage-lru-drain | usage | 14,167 OK | 5,850 OK | 776 NO (miss drainOperations, processRead, processWrite) | 955 NO (miss drainOperations, processRead, processWrite) |
| sf-impact-shortcut | impact | 56,263 OK | 9,517 NO (miss createArgumentArray, resolvePreparedArguments) | 572 OK | 2,425 OK |
| sf-impact-primary-conflict | impact | 40,375 OK | 9,017 NO (miss doResolveDependency) | 921 NO (miss doResolveDependency) | 1,003 NO (miss doResolveDependency) |
| sf-impact-cleanup-txinfo | impact | 23,146 OK | 7,378 OK | 329 OK | 2,385 OK |

## Settings

- grep_search emulation: 100 matches / 10,000 chars, lines cut at 250 chars; pattern = most selective keywords while the total stays under the match cap; files ordered by distinct keywords, non-test first, match count (generous to native).
- native-naive: top 3 files by visible match count, whole file capped at 2000 lines.
- native-ranged: ±60 lines around the best 4 matches (overlaps merged).
- kopt budgets: find 700, pack 2500, read 2000 tokens.
- index: reused in 0 ms, 9,552 files, 138,619 symbols.
- run duration: 9,088 ms.
