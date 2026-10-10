// bench/agentab/run.mjs, the agent A/B wrapper: the commands of a test task never see kopt's variables.
// Round 2 leaked the wrapper's KOPT_SESSION into kopt's own test suite through `kopt run` (which passes its whole
// environment to the command it runs): one test failed in every arm-B run and the agents chased it.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { rmTree } from './helpers/fs.js';

const ROOT = resolve(__dirname, '..');
const WRAPPER = join(ROOT, 'bench', 'agentab', 'run.mjs');
const BIN = join(ROOT, 'dist', 'bin.js');
const tmp = mkdtempSync(join(tmpdir(), 'kopt-agentab-'));
afterAll(() => rmTree(tmp));

/** A prepared run with one test task: two copies of a tiny repository whose `npm test` prints the KOPT_* it sees. */
function prepared() {
  const state = join(tmp, 'state');
  const run = 'r';
  const dirs: Record<string, string> = {};
  for (const arm of ['A', 'B']) {
    const dir = join(tmp, 'repos', arm);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'probe', private: true, scripts: { test: 'node probe.js' } }));
    writeFileSync(
      join(dir, 'probe.js'),
      "const k = Object.keys(process.env).filter((v) => v.startsWith('KOPT_')).sort();\nconsole.log('KOPT_VARS:' + (k.join(',') || 'none'));\n",
    );
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir, stdio: 'ignore' });
    git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    dirs[arm] = dir;
  }
  mkdirSync(join(state, run), { recursive: true });
  writeFileSync(join(state, run, 'meta.json'), JSON.stringify({ ready: true, reps: 1, koptBin: BIN, repos: { 'kopt-t1': { mode: 'test', task: 't1', dirs } }, explore: [], tests: ['t1'] }));
  return { state, run, logs: join(tmp, 'logs') };
}

describe.skipIf(process.platform === 'win32' || !existsSync(BIN))('agent A/B wrapper: test commands get no KOPT_* variable', () => {
  const p = prepared();
  const wrapper = (arm: string, command: string) => {
    // the operator's own KOPT_* must not reach the agents' commands either
    const env = { ...process.env, AGENTAB_STATE: p.state, AGENTAB_LOGS: p.logs, KOPT_SESSION: 'operator', KOPT_SHELL: 'bash', KOPT_DEBUG: '1' };
    const r = spawnSync(process.execPath, [WRAPPER, '--arm', arm, '--repo', 'kopt-t1', '--task', 't1', '--run', p.run, '--no-log', '--', command], { env, encoding: 'utf8', timeout: 120_000, input: '' });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };

  it('kopt run (arm B): the test command sees none of kopt\'s variables, KOPT_SESSION and KOPT_RUN included', () => {
    const r = wrapper('B', "kopt run 'npm test'");
    expect(r.out).toMatch(/KOPT_VARS:none/);
    expect(r.status).toBe(0);
  }, 150_000);

  it('a test command run directly (arm A) sees none either: both arms run tests in the same environment', () => {
    const r = wrapper('A', 'npm test');
    expect(r.out).toMatch(/KOPT_VARS:none/);
    expect(r.status).toBe(0);
  }, 150_000);
});
