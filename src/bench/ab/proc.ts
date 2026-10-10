// Child processes for the A/B harness: no shell (arguments are passed verbatim, prompts may contain quotes and
// newlines), stdin closed (/dev/null semantics), a wall-clock timeout that kills the whole process tree (kiro-cli
// starts an engine process and MCP servers), output streamed to files or captured.

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

export interface ProcOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Write stdout / stderr to these files instead of capturing them. */
  stdoutFile?: string;
  stderrFile?: string;
  /** Captured output is cut at this many characters (default 4 MB). */
  maxCapture?: number;
  /** Called once the child is started (its pid is the process group id on POSIX). */
  onSpawn?: (pid: number) => void;
  /** Sees every stdout chunk; a returned string kills the process tree, the string is the reason. */
  watchStdout?: (chunk: string) => string | undefined;
  /** Windows: look for processes the child left running once it exits (costs a PowerShell call; chat runs only). */
  reapWindows?: boolean;
}

export interface ProcResult {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  ms: number;
  stdout: string;
  stderr: string;
  spawnError?: string;
  /** Why watchStdout killed the process. */
  killedFor?: string;
}

/** A command to start: an executable, or Node running a script (the simulator, a .cmd shim's sibling script). */
export interface Launcher {
  command: string;
  prefix: string[];
  /** What the user configured (for messages). */
  display: string;
}

/** A Windows .cmd/.bat shim with no script next to it: it can only run through cmd.exe. */
export function isCmdShim(l: Launcher): boolean {
  return /\.(cmd|bat)$/i.test(l.command) && !l.prefix.length;
}

/** cmd.exe cannot carry these characters in an argument intact (multi-line prompts, quotes, expansions). */
const CMD_UNSAFE = /["\r\n%^&|<>!]/;

const NODE_SCRIPT = /\.(mjs|cjs|js)$/i;

/**
 * How to start `path`: Node scripts run with `node` (no shebang or file association needed, Windows included); a
 * Windows .cmd/.bat shim with a same-named .mjs/.js next to it runs that script directly (cmd.exe cannot carry
 * multi-line prompt arguments); anything else runs as is.
 */
export function launcherFor(path: string, nodePath: string): Launcher {
  if (NODE_SCRIPT.test(path)) return { command: nodePath, prefix: [path], display: path };
  if (/\.(cmd|bat)$/i.test(path)) {
    const stem = join(dirname(path), basename(path, extname(path)));
    for (const ext of ['.mjs', '.js', '.cjs']) {
      if (existsSync(stem + ext)) return { command: nodePath, prefix: [stem + ext], display: path };
    }
  }
  return { command: path, prefix: [], display: path };
}

let active: ChildProcess | undefined;

/** Kill a process and its descendants. POSIX: the process group (children are spawned detached); Windows: taskkill /T. */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10_000 });
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

/**
 * Windows: kill what a finished process left behind (MCP servers, a background `kopt index --refresh`). taskkill /T
 * cannot walk the tree once its root has exited, so the direct children are found by their parent pid. Best effort
 * (not verified on Windows): leftovers would keep files open and make a restore or `clean` fail with EBUSY.
 */
