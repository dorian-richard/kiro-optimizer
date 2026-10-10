// Extraction gaps and resolution rules added for large real-world repositories (see bench/results/failures.md).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/core/config.js';
import { extractFile, indexRepo } from '../src/indexer/index.js';
import { parseJsonc, TsConfigs } from '../src/indexer/tsconfig.js';
import { Store } from '../src/store/store.js';
import { rmTree } from './helpers/fs.js';

const FILES: Record<string, string> = {
  // Rust: receiver of unknown type, method declared once in the repo -> linked; twice -> not; generic -> not
  'rs/a/index.rs': 'pub struct Index { inner: Inner }\npub struct Inner;\nimpl Inner {\n  pub fn close_for_resize(&self) {}\n  pub fn reset(&self) {}\n}\n',
  'rs/a/other.rs': 'pub struct Other;\nimpl Other { pub fn reset(&self) {} }\n',
  'rs/a/use.rs': 'use crate::index::Index;\npub fn shrink(i: &Index) {\n  i.inner.close_for_resize();\n  i.inner.reset();\n  i.inner.clone();\n}\n',
  // Rust: `impl` block of a struct declared in another module
  'rs/b/rules.rs': 'pub struct Rules;\n',
  'rs/c/rules_impl.rs': 'use crate::b::rules::Rules;\nimpl Rules {\n  pub fn search_rules(&self) {}\n}\n',
  'rs/c/caller.rs': 'use crate::b::rules::Rules;\npub fn go(r: Rules) { r.search_rules(); }\n',
  // Go: method called on a returned value
  'go/policy/policy.go': 'package policy\n\ntype Policy struct{}\n\nfunc NewOpenIDPolicy() *Policy { return &Policy{} }\n\nfunc (p *Policy) NewHTTPTransport() int { return 1 }\n',
  'go/web/web.go': 'package web\n\nimport "example.com/x/go/policy"\n\nfunc Serve() { policy.NewOpenIDPolicy().NewHTTPTransport() }\n',
  // Rust: a std method name declared once in the repo is still std's on an unknown receiver
  'rs/d/wrapper.rs': 'pub struct Wrapper;\nimpl Wrapper { pub fn checked_sub(&self) {} }\n',
  'rs/e/conv.rs': 'pub fn calc(cap: usize) { cap.saturating_div(2).checked_sub(1); }\n',
  // Java: library calls through untyped chains are not linked by name (String.startsWith, Stream.toList)
  'jv/q/Matcher.java': 'package q;\npublic class Matcher { public boolean startsWith(String p) { return true; } }\n',
  'jv/q/Job.java': 'package q;\npublic class Job {\n  boolean go(String className) { return className.startsWith("javax."); }\n}\n',
  // C#: extension methods on string; Kotlin: extension functions on a repo class and on String
  'cs/Ext/StringExtensions.cs': 'namespace Ext {\n  public static class StringExtensions {\n    public static string GetMD5(this string s) { return s; }\n  }\n}\n',
  'cs/App/Prefs.cs': 'using Ext;\nnamespace App {\n  public class Prefs {\n    public string Key(string id) { id.ToString(); return id.GetMD5(); }\n  }\n  public class Other { public override string ToString() { return ""; } }\n}\n',
  'kt/core/Tx.kt': 'package core\n\nclass Transaction(val id: Int)\n',
  'kt/ext/TxExt.kt': 'package ext\n\nimport core.Transaction\n\nfun Transaction.commitQuietly(): Boolean = true\nfun <T> List<T>.secondOrNull(): T? = getOrNull(1)\nfun String.shout(): String = uppercase()\n',
  'kt/app/Use.kt': 'package app\n\nimport core.Transaction\nimport ext.commitQuietly\n\nfun run(tx: Transaction, name: String) {\n  tx.commitQuietly()\n  name.shout()\n}\n',
  // Call chains typed from the inner call's declared return type
  'jv/r/ReaderContext.java': 'package r;\npublic class ReaderContext { public void fireComponentRegistered(Object c) {} }\n',
  'jv/r/XmlReaderContext.java': 'package r;\npublic class XmlReaderContext extends ReaderContext {}\n',
  'jv/r/Builder.java': 'package r;\npublic class Builder {\n  public static Builder create() { return new Builder(); }\n  public Builder withName(String n) { return this; }\n  public Doc build() { return null; }\n}\n',
  'jv/r/Doc.java': 'package r;\npublic class Doc { public void render() {} }\n',
  'jv/r/Reader.java':
    'package r;\npublic class Reader {\n  protected XmlReaderContext getReaderContext() { return null; }\n  void go() {\n    getReaderContext().fireComponentRegistered(null);\n    Builder.create().withName("x").build().render();\n    new Builder().build().render();\n  }\n}\n',
  'kt/chain/Db.kt': 'package chain\n\nclass Session { fun commitAll() {} }\nfun newSession(name: String): Session = Session()\nfun use() { newSession("a").commitAll() }\n',
  'rs/chain/cfg.rs': 'pub struct Engine;\nimpl Engine {\n  pub fn new() -> Self { Engine }\n  pub fn start_engine(&self) {}\n}\npub fn boot() { Engine::new().start_engine(); }\n',
  'ts/chain/cart.ts':
    'export class Cart { total(): number { return 1; } }\nexport class CartService {\n  async getCart(id: string): Promise<Cart> { return new Cart(); }\n  async run() { return (await this.getCart("x")).total(); }\n}\n',
  // Python barrels: `from x import *` (even next to `from x import __all__`) is followed, a named or
  // function-local import of another module is not
  'py/dj/__init__.py': '',
  'py/dj/models/__init__.py': 'from dj.models.fields import *\nfrom dj.models.fields import __all__ as fields_all\n',
  'py/dj/models/fields.py': '__all__ = ["CharField"]\n\n\nclass CharField:\n    pass\n',
  'py/dj/forms/__init__.py': 'from dj.forms.widgets import *\nfrom dj.forms.fields import *\n',
  'py/dj/forms/widgets.py': 'class Widget:\n    def render(self):\n        from dj.models import CharField\n        return CharField\n',
  'py/dj/forms/fields.py': 'class CharField:\n    pass\n',
  'py/dj/app.py': 'from dj import forms, models\n\n\nclass Name(forms.CharField):\n    pass\n\n\nclass Col(models.CharField):\n    pass\n',
  // TypeScript: tsconfig paths (with comments and extends) and a barrel with export *
  'packages/mod/tsconfig.base.json': '{\n  // shared\n  "compilerOptions": { "paths": { "@utils": ["./src/utils"], "@/*": ["./src/*"], }, },\n}\n',
  'packages/mod/tsconfig.json': '{ "extends": "./tsconfig.base.json", "compilerOptions": { "strict": true } }\n',
  'packages/mod/src/utils/index.ts': "export * from './rules';\n",
  'packages/mod/src/utils/rules.ts': 'export function areRulesValidForContext(): boolean { return true; }\n',
  'packages/mod/src/lib/money.ts': 'export function toCents(n: number): number { return n * 100; }\n',
  'packages/mod/src/services/svc.ts':
    "import { areRulesValidForContext } from '@utils';\nimport { toCents } from '@/lib/money';\nexport function check(): boolean { toCents(1); return areRulesValidForContext(); }\n",
  // PHP: class constants
  'php/Repository.php': '<?php\nnamespace App;\nclass Repository {\n  const FLEXIBLE_CREATED_KEY_PREFIX = "x";\n  public function key() { return self::FLEXIBLE_CREATED_KEY_PREFIX; }\n}\n',
  'php/Cache.php': '<?php\nnamespace App;\nclass Cache {\n  public function flexible() { return Repository::FLEXIBLE_CREATED_KEY_PREFIX . Repository::class; }\n}\n',
  // JavaScript: CommonJS class expressions
  'js/lib/Base.js': 'class NullDependency {}\nNullDependency.Template = class NullDependencyTemplate { apply() {} };\nmodule.exports = NullDependency;\n',
  'js/lib/Dep.js':
    "const NullDependency = require('./Base');\nclass AMDDependency extends NullDependency {}\nAMDDependency.Template = class AMDDependencyTemplate extends NullDependency.Template {\n  apply() { this.replace(); }\n  replace() {}\n};\nmodule.exports = AMDDependency;\n",
  'js/lib/Multi.js': 'module.exports = class MultiCompiler {\n  run() { return 1; }\n};\n',
  'js/legacy/ctrl.js':
    "(function () {\n  'use strict';\n  angular.module('app').controller('OrderCtrl', OrderCtrl);\n  function OrderCtrl($scope) { loadOrders($scope); }\n  function loadOrders(s) { return s; }\n})();\n!function () { function bang() {} }();\n(function () { var helper = function () {}; }).call(this);\n",
  // Python: class built by a factory function, function aliases
  'py/pkg/__init__.py': '',
  'py/pkg/related.py':
    'def create_manager(superclass):\n    class ManyRelatedManager(superclass):\n        def _add_items(self, *objs):\n            return resolve_callables(objs)\n    return ManyRelatedManager\n\n\ndef resolve_callables(m):\n    return m\n',
  'py/pkg/translation.py': 'from functools import lazy\n\n\ndef gettext(m):\n    return m\n\n\ngettext_lazy = lazy(gettext, str)\nugettext = gettext\nlogger = get_logger()\n',
  'py/pkg/models.py': 'from pkg.translation import gettext_lazy as _\n\n\ndef label():\n    return _("x")\n',
  'py/tests/test_things.py': 'def test_local():\n    class Fixture:\n        def go(self):\n            pass\n',
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

function kindOf(qname: string): string | undefined {
  return (store.db.prepare('SELECT kind FROM symbols WHERE qname = ?').get(qname) as { kind: string } | undefined)?.kind;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'kopt-res2-'));
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

