#!/usr/bin/env node
// Package entry (`kopt`). Node 22 prints "ExperimentalWarning: SQLite is an experimental feature" when node:sqlite
// loads. Kiro treats any hook output as a message for the model (and, in IDE 0.x, any output intercepts the tool
// call), so the warning must never reach stdout/stderr. Shebang flags (`env -S node --no-warnings`) are not portable
// (npm's Windows cmd/PowerShell shims ignore them; old coreutils lack `env -S`), so the filter lives in code: replace
// Node's default 'warning' printer BEFORE anything imports node:sqlite, re-printing every other warning.

// Too old a Node: say so plainly, except for hooks, which must never disturb a Kiro session (silent no-op).
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  if (process.argv[2] === 'hook') process.exit(0);
  process.stderr.write(`kopt needs Node.js 22.13 or later (this is ${process.version}): install it from https://nodejs.org and run the command again.\n`);
  process.exit(1);
}

const defaults = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (warning: Error & { code?: string }) => {
  if (warning.name === 'ExperimentalWarning' && /SQLite/i.test(warning.message)) return;
  if (defaults.length) {
    for (const listener of defaults) listener.call(process, warning);
    return;
  }
  // No default printer (e.g. --no-warnings): stay quiet like Node would.
});

await import('./cli.js');
