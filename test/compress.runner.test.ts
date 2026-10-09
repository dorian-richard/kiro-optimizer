import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, type KoptConfig } from '../src/core/config.js';
import { newToolContext } from '../src/core/context.js';
import { estimateTokens } from '../src/core/tokens.js';
import { expand, runCommand, workspaceFingerprint } from '../src/compress/index.js';
import { OutputStore } from '../src/compress/outputs.js';
import { execCapture, powershellScript, quoteArg, resolveShell, shellFor } from '../src/compress/runner.js';

const HEADER_RE = /^\$ .+ · exit -?\d+ · \d+(?:\.\d)?s · ~(\d+) tok \(raw ~(\d+)\)$/;
const dirs: string[] = [];

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `kopt-${prefix}-`));
  dirs.push(d);
  return d;
}

/** Data dir inside the temp repo: never the user's cache dir, and `.kopt/` exercises the fingerprint exclusion. */
function config(root: string): KoptConfig {
  const cfg = defaultConfig(root);
  cfg.dataDir = join(root, '.kopt');
  return cfg;
}

function git(cwd: string, ...args: string[]) {
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'ignore' });
}

const WIN = process.platform === 'win32';
const SHELL = resolveShell().kind;
let scripts: string | undefined;
let scriptCount = 0;

/** Command line that runs `args` with this Node through kopt_run's shell (PowerShell needs `&` before a quoted path). */
function nodeCommand(args: string[]): string {
  const line = [process.execPath, ...args].map((a) => quoteArg(a, SHELL)).join(' ');
  return SHELL === 'powershell' ? `& ${line}` : line;
}

/** Runs a Node script written to a file: no nested quoting, so the same test works in bash, PowerShell and cmd. */
const node = (script: string) => {
  scripts ??= tempDir('scripts');
  const file = join(scripts, `s${scriptCount++}.cjs`);
  writeFileSync(file, script);
  return nodeCommand([file]);
};

