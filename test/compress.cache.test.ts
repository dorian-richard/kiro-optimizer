// kopt_run result cache: the workspace fingerprint (git status + the ignored state that changes results) and the
// before/after rule that keeps an edit made during a run from being attached to the old output.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, type KoptConfig } from '../src/core/config.js';
import { newToolContext } from '../src/core/context.js';
import { fingerprintParts, fingerprintPartsAsync, isReadOnlyCommand, runCommand, workspaceFingerprint } from '../src/compress/index.js';

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `kopt-${prefix}-`));
  dirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function git(cwd: string, ...args: string[]) {
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'ignore' });
}

/** Bump a file's mtime (and content) so the change is visible even on coarse-mtime filesystems. */
function touch(path: string, content?: string, when = Date.now() / 1000 + 5): void {
  if (content !== undefined) writeFileSync(path, content);
  utimesSync(path, when, when);
}

function newRepo(gitignore: string): { repo: string; cfg: KoptConfig; counter: string; count: () => number } {
  const repo = tempDir('cache');
  const counter = join(tempDir('counter'), 'count.txt');
  writeFileSync(join(repo, '.gitignore'), gitignore);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'kopt-cache', version: '1.0.0', private: true, scripts: { test: 'node t.js' } }));
  writeFileSync(
    join(repo, 't.js'),
    [
      `require('fs').appendFileSync(${JSON.stringify(counter)}, 'x');`,
      `const fs = require('fs');`,
      `const flag = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8').trim() : 'missing';`,
      `if (process.argv[2] === 'wait') { const until = Date.now() + Number(process.argv[3]); while (Date.now() < until) {} }`,
      `console.log('FLAG ' + flag + ' src=' + fs.readFileSync('src.txt', 'utf8').trim());`,
      `process.exit(flag === 'FLAG=ok' ? 0 : 1);`,
    ].join('\n'),
  );
  writeFileSync(join(repo, 'src.txt'), 'v1\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  const cfg = defaultConfig(repo);
  cfg.dataDir = join(tempDir('data'), 'kopt');
  return { repo, cfg, counter, count: () => (existsSync(counter) ? readFileSync(counter, 'utf8').length : 0) };
}

describe('workspace fingerprint: ignored state', () => {
  let repo: string;
  beforeAll(() => {
    ({ repo } = newRepo(['node_modules/', '.env*', '.venv/', 'dist/', 'target/', '*.log', '__pycache__/', '.idea/', 'generated/', ''].join('\n')));
  });

  it('env files and installed dependencies are inputs', () => {
    const fp0 = fingerprintParts(repo);
    writeFileSync(join(repo, '.env'), 'FLAG=bad\n');
    const fp1 = fingerprintParts(repo);
    expect(fp1.inputs).not.toBe(fp0.inputs);
    touch(join(repo, '.env'), 'FLAG=ok\n');
    const fp2 = fingerprintParts(repo);
    expect(fp2.inputs).not.toBe(fp1.inputs);

    // npm install rewrites node_modules/.package-lock.json
    mkdirSync(join(repo, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'dep', 'index.js'), '');
    writeFileSync(join(repo, 'node_modules', '.package-lock.json'), '{}');
    const fp3 = fingerprintParts(repo);
    expect(fp3.inputs).not.toBe(fp2.inputs);
    touch(join(repo, 'node_modules', '.package-lock.json'), '{"x":1}');
    const fp4 = fingerprintParts(repo);
    expect(fp4.inputs).not.toBe(fp3.inputs);
    // a file deep inside a package is not looked at (the install markers are)
    writeFileSync(join(repo, 'node_modules', 'dep', 'index.js'), 'changed');
    expect(fingerprintParts(repo).inputs).toBe(fp4.inputs);

    // a lockfile the project keeps out of git is an input too
    writeFileSync(join(repo, '.gitignore'), `${readFileSync(join(repo, '.gitignore'), 'utf8')}yarn.lock\n`);
    git(repo, 'add', '.gitignore');
    git(repo, 'commit', '-q', '-m', 'ignore yarn.lock');
    writeFileSync(join(repo, 'yarn.lock'), '# v1\n');
    const fpLock = fingerprintParts(repo);
    touch(join(repo, 'yarn.lock'), '# v2\n');
    expect(fingerprintParts(repo).inputs).not.toBe(fpLock.inputs);

    // pip install into a virtualenv changes its site-packages dir
    const fpVenv = fingerprintParts(repo);
    const sp = join(repo, '.venv', 'lib', 'python3.12', 'site-packages');
    mkdirSync(sp, { recursive: true });
    writeFileSync(join(repo, '.venv', 'pyvenv.cfg'), 'home = /usr/bin\n');
    const fp5 = fingerprintParts(repo);
    expect(fp5.inputs).not.toBe(fpVenv.inputs);
    mkdirSync(join(sp, 'requests'));
    touch(sp, undefined);
    expect(fingerprintParts(repo).inputs).not.toBe(fp5.inputs);
  });

  it('build outputs are part of the key but not of the inputs; caches and logs are ignored', () => {
    mkdirSync(join(repo, 'dist'), { recursive: true });
    writeFileSync(join(repo, 'dist', 'main.js'), 'v1');
    const fp0 = fingerprintParts(repo);
    touch(join(repo, 'dist', 'main.js'), 'v2');
    const fp1 = fingerprintParts(repo);
    expect(fp1.inputs).toBe(fp0.inputs);
    expect(fp1.outputs).not.toBe(fp0.outputs);
    expect(fp1.key).not.toBe(fp0.key);

    // a nested module's target/ and an arbitrary ignored codegen dir count as outputs too
    mkdirSync(join(repo, 'mod', 'target', 'classes'), { recursive: true });
    const fp2 = fingerprintParts(repo);
    expect(fp2.outputs).not.toBe(fp1.outputs);
    mkdirSync(join(repo, 'generated'), { recursive: true });
    writeFileSync(join(repo, 'generated', 'Api.java'), 'class Api {}');
    expect(fingerprintParts(repo).outputs).not.toBe(fp2.outputs);

    // noise: logs, bytecode caches, editor state
    const fp3 = fingerprintParts(repo);
    writeFileSync(join(repo, 'server.log'), 'noise');
    mkdirSync(join(repo, '__pycache__'), { recursive: true });
    writeFileSync(join(repo, '__pycache__', 'm.cpython-312.pyc'), 'x');
    mkdirSync(join(repo, '.idea'), { recursive: true });
    writeFileSync(join(repo, '.idea', 'workspace.xml'), '<x/>');
    expect(fingerprintParts(repo)).toEqual(fp3);
    expect(workspaceFingerprint(repo)).toBe(fp3.key);
  });
});

