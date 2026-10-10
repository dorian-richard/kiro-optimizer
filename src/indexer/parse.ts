// extractFile: text -> ExtractedFile (pure, no I/O). Used by the indexer (main thread or workers) and retrieval.

import type { Node, Tree } from 'web-tree-sitter';
import type { Lang } from '../core/types.js';
import { Ex, Vars, type ExtractOptions, type IxFile, type Scope, type Visitor } from './extract.js';
import { languageForPath, parserFor } from './languages.js';
import { visitCSharp } from './langs/csharp.js';
import { postGo, visitGo } from './langs/go.js';
import { visitJava } from './langs/java.js';
import { visitKotlin } from './langs/kotlin.js';
import { visitPhp, visitRuby, visitRust, visitScala } from './langs/misc.js';
import { initPython, visitPython } from './langs/python.js';
import { initTs, postTs, visitTs } from './langs/typescript.js';

interface LangDef {
  visit: Visitor;
  init?: (ex: Ex, scope: Scope, root: Node) => void;
  post?: (ex: Ex) => void;
}

const LANGS: Record<Lang, LangDef> = {
  typescript: { visit: visitTs, init: initTs, post: postTs },
  tsx: { visit: visitTs, init: initTs, post: postTs },
  javascript: { visit: visitTs, init: initTs, post: postTs },
  python: { visit: visitPython, init: initPython },
  java: { visit: visitJava },
  c_sharp: { visit: visitCSharp },
  go: { visit: visitGo, post: postGo },
  kotlin: { visit: visitKotlin },
  rust: { visit: visitRust },
  php: { visit: visitPhp },
  ruby: { visit: visitRuby },
  scala: { visit: visitScala },
};

/** Parsing budget per file: pathological inputs must not stall a whole indexing run. */
export const PARSE_TIMEOUT_MS = 5000;

export function countLines(text: string): number {
  if (!text) return 0;
  let n = 1;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n++;
  return text.endsWith('\n') ? n - 1 : n;
}

/** Extraction from an already-parsed tree (exposed for tests/tools that keep their own trees). */
export function extractTree(path: string, lang: Lang, text: string, root: Node, options?: ExtractOptions): IxFile {
  const def = LANGS[lang];
  const ex = new Ex(path, lang, text, options, def.visit);
  const scope: Scope = { q: '', local: false, exported: true, vars: new Vars() };
  def.init?.(ex, scope, root);
  ex.visitChildren(root, scope);
  ex.drain();
  def.post?.(ex);
  return ex.finish(countLines(text));
}

export async function extractFile(path: string, text: string, options?: ExtractOptions): Promise<IxFile | undefined> {
  const r = await extractFileWithin(path, text, PARSE_TIMEOUT_MS, options);
  return r === 'timeout' ? undefined : r;
}

/**
 * extractFile with an explicit parsing budget; 'timeout' when the parser gave up (the deadline is wall-clock
 * time, so a machine under heavy load can hit it on an ordinary file: the indexer retries those).
 */
export async function extractFileWithin(path: string, text: string, timeoutMs: number, options?: ExtractOptions): Promise<IxFile | undefined | 'timeout'> {
  const lang = languageForPath(path);
  if (!lang) return undefined;
  const parser = await parserFor(lang);
  const deadline = performance.now() + timeoutMs;
  let timedOut = false;
  let tree: Tree | null = null;
  try {
    tree = parser.parse(text, null, {
      progressCallback: () => {
        if (performance.now() > deadline) timedOut = true;
        return timedOut;
      },
    });
  } catch {
    tree = null;
  }
  if (!tree) {
    parser.reset();
    return timedOut ? 'timeout' : undefined;
  }
  try {
    return extractTree(path, lang, text, tree.rootNode, options);
  } finally {
    tree.delete();
  }
}
