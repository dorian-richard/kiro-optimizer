// `kopt doctor`: one line per check (ok / warn / fail + fix hint). Runs the configured hook commands the way Kiro
// does (shell: true, JSON on stdin) and the configured MCP server the way Kiro does (MCP SDK stdio transport), in a
// scratch directory with a scratch KOPT_HOME, so nothing of the user's is touched. Both run with a MINIMAL
// environment (PATH=/usr/bin:/bin on POSIX, the Windows system folders on Windows): Kiro IDE started from the Dock or
// the Start menu does not get the PATH of the user's shell profile (nvm, volta, fnm, Homebrew), so a command that
// starts here starts there.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findProjectRoot, indexPath, isUnsafeRoot, loadConfig, userDirFor } from '../core/config.js';
import { commandProgram, dependsOnPath, hookCommandLine, isTransientPath, nodeVersionOk, pathNodeVersion, resolveKoptCommand } from './command.js';
import { detectSurfaces, hookPlan, writeSurfacesCache, type Surfaces, type VersionRunner } from './detect.js';
import { parseJsonc } from './jsonc.js';
import { KIROIGNORE_BEGIN } from './kiroignore.js';
import { hostEnv, isNpxCachePath, kiroCliSettingsPath, kiroHomeDir, kiroUserSettingsPath, which, type HostEnv } from './paths.js';
import { readText } from './plan.js';
import { LISTED_TOOLS } from '../mcp/tools.js';
import { DEFAULT_AGENT_SETTING, IGNORE_SETTING } from './setup.js';

export type Status = 'ok' | 'warn' | 'fail';

export interface Check {
  id: string;
  status: Status;
  message: string;
  fix?: string;
}

export interface DoctorOptions {
  /** Folder whose index status is reported (default: cwd). */
  cwd?: string;
  h?: HostEnv;
  runVersion?: VersionRunner;
  /** Skip the checks that start processes (hook command, MCP server). */
  skipProcesses?: boolean;
  timeoutMs?: number;
  /** Validate the CLI agent with the real `kiro-cli agent validate` when the CLI is installed. Default true. */
  validateWithCli?: boolean;
  /** Report the IDE 0.x workspace hook and index status of `cwd`. Default true; `kopt setup` turns it off (user-level). */
  projectChecks?: boolean;
}

export interface DoctorReport {
  checks: Check[];
  surfaces: Surfaces;
  ok: boolean;
}

export interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  error?: string;
}

const pick = (env: NodeJS.ProcessEnv, keys: string[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = env[k];
    if (typeof v === 'string' && v && !v.startsWith('()')) out[k] = v;
  }
  return out;
};

/**
 * The environment of a GUI-started Kiro, with no shell profile: system folders only on PATH. Doctor runs every
 * configured command with it, so a command that needs nvm / volta / Homebrew on PATH fails here, not in Kiro.
 */
export function minimalEnv(h: HostEnv): Record<string, string> {
  if (h.platform === 'win32') {
    const env = pick(h.env, ['SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'PATHEXT', 'SystemDrive', 'USERPROFILE', 'USERNAME', 'APPDATA',
      'LOCALAPPDATA', 'TEMP', 'TMP', 'HOMEDRIVE', 'HOMEPATH', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'PUBLIC', 'OS',
      'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS']);
    const sys = env.SystemRoot || env.SYSTEMROOT || env.windir || 'C:\\Windows';
    env.PATH = [`${sys}\\System32`, sys, `${sys}\\System32\\Wbem`, `${sys}\\System32\\WindowsPowerShell\\v1.0`].join(';');
    if (!env.USERPROFILE) env.USERPROFILE = h.home;
    return env;
  }
  return { ...pick(h.env, ['USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR']), HOME: h.home, PATH: '/usr/bin:/bin', SHELL: '/bin/sh' };
}

