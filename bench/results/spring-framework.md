# kopt bench: spring-framework

Repo `spring-framework` @ `v7.0.9` (`82a6b40b9366`) · 15 tasks · input = `search` · 3 chars/token · 2026-10-09T22:21:11.854Z

> Offline proxy: tokens = estimated tokens of tool outputs returned to the model for ONE exploration step.
> It is not a credit measurement. Savings must be confirmed by the online A/B (bench/ab) before being claimed.

## Summary per strategy

| strategy | tasks | found | file recall | symbol recall | def recall | median tok | mean tok | p90 tok | tok / found task | calls |
|---|---|---|---|---|---|---|---|---|---|---|
| native-naive | 15 | 9 (60%) | 82% | 71% | 63% | 19,851 | 22,982 | 40,375 | 38,303 | 3.8 |
| native-ranged | 15 | 8 (53%) | 82% | 70% | 57% | 7,378 | 7,509 | 9,517 | 14,080 | 4.2 |
| kopt-pack | 15 | 11 (73%) | 89% | 93% | 48% | 1,327 | 1,304 | 1,480 | 1,778 | 1.0 |
| kopt-hits+read | 15 | 5 (33%) | 81% | 71% | 59% | 1,884 | 2,312 | 3,629 | 6,935 | 3.0 |
| kirograph | 15 | 0 (0%) | 27% | 21% | 0% | 1,208 | 1,268 | 1,655 | n/a | 1.0 |
| codegraph | 15 | 8 (53%) | 80% | 76% | 47% | 8,307 | 7,778 | 8,324 | 14,584 | 1.0 |

`found` = every gold file path AND every gold symbol name appears in the output. `def recall` = the definition line
of the gold symbol was shown (stricter). `tok / found task` = all tokens spent (failures included) / tasks found.

## Pass-gated pairs (only tasks found by both)

| b vs a | tasks run | found by both | only a | only b | median b/a | geomean b/a | b cheaper |
|---|---|---|---|---|---|---|---|
| kopt-pack vs native-naive | 15 | 9 | 0 | 2 | 0.05× | 0.06× | 9/9 |
| kopt-pack vs native-ranged | 15 | 8 | 0 | 3 | 0.20× | 0.21× | 8/8 |
| kopt-hits+read vs native-naive | 15 | 4 | 5 | 1 | 0.13× | 0.11× | 4/4 |
| kopt-hits+read vs native-ranged | 15 | 4 | 4 | 1 | 0.45× | 0.40× | 4/4 |
| kopt-pack vs kirograph | 15 | 0 | 0 | 11 | n/a | n/a | 0/0 |
| kopt-pack vs codegraph | 15 | 8 | 0 | 3 | 0.15× | 0.16× | 8/8 |
| kopt-hits+read vs kirograph | 15 | 0 | 0 | 5 | n/a | n/a | 0/0 |
| kopt-hits+read vs codegraph | 15 | 5 | 3 | 0 | 0.41× | 0.38× | 5/5 |
| kirograph vs native-ranged | 15 | 0 | 8 | 0 | n/a | n/a | 0/0 |
| codegraph vs native-ranged | 15 | 6 | 2 | 2 | 1.13× | 1.08× | 2/6 |
| native-ranged vs native-naive | 15 | 6 | 3 | 2 | 0.37× | 0.33× | 6/6 |

## By task kind

| kind | strategy | tasks | found | median tok |
|---|---|---|---|---|
| locate | native-naive | 4 | 2 | 19,837 |
| locate | native-ranged | 4 | 1 | 8,166 |
| locate | kopt-pack | 4 | 2 | 1,363 |
| locate | kopt-hits+read | 4 | 1 | 1,460 |
| locate | kirograph | 4 | 0 | 1,138 |
| locate | codegraph | 4 | 2 | 8,168 |
| explain | native-naive | 4 | 1 | 14,519 |
| explain | native-ranged | 4 | 2 | 8,399 |
| explain | kopt-pack | 4 | 2 | 1,335 |
| explain | kopt-hits+read | 4 | 1 | 2,644 |
| explain | kirograph | 4 | 0 | 1,354 |
| explain | codegraph | 4 | 2 | 8,057 |
| usage | native-naive | 4 | 3 | 18,153 |
| usage | native-ranged | 4 | 4 | 5,322 |
| usage | kopt-pack | 4 | 4 | 1,306 |
| usage | kopt-hits+read | 4 | 1 | 2,727 |
| usage | kirograph | 4 | 0 | 1,297 |
| usage | codegraph | 4 | 2 | 8,294 |
| impact | native-naive | 3 | 3 | 40,375 |
| impact | native-ranged | 3 | 1 | 9,017 |
| impact | kopt-pack | 3 | 3 | 1,230 |
| impact | kopt-hits+read | 3 | 2 | 2,599 |
| impact | kirograph | 3 | 0 | 1,208 |
| impact | codegraph | 3 | 2 | 8,316 |

