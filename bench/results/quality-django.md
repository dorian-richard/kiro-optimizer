# kopt bench quality: django

Primary language `python` · commit `2212534bae39` · 2,964 files indexed, 0 skipped · index built in 6,778 ms · 2026-10-09T22:21:22.623Z

## Per language

| lang | files | KLOC | symbols/KLOC | refs resolved | resolved of in-repo names | files with parse errors | parse errors/KLOC | precision sample |
|---|---|---|---|---|---|---|---|---|
| python | 2,919 | 524.5 | 97.4 | 44.4% | 59.5% | 0.0% (0/1000) | 0.00 | 100.0% (30/30) |
| javascript | 45 | 5.9 | 14.3 | 5.8% | 17.3% | 4.4% (2/45) | 2.17 | 100.0% (30/30) |

`refs resolved` counts every reference, library calls included. `resolved of in-repo names` only counts references
whose name is defined somewhere in the repo, i.e. where an in-repo target is plausible.

## python

Symbols by kind (count, per KLOC): method 28,127 (53.62), field 9,596 (18.29), class 8,135 (15.51), constant 2,378 (4.53), function 1,970 (3.76), constructor 892 (1.7).

Refs by kind (resolved/total): call 44,660/113,680 (39.3%), read 14,722/60,205 (24.5%), new 20,607/24,138 (85.4%), import 14,236/17,663 (80.6%), inherit 7,181/7,561 (95.0%), write 839/6,959 (12.1%), type_ref 6/8 (75.0%).

Parse sample: 1000 files, 203,404 lines, 0 ERROR + 0 MISSING nodes.

Precision sample: 30 symbols · name on header 30/30 · start 30/30 · end 30/30 · signature 30/30 · all 30/30.

## javascript

Symbols by kind (count, per KLOC): function 39 (6.56), constant 22 (3.7), method 20 (3.36), class 2 (0.34), constructor 2 (0.34).

Refs by kind (resolved/total): call 85/990 (8.6%), read 0/334 (0.0%), write 0/204 (0.0%), new 3/37 (8.1%), import 4/12 (33.3%), inherit 0/1 (0.0%).

Parse sample: 45 files, 5,991 lines, 11 ERROR + 2 MISSING nodes. Worst: `django/views/templates/i18n_catalog.js:1` (12), `tests/i18n/commands/javascript.js:23` (1).

Precision sample: 30 symbols · name on header 30/30 · start 30/30 · end 30/30 · signature 30/30 · all 30/30.

## Method

- Parse errors: up to 1000 indexed files per language, re-parsed with the indexer's web-tree-sitter grammar (JavaScript uses the TSX grammar, like the indexer); outermost ERROR nodes and MISSING nodes are counted.
- Precision: 30 random symbols per language (seed `django`). Checks: (a) the name is a whole identifier on the header lines (range start to 3 lines past the declaration line, after comments and annotations); (b) the first line is a comment, an annotation or a declaration-looking line, and the range ends at a plausible block end (balanced brackets outside strings/comments, closing brace or aligned `end`, nothing indented or chained after it); (c) the identifiers of the stored signature appear in order in the source of the range.
- These are heuristics. A failed sample is a pointer to inspect, not proof of an extraction bug.
- Duration: 2,115 ms.
