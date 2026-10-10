// Child-process runner: the platform's shell, merged stdout+stderr in arrival order (line granularity),
// noise-reducing environment, timeout that kills the whole process tree, bounded capture (head + tail).
//
// Shells: POSIX -> bash when available (agents write bash), else sh. Windows -> PowerShell, like Kiro's own
// shell tool there (pwsh 7 when on PATH, it accepts `&&`; else Windows PowerShell 5.1), else cmd.exe.
// KOPT_SHELL overrides (path or name: bash, sh, pwsh, powershell, cmd).

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { posix as posixPath, win32 as winPath } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export const DEFAULT_TIMEOUT_SEC = 600;
export const MAX_CAPTURE_CHARS = 50 * 1024 * 1024;
/** A line longer than this without a newline is force-split (protects memory on binary/minified output). */
const MAX_PENDING_CHARS = 1024 * 1024;
/** Windows command lines are limited to 32767 chars: longer encoded scripts fall back to -Command. */
const MAX_ENCODED_ARG = 30_000;

export interface ExecOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  /** Extra environment on top of process.env + the noise reducers. */
  env?: Record<string, string | undefined>;
  maxCaptureChars?: number;
  /** Cancels the command (MCP request cancelled): the process tree is killed. */
  signal?: AbortSignal;
}

export interface ExecResult {
  output: string;
  exitCode: number;
  signal?: string;
  timedOut: boolean;
  durationMs: number;
  /** Characters received (stdout + stderr). */
  totalChars: number;
  /** Characters dropped from the middle because of the capture cap. */
  droppedChars: number;
  spawnError?: string;
  /** Stopped through ExecOptions.signal. */
  cancelled?: boolean;
}

/**
 * process.env without any KOPT_* variable (names compared case-insensitively, as Windows does). They are kopt's own
 * state (KOPT_SESSION, KOPT_ROOT, KOPT_DATA_DIR, KOPT_HOME...): a command started by kopt_run, such as a test suite
 * that itself runs kopt, must see the developer's environment, not the agent session that launched it. The only
 * KOPT_* variable a command gets is KOPT_RUN=1, set by quietEnv.
 */
export function inheritedEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!k.toUpperCase().startsWith('KOPT_')) out[k] = v;
  return out;
}

/** Environment that makes tools print less: no colors, no progress bars, no interactive prompts, no pagers. */
export function quietEnv(extra?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...inheritedEnv(),
    CI: '1',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    TERM: 'dumb',
    CLICOLOR: '0',
    PY_COLORS: '0',
    PYTHONUNBUFFERED: '1',
    PIP_PROGRESS_BAR: 'off',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    CARGO_TERM_COLOR: 'never',
    CARGO_TERM_PROGRESS_WHEN: 'never',
    npm_config_progress: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    npm_config_color: 'false',
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    DOTNET_NOLOGO: '1',
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
    MSBUILDTERMINALLOGGER: 'off',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    // Lets hooks recognise commands launched by kopt itself (e.g. not to block them as duplicates).
    KOPT_RUN: '1',
  };
  // Maven >= 3.9 reads MAVEN_ARGS: batch mode + no transfer progress removes thousands of download lines.
  if (!process.env.MAVEN_ARGS) env.MAVEN_ARGS = '--batch-mode --no-transfer-progress';
  // Python writes pipes in the locale code page on Windows (cp1252: non-ASCII test names crash the run).
  if (!process.env.PYTHONIOENCODING) env.PYTHONIOENCODING = 'utf-8';
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

// ---------------------------------------------------------------------------------------------------------------
// Shell selection (pure: platform, environment and file checks are injectable for tests)

export type ShellKind = 'posix' | 'powershell' | 'cmd';

export interface ShellEnvironment {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** existsSync replacement (tests). */
  exists?: (path: string) => boolean;
}

export interface ShellCommand {
  file: string;
  args: string[];
  /** Pass args to CreateProcess as is (cmd.exe /s /c "..."); Windows only. */
  verbatim: boolean;
  kind: ShellKind;
}

