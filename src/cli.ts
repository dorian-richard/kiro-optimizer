#!/usr/bin/env node
// kopt CLI. The package's bin is dist/bin.js, which silences Node's SQLite ExperimentalWarning before importing
// this file. Commands lazy-import what they need: `kopt hook` runs on every Kiro tool call and must start fast,
// so it (and `bench`, which owns its argv) bypass commander entirely.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { KoptConfig } from './core/config.js';
import { findProjectRoot } from './core/config.js';
import type { Modules } from './mcp/modules.js';
import type { ToolName } from './mcp/tools.js';

const VERSION = '0.1.0';

const modules = async (): Promise<Modules> => (await import('./mcp/modules.js')).defaultModules;

/** Repo root: KOPT_ROOT, else nearest ancestor with .git or a per-project kopt index (never above $HOME). */
function findRoot(start: string = process.cwd()): string {
  if (process.env.KOPT_ROOT) return resolve(process.env.KOPT_ROOT);
  return findProjectRoot(start);
}

async function config(root?: string): Promise<KoptConfig> {
  const { loadConfig } = await import('./core/config.js');
  return loadConfig(root ? resolve(root) : findRoot());
}

function write(stream: NodeJS.WriteStream, text: string | undefined): Promise<void> {
  return new Promise((r) => (text ? stream.write(text, () => r()) : r()));
}

/** Flush, then exit: stray handles (timers, sockets) in sibling modules must not keep one-shot commands alive. */
async function finish(stdout: string | undefined, code = 0): Promise<never> {
  await write(process.stdout, stdout ? (stdout.endsWith('\n') ? stdout : stdout + '\n') : undefined);
  process.exit(code);
}

function fail(err: unknown): Promise<never> {
  process.stderr.write(`kopt: ${(err as Error)?.message ?? err}\n`);
  if (process.env.KOPT_DEBUG && (err as Error)?.stack) process.stderr.write(`${(err as Error).stack}\n`);
  process.exit(1);
}

function readStdin(timeoutMs: number): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolveText) => {
    const chunks: Buffer[] = [];
    const done = () => resolveText(Buffer.concat(chunks).toString('utf8'));
    const timer = setTimeout(done, timeoutMs);
    timer.unref();
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.once('end', () => {
      clearTimeout(timer);
      done();
    });
    process.stdin.once('error', () => {
      clearTimeout(timer);
      done();
    });
  });
}

export interface HookArgs {
  event?: string;
  source?: string;
  legacy: boolean;
}

/** `kopt hook [event] [--source <name>] [--legacy]`. */
export function parseHookArgs(argv: string[]): HookArgs {
  const out: HookArgs = { legacy: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--legacy') out.legacy = true;
    else if (a === '--source') out.source = argv[++i];
    else if (a.startsWith('--source=')) out.source = a.slice('--source='.length);
    else if (!a.startsWith('-') && !out.event) out.event = a;
  }
  return out;
}

/**
 * Kiro command hook: event JSON on stdin (`kopt hook [EventName] [--source s] [--legacy]`; the name fills a missing
 * hook_event_name). `--legacy` = Kiro IDE 0.x `.kiro.hook` runCommand: no stdin payload (Kiro leaves the pipe open),
 * the data is in USER_PROMPT. Exit 2 + stderr blocks; any internal error -> exit 0 so a kopt bug never breaks the
 * user's session. Nothing is printed on the allow path. KOPT_HOOKS=0 disables all hooks.
 */
