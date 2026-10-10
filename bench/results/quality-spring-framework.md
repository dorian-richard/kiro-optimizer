# kopt bench quality: spring-framework

Primary language `java` · commit `82a6b40b9366` · 9,552 files indexed, 0 skipped · index built in 20,224 ms · 2026-10-09T22:20:47.606Z

## Per language

| lang | files | KLOC | symbols/KLOC | refs resolved | resolved of in-repo names | files with parse errors | parse errors/KLOC | precision sample |
|---|---|---|---|---|---|---|---|---|
| java | 9,150 | 1494.5 | 90.4 | 50.9% | 67.7% | 1.0% (10/1000) | 0.07 | 100.0% (30/30) |
| kotlin | 388 | 34.5 | 100.6 | 44.1% | 62.3% | 1.0% (4/388) | 0.14 | 100.0% (30/30) |
| javascript | 10 | 0.0 | 150.0 | 0.0% | 0.0% | n/a | n/a | n/a |
| python | 2 | 0.0 | 200.0 | 0.0% | 0.0% | n/a | n/a | n/a |
| ruby | 2 | 0.0 | 50.0 | 25.0% | 66.7% | n/a | n/a | n/a |

`refs resolved` counts every reference, library calls included. `resolved of in-repo names` only counts references
whose name is defined somewhere in the repo, i.e. where an in-repo target is plausible.

## java

Symbols by kind (count, per KLOC): method 84,459 (56.51), field 19,290 (12.91), class 15,346 (10.27), constructor 6,879 (4.6), constant 6,083 (4.07), interface 2,713 (1.82), record 184 (0.12), enum 182 (0.12).

Refs by kind (resolved/total): call 165,589/343,812 (48.2%), type_ref 63,706/182,370 (34.9%), import 41,394/87,931 (47.1%), read 51,937/60,257 (86.2%), new 32,314/43,979 (73.5%), write 16,031/16,055 (99.9%), implement 3,960/4,907 (80.7%), inherit 4,034/4,669 (86.4%).

Parse sample: 1000 files, 165,586 lines, 12 ERROR + 0 MISSING nodes. Worst: `spring-beans/src/main/java/org/springframework/beans/factory/support/AbstractBeanFactory.java:205` (2), `spring-webmvc/src/main/java/org/springframework/web/servlet/support/WebContentGenerator.java:127` (2), `spring-beans/src/main/java/org/springframework/beans/factory/config/BeanDefinition.java:156` (1), `spring-context/src/main/java/org/springframework/context/annotation/ClassPathBeanDefinitionScanner.java:202` (1), `spring-context/src/main/java/org/springframework/validation/ValidationUtils.java:71` (1).

Precision sample: 30 symbols · name on header 30/30 · start 30/30 · end 30/30 · signature 30/30 · all 30/30.

## kotlin

Symbols by kind (count, per KLOC): method 2,060 (59.65), class 621 (17.98), property 514 (14.88), function 222 (6.43), interface 36 (1.04), constructor 14 (0.41), constant 6 (0.17).

Refs by kind (resolved/total): call 3,358/8,875 (37.8%), type_ref 1,626/3,280 (49.6%), import 1,134/2,138 (53.0%), read 685/2,094 (32.7%), new 902/1,273 (70.9%), implement 94/98 (95.9%), write 53/95 (55.8%), inherit 51/60 (85.0%).

Parse sample: 388 files, 34,798 lines, 5 ERROR + 0 MISSING nodes. Worst: `spring-tx/src/test/kotlin/org/springframework/transaction/reactive/TransactionalOperatorExtensionsTests.kt:64` (2), `spring-web/src/test/kotlin/org/springframework/http/codec/json/KotlinSerializationJsonEncoderTests.kt:166` (1), `spring-web/src/test/kotlin/org/springframework/http/converter/cbor/KotlinSerializationCborHttpMessageConverterTests.kt:196` (1), `spring-web/src/test/kotlin/org/springframework/http/converter/json/KotlinSerializationJsonHttpMessageConverterTests.kt:265` (1).

Precision sample: 30 symbols · name on header 30/30 · start 30/30 · end 30/30 · signature 30/30 · all 30/30.

## javascript

Symbols by kind (count, per KLOC): function 6 (150).

Refs by kind (resolved/total): write 0/38 (0.0%), call 0/24 (0.0%), read 0/22 (0.0%), new 0/2 (0.0%).

## python

Symbols by kind (count, per KLOC): function 2 (200).

Refs by kind (resolved/total): call 0/2 (0.0%), import 0/2 (0.0%), new 0/2 (0.0%).

## ruby

Symbols by kind (count, per KLOC): function 2 (50).

Refs by kind (resolved/total): call 4/12 (33.3%), new 0/4 (0.0%).

## Method

- Parse errors: up to 1000 indexed files per language, re-parsed with the indexer's web-tree-sitter grammar (JavaScript uses the TSX grammar, like the indexer); outermost ERROR nodes and MISSING nodes are counted.
- Precision: 30 random symbols per language (seed `spring-framework`). Checks: (a) the name is a whole identifier on the header lines (range start to 3 lines past the declaration line, after comments and annotations); (b) the first line is a comment, an annotation or a declaration-looking line, and the range ends at a plausible block end (balanced brackets outside strings/comments, closing brace or aligned `end`, nothing indented or chained after it); (c) the identifiers of the stored signature appear in order in the source of the range.
- These are heuristics. A failed sample is a pointer to inspect, not proof of an extraction bug.
- Duration: 3,214 ms.
