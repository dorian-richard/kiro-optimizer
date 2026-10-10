#!/usr/bin/env node
// Command-output compression on the committed fixtures: what kopt_run's filters return to the model, against the
// normalized raw output, at the default kopt_run budget (900 tokens). Deterministic and offline: it runs kopt's own
// filters (dist/compress) on the files of test/fixtures/compress and nothing else.
//
// usage: npm run build && node bench/compress/run.mjs [--out bench/results/compression]
//
// The figures cover the filter output only. A real kopt_run answer adds a one-line header (exit code, duration,
// raw size) and the log handle line, about 20 to 40 tokens, plus up to 200 tokens of source hints on a failing run
// when the project index is ready. The same path as test/compress.filters.test.ts: normalize, make repository
// paths relative, compress.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIX = join(ROOT, 'test', 'fixtures', 'compress');
const FIXTURE_ROOT = '/home/dev/shop';
const BUDGET = 900;

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const OUT = resolve(ROOT, outIdx >= 0 ? args[outIdx + 1] : 'bench/results/compression');

const imp = (p) => import(pathToFileURL(join(ROOT, 'dist', p)).href);
const { compressOutput, relativizeRoot } = await imp('compress/index.js');
const { normalizeOutput } = await imp('compress/normalize.js');
const { estimateTokens } = await imp('core/tokens.js');

// [fixture, command, exit code, family, origin]. origin: 'generated' = imitates the tool's CI output
// (test/fixtures/compress/generate.mjs: long passing runs generated, failing sections written by hand);
// 'real' = a real run (this repository's own test suite or build, or node:test on a small project), captured
// through kopt_run's runner, paths rewritten to the fixture root.
const CASES = [
  ['pytest-pass.txt', 'pytest -v', 0, 'Python'],
  ['pytest-fail.txt', 'python -m pytest -v', 1, 'Python'],
  ['unittest-fail.txt', 'python manage.py test', 1, 'Python'],
  ['jest-pass.txt', 'npx jest --verbose', 0, 'JavaScript / TypeScript'],
  ['jest-fail.txt', 'npm test', 1, 'JavaScript / TypeScript'],
  ['jest-json-fail.txt', 'npm test', 1, 'JavaScript / TypeScript'],
  ['vitest-pass.txt', 'npx vitest run', 0, 'JavaScript / TypeScript'],
  ['vitest-fail.txt', 'pnpm vitest run', 1, 'JavaScript / TypeScript'],
  ['mocha-pass.txt', 'npx mocha', 0, 'JavaScript / TypeScript'],
  ['mocha-fail.txt', 'npm test', 1, 'JavaScript / TypeScript'],
  ['mocha-json-fail.txt', 'npx mocha --reporter json', 1, 'JavaScript / TypeScript'],
  ['tsc-fail.txt', 'npx tsc --noEmit', 2, 'JavaScript / TypeScript'],
  ['tsc-pretty-fail.txt', 'npx tsc --noEmit --pretty', 2, 'JavaScript / TypeScript'],
  ['eslint-fail.txt', 'npx eslint src', 1, 'JavaScript / TypeScript'],
  ['eslint-json.txt', 'npx eslint -f json src', 1, 'JavaScript / TypeScript'],
  ['npm-install.txt', 'npm install', 0, 'JavaScript / TypeScript'],
  ['npm-build-fail.txt', 'npm run build', 1, 'JavaScript / TypeScript'],
  ['maven-pass.txt', 'mvn -B verify', 0, 'JVM'],
  ['maven-compile-fail.txt', 'mvn -B verify', 1, 'JVM'],
  ['maven-test-fail.txt', './mvnw test', 1, 'JVM'],
  ['gradle-pass.txt', './gradlew build', 0, 'JVM'],
  ['gradle-fail.txt', './gradlew build --continue', 1, 'JVM'],
  ['sbt-test-fail.txt', 'sbt test', 1, 'JVM'],
  ['sbt-compile-fail.txt', 'sbt compile', 1, 'JVM'],
  ['dotnet-build-pass.txt', 'dotnet build', 0, '.NET'],
  ['dotnet-build-fail.txt', 'dotnet build', 1, '.NET'],
  ['dotnet-test-fail.txt', 'dotnet test', 1, '.NET'],
  ['dotnet-mtp-fail.txt', 'dotnet test', 1, '.NET'],
  ['xunit-console-fail.txt', 'dotnet tools/xunit.console.dll tests/Shop.Tests.dll', 1, '.NET'],
  ['nunit-console-fail.txt', 'nunit3-console tests/Shop.Tests.dll', 1, '.NET'],
  ['go-test-pass.txt', 'go test -v ./...', 0, 'Go'],
  ['go-test-fail.txt', 'go test -v ./...', 1, 'Go'],
  ['go-test-json-fail.txt', 'go test -json ./...', 1, 'Go'],
  ['cargo-test-pass.txt', 'cargo test', 0, 'Rust'],
  ['cargo-build-fail.txt', 'cargo build', 101, 'Rust'],
  ['cargo-test-fail.txt', 'cargo test', 101, 'Rust'],
  ['rspec-fail.txt', 'bundle exec rspec --format documentation', 1, 'Ruby'],
  ['phpunit-fail.txt', 'vendor/bin/phpunit', 2, 'PHP'],
  ['pest-fail.txt', 'php artisan test', 1, 'PHP'],
  ['bazel-test-fail.txt', 'bazel test //...', 3, 'Other'],
  ['git-log.txt', 'git log', 0, 'git'],
  ['git-diff.txt', 'git diff', 0, 'git'],
  ['git-status.txt', 'git status', 0, 'git'],
  ['generic-fail.txt', 'python scripts/migrate.py', 1, 'Other'],
  ['generic-pass.txt', './reindex.sh', 0, 'Other'],
  ['vitest-kopt-pass.txt', 'npx vitest run', 0, 'JavaScript / TypeScript', 'real'],
  ['vitest-kopt-fail.txt', 'npx vitest run', 1, 'JavaScript / TypeScript', 'real'],
  ['vitest-kopt-many-fail.txt', 'npx vitest run', 1, 'JavaScript / TypeScript', 'real'],
  ['vitest-kopt-diff-fail.txt', 'npx vitest run', 1, 'JavaScript / TypeScript', 'real'],
  ['build-kopt-fail.txt', 'npm run build', 2, 'JavaScript / TypeScript', 'real'],
  ['node-test-fail.txt', 'npm test', 1, 'JavaScript / TypeScript', 'real'],
  ['node-test-spec-fail.txt', 'node --test --test-reporter=spec', 1, 'JavaScript / TypeScript', 'real'],
  ['node-test-pass.txt', 'npm test', 0, 'JavaScript / TypeScript', 'real'],
  ['node-test-load-fail.txt', 'node --test', 1, 'JavaScript / TypeScript', 'real'],
];

