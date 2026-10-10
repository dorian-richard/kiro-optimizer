// Minimal YAML reader for A/B task files (no dependency). Supported subset: block mappings and sequences (including
// `- key: value` items), flow sequences/mappings on one line (`[a, "b"]`, `{a: 1}`), plain / single-quoted /
// double-quoted scalars, literal (`|`) and folded (`>`) block scalars with optional chomping (`-`, `+`), comments,
// `---` / `...` document markers. Anchors, tags, multi-document files and multi-line flow collections are rejected
// with a line number instead of being misread.

export class YamlError extends Error {
  constructor(message: string, line: number) {
    super(`YAML line ${line}: ${message}`);
  }
}

interface Line {
  no: number;
  indent: number;
  text: string; // without indentation and trailing comment
  raw: string; // full original line
}

function stripComment(s: string): string {
  let q: string | undefined;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (q === "'" && c === "'" && s[i + 1] === "'") i++;
      else if (q === '"' && c === '\\') i++;
      else if (c === q) q = undefined;
    } else if (c === '"' || c === "'") {
      // a quote only opens a string at the start of a token
      if (i === 0 || /[\s:[{,-]/.test(s[i - 1])) q = c;
    } else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i);
    }
  }
  return s;
}

function scanLines(text: string): Line[] {
  const out: Line[] = [];
  const rows = text.replace(/^﻿/, '').split(/\r?\n/);
  rows.forEach((raw, i) => {
    if (/^\t/.test(raw)) throw new YamlError('tabs are not allowed for indentation', i + 1);
    const indent = raw.length - raw.trimStart().length;
    out.push({ no: i + 1, indent, text: stripComment(raw.slice(indent)).trimEnd(), raw });
  });
  return out;
}

function parseScalar(s: string, line: number): unknown {
  const t = s.trim();
  if (t === '') return null;
  if (t.startsWith('"')) {
    if (!t.endsWith('"') || t.length < 2) throw new YamlError('unterminated double-quoted string', line);
    try {
      return JSON.parse(t.replace(/\\'/g, "'"));
    } catch {
      throw new YamlError(`invalid double-quoted string ${t}`, line);
    }
  }
  if (t.startsWith("'")) {
    if (!t.endsWith("'") || t.length < 2) throw new YamlError('unterminated single-quoted string', line);
    return t.slice(1, -1).replace(/''/g, "'");
  }
  if (t.startsWith('[') || t.startsWith('{')) return parseFlow(t, line);
  if (/^[&*!]/.test(t)) throw new YamlError('anchors, aliases and tags are not supported', line);
  if (/^(true|True|TRUE)$/.test(t)) return true;
  if (/^(false|False|FALSE)$/.test(t)) return false;
  if (/^(null|Null|NULL|~)$/.test(t)) return null;
  if (/^[-+]?(\d+(\.\d+)?|\.\d+)([eE][-+]?\d+)?$/.test(t)) return Number(t);
  return t;
}

/** One-line flow collection: `[a, b, {c: d}]` or `{a: 1, b: [x]}`. */
function parseFlow(s: string, line: number): unknown {
  let i = 0;
  const ws = () => {
    while (i < s.length && /\s/.test(s[i])) i++;
  };
  const token = (stops: string): string => {
    ws();
    if (s[i] === '"' || s[i] === "'") {
      const q = s[i];
      let j = i + 1;
      while (j < s.length) {
        if (q === '"' && s[j] === '\\') j += 2;
        else if (q === "'" && s[j] === "'" && s[j + 1] === "'") j += 2;
        else if (s[j] === q) break;
        else j++;
      }
      if (j >= s.length) throw new YamlError('unterminated string in flow collection', line);
      const out = s.slice(i, j + 1);
      i = j + 1;
      return out;
    }
    let j = i;
    while (j < s.length && !stops.includes(s[j])) j++;
    const out = s.slice(i, j).trim();
    i = j;
    return out;
  };
  const value = (stops: string): unknown => {
    ws();
    if (s[i] === '[') return seq();
    if (s[i] === '{') return map();
    return parseScalar(token(stops), line);
  };
  const seq = (): unknown[] => {
    const out: unknown[] = [];
    i++; // [
    ws();
    if (s[i] === ']') {
      i++;
      return out;
    }
    for (;;) {
      out.push(value(',]'));
      ws();
      if (s[i] === ',') {
        i++;
        ws();
        if (s[i] === ']') {
          i++;
          return out;
        }
        continue;
      }
      if (s[i] === ']') {
        i++;
        return out;
      }
      throw new YamlError(`expected , or ] in flow sequence: ${s}`, line);
    }
  };
  const map = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    i++; // {
    ws();
    if (s[i] === '}') {
      i++;
      return out;
    }
    for (;;) {
      const k = token(':,}');
      ws();
      if (s[i] !== ':') throw new YamlError(`expected : in flow mapping: ${s}`, line);
      i++;
      out[String(parseScalar(k, line))] = value(',}');
      ws();
      if (s[i] === ',') {
        i++;
        continue;
      }
      if (s[i] === '}') {
        i++;
        return out;
      }
      throw new YamlError(`expected , or } in flow mapping: ${s}`, line);
    }
  };
  ws();
  const res = s[i] === '[' ? seq() : map();
  ws();
  if (i < s.length) throw new YamlError(`unexpected text after flow collection: ${s.slice(i)}`, line);
  return res;
}

/** `key: rest` split at the first `: ` (or trailing `:`) outside quotes. */
function splitKey(text: string): [string, string] | undefined {
  let q: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === q) q = undefined;
      continue;
    }
    if ((c === '"' || c === "'") && i === 0) q = c;
    else if (c === ':' && (i + 1 === text.length || text[i + 1] === ' ')) {
      const k = text.slice(0, i).trim();
      return [k.startsWith('"') || k.startsWith("'") ? String(parseScalar(k, 0)) : k, text.slice(i + 1).trim()];
    }
  }
  return undefined;
}

