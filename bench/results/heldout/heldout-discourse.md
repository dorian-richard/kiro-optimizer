# kopt bench: heldout-discourse

Repo `discourse` @ `v2026.9.0` (`343b20f97ef5`) · 2 tasks · input = `search` · 3 chars/token · 2026-10-09T20:17:54.878Z

> Offline proxy: tokens = estimated tokens of tool outputs returned to the model for ONE exploration step.
> It is not a credit measurement. Savings must be confirmed by the online A/B (bench/ab) before being claimed.

Skipped strategies: kirograph, codegraph — no kirograph result line for this task; no codegraph result line for this task

## Summary per strategy

| strategy | tasks | found | file recall | symbol recall | def recall | median tok | mean tok | p90 tok | tok / found task | calls |
|---|---|---|---|---|---|---|---|---|---|---|
| native-naive | 2 | 0 (0%) | 0% | 0% | 0% | 9,582 | 9,582 | 12,934 | n/a | 3.0 |
| native-ranged | 2 | 0 (0%) | 0% | 0% | 0% | 6,183 | 6,183 | 6,279 | n/a | 2.5 |
| kopt-pack | 2 | 1 (50%) | 50% | 50% | 25% | 1,142 | 1,142 | 1,382 | 2,283 | 1.0 |
| kopt-hits+read | 2 | 1 (50%) | 50% | 50% | 50% | 1,432 | 1,432 | 2,324 | 2,864 | 3.0 |

`found` = every gold file path AND every gold symbol name appears in the output. `def recall` = the definition line
of the gold symbol was shown (stricter). `tok / found task` = all tokens spent (failures included) / tasks found.

## Pass-gated pairs (only tasks found by both)

| b vs a | tasks run | found by both | only a | only b | median b/a | geomean b/a | b cheaper |
|---|---|---|---|---|---|---|---|
| kopt-pack vs native-naive | 2 | 0 | 0 | 1 | n/a | n/a | 0/0 |
| kopt-pack vs native-ranged | 2 | 0 | 0 | 1 | n/a | n/a | 0/0 |
| kopt-hits+read vs native-naive | 2 | 0 | 0 | 1 | n/a | n/a | 0/0 |
| kopt-hits+read vs native-ranged | 2 | 0 | 0 | 1 | n/a | n/a | 0/0 |
| native-ranged vs native-naive | 2 | 0 | 0 | 0 | n/a | n/a | 0/0 |

## By task kind

| kind | strategy | tasks | found | median tok |
|---|---|---|---|---|
| locate | native-naive | 1 | 0 | 12,934 |
| locate | native-ranged | 1 | 0 | 6,279 |
| locate | kopt-pack | 1 | 1 | 1,382 |
| locate | kopt-hits+read | 1 | 1 | 2,324 |
| explain | native-naive | 1 | 0 | 6,229 |
| explain | native-ranged | 1 | 0 | 6,086 |
| explain | kopt-pack | 1 | 0 | 901 |
| explain | kopt-hits+read | 1 | 0 | 540 |

## Per task (tokens, found)

| task | kind | native-naive | native-ranged | kopt-pack | kopt-hits+read | kirograph | codegraph |
|---|---|---|---|---|---|---|---|
| ho-ds-explain-tl2-promotion | explain | 6,229 NO (miss promotion.rb, review_tl1, tl2_met?) | 6,086 NO (miss promotion.rb, review_tl1, tl2_met?) | 901 NO (miss promotion.rb, review_tl1, tl2_met?) | 540 NO (miss promotion.rb, review_tl1, tl2_met?) | skipped | skipped |
| ho-ds-locate-email-related-post | locate | 12,934 NO (miss receiver.rb, find_related_post, extract_reply_message_ids) | 6,279 NO (miss receiver.rb, find_related_post, extract_reply_message_ids) | 1,382 OK | 2,324 OK | skipped | skipped |

## Settings

- grep_search emulation: 100 matches / 10,000 chars, lines cut at 250 chars; pattern = most selective keywords while the total stays under the match cap; files ordered by distinct keywords, non-test first, match count (generous to native).
- native-naive: top 3 files by visible match count, whole file capped at 2000 lines.
- native-ranged: ±60 lines around the best 4 matches (overlaps merged).
- kopt budgets: find 700, pack 2500, read 3000 tokens.
- index: reused, 15,517 files, 82,698 symbols.
- kirograph: outputs loaded from bench/competitors/results/kirograph-discourse.jsonl
- codegraph: outputs loaded from bench/competitors/results/codegraph-discourse.jsonl
- run duration: 6,264 ms.
