// CI smoke test: run `kopt hook` the way Kiro does and check the governor's exit-code contract.
//
// Kiro IDE starts hook commands with child_process.spawn(command, { shell: true }) (verified in the 0.12 bundle):
// /bin/sh -c on Linux/macOS, cmd.exe /d /s /c on Windows. The command line is the one kopt's installer writes
// (hookCommand() from dist/kiro/index.js), falling back to `node <dist/bin.js> hook` when that API is absent.
// The installer's default form runs the private launcher (<KOPT_HOME>/bin/kopt, kopt.cmd on Windows), which only
// `kopt setup` or `kopt init` writes, so this script writes it first with launcherScript(), as they do. The direct
// `<node> <bin.js> hook` form (KOPT_HOOK_COMMAND=node) is checked as well: the launcher turns every exit code
// other than 2 into 0, so only the direct form shows a hook that crashes.
// Checks for each form: an allowed PreToolUse exits 0 with empty stdout (any output would intercept the tool call), and a
// whole-file read of a big file exits 2 with the reason on stderr.
// Usage: node .github/scripts/hook-smoke.mjs   (from the repository root, after `npm run build`)

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve('.');
const bin = existsSync(join(root, 'dist', 'bin.js')) ? join(root, 'dist', 'bin.js') : join(root, 'dist', 'cli.js');

const quote = (s) => (/^[A-Za-z0-9_\/.:=@%+,-]+$/.test(s) ? s : process.platform === 'win32' ? `"${s}"` : `'${s.replace(/'/g, `'\\''`)}'`);

/** The hook command lines to test: the installer's default (launcher) form, then the direct node form. */
async function commandLines() {
  try {
    const kiro = await import(pathToFileURL(join(root, 'dist', 'kiro', 'index.js')).href);
    if (typeof kiro.hookCommand === 'function') {
      process.env.KOPT_CLI ??= bin;
      const lines = [];
      const cmd = typeof kiro.koptCommand === 'function' ? kiro.koptCommand() : undefined;
      if (cmd?.kind === 'launcher' && cmd.launcher && !existsSync(cmd.launcher) && typeof kiro.launcherScript === 'function') {
        // what `kopt setup` installs before any hook can run it
        mkdirSync(dirname(cmd.launcher), { recursive: true });
        writeFileSync(cmd.launcher, kiro.launcherScript(cmd.node, cmd.bin), { mode: 0o755 });
        console.log(`(wrote the launcher kopt setup installs: ${cmd.launcher})`);
      }
      lines.push(String(kiro.hookCommand('ci')));
      if (typeof kiro.resolveKoptCommand === 'function' && typeof kiro.hookCommandLine === 'function') {
        const direct = kiro.hookCommandLine(kiro.resolveKoptCommand({ bin: process.env.KOPT_CLI, force: 'node' }), 'ci');
        if (!lines.includes(direct)) lines.push(direct);
      }
      return lines;
    }
  } catch (err) {
    console.log(`(installer API unavailable: ${err.message}; using node + entry)`);
  }
  return [`node ${quote(bin)} hook`];
}

function run(line, event) {
  return new Promise((done) => {
    const child = spawn(line, { cwd: root, shell: true, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => done({ code, stdout, stderr }));
    // a command that exits without reading stdin (not found, crash) must fail the check, not this script
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(event));
  });
}

const base = { hook_event_name: 'PreToolUse', cwd: root, tool_name: 'read_file' };
let failed = 0;
const check = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) failed++;
};

for (const [i, line] of (await commandLines()).entries()) {
  console.log(`hook command (${process.platform}, shell: true): ${line}`);
  const allow = await run(line, { ...base, session_id: `ci-kiro-allow-${i}-${process.pid}`, tool_input: { path: 'LICENSE' } });
  check(allow.code === 0, `allowed PreToolUse exits 0 (got ${allow.code})`);
  check(allow.stdout === '', `allowed PreToolUse prints nothing on stdout${allow.stdout ? `: ${JSON.stringify(allow.stdout)}` : ''}`);
  if (allow.stderr) console.log(`::warning::allowed PreToolUse wrote to stderr: ${allow.stderr.trim()}`);

  const block = await run(line, { ...base, session_id: `ci-kiro-block-${i}-${process.pid}`, tool_input: { path: 'package-lock.json' } });
  check(block.code === 2, `whole-file read of a big file is blocked with exit 2 (got ${block.code})`);
  check(/kopt/.test(block.stderr), `the block reason goes to stderr: ${JSON.stringify(block.stderr.trim().slice(0, 160))}`);
}

process.exit(failed ? 1 : 0);