class Parser {
  private i = 0;
  constructor(private readonly lines: Line[]) {}

  private skipBlank(): void {
    while (this.i < this.lines.length && this.lines[this.i].text === '') this.i++;
  }

  parseDocument(): unknown {
    // document markers
    this.skipBlank();
    if (this.i < this.lines.length && this.lines[this.i].text === '---') this.i++;
    this.skipBlank();
    if (this.i >= this.lines.length) return null;
    const v = this.parseNode(this.lines[this.i].indent);
    this.skipBlank();
    if (this.i < this.lines.length && this.lines[this.i].text === '...') this.i++;
    this.skipBlank();
    if (this.i < this.lines.length) {
      const l = this.lines[this.i];
      if (l.text === '---') throw new YamlError('multi-document files are not supported', l.no);
      throw new YamlError(`unexpected indentation or content: ${l.raw.trim()}`, l.no);
    }
    return v;
  }

  private parseNode(indent: number): unknown {
    this.skipBlank();
    const l = this.lines[this.i];
    if (!l || l.indent < indent) return null;
    if (l.text === '-' || l.text.startsWith('- ')) return this.parseSeq(l.indent);
    if (splitKey(l.text)) return this.parseMap(l.indent);
    this.i++;
    return parseScalar(l.text, l.no);
  }

  private parseSeq(indent: number): unknown[] {
    const out: unknown[] = [];
    for (;;) {
      this.skipBlank();
      const l = this.lines[this.i];
      if (!l || l.indent < indent) return out;
      if (l.indent > indent) throw new YamlError('bad indentation in sequence', l.no);
      if (!(l.text === '-' || l.text.startsWith('- '))) return out;
      const rest = l.text === '-' ? '' : l.text.slice(2);
      const restTrim = rest.trimStart();
      const itemIndent = indent + 2 + (rest.length - restTrim.length);
      if (restTrim === '') {
        this.i++;
        out.push(this.parseNode(indent + 1));
      } else if (splitKey(restTrim) && !restTrim.startsWith('[') && !restTrim.startsWith('{')) {
        // `- key: value` starts a mapping whose keys are aligned with `key`
        this.lines[this.i] = { ...l, indent: itemIndent, text: restTrim };
        out.push(this.parseMap(itemIndent));
      } else if (/^[|>]/.test(restTrim)) {
        this.i++;
        out.push(this.blockScalar(restTrim, indent, l.no));
      } else {
        this.i++;
        out.push(parseScalar(restTrim, l.no));
      }
    }
  }

