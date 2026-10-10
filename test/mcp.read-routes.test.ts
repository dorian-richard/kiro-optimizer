// Kiro lists 4 tools: kopt_read also answers what kopt_outline (a directory, a glob, mode outline) and kopt_expand
// (a kopt_run log handle) did, so the fixed prompt carries two tool specs less.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinCommand } from '../src/compress/runner.js';
import { defaultConfig, type KoptConfig } from '../src/core/config.js';
import { newToolContext } from '../src/core/context.js';
import { indexRepo } from '../src/indexer/index.js';
import { withModules } from '../src/mcp/modules.js';
import { executeTool, listedSpelling, parseToolArgs, readRoute, toolNeedsStore, type ToolName } from '../src/mcp/tools.js';
import { Store } from '../src/store/store.js';
import { rmTree } from './helpers/fs.js';

const FILES: Record<string, string> = {
  'src/shop/cart.ts': [
    'export class Cart {',
    '  items: number[] = [];',
    '  add(price: number) {',
    '    this.items.push(price);',
    '  }',
    '  total() {',
    '    return this.items.reduce((a, b) => a + b, 0);',
    '  }',
    '}',
    '',
  ].join('\n'),
  'src/shop/order.ts': 'import { Cart } from "./cart";\nexport function place(c: Cart) {\n  return c.total();\n}\n',
};

let root: string;
let config: KoptConfig;
let store: Store;
const modules = withModules();

async function call(name: ToolName, raw: Record<string, unknown>) {
  const parsed = parseToolArgs(name, raw);
  if (!parsed.ok) throw new Error(parsed.message);
  return executeTool(name, parsed.args, { modules, ctx: newToolContext(config), store: toolNeedsStore(name, parsed.args) || name === 'kopt_run' ? store : undefined });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'kopt-routes-'));
  for (const [rel, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  config = defaultConfig(root);
  config.dataDir = join(root, '.kopt');
  config.telemetry.enabled = false;
  store = Store.open(join(root, '.kopt', 'index.db'), { root });
  await indexRepo(store, { config });
});

afterAll(() => {
  store?.close();
  rmTree(root);
});

describe('readRoute', () => {
  it('sends logs to kopt_expand, the repo, directories and globs to kopt_outline, the rest to read', () => {
    expect(readRoute(root, { target: 'o3fad54' })).toEqual({ kind: 'log', handle: 'o3fad54', start: undefined, end: undefined });
    expect(readRoute(root, { target: 'o3fad54:120-180' })).toEqual({ kind: 'log', handle: 'o3fad54', start: 120, end: 180 });
    expect(readRoute(root, { target: 'O3FAD54:120-' })).toEqual({ kind: 'log', handle: 'o3fad54', start: 120, end: undefined });
    expect(readRoute(root, { target: 'kopt_expand o3fad54' })).toMatchObject({ kind: 'log', handle: 'o3fad54' });
    expect(readRoute(root, { target: '.' })).toEqual({ kind: 'outline' });
    expect(readRoute(root, { target: 'src/shop' })).toEqual({ kind: 'outline', path: 'src/shop' });
    expect(readRoute(root, { target: 'src/**/*.ts' })).toEqual({ kind: 'outline', path: 'src/**/*.ts' });
    expect(readRoute(root, { target: 'src/shop/cart.ts', mode: 'outline' })).toEqual({ kind: 'outline', path: 'src/shop/cart.ts' });
    expect(readRoute(root, { target: 'Cart', mode: 'outline' })).toEqual({ kind: 'skeleton' });
    expect(readRoute(root, { target: 'src/shop/cart.ts' })).toEqual({ kind: 'read' });
    expect(readRoute(root, { target: 'Cart.total' })).toEqual({ kind: 'read' });
    expect(readRoute(root, { target: '../..' })).toEqual({ kind: 'read' }); // outside the project: read refuses it
    expect(toolNeedsStore('kopt_read', { target: 'o3fad54' })).toBe(false);
    expect(toolNeedsStore('kopt_read', { target: 'src/shop' })).toBe(true);
  });
});

