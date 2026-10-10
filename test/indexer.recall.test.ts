import { describe, expect, it } from 'vitest';
import { extractFile } from '../src/indexer/index.js';
import { checkExtractionRecall, definitionSites } from '../src/indexer/recall.js';

describe('extraction recall check', () => {
  it('finds definition-looking lines per language', () => {
    const py = 'class A:\n    def m(self):\n        def inner():\n            pass\n\n# def commented():\nasync def top():\n    pass\n';
    expect(definitionSites('python', py).map((s) => `${s.line}:${s.keyword}:${s.name}`)).toEqual(['1:class:A', '2:def:m', '3:def:inner', '7:def:top']);
    const java = 'public final class Svc {\n  @Override\n  public List<String> names(int a) {\n    return helper(a);\n  }\n  private static void run() {}\n}\n';
    expect(definitionSites('java', java).map((s) => s.name)).toEqual(['Svc', 'names', 'run']);
    const go = 'package p\n\ntype Store struct{}\n\nfunc (s *Store) Save() error { return nil }\nfunc New() *Store { return nil }\n';
    expect(definitionSites('go', go).map((s) => s.name)).toEqual(['Store', 'Save', 'New']);
    const kt = 'data class P(val a: Int)\nfun <T> List<T>.second(): T = this[1]\ninternal suspend fun load() {}\n';
    expect(definitionSites('kotlin', kt).map((s) => s.name)).toEqual(['P', 'second', 'load']);
  });

  it('counts covered sites, skips locals and reports what is missing', async () => {
    const code = 'class A:\n    def m(self):\n        def inner():\n            pass\n        return inner\n\n\ndef top():\n    pass\n';
    const f = await extractFile('a.py', code);
    const r = checkExtractionRecall('python', code, f!.symbols);
    expect(r).toEqual({ sites: 3, covered: 3, missing: [] });
    // a symbol list that lost `top`
    const lost = checkExtractionRecall('python', code, f!.symbols.filter((s) => s.name !== 'top'));
    expect(lost.sites).toBe(3);
    expect(lost.covered).toBe(2);
    expect(lost.missing.map((m) => `${m.line}:${m.name}`)).toEqual(['8:top']);
  });

  it('would have flagged the members lost to a Kotlin delegation mis-parse', async () => {
    const code = 'class T(private val impl: I) : I by impl {\n  override fun commit() {}\n  fun rollback() {}\n}\n';
    const f = await extractFile('T.kt', code);
    expect(checkExtractionRecall('kotlin', code, f!.symbols)).toMatchObject({ sites: 3, covered: 3 });
    expect(checkExtractionRecall('kotlin', code, f!.symbols.slice(0, 1))).toMatchObject({ sites: 3, covered: 1 });
  });
});
