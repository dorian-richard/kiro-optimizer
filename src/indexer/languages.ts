// Language registry: file extension -> Lang, and lazy loading of tree-sitter WASM grammars.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Language, Parser, type ParseCallback, type ParseOptions, type Tree } from 'web-tree-sitter';
import type { Lang } from '../core/types.js';
import { SOURCE_FIXES, type SourceFix } from './sourcefix.js';

const require = createRequire(import.meta.url);

const EXT_TO_LANG: Record<string, Lang> = {
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.pyi': 'python',
  '.java': 'java',
  '.cs': 'c_sharp',
  '.go': 'go',
  '.kt': 'kotlin', '.kts': 'kotlin',
  '.rs': 'rust',
  '.php': 'php',
  '.rb': 'ruby',
  '.scala': 'scala', '.sc': 'scala',
};

export const SUPPORTED_EXTENSIONS: readonly string[] = Object.keys(EXT_TO_LANG);

export function languageForPath(path: string): Lang | undefined {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  if (dot <= slash + 1) return undefined; // no extension, or dotfile
  // .d.ts declaration files are useful (types), keep them as typescript.
  return EXT_TO_LANG[path.slice(dot).toLowerCase()];
}

/**
 * Grammar used to parse a file. JavaScript goes through the TSX grammar: it is a superset that also
 * handles JSX and the occasional type annotation (Flow-ish code), and keeps one code path for TS/JS.
 */
export function grammarFor(lang: Lang): string {
  switch (lang) {
    case 'javascript':
    case 'tsx':
      return 'tsx';
    default:
      return lang;
  }
}

/**
 * WASM builds to try per grammar, best first. tree-sitter-wasms 0.1.13 ships 2023-era grammars; where a newer
 * pure-WASM build measurably parses real code better, it is vendored in vendor/grammars (see the README there):
 * - scala: tree-sitter-scala 0.26 (`sealed trait`, `private[x]`, `class X @Inject() (...)`, Scala 3 syntax);
 *   the old grammar left 80% of Play Framework files with parse errors, the new one none.
 * - rust: tree-sitter-rust 0.24 (let-else, async closures, raw identifiers...): 2.9% -> 0.1% on meilisearch.
 * Each vendored file is checked against its SHA-256 before it is loaded; a mismatch (corrupted or replaced
 * file) falls back to the tree-sitter-wasms build, which degrades extraction instead of disabling the language.
 */
const VENDORED: Record<string, { file: string; sha256: string }> = {
  scala: { file: 'tree-sitter-scala.wasm', sha256: '37d7fe5a91ca98941dc05493b0c05a0df0f36df5035890fa00b02497c68aaac3' },
  rust: { file: 'tree-sitter-rust.wasm', sha256: '34c51ee3e8c05a775e5e05163278bb73c79df149f7e8d648f84a54bd97466e84' },
};

/** vendor/grammars of the package: two levels above this module in dist/indexer/ and in src/indexer/. */
export const VENDOR_GRAMMAR_DIR = fileURLToPath(new URL('../../vendor/grammars/', import.meta.url));

let initPromise: Promise<void> | undefined;
const languages = new Map<string, Promise<Language>>();
const parsers = new Map<string, Parser>();
const warned = new Set<string>();

function initParser(): Promise<void> {
  if (!initPromise) initPromise = Parser.init();
  return initPromise;
}

/** A vendored grammar file with its expected checksum. */
export interface VendoredGrammar {
  path: string;
  sha256: string;
}

export function vendoredGrammar(grammar: string, dir = VENDOR_GRAMMAR_DIR): VendoredGrammar | undefined {
  const v = VENDORED[grammar];
  return v ? { path: join(dir, v.file), sha256: v.sha256 } : undefined;
}

/**
 * Bytes of a vendored grammar when the file exists and matches its checksum, else undefined (one stderr warning
 * per file on a mismatch; a missing file is silent: the fallback grammar is used).
 */
