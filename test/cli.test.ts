import { spawn, spawnSync } from 'node:child_process';
import { createServer as createHttp } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { defaultConfig, indexPath, loadConfig } from '../src/core/config.js';
import { META } from '../src/store/schema.js';
import { Store } from '../src/store/store.js';
import { rmTree } from './helpers/fs.js';

const ROOT = resolve(__dirname, '..');
const CLI = join(ROOT, 'src', 'cli.ts');
let home: string;
// Index caches of temp repos: a temp dir, shared with the spawned CLI through the environment.
process.env.KOPT_CACHE_DIR = mkdtempSync(join(tmpdir(), 'kopt-cli-cache-'));

const env = () => ({ ...process.env, KOPT_HOME: home, KOPT_TELEMETRY: '0', KOPT_ROOT: '' });

function kopt(args: string[], input?: string, extraEnv: Record<string, string> = {}) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['--no-warnings', '--import', 'tsx', CLI, ...args], {
    cwd: ROOT,
    input: input ?? '',
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...env(), ...extraEnv },
  });
  return { ...r, ms: Date.now() - t0 };
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'kopt-cli-home-'));
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('kopt hook', () => {
  it('exits 0 with no output on malformed stdin', () => {
    const r = kopt(['hook'], '{"hook_event_name": "PreToolUse", broken');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    process.stderr.write(`[perf] kopt hook (malformed input, via tsx): ${r.ms}ms\n`);
  });

  it('exits 0 on empty stdin and on non-object JSON', () => {
    expect(kopt(['hook'], '').status).toBe(0);
    expect(kopt(['hook'], '[1,2]').status).toBe(0);
  });

  it('passes a well-formed event to the hooks module and never fails the session', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'kopt-cli-repo-'));
    const r = kopt(['hook'], JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 's1', cwd, tool_name: 'fs_read', tool_input: {}, tool_response: {} }));
    expect([0, 2]).toContain(r.status);
    rmSync(cwd, { recursive: true, force: true });
  });
});

