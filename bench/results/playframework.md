# kopt bench: playframework

Repo `playframework` @ `3.0.12` (`316f494b2d12`) · 12 tasks · input = `search` · 3 chars/token · 2026-10-09T22:39:50.250Z

> Offline proxy: tokens = estimated tokens of tool outputs returned to the model for ONE exploration step.
> It is not a credit measurement. Savings must be confirmed by the online A/B (bench/ab) before being claimed.

## Summary per strategy

| strategy | tasks | found | file recall | symbol recall | def recall | median tok | mean tok | p90 tok | tok / found task | calls |
|---|---|---|---|---|---|---|---|---|---|---|
| native-naive | 12 | 9 (75%) | 92% | 79% | 75% | 21,802 | 23,042 | 30,592 | 30,723 | 3.9 |
| native-ranged | 12 | 5 (42%) | 92% | 52% | 43% | 7,631 | 10,102 | 9,495 | 24,245 | 4.5 |
| kopt-pack | 12 | 8 (67%) | 100% | 90% | 39% | 1,319 | 1,337 | 1,397 | 2,006 | 1.0 |
| kopt-hits+read | 12 | 5 (42%) | 92% | 69% | 41% | 1,346 | 1,568 | 2,233 | 3,762 | 3.0 |
| kirograph | 12 | 0 (0%) | 17% | 10% | 3% | 1,307 | 1,443 | 2,238 | n/a | 1.0 |
| codegraph | 12 | 10 (83%) | 92% | 85% | 51% | 8,319 | 8,199 | 8,330 | 9,839 | 1.0 |

`found` = every gold file path AND every gold symbol name appears in the output. `def recall` = the definition line
of the gold symbol was shown (stricter). `tok / found task` = all tokens spent (failures included) / tasks found.

## Pass-gated pairs (only tasks found by both)

| b vs a | tasks run | found by both | only a | only b | median b/a | geomean b/a | b cheaper |
|---|---|---|---|---|---|---|---|
| kopt-pack vs native-naive | 12 | 7 | 2 | 1 | 0.07× | 0.07× | 7/7 |
| kopt-pack vs native-ranged | 12 | 5 | 0 | 3 | 0.16× | 0.12× | 5/5 |
| kopt-hits+read vs native-naive | 12 | 5 | 4 | 0 | 0.10× | 0.10× | 5/5 |
| kopt-hits+read vs native-ranged | 12 | 5 | 0 | 0 | 0.20× | 0.17× | 5/5 |
| kopt-pack vs kirograph | 12 | 0 | 0 | 8 | n/a | n/a | 0/0 |
| kopt-pack vs codegraph | 12 | 7 | 3 | 1 | 0.16× | 0.16× | 7/7 |
| kopt-hits+read vs kirograph | 12 | 0 | 0 | 5 | n/a | n/a | 0/0 |
| kopt-hits+read vs codegraph | 12 | 5 | 5 | 0 | 0.21× | 0.23× | 5/5 |
| kirograph vs native-ranged | 12 | 0 | 5 | 0 | n/a | n/a | 0/0 |
| codegraph vs native-ranged | 12 | 5 | 0 | 5 | 1.02× | 0.77× | 2/5 |
| native-ranged vs native-naive | 12 | 5 | 4 | 0 | 0.53× | 0.58× | 4/5 |

## By task kind

| kind | strategy | tasks | found | median tok |
|---|---|---|---|---|
| locate | native-naive | 4 | 3 | 28,986 |
| locate | native-ranged | 4 | 1 | 7,577 |
| locate | kopt-pack | 4 | 3 | 1,319 |
| locate | kopt-hits+read | 4 | 1 | 1,271 |
| locate | kirograph | 4 | 0 | 1,033 |
| locate | codegraph | 4 | 3 | 8,315 |
| explain | native-naive | 3 | 2 | 23,170 |
| explain | native-ranged | 3 | 1 | 8,979 |
| explain | kopt-pack | 3 | 1 | 1,364 |
| explain | kopt-hits+read | 3 | 1 | 1,233 |
| explain | kirograph | 3 | 0 | 1,329 |
| explain | codegraph | 3 | 2 | 8,318 |
| usage | native-naive | 3 | 2 | 19,555 |
| usage | native-ranged | 3 | 1 | 7,184 |
| usage | kopt-pack | 3 | 2 | 1,299 |
| usage | kopt-hits+read | 3 | 1 | 1,581 |
| usage | kirograph | 3 | 0 | 2,238 |
| usage | codegraph | 3 | 3 | 8,325 |
| impact | native-naive | 2 | 2 | 22,285 |
| impact | native-ranged | 2 | 2 | 8,080 |
| impact | kopt-pack | 2 | 2 | 1,403 |
| impact | kopt-hits+read | 2 | 2 | 2,312 |
| impact | kirograph | 2 | 0 | 1,668 |
| impact | codegraph | 2 | 2 | 8,313 |

## Per task (tokens, found)

