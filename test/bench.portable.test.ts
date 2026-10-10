import { homedir, tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { portablePaths } from '../src/bench/portable.js';

const root = '/work/kiro-optimizer';

describe('portablePaths', () => {
  it('makes benchmark checkout and result paths repo-relative, wherever the worktree lives', () => {
    const t = '"repoRoot": "/some/other/worktree/bench/repos/django", "f": "/x/y/bench/competitors/results/a.jsonl"';
    expect(portablePaths(t, root)).toBe('"repoRoot": "bench/repos/django", "f": "bench/competitors/results/a.jsonl"');
  });
  it('strips the project root and hides temp folders and the home directory', () => {
    const tmp = tmpdir().replace(/\/+$/, '');
    const t = `${root}/bench/tasks/a.json ${tmp}/run-1/x.log ${tmp}/idx/.kopt-django/index.db ${homedir()}/notes.txt`;
    const out = portablePaths(t, root);
    expect(out.startsWith('bench/tasks/a.json <tmp> <index-dir>/.kopt-django/index.db ')).toBe(true);
    // HOME may itself live under the temp folder in the test sandbox, and uses '\\' on Windows:
    // either way the published text must not contain it.
    expect(out).not.toContain(homedir());
    expect(out.endsWith('<tmp>') || out.endsWith('~/notes.txt')).toBe(true);
  });
  it('never touches relative paths or backslashes (PHP namespaces)', () => {
    const t = 'src/bench/results/x and foo/bar/bench/repos/y and Illuminate\\\\Image\\\\Image';
    expect(portablePaths(t, root)).toBe(t);
  });
});