afterAll(() => {
  // Windows may hold handles on just-killed processes' files for a moment: retry
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('runCommand', () => {
  let root: string;
  let cfg: KoptConfig;
  beforeAll(() => {
    root = tempDir('run');
    cfg = config(root);
  });

  it('compresses a long successful run, stores the log and points to it', async () => {
    const ctx = newToolContext(cfg);
    const r = await runCommand({ command: node("for(let i=0;i<3000;i++){console.log('line '+i+' of output ok')} console.error('warn: done')") }, ctx);
    const lines = r.text.split('\n');
    const h = HEADER_RE.exec(lines[0]);
    expect(h, lines[0]).not.toBeNull();
    expect(Math.abs(Number(h![1]) - r.tokens)).toBeLessThanOrEqual(2);
    expect(Number(h![2])).toBe(r.baselineTokens);
    expect(r.tokens).toBeLessThanOrEqual(cfg.budgets.run);
    expect(r.baselineTokens! / r.tokens).toBeGreaterThan(10);
    expect(r.text).toContain('line 0 of output ok');
    expect(r.text).toContain('line 2999 of output ok');
    expect(r.text).toContain('warn: done');
    const handle = r.meta!.handle as string;
    expect(handle).toMatch(/^o[0-9a-f]{6}$/);
    expect(lines[lines.length - 1]).toBe(`full output: kopt_expand ${handle}`);
    const log = readFileSync(join(cfg.dataDir, 'outputs', `${handle}.log`), 'utf8');
    expect(log.split('\n')).toHaveLength(3001);
    expect(r.meta).toMatchObject({ exitCode: 0, cached: false, cacheable: false, filter: 'generic' });
  });

  it('keeps small outputs verbatim, merges stdout/stderr in arrival order, no expand pointer', async () => {
    const ctx = newToolContext(cfg);
    const r = await runCommand(
      { command: node("process.stdout.write('A\\n'); setTimeout(()=>{process.stderr.write('B\\n'); setTimeout(()=>process.stdout.write('C\\n'),60)},60)") },
      ctx,
    );
    const [head, ...body] = r.text.split('\n');
    expect(head).toMatch(HEADER_RE);
    expect(body).toEqual(['A', 'B', 'C']);
  });

  it('reports failures with the error lines and the exit code', async () => {
    const ctx = newToolContext(cfg);
    const r = await runCommand(
      { command: node("console.log('starting'); for(let i=0;i<500;i++) console.log('step '+i+' done'); console.error('Error: database unreachable at db.ts:12'); process.exit(3)") },
      ctx,
    );
    expect(r.text.split('\n')[0]).toMatch(/ · exit 3 · /);
    expect(r.text).toContain('Error: database unreachable at db.ts:12');
    expect(r.text).toMatch(/full output: kopt_expand o[0-9a-f]{6}$/);
    expect(r.tokens).toBeLessThanOrEqual(cfg.budgets.run);
  });

  it('strips ANSI and carriage-return progress before storing', async () => {
    const ctx = newToolContext(cfg);
    const r = await runCommand(
      { command: node("process.stdout.write('\\x1b[31mred\\x1b[0m\\n'); for(let i=0;i<=100;i+=10) process.stdout.write('progress '+i+'%\\r'); process.stdout.write('done\\n')") },
      ctx,
    );
    expect(r.text.split('\n').slice(1)).toEqual(['red', 'done']);
  });

  it('returns 127 for unknown commands', async () => {
    const ctx = newToolContext(cfg);
    const r = await runCommand({ command: 'definitely-not-a-command-kopt' }, ctx);
    expect(r.text).toMatch(/ · exit 127 · /);
    // bash: "command not found"; PowerShell: "is not recognized as a name of a cmdlet"; cmd: "is not recognized"
    expect(r.text).toMatch(/not found|not recognized/);
  });

  it.skipIf(WIN)('returns 128+n for signals (POSIX)', async () => {
    const s = await runCommand({ command: node("process.kill(process.pid,'SIGTERM')") }, newToolContext(cfg));
    expect(s.text).toMatch(/ · exit 143 · /);
  });

  it('kills the whole process tree on timeout', async () => {
    const ctx = newToolContext(cfg);
    const t0 = Date.now();
    const r = await runCommand(
      {
        command: node(
          "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'}); console.log('child '+c.pid); setInterval(()=>{},1000)",
        ),
        // leaves PowerShell (Windows) time to start before the deadline
        timeoutSec: 3,
      },
      ctx,
    );
    expect(Date.now() - t0).toBeLessThan(12_000);
    expect(r.text).toMatch(/ · exit 124 · /);
    expect(r.text).toContain('timed out after 3s');
    const pid = Number(/child (\d+)/.exec(r.text)?.[1]);
    expect(pid).toBeGreaterThan(0);
    await new Promise((res) => setTimeout(res, 300));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(r.meta).toMatchObject({ timedOut: true });
  });

  it('runs in a sub-directory and refuses to leave the repo', async () => {
    mkdirSync(join(root, 'sub'), { recursive: true });
    const ctx = newToolContext(cfg);
    const r = await runCommand({ command: node('console.log(process.cwd())'), cwd: 'sub' }, ctx);
    expect(r.text.split('\n')[0]).toMatch(/^\$ cd sub && /);
    expect(r.text.trim().endsWith('sub') || r.text.includes('/sub')).toBe(true);
    const out = await runCommand({ command: 'ls', cwd: '../..' }, ctx);
    expect(out.text).toMatch(/^kopt_run: cwd must be inside the repo/);
  });

  it('refuses to run when KOPT_DISABLE_RUN=1 (central mode)', async () => {
    const prev = process.env.KOPT_DISABLE_RUN;
    process.env.KOPT_DISABLE_RUN = '1';
    try {
      const r = await runCommand({ command: 'echo hi' }, newToolContext(cfg));
      expect(r.text).toMatch(/^kopt_run is disabled/);
      expect(r.text.split('\n')).toHaveLength(1);
    } finally {
      if (prev === undefined) delete process.env.KOPT_DISABLE_RUN;
      else process.env.KOPT_DISABLE_RUN = prev;
    }
  });

  it('honours KOPT_SHELL (e.g. pwsh)', () => {
    const prev = process.env.KOPT_SHELL;
    try {
      process.env.KOPT_SHELL = '/usr/local/bin/pwsh';
      expect(shellFor('Get-ChildItem', { platform: 'linux' })).toEqual({
        file: '/usr/local/bin/pwsh',
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', powershellScript('Get-ChildItem')],
        verbatim: false,
        kind: 'powershell',
      });
      process.env.KOPT_SHELL = '/bin/sh';
      expect(shellFor('ls', { platform: 'linux' })).toEqual({ file: '/bin/sh', args: ['-c', 'ls'], verbatim: false, kind: 'posix' });
    } finally {
      if (prev === undefined) delete process.env.KOPT_SHELL;
      else process.env.KOPT_SHELL = prev;
    }
  });

  it('caps the raw capture keeping head and tail', async () => {
    const r = await execCapture({
      command: node("for(let i=0;i<5000;i++) console.log('row '+i)"),
      cwd: root,
      timeoutMs: 20_000,
      maxCaptureChars: 20_000,
    });
    expect(r.exitCode).toBe(0);
    expect(r.droppedChars).toBeGreaterThan(0);
    // a shell that re-emits lines may use CRLF (PowerShell on Windows): compare without CR
    const out = r.output.replace(/\r/g, '');
    expect(out).toContain('row 0\n');
    expect(out).toMatch(/row 4999$/);
    expect(out).toMatch(/\[kopt\] … \d+ lines .* dropped from the middle/);
    expect(r.output.length).toBeLessThan(21_000);
  });
});

describe('dedup cache (git workspace)', () => {
  let repo: string;
  let counter: string;
  let cfg: KoptConfig;
  const count = () => (existsSync(counter) ? readFileSync(counter, 'utf8').length : 0);

  beforeAll(() => {
    repo = tempDir('repo');
    counter = join(tempDir('counter'), 'count.txt');
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ name: 'kopt-fixture', version: '1.0.0', private: true, scripts: { test: 'node count.js' } }),
    );
    writeFileSync(
      join(repo, 'count.js'),
      `require('fs').appendFileSync(${JSON.stringify(counter)}, 'x');\nfor (let i = 0; i < 300; i++) console.log('ok ' + i + ' - test case passed');\n`,
    );
    writeFileSync(join(repo, 'src.txt'), 'v1\n');
    git(repo, 'init', '-q');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    cfg = config(repo);
  });

  it('serves an identical re-run from cache until a file changes', async () => {
    const ctx = newToolContext(cfg);
    const r1 = await runCommand({ command: 'npm test' }, ctx);
    expect(count()).toBe(1);
    expect(r1.meta).toMatchObject({ cached: false, cacheable: true, exitCode: 0 });
    const handle = r1.meta!.handle as string;

    // same session: the verdict is still in context -> one line
    const r2 = await runCommand({ command: 'npm test' }, ctx);
    expect(count()).toBe(1);
    expect(r2.text).toMatch(new RegExp(`^identical to previous run ${handle} \\(call \\d+, exit 0, no file changed since\\) – pass fresh:true to re-run$`));
    expect(r2.meta).toMatchObject({ cached: true });
    expect(r2.baselineTokens).toBe(r1.baselineTokens);

    // new session: the cached compressed text is re-sent, prefixed
    const r3 = await runCommand({ command: 'npm test' }, newToolContext(cfg));
    expect(count()).toBe(1);
    expect(r3.text).toBe(`identical to previous run ${handle} (no file changed since) – pass fresh:true to re-run\n${r1.text}`);

    // another budget: the stored log is re-compressed, still without running
    const r3b = await runCommand({ command: 'npm test', maxTokens: 90 }, ctx);
    expect(count()).toBe(1);
    expect(r3b.tokens).toBeLessThanOrEqual(90);
    expect(r3b.text).toMatch(new RegExp(`^identical to previous run ${handle} \\(no file changed since\\)`));
    expect(r3b.text.split('\n')[1]).toMatch(/^\$ npm test · exit 0 · /);

    // tracked file modified -> runs again
    appendFileSync(join(repo, 'src.txt'), 'v2\n');
    const r4 = await runCommand({ command: 'npm test' }, ctx);
    expect(count()).toBe(2);
    expect(r4.meta).toMatchObject({ cached: false });

    // fresh:true bypasses the cache
    await runCommand({ command: 'npm test', fresh: true }, ctx);
    expect(count()).toBe(3);

    // new untracked file -> runs again; then cached again
    writeFileSync(join(repo, 'new-module.txt'), 'hello\n');
    await runCommand({ command: 'npm test' }, ctx);
    expect(count()).toBe(4);
    const r7 = await runCommand({ command: 'npm test' }, newToolContext(cfg));
    expect(count()).toBe(4);
    expect(r7.meta).toMatchObject({ cached: true });

    // editing an untracked file inside an untracked directory is detected too
    mkdirSync(join(repo, 'pkg'), { recursive: true });
    writeFileSync(join(repo, 'pkg', 'a.txt'), '1');
    await runCommand({ command: 'npm test' }, ctx);
    expect(count()).toBe(5);
    writeFileSync(join(repo, 'pkg', 'a.txt'), '22');
    await runCommand({ command: 'npm test' }, ctx);
    expect(count()).toBe(6);
  });

  it('never caches non-deterministic commands', async () => {
    const ctx = newToolContext(cfg);
    const cmd = node(`require('fs').appendFileSync(${JSON.stringify(counter).replace(/"/g, "'")}, 'y')`);
    const before = count();
    await runCommand({ command: cmd }, ctx);
    await runCommand({ command: cmd }, ctx);
    expect(count()).toBe(before + 2);
  });

  it('git commands use the git filter and are cacheable', async () => {
    const ctx = newToolContext(cfg);
    const r = await runCommand({ command: 'git log' }, ctx);
    expect(r.text).toMatch(/^\$ git log · exit 0 · /);
    expect(r.text).toContain('init');
    const again = await runCommand({ command: 'git log' }, ctx);
    expect(again.meta).toMatchObject({ cached: true });
  });

  it('workspaceFingerprint ignores kopt data and tracks content changes', () => {
    const fp1 = workspaceFingerprint(repo);
    expect(workspaceFingerprint(repo)).toBe(fp1);
    mkdirSync(join(repo, '.kopt', 'tmp'), { recursive: true });
    writeFileSync(join(repo, '.kopt', 'tmp', 'x.log'), 'noise');
    expect(workspaceFingerprint(repo)).toBe(fp1);
    appendFileSync(join(repo, 'src.txt'), 'v3\n');
    expect(workspaceFingerprint(repo)).not.toBe(fp1);
  });
});

