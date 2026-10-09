// Per-file work that can run off the main thread: read, filter (binary/minified/size), hash, parse.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { IxFile } from './extract.js';
import { ftsRows, type FtsRow } from './fts.js';
import { extractFile } from './parse.js';

export interface PrepJob {
  abs: string;
  rel: string;
  size: number;
  mtimeMs: number;
  maxBytes: number;
  /** Hash currently stored for this path: identical content skips parsing. */
  knownHash?: string;
  /** Python module name from the package layout. */
  pythonModule?: string;
}

export type Prepared =
  | { kind: 'file'; rel: string; hash: string; size: number; mtimeMs: number; file: IxFile; fts?: FtsRow[] }
  | { kind: 'same'; rel: string; hash: string; size: number; mtimeMs: number }
  | { kind: 'skip'; rel: string; size: number; mtimeMs: number; reason: 'large' | 'binary' | 'minified' | 'parse' }
  | { kind: 'gone'; rel: string };

const BINARY_SNIFF = 8192;
const MINIFIED_SNIFF = 65536;
const MAX_LINE = 3000;
const MAX_AVG_LINE = 250;

export function isBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, BINARY_SNIFF);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Generated bundles / minified code: any very long line early on, or a high average line length. */
export function isMinified(text: string): boolean {
  const head = text.length > MINIFIED_SNIFF ? text.slice(0, MINIFIED_SNIFF) : text;
  let start = 0;
  let lines = 0;
  while (start <= head.length) {
    let end = head.indexOf('\n', start);
    if (end === -1) end = head.length;
    if (end - start > MAX_LINE) return true;
    lines++;
    start = end + 1;
  }
  return head.length > 2000 && head.length / lines > MAX_AVG_LINE;
}

export function sha1(buf: Uint8Array | string): string {
  return createHash('sha1').update(buf).digest('hex');
}

export async function prepareFile(job: PrepJob): Promise<Prepared> {
  let buf: Buffer;
  try {
    buf = await readFile(job.abs);
  } catch {
    return { kind: 'gone', rel: job.rel };
  }
  const size = buf.length;
  const base = { rel: job.rel, size, mtimeMs: job.mtimeMs };
  if (size > job.maxBytes) return { kind: 'skip', ...base, reason: 'large' };
  if (isBinary(buf)) return { kind: 'skip', ...base, reason: 'binary' };
  const hash = sha1(buf);
  if (job.knownHash && job.knownHash === hash) return { kind: 'same', ...base, hash };
  let text = buf.toString('utf8');
  // A UTF-8 BOM (common on Windows) is not code: parse without it. Line numbers are unaffected; byte offsets are
  // shifted back below so they keep pointing into the file as stored. CRLF needs nothing: tree-sitter rows end at
  // `\n` and signatures/docs collapse whitespace.
  const bom = text.charCodeAt(0) === 0xfeff ? 3 : 0;
  if (bom) text = text.slice(1);
  if (isMinified(text)) return { kind: 'skip', ...base, reason: 'minified' };
  let file: IxFile | undefined;
  try {
    file = await extractFile(job.rel, text, job.pythonModule ? { pythonModule: job.pythonModule } : undefined);
  } catch {
    file = undefined;
  }
  if (!file) return { kind: 'skip', ...base, reason: 'parse' };
  if (bom) {
    for (const sym of file.symbols) {
      sym.startByte += bom;
      sym.endByte += bom;
    }
  }
  return { kind: 'file', ...base, hash, file, fts: ftsRows(file) };
}
