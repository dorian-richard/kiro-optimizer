# kopt bench: jellyfin

Repo `jellyfin` @ `v10.11.11` (`1fbd8739292c`) · 12 tasks · input = `search` · 3 chars/token · 2026-10-09T22:37:56.163Z

> Offline proxy: tokens = estimated tokens of tool outputs returned to the model for ONE exploration step.
> It is not a credit measurement. Savings must be confirmed by the online A/B (bench/ab) before being claimed.

## Summary per strategy

| strategy | tasks | found | file recall | symbol recall | def recall | median tok | mean tok | p90 tok | tok / found task | calls |
|---|---|---|---|---|---|---|---|---|---|---|
| native-naive | 12 | 5 (42%) | 96% | 71% | 63% | 13,681 | 19,285 | 26,362 | 46,284 | 4.0 |
| native-ranged | 12 | 5 (42%) | 96% | 76% | 63% | 6,578 | 6,766 | 8,871 | 16,238 | 4.5 |
| kopt-pack | 12 | 10 (83%) | 88% | 90% | 33% | 1,299 | 1,140 | 1,441 | 1,369 | 1.0 |
| kopt-hits+read | 12 | 2 (17%) | 55% | 44% | 31% | 1,310 | 1,772 | 4,203 | 10,631 | 3.0 |
| kirograph | 12 | 0 (0%) | 28% | 9% | 0% | 865 | 693 | 1,245 | n/a | 1.0 |
| codegraph | 12 | 8 (67%) | 92% | 79% | 47% | 8,316 | 8,038 | 8,330 | 12,058 | 1.0 |

`found` = every gold file path AND every gold symbol name appears in the output. `def recall` = the definition line
of the gold symbol was shown (stricter). `tok / found task` = all tokens spent (failures included) / tasks found.

## Pass-gated pairs (only tasks found by both)

| b vs a | tasks run | found by both | only a | only b | median b/a | geomean b/a | b cheaper |
|---|---|---|---|---|---|---|---|
| kopt-pack vs native-naive | 12 | 4 | 1 | 6 | 0.07× | 0.06× | 4/4 |
| kopt-pack vs native-ranged | 12 | 4 | 1 | 6 | 0.21× | 0.20× | 4/4 |
| kopt-hits+read vs native-naive | 12 | 1 | 4 | 1 | 0.10× | 0.10× | 1/1 |
| kopt-hits+read vs native-ranged | 12 | 2 | 3 | 0 | 0.47× | 0.36× | 2/2 |
| kopt-pack vs kirograph | 12 | 0 | 0 | 10 | n/a | n/a | 0/0 |
| kopt-pack vs codegraph | 12 | 8 | 0 | 2 | 0.12× | 0.12× | 8/8 |
| kopt-hits+read vs kirograph | 12 | 0 | 0 | 2 | n/a | n/a | 0/0 |
| kopt-hits+read vs codegraph | 12 | 2 | 6 | 0 | 0.32× | 0.26× | 2/2 |
| kirograph vs native-ranged | 12 | 0 | 5 | 0 | n/a | n/a | 0/0 |
| codegraph vs native-ranged | 12 | 4 | 1 | 4 | 1.48× | 1.45× | 0/4 |
| native-ranged vs native-naive | 12 | 2 | 3 | 3 | 0.46× | 0.44× | 2/2 |

## By task kind

| kind | strategy | tasks | found | median tok |
|---|---|---|---|---|
| locate | native-naive | 4 | 0 | 18,232 |
| locate | native-ranged | 4 | 1 | 7,702 |
| locate | kopt-pack | 4 | 3 | 1,315 |
| locate | kopt-hits+read | 4 | 1 | 2,776 |
| locate | kirograph | 4 | 0 | 909 |
| locate | codegraph | 4 | 2 | 7,799 |
| explain | native-naive | 3 | 3 | 14,336 |
| explain | native-ranged | 3 | 2 | 7,801 |
| explain | kopt-pack | 3 | 2 | 1,378 |
| explain | kopt-hits+read | 3 | 1 | 1,129 |
| explain | kirograph | 3 | 0 | 952 |
| explain | codegraph | 3 | 1 | 8,326 |
| usage | native-naive | 3 | 1 | 13,026 |
| usage | native-ranged | 3 | 1 | 5,027 |
| usage | kopt-pack | 3 | 3 | 730 |
| usage | kopt-hits+read | 3 | 0 | 461 |
| usage | kirograph | 3 | 0 | 861 |
| usage | codegraph | 3 | 3 | 8,316 |
| impact | native-naive | 2 | 1 | 17,275 |
| impact | native-ranged | 2 | 1 | 6,239 |
| impact | kopt-pack | 2 | 2 | 1,025 |
| impact | kopt-hits+read | 2 | 0 | 1,533 |
| impact | kirograph | 2 | 0 | 189 |
| impact | codegraph | 2 | 2 | 8,306 |

## Per task (tokens, found)