export function killOrphansWin(pid: number): void {
  if (process.platform !== 'win32') return;
  try {
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter "ParentProcessId=${Math.trunc(pid)}" | ForEach-Object { taskkill /pid $_.ProcessId /T /F | Out-Null }`],
      { stdio: 'ignore', windowsHide: true, timeout: 15_000 },
    );
  } catch {
    // nothing left, or no PowerShell
  }
}

/** The process exists (signal 0). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Command line of a running process (POSIX `ps`, Windows `tasklist` image name); undefined when it is gone. */
export function processCommand(pid: number): string | undefined {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${Math.trunc(pid)}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
      const m = /^"([^"]+)","(\d+)"/m.exec(out);
      return m && Number(m[2]) === pid ? m[1] : undefined;
    }
    const out = execFileSync('ps', ['-o', 'command=', '-p', String(Math.trunc(pid))], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/** Kill a process tree by pid (a run a previous harness process left behind). POSIX: its process group. */
export function killPidTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(Math.trunc(pid)), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10_000 });
    else process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // gone
    }
  }
}

/** The child currently running (killed by the harness's SIGINT handler). */
export function activeChild(): ChildProcess | undefined {
  return active;
}

export function runProcess(l: Launcher, args: string[], o: ProcOptions): Promise<ProcResult> {
  return new Promise((resolveRun) => {
    const t0 = Date.now();
    const max = o.maxCapture ?? 4 * 1024 * 1024;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let child: ChildProcess;
    const outFile = o.stdoutFile ? createWriteStream(o.stdoutFile) : undefined;
    const errFile = o.stderrFile ? createWriteStream(o.stderrFile) : undefined;
    const closeFiles = () =>
      Promise.all(
        [outFile, errFile].filter(Boolean).map((s) => new Promise<void>((r) => (s!.writableFinished ? r() : s!.end(() => r())))),
      );
    const done = async (r: Omit<ProcResult, 'ms' | 'stdout' | 'stderr' | 'timedOut'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardTimer);
      if (active === child) active = undefined;
      await closeFiles();
      resolveRun({ ...r, timedOut, stdout, stderr, ms: Date.now() - t0, ...(killedFor ? { killedFor } : {}) });
    };
    // A Windows .cmd shim without a script next to it only runs through cmd.exe (Node refuses to spawn it directly:
    // EINVAL), and cmd.exe cannot carry a multi-line prompt
    const shim = process.platform === 'win32' && isCmdShim(l);
    const fail = (msg: string) => {
      void closeFiles().then(() => resolveRun({ code: null, signal: null, timedOut: false, ms: 0, stdout: '', stderr: '', spawnError: msg }));
    };
    if (shim && args.some((a) => CMD_UNSAFE.test(a))) {
      fail(`${l.display} is a .cmd shim: cmd.exe cannot pass this argument intact (a multi-line prompt); point --kiro-cli (or KIRO_CLI) at kiro-cli-chat.exe`);
      return;
    }
    try {
      child = spawn(shim ? `"${l.command}"` : l.command, shim ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : [...l.prefix, ...args], {
        cwd: o.cwd,
        env: o.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        ...(shim ? { shell: true } : {}),
        // own process group on POSIX, so a timeout can kill the engine and MCP servers kiro-cli started
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      fail(e.code === 'EINVAL' && /\.(cmd|bat)$/i.test(l.command) ? `${l.display}: Windows refuses to start a .cmd file without a shell (EINVAL); point --kiro-cli at kiro-cli-chat.exe` : e.message);
      return;
    }
    active = child;
    if (child.pid !== undefined) o.onSpawn?.(child.pid);
    let hardTimer: NodeJS.Timeout | undefined;
    let killedFor: string | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, 'SIGTERM');
      hardTimer = setTimeout(() => killTree(child, 'SIGKILL'), 5000);
      hardTimer.unref();
    }, o.timeoutMs);
    child.stdout!.on('data', (c: Buffer) => {
      if (outFile) outFile.write(c);
      else if (stdout.length < max) stdout += c.toString('utf8');
      if (o.watchStdout && !killedFor) {
        const why = o.watchStdout(c.toString('utf8'));
        if (why) {
          killedFor = why;
          killTree(child, 'SIGTERM');
          const k = setTimeout(() => killTree(child, 'SIGKILL'), 3000);
          k.unref();
        }
      }
    });
    child.stderr!.on('data', (c: Buffer) => {
      if (errFile) errFile.write(c);
      if (stderr.length < max) stderr += c.toString('utf8');
    });
    // what the run started and left running (MCP servers, hook children that did not detach) belongs to the run
    const reap = () => {
      if (child.pid === undefined) return;
      if (process.platform === 'win32') {
        if (o.reapWindows) killOrphansWin(child.pid);
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // group already empty
        }
      }
    };
    child.on('error', (err) => void done({ code: null, signal: null, spawnError: err.message }));
    child.on('close', (code, signal) => {
      reap();
      void done({ code, signal: signal ?? null });
    });
    // A grandchild that inherited stdout (an MCP server, a hook) can keep the pipes open after kiro-cli exited:
    // give it a moment, then kill what is left of the process group and settle.
    child.on('exit', (code, signal) => {
      const grace = setTimeout(() => {
        if (settled) return;
        reap();
        child.stdout?.destroy();
        child.stderr?.destroy();
        void done({ code, signal: signal ?? null });
      }, 3000);
      grace.unref();
    });
  });
}
