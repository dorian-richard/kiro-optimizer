# kopt bench: heldout-jellyfin

Repo `jellyfin` @ `v10.11.11` (`1fbd8739292c`) · 2 tasks · input = `search` · 3 chars/token · 2026-10-09T20:18:10.327Z

> Offline proxy: tokens = estimated tokens of tool outputs returned to the model for ONE exploration step.
> It is not a credit measurement. Savings must be confirmed by the online A/B (bench/ab) before being claimed.

Skipped strategies: kirograph, codegraph — no kirograph result line for this task; no codegraph result line for this task

## Summary per strategy

| strategy | tasks | found | file recall | symbol recall | def recall | median tok | mean tok | p90 tok | tok / found task | calls |
|---|---|---|---|---|---|---|---|---|---|---|
| native-naive | 2 | 0 (0%) | 50% | 0% | 0% | 30,132 | 30,132 | 41,078 | n/a | 4.0 |
| native-ranged | 2 | 0 (0%) | 50% | 0% | 0% | 7,704 | 7,704 | 8,170 | n/a | 5.0 |
| kopt-pack | 2 | 2 (100%) | 100% | 100% | 100% | 1,357 | 1,357 | 1,398 | 1,357 | 1.0 |
| kopt-hits+read | 2 | 2 (100%) | 100% | 100% | 100% | 1,528 | 1,528 | 2,300 | 1,528 | 3.0 |

`found` = every gold file path AND every gold symbol name appears in the output. `def recall` = the definition line
of the gold symbol was shown (stricter). `tok / found task` = all tokens spent (failures included) / tasks found.

## Pass-gated pairs (only tasks found by both)

| b vs a | tasks run | found by both | only a | only b | median b/a | geomean b/a | b cheaper |
|---|---|---|---|---|---|---|---|
| kopt-pack vs native-naive | 2 | 0 | 0 | 2 | n/a | n/a | 0/0 |
| kopt-pack vs native-ranged | 2 | 0 | 0 | 2 | n/a | n/a | 0/0 |
| kopt-hits+read vs native-naive | 2 | 0 | 0 | 2 | n/a | n/a | 0/0 |
| kopt-hits+read vs native-ranged | 2 | 0 | 0 | 2 | n/a | n/a | 0/0 |
| native-ranged vs native-naive | 2 | 0 | 0 | 0 | n/a | n/a | 0/0 |

## By task kind

| kind | strategy | tasks | found | median tok |
|---|---|---|---|---|
| locate | native-naive | 1 | 0 | 19,186 |
| locate | native-ranged | 1 | 0 | 7,237 |
| locate | kopt-pack | 1 | 1 | 1,316 |
| locate | kopt-hits+read | 1 | 1 | 756 |
| explain | native-naive | 1 | 0 | 41,078 |
| explain | native-ranged | 1 | 0 | 8,170 |
| explain | kopt-pack | 1 | 1 | 1,398 |
| explain | kopt-hits+read | 1 | 1 | 2,300 |

## Per task (tokens, found)

| task | kind | native-naive | native-ranged | kopt-pack | kopt-hits+read | kirograph | codegraph |
|---|---|---|---|---|---|---|---|
| ho-jf-locate-remote-bitrate | locate | 19,186 NO (miss MediaInfoHelper.cs, GetMaxBitrate) | 7,237 NO (miss MediaInfoHelper.cs, GetMaxBitrate) | 1,316 OK | 756 OK | skipped | skipped |
| ho-jf-explain-stream-copy | explain | 41,078 NO (miss CanStreamCopyVideo) | 8,170 NO (miss CanStreamCopyVideo) | 1,398 OK | 2,300 OK | skipped | skipped |

## Settings

- grep_search emulation: 100 matches / 10,000 chars, lines cut at 250 chars; pattern = most selective keywords while the total stays under the match cap; files ordered by distinct keywords, non-test first, match count (generous to native).
- native-naive: top 3 files by visible match count, whole file capped at 2000 lines.
- native-ranged: ±60 lines around the best 4 matches (overlaps merged).
- kopt budgets: find 700, pack 2500, read 3000 tokens.
- index: reused, 1,922 files, 17,980 symbols.
- kirograph: outputs loaded from bench/competitors/results/kirograph-jellyfin.jsonl
- codegraph: outputs loaded from bench/competitors/results/codegraph-jellyfin.jsonl
- run duration: 863 ms.
