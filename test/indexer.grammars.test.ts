import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExtractedFile } from '../src/core/types.js';
import { extractFile } from '../src/indexer/index.js';
import { grammarPath, grammarPaths, loadGrammarFrom, parserFor, VENDOR_GRAMMAR_DIR, vendoredGrammar, verifiedGrammarBytes } from '../src/indexer/languages.js';
import { blank, kotlinFix } from '../src/indexer/sourcefix.js';

async function ex(path: string, code: string): Promise<ExtractedFile> {
  const f = await extractFile(path, code);
  if (!f) throw new Error(`no extraction for ${path}`);
  return f;
}

async function hasError(lang: 'kotlin' | 'scala' | 'rust', code: string): Promise<boolean> {
  const tree = (await parserFor(lang)).parse(code)!;
  try {
    return tree.rootNode.hasError;
  } finally {
    tree.delete();
  }
}

const qnames = (f: ExtractedFile) => f.symbols.map((s) => `${s.kind} ${s.qualifiedName}`);

describe('grammar sources', () => {
  afterEach(() => vi.restoreAllMocks());

  it('prefers the vendored builds and keeps tree-sitter-wasms as a fallback', () => {
    expect(grammarPath('scala')).toMatch(/vendor[\\/]grammars[\\/]tree-sitter-scala\.wasm$/);
    expect(grammarPath('rust')).toMatch(/vendor[\\/]grammars[\\/]tree-sitter-rust\.wasm$/);
    expect(grammarPaths('scala').at(-1)).toMatch(/tree-sitter-wasms[\\/]out[\\/]tree-sitter-scala\.wasm$/);
    expect(grammarPaths('java')).toHaveLength(1);
  });

  it('ships the vendored files with matching checksums, licenses and SHA256SUMS', () => {
    const sums = readFileSync(join(VENDOR_GRAMMAR_DIR, 'SHA256SUMS'), 'utf8');
    for (const g of ['scala', 'rust']) {
      const v = vendoredGrammar(g)!;
      expect(verifiedGrammarBytes(v)).toBeInstanceOf(Uint8Array);
      expect(sums).toContain(`${v.sha256}  tree-sitter-${g}.wasm`);
      expect(readFileSync(join(VENDOR_GRAMMAR_DIR, `LICENSE.tree-sitter-${g}`), 'utf8')).toMatch(/MIT License/);
    }
    const pkg = JSON.parse(readFileSync(join(VENDOR_GRAMMAR_DIR, '..', '..', 'package.json'), 'utf8'));
    expect(pkg.files).toContain('vendor');
    expect(Object.keys(pkg.dependencies).filter((d) => d.startsWith('@lumis-sh/'))).toEqual([]);
  });

  it('falls back to tree-sitter-wasms when a vendored file does not match its checksum', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kopt-grammars-'));
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      copyFileSync(vendoredGrammar('rust')!.path, join(dir, 'tree-sitter-rust.wasm'));
      const bytes = readFileSync(join(dir, 'tree-sitter-rust.wasm'));
      bytes[bytes.length - 1] ^= 1;
      writeFileSync(join(dir, 'tree-sitter-rust.wasm'), bytes);
      expect(verifiedGrammarBytes(vendoredGrammar('rust', dir)!)).toBeUndefined();
      const lang = await loadGrammarFrom('rust', dir);
      // the 2023 tree-sitter-wasms build is ABI 14, the vendored 0.24 grammar ABI 15
      expect(lang.abiVersion).toBeLessThan((await loadGrammarFrom('rust', VENDOR_GRAMMAR_DIR)).abiVersion);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/does not match its SHA-256.*tree-sitter-wasms/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('scala (tree-sitter-scala 0.26)', () => {
  const code = [
    'package play.api.cache',
    'import play.api.mvc._',
    'import play.api.{Configuration, Environment => Env}',
    'import scala.concurrent.Future',
    'import a.b.C as D',
    '@Singleton',
    'class Cached @Inject() (cache: AsyncCacheApi)(implicit mat: Materializer) extends Base[Int](1) with Foo {',
    '  private[cache] def apply(key: String): CachedBuilder = new CachedBuilder(cache, key)',
    '  def run(xs: List[Int]) = xs.map { x => helper.go(x) }',
    '  val anon = new Runnable { def run(): Unit = () }',
    '  def typed = cache.get[String]("k")',
    '}',
    'sealed trait Shape',
    'enum Color { case Red, Green }',
    '',
  ].join('\n');

  it('parses modern Scala without errors', async () => {
    expect(await hasError('scala', code)).toBe(false);
  });

  it('extracts members under their class, enum cases and nothing from anonymous classes', async () => {
    const f = await ex('Cached.scala', code);
    expect(qnames(f)).toEqual([
      'class play.api.cache.Cached',
      'method play.api.cache.Cached.apply',
      'method play.api.cache.Cached.run',
      'property play.api.cache.Cached.anon',
      'method play.api.cache.Cached.typed',
      'trait play.api.cache.Shape',
      'enum play.api.cache.Color',
      'constant play.api.cache.Color.Red',
      'constant play.api.cache.Color.Green',
    ]);
  });

  it('reads imports from path segments and selectors', async () => {
    const f = await ex('Cached.scala', code);
    expect(f.imports).toEqual(['play.api.mvc.*', 'play.api', 'scala.concurrent.Future', 'a.b.C']);
    const imports = f.refs.filter((r) => r.kind === 'import').map((r) => `${r.qualifier}.${r.name}`);
    expect(imports).toEqual(['play.api.Configuration', 'play.api.Environment', 'scala.concurrent.Future', 'a.b.C']);
    expect(f.refs.some((r) => r.kind === 'call' && r.name === 'go' && r.qualifier === 'helper')).toBe(true);
    expect(f.refs.some((r) => r.kind === 'type_ref' && r.name === 'Inject')).toBe(true);
    expect(f.refs.some((r) => r.kind === 'type_ref' && r.name === 'Materializer')).toBe(true);
  });
});

describe('rust (tree-sitter-rust 0.24)', () => {
  it('parses let-else and async closures', async () => {
    const code = 'fn f(x: Option<u8>) -> u8 {\n  let Some(y) = x else { return 0 };\n  let c = async move || { y };\n  y\n}\n';
    expect(await hasError('rust', code)).toBe(false);
  });
});

describe('kotlin source fixes', () => {
  it('recovers the body of a class that delegates an interface', async () => {
    const code = [
      'package p',
      'open class JdbcTransaction(private val impl: TransactionInterface) : TransactionInterface by impl {',
      '  override fun commit() { impl.commit() }',
      '  val maxAttempts: Int = 3',
      '  companion object { const val Z = 2 }',
      '}',
      '',
    ].join('\n');
    const f = await ex('T.kt', code);
    expect(qnames(f)).toEqual([
      'class p.JdbcTransaction',
      'property p.JdbcTransaction.impl',
      'method p.JdbcTransaction.commit',
      'property p.JdbcTransaction.maxAttempts',
      'constant p.JdbcTransaction.Z',
    ]);
    // signatures still show the original text
    expect(f.symbols[0].signature).toContain('TransactionInterface by impl');
    expect(f.refs.some((r) => r.kind === 'implement' && r.name === 'TransactionInterface')).toBe(true);
  });

  it('recovers object expressions that delegate', async () => {
    const code = 'fun wrap(orig: Api): Api {\n  return object : Api by orig {\n    override fun g() = helper()\n  }\n}\n';
    expect(await hasError('kotlin', code)).toBe(false);
    const f = await ex('W.kt', code);
    expect(f.refs.some((r) => r.kind === 'call' && r.name === 'helper')).toBe(true);
  });

  it('parses infix calls starting with e, guards, multi-dollar strings and qualified receivers', async () => {
    const code = [
      'fun q(t: Table, id: Int) = t.selectAll().where { t.id eq id }.single()',
      'fun g(x: Any) = when (x) {',
      '  is String if x.isNotEmpty() -> 1',
      '  else -> 2',
      '}',
      'val s = $$"a $b"',
      'fun conf(configure: (DatabaseConfig.Builder.() -> Unit)? = null) {}',
      '',
    ].join('\n');
    expect(await hasError('kotlin', code)).toBe(false);
    const f = await ex('Q.kt', code);
    expect(qnames(f)).toEqual(['function q', 'function g', 'constant s', 'function conf']);
    // node text comes from the original source: names are never the rewritten ones
    expect(f.refs.filter((r) => r.kind === 'call').map((r) => r.name)).toEqual(expect.arrayContaining(['selectAll', 'where', 'single', 'isNotEmpty']));
    expect(f.refs.some((r) => r.name === 'Eq' || r.name.includes('_'))).toBe(false);
    expect(f.refs.some((r) => r.kind === 'type_ref' && r.name === 'Builder')).toBe(true);
  });

  it('parses newer syntax and assignments the grammar rejects', async () => {
    const code = [
      'class AutoInc<T>(val delegate: ColumnType<T>) : IColumnType<T> by delegate {',
      '  private var seq: Sequence? = null',
      '  constructor(delegate: ColumnType<T>, s: Sequence) : this(delegate) {',
      '    seq = s',
      '  }',
      '  fun mask() = 0b1010 + elseResult(1)',
      '  fun loop(n: Int) { for (i in 0..<n) store(i) }',
      '  fun f(x: Any) = when (x) {',
      '    escapeChar -> 1',
      '    in specialChars -> 2',
      '    !isPK -> 3',
      '    else -> 4',
      '  }',
      '  fun g() {',
      '    find(1)!!.value = 2',
      '    cache(f)[key] = 3',
      '  }',
      '  fun h(body: Op<Boolean>?.() -> Op<Boolean>): Int = 1',
      '}',
      '',
    ].join('\n');
    expect(await hasError('kotlin', code)).toBe(false);
    const f = await ex('A.kt', code);
    expect(qnames(f)).toEqual([
      'class AutoInc',
      'property AutoInc.delegate',
      'property AutoInc.seq',
      'constructor AutoInc.AutoInc',
      'method AutoInc.mask',
      'method AutoInc.loop',
      'method AutoInc.f',
      'method AutoInc.g',
      'method AutoInc.h',
    ]);
    expect(f.refs.filter((r) => r.kind === 'call').map((r) => r.name)).toEqual(expect.arrayContaining(['elseResult', 'store', 'find', 'cache']));
  });

  it('only blanks delegations of class and object headers', () => {
    const fix = kotlinFix.text!;
    expect(fix('class A(val d: C) : I by d {\n}')).toBe('class A(val d: C) : I      {\n}');
    expect(fix('fun f() = object : Api by orig {\n}')).toBe('fun f() = object : Api         {\n}');
    expect(fix('val x: Foo by lazy { 1 }')).toBe('val x: Foo by lazy { 1 }');
    expect(fix('class D { val z by lazy { 2 } }')).toBe('class D { val z by lazy { 2 } }');
  });

  it('rewrites keep length and newlines, and leave keywords alone', () => {
    const src = 'val a = x eq y\nif (a) b else c\nprivate enum class E\nwhen (v) {\n  is T if ok -> 1\n}\n';
    const out = kotlinFix.text!(src);
    expect(out).toHaveLength(src.length);
    expect(out.split('\n').length).toBe(src.split('\n').length);
    expect(out).toContain('x Eq y');
    expect(out).toContain('b else c');
    expect(out).toContain('private enum class E');
    expect(out).toContain('is T ,  ok -> 1');
    expect(blank('ab\ncd', 1, 4)).toBe('a \n d');
  });
});
