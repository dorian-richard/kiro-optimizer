// Member reads and writes (`obj.field`, `this.x = v`, `x.n++`): extracted as `read` / `write` refs in every
// language with member access syntax, resolved to field / property symbols like calls are (receiver types,
// `this`, same file, imports), never by a repository-wide unique name, and listed by kopt_refs on a field.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/core/config.js';
import { newToolContext } from '../src/core/context.js';
import type { ExtractedFile } from '../src/core/types.js';
import { extractFile, indexRepo } from '../src/indexer/index.js';
import { find, refs } from '../src/retrieval/index.js';
import { Store } from '../src/store/store.js';
import { rmTree } from './helpers/fs.js';

async function members(path: string, code: string): Promise<string[]> {
  const f = (await extractFile(path, code)) as ExtractedFile;
  return f.refs.filter((r) => r.kind === 'read' || r.kind === 'write').map((r) => `${r.kind} ${r.qualifier ?? ''}.${r.name}`);
}

describe('extraction of member reads and writes', () => {
  it('Java: field accesses, assignments, increments; types and package paths are not fields', async () => {
    const m = await members('A.java', 'class A { Foo foo; void f(B b) { this.foo.bar = 1; b.count++; int x = b.total; java.util.List.of(); Outer.Inner.go(); y = Color.RED; foo.x.y(); } }');
    expect(m).toEqual(['write this.foo.bar', 'read this.foo', 'write b.count', 'read b.total', 'read Color.RED', 'read foo.x']);
  });

  it('TypeScript: reads, writes, callbacks; CommonJS exports, import.meta, process.env and generic untyped names are skipped', async () => {
    const m = await members(
      'a.ts',
      'class A { private svc: Svc; f() { this.svc.cfg.timeout = 3; module.exports.x = 1; exports.y = 2; import.meta.url; process.env.HOME; g(this.handler); res.data.items; this.svc.name; } }',
    );
    expect(m).toEqual(['write this.svc.cfg.timeout', 'read this.svc.cfg', 'read this.svc', 'read this.handler', 'read this.svc.name']);
  });

  it('Python: attribute reads and assignments, augmented assignments', async () => {
    const m = await members('a.py', 'class A:\n    def f(self, b: B):\n        self.x = 1\n        self.y.z += 2\n        v = b.total\n');
    expect(m).toEqual(['write self.x', 'write self.y.z', 'read self.y', 'read b.total']);
  });

  it('C#, Kotlin, Go, Rust, PHP, Scala', async () => {
    expect(await members('A.cs', 'class A { void F() { this.svc.B = 1; x.Y += 2; z.N++; var q = new Foo { Bar = 1 }; G(h.P); bool k = !m.Q; } }')).toEqual([
      'write this.svc.B',
      'read this.svc',
      'write x.Y',
      'write z.N',
      'write Foo.Bar',
      'read h.P',
      'read m.Q',
    ]);
    expect(await members('A.kt', 'class A(val svc: Svc) { fun f() { this.svc.cfg = 1; x.y += 2; val z = q.r; n.c++ } }')).toEqual([
      'read this.svc',
      'write this.svc.cfg',
      'write x.y',
      'read q.r',
      'write n.c',
    ]);
    expect(
      await members('a.go', 'package p\nimport "net/http"\nfunc (s *Server) F() { s.a.b = 1; a, s.c = 1, 2; s.n++; g(h.Field, http.StatusOK); c := &Client{Transport: t} }'),
    ).toEqual(['write s.a.b', 'read s.a', 'write s.c', 'write s.n', 'read h.Field', 'write Client.Transport']);
    expect(await members('a.rs', 'impl S { fn f(&self) { self.a.b = 1; x.y += 2; let q = Foo { bar: 1, baz }; match k { Kind::A => 1, _ => 2 }; g(t.0, Self::MAX); } }')).toEqual([
      'write self.a.b',
      'read self.a',
      'write x.y',
      'write Foo.bar',
      'write Foo.baz',
      'read Kind.A',
      'read Self.MAX',
    ]);
    expect(await members('a.php', '<?php class A { function f() { $this->a->b = 1; $x->y .= 2; $q = $o?->r; self::$cache = 1; $this->repo->find(); } }')).toEqual([
      'write $this->a.b',
      'read $this.a',
      'write $x.y',
      'read $o.r',
      'write self.cache',
      'read $this.repo',
    ]);
    expect(await members('A.scala', 'object O { def f() = { this.a.b = 1; x.y += 2; val q = o.r; s.m(1) } }')).toEqual(['write this.a.b', 'read this.a', 'write x.y', 'read o.r']);
  });

  it('keeps the calls made inside a computed member name (PHP `$this->{...}`)', async () => {
    const f = (await extractFile('a.php', '<?php class A { function f() { return $this->{$this->getKeyName()}; } }')) as ExtractedFile;
    expect(f.refs.map((r) => `${r.kind} ${r.name}`)).toEqual(['call getKeyName']);
  });
});

