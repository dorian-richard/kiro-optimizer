# kopt bench: discourse

Repo `discourse` @ `v2026.9.0` (`343b20f97ef5`) · 12 tasks · input = `search` · 3 chars/token · 2026-10-09T22:39:41.284Z

> Offline proxy: tokens = estimated tokens of tool outputs returned to the model for ONE exploration step.
> It is not a credit measurement. Savings must be confirmed by the online A/B (bench/ab) before being claimed.

## Summary per strategy

| strategy | tasks | found | file recall | symbol recall | def recall | median tok | mean tok | p90 tok | tok / found task | calls |
|---|---|---|---|---|---|---|---|---|---|---|
| native-naive | 12 | 3 (25%) | 67% | 48% | 41% | 22,658 | 27,226 | 45,865 | 108,903 | 3.8 |
| native-ranged | 12 | 6 (50%) | 63% | 60% | 52% | 5,988 | 7,422 | 10,705 | 14,844 | 4.8 |
| kopt-pack | 12 | 11 (92%) | 96% | 98% | 58% | 1,310 | 1,198 | 1,361 | 1,307 | 1.0 |
| kopt-hits+read | 12 | 7 (58%) | 81% | 78% | 67% | 1,166 | 1,190 | 1,668 | 2,040 | 3.0 |
| kirograph | 12 | 1 (8%) | 8% | 10% | 4% | 1,020 | 1,311 | 2,830 | 15,730 | 1.0 |
| codegraph | 12 | 8 (67%) | 75% | 71% | 48% | 7,954 | 7,651 | 8,328 | 11,477 | 1.0 |

`found` = every gold file path AND every gold symbol name appears in the output. `def recall` = the definition line
of the gold symbol was shown (stricter). `tok / found task` = all tokens spent (failures included) / tasks found.

## Pass-gated pairs (only tasks found by both)

| b vs a | tasks run | found by both | only a | only b | median b/a | geomean b/a | b cheaper |
|---|---|---|---|---|---|---|---|
| kopt-pack vs native-naive | 12 | 3 | 0 | 8 | 0.05× | 0.05× | 3/3 |
| kopt-pack vs native-ranged | 12 | 6 | 0 | 5 | 0.20× | 0.19× | 6/6 |
| kopt-hits+read vs native-naive | 12 | 2 | 1 | 5 | 0.07× | 0.05× | 2/2 |
| kopt-hits+read vs native-ranged | 12 | 2 | 4 | 5 | 0.17× | 0.15× | 2/2 |
| kopt-pack vs kirograph | 12 | 1 | 0 | 10 | 1.01× | 1.01× | 0/1 |
| kopt-pack vs codegraph | 12 | 7 | 1 | 4 | 0.17× | 0.17× | 7/7 |
| kopt-hits+read vs kirograph | 12 | 1 | 0 | 6 | 1.08× | 1.08× | 0/1 |
| kopt-hits+read vs codegraph | 12 | 5 | 3 | 2 | 0.19× | 0.18× | 5/5 |
| kirograph vs native-ranged | 12 | 0 | 6 | 1 | n/a | n/a | 0/0 |
| codegraph vs native-ranged | 12 | 3 | 3 | 5 | 1.46× | 1.10× | 1/3 |
| native-ranged vs native-naive | 12 | 3 | 0 | 3 | 0.23× | 0.27× | 3/3 |

## By task kind

| kind | strategy | tasks | found | median tok |
|---|---|---|---|---|
| locate | native-naive | 4 | 2 | 39,309 |
| locate | native-ranged | 4 | 2 | 8,575 |
| locate | kopt-pack | 4 | 4 | 1,309 |
| locate | kopt-hits+read | 4 | 4 | 1,151 |
| locate | kirograph | 4 | 1 | 1,115 |
| locate | codegraph | 4 | 2 | 7,697 |
| explain | native-naive | 3 | 0 | 12,760 |
| explain | native-ranged | 3 | 0 | 6,800 |
| explain | kopt-pack | 3 | 2 | 1,311 |
| explain | kopt-hits+read | 3 | 3 | 1,522 |
| explain | kirograph | 3 | 0 | 2,112 |
| explain | codegraph | 3 | 3 | 7,672 |
| usage | native-naive | 3 | 1 | 18,381 |
| usage | native-ranged | 3 | 3 | 4,650 |
| usage | kopt-pack | 3 | 3 | 879 |
| usage | kopt-hits+read | 3 | 0 | 769 |
| usage | kirograph | 3 | 0 | 1,049 |
| usage | codegraph | 3 | 1 | 7,459 |
| impact | native-naive | 2 | 0 | 21,304 |
| impact | native-ranged | 2 | 1 | 5,094 |
| impact | kopt-pack | 2 | 2 | 1,310 |
| impact | kopt-hits+read | 2 | 0 | 1,429 |
| impact | kirograph | 2 | 0 | 12 |
| impact | codegraph | 2 | 2 | 8,302 |

## Per task (tokens, found)

