# kopt bench quality: meilisearch

Primary language `rust` · commit `7ebd97e38c36` · 715 files indexed, 0 skipped · index built in 2,210 ms · 2026-10-09T22:38:32.674Z

## Per language

| lang | files | KLOC | symbols/KLOC | refs resolved | resolved of in-repo names | files with parse errors | parse errors/KLOC | precision sample |
|---|---|---|---|---|---|---|---|---|
| rust | 715 | 268.1 | 68.2 | 38.9% | 52.3% | 0.1% (1/715) | 0.01 | 100.0% (30/30) |

`refs resolved` counts every reference, library calls included. `resolved of in-repo names` only counts references
whose name is defined somewhere in the repo, i.e. where an in-repo target is plausible.

## rust

Symbols by kind (count, per KLOC): method 4,842 (18.06), field 4,783 (17.84), constant 2,831 (10.56), function 2,624 (9.79), struct 1,443 (5.38), module 753 (2.81), enum 509 (1.9), type 436 (1.63), trait 59 (0.22).

Refs by kind (resolved/total): call 12,632/50,369 (25.1%), type_ref 7,093/15,246 (46.5%), read 8,820/13,697 (64.4%), import 4,722/10,594 (44.6%), write 3,988/6,401 (62.3%), new 1,104/1,924 (57.4%), implement 180/803 (22.4%).

Parse sample: 715 files, 268,768 lines, 3 ERROR + 0 MISSING nodes. Worst: `crates/index-scheduler/src/lib.rs:315` (3).

Precision sample: 30 symbols · name on header 30/30 · start 30/30 · end 30/30 · signature 30/30 · all 30/30.

## Method

- Parse errors: up to 1000 indexed files per language, re-parsed with the indexer's web-tree-sitter grammar (JavaScript uses the TSX grammar, like the indexer); outermost ERROR nodes and MISSING nodes are counted.
- Precision: 30 random symbols per language (seed `meilisearch`). Checks: (a) the name is a whole identifier on the header lines (range start to 3 lines past the declaration line, after comments and annotations); (b) the first line is a comment, an annotation or a declaration-looking line, and the range ends at a plausible block end (balanced brackets outside strings/comments, closing brace or aligned `end`, nothing indented or chained after it); (c) the identifiers of the stored signature appear in order in the source of the range.
- These are heuristics. A failed sample is a pointer to inspect, not proof of an extraction bug.
- Duration: 1,724 ms.