describe('workspaceFingerprint without git', () => {
  it('falls back to an mtime/size scan', () => {
    const dir = tempDir('nogit');
    writeFileSync(join(dir, 'a.txt'), 'a');
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
    const fp1 = workspaceFingerprint(dir);
    expect(workspaceFingerprint(dir)).toBe(fp1);
    writeFileSync(join(dir, 'node_modules', 'x', 'i.js'), 'ignored');
    expect(workspaceFingerprint(dir)).toBe(fp1);
    utimesSync(join(dir, 'a.txt'), new Date(2020, 1, 1), new Date(2020, 1, 1));
    const fp2 = workspaceFingerprint(dir);
    expect(fp2).not.toBe(fp1);
    writeFileSync(join(dir, 'b.txt'), 'b');
    expect(workspaceFingerprint(dir)).not.toBe(fp2);
  });
});

describe('expand', () => {
  let cfg: KoptConfig;
  let handle: string;
  beforeAll(async () => {
    cfg = config(tempDir('expand'));
    const r = await runCommand({ command: node("for(let i=0;i<3000;i++){console.log('line '+i+' of output ok')}") }, newToolContext(cfg));
    handle = r.meta!.handle as string;
  });

  it('pages through the log within budget', () => {
    const r = expand({ handle }, newToolContext(cfg));
    const lines = r.text.split('\n');
    const m = new RegExp(`^${handle} lines 1-(\\d+) of 3000$`).exec(lines[0]);
    expect(m, lines[0]).not.toBeNull();
    const shown = Number(m![1]);
    expect(lines[1]).toBe('line 0 of output ok');
    expect(lines[shown]).toBe(`line ${shown - 1} of output ok`);
    expect(lines[shown + 1]).toBe(`… ${3000 - shown} more lines (startLine:${shown + 1})`);
    expect(r.tokens).toBeLessThanOrEqual(cfg.budgets.expand);
    const small = expand({ handle, maxTokens: 100 }, newToolContext(cfg));
    expect(small.tokens).toBeLessThanOrEqual(100);
  });

  it('returns an exact line range', () => {
    const r = expand({ handle, startLine: 100, endLine: 103 }, newToolContext(cfg));
    expect(r.text).toBe(`${handle} lines 100-103 of 3000\nline 99 of output ok\nline 100 of output ok\nline 101 of output ok\nline 102 of output ok`);
  });

  it('greps with 2 lines of context and merged ranges', () => {
    const r = expand({ handle, grep: 'LINE 150[01] |line 2000 ' }, newToolContext(cfg));
    expect(r.text).toBe(
      [
        `${handle} lines 1499-2003 of 3000 · 3 matches for /LINE 150[01] |line 2000 /`,
        '-- 1499-1504',
        ...[1498, 1499, 1500, 1501, 1502, 1503].map((i) => `line ${i} of output ok`),
        '-- 1999-2003',
        ...[1998, 1999, 2000, 2001, 2002].map((i) => `line ${i} of output ok`),
      ].join('\n'),
    );
    const none = expand({ handle, grep: 'nope' }, newToolContext(cfg));
    expect(none.text).toBe(`${handle} lines 1-3000 of 3000 · 0 matches for /nope/`);
    const many = expand({ handle, grep: 'output', maxTokens: 200 }, newToolContext(cfg));
    expect(many.tokens).toBeLessThanOrEqual(200);
    expect(many.text).toMatch(/… \+\d+ more match groups|more lines/);
  });

  it('answers unknown handles and bad regexes with one line', () => {
    expect(expand({ handle: 'o000000' }, newToolContext(cfg)).text).toMatch(/^unknown output handle o000000 /);
    expect(expand({ handle: '../../etc/passwd' }, newToolContext(cfg)).text).toMatch(/^unknown output handle/);
    expect(expand({ handle, grep: '(' }, newToolContext(cfg)).text).toMatch(/^invalid grep regex/);
  });
});

