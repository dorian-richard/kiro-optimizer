// FTS5 column values for a symbol (see store/schema.ts symbols_fts). Computed where the file is parsed
// (worker threads on big runs) so the main thread only binds strings.

import type { ExtractedFile, ExtractedSymbol } from '../core/types.js';
import { splitIdentifier, termsForText } from './terms.js';

/** [name_terms, sig_terms, path_terms, doc, body_terms] */
export type FtsRow = [string, string, string, string, string];

/** name_terms: full lower-cased name, its sub-words, and the enclosing containers (namespace prefix dropped). */
export function nameTerms(sym: ExtractedSymbol, namespace: string | undefined): string {
  const words = new Set<string>();
  const lower = sym.name.toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, '');
  if (lower) words.add(lower);
  for (const w of splitIdentifier(sym.name)) words.add(w);
  let q = sym.qualifiedName;
  if (namespace && q.startsWith(namespace + '.')) q = q.slice(namespace.length + 1);
  for (const part of q.split('.')) {
    const p = part.toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, '');
    if (p) words.add(p);
  }
  return [...words].join(' ');
}

export function ftsRows(file: ExtractedFile): FtsRow[] {
  const pathTerms = termsForText(file.path).join(' ');
  return file.symbols.map((s) => [
    nameTerms(s, file.namespace),
    termsForText(s.signature).join(' '),
    pathTerms,
    s.doc ?? '',
    s.bodyTerms ? s.bodyTerms.join(' ') : '',
  ]);
}
