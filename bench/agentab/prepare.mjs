#!/usr/bin/env node
// Prepares an agent A/B run for bench/agentab/run.mjs, so that every agent of the run sees the same kopt build and
// the same repositories, and nothing touches the real user folders or bench/repos:
//
//   1. snapshots the current kopt build (dist/, templates/, vendor/) into .state/<run>/kopt (a later rebuild cannot
//      change the run);
//   2. creates an isolated user state (.state/<run>/{home,kopt-home,kiro,kiro-user,cache}) and runs the real
//      `kopt setup --no-global` in it, so that arm B gets kopt's governor exactly as installed for Kiro;
//   3. explore tasks: indexes each bench/repos/<name> into .state/<run>/idx/.kopt-<name> (or copies --from-index);
//   4. test tasks: makes two copies (arm A, arm B) of this repository at HEAD per task, injects the task's bug, commits
//      the buggy tree as the copies' only commit, checks that exactly the expected test files fail, indexes the arm B
//      copy (Kiro builds the index in the background when a session starts);
//   5. smoke-tests every kopt command an agent may use through the wrapper (the v0.1 "ab2" run lost arm B because
//      every kopt call failed and nobody noticed): exit 0 and the expected content, or the run is not prepared.
//
// usage: node bench/agentab/prepare.mjs --run <label> [--explore <tasks.json>] [--tests <tasks-run.json>]
//          [--from-index <dir holding .kopt-<repo>/index.db>] [--runrepos <dir>] [--only-explore|--only-tests]
//          [--no-verify-clean] [--force] [--reps n]
//
// --reps n (default 1): the run will hold n repetitions per arm and task (prompts.mjs --reps, run.mjs --rep). Explore
// tasks share the repositories and indexes (kopt's retrieval answers do not depend on earlier calls of another
// agent); every test task gets n pairs of copies, each indexed for arm B, so no kopt run result is cached across
// repetitions.

import { execFileSync, spawnSync } from 'node:child_process';
import { constants, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STATE = process.env.AGENTAB_STATE ? resolve(process.env.AGENTAB_STATE) : join(ROOT, 'bench', 'agentab', '.state');
const WRAPPER = join(ROOT, 'bench', 'agentab', 'run.mjs');

function parseArgs(argv) {
  const o = { run: '', explore: join(ROOT, 'bench', 'agentab', 'tasks-explore.json'), tests: join(ROOT, 'bench', 'agentab', 'tasks-run.json'), fromIndex: '', runrepos: '', onlyExplore: false, onlyTests: false, verifyClean: true, force: false, reps: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run') o.run = argv[++i];
    else if (a === '--explore') o.explore = resolve(argv[++i]);
    else if (a === '--tests') o.tests = resolve(argv[++i]);
    else if (a === '--from-index') o.fromIndex = resolve(argv[++i]);
    else if (a === '--runrepos') o.runrepos = resolve(argv[++i]);
    else if (a === '--only-explore') o.onlyExplore = true;
    else if (a === '--only-tests') o.onlyTests = true;
    else if (a === '--no-verify-clean') o.verifyClean = false;
    else if (a === '--force') o.force = true;
    else if (a === '--reps') o.reps = Math.max(1, Math.floor(Number(argv[++i]) || 1));
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.run || !/^[A-Za-z0-9._-]+$/.test(o.run)) throw new Error('--run <label> is required (letters, digits, . _ -)');
  return o;
}

const log = (m) => process.stderr.write(`prepare: ${m}\n`);
function die(m) {
  process.stderr.write(`prepare: FAILED: ${m}\n`);
  process.exit(1);
}

function newestMtime(dir) {
  let newest = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    newest = Math.max(newest, e.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs);
  }
  return newest;
}

