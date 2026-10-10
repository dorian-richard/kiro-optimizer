import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultConfig } from '../src/core/config.js';
import { newToolContext, type ToolContext } from '../src/core/context.js';
import type { ExtractedFile } from '../src/core/types.js';
import { symbolHandle } from '../src/store/store.js';
import { outline, read, setExtractor, setReextract, settleExtractions } from '../src/retrieval/index.js';
import { type Seeded, seedStore } from './helpers/seed.js';

// Stand-in for the indexer's extractFile, injected through setExtractor.
const calls: string[] = [];
async function fakeExtract(path: string, text: string): Promise<ExtractedFile> {
  calls.push(path);
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.includes('public BigDecimal computeRefund('));
  const j = lines.findIndex((l, k) => k > i && l === '    }');
  return {
    path,
    lang: 'java',
    lineCount: lines.length,
    imports: [],
    refs: [],
    symbols: [
      { name: 'computeRefund', qualifiedName: 'com.acme.billing.RefundService.computeRefund', kind: 'method', startLine: i + 1, endLine: j + 1, startByte: 0, endByte: 0, signature: lines[i].trim(), exported: true },
    ],
  };
}

const RS = 'src/main/java/com/acme/billing/RefundService.java';
let s: Seeded;
let ctx: ToolContext;
const hd = (key: string) => symbolHandle(s.ids[key]);
const original = () => readFileSync(join(s.root, RS), 'utf8');
const write = (text: string) => writeFileSync(join(s.root, RS), text);
const slice = (text: string, a: number, b: number) => text.split('\n').slice(a - 1, b).join('\n');

beforeEach(() => {
  setReextract(false);
  setExtractor(undefined);
  calls.length = 0;
  s = seedStore();
  ctx = newToolContext(defaultConfig(s.root));
});
afterEach(() => s.cleanup());

describe('staleness', () => {
  it('re-locates a moved symbol by its signature', () => {
    const text = '// header\n// added\n// lines\n' + original();
    write(text);
    const r = read(s.store, { target: 'RefundService.computeRefund' }, ctx);
    expect(r.text).toBe(`${RS}:22-30 ${hd('RefundService.computeRefund')}\n${slice(text, 22, 30)}\nnote: file changed since indexing; lines re-located`);
  });

  it('finds the new block end when the body grew', () => {
    const text = original().replace('        validateRequest(order, request);\n', '        validateRequest(order, request);\n        // extra 1\n        // extra 2\n');
    write(text);
    const r = read(s.store, { target: 'RefundService.computeRefund' }, ctx);
    expect(r.text.split('\n')[0]).toBe(`${RS}:19-29 ${hd('RefundService.computeRefund')}`);
    expect(r.text).toContain('        return requested;\n    }\nnote:');
  });

  it('warns in one line when the symbol cannot be found', () => {
    write(original().replace('computeRefund(Order order', 'computeRefundV2(Order order'));
    const r = read(s.store, { target: 'RefundService.computeRefund' }, ctx);
    expect(r.text.split('\n').pop()).toBe('note: file changed since indexing and the symbol was not found; lines may be off (run kopt index)');
  });

  it('re-locates skeleton lines of a stale file', () => {
    write('// one\n// two\n' + original());
    const r = outline(s.store, { path: RS }, ctx);
    expect(r.text).toContain('  L21 public BigDecimal computeRefund(Order order, RefundRequest request)');
    expect(r.text).toContain('note: file changed since indexing; line numbers re-located (approximate)');
  });

  it('ignores touch-only changes (same content hash)', () => {
    utimesSync(join(s.root, RS), new Date(), new Date(Date.now() + 60_000));
    const r = read(s.store, { target: 'RefundService.computeRefund' }, ctx);
    expect(r.text).not.toContain('note:');
    expect(r.text.split('\n')[0]).toBe(`${RS}:19-27 ${hd('RefundService.computeRefund')}`);
  });

  it('tolerates a missing or broken indexer module', async () => {
    setReextract(true);
    write('// x\n' + original());
    expect(read(s.store, { target: 'RefundService.computeRefund' }, ctx).text).toContain('lines re-located');
    await settleExtractions();
    expect(read(s.store, { target: 'RefundService.computeRefund', fresh: true }, ctx).text.split('\n')[0]).toBe(`${RS}:20-28 ${hd('RefundService.computeRefund')}`);
  });

  it('uses a background re-extraction for later calls', async () => {
    setReextract(true);
    setExtractor(fakeExtract);
    const text = '// a\n// b\n// c\n// d\n' + original();
    write(text);
    const first = read(s.store, { target: 'RefundService.computeRefund' }, ctx);
    expect(first.text).toContain('lines re-located');
    await settleExtractions();
    expect(calls).toEqual([RS]);
    const second = read(s.store, { target: 'RefundService.computeRefund', fresh: true }, ctx);
    expect(second.text).toBe(`${RS}:23-31 ${hd('RefundService.computeRefund')}\n${slice(text, 23, 31)}`);
  });
});

