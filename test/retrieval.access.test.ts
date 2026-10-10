import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../src/core/config.js';
import { newToolContext, type ToolContext } from '../src/core/context.js';
import { outline, read, setReextract } from '../src/retrieval/index.js';
import { type Seeded, seedStore } from './helpers/seed.js';

// kopt_read and kopt_outline are auto-approved: they must not serve what git and Kiro keep out of the project.
let s: Seeded;
let ctx: ToolContext;
let outside: string;
let linked = true;

beforeAll(() => {
  setReextract(false);
  s = seedStore();
  outside = mkdtempSync(join(tmpdir(), 'kopt-outside-'));
  writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE-SECRET\n');
  const w = (rel: string, text: string) => {
    mkdirSync(join(s.root, rel, '..'), { recursive: true });
    writeFileSync(join(s.root, rel), text);
  };
  w('.gitignore', '.env\nlocal/\n');
  w('.env', 'AWS_SECRET_ACCESS_KEY=dotenv-secret\n');
  w('local/notes.md', '# private notes\n');
  w('.kiroignore', 'secrets/\n');
  w('secrets/prod.ts', 'export const dbPassword = "hunter2";\n');
  w('web/.gitignore', 'generated.ts\n');
  w('web/generated.ts', 'export const token = "nested-ignored";\n');
  w('.git/config', '[remote "origin"]\n  url = https://user:token@example.com/repo.git\n');
  w('docs/readme.md', '# Public docs\n');
  try {
    symlinkSync(join(outside, 'secret.txt'), join(s.root, 'docs', 'creds.txt'));
  } catch {
    linked = false; // Windows without symlink rights
  }
});
afterAll(() => {
  s.cleanup();
  rmSync(outside, { recursive: true, force: true });
});
beforeEach(() => {
  ctx = newToolContext(defaultConfig(s.root));
});

describe('access rules', () => {
  it('refuses git-ignored and kiro-ignored files, nested rules included, in one line', () => {
    for (const [target, reason] of [
      ['.env', 'excluded by .gitignore or .kiroignore'],
      ['local/notes.md', 'excluded by .gitignore or .kiroignore'],
      ['secrets/prod.ts', 'excluded by .gitignore or .kiroignore'],
      ['secrets/prod.ts:1-1', 'excluded by .gitignore or .kiroignore'],
      ['web/generated.ts', 'excluded by .gitignore or .kiroignore'],
      ['.git/config', 'inside .git'],
    ]) {
      const r = read(s.store, { target }, ctx);
      expect(r.text, target).toBe(`${target.replace(/:1-1$/, '')}: not readable through kopt (${reason})`);
      expect(r.text).not.toMatch(/dotenv-secret|hunter2|user:token|nested-ignored/);
    }
    expect(outline(s.store, { path: 'secrets/prod.ts' }, ctx).text).toMatch(/not readable through kopt/);
    expect(outline(s.store, { path: '.git' }, ctx).text).toMatch(/inside \.git/);
  });

  it('refuses paths and links that leave the project', () => {
    expect(read(s.store, { target: `${outside}/secret.txt` }, ctx).text).toMatch(/not readable through kopt \(outside the project\)/);
    expect(read(s.store, { target: '../x/secret.txt' }, ctx).text).toMatch(/outside the project/);
    if (linked) {
      const r = read(s.store, { target: 'docs/creds.txt' }, ctx);
      expect(r.text).toBe('docs/creds.txt: not readable through kopt (a link that leaves the project)');
    }
  });

  it('still reads ordinary files that are not indexed', () => {
    expect(read(s.store, { target: 'docs/readme.md' }, ctx).text).toBe('docs/readme.md:1-1\n# Public docs');
  });
});