async function hookMain(argv: string[]): Promise<void> {
  setTimeout(() => process.exit(0), 20_000).unref();
  const args = parseHookArgs(argv);
  const eventName = args.event;
  let outcome: { exitCode: 0 | 2; stdout?: string; stderr?: string } = { exitCode: 0 };
  let cfg: KoptConfig | undefined;
  let event: Record<string, unknown> | undefined;
  let hooks: Awaited<ReturnType<Modules['hooks']>> | undefined;
  try {
    if (process.env.KOPT_HOOKS === '0') return process.exit(0);
    if (args.legacy) {
      if (!eventName) throw new Error('kopt hook --legacy needs the event name');
      const { legacyEvent } = await import('./hooks/index.js');
      event = legacyEvent(eventName) as Record<string, unknown>;
    } else {
      const raw = (await readStdin(5000)).trim();
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('hook event must be a JSON object');
      event = parsed as Record<string, unknown>;
    }
    if (args.source) event._kopt_source = args.source;
    if (!event.hook_event_name && eventName) event.hook_event_name = eventName;
    if (!event.hook_event_name) throw new Error('hook event has no hook_event_name');
    const { loadConfig } = await import('./core/config.js');
    hooks = await (await modules()).hooks();
    // an invalid config file is logged to hook-errors.log: any output on the allow path intercepts the tool call
    const onWarning = (hooks as { hookWarningSink?: () => (m: string) => void }).hookWarningSink?.() ?? (() => {});
    cfg = loadConfig(findRoot(typeof event.cwd === 'string' && event.cwd && existsSync(event.cwd) ? event.cwd : process.cwd()), { onWarning });
    const out = await hooks.handleHook(event as Parameters<typeof hooks.handleHook>[0], cfg);
    if (out && (out.exitCode === 0 || out.exitCode === 2)) outcome = out;
  } catch (err) {
    try {
      (hooks as { logHookError?: (c: unknown, e: unknown, ev: unknown) => void } | undefined)?.logHookError?.(cfg, err, event);
    } catch {
      // ignore
    }
    if (process.env.KOPT_DEBUG) process.stderr.write(`kopt hook: ${(err as Error)?.message ?? err}\n`);
    outcome = { exitCode: 0 };
  }
  await write(process.stdout, outcome.stdout);
  await write(process.stderr, outcome.stderr && !outcome.stderr.endsWith('\n') ? outcome.stderr + '\n' : outcome.stderr);
  // Stop never blocks: in Kiro IDE 1.x a non-zero Stop exit means "continue the agent"
  const stopEvent = /^(stop|agentstop|sessionend)$/i.test(String(event?.hook_event_name ?? eventName ?? '').replace(/[^A-Za-z]/g, ''));
  process.exit(stopEvent ? 0 : outcome.exitCode);
}

async function benchMain(argv: string[]): Promise<void> {
  try {
    const { runBenchCli } = await (await modules()).bench();
    await runBenchCli(argv);
  } catch (err) {
    await fail(err);
  }
}

function progressPrinter(label: string): ((done: number, total: number) => void) & { end(): void } {
  let last = 0;
  let shown = false;
  const fn = ((done: number, total: number) => {
    if (!process.stderr.isTTY) return;
    const now = Date.now();
    if (now - last < 150 && done < total) return;
    last = now;
    shown = true;
    process.stderr.write(`\r${label} ${done}/${total || '?'} files`);
  }) as ((done: number, total: number) => void) & { end(): void };
  fn.end = () => {
    if (shown) process.stderr.write('\n');
  };
  return fn;
}

/** Exit status of a tool run: 1 on a tool error; for `kopt run`, the command's own exit code (1-255). */
export function toolExitCode(res: { isError?: boolean; result?: { meta?: Record<string, unknown> } }): number {
  if (res.isError) return 1;
  const code = res.result?.meta?.exitCode;
  if (typeof code !== 'number' || code === 0) return 0;
  return Number.isInteger(code) && code > 0 && code < 256 ? code : 1;
}

async function tool(name: ToolName, args: Record<string, unknown>, root?: string): Promise<void> {
  const cfg = await config(root);
  const { runToolOnce } = await import('./mcp/local.js');
  const progress = progressPrinter('indexing');
  const res = await runToolOnce(cfg, name, args, { onProgress: progress });
  progress.end();
  await finish(res.text, toolExitCode(res));
}

/**
 * One argument = a shell command line as is (`kopt run "npm test | tail"`); several = argv, quoted for the shell
 * kopt_run will use (bash/sh, PowerShell or cmd) so `kopt run sh -c 'a; b'` reaches it as typed.
 */
const commandLine = async (argv: string[]): Promise<string> => {
  if (argv.length === 1) return argv[0];
  const { joinCommand } = await import('./compress/runner.js');
  return joinCommand(argv);
};

const int = (v: string) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`not a number: ${v}`);
  return Math.trunc(n);
};
const list = (v?: string) => (v ? v.split(/[\s,]+/).filter(Boolean) : undefined);

/** Store.close() throws on an already-closed handle. */
function closeQuietly(store: { close(): void }): void {
  try {
    store.close();
  } catch {
    // already closed
  }
}

function fmtStats(s: { filesSeen: number; filesIndexed: number; filesUnchanged: number; filesDeleted: number; symbols: number; refs: number; durationMs: number }): string {
  return (
    `indexed ${s.filesSeen} files (${s.filesIndexed} parsed, ${s.filesUnchanged} unchanged, ${s.filesDeleted} deleted)` +
    ` · ${s.symbols} symbols · ${s.refs} refs · ${(s.durationMs / 1000).toFixed(1)}s`
  );
}

