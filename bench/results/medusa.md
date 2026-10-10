# kopt bench: medusa

Repo `medusa` @ `v2.21.2` (`020565398e43`) · 12 tasks · input = `search` · 3 chars/token · 2026-10-09T22:37:19.804Z

> Offline proxy: tokens = estimated tokens of tool outputs returned to the model for ONE exploration step.
> It is not a credit measurement. Savings must be confirmed by the online A/B (bench/ab) before being claimed.

## Summary per strategy

| strategy | tasks | found | file recall | symbol recall | def recall | median tok | mean tok | p90 tok | tok / found task | calls |
|---|---|---|---|---|---|---|---|---|---|---|
| native-naive | 12 | 5 (42%) | 58% | 58% | 45% | 28,854 | 33,763 | 50,387 | 81,032 | 3.5 |
| native-ranged | 12 | 3 (25%) | 58% | 46% | 30% | 6,994 | 6,880 | 9,825 | 27,520 | 4.0 |
| kopt-pack | 12 | 9 (75%) | 94% | 92% | 44% | 1,300 | 1,221 | 1,386 | 1,628 | 1.0 |
| kopt-hits+read | 12 | 4 (33%) | 61% | 58% | 50% | 995 | 1,496 | 3,093 | 4,488 | 3.0 |
| kirograph | 12 | 0 (0%) | 11% | 10% | 0% | 1,269 | 1,293 | 1,565 | n/a | 1.0 |
| codegraph | 12 | 7 (58%) | 87% | 74% | 36% | 8,317 | 8,108 | 8,329 | 13,900 | 1.0 |

`found` = every gold file path AND every gold symbol name appears in the output. `def recall` = the definition line
of the gold symbol was shown (stricter). `tok / found task` = all tokens spent (failures included) / tasks found.

## Pass-gated pairs (only tasks found by both)

| b vs a | tasks run | found by both | only a | only b | median b/a | geomean b/a | b cheaper |
|---|---|---|---|---|---|---|---|
| kopt-pack vs native-naive | 12 | 4 | 1 | 5 | 0.03× | 0.04× | 4/4 |
| kopt-pack vs native-ranged | 12 | 3 | 0 | 6 | 0.27× | 0.24× | 3/3 |
| kopt-hits+read vs native-naive | 12 | 2 | 3 | 2 | 0.04× | 0.04× | 2/2 |
| kopt-hits+read vs native-ranged | 12 | 1 | 2 | 3 | 0.25× | 0.25× | 1/1 |
| kopt-pack vs kirograph | 12 | 0 | 0 | 9 | n/a | n/a | 0/0 |
| kopt-pack vs codegraph | 12 | 7 | 0 | 2 | 0.15× | 0.14× | 7/7 |
| kopt-hits+read vs kirograph | 12 | 0 | 0 | 4 | n/a | n/a | 0/0 |
| kopt-hits+read vs codegraph | 12 | 2 | 5 | 2 | 0.20× | 0.19× | 2/2 |
| kirograph vs native-ranged | 12 | 0 | 3 | 0 | n/a | n/a | 0/0 |
| codegraph vs native-ranged | 12 | 3 | 0 | 4 | 1.79× | 1.63× | 0/3 |
| native-ranged vs native-naive | 12 | 2 | 3 | 1 | 0.29× | 0.28× | 2/2 |

## By task kind

| kind | strategy | tasks | found | median tok |
|---|---|---|---|---|
| locate | native-naive | 4 | 1 | 42,915 |
| locate | native-ranged | 4 | 1 | 8,506 |
| locate | kopt-pack | 4 | 4 | 1,375 |
| locate | kopt-hits+read | 4 | 3 | 1,428 |
| locate | kirograph | 4 | 0 | 1,216 |
| locate | codegraph | 4 | 2 | 8,321 |
| explain | native-naive | 3 | 1 | 27,901 |
| explain | native-ranged | 3 | 0 | 9,668 |
| explain | kopt-pack | 3 | 1 | 1,373 |
| explain | kopt-hits+read | 3 | 1 | 950 |
| explain | kirograph | 3 | 0 | 1,137 |
| explain | codegraph | 3 | 1 | 8,317 |
| usage | native-naive | 3 | 2 | 29,806 |
| usage | native-ranged | 3 | 2 | 4,640 |
| usage | kopt-pack | 3 | 3 | 996 |
| usage | kopt-hits+read | 3 | 0 | 996 |
| usage | kirograph | 3 | 0 | 1,224 |
| usage | codegraph | 3 | 3 | 8,308 |
| impact | native-naive | 2 | 1 | 18,864 |
| impact | native-ranged | 2 | 0 | 4,447 |
| impact | kopt-pack | 2 | 1 | 989 |
| impact | kopt-hits+read | 2 | 0 | 1,912 |
| impact | kirograph | 2 | 0 | 1,438 |
| impact | codegraph | 2 | 1 | 7,111 |

## Per task (tokens, found)

