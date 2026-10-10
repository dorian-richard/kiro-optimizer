# kopt bench quality: playframework

Primary language `scala` · commit `316f494b2d12` · 1,427 files indexed, 0 skipped · index built in 2,237 ms · 2026-10-09T22:39:45.443Z

## Per language

| lang | files | KLOC | symbols/KLOC | refs resolved | resolved of in-repo names | files with parse errors | parse errors/KLOC | precision sample |
|---|---|---|---|---|---|---|---|---|
| scala | 801 | 114.0 | 105.7 | 38.3% | 57.5% | 0.0% (0/801) | 0.00 | 100.0% (30/30) |
| java | 619 | 61.2 | 106.8 | 49.6% | 73.8% | 0.0% (0/619) | 0.00 | 100.0% (30/30) |
| javascript | 7 | 0.3 | 0.0 | 5.4% | 8.8% | n/a | n/a | n/a |

`refs resolved` counts every reference, library calls included. `resolved of in-repo names` only counts references
whose name is defined somewhere in the repo, i.e. where an in-repo target is plausible.

## scala

Symbols by kind (count, per KLOC): method 5,142 (45.09), property 4,251 (37.27), class 2,068 (18.13), trait 348 (3.05), constant 194 (1.7), function 51 (0.45).

Refs by kind (resolved/total): call 6,204/17,221 (36.0%), read 2,602/11,777 (22.1%), type_ref 5,293/11,655 (45.4%), new 2,825/5,495 (51.4%), import 2,235/5,392 (41.5%), inherit 873/1,324 (65.9%), implement 430/569 (75.6%), write 18/28 (64.3%).

Parse sample: 801 files, 114,850 lines, 0 ERROR + 0 MISSING nodes.

Precision sample: 30 symbols · name on header 30/30 · start 30/30 · end 30/30 · signature 30/30 · all 30/30.

## java

Symbols by kind (count, per KLOC): method 3,990 (65.16), class 800 (13.07), field 764 (12.48), constructor 505 (8.25), constant 289 (4.72), interface 186 (3.04), enum 4 (0.07).

Refs by kind (resolved/total): call 5,912/11,843 (49.9%), type_ref 4,263/9,449 (45.1%), import 1,252/3,238 (38.7%), new 890/1,409 (63.2%), read 562/1,055 (53.3%), write 601/604 (99.5%), inherit 380/439 (86.6%), implement 144/193 (74.6%).

Parse sample: 619 files, 61,843 lines, 0 ERROR + 0 MISSING nodes.

Precision sample: 30 symbols · name on header 30/30 · start 30/30 · end 30/30 · signature 30/30 · all 30/30.

## javascript

Symbols by kind (count, per KLOC): none.

Refs by kind (resolved/total): call 6/88 (6.8%), read 0/24 (0.0%).

## Method

- Parse errors: up to 1000 indexed files per language, re-parsed with the indexer's web-tree-sitter grammar (JavaScript uses the TSX grammar, like the indexer); outermost ERROR nodes and MISSING nodes are counted.
- Precision: 30 random symbols per language (seed `playframework`). Checks: (a) the name is a whole identifier on the header lines (range start to 3 lines past the declaration line, after comments and annotations); (b) the first line is a comment, an annotation or a declaration-looking line, and the range ends at a plausible block end (balanced brackets outside strings/comments, closing brace or aligned `end`, nothing indented or chained after it); (c) the identifiers of the stored signature appear in order in the source of the range.
- These are heuristics. A failed sample is a pointer to inspect, not proof of an extraction bug.
- Duration: 1,528 ms.
