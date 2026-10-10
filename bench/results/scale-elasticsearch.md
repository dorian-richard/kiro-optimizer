# kopt scale check: elasticsearch

50,285 tracked files at ef9234a09 · darwin-arm64 · node v22.23.3 · 2026-10-09
Produced by `bench/scale/run.mjs`: `kopt mcp` over stdio, as Kiro starts it, on a copy-on-write clone of the checkout.

| step | result |
|---|---|
| server start (initialize) | 125 ms |
| first build: kopt_find answers from the index | 31.5 s |
| first build: kopt_refs answers (references resolved) | 82.3 s |
| server peak memory (worker thread included) | 2022 MB |
| index size on disk | 1067 MB |
| concurrent `kopt index` started during the build | exit 0 after 80.1 s: kopt: another kopt process (pid 9169) is indexing <clone>; waiting for it / indexed 33090 files (0 parsed, 33089 unchanged, 0 deleted) · 572554 symbols · 3801212 refs · 80.0s |
| query latency on the built index (11 calls) | median 54 ms, max 496 ms |
| 20 files written by the agent (hook dirty list), next call | 593 ms, 20 of them found by that call |
| 200 files changed by a pull, `kopt index --refresh` | 4.4 s (indexed 33090 files (200 parsed, 32889 unchanged, 0 deleted) · 572774 symbols · 3801212 refs · 4.3s); the server then answers: find "koptScaleProbePulled" · 5 hits · ~241 tok · +195 more (raise limit or narrow query) |
| `kopt index --refresh`, nothing changed | 0.9 s (indexed 33090 files (0 parsed, 33089 unchanged, 0 deleted) · 572774 symbols · 3801212 refs · 0.8s) |

Calls made while the first build ran (the agent is never blocked: it gets the progress until search is ready):

| at (s) | call took (ms) | first line of the answer |
|---|---|---|
| 2.1 | 2015 | index building: 1000/33090 files parsed – use built-in search/read tools until then |
| 4.1 | 1 | index building: 4000/33090 files parsed, ~25 s left – use built-in search/read tools until then |
| 6.2 | 3 | index building: 7000/33090 files parsed, ~25 s left – use built-in search/read tools until then |
| 31.5 | 277 | find "index shard allocation" · 3 hits · ~295 tok · +344 more (raise limit or narrow query) |

| tool | arguments | ms | tokens | first line |
|---|---|---|---|---|
| kopt_find | `{"query":"snapshot restore repository"}` | 496 | 677 | find "snapshot restore repository" · 8 hits · ~677 tok · +179 more (raise maxTokens or narrow query) |
| kopt_find | `{"query":"circuit breaker memory limit"}` | 246 | 674 | find "circuit breaker memory limit" · 12 hits · ~674 tok · +222 more (raise limit or narrow query) |
| kopt_find | `{"query":"IndexShard"}` | 68 | 635 | find "IndexShard" · 12 hits · ~635 tok · +71 more (raise limit or narrow query) |
| kopt_find | `{"query":"how are search requests coordinated across shards","mode":"pack"}` | 291 | 1351 | pack "how are search requests coordinated across shards" · 12 hits · 1 body · ~1351 tok · +161 more (raise limit or narr |
| kopt_find | `{"query":"retention lease renewal","mode":"pack"}` | 192 | 1603 | pack "retention lease renewal" · 12 hits · 1 body · ~1603 tok · +29 more (raise limit or narrow query) |
| kopt_find | `{"query":"executeBulkRequest","mode":"pack"}` | 54 | 1120 | pack "executeBulkRequest" · 7 hits · 1 body · ~1120 tok |
| kopt_read | `{"target":"AllocationService"}` | 4 | 2369 | server/src/main/java/org/elasticsearch/cluster/routing/allocation/AllocationService.java:90-1017 #27nw skeleton |
| kopt_read | `{"target":"IndexShard.applyIndexOperationOnPrimary"}` | 3 | 268 | server/src/main/java/org/elasticsearch/index/shard/IndexShard.java:998-1021 #3dot |
| kopt_refs | `{"target":"IndexShard.applyIndexOperationOnPrimary"}` | 5 | 833 | refs #3dot IndexShard.applyIndexOperationOnPrimary · 23 usages in 8 files · ~833 tok |
| kopt_refs | `{"target":"ClusterState.metadata"}` | 29 | 838 | refs #20nf ClusterState.metadata · 1627 usages in 685 files · ~838 tok · +684 more (raise maxTokens or narrow query) |
| kopt_outline | `{"path":"server/src/main/java/org/elasticsearch/index/shard"}` | 9 | 1160 | outline server/src/main/java/org/elasticsearch/index/shard/ · 31 files · ~1160 tok · +18 more (narrow with path or focus |