describe('kopt CLI', () => {
  it('lists every command in --help', () => {
    const r = kopt(['--help']);
    expect(r.status).toBe(0);
    for (const c of ['index', 'mcp', 'serve', 'find', 'read', 'outline', 'refs', 'run', 'expand', 'setup', 'doctor', 'uninstall', 'init', 'hook', 'stats', 'telemetry', 'credits', 'sync', 'bench']) {
      expect(r.stdout).toMatch(new RegExp(`^  ${c}\\b`, 'm'));
    }
  });

  it('reports usage errors on stderr with a non-zero exit', () => {
    const r = kopt(['read']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("missing required argument 'target'");
  });

  it.skipIf(!existsSync(join(ROOT, 'src', 'kiro', 'index.ts')))('init --dry-run lists the files it would write', () => {
    const repo = mkdtempSync(join(tmpdir(), 'kopt-cli-init-'));
    const kiroHome = mkdtempSync(join(tmpdir(), 'kopt-cli-kiro-'));
    const r = kopt(['init', '--dry-run', '--root', repo], undefined, { KOPT_KIRO_HOME: kiroHome, KOPT_KIRO_USER_SETTINGS: join(kiroHome, 'settings.json') });
    if (r.status !== 0) process.stderr.write(`[init] ${r.stderr}\n`);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/would write .*mcp\.json/);
    expect(existsSync(join(repo, '.kiro'))).toBe(false);
    rmSync(repo, { recursive: true, force: true });
    rmSync(kiroHome, { recursive: true, force: true });
  });

  it.skipIf(!existsSync(join(ROOT, 'src', 'telemetry', 'index.ts')))('stats prints a report from an empty telemetry dir', () => {
    const repo = mkdtempSync(join(tmpdir(), 'kopt-cli-stats-'));
    const r = kopt(['stats', '--days', '7', '--root', repo], undefined, { KOPT_KIRO_HOME: join(repo, 'nokiro') });
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
    rmSync(repo, { recursive: true, force: true });
  });

  it('sync fails cleanly without a configured snapshot URL', () => {
    const repo = mkdtempSync(join(tmpdir(), 'kopt-cli-sync-'));
    const r = kopt(['sync', '--root', repo], undefined, { KOPT_SNAPSHOT_URL: '' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('snapshotUrl is not configured');
    rmSync(repo, { recursive: true, force: true });
  });
});

describe('kopt mcp (stdio)', () => {
  it('speaks clean MCP on stdout and lists the 6 tools', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'kopt-cli-mcp-'));
    const cfg = defaultConfig(repo);
    const text = 'export function computeRefund(total: number, fees: number): number {\n  return total - fees;\n}\n';
    writeFileSync(join(repo, 'refund.ts'), text);
    const s = Store.open(indexPath(cfg));
    s.prepare('INSERT INTO files(id, path, lang, hash, size, line_count, mtime_ms, rank, indexed_at) VALUES (1,?,?,?,?,?,0,0.5,?)').run('refund.ts', 'typescript', 'h', text.length, 3, Date.now());
    s.prepare(
      `INSERT INTO symbols(id, file_id, name, qname, kind, start_line, end_line, start_byte, end_byte, signature, exported, rank)
       VALUES (2, 1, 'computeRefund', 'computeRefund', 'function', 1, 3, 0, ?, 'export function computeRefund(total: number, fees: number): number', 1, 0.5)`,
    ).run(text.length);
    s.prepare('INSERT INTO symbols_fts(rowid, name_terms, sig_terms, path_terms, doc, body_terms) VALUES (2,?,?,?,?,?)').run('computerefund compute refund', 'total fees', 'refund ts', '', 'total fees');
    s.setMeta(META.indexedAt, String(Date.now()));
    s.close();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--no-warnings', '--import', 'tsx', CLI, 'mcp', '--root', repo],
      cwd: ROOT,
      env: env() as Record<string, string>,
      stderr: 'pipe',
    });
    const errors: Error[] = [];
    const client = new Client({ name: 'test', version: '0' });
    client.onerror = (e) => errors.push(e);
    const t0 = Date.now();
    await client.connect(transport);
    const { tools } = await client.listTools();
    const ms = Date.now() - t0;
    expect(tools.map((t) => t.name)).toEqual(['kopt_find', 'kopt_read', 'kopt_outline', 'kopt_refs', 'kopt_run', 'kopt_expand']);
    expect(errors).toEqual([]);
    process.stderr.write(`[perf] kopt mcp spawn -> tools/list (via tsx): ${ms}ms\n`);
    const res = (await client.callTool({ name: 'kopt_find', arguments: { query: 'refund' } })) as any;
    if (existsSync(join(ROOT, 'src', 'retrieval', 'index.ts'))) {
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain('computeRefund');
    }
    if (existsSync(join(ROOT, 'src', 'compress', 'index.ts'))) {
      const run = (await client.callTool({ name: 'kopt_run', arguments: { command: 'echo kopt-ok' } })) as any;
      expect(run.isError).toBeFalsy();
      expect(run.content[0].text).toContain('kopt-ok');
    }
    expect(errors).toEqual([]);
    await client.close();
    rmSync(repo, { recursive: true, force: true });
  });
});

describe('kopt run (end to end, needs compress)', () => {
  it.skipIf(!existsSync(join(ROOT, 'src', 'compress', 'index.ts')))('quotes argv, prints compact output and propagates failure', () => {
    const repo = mkdtempSync(join(tmpdir(), 'kopt-cli-run-'));
    // argv is quoted for the shell kopt_run uses: sh/bash on POSIX, PowerShell on Windows
    const win = process.platform === 'win32';
    const r = kopt(win
      ? ['run', '--root', repo, 'node', '-e', "console.log('its fine'); process.exit(3)"]
      : ['run', '--root', repo, 'sh', '-c', "echo 'it''s fine'; exit 3"]);
    expect(r.stdout).toContain("its fine");
    expect(r.status).toBe(1);
    const ok = kopt(['run', '--root', repo, win ? 'Write-Output hello | ForEach-Object { $_.ToUpper() }' : 'echo hello | tr a-z A-Z']);
    expect(ok.stdout).toContain('HELLO');
    expect(ok.status).toBe(0);
    rmSync(repo, { recursive: true, force: true });
  });
});