| task | kind | native-naive | native-ranged | kopt-pack | kopt-hits+read | kirograph | codegraph |
|---|---|---|---|---|---|---|---|
| md-locate-permanent-failure | locate | 47,482 NO (miss step-response.ts, errors.ts, transaction-orchestrator.ts, isPermanentStepFailureError, +2) | 9,042 NO (miss step-response.ts, errors.ts, transaction-orchestrator.ts, isPermanentStepFailureError, +2) | 1,207 OK | 1,863 NO (miss transaction-orchestrator.ts, executeSyncStep, executeAsyncStep) | 1,565 NO (miss step-response.ts, errors.ts, isPermanentStepFailureError, executeSyncStep, +1) | 8,300 OK |
| md-locate-available-quantity | locate | 45,754 NO (miss inventory-level.ts, inventory-module.ts, getAvailableQuantity, retrieveAvailableQuantity) | 7,149 NO (miss inventory-level.ts, inventory-module.ts, getAvailableQuantity, retrieveAvailableQuantity) | 1,393 OK | 981 OK | 1,090 NO (miss inventory-level.ts, inventory-module.ts, getAvailableQuantity, retrieveAvailableQuantity) | 8,329 NO (miss inventory-level.ts, getAvailableQuantity, retrieveAvailableQuantity) |
| md-locate-capture-payment | locate | 27,858 NO (miss order-payment-section.tsx, payments.tsx, Payment, useCapturePayment) | 10,316 NO (miss order-payment-section.tsx, payments.tsx, Payment, useCapturePayment) | 1,364 OK | 993 OK | 1,045 NO (miss order-payment-section.tsx, payments.tsx, Payment, useCapturePayment) | 8,321 NO (miss payments.tsx) |
| md-locate-lock-renewal | locate | 40,076 OK | 7,969 OK | 1,386 OK | 1,989 OK | 1,342 NO (miss renewUntilStopped) | 8,320 OK |
| md-explain-compensation | explain | 27,901 NO (miss transaction-orchestrator.ts, setStepFailure, checkAllSteps, flagStepsToRevert, +1) | 9,668 NO (miss transaction-orchestrator.ts, setStepFailure, checkAllSteps, flagStepsToRevert, +1) | 1,373 NO (miss checkAllSteps, flagStepsToRevert, getCompensationSteps) | 950 NO (miss checkAllSteps, flagStepsToRevert, getCompensationSteps) | 1,025 NO (miss transaction-orchestrator.ts, setStepFailure, checkAllSteps, flagStepsToRevert, +1) | 8,328 NO (miss setStepFailure, checkAllSteps, flagStepsToRevert, getCompensationSteps) |
| md-explain-buy-get | explain | 50,387 OK | 6,839 NO (miss getComputedActionsForBuyGet, applyPromotionToTargetItems) | 1,326 OK | 1,293 OK | 1,750 NO (miss buy-get.ts, getComputedActionsForBuyGet, preparePromotionApplicationState, applyPromotionToTargetItems, +1) | 8,316 OK |
| md-explain-price-lists | explain | 27,885 NO (miss pricing-module.ts, pricing.ts, PricingModuleService) | 9,825 NO (miss pricing-module.ts, pricing.ts, PricingModuleService) | 1,386 NO (miss pricing.ts) | 763 NO (miss pricing.ts, PricingModuleService) | 1,137 NO (miss pricing-module.ts, pricing.ts, calculatePrices, calculatePrices, +1) | 8,317 NO (miss PricingModuleService) |
| md-usage-cancel-transaction | usage | 60,981 NO (miss registerStepFailure) | 4,640 OK | 1,274 OK | 3,441 NO (miss local-workflow.ts, cancel) | 1,313 NO (miss transaction-orchestrator.ts, local-workflow.ts, handleStepSuccess, handleStepFailure, +3) | 8,308 OK |
| md-usage-refund-hook | usage | 9,300 OK | 3,552 OK | 973 OK | 996 NO (miss create-refund-form.tsx, order-balance-settlement-form.tsx, CreateRefundForm, OrderBalanceSettlementForm) | 1,149 NO (miss create-refund-form.tsx, order-balance-settlement-form.tsx, CreateRefundForm, OrderBalanceSettlementForm) | 8,224 OK |
| md-usage-rules-valid | usage | 29,806 OK | 4,668 NO (miss computeActions, filterItemsByPromotionRules, getValidItemsForPromotion) | 996 OK | 858 NO (miss promotion-module.ts, buy-get.ts, line-items.ts, shipping-methods.ts, +4) | 1,224 NO (miss promotion-module.ts, buy-get.ts, line-items.ts, shipping-methods.ts, +4) | 8,316 OK |
| md-impact-budget-exceeded | impact | 11,768 OK | 3,045 NO (miss applyPromotionToTargetItems, applyPromotionToItems) | 865 NO (miss promotion-module.ts, computeActions) | 730 NO (miss promotion-module.ts, buy-get.ts, line-items.ts, shipping-methods.ts, +4) | 1,556 NO (miss usage.ts, promotion-module.ts, buy-get.ts, line-items.ts, +5) | 5,891 NO (miss buy-get.ts, line-items.ts, shipping-methods.ts, computeActions, +3) |
| md-impact-transaction-key | impact | 25,960 NO (miss createStepPayload, getTransactionAndStepFromIdempotencyKey, saveCheckpoint, loadTransaction) | 5,848 NO (miss createStepPayload, getTransactionAndStepFromIdempotencyKey, saveCheckpoint, loadTransaction) | 1,113 OK | 3,093 NO (miss distributed-transaction.ts, saveCheckpoint, loadTransaction) | 1,319 NO (miss transaction-orchestrator.ts, distributed-transaction.ts, createStepPayload, getTransactionAndStepFromIdempotencyKey, +2) | 8,331 OK |

## Settings

- grep_search emulation: 100 matches / 10,000 chars, lines cut at 250 chars; pattern = most selective keywords while the total stays under the match cap; files ordered by distinct keywords, non-test first, match count (generous to native).
- native-naive: top 3 files by visible match count, whole file capped at 2000 lines.
- native-ranged: ±60 lines around the best 4 matches (overlaps merged).
- kopt budgets: find 700, pack 2500, read 3000 tokens.
- index: reused, 11,970 files, 40,269 symbols.
- kirograph: outputs loaded from bench/competitors/results/kirograph-medusa.jsonl
- codegraph: outputs loaded from bench/competitors/results/codegraph-medusa.jsonl
- run duration: 925,661 ms.