function envGet(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  // process.env is case-insensitive on Windows; plain objects (tests, copies) are not.
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

/** Shell family from a path or a bare name (`C:\...\pwsh.exe`, `/usr/bin/bash`, `cmd`). */
export function shellKindOf(file: string): ShellKind {
  const name = file.trim().replace(/^["']|["']$/g, '').split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, '');
  if (name === 'pwsh' || name === 'powershell' || name === 'pwsh-preview') return 'powershell';
  if (name === 'cmd') return 'cmd';
  return 'posix';
}

/** First `name` found in PATH, or undefined. */
export function findOnPath(name: string, o: ShellEnvironment = {}): string | undefined {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const exists = o.exists ?? existsSync;
  const pathMod = platform === 'win32' ? winPath : posixPath;
  const dirs = (envGet(env, 'PATH') ?? '').split(platform === 'win32' ? ';' : ':');
  for (const raw of dirs) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!dir) continue;
    const candidate = pathMod.join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

/** The shell kopt_run uses on this machine (see the header comment). */
export function resolveShell(o: ShellEnvironment = {}): { file: string; kind: ShellKind } {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const exists = o.exists ?? existsSync;
  const forced = envGet(env, 'KOPT_SHELL')?.trim();
  if (forced) return { file: forced, kind: shellKindOf(forced) };
  if (platform === 'win32') {
    const pwsh = findOnPath('pwsh.exe', { platform, env, exists });
    if (pwsh) return { file: pwsh, kind: 'powershell' };
    const root = envGet(env, 'SystemRoot') ?? envGet(env, 'windir') ?? 'C:\\Windows';
    const winPs = winPath.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (exists(winPs)) return { file: winPs, kind: 'powershell' };
    const onPath = findOnPath('powershell.exe', { platform, env, exists });
    if (onPath) return { file: onPath, kind: 'powershell' };
    return { file: envGet(env, 'ComSpec') || 'cmd.exe', kind: 'cmd' };
  }
  const user = envGet(env, 'SHELL');
  if (user && /\/bash$/.test(user) && exists(user)) return { file: user, kind: 'posix' };
  for (const candidate of ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash']) {
    if (exists(candidate)) return { file: candidate, kind: 'posix' };
  }
  return { file: '/bin/sh', kind: 'posix' };
}

/**
 * The script PowerShell runs: quiet progress, UTF-8 output, then the command, then a process exit code that
 * follows shell conventions (the native command's code, 127 for an unknown command, 0/1 for cmdlets).
 * `-Command` alone would turn every native failure into exit 1. The setup fits on line 1, so PowerShell's
 * error positions (`Line | 2 | ...`) stay close to the command's own lines.
 */
export function powershellScript(command: string): string {
  return [
    [
      "$ErrorActionPreference = 'Continue'",
      "$ProgressPreference = 'SilentlyContinue'",
      'try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}',
      '$global:LASTEXITCODE = $null',
    ].join('; '),
    command,
    '$__koptOk = $?; $__koptCode = $global:LASTEXITCODE',
    'if ($__koptOk) { exit 0 }',
    'if ($__koptCode -is [int] -and $__koptCode -ne 0) { exit $__koptCode }',
    "$__koptErr = if ($Error.Count) { [string]$Error[0].FullyQualifiedErrorId } else { '' }",
    "if ($__koptErr -like 'CommandNotFoundException*') { exit 127 }",
    "if ($__koptCode -eq 0 -and $__koptErr -like 'NativeCommandError*') { exit 0 }",
    'exit 1',
  ].join('\n');
}

/** Executable + argv that run `command` through the selected shell. */
export function shellFor(command: string, o: ShellEnvironment = {}): ShellCommand {
  const platform = o.platform ?? process.platform;
  const { file, kind } = resolveShell(o);
  if (kind === 'cmd') return { file, args: ['/d', '/s', '/c', `"${command}"`], verbatim: true, kind };
  if (kind === 'powershell') {
    const script = powershellScript(command);
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive'];
    if (platform === 'win32') {
      // Process-scope only: lets npm.ps1 / gradlew.ps1 shims run under the default Restricted policy.
      args.push('-ExecutionPolicy', 'Bypass');
      // Base64 UTF-16LE: no quoting pitfalls between CreateProcess, Windows PowerShell 5.1 and pwsh.
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      if (encoded.length <= MAX_ENCODED_ARG) return { file, args: [...args, '-OutputFormat', 'Text', '-EncodedCommand', encoded], verbatim: false, kind };
    }
    return { file, args: [...args, '-Command', script], verbatim: false, kind };
  }
  return { file, args: ['-c', command], verbatim: false, kind };
}

/** Quote one argument for `kind` (used to turn `kopt run a b c` argv into a command line). */
export function quoteArg(arg: string, kind: ShellKind = resolveShell().kind): string {
  if (kind === 'powershell') {
    if (/^[A-Za-z0-9_\/.:=+\\-]+$/.test(arg) && !arg.startsWith('-')) return arg;
    return `'${arg.replace(/'/g, "''")}'`;
  }
  if (kind === 'cmd') {
    // `=`, `,` and `;` split batch-file parameters (npm.cmd, gradlew.bat): quote them too
    if (/^[A-Za-z0-9_\/.:@+\\-]+$/.test(arg)) return arg;
    return `"${arg.replace(/"/g, '""')}"`;
  }
  if (/^[A-Za-z0-9_\/.:=@%+,-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * argv -> one command line for `kind` (`kopt run -- a b c`). PowerShell needs the call operator when the program
 * itself had to be quoted (`& 'C:\Program Files\x\tool.exe' arg`), or it would read a string expression.
 */
export function joinCommand(argv: string[], kind: ShellKind = resolveShell().kind): string {
  const parts = argv.map((a) => quoteArg(a, kind));
  if (kind === 'powershell' && parts.length && parts[0] !== argv[0]) return `& ${parts.join(' ')}`;
  return parts.join(' ');
}

/** `taskkill /pid <pid> /T /F` on Windows (kills the whole tree); undefined on POSIX (process-group kill). */
export function treeKillCommand(pid: number, o: ShellEnvironment = {}): { file: string; args: string[] } | undefined {
  const platform = o.platform ?? process.platform;
  if (platform !== 'win32') return undefined;
  const env = o.env ?? process.env;
  const exists = o.exists ?? existsSync;
  const root = envGet(env, 'SystemRoot') ?? envGet(env, 'windir');
  const full = root ? winPath.join(root, 'System32', 'taskkill.exe') : undefined;
  return { file: full && exists(full) ? full : 'taskkill.exe', args: ['/pid', String(pid), '/T', '/F'] };
}

// ---------------------------------------------------------------------------------------------------------------
// Capture

/** Line-granular capture of both streams with a head + tail cap. */
class Capture {
  private head: string[] = [];
  private headChars = 0;
  private tail: string[] = [];
  private tailStart = 0;
  private tailChars = 0;
  droppedLines = 0;
  droppedChars = 0;
  totalChars = 0;

  constructor(private readonly headCap: number, private readonly tailCap: number) {}

  push(line: string): void {
    const n = line.length + 1;
    this.totalChars += n;
    if (this.tail.length === this.tailStart && this.headChars + n <= this.headCap) {
      this.head.push(line);
      this.headChars += n;
      return;
    }
    this.tail.push(line);
    this.tailChars += n;
    while (this.tailChars > this.tailCap && this.tailStart < this.tail.length) {
      const dropped = this.tail[this.tailStart];
      this.tail[this.tailStart++] = '';
      this.tailChars -= dropped.length + 1;
      this.droppedChars += dropped.length + 1;
      this.droppedLines++;
    }
    if (this.tailStart > 65536 && this.tailStart * 2 > this.tail.length) {
      this.tail = this.tail.slice(this.tailStart);
      this.tailStart = 0;
    }
  }

  text(): string {
    const tail = this.tail.slice(this.tailStart);
    const marker = this.droppedLines
      ? [`[kopt] … ${this.droppedLines} lines (${(this.droppedChars / 1048576).toFixed(1)} MB) dropped from the middle (capture cap) …`]
      : [];
    return [...this.head, ...marker, ...tail].join('\n');
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Process trees

/** Commands still running, killed if this process exits or is stopped first (no orphaned test runs). */
const active = new Set<number>();
let exitHookInstalled = false;
/** Signals that stop kopt (Kiro stopping the MCP server, Ctrl+C on `kopt run`, a closed terminal). */
const STOP_SIGNALS: NodeJS.Signals[] = process.platform === 'win32' ? ['SIGINT', 'SIGBREAK', 'SIGHUP'] : ['SIGTERM', 'SIGINT', 'SIGHUP'];
const signalHandlers = new Map<NodeJS.Signals, () => void>();

/** Kill every command started by execCapture that is still running (call on server/CLI shutdown). */
export function killActiveCommands(): void {
  // POSIX: a descendant may have left the command's process group (setsid/setpgid); list them before the
  // group kill re-parents the tree.
  const strays = process.platform !== 'win32' && active.size ? descendants(active) : [];
  // Synchronous on Windows: this also runs from the 'exit' handler, where nothing asynchronous completes.
  for (const pid of active) killTree(pid, 'SIGKILL', true);
  for (const pid of strays) killOne(pid, 'SIGKILL');
  active.clear();
  removeSignalHandlers();
}

/** POSIX: live descendants of `roots`, from one `ps` listing (empty when ps is unavailable). */
function descendants(roots: Set<number>): number[] {
  let listing: string;
  try {
    listing = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return [];
  }
  const children = new Map<number, number[]>();
  for (const line of listing.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)/.exec(line);
    if (!m) continue;
    const arr = children.get(Number(m[2])) ?? [];
    arr.push(Number(m[1]));
    children.set(Number(m[2]), arr);
  }
  const out: number[] = [];
  const queue = [...roots];
  const seen = new Set(queue);
  while (queue.length) {
    for (const c of children.get(queue.shift()!) ?? []) {
      if (seen.has(c) || c === process.pid) continue;
      seen.add(c);
      out.push(c);
      queue.push(c);
    }
  }
  return out;
}

/**
 * A command runs in its own process group (POSIX), so a signal that stops kopt does not reach it, and Node's
 * default action ends kopt without an 'exit' event: kill the trees first, then let the signal take its course.
 * Installed only while a command runs, so kopt's own signal behavior is unchanged otherwise.
 */
function installSignalHandlers(): void {
  for (const sig of STOP_SIGNALS) {
    if (signalHandlers.has(sig)) continue;
    const handler = () => {
      killActiveCommands();
      // Our listener replaced the default action; restore it unless someone else handles this signal.
      if (process.listenerCount(sig) === 0) {
        try {
          process.kill(process.pid, sig);
        } catch {
          process.exit(128 + ((osConstants.signals as Record<string, number>)[sig] ?? 1));
        }
      }
    };
    signalHandlers.set(sig, handler);
    try {
      process.on(sig, handler);
    } catch {
      signalHandlers.delete(sig); // signal not supported on this platform
    }
  }
}

function removeSignalHandlers(): void {
  for (const [sig, handler] of signalHandlers) process.removeListener(sig, handler);
  signalHandlers.clear();
}

function track(pid: number | undefined): void {
  if (!pid) return;
  active.add(pid);
  installSignalHandlers();
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', killActiveCommands);
  }
}

function untrack(pid: number | undefined): void {
  if (pid) active.delete(pid);
  if (!active.size) removeSignalHandlers();
}

/** Number of commands still running (tests). */
export function activeCommandCount(): number {
  return active.size;
}

function killTree(pid: number | undefined, signal: NodeJS.Signals, sync = false): void {
  if (!pid) return;
  const tk = treeKillCommand(pid);
  try {
    if (tk) {
      if (sync) spawnSync(tk.file, tk.args, { stdio: 'ignore', windowsHide: true, timeout: 5000 });
      else spawn(tk.file, tk.args, { stdio: 'ignore', windowsHide: true }).on('error', () => killOne(pid, signal));
    } else {
      // The command runs in its own process group (detached): a negative pid signals the whole group.
      process.kill(-pid, signal);
    }
  } catch {
    killOne(pid, signal);
  }
}

function killOne(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

export function execCapture(o: ExecOptions): Promise<ExecResult> {
  const cap = o.maxCaptureChars ?? MAX_CAPTURE_CHARS;
  const capture = new Capture(Math.floor(cap * 0.2), Math.ceil(cap * 0.8));
  const started = Date.now();
  const sh = shellFor(o.command);
  return new Promise((resolvePromise) => {
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let closeTimer: NodeJS.Timeout | undefined;

    const child = spawn(sh.file, sh.args, {
      cwd: o.cwd,
      env: quietEnv(o.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group on POSIX so a timeout can kill the command and everything it spawned. On Windows the
      // shell stays in this process's kill-on-close job object, and taskkill /T ends the whole tree (timeouts,
      // killActiveCommands on exit).
      detached: process.platform !== 'win32',
      windowsHide: true,
      windowsVerbatimArguments: sh.verbatim,
    });

    track(child.pid);
    const finish = (spawnError?: string) => {
      if (settled) return;
      settled = true;
      untrack(child.pid);
      o.signal?.removeEventListener('abort', onAbort);
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(closeTimer);
      flushAll();
      let code: number;
      if (timedOut) code = 124;
      else if (cancelled) code = 130;
      else if (spawnError) code = 127;
      else if (exitCode !== null) code = exitCode;
      else if (exitSignal) code = 128 + ((osConstants.signals as Record<string, number>)[exitSignal] ?? 1);
      else code = 1;
      resolvePromise({
        output: spawnError ? `${capture.text()}${spawnError}` : capture.text(),
        exitCode: code,
        signal: exitSignal ?? undefined,
        timedOut,
        cancelled: cancelled || undefined,
        durationMs: Date.now() - started,
        totalChars: capture.totalChars,
        droppedChars: capture.droppedChars,
        spawnError,
      });
    };

    const readers: (() => void)[] = [];
    const attach = (stream: NodeJS.ReadableStream | null) => {
      if (!stream) return;
      const decoder = new StringDecoder('utf8');
      let pending = '';
      const onText = (s: string) => {
        if (!s) return;
        pending += s;
        let start = 0;
        let nl: number;
        while ((nl = pending.indexOf('\n', start)) >= 0) {
          capture.push(pending.slice(start, nl));
          start = nl + 1;
        }
        pending = start ? pending.slice(start) : pending;
        if (pending.length > MAX_PENDING_CHARS) {
          capture.push(pending);
          pending = '';
        }
      };
      stream.on('data', (chunk: Buffer) => onText(decoder.write(chunk)));
      stream.on('error', () => {});
      readers.push(() => {
        onText(decoder.end());
        if (pending) capture.push(pending);
        pending = '';
      });
    };
    const flushAll = () => {
      for (const r of readers.splice(0)) r();
    };
    attach(child.stdout);
    attach(child.stderr);

    child.on('error', (err) => finish(`kopt: cannot start command: ${err.message}`));
    child.on('exit', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      // A background grandchild may keep the pipes open forever: stop waiting shortly after exit.
      closeTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish();
      }, 1500);
    });
    child.on('close', (code, signal) => {
      if (exitCode === null) exitCode = code;
      if (!exitSignal) exitSignal = signal;
      finish();
    });

    // Graceful first (SIGTERM / taskkill), then SIGKILL; if pipes are still held open, give up on them.
    const stop = () => {
      killTree(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => {
        killTree(child.pid, 'SIGKILL');
        setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish();
        }, 1000).unref();
      }, 3000);
    };
    timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, Math.max(1, o.timeoutMs));
    function onAbort() {
      if (settled || cancelled || timedOut) return;
      cancelled = true;
      clearTimeout(timer);
      stop();
    }
    if (o.signal?.aborted) onAbort();
    else o.signal?.addEventListener('abort', onAbort, { once: true });
  });
}