/** Copy-on-write clone where the filesystem supports it (APFS, btrfs, XFS), else a plain copy. */
function cloneTree(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  const tries = process.platform === 'darwin' ? [['cp', ['-cR', from, to]]] : process.platform === 'linux' ? [['cp', ['-a', '--reflink=auto', from, to]]] : [];
  for (const [cmd, a] of tries) {
    if (spawnSync(cmd, a, { stdio: 'ignore' }).status === 0) return;
  }
  cpSync(from, to, { recursive: true, mode: constants.COPYFILE_FICLONE, verbatimSymlinks: true });
}

function git(args, cwd = ROOT) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const o = parseArgs(process.argv.slice(2));
// kopt needs Node >= 22.13 (package.json engines); every kopt call of the run uses this Node (absolute path)
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 13)) die(`Node ${process.version}: kopt needs Node >= 22.13; run prepare.mjs with it (absolute path)`);
const runDir = join(STATE, o.run);
const metaFile = join(runDir, 'meta.json');
if (existsSync(metaFile) && !o.force) die(`${metaFile} exists: run "${o.run}" is already prepared (--force to redo it; never during a run)`);
// --force, or an earlier prepare that stopped before writing meta.json: start from scratch
if (existsSync(runDir) && (o.force || !existsSync(metaFile))) rmSync(runDir, { recursive: true, force: true, maxRetries: 3 });
mkdirSync(runDir, { recursive: true });
const runrepos = o.runrepos || join(runDir, 'runrepos');

