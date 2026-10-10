# kopt bench: webpack

Repo `webpack` @ `v5.111.1` (`5a106753839f`) · 12 tasks · input = `search` · 3 chars/token · 2026-10-09T22:37:49.719Z

> Offline proxy: tokens = estimated tokens of tool outputs returned to the model for ONE exploration step.
> It is not a credit measurement. Savings must be confirmed by the online A/B (bench/ab) before being claimed.

## Summary per strategy

| strategy | tasks | found | file recall | symbol recall | def recall | median tok | mean tok | p90 tok | tok / found task | calls |
|---|---|---|---|---|---|---|---|---|---|---|
| native-naive | 12 | 6 (50%) | 75% | 76% | 65% | 32,203 | 33,552 | 47,931 | 67,104 | 3.8 |
| native-ranged | 12 | 5 (42%) | 75% | 61% | 49% | 5,649 | 16,860 | 7,586 | 40,465 | 4.4 |
| kopt-pack | 12 | 11 (92%) | 92% | 92% | 74% | 1,110 | 1,056 | 1,376 | 1,152 | 1.0 |
| kopt-hits+read | 12 | 7 (58%) | 71% | 67% | 59% | 1,315 | 1,674 | 3,620 | 2,870 | 3.0 |
| kirograph | 12 | 1 (8%) | 19% | 17% | 8% | 752 | 1,591 | 5,023 | 19,095 | 1.0 |
| codegraph | 12 | 5 (42%) | 58% | 67% | 41% | 8,325 | 8,323 | 8,331 | 19,976 | 1.0 |

`found` = every gold file path AND every gold symbol name appears in the output. `def recall` = the definition line
of the gold symbol was shown (stricter). `tok / found task` = all tokens spent (failures included) / tasks found.

## Pass-gated pairs (only tasks found by both)

| b vs a | tasks run | found by both | only a | only b | median b/a | geomean b/a | b cheaper |
|---|---|---|---|---|---|---|---|
| kopt-pack vs native-naive | 12 | 5 | 1 | 6 | 0.03× | 0.03× | 5/5 |
| kopt-pack vs native-ranged | 12 | 4 | 1 | 7 | 0.18× | 0.09× | 4/4 |
| kopt-hits+read vs native-naive | 12 | 3 | 3 | 4 | 0.07× | 0.06× | 3/3 |
| kopt-hits+read vs native-ranged | 12 | 3 | 2 | 4 | 0.39× | 0.14× | 3/3 |
| kopt-pack vs kirograph | 12 | 1 | 0 | 10 | 0.71× | 0.71× | 1/1 |
| kopt-pack vs codegraph | 12 | 4 | 1 | 7 | 0.12× | 0.12× | 4/4 |
| kopt-hits+read vs kirograph | 12 | 1 | 0 | 6 | 0.83× | 0.83× | 1/1 |
| kopt-hits+read vs codegraph | 12 | 3 | 2 | 4 | 0.19× | 0.25× | 3/3 |
| kirograph vs native-ranged | 12 | 1 | 4 | 0 | 0.01× | 0.01× | 1/1 |
| codegraph vs native-ranged | 12 | 3 | 2 | 2 | 1.41× | 0.55× | 1/3 |
| native-ranged vs native-naive | 12 | 5 | 1 | 0 | 0.19× | 0.33× | 4/5 |

## By task kind

| kind | strategy | tasks | found | median tok |
|---|---|---|---|---|
| locate | native-naive | 4 | 1 | 44,031 |
| locate | native-ranged | 4 | 1 | 5,505 |
| locate | kopt-pack | 4 | 4 | 1,199 |
| locate | kopt-hits+read | 4 | 4 | 1,547 |
| locate | kirograph | 4 | 1 | 1,330 |
| locate | codegraph | 4 | 1 | 8,321 |
| explain | native-naive | 3 | 2 | 37,116 |
| explain | native-ranged | 3 | 2 | 7,576 |
| explain | kopt-pack | 3 | 3 | 1,309 |
| explain | kopt-hits+read | 3 | 2 | 3,620 |
| explain | kirograph | 3 | 0 | 735 |
| explain | codegraph | 3 | 1 | 8,329 |
| usage | native-naive | 3 | 2 | 27,390 |
| usage | native-ranged | 3 | 1 | 4,761 |
| usage | kopt-pack | 3 | 2 | 781 |
| usage | kopt-hits+read | 3 | 0 | 905 |
| usage | kirograph | 3 | 0 | 1,146 |
| usage | codegraph | 3 | 2 | 8,325 |
| impact | native-naive | 2 | 1 | 21,720 |
| impact | native-ranged | 2 | 1 | 4,762 |
| impact | kopt-pack | 2 | 2 | 987 |
| impact | kopt-hits+read | 2 | 1 | 1,082 |
| impact | kirograph | 2 | 0 | 699 |
| impact | codegraph | 2 | 1 | 8,326 |

## Per task (tokens, found)