describe('method calls on receivers of unknown type', () => {
  it('links a distinctive name declared once in the repo (Rust, Go)', () => {
    expect(target('shrink', 'close_for_resize')).toBe('Inner.close_for_resize');
    expect(target('web.Serve', 'NewHTTPTransport')).toBe('policy.Policy.NewHTTPTransport');
  });

  it('leaves names declared twice, generic, standard-library or JVM names unresolved', () => {
    expect(target('shrink', 'reset')).toBeNull();
    expect(target('shrink', 'clone')).toBeNull();
    expect(target('calc', 'checked_sub')).toBeNull();
    expect(target('q.Job.go', 'startsWith')).toBeNull();
  });

  it('finds Rust methods of an impl block in another module', () => {
    expect(target('go', 'search_rules')).toBe('Rules.search_rules');
  });
});

describe('call chains', () => {
  it('types the receiver from the declared return type of the call that produced it', () => {
    expect(target('r.Reader.go', 'fireComponentRegistered')).toBe('r.ReaderContext.fireComponentRegistered');
    expect(target('r.Reader.go', 'withName')).toBe('r.Builder.withName');
    expect(target('r.Reader.go', 'build')).toBe('r.Builder.build');
    expect(target('r.Reader.go', 'render')).toBe('r.Doc.render');
    expect(target('chain.use', 'commitAll')).toBe('chain.Session.commitAll');
    expect(target('boot', 'start_engine')).toBe('Engine.start_engine');
    expect(target('CartService.run', 'total')).toBe('Cart.total');
  });
});

