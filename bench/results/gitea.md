# kopt bench: gitea

Repo `gitea` @ `v28.1.0` (`4ebd5e319b6a`) · 12 tasks · input = `search` · 3 chars/token · 2026-10-09T22:38:13.230Z

> Offline proxy: tokens = estimated tokens of tool outputs returned to the model for ONE exploration step.
> It is not a credit measurement. Savings must be confirmed by the online A/B (bench/ab) before being claimed.

## Summary per strategy

| strategy | tasks | found | file recall | symbol recall | def recall | median tok | mean tok | p90 tok | tok / found task | calls |
|---|---|---|---|---|---|---|---|---|---|---|
| native-naive | 12 | 4 (33%) | 73% | 64% | 54% | 14,142 | 45,777 | 42,955 | 137,331 | 3.8 |
| native-ranged | 12 | 3 (25%) | 73% | 64% | 54% | 6,266 | 7,640 | 7,746 | 30,561 | 4.3 |
| kopt-pack | 12 | 11 (92%) | 100% | 96% | 53% | 1,132 | 1,096 | 1,598 | 1,196 | 1.0 |
| kopt-hits+read | 12 | 5 (42%) | 66% | 67% | 48% | 752 | 878 | 1,645 | 2,107 | 3.0 |
| kirograph | 12 | 0 (0%) | 8% | 9% | 0% | 482 | 611 | 1,109 | n/a | 1.0 |
| codegraph | 12 | 6 (50%) | 80% | 69% | 31% | 8,257 | 7,631 | 8,328 | 15,262 | 1.0 |

`found` = every gold file path AND every gold symbol name appears in the output. `def recall` = the definition line
of the gold symbol was shown (stricter). `tok / found task` = all tokens spent (failures included) / tasks found.

## Pass-gated pairs (only tasks found by both)

| b vs a | tasks run | found by both | only a | only b | median b/a | geomean b/a | b cheaper |
|---|---|---|---|---|---|---|---|
| kopt-pack vs native-naive | 12 | 4 | 0 | 7 | 0.04× | 0.06× | 3/4 |
| kopt-pack vs native-ranged | 12 | 3 | 0 | 8 | 0.27× | 0.37× | 2/3 |
| kopt-hits+read vs native-naive | 12 | 2 | 2 | 3 | 0.43× | 0.21× | 2/2 |
| kopt-hits+read vs native-ranged | 12 | 2 | 1 | 3 | 0.60× | 0.48× | 2/2 |
| kopt-pack vs kirograph | 12 | 0 | 0 | 11 | n/a | n/a | 0/0 |
| kopt-pack vs codegraph | 12 | 6 | 0 | 5 | 0.12× | 0.12× | 6/6 |
| kopt-hits+read vs kirograph | 12 | 0 | 0 | 5 | n/a | n/a | 0/0 |
| kopt-hits+read vs codegraph | 12 | 3 | 3 | 2 | 0.19× | 0.15× | 3/3 |
| kirograph vs native-ranged | 12 | 0 | 3 | 0 | n/a | n/a | 0/0 |
| codegraph vs native-ranged | 12 | 2 | 1 | 4 | 1.51× | 1.46× | 0/2 |
| native-ranged vs native-naive | 12 | 2 | 2 | 1 | 0.54× | 0.45× | 2/2 |

## By task kind

| kind | strategy | tasks | found | median tok |
|---|---|---|---|---|
| locate | native-naive | 4 | 2 | 12,209 |
| locate | native-ranged | 4 | 2 | 6,626 |
| locate | kopt-pack | 4 | 4 | 1,487 |
| locate | kopt-hits+read | 4 | 3 | 1,370 |
| locate | kirograph | 4 | 0 | 540 |
| locate | codegraph | 4 | 2 | 8,264 |
| explain | native-naive | 3 | 0 | 42,955 |
| explain | native-ranged | 3 | 0 | 6,448 |
| explain | kopt-pack | 3 | 2 | 1,307 |
| explain | kopt-hits+read | 3 | 2 | 741 |
| explain | kirograph | 3 | 0 | 371 |
| explain | codegraph | 3 | 1 | 6,255 |
| usage | native-naive | 3 | 1 | 12,324 |
| usage | native-ranged | 3 | 1 | 6,140 |
| usage | kopt-pack | 3 | 3 | 679 |
| usage | kopt-hits+read | 3 | 0 | 453 |
| usage | kirograph | 3 | 0 | 466 |
| usage | codegraph | 3 | 2 | 8,303 |
| impact | native-naive | 2 | 1 | 20,314 |
| impact | native-ranged | 2 | 0 | 3,960 |
| impact | kopt-pack | 2 | 2 | 682 |
| impact | kopt-hits+read | 2 | 0 | 688 |
| impact | kirograph | 2 | 0 | 623 |
| impact | codegraph | 2 | 1 | 8,320 |

## Per task (tokens, found)