  private parseMap(indent: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (;;) {
      this.skipBlank();
      const l = this.lines[this.i];
      if (!l || l.indent < indent) return out;
      if (l.indent > indent) throw new YamlError('bad indentation in mapping', l.no);
      if (l.text.startsWith('- ') || l.text === '-') return out;
      const kv = splitKey(l.text);
      if (!kv) throw new YamlError(`expected "key: value", got: ${l.text}`, l.no);
      const [key, rest] = kv;
      if (key in out) throw new YamlError(`duplicate key "${key}"`, l.no);
      this.i++;
      if (rest === '') {
        this.skipBlank();
        const next = this.lines[this.i];
        if (next && (next.indent > indent || (next.indent === indent && (next.text.startsWith('- ') || next.text === '-')))) {
          out[key] = this.parseNode(next.indent);
        } else out[key] = null;
      } else if (/^[|>]/.test(rest)) {
        out[key] = this.blockScalar(rest, indent, l.no);
      } else {
        out[key] = parseScalar(rest, l.no);
      }
    }
  }

  private blockScalar(header: string, parentIndent: number, lineNo: number): string {
    const m = /^([|>])([-+]?)(\d?)([-+]?)\s*$/.exec(header);
    if (!m) throw new YamlError(`invalid block scalar header ${header}`, lineNo);
    const folded = m[1] === '>';
    const chomp = m[2] || m[4];
    const body: string[] = [];
    let blockIndent: number | undefined = m[3] ? parentIndent + Number(m[3]) : undefined;
    while (this.i < this.lines.length) {
      const l = this.lines[this.i];
      const isBlank = l.raw.trim() === '';
      if (!isBlank) {
        if (blockIndent === undefined) blockIndent = l.indent;
        if (l.indent < blockIndent || l.indent <= parentIndent) break;
      }
      body.push(isBlank ? '' : l.raw.slice(blockIndent));
      this.i++;
    }
    // trailing blank lines belong to chomping
    let end = body.length;
    while (end > 0 && body[end - 1] === '') end--;
    const kept = body.slice(0, end);
    let text: string;
    if (folded) {
      text = '';
      kept.forEach((ln, k) => {
        if (k === 0) text = ln;
        else if (ln === '' || /^\s/.test(ln) || kept[k - 1] === '' || /^\s/.test(kept[k - 1])) text += '\n' + ln;
        else text += ' ' + ln;
      });
    } else text = kept.join('\n');
    if (chomp === '-') return text;
    if (chomp === '+') return text + '\n'.repeat(body.length - end + 1);
    return kept.length ? text + '\n' : '';
  }
}

/** Bracket balance of a flow collection starting a value on this line (quotes skipped). */
function openFlow(text: string): boolean {
  const m = /^(?:-\s+)?(?:[^\s"'][^:]*:\s+|"[^"]*":\s+|'[^']*':\s+)?([[{].*)$/.exec(text);
  if (!m) return false;
  let depth = 0;
  let q: string | undefined;
  for (const c of m[1]) {
    if (q) {
      if (c === q) q = undefined;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
  }
  return depth > 0;
}

export function parseYaml(text: string): unknown {
  const lines = scanLines(text);
  let content = false;
  for (const l of lines) {
    if (l.text === '---' && l.indent === 0 && content) throw new YamlError('multi-document files are not supported', l.no);
    if (l.text !== '' && l.text !== '---') content = true;
    if (openFlow(l.text)) throw new YamlError('multi-line flow collections are not supported', l.no);
  }
  return new Parser(lines).parseDocument();
}