async function cmdIndex(o: { root?: string; refresh?: boolean; ifIdle?: boolean }): Promise<void> {
  const cfg = await config(o.root);
  const [{ Store }, { indexPath }, mods] = await Promise.all([import('./store/store.js'), import('./core/config.js'), modules()]);
  const idx = await mods.indexer();
  const progress = progressPrinter('indexing');
  const store = Store.open(indexPath(cfg), { root: cfg.root });
  try {
    const onPhase = (p: { phase: string; holder?: number }) => {
      if (p.phase === 'wait') process.stderr.write(`kopt: another kopt process${p.holder ? ` (pid ${p.holder})` : ''} is indexing ${cfg.root}; waiting for it\n`);
    };
    const opts = { config: cfg, onProgress: progress, onPhase, lock: o.ifIdle ? ('skip' as const) : ('wait' as const) };
    const stats = o.refresh ? await idx.refreshIndex(store, opts) : await idx.indexRepo(store, opts);
    progress.end();
    closeQuietly(store);
    if ((stats as { locked?: boolean }).locked) return await finish('another kopt process is indexing this project: nothing to do');
    await finish(fmtStats(stats));
  } finally {
    closeQuietly(store);
  }
}

async function cmdCredits(o: { root?: string }): Promise<void> {
  const cfg = await config(o.root);
  const tel = await (await modules()).telemetry();
  // The credits collector advances its cursor: what it returns must be recorded now or it is lost.
  const events = tel.collectKiroCredits(cfg);
  for (const e of events) tel.record(e, cfg);
  const total = events.reduce((n, e) => n + (e.credits ?? 0), 0);
  const days = new Map<string, { credits: number; sessions: Set<string> }>();
  for (const e of events) {
    const day = new Date(e.ts).toISOString().slice(0, 10);
    const d = days.get(day) ?? { credits: 0, sessions: new Set<string>() };
    d.credits += e.credits ?? 0;
    if (e.session) d.sessions.add(e.session);
    days.set(day, d);
  }
  const sessions = new Set(events.map((e) => e.session).filter(Boolean)).size;
  const lines = [`collected ${events.length} new credit events · ${sessions} sessions · ${total.toFixed(2)} credits (full history: kopt stats)`];
  for (const [day, d] of [...days].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 30)) {
    lines.push(`${day}  ${d.credits.toFixed(2).padStart(9)} cr  ${d.sessions.size} sessions`);
  }
  await finish(lines.join('\n'));
}


/** `~/…` display form of a path under the home dir (case-insensitive on Windows). */
function homeRel(p: string): string {
  const home = homedir().replace(/[\\/]+$/, '');
  if (!home) return p;
  const win = process.platform === 'win32';
  const head = p.slice(0, home.length);
  const same = win ? head.toLowerCase() === home.toLowerCase() : head === home;
  return same && (p.length === home.length || /[\\/]/.test(p[home.length])) ? '~' + p.slice(home.length) : p;
}

