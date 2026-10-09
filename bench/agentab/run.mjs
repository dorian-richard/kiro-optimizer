#!/usr/bin/env node
// Agent A/B wrapper: every command an exploring agent runs goes through here, so we know exactly
// what entered its context. Arm A = native read-only shell tools (capped like Kiro's built-ins);
// arm B = the same plus the kopt CLI.
//
// usage: node bench/agentab/run.mjs --arm A|B --repo <name> --task <id> --run <label> -- '<command>'

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHARS_PER_TOKEN = 3.0;
// Kiro built-in caps: read_file 2,000 lines / 250 KB, grep_search 100 matches / ~10k chars.
const READ_CAP = { lines: 2000, chars: 250_000 };
const SEARCH_CAP = { lines: 100, chars: 10_000 };
const NATIVE = new Set(['grep', 'egrep', 'find', 'ls', 'cat', 'head', 'tail', 'sed', 'wc', 'awk', 'sort', 'uniq', 'cut', 'tr', 'nl', 'tree', 'git']);
const GIT_READONLY = new Set(['grep', 'log', 'show', 'ls-files', 'blame', 'diff']);
const KOPT_ALLOWED = new Set(['find', 'read', 'outline', 'refs']);

function parseArgs(argv) {
  const out = { arm: '', repo: '', task: '', run: 'default', command: '' };
  const sep = argv.indexOf('--');
  const head = sep >= 0 ? argv.slice(0, sep) : argv;
  out.command = sep >= 0 ? argv.slice(sep + 1).join(' ') : '';
  for (let i = 0; i < head.length; i += 2) {
    const k = head[i].replace(/^--/, '');
    if (k in out) out[k] = head[i + 1] ?? '';
  }
  return out;
}

function fail(msg) {
  process.stdout.write(`error: ${msg}\n`);
  process.exit(2);
}

const args = parseArgs(process.argv.slice(2));
if (!['A', 'B'].includes(args.arm)) fail('--arm must be A or B');
const repoDir = join(ROOT, 'bench', 'repos', args.repo);
if (!args.repo || !existsSync(repoDir)) fail(`unknown repo "${args.repo}"`);
if (!args.task) fail('--task is required');
if (!args.command.trim()) fail('no command after --');

// Read-only guard: every pipeline segment must start with an allowed program; no redirections.
const cmd = args.command;
if (/[><]|`|\$\(/.test(cmd.replace(/'[^']*'|"[^"]*"/g, ''))) fail('redirections and command substitution are not allowed');
const segments = cmd.split(/\|\||&&|;|\|/).map((s) => s.trim()).filter(Boolean);
let usesKopt = false;
let isSearch = false;
for (const seg of segments) {
  const words = seg.match(/(?:[^\s'"]+|'[^']*'|"[^"]*")+/g) ?? [];
  const prog = words[0];
  if (prog === 'kopt') {
    if (args.arm !== 'B') fail('kopt is not available in this arm');
    if (!KOPT_ALLOWED.has(words[1])) fail(`only kopt ${[...KOPT_ALLOWED].join('/')} are allowed`);
    usesKopt = true;
    continue;
  }
  if (!NATIVE.has(prog)) fail(`"${prog}" is not allowed; use: ${[...NATIVE].join(', ')}${args.arm === 'B' ? ', kopt' : ''}`);
  if (prog === 'git' && !GIT_READONLY.has(words[1])) fail('only read-only git subcommands are allowed');
  if (prog === 'sed' && words.some((w) => /^-i/.test(w))) fail('sed -i is not allowed');
  if (['grep', 'egrep'].includes(prog) || (prog === 'git' && words[1] === 'grep') || prog === 'find') isSearch = true;
}

const koptBin = join(ROOT, 'dist', 'bin.js');
const env = {
  ...process.env,
  KOPT_TELEMETRY: '0',
  KOPT_HOOKS: '0',
  KOPT_ROOT: repoDir,
  KOPT_DATA_DIR: join(ROOT, 'bench', 'repos', `.kopt-${args.repo}`),
  NO_COLOR: '1',
};
// Expose `kopt` as a shell function bound to this repo's prepared index.
const prelude = usesKopt ? `kopt() { node ${JSON.stringify(koptBin)} "$@" --root ${JSON.stringify(repoDir)}; }\n` : '';
const res = spawnSync('bash', ['-c', prelude + cmd], { cwd: repoDir, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
let out = (res.stdout ?? '') + (res.stderr ? res.stderr.replace(/^.*ExperimentalWarning.*\n?/gm, '').replace(/^\(Use `node --trace-warnings.*\n?/gm, '') : '');

// Apply Kiro-like caps to native output (kopt output is already budgeted by the tool itself).
let truncated = false;
if (!usesKopt) {
  const cap = isSearch ? SEARCH_CAP : READ_CAP;
  let lines = out.split('\n');
  if (lines.length > cap.lines) {
    lines = lines.slice(0, cap.lines);
    truncated = true;
  }
  out = lines.join('\n');
  if (out.length > cap.chars) {
    out = out.slice(0, cap.chars);
    truncated = true;
  }
  if (truncated) out += `\n[output truncated: ${isSearch ? '100 matches / 10k chars' : '2000 lines / 250 KB'} cap]`;
}
if (!out.trim()) out = `(no output, exit ${res.status ?? 'timeout'})`;

const logDir = join(ROOT, 'bench', 'agentab', 'logs', args.run);
mkdirSync(logDir, { recursive: true });
appendFileSync(
  join(logDir, `${args.arm}-${args.repo}-${args.task}.jsonl`),
  JSON.stringify({ arm: args.arm, repo: args.repo, task: args.task, cmd, kopt: usesKopt, chars: out.length, tokens: Math.ceil(out.length / CHARS_PER_TOKEN), lines: out.split('\n').length, truncated, exit: res.status }) + '\n',
);
process.stdout.write(out.endsWith('\n') ? out : out + '\n');