describe('package re-exports', () => {
  it('follows wildcard imports only', () => {
    expect(target('dj.app.Name', 'CharField', 'inherit')).toBe('dj.forms.fields.CharField');
    expect(target('dj.app.Col', 'CharField', 'inherit')).toBe('dj.models.fields.CharField');
  });
});

describe('extension methods', () => {
  it('links calls on builtin or repo types to C# extension methods and Kotlin extension functions', () => {
    expect(target('App.Prefs.Key', 'GetMD5')).toBe('Ext.StringExtensions.GetMD5');
    expect(target('app.run', 'commitQuietly')).toBe('ext.commitQuietly');
    expect(target('app.run', 'shout')).toBe('ext.shout');
  });

  it('never links a call on a builtin-typed receiver to an unrelated repository method', () => {
    expect(target('App.Prefs.Key', 'ToString')).toBeNull();
  });
});

describe('TypeScript path aliases', () => {
  it('follows tsconfig paths (extends, comments) and export * barrels', () => {
    expect(target('check', 'areRulesValidForContext')).toBe('areRulesValidForContext');
    expect(target('check', 'toCents')).toBe('toCents');
    const imports = store.db
      .prepare("SELECT fi.spec AS spec, t.path AS target FROM file_imports fi JOIN files f ON f.id = fi.file_id LEFT JOIN files t ON t.id = fi.target_file_id WHERE f.path = 'packages/mod/src/services/svc.ts' ORDER BY fi.spec")
      .all() as Array<{ spec: string; target: string | null }>;
    expect(imports).toEqual([
      { spec: '@/lib/money', target: 'packages/mod/src/lib/money.ts' },
      { spec: '@utils', target: 'packages/mod/src/utils/index.ts' },
    ]);
  });

  it('parses the tsconfig dialect and matches the longest pattern', () => {
    expect(parseJsonc('{ /* c */ "a": "x // not a comment", "b": [1, 2,], }')).toEqual({ a: 'x // not a comment', b: [1, 2] });
    const cfgs = new TsConfigs(root);
    const cfg = cfgs.forDir('packages/mod/src/services')!;
    expect(cfgs.candidates('@/lib/money', cfg)).toEqual(['packages/mod/src/lib/money']);
    expect(cfgs.candidates('@utils', cfg)).toEqual(['packages/mod/src/utils']);
    expect(cfgs.candidates('lodash', cfg)).toEqual([]);
    expect(cfgs.forDir('rs/a')).toBeNull();
  });
});