async function cmdSetup(o: { surface?: string; global?: boolean; dryRun?: boolean; force?: boolean; explorerModel?: string; doctor?: boolean }): Promise<void> {
  const kiro = await import('./kiro/index.js');
  const surface = o.surface as 'ide' | 'cli' | 'all' | undefined;
  process.stderr.write('kopt setup: configuring Kiro for every project…\n');
  const r = await kiro.setupUser({ surface, global: o.global, dryRun: o.dryRun, force: o.force, explorerModel: o.explorerModel });
  if (r.refused) await finish(`fail  ${r.refused}`, 1);
  const lines: string[] = [];
  if (r.install.action !== 'not-needed') lines.push(`${r.install.action === 'failed' ? 'warn' : 'ok  '}  ${r.install.detail}`);
  for (const f of r.written) lines.push(`${o.dryRun ? 'would write' : 'wrote'} ${homeRel(f)}`);
  for (const n of r.notes) lines.push(`note  ${n}`);
  let failed = r.install.action === 'failed';
  if (o.doctor !== false && !o.dryRun) {
    // user-level checks only: the folder setup was started from is not a project
    const report = await kiro.runDoctor({ skipProcesses: false, projectChecks: false });
    const bad = report.checks.filter((c) => c.status !== 'ok');
    lines.push(`doctor: ${report.checks.length - bad.length} ok, ${bad.filter((c) => c.status === 'warn').length} warn, ${bad.filter((c) => c.status === 'fail').length} fail`);
    if (bad.length) lines.push(kiro.formatChecks(bad));
    failed ||= !report.ok;
  }
  const { cacheRoot } = await import('./core/config.js');
  const where = r.surfaces.ide || r.surfaces.cli ? kiro.describeSurfaces(r.surfaces) : 'Kiro (no install detected yet: every surface configured)';
  lines.push('');
  lines.push(
    failed
      ? `kopt setup finished with problems (see above); fix them, then run kopt doctor.`
      : o.dryRun
        ? `dry run for ${where}: nothing was written.`
        : `kopt is active for every project in ${r.surfaces.ide || r.surfaces.cli ? where : 'Kiro'}. Restart Kiro.`,
  );
  lines.push(`Indexes are built in the background on first use and kept in ${homeRel(cacheRoot())}; nothing is written into your projects.`);
  if (r.hooks.legacyWorkspace) lines.push(`Kiro IDE ${r.surfaces.ide!.version} is 0.x: prompt pointers only, the full governor needs Kiro IDE 1.x.`);
  lines.push('Check: kopt doctor · Savings: kopt stats · Remove: kopt uninstall');
  await finish(lines.join('\n'), failed ? 1 : 0);
}

async function cmdDoctor(o: { root?: string; quick?: boolean }): Promise<void> {
  const kiro = await import('./kiro/index.js');
  const report = await kiro.runDoctor({ cwd: o.root ? resolve(o.root) : process.cwd(), skipProcesses: !!o.quick });
  await finish(kiro.formatChecks(report.checks), report.ok ? 0 : 1);
}

async function cmdUninstall(o: { keepIndex?: boolean; purge?: boolean; dryRun?: boolean; root?: string; user?: boolean; workspace?: boolean; force?: boolean }): Promise<void> {
  const kiro = await import('./kiro/index.js');
  const scope = o.user ? 'user' : o.workspace ? 'workspace' : 'all';
  const root = o.root ? resolve(o.root) : findRoot();
  const r = await kiro.uninstallKiro({ root, scope, keepIndex: o.keepIndex, purge: o.purge, dryRun: o.dryRun, force: o.force });
  const lines = [
    ...r.notes,
    ...(r.removed ?? []).map((f) => `${o.dryRun ? 'would remove' : 'removed'} ${homeRel(f)}`),
    ...r.written.map((f) => `${o.dryRun ? 'would update' : 'updated'} ${homeRel(f)}`),
  ];
  if (!lines.length) lines.push('nothing to remove: kopt is not configured here');
  if (!o.dryRun && scope !== 'workspace') lines.push('To remove the command itself: npm uninstall -g kiro-optimizer');
  await finish(lines.join('\n'));
}

