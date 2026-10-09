// Resolver precision rules on a small generated multi-language repo.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/core/config.js';
import { indexRepo } from '../src/indexer/index.js';
import { Store } from '../src/store/store.js';

const FILES: Record<string, string> = {
  // Java: reflection on a class literal must not hit the repo's only `getMethod`
  'jv/a/Endpoint.java': 'package a;\npublic class Endpoint {\n  public Object getMethod() { return null; }\n}\n',
  'jv/a/Reflect.java': 'package a;\npublic class Reflect {\n  void go() { Object m = Endpoint.class.getMethod("x"); }\n}\n',
  // Java: unknown receiver + two unrelated classes with the same method -> unresolved
  'jv/b/One.java': 'package b;\npublic class One { public void process() {} }\n',
  'jv/b/Two.java': 'package b;\npublic class Two { public void process() {} }\n',
  'jv/b/Caller.java': 'package b;\npublic class Caller {\n  void go() { make().process(); }\n  Object make() { return null; }\n}\n',
  // Java: declaration in an interface + override in the implementation -> the declaration
  'jv/c/Shape.java': 'package c;\npublic interface Shape { double area(); }\n',
  'jv/c/Square.java': 'package c;\npublic class Square implements Shape { public double area() { return 1; } }\n',
  'jv/c/Report.java': 'package c;\npublic class Report {\n  double total() { return pick().area(); }\n  Shape pick() { return null; }\n}\n',
  // Java: inherited member through two levels of superclasses
  'jv/d/Base.java': 'package d;\npublic class Base { public void hello() {} }\n',
  'jv/d/Mid.java': 'package d;\npublic class Mid extends Base {}\n',
  'jv/d/Leaf.java': 'package d;\npublic class Leaf extends Mid {\n  void run(Leaf other) { hello(); other.hello(); super.hello(); }\n}\n',
  // Kotlin builder function named like the Java class it builds
  'jv/e/Ctx.java': 'package e;\npublic class Ctx { public void refresh() {} }\n',
  'jv/e/CtxExt.kt': 'package e\n\nfun Ctx(init: Ctx.() -> Unit): Ctx = Ctx()\n',
  'jv/f/AppCtx.java': 'package f;\nimport e.Ctx;\npublic class AppCtx extends Ctx {\n  void boot(Ctx c) { c.refresh(); }\n}\n',
  // Python: lowercase class used as a decorator through a package re-export
  'py/lib/__init__.py': 'from .utils import override_settings, helper\n',
  'py/lib/utils.py': 'class override_settings:\n    def __init__(self, **kw):\n        pass\n\n\ndef helper():\n    pass\n',
  'py/app/tests.py': 'from lib import override_settings\nfrom lib import helper as h\n\n\n@override_settings(DEBUG=True)\ndef test_it():\n    h()\n    len([])\n',
  // TypeScript: barrel re-exports and namespace imports
  'ts/lib/format.ts': 'export function formatDate(d: Date): string { return d.toISOString(); }\n',
  'ts/lib/index.ts': "export { formatDate } from './format';\nexport * from './math';\n",
  'ts/lib/math.ts': 'export function sum(a: number, b: number): number { return a + b; }\n',
  'ts/app/main.ts': "import { formatDate, sum } from '../lib';\nimport * as lib from '../lib/math';\n\nexport function main(): string {\n  lib.sum(1, 2);\n  return formatDate(new Date()) + sum(1, 2);\n}\n",
  // C#: partial class split over two files
  'cs/Orders.cs': 'namespace Shop {\n  public partial class Orders {\n    public void Place() {}\n  }\n}\n',
  'cs/Orders.Query.cs': 'namespace Shop {\n  public partial class Orders {\n    public int Count() { return 0; }\n  }\n}\n',
  'cs/Checkout.cs': 'namespace Shop {\n  public class Checkout {\n    private readonly Orders _orders;\n    public void Run() { _orders.Place(); _orders.Count(); }\n  }\n}\n',
  // Go: method of a receiver type declared in another file of the package
  'go/store/store.go': 'package store\n\ntype Store struct{}\n',
  'go/store/save.go': 'package store\n\nfunc (s *Store) Save() error { return nil }\n',
  'go/store/use.go': 'package store\n\nfunc Use(s *Store) { s.Save() }\n',
};

