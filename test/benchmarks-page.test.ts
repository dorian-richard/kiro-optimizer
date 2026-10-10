import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const html = readFileSync(join(ROOT, 'docs', 'benchmarks.html'), 'utf8');

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
// SVG shapes are written self-closed (`<path .../>`), which the tokenizer below treats as closed.

/** Open/close tag balance, ignoring comments and the contents of <script> and <style>. */
function unbalancedTags(doc: string): string[] {
  const text = doc.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  const stack: string[] = [];
  const problems: string[] = [];
  for (const m of text.matchAll(/<(\/?)([a-zA-Z][\w-]*)\b[^>]*?(\/?)>/g)) {
    const [, closing, rawName, selfClosing] = m;
    const name = rawName.toLowerCase();
    if (name === '!doctype' || VOID.has(name) || selfClosing) continue;
    if (!closing) stack.push(name);
    else if (stack[stack.length - 1] === name) stack.pop();
    else problems.push(`</${name}> closes <${stack[stack.length - 1] ?? 'nothing'}>`);
  }
  return [...problems, ...stack.map((s) => `<${s}> never closed`)];
}

describe('docs/benchmarks.html and docs/BENCHMARKS.md', () => {
  it('are up to date with the committed result files', () => {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-benchmarks-page.mjs'), '--check'], { cwd: ROOT, encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('is one well-formed, self-contained page', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toMatch(/<html lang="en">/);
    expect(html).toMatch(/<meta charset="utf-8">/);
    expect(html).toMatch(/<meta name="viewport"/);
    expect(html).toMatch(/<title>[^<]+<\/title>/);
    expect(unbalancedTags(html)).toEqual([]);
    // no network: no external script, stylesheet, image or font
    expect(html).not.toMatch(/<(script|img|iframe)\b[^>]*\bsrc=/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/@import|url\(/);
    for (const bad of ['undefined', 'NaN', '[object Object]', '@@CHART', '<!--v:']) expect(html, bad).not.toContain(bad);
  });

  it('has unique ids, working in-page links, accessible charts and a valid inline script', () => {
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of html.matchAll(/href="#([^"]+)"/g)) expect(ids, `#${m[1]}`).toContain(m[1]);
    const svgs = [...html.matchAll(/<svg\b[^>]*>/g)].map((m) => m[0]);
    expect(svgs.length).toBeGreaterThanOrEqual(6);
    for (const s of svgs) {
      expect(s).toContain('role="img"');
      const labels = /aria-labelledby="([^"]+)"/.exec(s)?.[1].split(' ') ?? [];
      expect(labels).toHaveLength(2);
      for (const l of labels) expect(ids).toContain(l);
    }
    // every section that holds a chart also holds its data as a table
    const sections = html.split(/<h[23]\b/).filter((p) => p.includes('<figure class="chart-fig">'));
    expect(sections.length).toBeGreaterThanOrEqual(4);
    for (const p of sections) expect(p).toContain('<table>');
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
    expect(() => new Function(script)).not.toThrow();
  });
});