export function verifiedGrammarBytes(v: VendoredGrammar): Uint8Array | undefined {
  let bytes: Buffer;
  try {
    bytes = readFileSync(v.path);
  } catch {
    return undefined;
  }
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual === v.sha256) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!warned.has(v.path)) {
    warned.add(v.path);
    process.stderr.write(`kopt: ${v.path} does not match its SHA-256 (expected ${v.sha256}, got ${actual}); using the tree-sitter-wasms grammar instead\n`);
  }
  return undefined;
}

/** The tree-sitter-wasms build of a grammar, when installed. */
function packagedGrammar(grammar: string): string | undefined {
  try {
    return require.resolve(`tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`);
  } catch {
    return undefined;
  }
}

/** Candidate WASM files for a grammar, in preference order (only the ones that exist or resolve). */
export function grammarPaths(grammar: string): string[] {
  const out: string[] = [];
  const v = vendoredGrammar(grammar);
  if (v && existsSync(v.path)) out.push(v.path);
  const p = packagedGrammar(grammar);
  if (p) out.push(p);
  return out;
}

/** WASM file the grammar is loaded from (the first candidate that resolves). */
export function grammarPath(grammar: string): string {
  const paths = grammarPaths(grammar);
  if (!paths.length) throw new Error(`kopt: no tree-sitter grammar found for ${grammar}`);
  return paths[0];
}

async function loadFirst(grammar: string, vendorDir = VENDOR_GRAMMAR_DIR): Promise<Language> {
  let lastError: unknown;
  const v = vendoredGrammar(grammar, vendorDir);
  if (v) {
    const bytes = verifiedGrammarBytes(v);
    if (bytes) {
      try {
        return await Language.load(bytes);
      } catch (e) {
        lastError = e;
      }
    }
  }
  // vendored files are only ever loaded from verified bytes, above
  const p = packagedGrammar(grammar);
  if (p) {
    try {
      return await Language.load(p);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`kopt: no tree-sitter grammar found for ${grammar}`);
}

/** Loads a grammar without the cache, vendored files looked up in `vendorDir` (tests: corrupted-file fallback). */
export async function loadGrammarFrom(grammar: string, vendorDir: string): Promise<Language> {
  await initParser();
  return loadFirst(grammar, vendorDir);
}

export async function loadGrammar(grammar: string): Promise<Language> {
  await initParser();
  let p = languages.get(grammar);
  if (!p) {
    p = loadFirst(grammar);
    languages.set(grammar, p);
    p.catch(() => languages.delete(grammar));
  }
  return p;
}

/**
 * Parser that steers its grammar around known gaps with same-length source rewrites (see sourcefix.ts).
 * The tree is built from the rewritten text, but node text reads the original: the parse callback the tree
 * keeps for `Node.text` is switched back to the original source once parsing is done. Offsets and rows are
 * unchanged because every rewrite keeps the length and the newlines.
 */
export class KoptParser extends Parser {
  constructor(private readonly fix?: SourceFix) {
    super();
  }

  override parse(input: string | ParseCallback, oldTree?: Tree | null, options?: ParseOptions): Tree | null {
    const fix = this.fix;
    if (!fix || typeof input !== 'string') return super.parse(input, oldTree, options);
    const original = input;
    let src = original;
    if (fix.text) {
      const t = fix.text(original);
      if (t.length === original.length) src = t;
    }
    const read: ParseCallback = (index: number) => src.slice(index);
    let tree = super.parse(read, oldTree, options);
    if (tree && fix.tree) {
      const again = fix.tree(src, tree.rootNode);
      if (again !== undefined && again !== src && again.length === original.length) {
        const prev = src;
        src = again;
        const second = super.parse(read, null, options);
        if (second) {
          tree.delete();
          tree = second;
        } else {
          src = prev;
        }
      }
    }
    src = original;
    return tree;
  }
}

/** One Parser per grammar (switching languages on a shared parser resets its internal state anyway). */
export async function parserFor(lang: Lang): Promise<Parser> {
  const grammar = grammarFor(lang);
  let parser = parsers.get(grammar);
  if (parser) return parser;
  const language = await loadGrammar(grammar);
  parser = parsers.get(grammar);
  if (parser) return parser;
  parser = new KoptParser(SOURCE_FIXES[grammar]);
  parser.setLanguage(language);
  parsers.set(grammar, parser);
  return parser;
}
