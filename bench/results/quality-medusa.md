# kopt bench quality: medusa

Primary language `typescript` · commit `020565398e43` · 11,970 files indexed, 9 skipped (large 4, minified 5) · index built in 12,764 ms · 2026-10-09T22:21:54.139Z

## Per language

| lang | files | KLOC | symbols/KLOC | refs resolved | resolved of in-repo names | files with parse errors | parse errors/KLOC | precision sample |
|---|---|---|---|---|---|---|---|---|
| typescript | 8,000 | 931.7 | 34.9 | 24.8% | 35.6% | 0.1% (1/1000) | 0.01 | 100.0% (30/30) |
| tsx | 3,263 | 275.1 | 25.6 | 22.5% | 36.3% | 0.5% (5/1000) | 0.18 | 100.0% (30/30) |
| javascript | 707 | 87.9 | 8.7 | 9.4% | 13.1% | 0.1% (1/707) | 0.01 | 100.0% (30/30) |

`refs resolved` counts every reference, library calls included. `resolved of in-repo names` only counts references
whose name is defined somewhere in the repo, i.e. where an in-repo target is plausible.

## typescript

Symbols by kind (count, per KLOC): property 10,427 (11.19), method 5,249 (5.63), function 4,895 (5.25), constant 3,707 (3.98), type 2,992 (3.21), interface 2,402 (2.58), field 1,504 (1.61), class 739 (0.79), constructor 359 (0.39), enum 147 (0.16), namespace 48 (0.05).

Refs by kind (resolved/total): call 10,877/61,523 (17.7%), import 11,222/33,429 (33.6%), read 5,516/33,241 (16.6%), type_ref 11,656/32,910 (35.4%), new 485/3,611 (13.4%), write 1,237/2,428 (50.9%), inherit 793/1,220 (65.0%), implement 20/103 (19.4%).

Parse sample: 1000 files, 137,450 lines, 1 ERROR + 0 MISSING nodes. Worst: `packages/core/types/src/modules-sdk/remote-query.ts:1` (1).

Precision sample: 30 symbols · name on header 30/30 · start 30/30 · end 30/30 · signature 30/30 · all 30/30.

## tsx

Symbols by kind (count, per KLOC): function 3,928 (14.28), type 1,249 (4.54), constant 784 (2.85), property 771 (2.8), interface 246 (0.89), method 25 (0.09), enum 18 (0.07), field 12 (0.04), class 3 (0.01), constructor 1 (0).

Refs by kind (resolved/total): call 7,104/38,439 (18.5%), import 7,853/21,365 (36.8%), read 442/10,487 (4.2%), type_ref 2,456/7,828 (31.4%), write 11/900 (1.2%), new 16/303 (5.3%), inherit 26/119 (21.8%).

Parse sample: 1000 files, 83,646 lines, 15 ERROR + 0 MISSING nodes. Worst: `packages/admin/dashboard/src/routes/orders/order-receive-return/components/order-receive-return-form/dismissed-quantity.tsx:152` (5), `packages/admin/dashboard/src/routes/orders/order-receive-return/components/order-receive-return-form/order-receive-return-form.tsx:296` (5), `packages/plugins/draft-order/src/admin/components/draft-orders/summary-section.tsx:125` (2), `packages/plugins/loyalty/src/admin/components/sortable-list.tsx:130` (2), `www/apps/ui/specs/examples/date-picker-form.tsx:32` (1).

Precision sample: 30 symbols · name on header 30/30 · start 30/30 · end 30/30 · signature 30/30 · all 30/30.

## javascript

Symbols by kind (count, per KLOC): constant 604 (6.87), function 114 (1.3), method 33 (0.38), class 5 (0.06), constructor 5 (0.06), field 2 (0.02).

Refs by kind (resolved/total): call 381/2,465 (15.5%), read 9/1,176 (0.8%), import 81/924 (8.8%), new 7/503 (1.4%), write 2/45 (4.4%).

Parse sample: 707 files, 88,126 lines, 1 ERROR + 0 MISSING nodes. Worst: `www/apps/api-reference/specs/admin/code_samples/JavaScript/admin_uploads_presigned-urls/post.js:15` (1).

Precision sample: 30 symbols · name on header 30/30 · start 30/30 · end 30/30 · signature 30/30 · all 30/30.

## Method

- Parse errors: up to 1000 indexed files per language, re-parsed with the indexer's web-tree-sitter grammar (JavaScript uses the TSX grammar, like the indexer); outermost ERROR nodes and MISSING nodes are counted.
- Precision: 30 random symbols per language (seed `medusa`). Checks: (a) the name is a whole identifier on the header lines (range start to 3 lines past the declaration line, after comments and annotations); (b) the first line is a comment, an annotation or a declaration-looking line, and the range ends at a plausible block end (balanced brackets outside strings/comments, closing brace or aligned `end`, nothing indented or chained after it); (c) the identifiers of the stored signature appear in order in the source of the range.
- These are heuristics. A failed sample is a pointer to inspect, not proof of an extraction bug.
- Duration: 3,043 ms.
