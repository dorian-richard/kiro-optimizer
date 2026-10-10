# kopt bench quality: gitea

Primary language `go` · commit `4ebd5e319b6a` · 3,402 files indexed, 3 skipped (minified 3) · index built in 6,271 ms · 2026-10-09T22:38:04.151Z

## Per language

| lang | files | KLOC | symbols/KLOC | refs resolved | resolved of in-repo names | files with parse errors | parse errors/KLOC | precision sample |
|---|---|---|---|---|---|---|---|---|
| go | 3,135 | 501.1 | 63.4 | 61.5% | 72.5% | 1.3% (13/1000) | 0.36 | 100.0% (30/30) |
| typescript | 267 | 24.6 | 45.6 | 28.8% | 63.0% | 0.0% (0/267) | 0.00 | 100.0% (30/30) |

`refs resolved` counts every reference, library calls included. `resolved of in-repo names` only counts references
whose name is defined somewhere in the repo, i.e. where an in-repo target is plausible.

## go

Symbols by kind (count, per KLOC): function 11,636 (23.22), field 9,650 (19.26), method 4,786 (9.55), constant 3,025 (6.04), struct 2,223 (4.44), type 319 (0.64), interface 145 (0.29).

Refs by kind (resolved/total): call 53,665/98,162 (54.7%), read 33,217/53,482 (62.1%), write 22,984/27,688 (83.0%), type_ref 13,784/24,954 (55.2%), new 8,238/10,062 (81.9%), inherit 117/399 (29.3%).

Parse sample: 1000 files, 160,342 lines, 51 ERROR + 7 MISSING nodes. Worst: `tests/integration/repofiles_change_test.go:108` (14), `modules/web/router_test.go:56` (13), `tests/integration/api_pull_test.go:513` (7), `tests/integration/api_admin_test.go:207` (5), `tests/integration/api_repo_get_contents_list_test.go:38` (4).

Precision sample: 30 symbols · name on header 30/30 · start 30/30 · end 30/30 · signature 30/30 · all 30/30.

## typescript

Symbols by kind (count, per KLOC): function 687 (27.95), type 153 (6.23), method 93 (3.78), field 81 (3.3), property 42 (1.71), class 19 (0.77), constant 16 (0.65), constructor 14 (0.57), namespace 10 (0.41), interface 6 (0.24).

Refs by kind (resolved/total): call 1,536/6,441 (23.8%), read 240/1,823 (13.2%), import 1,039/1,402 (74.1%), type_ref 377/1,072 (35.2%), write 114/517 (22.1%), new 22/314 (7.0%), implement 1/1 (100.0%), inherit 0/1 (0.0%).

Parse sample: 267 files, 24,845 lines, 0 ERROR + 0 MISSING nodes.

Precision sample: 30 symbols · name on header 30/30 · start 30/30 · end 30/30 · signature 30/30 · all 30/30.

## Method

- Parse errors: up to 1000 indexed files per language, re-parsed with the indexer's web-tree-sitter grammar (JavaScript uses the TSX grammar, like the indexer); outermost ERROR nodes and MISSING nodes are counted.
- Precision: 30 random symbols per language (seed `gitea`). Checks: (a) the name is a whole identifier on the header lines (range start to 3 lines past the declaration line, after comments and annotations); (b) the first line is a comment, an annotation or a declaration-looking line, and the range ends at a plausible block end (balanced brackets outside strings/comments, closing brace or aligned `end`, nothing indented or chained after it); (c) the identifiers of the stored signature appear in order in the source of the range.
- These are heuristics. A failed sample is a pointer to inspect, not proof of an extraction bug.
- Duration: 1,509 ms.
