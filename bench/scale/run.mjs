#!/usr/bin/env node
// Scale check on a large repository, the way Kiro uses kopt: `kopt mcp` over stdio (what Kiro starts), a first
// build in its worker thread while tool calls keep arriving, a concurrent `kopt index` (the cross-process index
// lock), query latencies on the finished index, and refreshes (files written by the agent, reported by the hooks
// through <dataDir>/dirty; files changed by a pull, caught by `kopt index --refresh`).
//
// usage: node bench/scale/run.mjs --repo <checkout> [--work <dir>] [--out <file.md>] [--keep]
//
// The checkout is never modified or executed: it is cloned copy-on-write into <work>/repo (APFS / btrfs / XFS
// reflinks, else a plain copy) and the refresh steps edit that clone. All kopt state (HOME, ~/.kopt, cache, index)
// lives under <work>, which is deleted at the end unless --keep.

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = join(ROOT, 'dist', 'bin.js');

function parseArgs(argv) {
  const o = { repo: '', work: '', out: '', keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keep') o.keep = true;
    else if (a === '--repo') o.repo = resolve(argv[++i]);
    else if (a === '--work') o.work = resolve(argv[++i]);
    else if (a === '--out') o.out = resolve(argv[++i]);
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.repo || !existsSync(join(o.repo, '.git'))) throw new Error('--repo <git checkout> is required');
  return o;
}

const o = parseArgs(process.argv.slice(2));
const name = basename(o.repo);
const work = o.work || join(tmpdir(), `kopt-scale-${name}-${process.pid}`);
const repo = join(work, 'repo');
const dataDir = join(work, 'data');
const log = (m) => process.stderr.write(`scale: ${m}\n`);
const now = () => performance.now();
const secs = (ms) => Math.round(ms / 100) / 10;

if (!existsSync(BIN)) throw new Error('dist/bin.js missing: npm run build');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
log(`cloning ${o.repo} -> ${repo}`);
const cloned =
  (process.platform === 'darwin' && spawnSync('cp', ['-cR', o.repo, repo]).status === 0) ||
  (process.platform === 'linux' && spawnSync('cp', ['-a', '--reflink=auto', o.repo, repo]).status === 0);
if (!cloned) cpSync(o.repo, repo, { recursive: true, verbatimSymlinks: true });

const home = join(work, 'home');
for (const d of ['home', 'kopt-home', 'cache', 'kiro']) mkdirSync(join(work, d), { recursive: true });
const env = { ...process.env };
for (const k of Object.keys(env)) if (k.startsWith('KOPT_')) delete env[k];
Object.assign(env, {
  HOME: home,
  USERPROFILE: home,
  KOPT_HOME: join(work, 'kopt-home'),
  KOPT_CACHE_DIR: join(work, 'cache'),
  KOPT_KIRO_HOME: join(work, 'kiro'),
  KOPT_KIRO_USER_SETTINGS: join(work, 'kiro', 'user-settings.json'),
  KOPT_DATA_DIR: dataDir,
  KOPT_TELEMETRY: '0',
});

