# kopt bench: spring-framework-question

Repo `spring-framework` @ `v7.0.9` (`82a6b40b9366`) · 15 tasks · input = `question` · 3 chars/token · 2026-10-09T11:38:08.915Z

> Offline proxy: tokens = estimated tokens of tool outputs returned to the model for ONE exploration step.
> It is not a credit measurement. Savings must be confirmed by the online A/B (bench/ab) before being claimed.

## Summary per strategy

| strategy | tasks | found | file recall | symbol recall | def recall | median tok | mean tok | p90 tok | tok / found task | calls |
|---|---|---|---|---|---|---|---|---|---|---|
| native-naive | 15 | 6 (40%) | 56% | 52% | 42% | 19,851 | 21,838 | 43,980 | 54,596 | 3.6 |
| native-ranged | 15 | 4 (27%) | 56% | 46% | 29% | 7,270 | 6,685 | 9,556 | 25,069 | 4.1 |
| kopt-pack | 15 | 4 (27%) | 63% | 59% | 30% | 978 | 1,019 | 1,550 | 3,820 | 1.0 |
| kopt-hits+read | 15 | 2 (13%) | 68% | 43% | 37% | 1,190 | 1,185 | 1,822 | 8,890 | 3.0 |

`found` = every gold file path AND every gold symbol name appears in the output. `def recall` = the definition line
of the gold symbol was shown (stricter). `tok / found task` = all tokens spent (failures included) / tasks found.

## Pass-gated pairs (only tasks found by both)

| b vs a | tasks run | found by both | only a | only b | median b/a | geomean b/a | b cheaper |
|---|---|---|---|---|---|---|---|
| kopt-pack vs native-naive | 15 | 4 | 2 | 0 | 0.02× | 0.02× | 4/4 |
| kopt-pack vs native-ranged | 15 | 2 | 2 | 2 | 0.10× | 0.07× | 2/2 |
| kopt-hits+read vs native-naive | 15 | 2 | 4 | 0 | 0.10× | 0.10× | 2/2 |
| kopt-hits+read vs native-ranged | 15 | 1 | 3 | 1 | 0.31× | 0.31× | 1/1 |
| native-ranged vs native-naive | 15 | 3 | 3 | 1 | 0.24× | 0.22× | 3/3 |

## By task kind

| kind | strategy | tasks | found | median tok |
|---|---|---|---|---|
| locate | native-naive | 4 | 0 | 14,106 |
| locate | native-ranged | 4 | 0 | 7,055 |
| locate | kopt-pack | 4 | 0 | 845 |
| locate | kopt-hits+read | 4 | 0 | 911 |
| explain | native-naive | 4 | 1 | 17,093 |
| explain | native-ranged | 4 | 0 | 7,098 |
| explain | kopt-pack | 4 | 1 | 1,365 |
| explain | kopt-hits+read | 4 | 1 | 1,389 |
| usage | native-naive | 4 | 3 | 18,153 |
| usage | native-ranged | 4 | 3 | 5,696 |
| usage | kopt-pack | 4 | 1 | 827 |
| usage | kopt-hits+read | 4 | 0 | 910 |
| impact | native-naive | 3 | 2 | 23,146 |
| impact | native-ranged | 3 | 1 | 7,378 |
| impact | kopt-pack | 3 | 2 | 374 |
| impact | kopt-hits+read | 3 | 1 | 1,302 |

## Per task (tokens, found)

