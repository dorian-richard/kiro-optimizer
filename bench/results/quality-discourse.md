# kopt bench quality: discourse

Primary language `ruby` · commit `343b20f97ef5` · 15,517 files indexed, 5 skipped (large 1, minified 4) · index built in 10,398 ms · 2026-10-09T22:39:01.851Z

## Per language

| lang | files | KLOC | symbols/KLOC | refs resolved | resolved of in-repo names | files with parse errors | parse errors/KLOC | precision sample |
|---|---|---|---|---|---|---|---|---|
| ruby | 12,033 | 1399.6 | 44.0 | 21.3% | 28.0% | 0.0% (0/1000) | 0.00 | 100.0% (30/30) |
| javascript | 3,325 | 411.5 | 45.4 | 30.3% | 42.0% | 0.0% (0/1000) | 0.00 | 100.0% (30/30) |
| typescript | 159 | 34.4 | 72.7 | 46.5% | 62.5% | 0.0% (0/159) | 0.00 | 100.0% (30/30) |

`refs resolved` counts every reference, library calls included. `resolved of in-repo names` only counts references
whose name is defined somewhere in the repo, i.e. where an in-repo target is plausible.

## ruby

Symbols by kind (count, per KLOC): method 40,782 (29.14), class 7,769 (5.55), module 5,953 (4.25), constant 4,896 (3.5), function 2,118 (1.51).

Refs by kind (resolved/total): call 74,837/376,459 (19.9%), new 6,517/10,603 (61.5%), inherit 2,706/6,966 (38.8%).

Parse sample: 1000 files, 118,932 lines, 0 ERROR + 0 MISSING nodes.

Precision sample: 30 symbols · name on header 30/30 · start 30/30 · end 30/30 · signature 30/30 · all 30/30.

## javascript

Symbols by kind (count, per KLOC): method 5,633 (13.69), field 3,900 (9.48), function 3,393 (8.25), property 2,678 (6.51), class 1,512 (3.67), constant 1,293 (3.14), constructor 268 (0.65).

Refs by kind (resolved/total): call 13,949/52,373 (26.6%), read 9,391/29,055 (32.3%), import 5,273/14,322 (36.8%), write 2,422/6,351 (38.1%), new 331/1,631 (20.3%), inherit 449/1,268 (35.4%).

Parse sample: 1000 files, 128,689 lines, 0 ERROR + 0 MISSING nodes.

Precision sample: 30 symbols · name on header 30/30 · start 30/30 · end 30/30 · signature 30/30 · all 30/30.

## typescript

Symbols by kind (count, per KLOC): property 930 (27.01), method 476 (13.83), function 331 (9.61), field 251 (7.29), interface 211 (6.13), type 112 (3.25), constant 98 (2.85), class 56 (1.63), constructor 36 (1.05), namespace 2 (0.06).

Refs by kind (resolved/total): call 936/2,999 (31.2%), read 1,026/1,979 (51.8%), type_ref 942/1,743 (54.0%), import 595/1,064 (55.9%), write 316/369 (85.6%), new 37/153 (24.2%), inherit 30/54 (55.6%), implement 6/6 (100.0%).

Parse sample: 159 files, 34,585 lines, 0 ERROR + 0 MISSING nodes.

Precision sample: 30 symbols · name on header 30/30 · start 30/30 · end 30/30 · signature 30/30 · all 30/30.

## Method

- Parse errors: up to 1000 indexed files per language, re-parsed with the indexer's web-tree-sitter grammar (JavaScript uses the TSX grammar, like the indexer); outermost ERROR nodes and MISSING nodes are counted.
- Precision: 30 random symbols per language (seed `discourse`). Checks: (a) the name is a whole identifier on the header lines (range start to 3 lines past the declaration line, after comments and annotations); (b) the first line is a comment, an annotation or a declaration-looking line, and the range ends at a plausible block end (balanced brackets outside strings/comments, closing brace or aligned `end`, nothing indented or chained after it); (c) the identifiers of the stored signature appear in order in the source of the range.
- These are heuristics. A failed sample is a pointer to inspect, not proof of an extraction bug.
- Duration: 2,671 ms.