// ---- 1. snapshot of the kopt build ------------------------------------------------------------------------------
const dist = join(ROOT, 'dist');
if (!existsSync(join(dist, 'bin.js'))) die('dist/bin.js missing: npm run build');
if (newestMtime(join(ROOT, 'src')) > newestMtime(dist)) die('dist/ is older than src/: npm run build');
const koptDir = join(runDir, 'kopt');
cpSync(dist, join(koptDir, 'dist'), { recursive: true });
cpSync(join(ROOT, 'templates'), join(koptDir, 'templates'), { recursive: true });
// the vendored grammars (rust, scala): without them the snapshot silently falls back to the older tree-sitter-wasms
// builds, and indexes meilisearch with the grammar the published package no longer uses
if (existsSync(join(ROOT, 'vendor'))) cpSync(join(ROOT, 'vendor'), join(koptDir, 'vendor'), { recursive: true });
cpSync(join(ROOT, 'package.json'), join(koptDir, 'package.json'));
symlinkSync(join(ROOT, 'node_modules'), join(koptDir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
const koptBin = join(koptDir, 'dist', 'bin.js');
const commit = git(['rev-parse', 'HEAD']);
const dirty = git(['status', '--porcelain', '--', 'src', 'templates', 'package.json']) !== '';
const identity = { name: git(['config', 'user.name']), email: git(['config', 'user.email']) };
log(`kopt build ${commit.slice(0, 10)}${dirty ? ' (uncommitted changes in src/)' : ''} -> ${koptDir}`);

// ---- 2. isolated user state + real kopt setup --------------------------------------------------------------------
const home = join(runDir, 'home');
for (const d of ['home', 'kopt-home', 'kiro', 'kiro-user', 'cache', 'idx', 'verify']) mkdirSync(join(runDir, d), { recursive: true });
const baseEnv = { ...process.env };
for (const k of Object.keys(baseEnv)) if (k.startsWith('KOPT_')) delete baseEnv[k];
const env = {
  ...baseEnv,
  PATH: `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
  HOME: home,
  USERPROFILE: home,
  KOPT_HOME: join(runDir, 'kopt-home'),
  KOPT_CACHE_DIR: join(runDir, 'cache'),
  KOPT_KIRO_HOME: join(runDir, 'kiro'),
  KOPT_KIRO_USER_SETTINGS: join(runDir, 'kiro-user', 'settings.json'),
  KOPT_KIRO_CLI: 'none',
  KOPT_KIRO_IDE_PATHS: join(runDir, 'no-kiro-ide'),
  KOPT_CLI: koptBin,
  NO_COLOR: '1',
  npm_config_update_notifier: 'false',
  npm_config_fund: 'false',
  npm_config_audit: 'false',
};
const kopt = (args, extra = {}, opts = {}) =>
  spawnSync(process.execPath, [koptBin, ...args], { env: { ...env, ...extra }, encoding: 'utf8', input: '', timeout: 1_800_000, maxBuffer: 64 * 1024 * 1024, ...opts });
{
  const r = kopt(['setup', '--no-global', '--surface', 'all', '--no-doctor'], {}, { cwd: home });
  if (r.status !== 0) die(`kopt setup failed (exit ${r.status}):\n${r.stdout}${r.stderr}`);
  const mcp = join(runDir, 'kiro', 'settings', 'mcp.json');
  if (!existsSync(mcp) || !readFileSync(mcp, 'utf8').includes(koptBin)) die(`kopt setup did not write a kopt entry using the snapshot into ${mcp}`);
  log(`kopt setup (isolated HOME): ok`);
}

const meta = {
  run: o.run,
  createdAt: new Date().toISOString(),
  commit,
  dirty,
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  koptBin,
  reps: o.reps,
  repos: {},
  explore: [],
  tests: [],
  verify: {},
};

/** Runs the wrapper like an agent would, without logging. */
function viaWrapper(arm, repo, command) {
  // one governor session per repository, as an agent would have
  const r = spawnSync(process.execPath, [WRAPPER, '--arm', arm, '--repo', repo, '--task', `__smoke-${repo}`, '--run', o.run, '--no-log', '--', command], {
    encoding: 'utf8',
    timeout: 900_000,
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
  });
  return { status: r.status, out: r.stdout + r.stderr };
}
const smokeFailures = [];
function smoke(label, arm, repo, command, check) {
  const r = viaWrapper(arm, repo, command);
  const problem = check(r);
  if (problem) smokeFailures.push(`${label}: ${problem}\n  command: ${command}\n  output: ${r.out.slice(0, 600)}`);
  else log(`smoke ok: ${label}`);
}

// ---- 3. explore repositories --------------------------------------------------------------------------------------
const exploreTasks = o.onlyTests ? [] : JSON.parse(readFileSync(o.explore, 'utf8'));
for (const repo of [...new Set(exploreTasks.map((t) => t.repo))]) {
  const dir = join(ROOT, 'bench', 'repos', repo);
  if (!existsSync(dir)) die(`missing checkout bench/repos/${repo} (see bench/README.md)`);
  const dataDir = join(runDir, 'idx', `.kopt-${repo}`);
  mkdirSync(dataDir, { recursive: true });
  const src = o.fromIndex ? join(o.fromIndex, `.kopt-${repo}`, 'index.db') : '';
  const t0 = Date.now();
  if (src && existsSync(src)) {
    cloneTree(src, join(dataDir, 'index.db'));
    log(`${repo}: index copied from ${src}`);
  }
  // builds the index, or brings a copied one up to date with this build and checkout
  const r = kopt(['index', '--root', dir], { KOPT_DATA_DIR: dataDir, KOPT_TELEMETRY: '0' });
  if (r.status !== 0) die(`${repo}: kopt index failed (exit ${r.status}):\n${r.stdout}${r.stderr}`);
  log(`${repo}: ${r.stdout.trim().split('\n').pop()} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  meta.repos[repo] = { mode: 'explore', dir, dataDir };
}
for (const t of exploreTasks) meta.explore.push(t.id);

// ---- 4. test-task repositories ------------------------------------------------------------------------------------
const testSpec = o.onlyExplore ? { tasks: [] } : JSON.parse(readFileSync(o.tests, 'utf8'));
const fixedDate = '2026-10-01T12:00:00+0000';

function exportTree(to) {
  rmSync(to, { recursive: true, force: true, maxRetries: 3 });
  mkdirSync(to, { recursive: true });
  const r = spawnSync('sh', ['-c', `git -C "${ROOT}" archive --format=tar HEAD | tar -x -C "${to}"`], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  if (r.status !== 0) die(`git archive failed: ${r.stderr}`);
  // the A/B harness (tasks, gold, logs) never ships inside a task repository, nor do the published A/B results: they
  // quote earlier runs' answers ("ROOT CAUSE: src/compress/expand.ts:83 expandOutput"), one grep away for an agent
  rmSync(join(to, 'bench', 'agentab'), { recursive: true, force: true });
  const results = join(to, 'bench', 'results');
  if (existsSync(results)) for (const f of readdirSync(results)) if (f.startsWith('agent-ab')) rmSync(join(results, f), { recursive: true, force: true });
  cloneTree(join(ROOT, 'node_modules'), join(to, 'node_modules'));
}
function commitTree(dir) {
  const genv = { ...process.env, GIT_AUTHOR_DATE: fixedDate, GIT_COMMITTER_DATE: fixedDate, HOME: home };
  const g = (a) => execFileSync('git', a, { cwd: dir, env: genv, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  g(['init', '-q', '-b', 'main']);
  g(['add', '-A']);
  g(['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'Snapshot']);
}
function runVitest(dir, label) {
  const out = join(runDir, 'verify', `${label}.json`);
  rmSync(out, { force: true });
  const t0 = Date.now();
  // the environment the agents' test commands get (run.mjs): no KOPT_* variable
  const testEnv = Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('KOPT_')));
  const r = spawnSync('npx', ['vitest', 'run', '--reporter=json', `--outputFile=${out}`], { cwd: dir, env: testEnv, encoding: 'utf8', timeout: 900_000, maxBuffer: 64 * 1024 * 1024 });
  if (!existsSync(out)) die(`${label}: vitest wrote no report (exit ${r.status}):\n${(r.stdout + r.stderr).slice(-2000)}`);
  const d = JSON.parse(readFileSync(out, 'utf8'));
  const failedFiles = [...new Set(d.testResults.filter((f) => f.status === 'failed' || f.assertionResults.some((a) => a.status === 'failed')).map((f) => f.name.slice(dir.length + 1).replace(/\\/g, '/')))].sort();
  return { failed: d.numFailedTests, passed: d.numPassedTests, total: d.numTotalTests, failedFiles, seconds: Math.round((Date.now() - t0) / 100) / 10 };
}

if (testSpec.tasks.length && o.verifyClean) {
  const clean = join(runrepos, '_clean');
  exportTree(clean);
  const v = runVitest(clean, 'clean');
  if (v.failed) die(`the unmodified tree has ${v.failed} failing tests (${v.failedFiles.join(', ')}): fix that first`);
  meta.verify.clean = v;
  log(`clean tree: ${v.passed}/${v.total} passed (${v.seconds}s)`);
  rmSync(clean, { recursive: true, force: true, maxRetries: 3 });
}
for (const t of testSpec.tasks) {
  const name = `kopt-${t.id}`;
  const dirs = {};
  let injectedLine = 0;
  for (const arm of ['A', 'B']) {
    const dir = join(runrepos, t.id, arm);
    exportTree(dir);
    const f = join(dir, t.mutation.file);
    const text = readFileSync(f, 'utf8');
    const at = text.indexOf(t.mutation.find);
    if (at < 0 || text.indexOf(t.mutation.find, at + 1) >= 0) die(`${t.id}: the mutation must match ${t.mutation.file} exactly once`);
    writeFileSync(f, text.slice(0, at) + t.mutation.replace + text.slice(at + t.mutation.find.length));
    injectedLine = text.slice(0, at).split('\n').length;
    commitTree(dir);
    const v = runVitest(dir, `${t.id}-${arm}`);
    const expected = [...t.expectFailing].sort();
    if (!v.failed || JSON.stringify(v.failedFiles) !== JSON.stringify(expected)) {
      die(`${t.id}/${arm}: expected failures in ${expected.join(', ')}, got ${v.failed} in ${v.failedFiles.join(', ') || 'none'}`);
    }
    meta.verify[`${t.id}-${arm}`] = v;
    log(`${t.id}/${arm}: ${v.failed} failing tests in ${v.failedFiles.join(', ')} (${v.seconds}s)`);
    dirs[arm] = dir;
  }
  // arm B: the index Kiro would have built in the background at session start
  const r = kopt(['index', '--root', dirs.B]);
  if (r.status !== 0) die(`${t.id}: kopt index failed:\n${r.stdout}${r.stderr}`);
  // repetitions 2..n: copies of the verified trees (git history included), each arm B copy with its own index
  const reps = [dirs];
  for (let k = 2; k <= o.reps; k++) {
    const d = {};
    for (const arm of ['A', 'B']) {
      d[arm] = join(runrepos, t.id, `r${k}`, arm);
      rmSync(d[arm], { recursive: true, force: true, maxRetries: 3 });
      cloneTree(dirs[arm], d[arm]);
    }
    const rk = kopt(['index', '--root', d.B]);
    if (rk.status !== 0) die(`${t.id} r${k}: kopt index failed:\n${rk.stdout}${rk.stderr}`);
    reps.push(d);
  }
  meta.repos[name] = { mode: 'test', task: t.id, dirs, reps, injected: { file: t.mutation.file, line: injectedLine } };
  meta.tests.push(t.id);
}
// ---- 5. smoke tests through the wrapper (meta.json exists but is not ready yet) -------------------------------
writeFileSync(metaFile, JSON.stringify({ ...meta, ready: false }, null, 2) + '\n');
for (const t of exploreTasks) {
  const sym = t.gold.symbols[0];
  smoke(`${t.id} B kopt find`, 'B', t.repo, `kopt find "${sym.name}" --limit 5`, (r) => (r.status !== 0 ? `exit ${r.status}` : !r.out.includes(sym.name) ? `${sym.name} not in the output` : undefined));
}
for (const repo of Object.keys(meta.repos).filter((r) => meta.repos[r].mode === 'explore')) {
  const sym = exploreTasks.find((t) => t.repo === repo).gold.symbols[0];
  smoke(`${repo} B kopt find --pack`, 'B', repo, `kopt find "${sym.name}" --pack`, (r) => (r.status !== 0 ? `exit ${r.status}` : /^error|internal error/im.test(r.out) ? 'error output' : undefined));
  smoke(`${repo} B kopt refs`, 'B', repo, `kopt refs "${sym.name}"`, (r) => (r.status !== 0 ? `exit ${r.status}` : undefined));
  // the pack above may already have sent these lines: the session's dedup ledger then answers "unchanged"
  smoke(`${repo} B kopt read`, 'B', repo, `kopt read "${sym.file}:${sym.line}-${sym.line + 5}"`, (r) =>
    r.status !== 0 ? `exit ${r.status}` : !r.out.includes(sym.name) && !/ unchanged \(shown in call \d+\)/.test(r.out) ? `neither ${sym.name} nor an "unchanged" line` : undefined,
  );
  // MCP's fresh:true, which the wrapper maps for the CLI: the same range again, in full despite the session ledger
  smoke(`${repo} B kopt read --fresh`, 'B', repo, `kopt read "${sym.file}:${sym.line}-${sym.line + 5}" --fresh`, (r) => (r.status !== 0 || !r.out.includes(sym.name) ? `exit ${r.status}, ${sym.name} not shown again` : undefined));
  smoke(`${repo} B kopt read <dir>`, 'B', repo, `kopt read "${dirname(sym.file)}" --max-tokens 300`, (r) => (r.status !== 0 ? `exit ${r.status}` : undefined));
  smoke(`${repo} A grep`, 'A', repo, `grep -rn "${sym.name}" "${sym.file}"`, (r) => (r.status !== 0 || !r.out.includes(sym.name) ? `exit ${r.status}` : undefined));
  smoke(`${repo} A kopt refused`, 'A', repo, `kopt find "${sym.name}"`, (r) => (r.status === 2 && r.out.includes('not available in this arm') ? undefined : 'arm A could run kopt'));
  smoke(`${repo} B escape refused`, 'B', repo, 'cat ../../tasks/django.json', (r) => (r.status === 2 ? undefined : 'a path outside the repository was readable'));
}

if (testSpec.tasks.length) {
  const bugLabels = [...new Set([...testSpec.tasks.map((t) => t.bug), 'injected bug'])].map((b) => b.replace(/[.*+?^${}()|[\]\\-]/g, '.')).join('|');
  // one narrow failing file per repo through kopt run and kopt read <log handle>, then the governor on a full run
  for (const t of testSpec.tasks) {
    const name = `kopt-${t.id}`;
    const file = t.expectFailing[0];
    let handle = '';
    smoke(`${t.id} B kopt run`, 'B', name, `kopt run "npx vitest run ${file}"`, (r) => {
      handle = /kopt[_ ](?:read|expand) (o[0-9a-f]+)/.exec(r.out)?.[1] ?? '';
      return r.status !== 1 ? `exit ${r.status} (expected 1: failing tests)` : !/FAIL/.test(r.out) ? 'no FAIL line' : !handle ? 'no output handle' : undefined;
    });
    if (handle) smoke(`${t.id} B kopt read <log> --grep`, 'B', name, `kopt read ${handle} --grep "FAIL" --max-tokens 300`, (r) => (r.status !== 0 || !/FAIL/.test(r.out) ? `exit ${r.status}` : undefined));
    smoke(`${t.id} A vitest`, 'A', name, `npx vitest run ${file}`, (r) => (r.status !== 1 || !/FAIL/.test(r.out) ? `exit ${r.status}` : undefined));
    smoke(`${t.id} B governor`, 'B', name, 'npx vitest run', (r) => (r.status === 2 && r.out.includes('kopt run "npx vitest run"') ? undefined : `not redirected to kopt run (exit ${r.status})`));
    smoke(`${t.id} A git log`, 'A', name, 'git log --oneline', (r) => (r.out.trim().split('\n').length === 1 ? undefined : 'git history is not a single commit'));
    smoke(`${t.id} A no earlier answers`, 'A', name, 'git grep -l "ROOT CAUSE:"', (r) => (r.status === 1 ? undefined : `answers of an earlier run are in the copy: ${r.out.trim()}`));
    // nor a description of an injected bug (comments next to stored logs of earlier runs, notes): only the A/B
    // section of bench/README.md lists the kinds of bugs, as in rounds 1 and 2, not where they are
    smoke(`${t.id} A no bug descriptions`, 'A', name, `git grep -n -i -E "${bugLabels}" -- . ":!bench/README.md"`, (r) => (r.status === 1 ? undefined : `the copy describes an injected bug: ${r.out.trim().slice(0, 300)}`));
  }
}
// smoke runs must leave nothing the agents could see: cached kopt run results, dedup ledgers, governor sessions,
// usage log
for (const d of readdirSync(join(runDir, 'cache'))) for (const sub of ['outputs', 'ledgers']) rmSync(join(runDir, 'cache', d, sub), { recursive: true, force: true });
for (const d of Object.values(meta.repos)) if (d.dataDir) for (const sub of ['outputs', 'ledgers']) rmSync(join(d.dataDir, sub), { recursive: true, force: true });
for (const d of ['sessions', 'telemetry']) rmSync(join(runDir, 'kopt-home', d), { recursive: true, force: true });

if (smokeFailures.length) die(`${smokeFailures.length} smoke check(s) failed:\n${smokeFailures.join('\n')}`);
writeFileSync(metaFile, JSON.stringify({ ...meta, ready: true }, null, 2) + '\n');
log(`ready: ${meta.explore.length} explore tasks, ${meta.tests.length} test tasks -> ${metaFile}`);
