# kopt bench quality: exposed

Primary language `kotlin` · commit `84361204b663` · 864 files indexed, 2 skipped (minified 2) · index built in 2,057 ms · 2026-10-09T22:38:17.136Z

## Per language

| lang | files | KLOC | symbols/KLOC | refs resolved | resolved of in-repo names | files with parse errors | parse errors/KLOC | precision sample |
|---|---|---|---|---|---|---|---|---|
| kotlin | 860 | 141.9 | 91.1 | 51.0% | 72.9% | 1.2% (10/860) | 0.24 | 96.7% (29/30) |
| javascript | 4 | 0.6 | 62.5 | 11.2% | 34.1% | n/a | n/a | n/a |

`refs resolved` counts every reference, library calls included. `resolved of in-repo names` only counts references
whose name is defined somewhere in the repo, i.e. where an in-repo target is plausible.

## kotlin

Symbols by kind (count, per KLOC): method 5,981 (42.14), property 3,684 (25.95), class 1,871 (13.18), function 955 (6.73), constant 351 (2.47), interface 70 (0.49), constructor 13 (0.09).

Refs by kind (resolved/total): call 19,665/40,120 (49.0%), read 5,266/12,602 (41.8%), type_ref 5,268/11,488 (45.9%), import 5,369/8,472 (63.4%), new 2,553/3,431 (74.4%), inherit 1,341/1,376 (97.5%), write 141/296 (47.6%), implement 206/265 (77.7%).

Parse sample: 860 files, 142,799 lines, 27 ERROR + 7 MISSING nodes. Worst: `exposed-jdbc/src/main/kotlin/org/jetbrains/exposed/v1/jdbc/statements/jdbc/JdbcDatabaseMetadataImpl.kt:279` (15), `exposed-maven-plugin/src/test/kotlin/org/jetbrains/exposed/v1/maven/plugin/integrations/helpers/MavenProjectGeneration.kt:66` (7), `exposed-core/src/main/kotlin/org/jetbrains/exposed/v1/core/OpBuilder.kt:114` (2), `exposed-core/src/main/kotlin/org/jetbrains/exposed/v1/core/Table.kt:51` (2), `exposed-maven-plugin/src/test/resources/template/sourceFiles/Cities.kt:1` (2).

Precision sample: 30 symbols · name on header 30/30 · start 30/30 · end 29/30 · signature 30/30 · all 29/30.

| symbol | kind | range | failed | why |
|---|---|---|---|---|
| `JdbcDatabaseMetadataImpl` | class | `exposed-jdbc/src/main/kotlin/org/jetbrains/exposed/v1/jdbc/statements/jdbc/JdbcDatabaseMetadataImpl.kt:25-305` | end | unbalanced brackets in the declaration (round 0, square 0, curly 5) |

## javascript

Symbols by kind (count, per KLOC): function 30 (50.68), constant 7 (11.82).

Refs by kind (resolved/total): call 29/207 (14.0%), read 0/40 (0.0%), write 0/12 (0.0%).

## Method

- Parse errors: up to 1000 indexed files per language, re-parsed with the indexer's web-tree-sitter grammar (JavaScript uses the TSX grammar, like the indexer); outermost ERROR nodes and MISSING nodes are counted.
- Precision: 30 random symbols per language (seed `exposed`). Checks: (a) the name is a whole identifier on the header lines (range start to 3 lines past the declaration line, after comments and annotations); (b) the first line is a comment, an annotation or a declaration-looking line, and the range ends at a plausible block end (balanced brackets outside strings/comments, closing brace or aligned `end`, nothing indented or chained after it); (c) the identifiers of the stored signature appear in order in the source of the range.
- These are heuristics. A failed sample is a pointer to inspect, not proof of an extraction bug.
- Duration: 1,654 ms.
