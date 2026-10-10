// kopt_run's source hints on a real index: a failing test is followed below the function it calls, to the one that
// produced the failing value (thin wrappers, the setter of a field a diff shows, the function the test is named
// after), and a failure message only points at a function that has it as a string literal.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/core/config.js';
import { estimateTokens } from '../src/core/tokens.js';
import { indexRepo } from '../src/indexer/index.js';
import { assertedFields, failureContext } from '../src/retrieval/failures.js';
import { Store } from '../src/store/store.js';
import { rmTree } from './helpers/fs.js';

const FILES: Record<string, string> = {
  'src/store.ts': [
    'export interface Job { ok: boolean; changed: boolean }',
    'export function save(job: Job) {',
    '  const stored = job.ok && job.changed;',
    "  return { exitCode: 0, stored, text: 'saved' };",
    '}',
    '',
  ].join('\n'),
  'src/run.ts': [
    "import { save, type Job } from './store';",
    'export function runJob(job: Job) {',
    '  const r = save(job);',
    '  return finish(r);',
    '}',
    'function finish(r: object) {',
    '  return { ...r, done: true };',
    '}',
    'export function expand(log: string) {',
    '  return expandLog(log);',
    '}',
    'export function expandLog(log: string) {',
    "  const lines = log.split('\\n');",
    "  return lines.slice(1).join('\\n');",
    '}',
    'export function preToolUse(e: { calls: number }) {',
    '  return { exitCode: e.calls >= 1 ? 2 : 0 };',
    '}',
    'export function handleHook(e: { name: string; calls: number }) {',
    '  switch (e.name) {',
    "    case 'pre':",
    '      return preToolUse(e);',
    '    default:',
    '      return { exitCode: 0 };',
    '  }',
    '}',
    'export function denyReason(path: string) {',
    "  if (path.startsWith('..')) return 'a link that leaves the project';",
    '  return undefined;',
    '}',
    '',
  ].join('\n'),
  'src/total.ts': [
    'export function sumTotal(xs: number[]) {',
    '  let total = 0;',
    '  for (const x of xs) total += x;',
    '  return total;',
    '}',
    '',
  ].join('\n'),
  'test/run.test.ts': [
    "import { describe, expect, it } from 'vitest';",
    "import { expand, handleHook, runJob } from '../src/run';",
    "import { sumTotal } from '../src/total';",
    "describe('runJob', () => {",
    "  it('stores the result', () => {",
    '    const r = runJob({ ok: true, changed: false });',
    '    expect(r).toMatchObject({ stored: true });',
    '  });',
    "  it('pages the log', () => {",
    "    expect(expand('a\\nb')).toBe('a\\nb');",
    '  });',
    "  it('preToolUse blocks after the budget', () => {",
    "    expect(handleHook({ name: 'pre', calls: 1 }).exitCode).toBe(0);",
    '  });',
    "  it('sums', () => {",
    '    expect(sumTotal([1, 2])).toBe(3);',
    '  });',
    '});',
    '',
  ].join('\n'),
};

let root: string;
let store: Store;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'kopt-hints-'));
  for (const [rel, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  const config = defaultConfig(root);
  config.dataDir = join(root, '.kopt');
  store = Store.open(join(root, '.kopt', 'index.db'), { root });
  await indexRepo(store, { config });
});

afterAll(() => {
  store?.close();
  rmTree(root);
});

/** A vitest failure as kopt_run prints it. */
const failure = (title: string, body: string[], line: number) =>
  [`FAIL test/run.test.ts > runJob > ${title}`, ...body.map((l) => `  ${l}`), `  ❯ test/run.test.ts:${line}:5`].join('\n');

describe('assertedFields', () => {
  it('takes the key both sides of a diff name, else the property the assertion reads', () => {
    expect(assertedFields(['- Expected', '+ Received', '  {', '-   "stored": true,', '+   "stored": false,', '  }'])).toEqual({ names: ['stored'], diff: true });
    expect(assertedFields(['- 0', '+ 2'], "    expect(handleHook({ name: 'pre' }).exitCode).toBe(0);")).toEqual({ names: ['exitCode'], diff: false });
    expect(assertedFields([], '    assert refund.amount == Decimal("70.00")')).toEqual({ names: ['amount'], diff: false });
    expect(assertedFields(['- 1', '+ 2'], '    expect(count()).toBe(1);')).toEqual({ names: [], diff: false });
  });
});

describe('failureContext follows a failing test to the function that produced the value', () => {
  it('goes below the called function to the one that sets the field the diff shows', () => {
    const out = failure('stores the result', ['- Expected', '+ Received', '  {', '-   "stored": true,', '+   "stored": false,', '  }', '> expect(r).toMatchObject({ stored: true });'], 7);
    const ctx = failureContext(store, out, 200)!;
    expect(ctx).toMatch(/test test\/run\.test\.ts:7 \(test L5-8\) calls #\w+ runJob src\/run\.ts:2 > #\w+ save src\/store\.ts:2 \(sets stored\)/);
  });

  it('names the function a thin wrapper forwards to', () => {
    const out = failure('pages the log', ['Expected: "a\\nb"', 'Received: "b"', "> expect(expand('a\\nb')).toBe('a\\nb');"], 10);
    const ctx = failureContext(store, out, 200)!;
    expect(ctx).toMatch(/calls #\w+ expand > #\w+ expandLog src\/run\.ts:12/);
  });

  it('picks the function the test is named after among the callees of a dispatcher', () => {
    const out = failure('preToolUse blocks after the budget', ['AssertionError: expected 2 to be +0', '- Expected', '+ Received', '- 0', '+ 2'], 13);
    const ctx = failureContext(store, out, 200)!;
    expect(ctx).toMatch(/calls #\w+ handleHook src\/run\.ts:19 > #\w+ preToolUse src\/run\.ts:16 \(named in the test\)/);
  });

  it('points a message at a function only when the function has it as a string literal', () => {
    const out = failure('sums', ['Expected: "return total"', 'Received: "a link that leaves the project"'], 16);
    const ctx = failureContext(store, out, 200)!;
    expect(ctx).toMatch(/"a link that leaves the project" is written in #\w+ denyReason src\/run\.ts:27/);
    // sumTotal's code reads `return total`, but no string of it does
    expect(ctx).not.toContain('"return total" is written in');
  });

  it('keeps every hint line within the budget', () => {
    const out = [
      failure('stores the result', ['-   "stored": true,', '+   "stored": false,'], 7),
      failure('pages the log', ['Received: "b"'], 10),
      failure('preToolUse blocks after the budget', ['- 0', '+ 2'], 13),
    ].join('\n');
    for (const max of [20, 40, 80, 200]) {
      const c = failureContext(store, out, max);
      if (c) expect(estimateTokens(c)).toBeLessThanOrEqual(max);
    }
  });
});
