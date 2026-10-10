# kopt bench quality: webpack

Primary language `javascript` · commit `5a106753839f` · 14,902 files indexed, 50 skipped (binary 9, minified 41) · index built in 4,951 ms · 2026-10-09T22:37:27.043Z

## Per language

| lang | files | KLOC | symbols/KLOC | refs resolved | resolved of in-repo names | files with parse errors | parse errors/KLOC | precision sample |
|---|---|---|---|---|---|---|---|---|
| javascript | 14,792 | 564.7 | 27.2 | 20.3% | 32.0% | 1.9% (19/1000) | 1.18 | 100.0% (30/30) |
| typescript | 109 | 34.1 | 211.0 | 61.1% | 94.2% | 0.9% (1/109) | 0.09 | 100.0% (30/30) |
| tsx | 1 | 0.0 | 0.0 | 0.0% | 0.0% | n/a | n/a | n/a |

`refs resolved` counts every reference, library calls included. `resolved of in-repo names` only counts references
whose name is defined somewhere in the repo, i.e. where an in-repo target is plausible.

## javascript

Symbols by kind (count, per KLOC): function 5,592 (9.9), constant 3,940 (6.98), method 3,571 (6.32), class 1,135 (2.01), constructor 738 (1.31), property 309 (0.55), field 91 (0.16).

Refs by kind (resolved/total): call 14,860/72,610 (20.5%), read 2,915/28,813 (10.1%), import 3,601/8,102 (44.4%), write 1,436/7,256 (19.8%), new 1,656/5,186 (31.9%), inherit 350/417 (83.9%).

Parse sample: 1000 files, 32,331 lines, 37 ERROR + 1 MISSING nodes. Worst: `test/hotCases/worker/remove-add-worker/compute.js:3` (7), `test/hotCases/numeric-ids/add-remove-chunks/module.js:3` (4), `test/hotCases/runtime/dispose-removed-module/module.js:3` (4), `test/hotCases/concat/reload-external/a.js:3` (3), `test/hotCases/concat/reload-external/b.js:3` (3).

Precision sample: 30 symbols · name on header 30/30 · start 30/30 · end 30/30 · signature 30/30 · all 30/30.

## typescript

Symbols by kind (count, per KLOC): property 3,136 (91.91), method 1,581 (46.34), field 897 (26.29), interface 578 (16.94), constant 356 (10.43), type 273 (8), class 251 (7.36), namespace 63 (1.85), function 61 (1.79), enum 2 (0.06), constructor 1 (0.03).

Refs by kind (resolved/total): type_ref 3,897/6,134 (63.5%), call 25/176 (14.2%), import 11/160 (6.9%), inherit 80/85 (94.1%), read 6/24 (25.0%), new 1/1 (100.0%).

Parse sample: 109 files, 34,229 lines, 1 ERROR + 2 MISSING nodes. Worst: `declarations.d.ts:208` (3).

Precision sample: 30 symbols · name on header 30/30 · start 30/30 · end 30/30 · signature 30/30 · all 30/30.

## tsx

Symbols by kind (count, per KLOC): none.

Refs by kind (resolved/total): call 0/4 (0.0%), import 0/1 (0.0%).

## Method

- Parse errors: up to 1000 indexed files per language, re-parsed with the indexer's web-tree-sitter grammar (JavaScript uses the TSX grammar, like the indexer); outermost ERROR nodes and MISSING nodes are counted.
- Precision: 30 random symbols per language (seed `webpack`). Checks: (a) the name is a whole identifier on the header lines (range start to 3 lines past the declaration line, after comments and annotations); (b) the first line is a comment, an annotation or a declaration-looking line, and the range ends at a plausible block end (balanced brackets outside strings/comments, closing brace or aligned `end`, nothing indented or chained after it); (c) the identifiers of the stored signature appear in order in the source of the range.
- These are heuristics. A failed sample is a pointer to inspect, not proof of an extraction bug.
- Duration: 1,760 ms.