const FILES: Record<string, string> = {
  'jv/app/Config.java': 'package app;\npublic class Config {\n  public int timeout;\n  public static final int MAX = 3;\n}\n',
  'jv/app/Other.java': 'package app;\npublic class Other {\n  public int timeout;\n}\n',
  'jv/app/Client.java':
    'package app;\npublic class Client {\n  private Config config;\n  int wait(Config c) {\n    return c.timeout + Config.MAX;\n  }\n' +
    '  void set() {\n    this.config.timeout = 5;\n  }\n  int own() {\n    return this.config.timeout;\n  }\n}\n',
  // JS: a property declared only in a .d.ts, read through an untyped receiver: never linked by name alone
  'web/types.d.ts': 'declare interface KnownBuildInfo {\n  isCircular?: boolean;\n}\n',
  'web/lib/a.js': 'function useIt(module) {\n  return module.buildInfo.isCircular === false;\n}\nmodule.exports = { useIt };\n',
  'web/lib/b.js': 'function setIt(buildInfo) {\n  buildInfo.isCircular = true;\n}\nmodule.exports = { setIt };\n',
  'go/cfg/cfg.go': 'package cfg\n\ntype Settings struct {\n\tURL string\n}\n\nvar App = Settings{}\n',
  'go/web/web.go':
    'package web\n\nimport "example.com/x/go/cfg"\n\nfunc home(s *cfg.Settings) string {\n\treturn s.URL\n}\n\nfunc build() *cfg.Settings {\n\treturn &cfg.Settings{URL: "x"}\n}\n',
  'go.mod': 'module example.com/x\n\ngo 1.22\n',
};

let root: string;
let store: Store;

function target(fromQname: string, name: string, kind: string): string | null | undefined {
  const row = store.db
    .prepare(
      `SELECT t.qname AS q FROM refs r JOIN symbols f ON f.id = r.from_symbol_id LEFT JOIN symbols t ON t.id = r.to_symbol_id
       WHERE f.qname = ? AND r.name = ? AND r.kind = ? ORDER BY r.id LIMIT 1`,
    )
    .get(fromQname, name, kind) as { q: string | null } | undefined;
  return row === undefined ? undefined : row.q;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'kopt-members-'));
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

describe('resolution of member reads and writes', () => {
  it('links reads and writes through typed receivers, this-fields and static types', () => {
    expect(target('app.Client.wait', 'timeout', 'read')).toBe('app.Config.timeout');
    expect(target('app.Client.wait', 'MAX', 'read')).toBe('app.Config.MAX');
    expect(target('app.Client.set', 'timeout', 'write')).toBe('app.Config.timeout');
    expect(target('app.Client.set', 'config', 'read')).toBe('app.Client.config');
    expect(target('web.home', 'URL', 'read')).toBe('cfg.Settings.URL');
    expect(target('web.build', 'URL', 'write')).toBe('cfg.Settings.URL');
  });

  it('never links a member read by a repository-wide unique name', () => {
    expect(target('useIt', 'isCircular', 'read')).toBeNull();
    expect(target('setIt', 'isCircular', 'write')).toBeNull();
  });

  it('leaves member reads out of the centrality ranks', () => {
    const rank = store.db.prepare("SELECT rank FROM symbols WHERE qname = 'app.Config.timeout'").get() as { rank: number };
    expect(rank.rank).toBe(0);
  });
});

describe('kopt_refs and pack on a field', () => {
  it('lists the readers and writers of a field, tagged, with read/write counts', () => {
    const ctx = newToolContext(defaultConfig(root));
    const r = refs(store, { target: 'Config.timeout' }, ctx);
    const out = r.text.split('\n');
    expect(out[0]).toMatch(/^refs #\w+ Config\.timeout · 3 usages in 1 file \(2 reads, 1 write\) · complete · /);
    expect(r.text).toContain('jv/app/Client.java:5 read in ');
    expect(r.text).toMatch(/jv\/app\/Client\.java:8 write in #\w+ Client\.set \(defined 7-9\): this\.config\.timeout = 5;/);
  });

  it('lists unresolved reads and writes of a property as possible users, and says the list is incomplete', () => {
    const ctx = newToolContext(defaultConfig(root));
    const r = refs(store, { target: 'KnownBuildInfo.isCircular' }, ctx);
    expect(r.text).toContain('possible (unresolved refs named isCircular):');
    expect(r.text).toMatch(/\? web\/lib\/a\.js:2 read in #\w+ useIt \(defined 1-3\): return module\.buildInfo\.isCircular === false;/);
    expect(r.text).toMatch(/\? web\/lib\/b\.js:2 write in #\w+ setIt \(defined 1-3\)/);
    expect(r.text.split('\n').pop()).toBe('incomplete: 2 unresolved references named isCircular (receiver type unknown) may be reads or writes of it (listed under possible)');
    const p = find(store, { query: 'Config.timeout', mode: 'pack' }, ctx);
    expect(p.text).toMatch(/^users of #\w+ Config\.timeout · 3 refs in 1 file · complete:$/m);
  });

  it('summarizes the fields a function reads and writes on one line of its callees', () => {
    const ctx = newToolContext(defaultConfig(root));
    const out = refs(store, { target: 'Client.set', direction: 'out' }, ctx).text.split('\n');
    expect(out.at(-1)).toMatch(/^fields: reads #\w+ Client\.config; writes #\w+ Config\.timeout$/);
  });
});
