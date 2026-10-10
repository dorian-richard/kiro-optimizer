# kopt bench quality: jellyfin

Primary language `c_sharp` · commit `1fbd8739292c` · 1,922 files indexed, 0 skipped · index built in 2,144 ms · 2026-10-09T22:37:52.904Z

## Per language

| lang | files | KLOC | symbols/KLOC | refs resolved | resolved of in-repo names | files with parse errors | parse errors/KLOC | precision sample |
|---|---|---|---|---|---|---|---|---|
| c_sharp | 1,922 | 231.9 | 77.5 | 48.8% | 72.6% | 0.7% (7/1000) | 0.11 | 96.7% (29/30) |

`refs resolved` counts every reference, library calls included. `resolved of in-repo names` only counts references
whose name is defined somewhere in the repo, i.e. where an in-repo target is plausible.

## c_sharp

Symbols by kind (count, per KLOC): method 6,376 (27.5), property 5,347 (23.06), field 1,905 (8.22), class 1,647 (7.1), constant 1,432 (6.18), constructor 929 (4.01), interface 196 (0.85), enum 132 (0.57), record 10 (0.04), struct 5 (0.02), type 1 (0).

Refs by kind (resolved/total): call 9,821/27,577 (35.6%), read 12,820/24,918 (51.4%), type_ref 10,792/22,524 (47.9%), write 6,219/7,266 (85.6%), new 2,019/3,757 (53.7%), implement 510/638 (79.9%), inherit 387/514 (75.3%).

Parse sample: 1000 files, 119,157 lines, 11 ERROR + 2 MISSING nodes. Worst: `Jellyfin.Server/Migrations/Routines/MigrateLibraryUserData.cs:77` (3), `src/Jellyfin.Database/Jellyfin.Database.Providers.Sqlite/SqliteDatabaseProvider.cs:200` (3), `Jellyfin.Server/Migrations/Routines/ReseedFolderFlag.cs:61` (2), `src/Jellyfin.Database/Jellyfin.Database.Providers.Sqlite/Migrations/20250913211637_AddProperParentChildRelationBaseItemWithCascade.cs:13` (2), `Jellyfin.Server.Implementations/Item/BaseItemRepository.cs:108` (1).

Precision sample: 30 symbols · name on header 30/30 · start 29/30 · end 29/30 · signature 30/30 · all 29/30.

| symbol | kind | range | failed | why |
|---|---|---|---|---|
| `Up` | method | `src/Jellyfin.Database/Jellyfin.Database.Providers.Sqlite/Migrations/20241111131257_AddedCustomDataKey.cs:11-18` | start, end | byte range maps to lines 11-20, stored lines are 11-18 |

## Method

- Parse errors: up to 1000 indexed files per language, re-parsed with the indexer's web-tree-sitter grammar (JavaScript uses the TSX grammar, like the indexer); outermost ERROR nodes and MISSING nodes are counted.
- Precision: 30 random symbols per language (seed `jellyfin`). Checks: (a) the name is a whole identifier on the header lines (range start to 3 lines past the declaration line, after comments and annotations); (b) the first line is a comment, an annotation or a declaration-looking line, and the range ends at a plausible block end (balanced brackets outside strings/comments, closing brace or aligned `end`, nothing indented or chained after it); (c) the identifiers of the stored signature appear in order in the source of the range.
- These are heuristics. A failed sample is a pointer to inspect, not proof of an extraction bug.
- Duration: 870 ms.