| task | kind | native-naive | native-ranged | kopt-pack | kopt-hits+read |
|---|---|---|---|---|---|
| sf-locate-retry-loop | locate | 1,130 NO (miss RetryTemplate.java, RetryTemplate, execute, checkIfTimeoutExceeded) | 921 NO (miss RetryTemplate.java, RetryTemplate, execute, checkIfTimeoutExceeded) | 1,087 NO (miss RetryTemplate.java, RetryTemplate, execute, checkIfTimeoutExceeded) | 1,822 NO (miss RetryTemplate.java, RetryTemplate, execute, checkIfTimeoutExceeded) |
| sf-locate-api-version | locate | 22,563 NO (miss ApiVersionStrategy.java, DefaultApiVersionStrategy.java, AbstractHandlerMapping.java, resolveParseAndValidateVersion, +3) | 7,755 NO (miss ApiVersionStrategy.java, DefaultApiVersionStrategy.java, AbstractHandlerMapping.java, resolveParseAndValidateVersion, +3) | 978 NO (miss ApiVersionStrategy.java, DefaultApiVersionStrategy.java, AbstractHandlerMapping.java, resolveParseAndValidateVersion, +3) | 903 NO (miss ApiVersionStrategy.java, DefaultApiVersionStrategy.java, AbstractHandlerMapping.java, resolveParseAndValidateVersion, +3) |
| sf-locate-sqlstate-lock | locate | 5,649 NO (miss indicatesCannotAcquireLock) | 6,354 NO (miss indicatesCannotAcquireLock) | 527 NO (miss SQLExceptionSubclassTranslator.java) | 592 NO (miss SQLExceptionSubclassTranslator.java, SQLExceptionSubclassTranslator) |
| sf-locate-advice-order | locate | 43,980 NO (miss AspectJPrecedenceComparator.java, AspectJPrecedenceComparator, comparePrecedenceWithinAspect, getAspectDeclarationOrder) | 9,556 NO (miss AspectJPrecedenceComparator.java, AspectJPrecedenceComparator, comparePrecedenceWithinAspect, getAspectDeclarationOrder) | 712 NO (miss comparePrecedenceWithinAspect) | 919 NO (miss comparePrecedenceWithinAspect) |
| sf-explain-concurrency-limit | explain | 20,664 NO (miss ConcurrencyLimitBeanPostProcessor.java, ConcurrencyThrottleSupport.java, ConcurrencyLimitBeanPostProcessor, ConcurrencyLimitInterceptor, +2) | 6,661 NO (miss ConcurrencyLimitBeanPostProcessor.java, ConcurrencyThrottleSupport.java, ConcurrencyLimitBeanPostProcessor, ConcurrencyLimitInterceptor, +2) | 1,182 NO (miss ConcurrencyLimitInterceptor, beforeAccess) | 1,607 NO (miss ConcurrencyLimitInterceptor, beforeAccess) |
| sf-explain-retryable | explain | 13,521 NO (miss RetryAnnotationBeanPostProcessor.java, AbstractRetryInterceptor.java, getRetrySpec, AbstractRetryInterceptor) | 6,106 NO (miss RetryAnnotationBeanPostProcessor.java, AbstractRetryInterceptor.java, getRetrySpec, AbstractRetryInterceptor) | 1,550 NO (miss RetryAnnotationBeanPostProcessor.java, AbstractRetryInterceptor.java, RetryTemplate.java, RetryAnnotationBeanPostProcessor, +3) | 1,190 NO (miss RetryAnnotationBeanPostProcessor.java, AbstractRetryInterceptor.java, RetryAnnotationBeanPostProcessor, getRetrySpec, +1) |
| sf-explain-config-full-lite | explain | 43,980 NO (miss ConfigurationClassUtils.java, ConfigurationClassPostProcessor.java, ConfigurationClassEnhancer.java, checkConfigurationClassCandidate, +3) | 9,556 NO (miss ConfigurationClassUtils.java, ConfigurationClassPostProcessor.java, ConfigurationClassEnhancer.java, checkConfigurationClassCandidate, +3) | 1,547 NO (miss ConfigurationClassUtils.java, checkConfigurationClassCandidate) | 1,460 NO (miss ConfigurationClassUtils.java, checkConfigurationClassCandidate) |
| sf-explain-exponential-backoff | explain | 13,517 OK | 7,534 NO (miss computeNextInterval) | 1,150 OK | 1,317 OK |
| sf-usage-fail-early | usage | 19,851 OK | 4,794 OK | 738 OK | 864 NO (miss processCommit, processRollback) |
| sf-usage-trigger-flush | usage | 16,454 NO (miss DataSourceTransactionObject) | 6,597 OK | 1,033 NO (miss DataSourceTransactionManager.java) | 1,349 NO (miss DataSourceTransactionManager.java, DataSourceTransactionObject) |
| sf-usage-imported-by | usage | 26,310 OK | 3,582 OK | 777 NO (miss ConfigurationClassBeanDefinitionReader.java) | 803 NO (miss TrackedConditionEvaluator, getEnclosingConfigurationClass) |
| sf-usage-lru-drain | usage | 12,682 OK | 8,546 NO (miss drainOperations, processWrite) | 877 NO (miss drainOperations, processRead, processWrite) | 956 NO (miss drainOperations, processRead, processWrite) |
| sf-impact-shortcut | impact | 47,421 OK | 7,270 NO (miss createArgumentArray) | 374 OK | 418 NO (miss createArgumentArray, resolvePreparedArguments) |
| sf-impact-primary-conflict | impact | 16,708 NO (miss DefaultListableBeanFactory.java, hasPrimaryConflict, doResolveDependency) | 7,666 NO (miss DefaultListableBeanFactory.java, hasPrimaryConflict, doResolveDependency) | 2,481 NO (miss DefaultListableBeanFactory.java, hasPrimaryConflict, doResolveDependency) | 1,302 NO (miss DefaultListableBeanFactory.java, hasPrimaryConflict, doResolveDependency) |
| sf-impact-cleanup-txinfo | impact | 23,146 OK | 7,378 OK | 268 OK | 2,277 OK |

## Settings

- grep_search emulation: 100 matches / 10,000 chars, lines cut at 250 chars; pattern = most selective keywords while the total stays under the match cap; files ordered by distinct keywords, non-test first, match count (generous to native).
- native-naive: top 3 files by visible match count, whole file capped at 2000 lines.
- native-ranged: ±60 lines around the best 4 matches (overlaps merged).
- kopt budgets: find 700, pack 2500, read 2000 tokens.
- index: reused in 0 ms, 9,552 files, 138,619 symbols.
- run duration: 9,472 ms.
