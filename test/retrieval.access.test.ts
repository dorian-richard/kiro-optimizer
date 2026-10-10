import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultConfig } from '../src/core/config.js';
import { filterPaths, ignoreTestsOnePath, listFiles } from '../src/indexer/walker.js';
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

// Acceptance test of v0.2.1: files ignored only by the user's global git excludes were served; a nested ignore file
// could re-include a file inside an excluded folder (git cannot), and a nested .kiroignore re-included what the root
// one excludes (Kiro cannot); a folder a deeper .gitignore re-includes stayed unreadable.
describe('ignore semantics of git and Kiro', () => {
  let top: string;
  const REFUSED = (p: string) => `${p}: not readable through kopt (excluded by .gitignore or .kiroignore)`;
  // never the developer's git setup: no inherited repository or global config file
  const gitEnv = () => ({ ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_CONFIG_GLOBAL: undefined, GIT_CONFIG_SYSTEM: undefined, GIT_CONFIG_NOSYSTEM: '1' });
  const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8' });
  const hasGit = git(tmpdir(), '--version').status === 0;
  const files = (root: string, spec: Record<string, string>) => {
    for (const [rel, text] of Object.entries(spec)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
  };
  const readAt = (root: string, target: string) => {
    const store = Store.open(':memory:', { root });
    try {
      return read(store, { target }, newToolContext(defaultConfig(root))).text;
    } finally {
      store.close();
    }
  };
  const repo = (name: string) => {
    const dir = join(top, name);
    mkdirSync(dir, { recursive: true });
    if (hasGit) git(dir, 'init', '-q');
    else mkdirSync(join(dir, '.git', 'info'), { recursive: true });
    return dir;
  };
  beforeAll(() => {
    top = mkdtempSync(join(tmpdir(), 'kopt-ignore-'));
  });
  afterAll(() => rmSync(top, { recursive: true, force: true }));

  it('the single-path test of `ignore` is available (folders are checked on their own)', () => {
    expect(ignoreTestsOnePath()).toBe(true);
  });

  it.runIf(hasGit)('global git excludes: core.excludesFile (`~` expanded, repository config included), else XDG_CONFIG_HOME, else ~/.config/git/ignore', () => {
    const keys = ['HOME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM', 'GIT_DIR', 'GIT_WORK_TREE'] as const;
    const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    const home = join(top, 'home');
    // what git itself says, with the same environment
    const gitIgnores = (cwd: string, p: string) => spawnSync('git', ['check-ignore', '-q', p], { cwd, env: process.env }).status === 0;
    try {
      for (const k of keys) delete process.env[k];
      process.env.HOME = home;
      process.env.GIT_CONFIG_NOSYSTEM = '1';
      files(home, { '.config/git/ignore': '*.secret\n' });
      const a = repo('xdg-default');
      files(a, { 'token.secret': 'LEAK-default\n', 'ok.txt': 'ok\n' });
      expect(readAt(a, 'token.secret')).toBe(REFUSED('token.secret'));
      expect(gitIgnores(a, 'token.secret')).toBe(true);
      expect(readAt(a, 'ok.txt')).toBe('ok.txt:1-1\nok');

      process.env.XDG_CONFIG_HOME = join(home, 'xdg');
      files(home, { 'xdg/git/ignore': '.envrc\n' });
      const b = repo('xdg');
      files(b, { '.envrc': 'export TOKEN=LEAK-xdg\n', 'token.secret': 'served\n' });
      expect(readAt(b, '.envrc')).toBe(REFUSED('.envrc'));
      expect(readAt(b, 'token.secret')).toBe('token.secret:1-1\nserved'); // git reads one of the two, not both
      expect([gitIgnores(b, '.envrc'), gitIgnores(b, 'token.secret')]).toEqual([true, false]);

      files(home, { '.gitconfig': '[core]\n\texcludesFile = ~/gx\n', gx: 'creds.ini\n' });
      const c = repo('configured');
      files(c, { 'creds.ini': 'LEAK-configured\n', '.envrc': 'served\n' });
      expect(readAt(c, 'creds.ini')).toBe(REFUSED('creds.ini'));
      expect(readAt(c, '.envrc')).toBe('.envrc:1-1\nserved');
      expect([gitIgnores(c, 'creds.ini'), gitIgnores(c, '.envrc')]).toEqual([true, false]);

      const d = repo('repo-config');
      files(home, { 'repo-ignore': 'local.only\n' });
      appendFileSync(join(d, '.git', 'config'), `[core]\n\texcludesFile = ${join(home, 'repo-ignore').replace(/\\/g, '/')}\n`);
      files(d, { 'local.only': 'LEAK-repo-config\n', 'creds.ini': 'served\n' });
      expect(readAt(d, 'local.only')).toBe(REFUSED('local.only'));
      expect(readAt(d, 'creds.ini')).toBe('creds.ini:1-1\nserved');
      expect([gitIgnores(d, 'local.only'), gitIgnores(d, 'creds.ini')]).toEqual([true, false]);
    } finally {
      for (const k of keys) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
  });

  const TREE: Record<string, string> = {
    '.gitignore': 'logs/\nbuild\n*.key\n',
    'logs/.gitignore': '*\n!app.ts\n',
    'logs/app.ts': 'export const LEAK_nested = 1;\n',
    'www/apps/book/.gitignore': '!/app/learn/build\n',
    'www/apps/book/app/learn/build/page.ts': 'export const page = 1;\n',
    'www/apps/book/app/learn/build/x.key': 'LEAK-key\n',
    'www/apps/book/app/other/build/out.ts': 'export const LEAK_build = 1;\n',
    'deep/.gitignore': '!*.key\n',
    'deep/kept.key': 'served\n',
    '.kiroignore': 'kiro-secret.ts\n*.gen.ts\n!keep.gen.ts\n',
    'src/.kiroignore': '!kiro-secret.ts\n',
    'src/kiro-secret.ts': 'export const LEAK_kiro = 1;\n',
    'src/keep.gen.ts': 'export const kept = 1;\n',
    'src/drop.gen.ts': 'export const LEAK_gen = 1;\n',
    'src/ok.ts': 'export const ok = 1;\n',
  };

  it('a file inside an excluded folder stays excluded; a folder a deeper .gitignore re-includes is readable (as git says)', () => {
    const r = repo('nested');
    files(r, TREE);
    const verdicts: Record<string, boolean> = {
      'logs/app.ts': true,
      'www/apps/book/app/learn/build/page.ts': false,
      'www/apps/book/app/learn/build/x.key': true,
      'www/apps/book/app/other/build/out.ts': true,
      'deep/kept.key': false,
      'src/ok.ts': false,
    };
    for (const [p, refused] of Object.entries(verdicts)) {
      if (hasGit) expect(git(r, 'check-ignore', '-q', p).status === 0, `git check-ignore ${p}`).toBe(refused);
      const text = readAt(r, p);
      if (refused) expect(text, p).toBe(REFUSED(p));
      else expect(text, p).toMatch(new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:1-1\n`));
    }
  });

  it('.kiroignore: a nested file cannot re-include what another one excludes; a file can within itself', () => {
    const r = repo('kiro');
    files(r, TREE);
    expect(readAt(r, 'src/kiro-secret.ts')).toBe(REFUSED('src/kiro-secret.ts'));
    expect(readAt(r, 'src/drop.gen.ts')).toBe(REFUSED('src/drop.gen.ts'));
    expect(readAt(r, 'src/keep.gen.ts')).toBe('src/keep.gen.ts:1-1\nexport const kept = 1;');
  });

  it('the indexer lists and refreshes by the same rules (git listing, walk without git, explicit paths)', async () => {
    const expected = ['src/keep.gen.ts', 'src/ok.ts', 'www/apps/book/app/learn/build/page.ts'];
    const r = repo('index-git');
    files(r, TREE);
    const plain = join(top, 'index-plain');
    files(plain, TREE);
    for (const root of hasGit ? [r, plain] : [plain]) {
      // no default excludes (they leave out build/ folders as noise)
      const listed = (await listFiles({ ...defaultConfig(root), exclude: [] })).files;
      expect(listed, root).toEqual(expected);
    }
    const { keep } = filterPaths({ ...defaultConfig(plain), exclude: [] }, Object.keys(TREE).filter((p) => p.endsWith('.ts')));
    expect(keep.sort()).toEqual(expected);
  });
});