const rows = CASES.map(([file, command, exitCode, family, origin = 'generated']) => {
  const raw = readFileSync(join(FIX, file), 'utf8');
  const normalized = normalizeOutput(raw);
  const r = compressOutput(command, relativizeRoot(normalized, [FIXTURE_ROOT], 'linux'), exitCode, BUDGET);
  const rawTokens = estimateTokens(normalized);
  const outTokens = estimateTokens(r.text);
  return {
    fixture: file,
    command,
    exitCode,
    outcome: exitCode === 0 ? 'pass' : 'fail',
    family,
    origin,
    filter: r.filter,
    rawChars: normalized.length,
    rawTokens,
    outTokens,
    reduction: rawTokens > 0 ? 1 - outTokens / rawTokens : 0,
  };
});

function group(pred) {
  const sel = rows.filter(pred);
  const raw = sel.reduce((s, r) => s + r.rawTokens, 0);
  const out = sel.reduce((s, r) => s + r.outTokens, 0);
  const sorted = sel.map((r) => r.reduction).sort((a, b) => a - b);
  const mid = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : 0;
  return { fixtures: sel.length, rawTokens: raw, outTokens: out, reduction: raw ? 1 - out / raw : 0, medianReduction: mid, minReduction: sorted[0] ?? 0 };
}

const families = [...new Set(rows.map((r) => r.family))];
const result = {
  schema: 'kopt-compression/1',
  generatedBy: 'bench/compress/run.mjs',
  date: new Date().toISOString().slice(0, 10),
  node: process.version,
  budgetTokens: BUDGET,
  charsPerToken: 3,
  note: 'filter output only, against the normalized raw output; a kopt_run answer adds a header and the log handle line (about 20-40 tokens) and, on a failing run with the index ready, up to 200 tokens of source hints',
  totals: {
    all: group(() => true),
    exit0: group((r) => r.outcome === 'pass'),
    exitNonZero: group((r) => r.outcome === 'fail'),
    real: group((r) => r.origin === 'real'),
    generated: group((r) => r.origin === 'generated'),
  },
  byFamily: families.map((f) => ({ family: f, ...group((r) => r.family === f) })),
  rows,
};

const SET_LABELS = { all: 'all', exit0: 'exit 0 (passing runs, git)', exitNonZero: 'exit non-zero (failures)', real: 'real runs', generated: 'generated fixtures' };
const fmt = (n) => n.toLocaleString('en-US');
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const md = [
  '# kopt_run compression on the committed fixtures',
  '',
  `Generated ${result.date} by \`node bench/compress/run.mjs\` (Node ${process.version}) from \`test/fixtures/compress\`, at the`,
  `default kopt_run budget (${BUDGET} tokens). Tokens = characters / 3. "raw" is the output after normalization (ANSI codes`,
  'and progress redraws removed), "kopt" is what the filter returns. A kopt_run answer adds a one-line header and the log',
  'handle line (about 20-40 tokens), and on a failing run with the index ready up to 200 tokens of source hints.',
  '',
  '"generated" fixtures imitate each tool\'s CI output (`test/fixtures/compress/generate.mjs`: long passing runs generated,',
  'failing sections written by hand); "real" fixtures are real runs: this repository\'s own suite and build, and node:test',
  '(TAP and spec reporters) on a small project.',
  '',
  '| set | fixtures | raw tokens | kopt tokens | reduction (total) | median reduction | smallest reduction |',
  '|---|---|---|---|---|---|---|',
  ...Object.entries(result.totals).map(([k, t]) => `| ${SET_LABELS[k]} | ${t.fixtures} | ${fmt(t.rawTokens)} | ${fmt(t.outTokens)} | ${pct(t.reduction)} | ${pct(t.medianReduction)} | ${pct(t.minReduction)} |`),
  '',
  '| fixture | command | exit | origin | filter | raw tokens | kopt tokens | reduction |',
  '|---|---|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.fixture} | \`${r.command}\` | ${r.exitCode} | ${r.origin} | ${r.filter} | ${fmt(r.rawTokens)} | ${fmt(r.outTokens)} | ${pct(r.reduction)} |`),
  '',
];

writeFileSync(`${OUT}.json`, JSON.stringify(result, null, 2) + '\n');
writeFileSync(`${OUT}.md`, md.join('\n'));
console.log(`${rows.length} fixtures · raw ${fmt(result.totals.all.rawTokens)} -> ${fmt(result.totals.all.outTokens)} tokens (${pct(result.totals.all.reduction)}) · ${OUT}.json`);
