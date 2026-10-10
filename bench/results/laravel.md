# kopt bench: laravel

Repo `laravel` @ `v13.35.0` (`a413a9da9488`) · 12 tasks · input = `search` · 3 chars/token · 2026-10-09T22:38:48.345Z

> Offline proxy: tokens = estimated tokens of tool outputs returned to the model for ONE exploration step.
> It is not a credit measurement. Savings must be confirmed by the online A/B (bench/ab) before being claimed.

## Summary per strategy

| strategy | tasks | found | file recall | symbol recall | def recall | median tok | mean tok | p90 tok | tok / found task | calls |
|---|---|---|---|---|---|---|---|---|---|---|
| native-naive | 12 | 6 (50%) | 78% | 71% | 60% | 22,327 | 29,214 | 71,442 | 58,428 | 3.8 |
| native-ranged | 12 | 4 (33%) | 78% | 62% | 43% | 4,786 | 34,005 | 171,419 | 102,016 | 4.6 |
| kopt-pack | 12 | 9 (75%) | 92% | 94% | 62% | 1,298 | 1,235 | 1,434 | 1,646 | 1.0 |
| kopt-hits+read | 12 | 6 (50%) | 86% | 84% | 61% | 1,007 | 1,353 | 2,530 | 2,706 | 3.0 |
| kirograph | 12 | 0 (0%) | 15% | 17% | 4% | 1,382 | 1,274 | 1,806 | n/a | 1.0 |
| codegraph | 12 | 5 (42%) | 78% | 70% | 49% | 8,308 | 7,924 | 8,319 | 19,017 | 1.0 |

`found` = every gold file path AND every gold symbol name appears in the output. `def recall` = the definition line
of the gold symbol was shown (stricter). `tok / found task` = all tokens spent (failures included) / tasks found.

## Pass-gated pairs (only tasks found by both)

| b vs a | tasks run | found by both | only a | only b | median b/a | geomean b/a | b cheaper |
|---|---|---|---|---|---|---|---|
| kopt-pack vs native-naive | 12 | 6 | 0 | 3 | 0.07× | 0.09× | 6/6 |
| kopt-pack vs native-ranged | 12 | 4 | 0 | 5 | 0.26× | 0.25× | 4/4 |
| kopt-hits+read vs native-naive | 12 | 4 | 2 | 2 | 0.06× | 0.09× | 4/4 |
| kopt-hits+read vs native-ranged | 12 | 2 | 2 | 4 | 0.58× | 0.39× | 1/2 |
| kopt-pack vs kirograph | 12 | 0 | 0 | 9 | n/a | n/a | 0/0 |
| kopt-pack vs codegraph | 12 | 4 | 1 | 5 | 0.16× | 0.14× | 4/4 |
| kopt-hits+read vs kirograph | 12 | 0 | 0 | 6 | n/a | n/a | 0/0 |
| kopt-hits+read vs codegraph | 12 | 3 | 2 | 3 | 0.09× | 0.12× | 3/3 |
| kirograph vs native-ranged | 12 | 0 | 4 | 0 | n/a | n/a | 0/0 |
| codegraph vs native-ranged | 12 | 3 | 1 | 2 | 2.17× | 2.35× | 0/3 |
| native-ranged vs native-naive | 12 | 4 | 2 | 0 | 0.36× | 0.40× | 4/4 |

## By task kind

| kind | strategy | tasks | found | median tok |
|---|---|---|---|---|
| locate | native-naive | 4 | 1 | 15,837 |
| locate | native-ranged | 4 | 1 | 5,186 |
| locate | kopt-pack | 4 | 3 | 1,319 |
| locate | kopt-hits+read | 4 | 2 | 1,206 |
| locate | kirograph | 4 | 0 | 1,287 |
| locate | codegraph | 4 | 1 | 8,088 |
| explain | native-naive | 3 | 0 | 71,442 |
| explain | native-ranged | 3 | 0 | 21,531 |
| explain | kopt-pack | 3 | 1 | 1,269 |
| explain | kopt-hits+read | 3 | 1 | 2,318 |
| explain | kirograph | 3 | 0 | 937 |
| explain | codegraph | 3 | 1 | 8,305 |
| usage | native-naive | 3 | 3 | 18,874 |
| usage | native-ranged | 3 | 1 | 4,757 |
| usage | kopt-pack | 3 | 3 | 1,281 |
| usage | kopt-hits+read | 3 | 3 | 701 |
| usage | kirograph | 3 | 0 | 1,528 |
| usage | codegraph | 3 | 2 | 8,313 |
| impact | native-naive | 2 | 2 | 17,643 |
| impact | native-ranged | 2 | 2 | 6,539 |
| impact | kopt-pack | 2 | 2 | 1,235 |
| impact | kopt-hits+read | 2 | 0 | 860 |
| impact | kirograph | 2 | 0 | 1,382 |
| impact | codegraph | 2 | 1 | 8,312 |

## Per task (tokens, found)