/** Run a hook command like Kiro: through the platform shell, event JSON on stdin, stdin then closed. */
export function runHookCommand(command: string, event: unknown, o: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<ProcResult> {
  return new Promise((resolveRun) => {
    const t0 = Date.now();
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (r: Omit<ProcResult, 'ms' | 'stdout' | 'stderr'>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolveRun({ ...r, stdout, stderr, ms: Date.now() - t0 });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, { shell: true, cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      return resolveRun({ code: null, stdout: '', stderr: '', ms: 0, error: (err as Error).message });
    }
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: null, error: `timed out after ${o.timeoutMs ?? 15000} ms` });
    }, o.timeoutMs ?? 15000);
    child.stdout!.on('data', (c) => (stdout += c));
    child.stderr!.on('data', (c) => (stderr += c));
    child.on('error', (err) => finish({ code: null, error: err.message }));
    child.on('close', (code) => finish({ code }));
    child.stdin!.on('error', () => {});
    child.stdin!.end(JSON.stringify(event));
  });
}

interface ConfiguredHooks {
  /** PreToolUse command (the governor), and the Stop command, of one hook file. */
  pre: string;
  stop?: string;
  from: string;
}

/** kopt's configured hook commands: the v1 file (IDE 1.x, CLI V3) and the CLI 2.x agent. */
function configuredHooks(h: HostEnv): ConfiguredHooks[] {
  const kh = kiroHomeDir(h);
  const out: ConfiguredHooks[] = [];
  const v1 = join(kh, 'hooks', 'kopt.json');
  try {
    const doc = JSON.parse(readText(v1) ?? '');
    const find = (t: string) => (doc.hooks as any[]).find((x) => x?.trigger === t)?.action?.command;
    const pre = find('PreToolUse');
    if (typeof pre === 'string') out.push({ pre, stop: typeof find('Stop') === 'string' ? find('Stop') : undefined, from: v1 });
  } catch {
    // missing or invalid: reported by the hooks check
  }
  const agent = join(kh, 'agents', 'kopt.json');
  try {
    const doc = JSON.parse(readText(agent) ?? '');
    const pre = doc?.hooks?.preToolUse?.[0]?.command;
    const stop = doc?.hooks?.stop?.[0]?.command;
    if (typeof pre === 'string') out.push({ pre, stop: typeof stop === 'string' ? stop : undefined, from: agent });
  } catch {
    // none
  }
  return out;
}

/** Problems of a configured program path: needs PATH, lives in the npx cache, or is gone. */
function programProblem(program: string, platform: NodeJS.Platform): string | undefined {
  if (!program) return 'empty command';
  if (dependsOnPath(program)) return `"${program}" is looked up on PATH, which Kiro started from the ${platform === 'darwin' ? 'Dock' : platform === 'win32' ? 'Start menu' : 'desktop'} may not have`;
  if (isTransientPath(program)) return `${program} is in the npx cache, which npm deletes`;
  if (!existsSync(program)) return `${program} does not exist`;
  return undefined;
}