## Per task (tokens, found)

| task | kind | native-naive | native-ranged | kopt-pack | kopt-hits+read | kirograph | codegraph |
|---|---|---|---|---|---|---|---|
| sf-locate-retry-loop | locate | 23,792 NO (miss RetryTemplate.java, RetryTemplate, execute, checkIfTimeoutExceeded) | 8,971 NO (miss RetryTemplate.java, RetryTemplate, execute, checkIfTimeoutExceeded) | 1,327 NO (miss execute) | 1,774 NO (miss execute) | 1,172 NO (miss execute, checkIfTimeoutExceeded) | 8,320 NO (miss execute, checkIfTimeoutExceeded) |
| sf-locate-api-version | locate | 31,703 NO (miss ApiVersionStrategy.java, DefaultApiVersionStrategy.java, AbstractHandlerMapping.java, resolveParseAndValidateVersion, +3) | 9,466 NO (miss ApiVersionStrategy.java, DefaultApiVersionStrategy.java, AbstractHandlerMapping.java, resolveParseAndValidateVersion, +3) | 1,480 NO (miss AbstractHandlerMapping.java) | 1,146 NO (miss AbstractHandlerMapping.java, initApiVersion) | 1,149 NO (miss AbstractHandlerMapping.java, resolveParseAndValidateVersion, validateVersion, initApiVersion) | 8,307 NO (miss ApiVersionStrategy.java, DefaultApiVersionStrategy.java, AbstractHandlerMapping.java, resolveParseAndValidateVersion, +2) |
| sf-locate-sqlstate-lock | locate | 8,382 OK | 6,511 NO (miss indicatesCannotAcquireLock) | 752 OK | 630 NO (miss SQLExceptionSubclassTranslator.java, SQLExceptionSubclassTranslator) | 935 NO (miss SQLStateSQLExceptionTranslator.java, SQLExceptionSubclassTranslator.java, indicatesCannotAcquireLock, SQLStateSQLExceptionTranslator, +1) | 8,028 OK |
| sf-locate-advice-order | locate | 15,882 OK | 7,360 OK | 1,399 OK | 1,867 OK | 1,127 NO (miss AspectJPrecedenceComparator.java, AspectJPrecedenceComparator, comparePrecedenceWithinAspect, getAspectDeclarationOrder) | 3,938 OK |
| sf-explain-concurrency-limit | explain | 13,248 OK | 9,115 OK | 1,277 OK | 1,590 NO (miss ConcurrencyLimitInterceptor) | 1,806 NO (miss ConcurrencyLimitBeanPostProcessor.java, ConcurrencyThrottleSupport.java, ConcurrencyLimitBeanPostProcessor, ConcurrencyLimitInterceptor, +2) | 8,321 OK |
| sf-explain-retryable | explain | 8,744 NO (miss RetryAnnotationBeanPostProcessor.java, AbstractRetryInterceptor.java, RetryAnnotationBeanPostProcessor, getRetrySpec, +1) | 7,682 NO (miss RetryAnnotationBeanPostProcessor.java, AbstractRetryInterceptor.java, RetryAnnotationBeanPostProcessor, getRetrySpec, +1) | 1,352 NO (miss AbstractRetryInterceptor.java, RetryTemplate.java, RetryTemplate) | 6,066 NO (miss AbstractRetryInterceptor.java, RetryTemplate.java, RetryTemplate) | 1,370 NO (miss AbstractRetryInterceptor.java, RetryTemplate.java, getRetrySpec, AbstractRetryInterceptor, +1) | 7,384 NO (miss RetryTemplate.java) |
| sf-explain-config-full-lite | explain | 30,624 NO (miss checkConfigurationClassCandidate, enhanceConfigurationClasses, enhance) | 9,933 NO (miss checkConfigurationClassCandidate) | 1,317 NO (miss ConfigurationClassUtils.java, ConfigurationClassPostProcessor.java, checkConfigurationClassCandidate, enhanceConfigurationClasses) | 1,884 NO (miss ConfigurationClassUtils.java, ConfigurationClassPostProcessor.java, checkConfigurationClassCandidate, enhanceConfigurationClasses) | 1,337 NO (miss ConfigurationClassUtils.java, ConfigurationClassPostProcessor.java, ConfigurationClassEnhancer.java, checkConfigurationClassCandidate, +2) | 8,315 NO (miss ConfigurationClassUtils.java, ConfigurationClassPostProcessor.java, checkConfigurationClassCandidate, enhanceConfigurationClasses) |
| sf-explain-exponential-backoff | explain | 15,790 NO (miss computeNextInterval, applyJitter) | 6,864 OK | 1,379 OK | 3,404 OK | 1,138 NO (miss ExponentialBackOff.java, nextBackOff, computeNextInterval, applyJitter) | 7,799 OK |
| sf-usage-fail-early | usage | 19,851 OK | 4,794 OK | 764 OK | 453 NO (miss processCommit, processRollback) | 1,655 NO (miss processCommit, processRollback) | 8,314 OK |
| sf-usage-trigger-flush | usage | 16,454 NO (miss DataSourceTransactionObject) | 6,597 OK | 1,406 OK | 2,886 NO (miss DataSourceTransactionManager.java, JtaTransactionObject.java, DataSourceTransactionObject, JtaTransactionObject) | 1,139 NO (miss TransactionSynchronizationUtils.java, DataSourceTransactionManager.java, JtaTransactionObject.java, DataSourceTransactionObject, +1) | 8,274 NO (miss DataSourceTransactionObject) |
| sf-usage-imported-by | usage | 26,310 OK | 3,582 OK | 1,206 OK | 3,629 NO (miss TrackedConditionEvaluator, getEnclosingConfigurationClass) | 1,289 NO (miss ConfigurationClass.java, ConfigurationClassBeanDefinitionReader.java, ConfigurationClassParser.java, TrackedConditionEvaluator, +1) | 6,406 NO (miss TrackedConditionEvaluator) |
| sf-usage-lru-drain | usage | 14,167 OK | 5,850 OK | 2,317 OK | 2,568 OK | 1,304 NO (miss ConcurrentLruCache.java, drainOperations, processRead, processWrite) | 8,324 OK |
| sf-impact-shortcut | impact | 56,263 OK | 9,517 NO (miss createArgumentArray, resolvePreparedArguments) | 935 OK | 2,599 OK | 1,208 NO (miss createArgumentArray, resolvePreparedArguments) | 8,316 OK |
| sf-impact-primary-conflict | impact | 40,375 OK | 9,017 NO (miss doResolveDependency) | 1,412 OK | 802 NO (miss doResolveDependency) | 1,165 NO (miss DefaultListableBeanFactory.java, hasPrimaryConflict, doResolveDependency) | 8,297 NO (miss DefaultListableBeanFactory.java, hasPrimaryConflict, doResolveDependency) |
| sf-impact-cleanup-txinfo | impact | 23,146 OK | 7,378 OK | 1,230 OK | 3,379 OK | 1,222 NO (miss TransactionAspectSupport.java, invokeWithinTransaction) | 8,330 OK |

## Settings

- grep_search emulation: 100 matches / 10,000 chars, lines cut at 250 chars; pattern = most selective keywords while the total stays under the match cap; files ordered by distinct keywords, non-test first, match count (generous to native).
- native-naive: top 3 files by visible match count, whole file capped at 2000 lines.
- native-ranged: ±60 lines around the best 4 matches (overlaps merged).
- kopt budgets: find 700, pack 2500, read 3000 tokens.
- index: reused, 9,552 files, 138,619 symbols.
- kirograph: outputs loaded from bench/competitors/results/kirograph-spring-framework.jsonl
- codegraph: outputs loaded from bench/competitors/results/codegraph-spring-framework.jsonl
- run duration: 24,199 ms.