| task | kind | native-naive | native-ranged | kopt-pack | kopt-hits+read | kirograph | codegraph |
|---|---|---|---|---|---|---|---|
| ds-locate-mcp-pkce | locate | 14,175 OK | 6,644 OK | 1,361 OK | 1,668 OK | 453 NO (miss oauth.rb, exchange_code!, secure_compare_challenge) | 8,292 NO (miss secure_compare_challenge) |
| ds-locate-nested-hot-score | locate | 45,865 OK | 10,705 OK | 1,365 OK | 958 OK | 991 NO (miss hot_score_calculator.rb, score_for, hot_score_sql, formula_settings) | 6,497 OK |
| ds-locate-auto-silence | locate | 38,951 NO (miss auto_silence.rb, reviewable.rb, should_autosilence?, user_spam_stats, +1) | 10,506 NO (miss auto_silence.rb, reviewable.rb, should_autosilence?, user_spam_stats, +1) | 1,074 OK | 606 OK | 1,841 NO (miss auto_silence.rb, reviewable.rb, should_autosilence?, user_spam_stats, +1) | 8,328 NO (miss auto_silence.rb, reviewable.rb, should_autosilence?, user_spam_stats, +1) |
| ds-locate-login-code-verify | locate | 39,666 NO (miss email_login_code.rb, verify, hash_code) | 6,291 NO (miss email_login_code.rb, verify, hash_code) | 1,256 OK | 1,343 OK | 1,239 OK | 7,101 OK |
| ds-explain-mcp-refresh-rotation | explain | 12,760 NO (miss oauth.rb, mcp_oauth_refresh_token.rb, refresh!, issue!, +1) | 5,325 NO (miss oauth.rb, mcp_oauth_refresh_token.rb, refresh!, issue!, +1) | 1,256 OK | 911 OK | 2,112 NO (miss oauth.rb, mcp_oauth_refresh_token.rb, refresh!, issue!, +1) | 7,402 OK |
| ds-explain-upcoming-promotion | explain | 67,895 NO (miss notify_promotion.rb, admin_has_not_manually_toggled) | 18,538 NO (miss notify_promotion.rb, upcoming_changes.rb, promotion_not_already_handled, admin_has_not_manually_toggled, +2) | 1,325 NO (miss upcoming_changes.rb, meets_or_exceeds_status?) | 2,155 OK | 2,830 NO (miss notify_promotion.rb, upcoming_changes.rb, NotifyPromotion, promotion_not_already_handled, +3) | 8,332 OK |
| ds-explain-rate-limit-create | explain | 9,564 NO (miss rate_limiter.rb, rate_limit, default_rate_limiter, performed!) | 6,800 NO (miss rate_limiter.rb, rate_limit, default_rate_limiter, performed!) | 1,311 OK | 1,522 OK | 805 NO (miss on_create_record.rb, rate_limiter.rb, default_rate_limiter, performed!, +1) | 7,672 OK |
| ds-usage-disable-rate-limits | usage | 18,381 NO (miss save_topic) | 4,490 OK | 879 OK | 478 NO (miss post_mover.rb, move) | 12 NO (miss post_creator.rb, topic_creator.rb, post_mover.rb, save_post, +2) | 5,892 NO (miss post_creator.rb, topic_creator.rb, post_mover.rb, save_post, +2) |
| ds-usage-prevent-posting | usage | 9,909 NO (miss can_create_chat_message?) | 4,650 OK | 611 OK | 769 NO (miss post_guardian.rb, guardian_extensions.rb, can_create_post_in_topic?, can_create_chat_message?) | 4,374 NO (miss post_guardian.rb, guardian_extensions.rb, can_create_post_in_topic?, can_create_chat_message?) | 8,235 NO (miss post_guardian.rb, guardian_extensions.rb, can_create_post_in_topic?, can_create_chat_message?) |
| ds-usage-hot-score-fallback | usage | 26,935 OK | 4,930 OK | 1,319 OK | 1,011 NO (miss hot_score_values) | 1,049 NO (miss sort.rb, hot_score_expression, hot_score_values) | 7,459 OK |
| ds-impact-require-consent | impact | 8,597 NO (miss set_emergency_block!, require_fresh_consent_for_new_exposure!) | 5,685 OK | 1,308 OK | 1,538 NO (miss mcp_primitive_updater.rb, oauth.rb, set_emergency_block!, require_fresh_consent_for_new_exposure!, +1) | 12 NO (miss mcp_oauth_authorization.rb, mcp_primitive_updater.rb, oauth.rb, require_consent!, +3) | 8,309 OK |
| ds-impact-consume-login-code | impact | 34,011 NO (miss consume!, consume_code, consume_code, consume_code) | 4,502 NO (miss consume!) | 1,311 OK | 1,320 NO (miss create_password_reset_token.rb) | 12 NO (miss email_login_code.rb, redeem.rb, redeem_with_email_code.rb, create_password_reset_token.rb, +4) | 8,295 OK |

## Settings

- grep_search emulation: 100 matches / 10,000 chars, lines cut at 250 chars; pattern = most selective keywords while the total stays under the match cap; files ordered by distinct keywords, non-test first, match count (generous to native).
- native-naive: top 3 files by visible match count, whole file capped at 2000 lines.
- native-ranged: ±60 lines around the best 4 matches (overlaps merged).
- kopt budgets: find 700, pack 2500, read 3000 tokens.
- index: reused, 15,517 files, 82,698 symbols.
- kirograph: outputs loaded from bench/competitors/results/kirograph-discourse.jsonl
- codegraph: outputs loaded from bench/competitors/results/codegraph-discourse.jsonl
- run duration: 39,432 ms.
