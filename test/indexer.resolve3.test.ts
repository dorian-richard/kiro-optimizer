// Calls on typed receivers: parameters and fields typed with another package's type (Go `p *policy.Policy`),
// fields of a typed receiver (`s.policy.X()`), and locals initialized from a call (`t := p.NewTransport()`,
// `var x = repo.find()`), in Go, Java, C# and Kotlin. Regression for the gitea miss at
// services/gitproxy/server.go:63 (newServer calls p.NewHTTPTransport on a `*policy.Policy` parameter).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/core/config.js';
import { newToolContext } from '../src/core/context.js';
import { indexRepo } from '../src/indexer/index.js';
import { refs } from '../src/retrieval/index.js';
import { Store } from '../src/store/store.js';
import { rmTree } from './helpers/fs.js';

const FILES: Record<string, string> = {
  'go.mod': 'module example.com/x\n\ngo 1.22\n',
  // Two Policy types and two NewHTTPTransport methods: a name-only guess cannot pick one.
  'modules/egress/policy/policy.go':
    'package policy\n\nimport "net/http"\n\ntype Policy struct{ name string }\n\nfunc New() *Policy { return &Policy{} }\n\n' +
    'func (p *Policy) NewHTTPTransport() *Transport { return &Transport{} }\n\nfunc (p *Policy) NewDialContext() int { return 1 }\n\n' +
    'type Transport struct{ http.Transport }\n\nfunc (t *Transport) CloseIdle() {}\n',
  'modules/other/policy.go':
    'package other\n\ntype Policy struct{}\n\nfunc (p *Policy) NewHTTPTransport() int { return 2 }\n\nfunc (p *Policy) NewDialContext() int { return 2 }\n',
  'services/gitproxy/server.go':
    'package gitproxy\n\nimport (\n\t"example.com/x/modules/egress/policy"\n)\n\n' +
    'type server struct {\n\tpolicy *policy.Policy\n}\n\n' +
    'func newServer(p *policy.Policy) *server {\n\ts := &server{policy: p}\n\ttransport := p.NewHTTPTransport()\n\ttransport.CloseIdle()\n\treturn s\n}\n\n' +
    'func (s *server) dial() int {\n\treturn s.policy.NewDialContext()\n}\n\n' +
    'func build() {\n\tpol := policy.New()\n\tpol.NewDialContext()\n\tvar q = policy.New()\n\tq.NewHTTPTransport()\n}\n',
  // Java / C# / Kotlin: locals declared without a type, initialized from a call
  'jv/app/Doc.java': 'package app;\npublic class Doc { public void render() {} }\n',
  'jv/app/Other.java': 'package app;\npublic class Other { public void render() {} }\n',
  'jv/app/Repo.java': 'package app;\npublic class Repo { public Doc find(String id) { return null; } }\n',
  'jv/app/Use.java':
    'package app;\npublic class Use {\n  void go(Repo repo) {\n    var d = repo.find("x");\n    d.render();\n  }\n}\n',
  'cs/App/Doc.cs': 'namespace App {\n  public class Doc { public void Render() {} }\n  public class Other { public void Render() {} }\n}\n',
  'cs/App/Repo.cs': 'namespace App {\n  public class Repo { public Doc Find(string id) { return null; } }\n}\n',
  'cs/App/Use.cs': 'namespace App {\n  public class Use {\n    void Go(Repo repo) {\n      var d = repo.Find("x");\n      d.Render();\n    }\n  }\n}\n',
  'kt/app/Doc.kt': 'package app\n\nclass Doc { fun render() {} }\nclass Other { fun render() {} }\nclass Repo { fun find(id: String): Doc = Doc() }\n',
  'kt/app/Use.kt': 'package app\n\nfun go(repo: Repo) {\n  val d = repo.find("x")\n  d.render()\n}\n',
  // an interface method and its implementation: one target for kopt_refs
  'jv/tp/ITrickplay.java': 'package tp;\npublic interface ITrickplay { void refreshTrickplayData(String id); }\n',
  'jv/tp/Trickplay.java': 'package tp;\npublic class Trickplay implements ITrickplay {\n  public void refreshTrickplayData(String id) {}\n}\n',
  'jv/tp/Task.java': 'package tp;\npublic class Task {\n  private final ITrickplay manager = null;\n  void execute() {\n    manager.refreshTrickplayData("a");\n  }\n}\n',
};

let root: string;
let store: Store;

/** Qualified name of the target of the first ref named `name` made from symbol `fromQname` (null = unresolved). */
function target(fromQname: string, name: string): string | null | undefined {
  const row = store.db
    .prepare(
      `SELECT t.qname AS q FROM refs r JOIN symbols f ON f.id = r.from_symbol_id LEFT JOIN symbols t ON t.id = r.to_symbol_id
       WHERE f.qname = ? AND r.name = ? ORDER BY r.id LIMIT 1`,
    )
    .get(fromQname, name) as { q: string | null } | undefined;
  return row === undefined ? undefined : row.q;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'kopt-res3-'));
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

describe('Go receivers typed with an imported package type', () => {
  it('resolves a method call on a *pkg.Type parameter (gitea newServer -> Policy.NewHTTPTransport)', () => {
    expect(target('gitproxy.newServer', 'NewHTTPTransport')).toBe('policy.Policy.NewHTTPTransport');
  });

  it('types a local from the call that initializes it, through a package-qualified result type', () => {
    expect(target('gitproxy.newServer', 'CloseIdle')).toBe('policy.Transport.CloseIdle');
    expect(target('gitproxy.build', 'NewDialContext')).toBe('policy.Policy.NewDialContext');
    expect(target('gitproxy.build', 'NewHTTPTransport')).toBe('policy.Policy.NewHTTPTransport');
  });

  it('resolves a call on a field of the receiver (s.policy.X())', () => {
    expect(target('gitproxy.server.dial', 'NewDialContext')).toBe('policy.Policy.NewDialContext');
  });
});

describe('locals initialized from a call (Java, C#, Kotlin)', () => {
  it('types the local from the callee declared result', () => {
    expect(target('app.Use.go', 'render')).toBe('app.Doc.render');
    expect(target('App.Use.Go', 'Render')).toBe('App.Doc.Render');
    expect(target('app.go', 'render')).toBe('app.Doc.render');
  });
});

describe('kopt_refs on an interface method and its implementation', () => {
  it('answers for the whole family instead of listing two candidates', () => {
    const ctx = newToolContext(defaultConfig(root));
    const r = refs(store, { target: 'refreshTrickplayData' }, ctx);
    const out = r.text.split('\n');
    expect(out[0]).toMatch(/^refs #\w+ ITrickplay\.refreshTrickplayData · 1 usage in 1 file · complete · /);
    expect(out[1]).toMatch(/^jv\/tp\/Task\.java:5 in #\w+ Task\.execute \(defined 4-\d+\): /);
    expect(r.text).toContain('complete: every reference to refreshTrickplayData in the index is resolved; the one function whose code names it is listed');
    // either way (one picked, or both counted together) the implementation's callers are the interface's
    const impl = refs(store, { target: 'Trickplay.refreshTrickplayData' }, ctx);
    expect(impl.text.split('\n')[1]).toBe(out[1]);
  });
});