// Overloads and call sites placed before the declaration they call: the cases where line-distance matching fails.
describe('staleness with overloads and call sites', () => {
  const SVC = 'src/a/Svc.java';
  const svcText = [
    'package a;',
    '',
    'public class Svc {',
    '    public void run(Order o) {',
    '        validate(o);',
    '    }',
    '',
    '    public void place(Order o) {',
    '        validate(o);',
    '        log(o);',
    '    }',
    '',
    '    public void place(Order o, int qty) {',
    '        validate(o);',
    '    }',
    '',
    '    private void validate(Order o) {',
    '        check(o);',
    '    }',
    '}',
    '',
  ].join('\n');
  let t: Seeded;
  let c: ToolContext;
  const th = (id: string) => symbolHandle(t.ids[id]);
  const shifted = '// 1\n// 2\n// 3\n// 4\n// 5\n' + svcText;

  // Minimal Java parse of the fixture, standing in for the indexer's extractFile.
  async function parseSvc(path: string, text: string): Promise<ExtractedFile> {
    const lines = text.split('\n');
    const symbols: ExtractedFile['symbols'] = [];
    lines.forEach((l, i) => {
      const m = /^\s*(?:public|private) (class|void) (\w+)/.exec(l);
      if (!m) return;
      let depth = 0;
      let end = i;
      for (let j = i; j < lines.length; j++) {
        depth += (lines[j].match(/\{/g) ?? []).length - (lines[j].match(/\}/g) ?? []).length;
        if (depth <= 0) {
          end = j;
          break;
        }
      }
      const cls = m[1] === 'class';
      symbols.push({
        name: m[2], qualifiedName: cls ? `a.${m[2]}` : `a.Svc.${m[2]}`, kind: cls ? 'class' : 'method', startLine: i + 1, endLine: end + 1,
        startByte: 0, endByte: 0, signature: l.trim().replace(/\s*\{$/, ''), exported: l.includes('public'), ...(cls ? {} : { parent: 0 }),
      });
    });
    return { path, lang: 'java', lineCount: lines.length, imports: [], refs: [], symbols };
  }

  beforeEach(() => {
    setReextract(false);
    setExtractor(undefined);
    t = seedStore({
      specs: [
        {
          path: SVC, lang: 'java', namespace: 'a', rank: 0.5, text: svcText,
          symbols: [
            { key: 'Svc', kind: 'class', exported: true },
            { key: 'Svc.run', kind: 'method', exported: true },
            { key: 'Svc.place', id: 'place1', kind: 'method', exported: true, at: 'public void place(Order o)' },
            { key: 'Svc.place', id: 'place2', kind: 'method', exported: true, at: 'public void place(Order o, int qty)' },
            { key: 'Svc.validate', kind: 'method', at: 'private void validate(' },
          ],
        },
      ],
    });
    c = newToolContext(defaultConfig(t.root));
    writeFileSync(join(t.root, SVC), shifted);
  });
  afterEach(() => {
    setExtractor(undefined);
    t.cleanup();
  });

  it('re-locates a declaration, not a call site placed before it', () => {
    const r = read(t.store, { target: th('Svc.validate') }, c);
    expect(r.text.split('\n')[0]).toBe(`${SVC}:22-24 ${th('Svc.validate')}`);
    expect(r.text).toContain('    private void validate(Order o) {');
  });

  it('matches an overload by its signature after a re-parse', async () => {
    setReextract(true);
    setExtractor(parseSvc);
    read(t.store, { target: th('place2') }, c);
    await settleExtractions();
    const r = read(t.store, { target: th('place2'), fresh: true }, c);
    expect(r.text).toBe(`${SVC}:18-20 ${th('place2')}\n${slice(shifted, 18, 20)}`);
    expect(read(t.store, { target: th('place1'), fresh: true }, c).text.split('\n')[0]).toBe(`${SVC}:13-16 ${th('place1')}`);
  });

  it('maps path:LINE of a changed file to the symbol covering that line now', async () => {
    setReextract(true);
    setExtractor(parseSvc);
    // Before the re-parse is ready: a window around the requested line, never a range that misses it.
    const first = read(t.store, { target: `${SVC}:19` }, c);
    expect(first.text.split('\n')[0]).toBe(`${SVC}:1-25`);
    await settleExtractions();
    const r = read(t.store, { target: `${SVC}:19`, fresh: true }, c);
    expect(r.text.split('\n')[0]).toBe(`${SVC}:18-20 ${th('place2')}`);
  });
});
