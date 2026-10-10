// kopt_run process lifecycle and result shape: stop signals kill running command trees, private output files,
// cancellation, refusal of commands that never exit, small outputs returned as they are.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultConfig, type KoptConfig } from '../src/core/config.js';
import { newToolContext } from '../src/core/context.js';
import { estimateTokens } from '../src/core/tokens.js';
import { runCommand, SMALL_OUTPUT_TOKENS } from '../src/compress/index.js';
import { activeCommandCount, execCapture, quoteArg, resolveShell } from '../src/compress/runner.js';

const ROOT = resolve(import.meta.dirname, '..');
const WIN = process.platform === 'win32';
const SHELL = resolveShell().kind;
const dirs: string[] = [];

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `kopt-${prefix}-`));
  dirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function config(): KoptConfig {
  const root = tempDir('life');
  const cfg = defaultConfig(root);
  cfg.dataDir = join(tempDir('life-data'), 'kopt');
  return cfg;
}

/** Command line that runs a Node script file through kopt_run's shell. */
function node(script: string): string {
  const file = join(tempDir('script'), 's.cjs');
  writeFileSync(file, script);
  const line = [process.execPath, file].map((a) => quoteArg(a, SHELL)).join(' ');
  return SHELL === 'powershell' ? `& ${line}` : line;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

function psLine(pid: number): string {
  try {
    return execFileSync('ps', ['-o', 'pid=,pgid=,ppid=,stat=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch {
    return String(pid);
  }
}

function killQuietly(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* gone */
  }
}

/** A command whose grandchild writes its pid to `pidFile` and then runs forever. */
function foreverTree(pidFile: string, ownSession = false): string {
  // two levels of JS string literals: the grandchild's code is itself a literal in the script (Windows paths keep
  // their backslashes only when both levels are escaped)
  const grandchild = `require('fs').writeFileSync(${JSON.stringify(pidFile).replace(/"/g, "'")}, String(process.pid)); setInterval(() => {}, 1000)`;
  return node(
    `const c = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore', detached: ${ownSession} });\nsetInterval(() => {}, 1000);`,
  );
}

describe('stop signals kill running command trees', () => {
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    it.skipIf(WIN)(`${sig} to \`kopt run\` kills the command it started`, async () => {
      const repo = tempDir('sig');
      const pidFile = join(tempDir('pid'), 'pid');
      const data = tempDir('sig-data');
      const kopt = spawn(process.execPath, ['--no-warnings', '--import', 'tsx', join(ROOT, 'src', 'cli.ts'), 'run', '--root', repo, foreverTree(pidFile)], {
        cwd: ROOT,
        env: { ...process.env, KOPT_DATA_DIR: data, KOPT_HOME: tempDir('sig-home') },
        stdio: 'ignore',
      });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => kopt.on('exit', (code, signal) => res({ code, signal })));
      expect(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').length > 0, 15_000)).toBe(true);
      const grandchild = Number(readFileSync(pidFile, 'utf8'));
      expect(alive(grandchild)).toBe(true);
      kopt.kill(sig);
      const end = await exited;
      // the default action of the signal still applies to kopt itself
      expect(end.signal).toBe(sig);
      const gone = await waitFor(() => !alive(grandchild), 3000);
      // on failure, say where the survivor sits (its group and parent) before cleaning it up
      const where = gone ? '' : psLine(grandchild);
      if (!gone) killQuietly(grandchild);
      expect(gone, `${sig}: survivor ${where} (kopt ${JSON.stringify(end)})`).toBe(true);
    }, 30_000);
  }

  it.skipIf(WIN)('a descendant that left the process group (setsid) is killed too', async () => {
    const repo = tempDir('sig-escape');
    const pidFile = join(tempDir('pid'), 'pid');
    const kopt = spawn(process.execPath, ['--no-warnings', '--import', 'tsx', join(ROOT, 'src', 'cli.ts'), 'run', '--root', repo, foreverTree(pidFile, true)], {
      cwd: ROOT,
      env: { ...process.env, KOPT_DATA_DIR: tempDir('sig-escape-data'), KOPT_HOME: tempDir('sig-escape-home') },
      stdio: 'ignore',
    });
    const exited = new Promise((res) => kopt.on('exit', res));
    expect(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').length > 0, 15_000)).toBe(true);
    const escaped = Number(readFileSync(pidFile, 'utf8'));
    kopt.kill('SIGTERM');
    await exited;
    const gone = await waitFor(() => !alive(escaped), 3000);
    const where = gone ? '' : psLine(escaped);
    if (!gone) killQuietly(escaped);
    expect(gone, `survivor ${where}`).toBe(true);
  }, 30_000);

  it('removes its signal listeners once no command runs', async () => {
    const before = process.listenerCount('SIGINT');
    const p = execCapture({ command: node('setTimeout(() => {}, 200)'), cwd: tmpdir(), timeoutMs: 10_000 });
    expect(activeCommandCount()).toBe(1);
    expect(process.listenerCount('SIGINT')).toBe(before + 1);
    await p;
    expect(activeCommandCount()).toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});

describe('kopt_run output files are private', () => {
  it.skipIf(process.platform === 'win32')('creates the outputs folder 0700 and logs 0600, and tightens an existing folder', async () => {
    const root = tempDir('perm');
    const cfg = defaultConfig(root);
    cfg.dataDir = join(tempDir('perm-data'), 'nested', 'kopt');
    const line = node("console.log('DB_PASSWORD=hunter2')");
    const r = await runCommand({ command: line }, newToolContext(cfg));
    const handle = r.meta!.handle as string;
    const outDir = join(cfg.dataDir, 'outputs');
    expect(statSync(outDir).mode & 0o777).toBe(0o700);
    expect(statSync(cfg.dataDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(outDir, `${handle}.log`)).mode & 0o777).toBe(0o600);
    expect(statSync(join(outDir, 'index.json')).mode & 0o777).toBe(0o600);

    // folder written by an older kopt with default permissions
    const old = join(tempDir('perm-old'), 'kopt');
    mkdirSync(join(old, 'outputs'), { recursive: true, mode: 0o755 });
    writeFileSync(join(old, 'outputs', 'o123456.log'), 'secret', { mode: 0o644 });
    const cfg2 = defaultConfig(root);
    cfg2.dataDir = old;
    await runCommand({ command: line }, newToolContext(cfg2));
    expect(statSync(join(old, 'outputs')).mode & 0o777).toBe(0o700);
    expect(statSync(join(old, 'outputs', 'o123456.log')).mode & 0o777).toBe(0o600);
  });
});

describe('cancellation', () => {
  it('an aborted signal kills the process tree and reports exit 130', async () => {
    const pidFile = join(tempDir('abort'), 'pid');
    const ac = new AbortController();
    const cfg = config();
    const run = runCommand({ command: foreverTree(pidFile), timeoutSec: 120 }, newToolContext(cfg), { signal: ac.signal });
    expect(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').length > 0, 15_000)).toBe(true);
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    const t0 = Date.now();
    ac.abort();
    const r = await run;
    expect(Date.now() - t0).toBeLessThan(8000);
    expect(r.text).toMatch(/^exit 130 · cancelled after [\d.]+s, process tree killed; output so far/);
    expect(r.meta).toMatchObject({ cancelled: true, stored: false });
    expect(await waitFor(() => !alive(grandchild), 3000)).toBe(true);
  }, 30_000);

  it('a run joined by an identical call is killed only when every caller has cancelled', async () => {
    const pidFile = join(tempDir('abort2'), 'pid');
    const cfg = config();
    const command = foreverTree(pidFile);
    const first = new AbortController();
    const second = new AbortController();
    const a = runCommand({ command, timeoutSec: 120 }, newToolContext(cfg), { signal: first.signal });
    expect(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').length > 0, 15_000)).toBe(true);
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    const b = runCommand({ command, timeoutSec: 120 }, newToolContext(cfg), { signal: second.signal });
    first.abort();
    await new Promise((r) => setTimeout(r, 500));
    expect(alive(grandchild)).toBe(true);
    second.abort();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.meta).toMatchObject({ cancelled: true });
    expect(rb.meta).toMatchObject({ cancelled: true, joined: true });
    expect(await waitFor(() => !alive(grandchild), 3000)).toBe(true);
  }, 30_000);
});

describe('commands that never exit', () => {
  it('are refused with a one-line hint unless timeoutSec is given', async () => {
    const cfg = config();
    const r = await runCommand({ command: 'npm run dev' }, newToolContext(cfg));
    expect(r.text.split('\n')).toHaveLength(1);
    expect(r.text).toMatch(/^kopt_run: not run, `npm run dev` never exits \(script "dev" usually runs until stopped\)\. /);
    expect(r.text).toContain('pass timeoutSec');
    expect(r.meta).toMatchObject({ refused: 'long-running', exitCode: 2 });
    expect(estimateTokens(r.text)).toBeLessThan(60);
    expect((await runCommand({ command: 'npx tsc --watch' }, newToolContext(cfg))).meta).toMatchObject({ refused: 'long-running' });

    // explicit timeoutSec: the agent wants the first seconds of a server's output
    const bounded = await runCommand({ command: node("console.log('listening on 3000'); setInterval(() => {}, 1000)") + ' --watch', timeoutSec: 2 }, newToolContext(cfg));
    expect(bounded.meta).toMatchObject({ timedOut: true });
    expect(bounded.text).toContain('listening on 3000');
  }, 20_000);
});

describe('result size', () => {
  it('small outputs come back as they are under a one-line exit header', async () => {
    const cfg = config();
    const r = await runCommand({ command: node("console.log('ok')") }, newToolContext(cfg));
    expect(r.text).toBe('exit 0\nok');
    const empty = await runCommand({ command: node('') }, newToolContext(cfg));
    expect(empty.text).toBe('exit 0\n(no output)');
    const fail = await runCommand({ command: node("console.error('Error: nope'); process.exit(2)") }, newToolContext(cfg));
    expect(fail.text).toBe('exit 2\nError: nope');
    // header overhead is a few tokens at most
    expect(r.tokens - estimateTokens('ok')).toBeLessThanOrEqual(3);
    // a run that takes a second or more says how long
    const slow = await runCommand({ command: node("setTimeout(() => console.log('done'), 1100)") }, newToolContext(cfg));
    expect(slow.text).toMatch(/^exit 0 · \d+\.\ds\ndone$/);
  });

  it('a short passing run of a known test tool is its verdict line', async () => {
    const cfg = config();
    const out = [
      '============================= test session starts ==============================',
      'platform linux -- Python 3.12.3, pytest-8.2.1, pluggy-1.5.0',
      'rootdir: /srv/app',
      'collected 3 items',
      '',
      'tests/test_refunds.py ...                                                [100%]',
      '',
      '============================== 3 passed in 0.12s ===============================',
    ].join('\n');
    // printed by a script: the pytest filter recognizes the output by its session banner
    const dir = tempDir('pytest-bin');
    const script = join(dir, 'pytest.cjs');
    writeFileSync(script, `console.log(${JSON.stringify(out)})`);
    const cmd = [process.execPath, script].map((a) => quoteArg(a, SHELL)).join(' ');
    const r = await runCommand({ command: SHELL === 'powershell' ? `& ${cmd}` : cmd }, newToolContext(cfg));
    expect(estimateTokens(out)).toBeLessThanOrEqual(SMALL_OUTPUT_TOKENS);
    expect(r.text).toMatch(/^exit 0 · raw ~\d+ tok\n3 passed in 0\.12s\nfull output: kopt_read o[0-9a-f]{6} \(grep=<regex> filters it\)$/);
    expect(r.tokens).toBeLessThan(estimateTokens(out) / 2);
    // a failing short run stays as it is
    writeFileSync(script, `console.log(${JSON.stringify(out.replace('3 passed', '1 failed, 2 passed'))}); process.exit(1)`);
    const f = await runCommand({ command: SHELL === 'powershell' ? `& ${cmd}` : cmd }, newToolContext(cfg));
    expect(f.text).toContain('platform linux');
  });

  it('never returns more than the output itself when a filter cannot shrink it', async () => {
    const cfg = config();
    // ~200 tokens of distinct, error-free lines: nothing for a filter to drop
    const lines = Array.from({ length: 24 }, (_, i) => `entry ${i}: ${'abcdefghij'.slice(i % 5)} value=${(i * 7919) % 1000} label=${['red', 'green', 'blue'][i % 3]}`);
    const r = await runCommand({ command: node(`console.log(${JSON.stringify(lines.join('\n'))})`) }, newToolContext(cfg));
    const raw = lines.join('\n');
    expect(estimateTokens(raw)).toBeGreaterThan(SMALL_OUTPUT_TOKENS);
    expect(r.text).toBe(`${r.text.split('\n')[0]}\n${raw}`);
    expect(r.tokens).toBeLessThanOrEqual(estimateTokens(raw) + 8);
    expect(r.meta).toMatchObject({ elided: false });
  });
});