describe('PHP class constants', () => {
  it('links Class::CONST and self::CONST to the constant, and Class to the class', () => {
    expect(target('App.Cache.flexible', 'FLEXIBLE_CREATED_KEY_PREFIX')).toBe('App.Repository.FLEXIBLE_CREATED_KEY_PREFIX');
    expect(target('App.Repository.key', 'FLEXIBLE_CREATED_KEY_PREFIX')).toBe('App.Repository.FLEXIBLE_CREATED_KEY_PREFIX');
    expect(target('App.Cache.flexible', 'Repository', 'type_ref')).toBe('App.Repository');
  });
});

describe('JavaScript class expressions', () => {
  it('indexes classes assigned to module.exports and to properties', () => {
    expect(kindOf('MultiCompiler')).toBe('class');
    expect(kindOf('MultiCompiler.run')).toBe('method');
    expect(kindOf('AMDDependencyTemplate')).toBe('class');
    expect(kindOf('AMDDependencyTemplate.replace')).toBe('method');
    expect(target('AMDDependencyTemplate.apply', 'replace')).toBe('AMDDependencyTemplate.replace');
  });

  it('indexes the declarations of a top-level IIFE (pre-module scripts)', () => {
    expect(kindOf('OrderCtrl')).toBe('function');
    expect(kindOf('loadOrders')).toBe('function');
    expect(kindOf('bang')).toBe('function');
    expect(target('OrderCtrl', 'loadOrders')).toBe('loadOrders');
  });
});

describe('Python', () => {
  it('indexes classes built inside factory functions, not test fixtures', () => {
    expect(kindOf('pkg.related.create_manager.ManyRelatedManager')).toBe('class');
    expect(kindOf('pkg.related.create_manager.ManyRelatedManager._add_items')).toBe('method');
    expect(target('pkg.related.create_manager.ManyRelatedManager._add_items', 'resolve_callables')).toBe('pkg.related.resolve_callables');
    expect(kindOf('tests.test_things.test_local.Fixture')).toBeUndefined();
  });

  it('indexes module-level function aliases and resolves calls to them', async () => {
    expect(kindOf('pkg.translation.gettext_lazy')).toBe('function');
    expect(kindOf('pkg.translation.ugettext')).toBe('function');
    expect(kindOf('pkg.translation.logger')).toBeUndefined();
    expect(target('pkg.models.label', 'gettext_lazy')).toBe('pkg.translation.gettext_lazy');
    const f = await extractFile('t.py', 'x = lazy(f, str)\n');
    expect(f!.symbols[0].signature).toBe('x = lazy(f, str)');
  });
});