describe('kopt find (end to end, needs indexer + retrieval)', () => {
  const ready = existsSync(join(ROOT, 'src', 'indexer', 'index.ts')) && existsSync(join(ROOT, 'src', 'retrieval', 'index.ts'));
  it.skipIf(!ready)('indexes a tiny repo on first use and prints hits', () => {
    const repo = mkdtempSync(join(tmpdir(), 'kopt-cli-find-'));
    writeFileSync(join(repo, 'refund.ts'), 'export function computeRefund(total: number, fees: number): number {\n  return total - fees;\n}\n');
    const r = kopt(['find', 'compute', 'refund', '--root', repo]);
    if (r.status !== 0) process.stderr.write(`[cli find] ${r.stderr}\n`);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('computeRefund');
    rmSync(repo, { recursive: true, force: true });
  });
});

describe('kopt mcp first build (worker thread, needs indexer + retrieval)', () => {
  const ready = existsSync(join(ROOT, 'src', 'indexer', 'index.ts')) && existsSync(join(ROOT, 'src', 'retrieval', 'index.ts'));
  it.skipIf(!ready)('builds the index in the background and answers once ready', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'kopt-cli-build-'));
    writeFileSync(join(repo, 'refund.ts'), 'export function computeRefund(total: number, fees: number): number {\n  return total - fees;\n}\n');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--no-warnings', '--import', 'tsx', CLI, 'mcp', '--root', repo],
      cwd: ROOT,
      env: env() as Record<string, string>,
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (c) => (stderr += String(c)));
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(transport);
    let text = '';
    for (let i = 0; i < 5 && !text.includes('computeRefund'); i++) {
      const r = (await client.callTool({ name: 'kopt_find', arguments: { query: 'compute refund' } })) as any;
      text = r.content[0].text;
    }
    if (!text.includes('computeRefund')) process.stderr.write(`[first build] ${text}\n${stderr}\n`);
    expect(text).toContain('computeRefund');
    expect(stderr).not.toContain('index worker unavailable');
    await client.close();
    rmSync(repo, { recursive: true, force: true });
  }, 60_000);
});