let root: string;
let store: Store;

function target(fromQname: string, name: string, kind?: string): string | null | undefined {
  const row = store.db
    .prepare(
      `SELECT t.qname AS q FROM refs r JOIN symbols f ON f.id = r.from_symbol_id LEFT JOIN symbols t ON t.id = r.to_symbol_id
       WHERE f.qname = ? AND r.name = ? ${kind ? 'AND r.kind = ?' : ''} ORDER BY r.id LIMIT 1`,
    )
    .get(...(kind ? [fromQname, name, kind] : [fromQname, name])) as { q: string | null } | undefined;
  return row === undefined ? undefined : row.q;
}

function targets(fromQname: string, name: string): Array<string | null> {
  return (
    store.db
      .prepare('SELECT t.qname AS q FROM refs r JOIN symbols f ON f.id = r.from_symbol_id LEFT JOIN symbols t ON t.id = r.to_symbol_id WHERE f.qname = ? AND r.name = ? ORDER BY r.id')
      .all(fromQname, name) as Array<{ q: string | null }>
  ).map((r) => r.q);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'kopt-res-'));
  for (const [rel, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  store = Store.open(join(root, '.kopt/index.db'), { root });
  await indexRepo(store, { config: defaultConfig(root) });
});

afterAll(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe('resolver precision', () => {
  it('treats class literals as external receivers', () => {
    expect(target('a.Reflect.go', 'getMethod')).toBeNull();
  });

  it('leaves untyped receivers unresolved in statically typed code when several methods match', () => {
    expect(target('b.Caller.go', 'process')).toBeNull();
  });

  it('prefers the declaration over overrides when the receiver type is the supertype', () => {
    expect(target('c.Report.total', 'area')).toBe('c.Shape.area');
    expect(target('c.Square', 'Shape', 'implement')).toBe('c.Shape');
  });

  it('walks superclasses for implicit this, typed receivers and super', () => {
    expect(targets('d.Leaf.run', 'hello')).toEqual(['d.Base.hello', 'd.Base.hello', 'd.Base.hello']);
  });

  it('prefers the class over a same-named Kotlin builder function', () => {
    expect(target('f.AppCtx', 'Ctx', 'inherit')).toBe('e.Ctx');
    expect(target('f.AppCtx.boot', 'refresh')).toBe('e.Ctx.refresh');
  });

  it('follows Python package re-exports, aliases and lowercase classes', () => {
    expect(target('py.app.tests.test_it', 'override_settings')).toBe('lib.utils.override_settings');
    expect(target('py.app.tests.test_it', 'helper')).toBe('lib.utils.helper');
    expect(target('py.app.tests.test_it', 'len')).toBeNull();
  });

  it('follows TypeScript barrels (named and star re-exports) and namespace imports', () => {
    expect(target('main', 'formatDate', 'call')).toBe('formatDate');
    expect(targets('main', 'sum')).toEqual(['sum', 'sum']);
    const file = store.db.prepare("SELECT f.path AS p FROM refs r JOIN symbols t ON t.id = r.to_symbol_id JOIN files f ON f.id = t.file_id WHERE r.name = 'formatDate' AND r.kind = 'call'").get() as { p: string };
    expect(file.p).toBe('ts/lib/format.ts');
  });

  it('treats C# partial classes as one type', () => {
    expect(target('Shop.Checkout.Run', 'Place')).toBe('Shop.Orders.Place');
    expect(target('Shop.Checkout.Run', 'Count')).toBe('Shop.Orders.Count');
  });

  it('finds Go methods declared in another file of the package', () => {
    expect(target('store.Use', 'Save')).toBe('store.Store.Save');
  });
});
