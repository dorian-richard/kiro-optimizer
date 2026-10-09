// Minimal JSONC support for editor settings files (comments + trailing commas), enough to add one
// value without destroying the user's comments: edits are textual when the file has comments.

interface Tok { kind: 'str' | 'punct' | 'other'; start: number; end: number; value: string }

/** Tokens outside comments (strings, punctuation, bare words). */
function tokenize(text: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') { const nl = text.indexOf('\n', i); i = nl < 0 ? text.length : nl; continue; }
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? text.length : e + 2; continue; }
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      toks.push({ kind: 'str', start: i, end: j + 1, value: text.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    if ('{}[]:,'.includes(c)) { toks.push({ kind: 'punct', start: i, end: i + 1, value: c }); i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    let j = i;
    while (j < text.length && !/[\s{}[\]:,"/]/.test(text[j])) j++;
    toks.push({ kind: 'other', start: i, end: Math.max(j, i + 1), value: text.slice(i, Math.max(j, i + 1)) });
    i = Math.max(j, i + 1);
  }
  return toks;
}

/** Remove comments and trailing commas; result is strict JSON when the input was valid JSONC. */
export function stripJsonc(text: string): string {
  const toks = tokenize(text);
  const out: string[] = [];
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.value === ',' && t.kind === 'punct' && (toks[k + 1]?.value === '}' || toks[k + 1]?.value === ']')) continue;
    out.push(t.value);
  }
  return out.join(' ');
}

export function parseJsonc(text: string): unknown {
  // a UTF-8 BOM (Notepad, Windows PowerShell 5) is not JSON whitespace
  return JSON.parse(stripJsonc(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) || 'null');
}

function detectIndent(text: string): string {
  const m = /\n([ \t]+)\S/.exec(text);
  return m ? m[1] : '  ';
}

/**
 * Ensure `settings[key]` (an array of strings) contains `value`. Returns the new text, or
 * undefined when nothing changes. Throws when the file is not a JSON(C) object.
 */
export function ensureArrayValue(text: string | undefined, key: string, value: string): string | undefined {
  if (text === undefined || !text.trim()) return JSON.stringify({ [key]: [value] }, null, 2) + '\n';
  const obj = parseJsonc(text);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('settings file is not a JSON object');
  const cur = (obj as Record<string, unknown>)[key];
  if (Array.isArray(cur) && cur.includes(value)) return undefined;
  if (cur !== undefined && !Array.isArray(cur)) throw new Error(`"${key}" is not an array`);

  let strict: unknown;
  try { strict = JSON.parse(text); } catch { strict = undefined; }
  if (strict && typeof strict === 'object') {
    const next = { ...(strict as Record<string, unknown>), [key]: [...((cur as unknown[]) ?? []), value] };
    return JSON.stringify(next, null, detectIndent(text)) + (text.endsWith('\n') ? '\n' : '');
  }

  // JSONC with comments: textual insertion keeps them.
  const toks = tokenize(text);
  const indent = detectIndent(text);
  if (cur === undefined) {
    const open = toks.find((t) => t.value === '{');
    if (!open) throw new Error('settings file is not a JSON object');
    const empty = toks[toks.indexOf(open) + 1]?.value === '}';
    const entry = `\n${indent}${JSON.stringify(key)}: [${JSON.stringify(value)}]${empty ? '\n' : ','}`;
    return text.slice(0, open.end) + entry + text.slice(open.end);
  }
  // depth-1 key token followed by ':' '['
  let depth = 0;
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.value === '{' || t.value === '[') depth++;
    else if (t.value === '}' || t.value === ']') depth--;
    else if (depth === 1 && t.kind === 'str' && JSON.parse(t.value) === key && toks[k + 1]?.value === ':' && toks[k + 2]?.value === '[') {
      const bracket = toks[k + 2];
      const empty = toks[k + 3]?.value === ']';
      return text.slice(0, bracket.end) + JSON.stringify(value) + (empty ? '' : ', ') + text.slice(bracket.end);
    }
  }
  throw new Error(`could not locate "${key}"`);
}

/**
 * Remove `value` from `settings[key]` (an array of strings). Returns the new text, or undefined when nothing
 * changes. Comments are kept (textual edit) when the file is JSONC; an emptied array is left in place.
 */
export function removeArrayValue(text: string | undefined, key: string, value: string): string | undefined {
  if (text === undefined || !text.trim()) return undefined;
  const obj = parseJsonc(text);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  const cur = (obj as Record<string, unknown>)[key];
  if (!Array.isArray(cur) || !cur.includes(value)) return undefined;

  let strict: unknown;
  try { strict = JSON.parse(text); } catch { strict = undefined; }
  if (strict && typeof strict === 'object') {
    const next = { ...(strict as Record<string, unknown>), [key]: cur.filter((v) => v !== value) };
    return JSON.stringify(next, null, detectIndent(text)) + (text.endsWith('\n') ? '\n' : '');
  }

  const toks = tokenize(text);
  let depth = 0;
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.value === '{' || t.value === '[') depth++;
    else if (t.value === '}' || t.value === ']') depth--;
    else if (depth === 1 && t.kind === 'str' && JSON.parse(t.value) === key && toks[k + 1]?.value === ':' && toks[k + 2]?.value === '[') {
      for (let j = k + 3; j < toks.length && toks[j].value !== ']'; j++) {
        const v = toks[j];
        if (v.kind !== 'str' || JSON.parse(v.value) !== value) continue;
        const next = toks[j + 1];
        const prev = toks[j - 1];
        if (next?.value === ',') return text.slice(0, v.start) + text.slice(next.end).replace(/^\s+/, '');
        if (prev?.value === ',') return text.slice(0, prev.start) + text.slice(v.end);
        return text.slice(0, v.start) + text.slice(v.end);
      }
    }
  }
  return undefined;
}
