# Vendored tree-sitter grammars

kopt parses most languages with the WASM grammars of the `tree-sitter-wasms` npm package. For Scala and Rust it
uses newer builds, kept here so that installing kopt pulls no extra npm package for them:

| file | grammar | upstream version | upstream revision | taken from | SHA-256 |
|---|---|---|---|---|---|
| `tree-sitter-scala.wasm` | [tree-sitter-scala](https://github.com/tree-sitter/tree-sitter-scala) | 0.26.2 | `b931fcc338390925eb893d70ad070033f5856ccf` | npm `@lumis-sh/wasm-scala@0.26.4` | `37d7fe5a91ca98941dc05493b0c05a0df0f36df5035890fa00b02497c68aaac3` |
| `tree-sitter-rust.wasm` | [tree-sitter-rust](https://github.com/tree-sitter/tree-sitter-rust) | 0.24.2 | `77a3747266f4d621d0757825e6b11edcbf991ca5` | npm `@lumis-sh/wasm-rust@0.26.5` | `34c51ee3e8c05a775e5e05163278bb73c79df149f7e8d648f84a54bd97466e84` |

Both files are byte-for-byte copies of the `.wasm` file in those packages (built with `tree-sitter build --wasm`
0.26.11 by the Lumis project). They are pure WebAssembly: no native code, no install script.

Why these builds: the `tree-sitter-wasms` 0.1.13 grammars date from 2023. With them, 80% of Play Framework's Scala
files had parse errors (Scala 3 syntax, `private[x]`, `class X @Inject() (...)`), against none with
tree-sitter-scala 0.26; Rust parse errors on meilisearch dropped from 2.9% to 0.1% (let-else, async closures, raw
identifiers).

## Integrity

`src/indexer/languages.ts` holds the SHA-256 of each file and checks it before loading the grammar. On a mismatch
(a corrupted or replaced file), kopt prints one warning to stderr and parses that language with the older
`tree-sitter-wasms` grammar instead. `SHA256SUMS` lists the same checksums for `shasum -a 256 -c SHA256SUMS`.

## Licenses

- `LICENSE.tree-sitter-scala`: MIT, the upstream tree-sitter-scala grammar.
- `LICENSE.tree-sitter-rust`: MIT, the upstream tree-sitter-rust grammar.
- `LICENSE.lumis-packaging`: MIT, the Lumis packaging the WASM builds were taken from.

## Updating

1. Build or download the new `.wasm` (it must load with the `web-tree-sitter` version in `package.json`).
2. Replace the file here, update the table above, `SHA256SUMS` and the checksum in `src/indexer/languages.ts`.
3. Run `npm test` (test/indexer.grammars.test.ts parses modern Scala and Rust) and `kopt bench all` on the corpus.