| task | kind | native-naive | native-ranged | kopt-pack | kopt-hits+read | kirograph | codegraph |
|---|---|---|---|---|---|---|---|
| lv-locate-cache-flexible | locate | 22,344 NO (miss functions.php, flexible, defer) | 6,161 NO (miss functions.php, flexible, defer) | 1,314 NO (miss functions.php) | 1,324 NO (miss functions.php) | 1,080 NO (miss Repository.php, functions.php, flexible, defer) | 6,131 NO (miss Repository.php, functions.php, flexible, defer) |
| lv-locate-image-processing | locate | 52,831 NO (miss InterventionDriver.php, ImageManager.php, process, transformationHandlerFor, +1) | 171,650 NO (miss InterventionDriver.php, ImageManager.php, process, transformationHandlerFor, +1) | 1,218 OK | 722 OK | 1,062 NO (miss Image.php, InterventionDriver.php, ImageManager.php, process, +2) | 8,307 NO (miss transformationHandlerFor) |
| lv-locate-pwned | locate | 9,330 NO (miss Password.php) | 4,211 NO (miss Password.php) | 1,362 OK | 1,088 NO (miss passes) | 1,493 NO (miss NotPwnedVerifier.php, Password.php, verify, search, +1) | 8,309 NO (miss NotPwnedVerifier.php, search) |
| lv-locate-cache-failover | locate | 4,105 OK | 2,529 OK | 1,323 OK | 2,530 OK | 1,634 NO (miss CacheFailedOver.php, attemptOnAllStores) | 7,869 OK |
| lv-explain-http-batch | explain | 28,206 NO (miss send, hasFailures, incrementFailedRequests) | 171,419 NO (miss hasFailures, incrementFailedRequests) | 838 NO (miss hasFailures) | 762 NO (miss hasFailures) | 937 NO (miss send, hasFailures, incrementFailedRequests) | 8,319 OK |
| lv-explain-concurrency | explain | 72,119 NO (miss ProcessDriver.php, InvokeSerializedClosureCommand.php, InvokeSerializedClosureCommand) | 21,531 NO (miss ProcessDriver.php, InvokeSerializedClosureCommand.php, defer, InvokeSerializedClosureCommand) | 1,434 NO (miss InvokeSerializedClosureCommand.php, InvokeSerializedClosureCommand, handle) | 2,318 NO (miss InvokeSerializedClosureCommand.php, InvokeSerializedClosureCommand, handle) | 234 NO (miss ProcessDriver.php, InvokeSerializedClosureCommand.php, defer, InvokeSerializedClosureCommand, +1) | 8,305 NO (miss InvokeSerializedClosureCommand.php, InvokeSerializedClosureCommand, handle) |
| lv-explain-throttles-exceptions | explain | 71,442 NO (miss shouldDelete, shouldFail, getTimeUntilNextRetryAfterException) | 4,083 NO (miss shouldDelete, shouldFail, getTimeUntilNextRetryAfterException) | 1,269 OK | 3,200 OK | 1,831 NO (miss ThrottlesExceptions.php, handle, shouldDelete, shouldFail, +1) | 6,331 NO (miss shouldDelete, getTimeUntilNextRetryAfterException) |
| lv-usage-image-driver | usage | 12,310 OK | 3,832 OK | 777 OK | 580 OK | 1,528 NO (miss Image.php, toBytes, dimensions, dominantColor) | 8,332 OK |
| lv-usage-fail-job | usage | 23,720 OK | 4,814 NO (miss markJobAsFailedIfAlreadyExceedsMaxAttempts, markJobAsFailedIfWillExceedMaxAttempts) | 1,281 OK | 701 OK | 1,806 NO (miss Worker.php, markJobAsFailedIfAlreadyExceedsMaxAttempts, markJobAsFailedIfWillExceedMaxAttempts, markJobAsFailedIfWillExceedMaxExceptions, +2) | 8,246 OK |
| lv-usage-batch-record | usage | 18,874 OK | 4,757 NO (miss ensureSuccessfulBatchJobIsRecordedForMissingModel, ensureFailedBatchJobIsRecorded) | 1,530 OK | 1,290 OK | 916 NO (miss CallQueuedHandler.php, ensureSuccessfulBatchJobIsRecorded, ensureSuccessfulBatchJobIsRecordedForMissingModel, ensureFailedBatchJobIsRecorded) | 8,313 NO (miss ensureSuccessfulBatchJobIsRecorded, ensureSuccessfulBatchJobIsRecordedForMissingModel) |
| lv-impact-max-exceptions | impact | 12,975 OK | 4,337 OK | 1,363 OK | 925 NO (miss registerTimeoutHandler) | 1,312 NO (miss Worker.php, registerTimeoutHandler, handleJobException, markJobAsFailedIfAlreadyExceedsMaxExceptions) | 8,315 OK |
| lv-impact-flexible-prefix | impact | 22,310 OK | 8,741 OK | 1,107 OK | 794 NO (miss DatabaseStore.php, FileStore.php, forgetMany, forgetManyIfExpired, +1) | 1,452 NO (miss DatabaseStore.php, FileStore.php, forgetMany, forgetManyIfExpired, +1) | 8,309 NO (miss DatabaseStore.php, FileStore.php, forgetMany, forgetManyIfExpired) |

## Settings

- grep_search emulation: 100 matches / 10,000 chars, lines cut at 250 chars; pattern = most selective keywords while the total stays under the match cap; files ordered by distinct keywords, non-test first, match count (generous to native).
- native-naive: top 3 files by visible match count, whole file capped at 2000 lines.
- native-ranged: ±60 lines around the best 4 matches (overlaps merged).
- kopt budgets: find 700, pack 2500, read 3000 tokens.
- index: reused, 3,114 files, 40,979 symbols.
- kirograph: outputs loaded from bench/competitors/results/kirograph-laravel.jsonl
- codegraph: outputs loaded from bench/competitors/results/codegraph-laravel.jsonl
- run duration: 5,866 ms.