const files = Number(spawnSync('git', ['-C', repo, 'ls-files'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).stdout.split('\n').filter(Boolean).length);
const result = { repo: name, commit: spawnSync('git', ['-C', repo, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), files, node: process.version, platform: `${process.platform}-${process.arch}`, steps: {} };
log(`${files} files tracked`);

// ---- MCP client over stdio, as Kiro runs it ------------------------------------------------------------------------
const sdk = (p) => import(pathToFileURL(join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', ...p.split('/'))).href);
const { Client } = await sdk('client/index.js');
const { StdioClientTransport } = await sdk('client/stdio.js');
const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp', '--root', repo], cwd: repo, env, stderr: 'pipe' });
const client = new Client({ name: 'kopt-scale', version: '1' });
const t0 = now();
await client.connect(transport);
const serverPid = transport.pid;
result.steps.connectMs = Math.round(now() - t0);
const call = async (tool, args) => {
  const t = now();
  const r = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 600_000 });
  return { ms: now() - t, text: r.content?.[0]?.text ?? '' };
};

// peak memory of the server process (its worker thread included)
let peakRss = 0;
const rssTimer = setInterval(() => {
  // ps: Linux and macOS (no peak memory on Windows)
  const r = spawnSync('ps', ['-o', 'rss=', '-p', String(serverPid)], { encoding: 'utf8' });
  const kb = Number((r.stdout ?? '').trim()) || 0;
  if (kb > peakRss) peakRss = kb;
}, 500);

// ---- first build: calls arrive while it runs; a concurrent CLI index waits on the lock ----------------------------
// "index building: ..." (search not ready) or "kopt_refs: references are being resolved ..." (refs not ready)
const building = (t) => /^index building|^kopt_refs: (?:references are being resolved|the index is being ranked)/.test(t);
const probe = { find: undefined, refs: undefined, firstAnswers: [] };
let concurrent;
for (let i = 0; ; i++) {
  const f = await call('kopt_find', { query: 'index shard allocation', limit: 3 });
  if (i < 3 || (!building(f.text) && probe.find === undefined)) probe.firstAnswers.push({ at: secs(now() - t0), ms: Math.round(f.ms), text: f.text.split('\n')[0].slice(0, 160) });
  if (!building(f.text) && probe.find === undefined) probe.find = now() - t0;
  if (i === 1 && !concurrent) {
    // a second process (e.g. `kopt index` in a terminal) while the server builds: it must wait, then only catch up
    const tc = now();
    concurrent = new Promise((res) => {
      const p = spawn(process.execPath, [BIN, 'index', '--root', repo], { env, cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (out += d));
      p.on('close', (code) => res({ code, ms: now() - tc, out: out.trim().split('\n').filter((l) => !/ExperimentalWarning|trace-warnings/.test(l)).slice(-3) }));
    });
  }
  if (probe.find !== undefined) {
    const r = await call('kopt_refs', { target: 'AllocationService', maxTokens: 300 });
    if (!building(r.text)) {
      probe.refs = now() - t0;
      break;
    }
  }
  if (now() - t0 > 30 * 60_000) throw new Error('first build did not finish in 30 minutes');
  await new Promise((r) => setTimeout(r, 2000));
}
result.steps.firstBuild = {
  searchableS: secs(probe.find),
  refsReadyS: secs(probe.refs),
  callsDuringBuild: probe.firstAnswers,
};
const conc = await concurrent;
result.steps.concurrentIndex = { exit: conc.code, seconds: secs(conc.ms), output: conc.out };
log(`search after ${secs(probe.find)} s, refs after ${secs(probe.refs)} s; concurrent kopt index exit ${conc.code} after ${secs(conc.ms)} s`);

// ---- query latency on the finished index ---------------------------------------------------------------------------
const queries = [
  ['kopt_find', { query: 'snapshot restore repository' }],
  ['kopt_find', { query: 'circuit breaker memory limit' }],
  ['kopt_find', { query: 'IndexShard' }],
  ['kopt_find', { query: 'how are search requests coordinated across shards', mode: 'pack' }],
  ['kopt_find', { query: 'retention lease renewal', mode: 'pack' }],
  ['kopt_find', { query: 'executeBulkRequest', mode: 'pack' }],
  ['kopt_read', { target: 'AllocationService' }],
  ['kopt_read', { target: 'IndexShard.applyIndexOperationOnPrimary' }],
  ['kopt_refs', { target: 'IndexShard.applyIndexOperationOnPrimary' }],
  ['kopt_refs', { target: 'ClusterState.metadata' }],
  ['kopt_outline', { path: 'server/src/main/java/org/elasticsearch/index/shard' }],
];
const lat = [];
for (const [tool, args] of queries) {
  const r = await call(tool, args);
  lat.push({ tool, args: JSON.stringify(args), ms: Math.round(r.ms), tokens: Math.ceil(r.text.length / 3), head: r.text.split('\n')[0].slice(0, 120) });
}
const sorted = lat.map((x) => x.ms).sort((a, b) => a - b);
result.steps.queries = { p50Ms: sorted[Math.floor(sorted.length / 2)], maxMs: sorted[sorted.length - 1], calls: lat };

// ---- refresh 1: files the agent writes (the hooks append them to <dataDir>/dirty) ---------------------------------
const javaFiles = spawnSync('git', ['-C', repo, 'ls-files', '*.java'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).stdout.split('\n').filter((p) => p.startsWith('server/src/main/'));
const pick = (n, from) => javaFiles.filter((_, i) => i % Math.max(1, Math.floor(javaFiles.length / (n * 3))) === from).slice(0, n);
const edit = (paths, tag) => {
  for (const p of paths) {
    const f = join(repo, p);
    const text = readFileSync(f, 'utf8');
    const at = text.lastIndexOf('}');
    writeFileSync(f, `${text.slice(0, at)}    public static int koptScaleProbe${tag}() { return 1; }\n${text.slice(at)}`);
  }
};
const written = pick(20, 0);
edit(written, 'Written');
appendFileSync(join(dataDir, 'dirty'), written.join('\n') + '\n');
{
  const r = await call('kopt_find', { query: 'koptScaleProbeWritten', limit: 30, maxTokens: 4000 });
  const hits = Number(/· (\d+) hits?/.exec(r.text)?.[1] ?? 0);
  result.steps.refreshWritten = { files: written.length, firstCallMs: Math.round(r.ms), visibleInFirstCall: hits };
  log(`refresh of ${written.length} written files: next call ${Math.round(r.ms)} ms, ${hits} hits`);
}

// ---- refresh 2: a pull changes files behind the server's back; `kopt index --refresh` catches up ----------------
const pulled = pick(200, 1);
edit(pulled, 'Pulled');
{
  const t = now();
  const r = spawnSync(process.execPath, [BIN, 'index', '--root', repo, '--refresh'], { env, cwd: repo, encoding: 'utf8', timeout: 900_000 });
  const ms = now() - t;
  const f = await call('kopt_find', { query: 'koptScaleProbePulled', limit: 5 });
  result.steps.refreshPulled = { files: pulled.length, exit: r.status, seconds: secs(ms), output: (r.stdout || '').trim().split('\n').slice(-1)[0], serverSees: f.text.split('\n')[0].slice(0, 120) };
  log(`kopt index --refresh after ${pulled.length} changed files: ${secs(ms)} s`);
}
// ---- no-op refresh: nothing changed ---------------------------------------------------------------------------
{
  const t = now();
  const r = spawnSync(process.execPath, [BIN, 'index', '--root', repo, '--refresh'], { env, cwd: repo, encoding: 'utf8', timeout: 900_000 });
  result.steps.refreshNoop = { exit: r.status, seconds: secs(now() - t), output: (r.stdout || '').trim().split('\n').slice(-1)[0] };
}

clearInterval(rssTimer);
result.steps.serverPeakRssMb = Math.round(peakRss / 1024);
const dbSize = existsSync(join(dataDir, 'index.db')) ? statSync(join(dataDir, 'index.db')).size : 0;
let wal = 0;
for (const f of readdirSync(dataDir)) if (f.startsWith('index.db-')) wal += statSync(join(dataDir, f)).size;
result.steps.indexMb = Math.round((dbSize + wal) / 1024 / 1024);
await client.close();

// ---- report ---------------------------------------------------------------------------------------------------------
const s = result.steps;
const md = [
  `# kopt scale check: ${name}`,
  '',
  `${files.toLocaleString('en-US')} tracked files at ${result.commit} · ${result.platform} · node ${result.node} · ${new Date().toISOString().slice(0, 10)}`,
  'Produced by `bench/scale/run.mjs`: `kopt mcp` over stdio, as Kiro starts it, on a copy-on-write clone of the checkout.',
  '',
  '| step | result |',
  '|---|---|',
  `| server start (initialize) | ${s.connectMs} ms |`,
  `| first build: kopt_find answers from the index | ${s.firstBuild.searchableS} s |`,
  `| first build: kopt_refs answers (references resolved) | ${s.firstBuild.refsReadyS} s |`,
  `| server peak memory (worker thread included) | ${s.serverPeakRssMb} MB |`,
  `| index size on disk | ${s.indexMb} MB |`,
  `| concurrent \`kopt index\` started during the build | exit ${s.concurrentIndex.exit} after ${s.concurrentIndex.seconds} s: ${s.concurrentIndex.output.join(' / ')} |`,
  `| query latency on the built index (${s.queries.calls.length} calls) | median ${s.queries.p50Ms} ms, max ${s.queries.maxMs} ms |`,
  `| ${s.refreshWritten.files} files written by the agent (hook dirty list), next call | ${s.refreshWritten.firstCallMs} ms, ${s.refreshWritten.visibleInFirstCall} of them found by that call |`,
  `| ${s.refreshPulled.files} files changed by a pull, \`kopt index --refresh\` | ${s.refreshPulled.seconds} s (${s.refreshPulled.output}); the server then answers: ${s.refreshPulled.serverSees} |`,
  `| \`kopt index --refresh\`, nothing changed | ${s.refreshNoop.seconds} s (${s.refreshNoop.output}) |`,
  '',
  'Calls made while the first build ran (the agent is never blocked: it gets the progress until search is ready):',
  '',
  '| at (s) | call took (ms) | first line of the answer |',
  '|---|---|---|',
  ...s.firstBuild.callsDuringBuild.map((c) => `| ${c.at} | ${c.ms} | ${c.text.replace(/\|/g, '\\|')} |`),
  '',
  '| tool | arguments | ms | tokens | first line |',
  '|---|---|---|---|---|',
  ...s.queries.calls.map((c) => `| ${c.tool} | \`${c.args}\` | ${c.ms} | ${c.tokens} | ${c.head.replace(/\|/g, '\\|')} |`),
  '',
];
// no machine-specific path in the report
const scrub = (t) => t.split(repo).join('<clone>').split(work).join('<work>');
const text = scrub(md.join('\n'));
if (o.out) {
  writeFileSync(o.out, text);
  writeFileSync(o.out.replace(/\.md$/, '') + '.json', scrub(JSON.stringify(result, null, 2)) + '\n');
}
process.stdout.write(text);
if (!o.keep) rmSync(work, { recursive: true, force: true, maxRetries: 3 });
process.exit(0);
