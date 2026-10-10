# kopt_run compression on the committed fixtures

Generated 2026-10-10 by `node bench/compress/run.mjs` (Node v22.23.3) from `test/fixtures/compress`, at the
default kopt_run budget (900 tokens). Tokens = characters / 3. "raw" is the output after normalization (ANSI codes
and progress redraws removed), "kopt" is what the filter returns. A kopt_run answer adds a one-line header and the log
handle line (about 20-40 tokens), and on a failing run with the index ready up to 200 tokens of source hints.

"generated" fixtures imitate each tool's CI output (`test/fixtures/compress/generate.mjs`: long passing runs generated,
failing sections written by hand); "real" fixtures are real runs of this repository's own suite and build.

| set | fixtures | raw tokens | kopt tokens | reduction (total) | median reduction | smallest reduction |
|---|---|---|---|---|---|---|
| all | 50 | 286,154 | 10,402 | 96.4% | 93.8% | 42.5% |
| exit 0 (passing runs, git) | 15 | 87,544 | 2,145 | 97.5% | 99.4% | 79.8% |
| exit non-zero (failures) | 35 | 198,610 | 8,257 | 95.8% | 91.8% | 42.5% |
| real runs of this repository | 5 | 32,729 | 1,889 | 94.2% | 94.1% | 60.7% |
| generated fixtures | 45 | 253,425 | 8,513 | 96.6% | 93.5% | 42.5% |

| fixture | command | exit | origin | filter | raw tokens | kopt tokens | reduction |
|---|---|---|---|---|---|---|---|
| pytest-pass.txt | `pytest -v` | 0 | generated | pytest | 11,500 | 18 | 99.8% |
| pytest-fail.txt | `python -m pytest -v` | 1 | generated | pytest | 13,013 | 318 | 97.6% |
| unittest-fail.txt | `python manage.py test` | 1 | generated | unittest | 602 | 223 | 63.0% |
| jest-pass.txt | `npx jest --verbose` | 0 | generated | jest | 12,533 | 27 | 99.8% |
| jest-fail.txt | `npm test` | 1 | generated | jest | 1,608 | 358 | 77.7% |
| jest-json-fail.txt | `npm test` | 1 | generated | json | 32,718 | 182 | 99.4% |
| vitest-pass.txt | `npx vitest run` | 0 | generated | vitest | 2,401 | 24 | 99.0% |
| vitest-fail.txt | `pnpm vitest run` | 1 | generated | vitest | 1,626 | 125 | 92.3% |
| mocha-pass.txt | `npx mocha` | 0 | generated | mocha | 6,903 | 10 | 99.9% |
| mocha-fail.txt | `npm test` | 1 | generated | mocha | 4,445 | 188 | 95.8% |
| mocha-json-fail.txt | `npx mocha --reporter json` | 1 | generated | json | 27,323 | 157 | 99.4% |
| tsc-fail.txt | `npx tsc --noEmit` | 2 | generated | tsc | 3,459 | 343 | 90.1% |
| tsc-pretty-fail.txt | `npx tsc --noEmit --pretty` | 2 | generated | tsc | 240 | 138 | 42.5% |
| eslint-fail.txt | `npx eslint src` | 1 | generated | eslint | 5,204 | 167 | 96.8% |
| eslint-json.txt | `npx eslint -f json src` | 1 | generated | json | 10,107 | 384 | 96.2% |
| npm-install.txt | `npm install` | 0 | generated | npm | 628 | 41 | 93.5% |
| npm-build-fail.txt | `npm run build` | 1 | generated | npm | 2,386 | 212 | 91.1% |
| maven-pass.txt | `mvn -B verify` | 0 | generated | maven | 8,418 | 39 | 99.5% |
| maven-compile-fail.txt | `mvn -B verify` | 1 | generated | maven | 3,071 | 269 | 91.2% |
| maven-test-fail.txt | `./mvnw test` | 1 | generated | maven | 3,680 | 263 | 92.9% |
| gradle-pass.txt | `./gradlew build` | 0 | generated | gradle | 4,287 | 27 | 99.4% |
| gradle-fail.txt | `./gradlew build --continue` | 1 | generated | gradle | 1,101 | 274 | 75.1% |
| sbt-test-fail.txt | `sbt test` | 1 | generated | sbt | 4,086 | 171 | 95.8% |
| sbt-compile-fail.txt | `sbt compile` | 1 | generated | sbt | 932 | 154 | 83.5% |
| dotnet-build-pass.txt | `dotnet build` | 0 | generated | dotnet | 5,210 | 30 | 99.4% |
| dotnet-build-fail.txt | `dotnet build` | 1 | generated | dotnet | 630 | 143 | 77.3% |
| dotnet-test-fail.txt | `dotnet test` | 1 | generated | dotnet | 830 | 239 | 71.2% |
| dotnet-mtp-fail.txt | `dotnet test` | 1 | generated | dotnet | 383 | 101 | 73.6% |
| xunit-console-fail.txt | `dotnet tools/xunit.console.dll tests/Shop.Tests.dll` | 1 | generated | xunit | 441 | 193 | 56.2% |
| nunit-console-fail.txt | `nunit3-console tests/Shop.Tests.dll` | 1 | generated | xunit | 546 | 198 | 63.7% |
| go-test-pass.txt | `go test -v ./...` | 0 | generated | go | 7,254 | 18 | 99.8% |
| go-test-fail.txt | `go test -v ./...` | 1 | generated | go | 1,539 | 298 | 80.6% |
| go-test-json-fail.txt | `go test -json ./...` | 1 | generated | json | 25,630 | 67 | 99.7% |
| cargo-test-pass.txt | `cargo test` | 0 | generated | cargo | 5,311 | 23 | 99.6% |
| cargo-build-fail.txt | `cargo build` | 101 | generated | cargo | 2,248 | 182 | 91.9% |
| cargo-test-fail.txt | `cargo test` | 101 | generated | cargo | 2,111 | 98 | 95.4% |
| rspec-fail.txt | `bundle exec rspec --format documentation` | 1 | generated | rspec | 4,368 | 188 | 95.7% |
| phpunit-fail.txt | `vendor/bin/phpunit` | 2 | generated | phpunit | 462 | 175 | 62.1% |
| pest-fail.txt | `php artisan test` | 1 | generated | phpunit | 6,366 | 86 | 98.6% |
| bazel-test-fail.txt | `bazel test //...` | 3 | generated | bazel | 3,837 | 313 | 91.8% |
| git-log.txt | `git log` | 0 | generated | git | 4,405 | 888 | 79.8% |
| git-diff.txt | `git diff` | 0 | generated | git | 5,268 | 811 | 84.6% |
| git-status.txt | `git status` | 0 | generated | git | 655 | 92 | 86.0% |
| generic-fail.txt | `python scripts/migrate.py` | 1 | generated | generic | 4,629 | 188 | 95.9% |
| generic-pass.txt | `./reindex.sh` | 0 | generated | generic | 9,031 | 70 | 99.2% |
| vitest-kopt-pass.txt | `npx vitest run` | 0 | real | vitest | 3,740 | 27 | 99.3% |
| vitest-kopt-fail.txt | `npx vitest run` | 1 | real | vitest | 6,764 | 158 | 97.7% |
| vitest-kopt-many-fail.txt | `npx vitest run` | 1 | real | vitest | 14,831 | 878 | 94.1% |
| vitest-kopt-diff-fail.txt | `npx vitest run` | 1 | real | vitest | 6,873 | 621 | 91.0% |
| build-kopt-fail.txt | `npm run build` | 2 | real | tsc | 521 | 205 | 60.7% |
