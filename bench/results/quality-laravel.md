# kopt bench quality: laravel

Primary language `php` · commit `a413a9da9488` · 3,114 files indexed, 2 skipped (minified 2) · index built in 4,359 ms · 2026-10-09T22:38:42.477Z

## Per language

| lang | files | KLOC | symbols/KLOC | refs resolved | resolved of in-repo names | files with parse errors | parse errors/KLOC | precision sample |
|---|---|---|---|---|---|---|---|---|
| php | 3,111 | 574.3 | 71.3 | 55.5% | 71.7% | 0.3% (3/1000) | 0.02 | 100.0% (30/30) |
| javascript | 3 | 0.1 | 0.0 | 0.0% | 0.0% | n/a | n/a | n/a |

`refs resolved` counts every reference, library calls included. `resolved of in-repo names` only counts references
whose name is defined somewhere in the repo, i.e. where an in-repo target is plausible.

## php

Symbols by kind (count, per KLOC): method 30,497 (53.1), field 4,660 (8.11), class 4,120 (7.17), constructor 935 (1.63), trait 215 (0.37), interface 214 (0.37), enum 134 (0.23), function 130 (0.23), constant 74 (0.13).

Refs by kind (resolved/total): call 58,688/127,871 (45.9%), read 11,932/16,163 (73.8%), new 11,266/14,133 (79.7%), import 9,268/13,957 (66.4%), type_ref 8,957/11,937 (75.0%), write 3,592/4,373 (82.1%), inherit 2,804/3,868 (72.5%), implement 591/835 (70.8%).

Parse sample: 1000 files, 186,785 lines, 3 ERROR + 0 MISSING nodes. Worst: `tests/Foundation/Fixtures/bad-syntax-strategy.php:3` (1), `tests/Http/Fixtures/Enums.php:13` (1), `tests/Notifications/NotificationChannelManagerTest.php:754` (1).

Precision sample: 30 symbols · name on header 30/30 · start 30/30 · end 30/30 · signature 30/30 · all 30/30.

## javascript

Symbols by kind (count, per KLOC): none.

Refs by kind (resolved/total): call 0/16 (0.0%), import 0/11 (0.0%), write 0/7 (0.0%), read 0/2 (0.0%), new 0/1 (0.0%).

## Method

- Parse errors: up to 1000 indexed files per language, re-parsed with the indexer's web-tree-sitter grammar (JavaScript uses the TSX grammar, like the indexer); outermost ERROR nodes and MISSING nodes are counted.
- Precision: 30 random symbols per language (seed `laravel`). Checks: (a) the name is a whole identifier on the header lines (range start to 3 lines past the declaration line, after comments and annotations); (b) the first line is a comment, an annotation or a declaration-looking line, and the range ends at a plausible block end (balanced brackets outside strings/comments, closing brace or aligned `end`, nothing indented or chained after it); (c) the identifiers of the stored signature appear in order in the source of the range.
- These are heuristics. A failed sample is a pointer to inspect, not proof of an extraction bug.
- Duration: 1,297 ms.