async function main(): Promise<void> {
  const { Command, Option } = await import('commander');
  const program = new Command('kopt')
    .description('KiroOptimizer: budgeted code intelligence, compact command output and session guards for Kiro')
    .version(VERSION)
    .enablePositionalOptions()
    .showHelpAfterError();

  const wrap =
    <A extends unknown[]>(fn: (...a: A) => Promise<void>) =>
    async (...a: A) => {
      try {
        await fn(...a);
      } catch (err) {
        await fail(err);
      }
    };

  program
    .command('index')
    .description('build or update the local index')
    .option('--root <dir>', 'repo root (default: nearest git root)')
    .option('--refresh', 'only re-index files changed since the last run')
    .option('--if-idle', 'do nothing when another kopt process is indexing this project (default: wait for it)')
    .action(wrap(cmdIndex));

  program
    .command('mcp')
    .description('run the MCP server over stdio (what Kiro launches); without --root it serves the project Kiro opens')
    .option('--root <dir>', 'fixed repo root (default: from the MCP client roots, KOPT_ROOT, then the git root of the cwd)')
    .action(
      wrap(async (o: { root?: string }) => {
        const local = await import('./mcp/local.js');
        if (o.root) await local.serveStdio(await config(o.root));
        else {
          const { loadConfig } = await import('./core/config.js');
          await local.serveStdioAuto(loadConfig(process.cwd()));
        }
        process.exit(0);
      }),
    );

  program
    .command('find')
    .description('search code (kopt_find)')
    .argument('<query...>')
    .option('--pack', 'include bodies of the best symbols')
    .option('--max-tokens <n>', 'token budget', int)
    .option('--path <prefix>', 'restrict to a path prefix or glob')
    .option('--kinds <list>', 'symbol kinds, e.g. class,function (function includes methods; class includes structs and records)')
    .option('--limit <n>', 'max hits', int)
    .option('--root <dir>')
    .action(
      wrap(async (q: string[], o: { pack?: boolean; maxTokens?: number; path?: string; kinds?: string; limit?: number; root?: string }) =>
        tool('kopt_find', { query: q.join(' '), mode: o.pack ? 'pack' : undefined, maxTokens: o.maxTokens, path: o.path, kinds: list(o.kinds), limit: o.limit }, o.root),
      ),
    );

  program
    .command('read')
    .description('read a symbol, file, range, directory (outline) or kopt run log (kopt_read)')
    .argument('<target>', '#handle, Class.method, path, path:start-end, a directory, or a kopt run log handle (o3fad54[:a-b])')
    .addOption(new Option('--mode <mode>').choices(['body', 'skeleton', 'card', 'outline']))
    .option('--focus <words>', '(outline) rank files/symbols relevant to these words first')
    .option('--grep <regex>', '(log) filter lines (with context)')
    .option('--start <line>', '(log) first line', int)
    .option('--end <line>', '(log) last line', int)
    .option('--max-tokens <n>', 'token budget', int)
    .option('--root <dir>')
    .action(
      wrap(async (target: string, o: { mode?: string; focus?: string; grep?: string; start?: number; end?: number; maxTokens?: number; root?: string }) =>
        tool('kopt_read', { target, mode: o.mode, focus: o.focus, grep: o.grep, startLine: o.start, endLine: o.end, maxTokens: o.maxTokens }, o.root),
      ),
    );

  program
    .command('outline')
    .description('structure map of the repo, a directory or a file (kopt_outline; also kopt read <dir>)')
    .argument('[path]')
    .option('--focus <words>', 'rank files/symbols relevant to these words first')
    .option('--max-tokens <n>', 'token budget', int)
    .option('--root <dir>')
    .action(wrap(async (path: string | undefined, o: { focus?: string; maxTokens?: number; root?: string }) => tool('kopt_outline', { path, focus: o.focus, maxTokens: o.maxTokens }, o.root)));

  program
    .command('refs')
    .description('callers / callees of a symbol (kopt_refs)')
    .argument('<target>')
    .addOption(new Option('--direction <dir>').choices(['in', 'out', 'both']))
    .addOption(new Option('--depth <n>').choices(['1', '2']))
    .option('--max-tokens <n>', 'token budget', int)
    .option('--root <dir>')
    .action(
      wrap(async (target: string, o: { direction?: string; depth?: string; maxTokens?: number; root?: string }) =>
        tool('kopt_refs', { target, direction: o.direction, depth: o.depth ? Number(o.depth) : undefined, maxTokens: o.maxTokens }, o.root),
      ),
    );

  program
    .command('run')
    .description('run a command and print compact output (kopt_run); options go before the command')
    .argument('<command...>')
    .option('--cwd <dir>', 'working directory relative to the repo root')
    .option('--timeout <sec>', 'timeout in seconds', int)
    .option('--max-tokens <n>', 'token budget', int)
    .option('--fresh', 'bypass the identical-command cache')
    .option('--root <dir>')
    .passThroughOptions()
    .action(
      wrap(async (cmd: string[], o: { cwd?: string; timeout?: number; maxTokens?: number; fresh?: boolean; root?: string }) =>
        tool('kopt_run', { command: await commandLine(cmd), cwd: o.cwd, timeoutSec: o.timeout, maxTokens: o.maxTokens, fresh: o.fresh }, o.root),
      ),
    );

  program
    .command('expand')
    .description('show more of a kopt_run output (kopt_expand; also kopt read <handle> --grep)')
    .argument('<handle>')
    .option('--grep <regex>', 'filter lines (with context)')
    .option('--start <line>', 'first line', int)
    .option('--end <line>', 'last line', int)
    .option('--max-tokens <n>', 'token budget', int)
    .option('--root <dir>')
    .action(
      wrap(async (handle: string, o: { grep?: string; start?: number; end?: number; maxTokens?: number; root?: string }) =>
        tool('kopt_expand', { handle, grep: o.grep, startLine: o.start, endLine: o.end, maxTokens: o.maxTokens }, o.root),
      ),
    );

  program
    .command('setup')
    .description('one-time setup: install kopt globally if needed and configure Kiro IDE and Kiro CLI for every project')
    .addOption(new Option('--surface <surface>', 'configure these surfaces whatever is detected').choices(['ide', 'cli', 'all']))
    // --global first: declared after it, --no-global would make `global` default to true (commander)
    .option('--global', 'install kopt globally with npm even from a checkout')
    .option('--no-global', 'do not install kopt globally with npm (from npx, a private copy goes to ~/.kopt/runtime)')
    .option('--dry-run', 'show what would be written')
    .option('--force', 'overwrite kopt files edited by hand and make kopt the Kiro CLI default agent (your mcp.json fields are kept)')
    .option('--no-doctor', 'skip the final checks')
    .option('--explorer-model <id>', 'model for the read-only explorer agent')
    .action(wrap(cmdSetup));

  program
    .command('doctor')
    .description('check Node, PATH, Kiro surfaces, config files, that hooks run silently, the MCP server and the index')
    .option('--root <dir>', 'folder whose index status to report (default: cwd)')
    .option('--quick', 'skip the checks that start processes (hook, MCP server)')
    .action(wrap(cmdDoctor));

  program
    .command('uninstall')
    .description('remove what kopt setup / kopt init wrote (and the index caches)')
    .option('--keep-index', 'keep the index caches')
    .option('--purge', 'also delete ~/.kopt (telemetry, governor state)')
    .option('--user', 'only the user-level configuration')
    .option('--workspace', 'only the files kopt init wrote in this project')
    .option('--force', 'also remove kopt files you edited since kopt wrote them (kept and listed otherwise)')
    .option('--dry-run', 'show what would be removed')
    .option('--root <dir>')
    .action(wrap(cmdUninstall));

  program
    .command('init')
    .description('optional per-project install: Kiro files under <root>/.kiro (kopt setup already covers every project)')
    .option('--user', 'install for the user (~/.kiro): same files as kopt setup, without the npm install')
    .option('--dry-run', 'show what would be written')
    .option('--force', 'overwrite existing files')
    .option('--explorer-model <id>', 'model for the read-only explorer agent')
    .option('--root <dir>')
    .action(
      wrap(async (o: { user?: boolean; dryRun?: boolean; force?: boolean; explorerModel?: string; root?: string }) => {
        const { installKiro } = await (await modules()).kiro();
        const r = await installKiro({
          root: o.root ? resolve(o.root) : findRoot(),
          scope: o.user ? 'user' : 'workspace',
          explorerModel: o.explorerModel,
          dryRun: o.dryRun,
          force: o.force,
        });
        const lines = [
          ...r.written.map((f) => `${o.dryRun ? 'would write' : 'wrote'} ${f}`),
          ...r.skipped.map((f) => `skipped ${f} (exists; --force to overwrite)`),
          ...r.notes,
        ];
        await finish(lines.join('\n') || 'nothing to do');
      }),
    );

  program
    .command('hook')
    .description('Kiro command hook entry point (reads the event JSON on stdin)')
    .argument('[event]', 'event name used when the payload has no hook_event_name')
    .option('--source <name>', 'which hook configuration runs it (duplicate events from two sources are handled once)')
    .option('--legacy', 'Kiro IDE 0.x .kiro.hook invocation (data in USER_PROMPT, no stdin)')
    .action(() => hookMain(process.argv.slice(process.argv.indexOf('hook') + 1))); // normally short-circuited before commander loads

  program
    .command('stats')
    .description('token / credit savings report from local telemetry')
    .option('--days <n>', 'window in days', int)
    .option('--root <dir>')
    .action(
      wrap(async (o: { days?: number; root?: string }) => {
        const cfg = await config(o.root);
        const tel = await (await modules()).telemetry();
        await finish(tel.stats(cfg, { days: o.days }));
      }),
    );

  program.command('credits').description('collect Kiro CLI session credits and print a summary').option('--root <dir>').action(wrap(cmdCredits));

  program
    .command('bench')
    .description('benchmarks (see kopt bench --help)')
    .allowUnknownOption()
    .helpOption(false)
    .argument('[args...]')
    .action(() => benchMain(process.argv.slice(process.argv.indexOf('bench') + 1)));

  await program.parseAsync(process.argv);
}

const command = process.argv[2];
if (command === 'hook') void hookMain(process.argv.slice(3));
else if (command === 'bench') void benchMain(process.argv.slice(3));
else void main().catch(fail);
