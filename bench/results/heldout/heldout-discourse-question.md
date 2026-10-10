# kopt bench: heldout-discourse-question

Repo `discourse` @ `v2026.9.0` (`343b20f97ef5`) · 2 tasks · input = `question` · 3 chars/token · 2026-10-09T20:18:01.185Z

> Offline proxy: tokens = estimated tokens of tool outputs returned to the model for ONE exploration step.
> It is not a credit measurement. Savings must be confirmed by the online A/B (bench/ab) before being claimed.

Skipped strategies: kirograph, codegraph — no kirograph result line for this task; no codegraph result line for this task

## Summary per strategy

| strategy | tasks | found | file recall | symbol recall | def recall | median tok | mean tok | p90 tok | tok / found task | calls |
|---|---|---|---|---|---|---|---|---|---|---|
| native-naive | 2 | 0 (0%) | 0% | 0% | 0% | 30,674 | 30,674 | 35,452 | n/a | 4.0 |
| native-ranged | 2 | 0 (0%) | 0% | 0% | 0% | 9,264 | 9,264 | 11,591 | n/a | 5.0 |
| kopt-pack | 2 | 1 (50%) | 100% | 75% | 50% | 1,363 | 1,363 | 1,394 | 2,726 | 1.0 |
| kopt-hits+read | 2 | 1 (50%) | 100% | 50% | 50% | 1,751 | 1,751 | 2,524 | 3,502 | 3.0 |

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
| locate | native-naive | 1 | 0 | 25,895 |
| locate | native-ranged | 1 | 0 | 11,591 |
| locate | kopt-pack | 1 | 0 | 1,332 |
| locate | kopt-hits+read | 1 | 0 | 978 |
| explain | native-naive | 1 | 0 | 35,452 |
| explain | native-ranged | 1 | 0 | 6,936 |
| explain | kopt-pack | 1 | 1 | 1,394 |
| explain | kopt-hits+read | 1 | 1 | 2,524 |

## Per task (tokens, found)

| task | kind | native-naive | native-ranged | kopt-pack | kopt-hits+read | kirograph | codegraph |
|---|---|---|---|---|---|---|---|
| ho-ds-explain-tl2-promotion | explain | 35,452 NO (miss promotion.rb, review_tl1, tl2_met?) | 6,936 NO (miss promotion.rb, review_tl1, tl2_met?) | 1,394 OK | 2,524 OK | skipped | skipped |
| ho-ds-locate-email-related-post | locate | 25,895 NO (miss receiver.rb, find_related_post, extract_reply_message_ids) | 11,591 NO (miss receiver.rb, find_related_post, extract_reply_message_ids) | 1,332 NO (miss extract_reply_message_ids) | 978 NO (miss find_related_post, extract_reply_message_ids) | skipped | skipped |

## Settings

- grep_search emulation: 100 matches / 10,000 chars, lines cut at 250 chars; pattern = most selective keywords while the total stays under the match cap; files ordered by distinct keywords, non-test first, match count (generous to native).
- native-naive: top 3 files by visible match count, whole file capped at 2000 lines.
- native-ranged: ±60 lines around the best 4 matches (overlaps merged).
- kopt budgets: find 700, pack 2500, read 3000 tokens.
- index: reused, 15,517 files, 82,698 symbols.
- kirograph: outputs loaded from bench/competitors/results/kirograph-discourse.jsonl
- codegraph: outputs loaded from bench/competitors/results/codegraph-discourse.jsonl
- run duration: 6,247 ms.