| task | kind | native-naive | native-ranged | kopt-pack | kopt-hits+read | kirograph | codegraph |
|---|---|---|---|---|---|---|---|
| gt-locate-git-proxy | locate | 1,357 OK | 1,143 OK | 1,375 OK | 1,095 OK | 507 NO (miss policies.go, gitProxySelector, normalizeGitProxy) | 8,318 NO (miss normalizeGitProxy) |
| gt-locate-runner-pick | locate | 15,959 NO (miss task.go, runner.go, CreateTaskForRunner, claimJobForRunner, +1) | 7,746 NO (miss task.go, runner.go, CreateTaskForRunner, claimJobForRunner, +1) | 1,598 OK | 2,131 NO (miss runner.go) | 1,820 NO (miss CreateTaskForRunner, claimJobForRunner, CanMatchLabels) | 8,324 NO (miss task.go, runner.go, CreateTaskForRunner, claimJobForRunner, +1) |
| gt-locate-protected-branch | locate | 29,246 OK | 6,975 OK | 1,870 OK | 1,645 OK | 572 NO (miss protected_branch.go, protected_branch_list.go, loadGlob, GetFirstMatched) | 7,944 OK |
| gt-locate-audit-origin | locate | 8,458 NO (miss audit.go, AuditOrigin) | 6,277 NO (miss audit.go, getOrigin, getIPAddress, AuditOrigin) | 1,371 OK | 763 OK | 368 NO (miss event.go, audit.go, getOrigin, getIPAddress, +2) | 8,210 OK |
| gt-explain-egress | explain | 42,955 NO (miss policy.go, checkAddr, gate, allowCheck, +1) | 6,448 NO (miss policy.go, checkAddr, gate, allowCheck, +1) | 956 NO (miss checkAddr, dialContext) | 738 NO (miss checkAddr, dialContext) | 1,034 NO (miss policy.go, checkAddr, gate, allowCheck, +1) | 7,118 NO (miss checkAddr, gate, dialContext) |
| gt-explain-audit | explain | 5,898 NO (miss message.go, buildEvent, renderMessage) | 6,256 NO (miss message.go, buildEvent, renderMessage) | 1,423 OK | 906 OK | 371 NO (miss event.go, message.go, Record, RecordAs, +2) | 6,255 NO (miss message.go, Record, RecordAs, renderMessage) |
| gt-explain-globallock | explain | 358,497 NO (miss startExtend) | 32,075 NO (miss startExtend) | 1,307 OK | 741 OK | 366 NO (miss redis_locker.go, globallock.go, startExtend, NewRedisLocker, +1) | 3,925 OK |
| gt-usage-egress-transport | usage | 12,324 NO (miss openIDInstance, oauth2AvatarHTTPClient, NewMigrationHTTPTransport, Init) | 6,276 NO (miss newServer) | 889 OK | 453 NO (miss openid.go, oauth.go, server.go, deliver.go, +4) | 85 NO (miss openid.go, oauth.go, server.go, http_client.go, +6) | 8,203 NO (miss openid.go, openIDInstance) |
| gt-usage-automerge-check | usage | 4,591 NO (miss markPullRequestAsMergeable) | 4,429 OK | 679 OK | 485 NO (miss automerge.go, notify.go, check.go, populateRecentAutoMergeItems, +4) | 498 NO (miss automerge.go, notify.go, check.go, populateRecentAutoMergeItems, +5) | 8,330 OK |
| gt-usage-pull-working-lock | usage | 29,411 OK | 6,140 NO (miss ChangeTargetBranch) | 322 OK | 201 NO (miss check.go, merge.go, update.go, StartPullRequestCheckOnView, +5) | 466 NO (miss check.go, merge.go, pull.go, update.go, +6) | 8,303 OK |
| gt-impact-remove-scheduled-automerge | impact | 37,254 OK | 4,113 NO (miss CancelScheduledAutoMerge) | 681 OK | 986 NO (miss pull.go, CancelAutoMergePullRequest) | 137 NO (miss automerge.go, pull.go, pull.go, CancelScheduledAutoMerge, +1) | 8,311 OK |
| gt-impact-migration-policy | impact | 3,373 NO (miss server.go, IsMigrateURLAllowed, Run) | 3,806 NO (miss server.go, Run) | 683 OK | 389 NO (miss migrate.go, http_client.go, server.go, IsMigrateURLAllowed, +2) | 1,109 NO (miss policies.go, migrate.go, http_client.go, server.go, +5) | 8,328 NO (miss migrate.go, http_client.go, server.go, IsMigrateURLAllowed, +2) |

## Settings

- grep_search emulation: 100 matches / 10,000 chars, lines cut at 250 chars; pattern = most selective keywords while the total stays under the match cap; files ordered by distinct keywords, non-test first, match count (generous to native).
- native-naive: top 3 files by visible match count, whole file capped at 2000 lines.
- native-ranged: ±60 lines around the best 4 matches (overlaps merged).
- kopt budgets: find 700, pack 2500, read 3000 tokens.
- index: reused, 3,402 files, 32,905 symbols.
- kirograph: outputs loaded from bench/competitors/results/kirograph-gitea.jsonl
- codegraph: outputs loaded from bench/competitors/results/codegraph-gitea.jsonl
- run duration: 9,078 ms.