| task | kind | native-naive | native-ranged | kopt-pack | kopt-hits+read | kirograph | codegraph |
|---|---|---|---|---|---|---|---|
| jf-locate-lockout | locate | 26,362 NO (miss UserLockedOutEventArgs.cs) | 9,261 NO (miss UserLockedOutEventArgs.cs) | 1,441 NO (miss UserManager.cs, UserLockedOutEventArgs.cs, AuthenticateUser, UserLockedOutEventArgs) | 4,540 NO (miss UserManager.cs, UserLockedOutEventArgs.cs, AuthenticateUser, UserLockedOutEventArgs) | 868 NO (miss UserManager.cs, UserLockedOutEventArgs.cs, AuthenticateUser, UserLockedOutEventArgs) | 6,840 NO (miss AuthenticateUser) |
| jf-locate-auth-header | locate | 69,370 NO (miss GetAuthorizationDictionary, GetAuthorization, GetParts) | 8,871 NO (miss GetAuthorizationDictionary, GetAuthorization, GetParts) | 1,298 OK | 1,349 NO (miss GetAuthorizationDictionary, GetParts) | 949 NO (miss GetAuthorizationDictionary, GetAuthorization, GetParts) | 8,316 NO (miss AuthorizationContext.cs, GetAuthorizationDictionary, GetAuthorization, GetParts) |
| jf-locate-password-migration | locate | 10,102 NO (miss Authenticate) | 6,532 NO (miss Authenticate) | 1,332 OK | 1,271 NO (miss DefaultAuthenticationProvider.cs, Authenticate) | 235 NO (miss DefaultAuthenticationProvider.cs, CryptographyProvider.cs, Authenticate, Verify) | 7,281 OK |
| jf-locate-media-segments | locate | 4,551 NO (miss GetProviderId) | 5,391 OK | 1,250 OK | 4,203 OK | 1,198 NO (miss RunSegmentPluginProviders) | 8,320 OK |
| jf-explain-quick-connect | explain | 11,452 OK | 6,798 OK | 1,378 OK | 1,119 OK | 952 NO (miss QuickConnectManager.cs, TryConnect, CheckRequestStatus, AuthorizeRequest, +1) | 8,318 OK |
| jf-explain-trickplay | explain | 14,336 OK | 8,468 NO (miss RefreshTrickplayDataAsync, CanGenerateTrickplay) | 1,443 OK | 1,129 NO (miss RefreshTrickplayDataAsync, RefreshTrickplayDataInternal) | 1,245 NO (miss RefreshTrickplayDataAsync, RefreshTrickplayDataInternal, CreateTiles, CanGenerateTrickplay) | 8,326 NO (miss RefreshTrickplayDataInternal, CreateTiles) |
| jf-explain-syncplay-wait | explain | 23,693 OK | 7,801 OK | 1,299 NO (miss Group.cs, SetBuffering) | 2,087 NO (miss Group.cs, SetBuffering, IsBuffering) | 286 NO (miss WaitingGroupState.cs, Group.cs, WaitingGroupState, HandleRequest, +2) | 8,330 NO (miss SetBuffering, IsBuffering) |
| jf-usage-refresh-trickplay | usage | 13,026 NO (miss ExecuteAsync) | 5,027 OK | 730 OK | 1,605 NO (miss TrickplayImagesTask.cs, TrickplayProvider.cs, ExecuteAsync, FetchInternal) | 861 NO (miss TrickplayImagesTask.cs, TrickplayProvider.cs, ExecuteAsync, FetchInternal) | 8,316 OK |
| jf-usage-authorization-info | usage | 5,295 NO (miss InitiateQuickConnect, AuthenticateUserByName) | 4,124 NO (miss AuthenticateUserByName) | 748 OK | 461 NO (miss AuthService.cs, QuickConnectController.cs, UserController.cs, Authenticate, +2) | 1,259 NO (miss AuthService.cs, QuickConnectController.cs, UserController.cs, AuthorizationContext.cs, +4) | 8,332 OK |
| jf-usage-create-backup | usage | 18,684 OK | 6,441 NO (miss PrepareSystemForMigration) | 716 OK | 433 NO (miss JellyfinMigrationService.cs, CreateBackup, PrepareSystemForMigration) | 81 NO (miss BackupController.cs, JellyfinMigrationService.cs, CreateBackup, PrepareSystemForMigration) | 7,471 OK |
| jf-impact-trickplay-resolutions | impact | 24,149 OK | 6,623 NO (miss GetMasterPlaylistInternal) | 733 OK | 708 NO (miss DynamicHlsHelper.cs, MoveGeneratedTrickplayDataAsync, GetMasterPlaylistInternal) | 141 NO (miss TrickplayManager.cs, DynamicHlsHelper.cs, MoveGeneratedTrickplayDataAsync, GetTrickplayTilePathAsync, +2) | 8,305 OK |
| jf-impact-dot-ignore | impact | 10,400 NO (miss ReportFileSystemChanged, FindExtras) | 5,854 OK | 1,317 OK | 2,357 NO (miss LibraryMonitor.cs, LibraryManager.cs, ReportFileSystemChanged, FindExtras) | 236 NO (miss LibraryMonitor.cs, LibraryManager.cs, ShouldIgnore, ReportFileSystemChanged, +1) | 8,306 OK |

## Settings

- grep_search emulation: 100 matches / 10,000 chars, lines cut at 250 chars; pattern = most selective keywords while the total stays under the match cap; files ordered by distinct keywords, non-test first, match count (generous to native).
- native-naive: top 3 files by visible match count, whole file capped at 2000 lines.
- native-ranged: ±60 lines around the best 4 matches (overlaps merged).
- kopt budgets: find 700, pack 2500, read 3000 tokens.
- index: reused, 1,922 files, 17,980 symbols.
- kirograph: outputs loaded from bench/competitors/results/kirograph-jellyfin.jsonl
- codegraph: outputs loaded from bench/competitors/results/codegraph-jellyfin.jsonl
- run duration: 3,257 ms.