describe('kopt_read answers for the folded tools', () => {
  it('a directory or mode outline: the members with their lines', async () => {
    const dir = await call('kopt_read', { target: 'src/shop' });
    expect(dir.text).toMatch(/^outline src\/shop\//);
    expect(dir.text).toContain('cart.ts');
    const file = await call('kopt_read', { target: 'src/shop/cart.ts', mode: 'outline' });
    expect(file.text).toMatch(/^outline src\/shop\/cart\.ts/);
    expect(file.text).toMatch(/L6 +total\(\)/);
    const type = await call('kopt_read', { target: 'Cart', mode: 'outline' });
    expect(type.text).toMatch(/skeleton/);
    expect(type.text).not.toContain('reduce(');
    const code = await call('kopt_read', { target: 'Cart.total' });
    expect(code.text).toContain('return this.items.reduce');
  });

  it('a kopt_run log handle: its lines, a range, a grep; the run output points there', async () => {
    const script = join(root, 'noisy.cjs');
    // process.exitCode, not process.exit(): on Linux a child's stdout is a socket and Node writes to it
    // asynchronously, so process.exit() right after 2000 lines drops the ones still queued in the child
    writeFileSync(script, "for (let i = 0; i < 2000; i++) console.log('row ' + i + ' ok'); console.error('Error: boom at row 1500'); process.exitCode = 1;\n");
    // quoted for kopt_run's shell (PowerShell on Windows needs `& ` before a quoted program)
    const run = await call('kopt_run', { command: joinCommand([process.execPath, 'noisy.cjs']) });
    const handle = /full output: kopt_read (o[0-9a-f]{6}) \(grep=<regex> filters it\)/.exec(run.text)?.[1];
    expect(handle, run.text).toBeDefined();
    const head = await call('kopt_read', { target: handle! });
    expect(head.text.split('\n')[0]).toMatch(new RegExp(`^${handle} lines 1-\\d+ of 2001$`));
    expect(head.text).toMatch(new RegExp(`… \\d+ more lines \\(${handle}:\\d+-\\)$`));
    const range = await call('kopt_read', { target: `${handle}:10-12` });
    expect(range.text).toBe(`${handle} lines 10-12 of 2001\nrow 9 ok\nrow 10 ok\nrow 11 ok`);
    const grep = await call('kopt_read', { target: handle!, grep: 'boom' });
    expect(grep.text).toContain('Error: boom at row 1500');
  });

  it('texts that name the folded tools are spelled as the listed call', () => {
    expect(listedSpelling('next: try other words or kopt_outline . for the repo map')).toBe('next: try other words or kopt_read . for the repo map');
    expect(listedSpelling('Use kopt_outline path=src/a.ts or read a range')).toBe('Use kopt_read src/a.ts or read a range');
    expect(listedSpelling('full output: kopt_expand o1a2b3c')).toBe('full output: kopt_read o1a2b3c');
  });
});

describe('kopt_read access rules through the MCP tool (every route)', () => {
  it('refuses ignored files and folders whatever the route: name-like file, ./path, mode outline, directory', async () => {
    writeFileSync(join(root, '.gitignore'), 'debug.log\nbuild/\n*.pem\n');
    writeFileSync(join(root, 'debug.log'), 'LEAK-log\n');
    writeFileSync(join(root, 'cert.pem'), 'LEAK-pem\n');
    mkdirSync(join(root, 'build'), { recursive: true });
    writeFileSync(join(root, 'build', 'out.ts'), 'export const LEAK = "build";\n');
    for (const args of [
      { target: 'debug.log' },
      { target: './debug.log' },
      { target: 'debug.log', mode: 'outline' },
      { target: 'cert.pem' },
      { target: 'cert.pem', mode: 'outline' },
      { target: 'build' },
      { target: 'build/' },
      { target: 'build/out.ts' },
      { target: 'build/out.ts', mode: 'outline' },
    ]) {
      const r = await call('kopt_read', args);
      expect(r.isError, JSON.stringify(args)).toBe(false);
      expect(r.text, JSON.stringify(args)).toMatch(/not readable through kopt \(excluded by \.gitignore or \.kiroignore\)/);
      expect(r.text).not.toMatch(/LEAK/);
    }
  });
});