/** `<node> --version`, or undefined. */
function nodeVersionOf(node: string): string | undefined {
  try {
    return execFileSync(node, ['--version'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
  } catch {
    return undefined;
  }
}

/** Static checks of the commands Kiro will run: absolute, present, not in the npx cache, Node >= 22.13. */
function commandChecks(h: HostEnv, entry: Record<string, any> | undefined, hooks: ConfiguredHooks[]): Check[] {
  const checks: Check[] = [];
  if (entry && typeof entry.command === 'string') {
    const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
    const problems: string[] = [];
    const p = programProblem(entry.command, h.platform);
    if (p) problems.push(p);
    // kopt's entry is the argument before `mcp` (`node [flags] <bin.js> mcp`)
    const at = args.indexOf('mcp');
    const bin = at > 0 && !/^[a-z]+:\/\//i.test(args[at - 1]) ? args[at - 1] : undefined;
    if (bin && isTransientPath(bin)) problems.push(`${bin} is in the npx cache, which npm deletes`);
    else if (bin && !existsSync(bin)) problems.push(`${bin} does not exist`);
    let version: string | undefined;
    if (!p && !dependsOnPath(entry.command) && /node(\.exe)?$/i.test(entry.command)) {
      version = nodeVersionOf(entry.command);
      if (!nodeVersionOk(version)) problems.push(`${entry.command} is Node ${version ?? '(does not run)'}, kopt needs 22.13 or later`);
    }
    checks.push(problems.length
      ? { id: 'mcp-command', status: 'fail', message: `MCP command: ${problems.join('; ')}`, fix: 're-run kopt setup with Node 22.13+ (it writes absolute paths)' }
      : { id: 'mcp-command', status: 'ok', message: `MCP command: absolute paths${version ? ` (Node ${version})` : ''}` });
  }
  const seen = new Set<string>();
  for (const c of hooks) {
    for (const line of [c.pre, c.stop]) {
      if (!line || seen.has(line)) continue;
      seen.add(line);
      const problem = programProblem(commandProgram(line), h.platform);
      if (problem) checks.push({ id: 'hook-command', status: 'fail', message: `hook command in ${c.from}: ${problem}`, fix: 're-run kopt setup (it writes absolute paths)' });
    }
  }
  if (hooks.length && !checks.some((c) => c.id === 'hook-command')) checks.push({ id: 'hook-command', status: 'ok', message: `hook commands: absolute paths (${commandProgram(hooks[0].pre)})` });
  return checks;
}

function mcpEntry(h: HostEnv): { entry?: Record<string, any>; path: string; error?: string } {
  const path = join(kiroHomeDir(h), 'settings', 'mcp.json');
  const text = readText(path);
  if (text === undefined) return { path };
  try {
    const doc = JSON.parse(text);
    const entry = doc?.mcpServers?.kopt;
    return { path, entry: entry && typeof entry === 'object' ? entry : undefined };
  } catch (err) {
    return { path, error: (err as Error).message };
  }
}

function validHooksFile(text: string | undefined): string | undefined {
  if (text === undefined) return 'missing';
  try {
    const doc = JSON.parse(text);
    if (doc.version !== 'v1') return 'version is not "v1"';
    if (!Array.isArray(doc.hooks) || !doc.hooks.length) return 'no hooks';
    for (const x of doc.hooks) {
      if (typeof x?.name !== 'string' || typeof x?.trigger !== 'string' || x?.action?.type !== 'command' || typeof x?.action?.command !== 'string') {
        return `invalid hook ${JSON.stringify(x?.name ?? '?')}`;
      }
    }
    return undefined;
  } catch (err) {
    return `invalid JSON (${(err as Error).message})`;
  }
}

function age(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 120) return `${s}s`;
  if (s < 7200) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} days`;
}

async function indexStatus(cwd: string): Promise<Check> {
  const root = findProjectRoot(cwd);
  if (isUnsafeRoot(root)) return { id: 'index', status: 'ok', message: `index: ${root} is not a project (home or filesystem root): nothing to index here` };
  const cfg = loadConfig(root);
  const db = indexPath(cfg);
  const { existsSync } = await import('node:fs');
  if (!existsSync(db)) {
    return { id: 'index', status: 'warn', message: `index: none yet for ${root}`, fix: 'it builds in the background when Kiro opens this folder; or run kopt index' };
  }
  try {
    const { Store } = await import('../store/store.js');
    const store = Store.open(db, { root, readonly: true });
    try {
      const files = (store.prepare('SELECT count(*) AS n FROM files').get() as { n: number }).n;
      const symbols = (store.prepare('SELECT count(*) AS n FROM symbols').get() as { n: number }).n;
      const at = Number(store.getMeta('indexed_at') ?? 0);
      const when = at ? `, updated ${age(Date.now() - at)} ago` : ', first build not finished';
      // each checkout of a big repository has its own index (about 1 GB for 30k Java files)
      const { statSync, readFileSync } = await import('node:fs');
      let bytes = 0;
      for (const f of [db, `${db}-wal`]) {
        try {
          bytes += statSync(f).size;
        } catch {
          // no WAL
        }
      }
      const size = bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
      let failed: { at: number; message: string } | undefined;
      try {
        failed = JSON.parse(readFileSync(join(cfg.dataDir, 'last-error.json'), 'utf8'));
      } catch {
        // no failure recorded
      }
      if (failed && typeof failed.message === 'string' && Number(failed.at) > at) {
        return {
          id: 'index',
          status: 'fail',
          message: `index: the last build failed ${age(Date.now() - Number(failed.at))} ago: ${failed.message} (${db})`,
          fix: `run kopt index in ${root} to see it again; kopt retries by itself after 1, 2, 4... minutes`,
        };
      }
      return { id: 'index', status: at ? 'ok' : 'warn', message: `index: ${files} files, ${symbols} symbols${when}, ${size} on disk (${db})` };
    } finally {
      store.close();
    }
  } catch (err) {
    return { id: 'index', status: 'fail', message: `index: unreadable ${db} (${(err as Error).message.split('\n')[0]})`, fix: 'delete it; kopt rebuilds it' };
  }
}

async function mcpCheck(entry: Record<string, any>, scratch: string, hostVars: NodeJS.ProcessEnv, envExtra: Record<string, string>, timeoutMs: number, pathNote = ''): Promise<Check> {
  const [{ Client }, { StdioClientTransport, DEFAULT_INHERITED_ENV_VARS }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
  ]);
  // Kiro starts MCP servers with the SDK's default environment (only these variables) plus the entry's env; the
  // caller passes the minimal environment of a GUI-started Kiro.
  const inherited: Record<string, string> = {};
  // Windows names are case-insensitive (SYSTEMROOT = SystemRoot); a plain object is not
  const lookup = (k: string) => hostVars[k] ?? Object.entries(hostVars).find(([n]) => n.toUpperCase() === k.toUpperCase())?.[1];
  for (const k of DEFAULT_INHERITED_ENV_VARS) {
    const v = lookup(k);
    if (v !== undefined && !v.startsWith('()')) inherited[k] = v;
  }
  const transport = new StdioClientTransport({
    command: String(entry.command),
    args: Array.isArray(entry.args) ? entry.args.map(String) : [],
    env: { ...inherited, ...(entry.env ?? {}), ...envExtra },
    cwd: scratch,
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (c) => (stderr += String(c)));
  const client = new Client({ name: 'kopt-doctor', version: '0' });
  const t0 = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const run = (async () => {
      await client.connect(transport);
      return client.listTools();
    })();
    const timeout = new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs)));
    const { tools } = await Promise.race([run, timeout]);
    const names = tools.map((t) => t.name);
    const ms = Date.now() - t0;
    const want = LISTED_TOOLS.length;
    if (names.length !== want) return { id: 'mcp', status: 'fail', message: `MCP server: ${names.length} tools (${names.join(', ')}), expected ${want}`, fix: 'reinstall kopt' };
    return { id: 'mcp', status: 'ok', message: `MCP server: starts and lists ${want} tools (${ms} ms${pathNote ? `, ${pathNote}` : ''}): ${[entry.command, ...(entry.args ?? [])].join(' ')}` };
  } catch (err) {
    const detail = stderr.trim().split('\n').slice(-2).join(' | ');
    return {
      id: 'mcp',
      status: 'fail',
      message: `MCP server${pathNote ? ` (${pathNote})` : ''}: ${(err as Error).message}${detail ? ` (${detail})` : ''}`,
      fix: 're-run kopt setup with Node 22.13+ (it writes absolute paths), then kopt doctor',
    };
  } finally {
    if (timer) clearTimeout(timer);
    await client.close().catch(() => {});
  }
}

export async function runDoctor(o: DoctorOptions = {}): Promise<DoctorReport> {
  const h = o.h ?? hostEnv();
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);
  const timeoutMs = o.timeoutMs ?? 20_000;

  // Node
  const nodeOk = nodeVersionOk(process.version);
  add({ id: 'node', status: nodeOk ? 'ok' : 'fail', message: `node ${process.version} (needs >= 22.13)`, fix: nodeOk ? undefined : 'install Node.js 22.13 or later' });

  // kopt on the terminal PATH: only for typing `kopt ...` (Kiro runs it by absolute path)
  const shim = which('kopt', h, (d) => isNpxCachePath(d + '/') || /[\\/]node_modules[\\/]\.bin$/.test(d));
  const pathNode = shim ? pathNodeVersion(h) : undefined;
  if (shim) {
    const ok = nodeVersionOk(pathNode);
    add({
      id: 'path',
      status: ok ? 'ok' : 'warn',
      message: `kopt on PATH: ${shim}${pathNode ? ` (node ${pathNode})` : ''}`,
      fix: ok ? undefined : 'the `node` on your PATH is older than 22.13: `kopt` fails in this terminal (Kiro is not affected)',
    });
  } else {
    add({ id: 'path', status: 'warn', message: 'kopt is not on your terminal PATH (Kiro does not need it: it runs kopt by absolute path)', fix: 'to type kopt commands, add `npm prefix -g` (its bin folder on Linux/macOS) or ~/.kopt/bin to PATH' });
  }

  // Surfaces
  const surfaces = detectSurfaces(h, { run: o.runVersion });
  writeSurfacesCache(userDirFor({ platform: h.platform, env: h.env, home: h.home }), surfaces);
  add({ id: 'ide', status: surfaces.ide ? 'ok' : 'warn', message: surfaces.ide ? `Kiro IDE ${surfaces.ide.version} (${surfaces.ide.major < 1 ? 'legacy 0.x hooks per workspace' : 'global v1 hooks'})` : 'Kiro IDE: not found' });
  add({
    id: 'cli',
    status: surfaces.cli ? 'ok' : 'warn',
    message: surfaces.cli ? `Kiro CLI ${surfaces.cli.version} (${surfaces.cli.engine} engine) at ${surfaces.cli.path}` : 'Kiro CLI: not found',
  });
  const plan = hookPlan(surfaces, surfaces.ide || surfaces.cli ? undefined : 'all');

  // Config files
  const kh = kiroHomeDir(h);
  const mcp = mcpEntry(h);
  if (mcp.error) add({ id: 'mcp.json', status: 'fail', message: `${mcp.path}: invalid JSON (${mcp.error})`, fix: 'fix the JSON, then re-run kopt setup' });
  else if (!mcp.entry) add({ id: 'mcp.json', status: 'fail', message: `${mcp.path}: no "kopt" server`, fix: 'run kopt setup' });
  else if (mcp.entry.disabled === true) add({ id: 'mcp.json', status: 'warn', message: `${mcp.path}: kopt server is disabled`, fix: 'enable it in the Kiro MCP panel' });
  else add({ id: 'mcp.json', status: 'ok', message: `${mcp.path}: kopt -> ${[mcp.entry.command, ...(mcp.entry.args ?? [])].join(' ')}` });

  const hooksPath = join(kh, 'hooks', 'kopt.json');
  const hooksErr = validHooksFile(readText(hooksPath));
  if (plan.globalV1) add({ id: 'hooks', status: hooksErr ? 'fail' : 'ok', message: `${hooksPath}: ${hooksErr ?? 'valid v1 hooks (IDE 1.x, CLI V3)'}`, fix: hooksErr ? 'run kopt setup' : undefined });

  if (plan.cliAgent) {
    const agentPath = join(kh, 'agents', 'kopt.json');
    const text = readText(agentPath);
    let err: string | undefined;
    try {
      const doc = JSON.parse(text ?? '');
      if (!doc?.hooks?.preToolUse) err = 'no preToolUse hook';
      else if ('useLegacyMcpJson' in doc && 'includeMcpJson' in doc) err = 'both includeMcpJson and its alias useLegacyMcpJson (kiro-cli rejects duplicates)';
    } catch {
      err = text === undefined ? 'missing' : 'invalid JSON';
    }
    let validated = false;
    if (!err && surfaces.cli && !o.skipProcesses && o.validateWithCli !== false) {
      // `kiro-cli agent ...` re-launches `$HOME/.local/bin/kiro-cli-chat`; call the chat binary next to kiro-cli directly.
      const { execFileSync } = await import('node:child_process');
      const { dirname } = await import('node:path');
      const { realpathSync, existsSync } = await import('node:fs');
      const dir = dirname(realpathSync(surfaces.cli.path));
      const chat = [join(dir, 'kiro-cli-chat'), join(dir, 'kiro-cli-chat.exe')].find((c) => existsSync(c)) ?? surfaces.cli.path;
      let out = '';
      try {
        out = execFileSync(chat, ['agent', 'validate', '--path', agentPath], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        validated = true;
      } catch (e) {
        out = String((e as { stderr?: string }).stderr ?? '') + String((e as { stdout?: string }).stdout ?? '');
        validated = !/failed to launch|not found|ENOENT/i.test(out);
      }
      const clean = out.replace(/\x1b\[[0-9;]*m/g, '').trim();
      if (/invalid|did not match|duplicate|error/i.test(clean)) {
        err = clean.split('\n')[0];
        validated = true;
      }
    }
    add({
      id: 'agent',
      status: err ? 'fail' : 'ok',
      message: `${agentPath}: ${err ?? (validated ? 'valid CLI 2.x agent (kiro-cli agent validate)' : 'CLI 2.x agent present')}`,
      fix: err ? 'run kopt setup --force' : undefined,
    });
    let def: unknown;
    try {
      def = JSON.parse(readText(kiroCliSettingsPath(h)) ?? '{}')[DEFAULT_AGENT_SETTING];
    } catch {
      def = undefined;
    }
    add({
      id: 'default-agent',
      status: def === 'kopt' ? 'ok' : 'warn',
      message: `Kiro CLI default agent: ${def === undefined ? 'built-in' : JSON.stringify(def)}`,
      fix: def === 'kopt' ? undefined : 'kopt setup --force, or kiro-cli chat --agent kopt',
    });
  }

  for (const c of commandChecks(h, mcp.entry, configuredHooks(h))) add(c);

  const steering = readText(join(kh, 'steering', 'kopt.md'));
  add({ id: 'steering', status: steering ? 'ok' : 'warn', message: `${join(kh, 'steering', 'kopt.md')}: ${steering ? 'present' : 'missing'}`, fix: steering ? undefined : 'run kopt setup' });
  const ki = readText(join(kh, 'settings', 'kiroignore'));
  add({ id: 'kiroignore', status: ki?.includes(KIROIGNORE_BEGIN) ? 'ok' : 'warn', message: `${join(kh, 'settings', 'kiroignore')}: ${ki?.includes(KIROIGNORE_BEGIN) ? 'kopt block present' : 'no kopt block'}` });
  if (surfaces.ide) {
    const sp = kiroUserSettingsPath(h);
    let has = false;
    try {
      const v = (parseJsonc(readText(sp) ?? '{}') as Record<string, unknown>)[IGNORE_SETTING];
      has = Array.isArray(v) && v.includes('.kiroignore');
    } catch {
      has = false;
    }
    add({ id: 'ide-settings', status: has ? 'ok' : 'warn', message: `${sp}: ${IGNORE_SETTING} ${has ? 'includes' : 'lacks'} .kiroignore`, fix: has ? undefined : 'run kopt setup' });
  }

  // Processes, like Kiro runs them, with the minimal environment of a GUI-started Kiro
  if (!o.skipProcesses) {
    const scratch = mkdtempSync(join(tmpdir(), 'kopt-doctor-'));
    try {
      const env: Record<string, string> = { KOPT_HOME: join(scratch, 'home'), KOPT_CACHE_DIR: join(scratch, 'cache'), KOPT_TELEMETRY: '0', KOPT_INDEX_ON_START: '0', KOPT_LEGACY_WORKSPACE_HOOKS: '0' };
      const base = minimalEnv(h);
      const configured = configuredHooks(h);
      const fallback = hookCommandLine(resolveKoptCommand({ h }), 'global');
      const command = configured[0]?.pre ?? fallback;
      const runEnv = { ...base, ...env };
      const pathNote = h.platform === 'win32' ? 'system PATH only' : 'PATH=/usr/bin:/bin';
      const session = `kopt-doctor-${process.pid}`;
      const allowEvent = { hook_event_name: 'PreToolUse', session_id: session, cwd: scratch, tool_name: 'grep_search', tool_input: { query: 'kopt' } };
      const allow = await runHookCommand(command, allowEvent, { cwd: scratch, env: runEnv, timeoutMs });
      const silent = allow.code === 0 && !allow.stdout && !allow.stderr;
      add({
        id: 'hook-allow',
        status: silent ? 'ok' : 'fail',
        message: silent
          ? `hook allow path: exit 0, no output (${allow.ms} ms, ${pathNote}): ${command}`
          : `hook allow path (${pathNote}): exit ${allow.code ?? allow.error}, stdout ${JSON.stringify(allow.stdout.slice(0, 120))}, stderr ${JSON.stringify(allow.stderr.slice(0, 160))}: ${command}`,
        fix: silent ? undefined : 'any output on the allow path intercepts tool calls in Kiro: re-run kopt setup (absolute paths), then kopt doctor',
      });
      // big enough in tokens for the big-read rule whatever the config (~60 KB)
      const big = join(scratch, 'big.txt');
      writeFileSync(big, Array.from({ length: 1500 }, (_, i) => `line ${i}: lorem ipsum dolor sit amet, consectetur adipiscing`).join('\n') + '\n');
      const blocked = await runHookCommand(command, { hook_event_name: 'PreToolUse', session_id: session, cwd: scratch, tool_name: 'read_file', tool_input: { path: 'big.txt' } }, { cwd: scratch, env: runEnv, timeoutMs });
      const blockOk = blocked.code === 2 && /kopt/.test(blocked.stderr) && !blocked.stdout;
      add({
        id: 'hook-block',
        status: blockOk ? 'ok' : 'fail',
        message: blockOk ? `hook block path: exit 2 with a one-line reason (${blocked.ms} ms)` : `hook block path: exit ${blocked.code ?? blocked.error}, expected 2 (stderr ${JSON.stringify(blocked.stderr.slice(0, 160))})`,
        fix: blockOk ? undefined : 're-run kopt setup',
      });
      // Stop: in Kiro IDE 1.x a Stop hook that exits 1 means "continue the agent" (with no limit)
      const stops = configured.filter((c) => c.stop).map((c) => ({ cmd: c.stop!, label: c.from.endsWith(join('agents', 'kopt.json')) ? 'CLI agent' : 'global' }));
      const seenStop = new Set<string>();
      for (const { cmd: stopCmd, label } of stops.length ? stops : [{ cmd: command, label: 'global' }]) {
        if (seenStop.has(stopCmd)) continue;
        seenStop.add(stopCmd);
        const stop = await runHookCommand(stopCmd, { hook_event_name: 'Stop', session_id: session, cwd: scratch }, { cwd: scratch, env: runEnv, timeoutMs });
        const stopOk = stop.code === 0 && !stop.stdout;
        add({
          id: 'hook-stop',
          status: stopOk ? 'ok' : 'fail',
          message: stopOk ? `hook stop path (${label}): exit 0 (${stop.ms} ms)` : `hook stop path (${label}): exit ${stop.code ?? stop.error}, expected 0 (a non-zero Stop hook makes Kiro IDE continue the agent): ${stopCmd}`,
          fix: stopOk ? undefined : 're-run kopt setup',
        });
      }
      // the CLI 2.x agent's governor command, when it differs from the global one
      for (const c of configured.slice(1)) {
        if (c.pre === command) continue;
        const r = await runHookCommand(c.pre, allowEvent, { cwd: scratch, env: runEnv, timeoutMs });
        const ok = r.code === 0 && !r.stdout && !r.stderr;
        add({
          id: 'hook-agent',
          status: ok ? 'ok' : 'fail',
          message: ok ? `CLI agent hook: exit 0, no output (${r.ms} ms)` : `CLI agent hook (${pathNote}): exit ${r.code ?? r.error}, stderr ${JSON.stringify(r.stderr.slice(0, 160))}: ${c.pre}`,
          fix: ok ? undefined : 're-run kopt setup',
        });
      }
      if (mcp.entry) {
        mkdirSync(join(scratch, 'home'), { recursive: true });
        add(await mcpCheck(mcp.entry, scratch, base, env, timeoutMs, pathNote));
      }
    } finally {
      // Windows: the MCP server child may still be exiting (its cwd and files are in `scratch`); a leftover temp dir
      // must not turn the report into a crash.
      try {
        rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch {
        // temp dir: best effort
      }
    }
  }

  // Legacy IDE workspace hooks + index status for the current folder
  if (o.projectChecks === false) return { checks, surfaces, ok: !checks.some((c) => c.status === 'fail') };
  const cwd = o.cwd ?? process.cwd();
  if (plan.legacyWorkspace) {
    const root = findProjectRoot(cwd);
    const legacy = readText(join(root, '.kiro', 'hooks', 'kopt-prompt.kiro.hook'));
    if (!isUnsafeRoot(root)) {
      add({
        id: 'legacy-hooks',
        status: legacy ? 'ok' : 'warn',
        message: `${root}: IDE 0.x prompt hook ${legacy ? 'present' : 'not written yet'}`,
        fix: legacy ? undefined : 'it is written when the kopt MCP server starts in this workspace (open it in Kiro)',
      });
    }
  }
  add(await indexStatus(cwd));

  return { checks, surfaces, ok: !checks.some((c) => c.status === 'fail') };
}

export function formatChecks(checks: Check[]): string {
  return checks.map((c) => `${c.status.padEnd(4)}  ${c.message}${c.fix ? `  -> ${c.fix}` : ''}`).join('\n');
}