| task | kind | native-naive | native-ranged | kopt-pack | kopt-hits+read | kirograph | codegraph |
|---|---|---|---|---|---|---|---|
| pf-locate-evolution-conflict | locate | 16,437 OK | 36,185 OK | 1,321 OK | 1,353 OK | 658 NO (miss scripts, conflictings) | 8,330 OK |
| pf-locate-csrf-body-token | locate | 37,419 NO (miss CSRFActions.scala, checkBody, extractTokenFromFormBody, extractTokenFromMultipartFormDataBody, +1) | 8,263 NO (miss CSRFActions.scala, checkBody, extractTokenFromFormBody, extractTokenFromMultipartFormDataBody, +1) | 1,328 OK | 2,089 NO (miss BodyHandler) | 972 NO (miss CSRFActions.scala, checkBody, extractTokenFromFormBody, extractTokenFromMultipartFormDataBody, +1) | 8,333 NO (miss checkBody, extractTokenFromFormBody, BodyHandler) |
| pf-locate-jwt-session | locate | 27,379 OK | 6,863 NO (miss FallbackCookieDataCodec) | 1,305 NO (miss parse) | 1,188 NO (miss parse) | 1,348 NO (miss Cookie.scala, JWTCookieDataCodec, JWTFormatter, parse, +1) | 8,299 OK |
| pf-locate-routes-validation | locate | 30,592 OK | 6,891 NO (miss validate, parseContent) | 1,317 OK | 961 NO (miss validate, parseContent) | 1,094 NO (miss RoutesFileParser.scala, validate, parseContent) | 7,795 OK |
| pf-explain-gzip | explain | 29,620 OK | 9,495 NO (miss handleResult, mayCompress, gzipIsAcceptedAndPreferredBy) | 1,364 NO (miss handleResult) | 1,113 NO (miss handleResult) | 1,405 NO (miss GzipFilter.scala, handleResult, shouldCompress, mayCompress, +1) | 7,764 NO (miss GzipFilter.scala, handleResult, shouldCompress, mayCompress, +1) |
| pf-explain-forwarded | explain | 17,092 OK | 8,979 OK | 1,275 OK | 1,780 OK | 1,284 NO (miss ForwardedHeaderHandler.scala, forwardedConnection, forwardedHeaders, parseEntry, +1) | 8,322 OK |
| pf-explain-cached | explain | 23,170 NO (miss CachedBuilder, handleResult, cachingWithEternity) | 6,746 NO (miss CachedBuilder, build, handleResult, cachingWithEternity) | 1,373 NO (miss cachingWithEternity) | 1,233 NO (miss cachingWithEternity) | 1,329 NO (miss Cached.scala, CachedBuilder, build, handleResult, +1) | 8,318 OK |
| pf-usage-prepare-cookies | usage | 20,433 OK | 7,284 NO (miss handleAction, runAction) | 1,261 OK | 1,581 NO (miss PlayRequestHandler.scala, PekkoHttpServer.scala, handleAction, runAction) | 2,238 NO (miss PlayRequestHandler.scala, PekkoHttpServer.scala, handleAction, runAction) | 8,329 OK |
| pf-usage-enforce-max-length | usage | 19,555 OK | 7,175 OK | 1,397 OK | 2,233 OK | 2,514 NO (miss BodyParsers.scala, raw, multipartFormData, tolerantBodyParser) | 8,325 OK |
| pf-usage-assets-digest | usage | 10,240 NO (miss findAssetPath, assetInfoFromResource, StaticAssetsMetadata) | 7,184 NO (miss findAssetPath, assetInfoFromResource, StaticAssetsMetadata) | 1,299 NO (miss findAssetPath, versioned) | 655 NO (miss findAssetPath, assetInfoFromResource, versioned) | 1,143 NO (miss findAssetPath, assetInfoFromResource, versioned, StaticAssetsMetadata) | 7,946 OK |
| pf-impact-requires-csrf-check | impact | 14,050 OK | 8,181 OK | 1,272 OK | 3,286 OK | 1,097 NO (miss CSRFActions.scala, RequireCSRFCheckAction.java, CSRFAction, CSRFCheckAction, +1) | 8,306 OK |
| pf-impact-get-handler-for | impact | 30,519 OK | 7,978 OK | 1,534 OK | 1,338 OK | 2,238 NO (miss Server.scala, PlayRequestHandler.scala, PekkoHttpServer.scala, handle, +1) | 8,319 OK |

## Settings

- grep_search emulation: 100 matches / 10,000 chars, lines cut at 250 chars; pattern = most selective keywords while the total stays under the match cap; files ordered by distinct keywords, non-test first, match count (generous to native).
- native-naive: top 3 files by visible match count, whole file capped at 2000 lines.
- native-ranged: ±60 lines around the best 4 matches (overlaps merged).
- kopt budgets: find 700, pack 2500, read 3000 tokens.
- index: reused, 1,427 files, 18,592 symbols.
- kirograph: outputs loaded from bench/competitors/results/kirograph-playframework.jsonl
- codegraph: outputs loaded from bench/competitors/results/codegraph-playframework.jsonl
- run duration: 4,806 ms.