describe('kopt sync (needs indexer)', () => {
  it.skipIf(!existsSync(join(ROOT, 'src', 'indexer', 'index.ts')))('downloads a gzipped snapshot, swaps it in and refreshes local changes', async () => {
    const work = mkdtempSync(join(tmpdir(), 'kopt-cli-sync-'));
    const snap = join(work, 'snap.db');
    const s = Store.open(snap);
    s.setMeta(META.indexedAt, String(Date.now()));
    s.setMeta(META.origin, 'snapshot');
    s.setMeta('sync_marker', 'from-snapshot');
    s.db.exec('PRAGMA journal_mode=DELETE;');
    s.close();
    const body = gzipSync(readFileSync(snap));
    const seen: string[] = [];
    const server = createHttp((req, res) => {
      seen.push(req.url ?? '');
      if (req.url?.endsWith('/latest.db.gz')) return res.end(body);
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const repo = join(work, 'myrepo');
    (await import('node:fs')).mkdirSync(repo);
    writeFileSync(join(repo, 'refund.ts'), 'export function computeRefund(total: number): number {\n  return total;\n}\n');
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/{repo}/{commit}.db.gz`;
    // async spawn: the snapshot server lives in this process
    const r = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveRun) => {
      const p = spawn(process.execPath, ['--no-warnings', '--import', 'tsx', CLI, 'sync', '--root', repo], { cwd: ROOT, env: { ...env(), KOPT_SNAPSHOT_URL: url } });
      let stdout = '';
      let stderr = '';
      p.stdout.on('data', (c) => (stdout += c));
      p.stderr.on('data', (c) => (stderr += c));
      p.on('close', (code) => resolveRun({ code, stdout, stderr }));
    });
    server.close();
    if (r.code !== 0) process.stderr.write(`[sync] ${r.stderr}\n`);
    expect(r.code).toBe(0);
    expect(seen).toContain('/myrepo/latest.db.gz');
    expect(r.stdout).toMatch(/^synced myrepo@latest/);
    const idx = Store.open(indexPath(loadConfig(repo)), { readonly: true });
    expect(idx.getMeta('sync_marker')).toBe('from-snapshot'); // the downloaded file was swapped in
    expect(idx.fileByPath('refund.ts')).toBeDefined(); // local file picked up by the refresh
    idx.close();
    rmSync(work, { recursive: true, force: true });
  });
});

describe('zero-config commands (temp HOME)', () => {
  function sandboxEnv(): Record<string, string> {
    const box = mkdtempSync(join(tmpdir(), 'kopt-cli-box-'));
    return {
      HOME: box,
      USERPROFILE: box,
      KOPT_HOME: join(box, '.kopt'),
      KOPT_KIRO_HOME: join(box, '.kiro'),
      KOPT_KIRO_USER_SETTINGS: join(box, 'Kiro', 'User', 'settings.json'),
      KOPT_KIRO_CLI: 'none',
      KOPT_KIRO_IDE_PATHS: '',
      KOPT_HOOK_COMMAND: 'node',
      XDG_CONFIG_HOME: join(box, '.config'),
    };
  }

  it('setup --dry-run --no-global plans the user-level files and writes nothing', () => {
    const e = sandboxEnv();
    const r = kopt(['setup', '--dry-run', '--no-global'], undefined, e);
    if (r.status !== 0) process.stderr.write(`[setup] ${r.stderr}\n`);
    expect(r.status).toBe(0);
    // user-facing paths use the native separator: ~/.kiro/... on POSIX, ~\.kiro\... on Windows
    expect(r.stdout).toContain(`would write ${join('~', '.kiro', 'settings', 'mcp.json')}\n`);
    expect(r.stdout).toContain(`would write ${join('~', '.kiro', 'hooks', 'kopt.json')}\n`);
    expect(r.stdout).toMatch(/dry run/);
    expect(existsSync(join(e.HOME, '.kiro'))).toBe(false);
    rmSync(e.HOME, { recursive: true, force: true });
  });

  it('setup then doctor --quick then uninstall', () => {
    const e = sandboxEnv();
    const s = kopt(['setup', '--no-global', '--no-doctor'], undefined, e);
    expect(s.status).toBe(0);
    expect(s.stdout).toMatch(/kopt is active for every project in Kiro\. Restart Kiro\./);
    expect(existsSync(join(e.HOME, '.kiro', 'hooks', 'kopt.json'))).toBe(true);
    const d = kopt(['doctor', '--quick'], undefined, e);
    expect(d.stdout).toMatch(/^ok {4}node v/m);
    expect(d.stdout).toContain(`${join(e.KOPT_KIRO_HOME, 'hooks', 'kopt.json')}: valid v1 hooks`);
    const u = kopt(['uninstall'], undefined, e);
    expect(u.status).toBe(0);
    expect(u.stdout).toContain(`removed ${join('~', '.kiro', 'hooks', 'kopt.json')}\n`);
    expect(existsSync(join(e.HOME, '.kiro', 'hooks', 'kopt.json'))).toBe(false);
    rmSync(e.HOME, { recursive: true, force: true });
  }, 60_000);

  it('kopt mcp without --root serves the git root of its cwd, and nothing in a home directory', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'kopt-cli-auto-'));
    (await import('node:fs')).mkdirSync(join(repo, '.git'));
    (await import('node:fs')).mkdirSync(join(repo, 'pkg', 'sub'), { recursive: true });
    writeFileSync(join(repo, 'refund.ts'), 'export function computeRefund(total: number): number {\n  return total;\n}\n');
    const call = async (cwd: string, extra: Record<string, string> = {}) => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ['--no-warnings', '--import', 'tsx', CLI, 'mcp'],
        cwd,
        env: { ...(env() as Record<string, string>), NODE_OPTIONS: '', ...extra },
        stderr: 'pipe',
      });
      // tsx must resolve from the repo even when cwd is elsewhere; --import takes a URL (a bare C:\ path is not one)
      (transport as any)._serverParams.args[2] = pathToFileURL(join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
      const client = new Client({ name: 'test', version: '0' });
      await client.connect(transport);
      let text = '';
      for (let i = 0; i < 5 && !/computeRefund|no project/.test(text); i++) {
        const r = (await client.callTool({ name: 'kopt_find', arguments: { query: 'compute refund' } })) as any;
        text = r.content[0].text;
      }
      await client.close();
      return text;
    };
    expect(await call(join(repo, 'pkg', 'sub'))).toContain('computeRefund');
    expect(existsSync(join(repo, '.kopt'))).toBe(false); // the index lives in the cache dir
    const fakeHome = mkdtempSync(join(tmpdir(), 'kopt-cli-home-'));
    expect(await call(fakeHome, { HOME: fakeHome, USERPROFILE: fakeHome })).toMatch(/^kopt: no project folder is open/);
    // the server children may still be exiting, their cwd inside these dirs (Windows refuses to delete those)
    rmTree(repo);
    rmTree(fakeHome);
  }, 60_000);
});
