import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../src/core/config.js';
import { newToolContext, type ToolContext } from '../src/core/context.js';
import { failureContext, find, outline, read, refs, setExtractor, setReextract, settleExtractions } from '../src/retrieval/index.js';
import { Store, symbolHandle } from '../src/store/store.js';
import { type FileSpec, type Seeded, seedStore } from './helpers/seed.js';

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

// Acceptance test of v0.2.0: a target with no `/` and no known extension was taken for a symbol name, skipped the
// access rules, and was then served from disk (`debug.log`, `id_rsa`, `./debug.log`). Every read path is covered here.
describe('access rules on every read path', () => {
  const SPECS: FileSpec[] = [
    {
      path: 'src/app.ts',
      lang: 'typescript',
      rank: 0.5,
      text: [
        'export function useConfig(): string {',
        '  return loadSecret();',
        '}',
        '',
        'export function computeTotal(a: number, b: number): number {',
        '  return a + b;',
        '}',
        '',
        'export class Logger {',
        '  log(msg: string): void {',
        '    console.info(msg);',
        '  }',
        '}',
        '',
      ].join('\n'),
      symbols: [
        { key: 'useConfig', kind: 'function', exported: true },
        { key: 'computeTotal', kind: 'function', exported: true },
        { key: 'Logger', kind: 'class', exported: true },
        { key: 'Logger.log', kind: 'method', at: 'log(msg' },
      ],
      refs: [{ from: 'useConfig', name: 'loadSecret', to: 'loadSecret' }],
    },
    {
      path: 'vault/secret.ts',
      lang: 'typescript',
      rank: 0.5,
      text: [
        'export function loadSecret(): string {',
        "  return 'VAULT-SECRET-123';",
        '}',
        '',
        'export function leak(): string {',
        "  return useConfig() + 'VAULT-CALLER-SECRET';",
        '}',
        '',
        'export function rejectToken(): never {',
        "  throw new Error('vault token rejected by policy');",
        '}',
        '',
      ].join('\n'),
      symbols: [
        { key: 'loadSecret', kind: 'function', exported: true },
        { key: 'leak', kind: 'function', exported: true },
        { key: 'rejectToken', kind: 'function', exported: true },
      ],
      refs: [{ from: 'leak', name: 'useConfig', to: 'useConfig' }],
    },
  ];
  const IGNORED = ['debug.log', 'cert.pem', 'notes.swp', 'proj.iml', 'id_rsa', 'credentials', 'server.key', 'jmx.log'];
  let v: Seeded;
  let vctx: ToolContext;
  let vlinked = true;
  const LEAK = /LEAK-|FILE-COMPUTE-TOTAL|FILE-LOGGER-LOG|VAULT-SECRET-123|VAULT-CALLER-SECRET/;

  beforeAll(() => {
    setReextract(false);
    // Indexed first, ignored afterwards: vault/ became ignored since the index was built.
    v = seedStore({ specs: SPECS });
    const w = (rel: string, text: string) => {
      mkdirSync(join(v.root, rel, '..'), { recursive: true });
      writeFileSync(join(v.root, rel), text);
    };
    w('.gitignore', ['vault/', '*.log', '*.pem', '*.swp', '*.iml', 'id_rsa', 'credentials', 'computeTotal', ''].join('\n'));
    w('.git/info/exclude', 'server.key\n');
    for (const f of IGNORED) w(f, `LEAK-${f}\n`);
    w('computeTotal', 'FILE-COMPUTE-TOTAL\n');
    w('Logger.log', 'FILE-LOGGER-LOG\n');
    w('Makefile', 'all:\n\techo build\n');
    mkdirSync(join(v.root, 'docs'), { recursive: true });
    try {
      symlinkSync(join(v.root, 'vault', 'secret.ts'), join(v.root, 'docs', 'link.ts'));
    } catch {
      vlinked = false;
    }
  });
  afterAll(() => v.cleanup());
  beforeEach(() => {
    vctx = newToolContext(defaultConfig(v.root));
  });

  it('refuses ignored files whose names look like symbols, at the root and as ./name', () => {
    for (const f of IGNORED) {
      for (const target of [f, `./${f}`]) {
        const r = read(v.store, { target }, vctx);
        expect(r.text, target).toBe(`${f}: not readable through kopt (excluded by .gitignore or .kiroignore)`);
        for (const mode of ['skeleton', 'card'] as const) expect(read(v.store, { target, mode }, vctx).text, `${target} ${mode}`).not.toMatch(LEAK);
        expect(outline(v.store, { path: target }, vctx).text, `outline ${target}`).toMatch(/not readable through kopt/);
      }
      expect(read(v.store, { target: `${f}:1-1` }, vctx).text).toMatch(/not readable through kopt/);
    }
    // other spellings of the same files: never their content
    for (const target of ['DEBUG.LOG', 'Id_Rsa', '.GIT/config', './/debug.log']) expect(read(v.store, { target }, vctx).text, target).not.toMatch(LEAK);
    expect(read(v.store, { target: '.GIT/config' }, vctx).text).toBe('.GIT/config: not readable through kopt (inside .git)');
  });

  it('a symbol name that is also an ignored file gives the symbol, never the file', () => {
    const t = read(v.store, { target: 'computeTotal' }, vctx).text;
    expect(t).toMatch(/^src\/app\.ts:5-7 #\w+\n/);
    expect(t).toContain('return a + b;');
    const l = read(v.store, { target: 'Logger.log' }, vctx).text;
    expect(l).toContain('console.info(msg);');
    for (const x of [t, l]) expect(x).not.toMatch(LEAK);
  });

  it('still reads plain files without an extension that nothing ignores', () => {
    expect(read(v.store, { target: 'Makefile' }, vctx).text).toBe('Makefile:1-2\nall:\n\techo build');
  });

  it('refuses a link inside the project that points at an ignored file', () => {
    if (!vlinked) return;
    expect(read(v.store, { target: 'docs/link.ts' }, vctx).text).toBe('docs/link.ts: not readable through kopt (excluded by .gitignore or .kiroignore)');
    expect(outline(v.store, { path: 'docs/link.ts' }, vctx).text).toMatch(/not readable through kopt/);
  });

  it('an indexed file that is ignored now: no handle, name, range or outline serves it', () => {
    const handle = symbolHandle(v.ids.loadSecret);
    for (const target of [handle, 'loadSecret', 'vault/secret.ts', 'vault/secret.ts:1-3', 'vault/secret.ts:2', 'secret.ts']) {
      const r = read(v.store, { target }, vctx);
      expect(r.text, target).toMatch(/^vault\/secret\.ts: not readable through kopt \(excluded by \.gitignore or \.kiroignore\)$/);
    }
    expect(read(v.store, { target: handle, mode: 'skeleton' }, vctx).text).not.toMatch(LEAK);
    expect(outline(v.store, { path: 'vault/secret.ts' }, vctx).text).toMatch(/not readable through kopt/);
    expect(outline(v.store, { path: 'vault' }, vctx).text).toBe('vault: not readable through kopt (excluded by .gitignore or .kiroignore)');
    expect(outline(v.store, { path: handle }, vctx).text).not.toMatch(LEAK);
  });

  it('find pack bodies, refs code lines and kopt_run source hints never quote a refused file', () => {
    const pack = find(v.store, { query: 'loadSecret', mode: 'pack' }, vctx).text;
    expect(pack).not.toMatch(LEAK);
    const callers = refs(v.store, { target: 'useConfig' }, vctx).text;
    expect(callers).not.toMatch(LEAK);
    // "<message> is written in <function>" needs the file's text: not for a refused file
    const hint = failureContext(v.store, ['FAIL test/app.test.ts > rejects', 'Error: vault token rejected by policy'].join('\n'), 200);
    expect(hint ?? '').not.toMatch(/rejectToken|vault\/secret/);
  });

  it('no background re-extraction of a refused file that changed', async () => {
    const seen: string[] = [];
    setExtractor(async (path) => {
      seen.push(path);
      return undefined;
    });
    setReextract(true);
    try {
      writeFileSync(join(v.root, 'vault', 'secret.ts'), `// edited\n${SPECS[1].text}`);
      read(v.store, { target: symbolHandle(v.ids.loadSecret) }, vctx);
      find(v.store, { query: 'loadSecret', mode: 'pack' }, vctx);
      refs(v.store, { target: 'useConfig' }, vctx);
      await settleExtractions();
      expect(seen).not.toContain('vault/secret.ts');
    } finally {
      setReextract(false);
      setExtractor(undefined);
      writeFileSync(join(v.root, 'vault', 'secret.ts'), SPECS[1].text);
    }
  });
});

describe('access rules from the enclosing git repository', () => {
  let top: string;
  beforeAll(() => {
    top = mkdtempSync(join(tmpdir(), 'kopt-parent-'));
  });
  afterAll(() => rmSync(top, { recursive: true, force: true }));

  it('a project inside a repository: the parent .gitignore and info/exclude apply', () => {
    const repo = join(top, 'mono');
    mkdirSync(join(repo, '.git', 'info'), { recursive: true });
    writeFileSync(join(repo, '.gitignore'), '*.secret\n');
    writeFileSync(join(repo, '.git', 'info', 'exclude'), '/svc/private.txt\n');
    mkdirSync(join(repo, 'svc'), { recursive: true });
    writeFileSync(join(repo, 'svc', 'app.secret'), 'LEAK-parent-gitignore\n');
    writeFileSync(join(repo, 'svc', 'private.txt'), 'LEAK-parent-exclude\n');
    writeFileSync(join(repo, 'svc', 'public.txt'), 'public\n');
    const store = Store.open(':memory:', { root: join(repo, 'svc') });
    try {
      const c = newToolContext(defaultConfig(join(repo, 'svc')));
      expect(read(store, { target: 'app.secret' }, c).text).toBe('app.secret: not readable through kopt (excluded by .gitignore or .kiroignore)');
      expect(read(store, { target: 'private.txt' }, c).text).toBe('private.txt: not readable through kopt (excluded by .gitignore or .kiroignore)');
      expect(read(store, { target: 'public.txt' }, c).text).toBe('public.txt:1-1\npublic');
    } finally {
      store.close();
    }
  });

  it('a linked worktree: info/exclude of the shared git dir applies', () => {
    const main = join(top, 'main');
    const wt = join(top, 'wt');
    mkdirSync(join(main, '.git', 'info'), { recursive: true });
    mkdirSync(join(main, '.git', 'worktrees', 'wt'), { recursive: true });
    writeFileSync(join(main, '.git', 'info', 'exclude'), 'local.key\n');
    writeFileSync(join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'wt')}\n`);
    writeFileSync(join(wt, 'local.key'), 'LEAK-worktree\n');
    const store = Store.open(':memory:', { root: wt });
    try {
      const r = read(store, { target: 'local.key' }, newToolContext(defaultConfig(wt)));
      expect(r.text).toBe('local.key: not readable through kopt (excluded by .gitignore or .kiroignore)');
    } finally {
      store.close();
    }
  });

  it.runIf(process.platform === 'win32')('Windows spellings that open an ignored file are refused', () => {
    const repo = join(top, 'win');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.gitignore'), '*.log\n');
    writeFileSync(join(repo, 'debug.log'), 'LEAK-win\n');
    const store = Store.open(':memory:', { root: repo });
    try {
      const c = newToolContext(defaultConfig(repo));
      for (const target of ['debug.log.', 'debug.log ', 'debug.log::$DATA', 'DEBUG~1.LOG', 'DEBUG.LOG']) {
        expect(read(store, { target }, c).text, target).not.toMatch(/LEAK/);
      }
    } finally {
      store.close();
    }
  });
});
