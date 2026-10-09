// Code-aware term extraction, shared by the indexer (FTS columns) and retrieval (queries).
// Both sides MUST use these functions so that index terms and query terms line up.

const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/**
 * Split an identifier into lower-cased sub-words.
 * "parseHTTPRequest_v2" -> ["parse", "http", "request", "v2"]; "OrderService" -> ["order", "service"].
 */
export function splitIdentifier(name: string): string[] {
  const parts = name
    .replace(/[$]/g, '_')
    // fooBar -> foo_Bar ; HTTPRequest -> HTTP_Request ; v2Api -> v2_Api
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p.toLowerCase());
  return parts;
}

/**
 * Identifiers found in `text` plus their sub-words, lower-cased, de-duplicated, order preserved.
 * Single-character terms are dropped.
 */
export function termsForText(text: string, limit = Infinity): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(IDENT_RE)) {
    const ident = m[0];
    const full = ident.replace(/^[_$]+|[_$]+$/g, '').toLowerCase();
    if (full.length >= 2) out.add(full);
    const subs = splitIdentifier(ident);
    if (subs.length > 1) for (const s of subs) if (s.length >= 2) out.add(s);
    if (out.size >= limit) break;
  }
  return [...out].slice(0, limit === Infinity ? undefined : limit);
}

/** Words ignored in natural-language queries (EN + FR, since prompts may be written in French). */
export const QUERY_STOPWORDS: ReadonlySet<string> = new Set([
  // English
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'by', 'from', 'at', 'as', 'is', 'are', 'was',
  'be', 'been', 'it', 'its', 'this', 'that', 'these', 'those', 'how', 'what', 'where', 'when', 'which', 'who', 'why',
  'does', 'do', 'did', 'can', 'could', 'should', 'would', 'will', 'there', 'here', 'all', 'any', 'some', 'into',
  'me', 'my', 'we', 'our', 'you', 'your', 'find', 'show', 'get', 'code', 'file', 'files', 'function', 'method',
  'class', 'implemented', 'implementation', 'used', 'use', 'uses', 'called', 'logic', 'handle', 'handled', 'work', 'works',
  // French
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'et', 'ou', 'en', 'au', 'aux', 'est', 'sont', 'dans', 'pour',
  'par', 'sur', 'avec', 'qui', 'que', 'quoi', 'comment', 'pourquoi', 'quand', 'ce', 'cette', 'ces', 'se', 'sa', 'son',
  'ses', 'il', 'elle', 'on', 'nous', 'vous', 'je', 'mon', 'ma', 'mes', 'fait', 'faire', 'trouve', 'fichier', 'fonction',
  'classe', 'methode', 'méthode', 'utilise', 'appel', 'appelé', 'gère', 'géré',
]);

/** Terms for a search query: identifiers + sub-words minus stopwords. */
export function queryTerms(query: string): string[] {
  return termsForText(query).filter((t) => !QUERY_STOPWORDS.has(t));
}