| task | kind | native-naive | native-ranged | kopt-pack | kopt-hits+read | kirograph | codegraph |
|---|---|---|---|---|---|---|---|
| wp-locate-dotenv-expand | locate | 47,931 OK | 143,254 OK | 1,376 OK | 1,596 OK | 1,927 OK | 8,325 OK |
| wp-locate-semver-satisfy | locate | 52,305 NO (miss semver.js, satisfy, satisfyRuntimeCode) | 5,853 NO (miss semver.js, satisfy, satisfyRuntimeCode) | 1,307 OK | 2,663 OK | 729 NO (miss semver.js, satisfy, satisfyRuntimeCode) | 8,329 NO (miss satisfy) |
| wp-locate-case-mismatch | locate | 40,131 NO (miss findCaseMismatch.js) | 5,156 NO (miss findCaseMismatch.js, findCaseMismatch, _resolveResourceErrorHints) | 1,091 OK | 1,049 OK | 5,023 NO (miss findCaseMismatch.js, NormalModuleFactory.js, findCaseMismatch, _resolveResourceErrorHints) | 8,315 NO (miss findCaseMismatch.js, findCaseMismatch) |
| wp-locate-circular-hints | locate | 22,860 NO (miss CircularDependenciesWarning.js) | 3,763 NO (miss CircularDependenciesWarning.js) | 909 OK | 1,497 OK | 732 NO (miss CircularModulesPlugin.js, CircularDependenciesWarning.js, apply, CircularDependenciesWarning) | 8,316 NO (miss CircularModulesPlugin.js, CircularDependenciesWarning.js, CircularDependenciesWarning) |
| wp-explain-lazy-barrel | explain | 37,116 OK | 7,576 OK | 1,392 OK | 4,298 OK | 945 NO (miss LazyBarrel.js, LazyBarrelController, classify, request, +1) | 8,329 NO (miss LazyBarrel.js, LazyBarrelController, classify, LazyBarrelInfo) |
| wp-explain-deterministic-grouping | explain | 30,773 OK | 5,927 OK | 1,309 OK | 714 NO (miss getSimilarities, popNodes) | 669 NO (miss deterministicGrouping.js, getSimilarities, Group, popNodes) | 8,331 NO (miss deterministicGrouping.js, getSimilarities, Group, popNodes) |
| wp-explain-circular-scc | explain | 40,674 NO (miss CircularModulesPlugin.js, CycleGraph, getSynchronousTarget, isBindingRead) | 7,586 NO (miss CircularModulesPlugin.js, CycleGraph, build, getSynchronousTarget, +1) | 1,128 OK | 3,620 OK | 735 NO (miss CircularModulesPlugin.js, CycleGraph, build, getSynchronousTarget, +1) | 8,324 OK |
| wp-usage-process-async-tree | usage | 26,372 NO (miss executeModule) | 4,761 NO (miss applyDiff, executeModule, resolveBuildDependencies, _resolveContextTsh) | 831 OK | 1,132 NO (miss CleanPlugin.js, Compilation.js, FileSystemInfo.js, applyDiff, +5) | 5,023 NO (miss CleanPlugin.js, Compilation.js, applyDiff, executeModule, +4) | 8,329 OK |
| wp-usage-unlazy-for-dependency | usage | 27,390 OK | 3,051 NO (miss _processModuleDependencies) | 579 OK | 451 NO (miss Compilation.js, _processModuleDependencies) | 769 NO (miss _processModuleDependencies) | 8,325 NO (miss Compilation.js) |
| wp-usage-implicit-type-fallback | usage | 33,632 OK | 5,875 OK | 781 NO (miss CssModulesPlugin.js, HtmlModulesPlugin.js, CssModulesPlugin, HtmlModulesPlugin) | 905 NO (miss CssModulesPlugin.js, HtmlModulesPlugin.js, CssModulesPlugin, HtmlModulesPlugin) | 1,146 NO (miss CssModulesPlugin.js, HtmlModulesPlugin.js, CssModulesPlugin, HtmlModulesPlugin) | 8,305 OK |
| wp-impact-legacy-is-circular | impact | 20,478 NO (miss HarmonyExportDependencyTemplate, HarmonyExportSpecifierDependencyTemplate) | 5,444 NO (miss HarmonyExportDependencyTemplate) | 1,255 OK | 557 NO (miss HarmonyExportExpressionDependency.js, HarmonyExportSpecifierDependency.js, HarmonyExportDependencyTemplate, HarmonyExportSpecifierDependencyTemplate) | 670 NO (miss HarmonyExportExpressionDependency.js, HarmonyExportSpecifierDependency.js, HarmonyExportDependencyTemplate, HarmonyExportSpecifierDependencyTemplate) | 8,332 NO (miss HarmonyExportExpressionDependency.js, HarmonyExportSpecifierDependency.js, HarmonyExportDependencyTemplate, HarmonyExportSpecifierDependencyTemplate) |
| wp-impact-synchronous-target | impact | 22,962 OK | 4,079 OK | 719 OK | 1,607 OK | 727 NO (miss CircularModulesPlugin.js, build, formatShortestCycle) | 8,319 OK |

## Settings

- grep_search emulation: 100 matches / 10,000 chars, lines cut at 250 chars; pattern = most selective keywords while the total stays under the match cap; files ordered by distinct keywords, non-test first, match count (generous to native).
- native-naive: top 3 files by visible match count, whole file capped at 2000 lines.
- native-ranged: ±60 lines around the best 4 matches (overlaps merged).
- kopt budgets: find 700, pack 2500, read 3000 tokens.
- index: reused, 14,902 files, 22,575 symbols.
- kirograph: outputs loaded from bench/competitors/results/kirograph-webpack.jsonl
- codegraph: outputs loaded from bench/competitors/results/codegraph-webpack.jsonl
- run duration: 22,674 ms.
