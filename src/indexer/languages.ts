// Language registry: file extension -> Lang, and lazy loading of tree-sitter WASM grammars.

import { createRequire } from 'node:module';
import { Language, Parser } from 'web-tree-sitter';
import type { Lang } from '../core/types.js';

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

let initPromise: Promise<void> | undefined;
const languages = new Map<string, Promise<Language>>();
const parsers = new Map<string, Parser>();

function initParser(): Promise<void> {
  if (!initPromise) initPromise = Parser.init();
  return initPromise;
}

export function grammarPath(grammar: string): string {
  return require.resolve(`tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`);
}

export async function loadGrammar(grammar: string): Promise<Language> {
  await initParser();
  let p = languages.get(grammar);
  if (!p) {
    p = Language.load(grammarPath(grammar));
    languages.set(grammar, p);
    p.catch(() => languages.delete(grammar));
  }
  return p;
}

/** One Parser per grammar (switching languages on a shared parser resets its internal state anyway). */
export async function parserFor(lang: Lang): Promise<Parser> {
  const grammar = grammarFor(lang);
  let parser = parsers.get(grammar);
  if (parser) return parser;
  const language = await loadGrammar(grammar);
  parser = parsers.get(grammar);
  if (parser) return parser;
  parser = new Parser();
  parser.setLanguage(language);
  parsers.set(grammar, parser);
  return parser;
}