describe('OutputStore retention', () => {
  it('evicts least recently used logs and their cache entries', () => {
    const dataDir = tempDir('lru');
    const store = new OutputStore(dataDir);
    const idx = store.load();
    const handles: string[] = [];
    for (let i = 0; i < 5; i++) {
      const h = store.newHandle(idx, `cmd${i}`);
      store.writeLog(idx, h, `output ${i}\n`.repeat(10), `cmd${i}`);
      idx.outputs[h].used = 1000 + i;
      handles.push(h);
    }
    idx.runs.k0 = { command: 'cmd0', cwd: '', fingerprint: 'f', handle: handles[0], exitCode: 0, text: 't', call: 1, at: 0, baselineTokens: 1, rawTokens: 1, filter: 'generic' };
    store.evict(idx, 3);
    expect(Object.keys(idx.outputs).sort()).toEqual(handles.slice(2).sort());
    expect(idx.runs.k0).toBeUndefined();
    expect(existsSync(store.logPath(handles[0]))).toBe(false);
    expect(existsSync(store.logPath(handles[4]))).toBe(true);
    store.save(idx);
    expect(store.load().outputs[handles[4]].bytes).toBeGreaterThan(0);
    expect(estimateTokens(readFileSync(store.logPath(handles[4]), 'utf8'))).toBeGreaterThan(0);
  });
});