describe('workspace fingerprint without git: skipped dirs', () => {
  it('tracks dependency markers and build outputs, not their whole content', () => {
    const dir = tempDir('nogit-ignored');
    writeFileSync(join(dir, 'a.txt'), 'a');
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
    mkdirSync(join(dir, 'target'), { recursive: true });
    const fp0 = fingerprintParts(dir);
    writeFileSync(join(dir, 'node_modules', 'x', 'i.js'), 'ignored');
    expect(fingerprintParts(dir)).toEqual(fp0);
    writeFileSync(join(dir, 'node_modules', '.package-lock.json'), '{}');
    const fp1 = fingerprintParts(dir);
    expect(fp1.inputs).not.toBe(fp0.inputs);
    writeFileSync(join(dir, 'target', 'app.jar'), 'jar');
    const fp2 = fingerprintParts(dir);
    expect(fp2.inputs).toBe(fp1.inputs);
    expect(fp2.outputs).not.toBe(fp1.outputs);
  });
});

describe('kopt_run cache and ignored state', () => {
  it('re-runs after a gitignored .env or a dependency install changes (no stale verdict)', async () => {
    const { repo, cfg, count } = newRepo('node_modules/\n.env\n');
    writeFileSync(join(repo, '.env'), 'FLAG=bad\n');
    const ctx = newToolContext(cfg);
    const r1 = await runCommand({ command: 'npm test' }, ctx);
    expect(r1.meta).toMatchObject({ exitCode: 1, cached: false, stored: true });
    expect(r1.text).toContain('FLAG FLAG=bad');
    expect((await runCommand({ command: 'npm test' }, ctx)).meta).toMatchObject({ cached: true });
    expect(count()).toBe(1);

    touch(join(repo, '.env'), 'FLAG=ok\n');
    const r2 = await runCommand({ command: 'npm test' }, ctx);
    expect(count()).toBe(2);
    expect(r2.meta).toMatchObject({ exitCode: 0, cached: false });
    expect(r2.text).toContain('FLAG FLAG=ok');

    mkdirSync(join(repo, 'node_modules'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', '.package-lock.json'), '{}');
    const r3 = await runCommand({ command: 'npm test' }, ctx);
    expect(count()).toBe(3);
    expect(r3.meta).toMatchObject({ cached: false });
  });

  it('does not cache a run during which a file changed, then caches the next one', async () => {
    const { repo, cfg, count } = newRepo('.env\n');
    writeFileSync(join(repo, '.env'), 'FLAG=ok\n');
    const ctx = newToolContext(cfg);
    // the test reads src.txt at the end of a 1.5 s run; src.txt is edited 0.5 s into it
    const cmd = 'npm test -- wait 1500';
    const run = runCommand({ command: cmd }, ctx);
    await new Promise((res) => setTimeout(res, 500));
    touch(join(repo, 'src.txt'), 'v2\n');
    const r1 = await run;
    expect(r1.meta).toMatchObject({ cached: false, cacheable: true, stored: false });
    // nothing changed since the edit, but the stored output (if any) would predate it: the command runs again
    const r2 = await runCommand({ command: cmd }, ctx);
    expect(count()).toBe(2);
    expect(r2.meta).toMatchObject({ cached: false, stored: true });
    expect(r2.text).toContain('src=v2');
    const r3 = await runCommand({ command: cmd }, newToolContext(cfg));
    expect(r3.meta).toMatchObject({ cached: true });
    expect(count()).toBe(2);
  });

  it('a command that writes its own ignored build output is still cached', async () => {
    const { repo, cfg, count } = newRepo('.env\ndist/\n');
    writeFileSync(join(repo, '.env'), 'FLAG=ok\n');
    writeFileSync(join(repo, 'build.js'), "require('fs').mkdirSync('dist', { recursive: true });\nrequire('fs').writeFileSync('dist/out.js', String(Date.now()));\nconsole.log('built');\n");
    const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
    pkg.scripts.test = 'node build.js && node t.js';
    writeFileSync(join(repo, 'package.json'), JSON.stringify(pkg));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'build');
    const ctx = newToolContext(cfg);
    const r1 = await runCommand({ command: 'npm test' }, ctx);
    expect(r1.meta).toMatchObject({ exitCode: 0, stored: true });
    const r2 = await runCommand({ command: 'npm test' }, newToolContext(cfg));
    expect(r2.meta).toMatchObject({ cached: true });
    expect(count()).toBe(1);
    // a rebuild from the shell afterwards invalidates it
    touch(join(repo, 'dist', 'out.js'), 'rebuilt', Date.now() / 1000 + 60);
    const r3 = await runCommand({ command: 'npm test' }, newToolContext(cfg));
    expect(r3.meta).toMatchObject({ cached: false });
    expect(count()).toBe(2);
  });

  it('joins an identical run in progress instead of starting it twice', async () => {
    const { repo, cfg, count } = newRepo('.env\n');
    writeFileSync(join(repo, '.env'), 'FLAG=ok\n');
    const cmd = 'npm test -- wait 800';
    const [a, b] = await Promise.all([runCommand({ command: cmd }, newToolContext(cfg)), runCommand({ command: cmd }, newToolContext(cfg))]);
    expect(count()).toBe(1);
    expect(b.text).toBe(a.text);
    expect([a.meta?.joined, b.meta?.joined].filter(Boolean)).toHaveLength(1);
    // fresh:true never joins
    const [c, d] = await Promise.all([runCommand({ command: cmd, fresh: true }, newToolContext(cfg)), runCommand({ command: cmd, fresh: true }, newToolContext(cfg))]);
    expect(c.meta?.joined).toBeUndefined();
    expect(d.meta?.joined).toBeUndefined();
    expect(count()).toBe(3);
    void repo;
  });
});

describe('fingerprint cost on big checkouts', () => {
  it('the async fingerprint equals the sync one, in a git repo and outside git', async () => {
    const { repo } = newRepo('node_modules/\n');
    writeFileSync(join(repo, 'untracked.txt'), 'u');
    expect(await fingerprintPartsAsync(repo)).toEqual(fingerprintParts(repo));
    const plain = tempDir('plain');
    writeFileSync(join(plain, 'a.txt'), 'a');
    expect(await fingerprintPartsAsync(plain)).toEqual(fingerprintParts(plain));
  });

  it('read-only commands (git log/diff/status piped through grep, head...) skip the fingerprint after the run', () => {
    for (const c of ['git log -n 3000', 'git log --oneline | head -50', 'git diff HEAD~1 | grep -c foo', 'git status', 'git ls-files | wc -l', 'cd sub && git blame a.ts']) {
      expect(isReadOnlyCommand(c), c).toBe(true);
    }
    for (const c of ['npm test', 'git commit -m x', 'git log > out.txt; sed -i s/a/b/ f', 'git log | tee log.txt', 'mvn -q test', 'git checkout main', 'git']) {
      expect(isReadOnlyCommand(c), c).toBe(false);
    }
  });
});
