#!/usr/bin/env node
// Agent A/B wrapper: every command an agent runs goes through here, so we know exactly what entered its context.
// Arm A = stock Kiro: read-only shell tools, capped like Kiro's built-ins (and, for test tasks, the test command).
// Arm B = Kiro with kopt: the same, plus the kopt CLI (same output as the MCP tools) and kopt's real session
// governor (`kopt hook`), which blocks once what it blocks in Kiro (verbose test runs, whole reads of big files).
//
// usage: node bench/agentab/run.mjs --arm A|B --repo <name> --task <id> --run <label> [--rep k] [--no-log] -- '<command>'
//
// --rep k: repetition k (default 1) of the task in a run prepared with several (prepare.mjs --reps): its own log
// file (<arm>-<repo>-<task>.r<k>.jsonl from k = 2), governor session and, for test tasks, its own repository copies.
//
// The run must be prepared first (node bench/agentab/prepare.mjs --run <label>): that snapshots the kopt build,
// creates an isolated user state (HOME, ~/.kopt, ~/.kiro, kopt cache), indexes the repositories and creates the
// test-task repository copies. Nothing is written to the real user folders or into bench/repos.
//
// Environment: no KOPT_* variable of the operator's shell reaches an agent's command; kopt gets the run's isolated
// state (KOPT_HOME, KOPT_CACHE_DIR, ...) and, for its dedup ledger, the run's KOPT_SESSION. The commands of a test
// task (npx vitest run, npm test) never see any KOPT_* variable, run directly or through `kopt run`, in either arm:
// npx and npm resolve to shims (<state>/<run>/test-shims, first on PATH) that drop them. Round 2 measured the test
// tasks with the wrapper's KOPT_SESSION leaking through `kopt run` into kopt's own test suite (one test failed in
// every arm-B run); its test-task numbers are confounded by it.

import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STATE = process.env.AGENTAB_STATE ? resolve(process.env.AGENTAB_STATE) : join(ROOT, 'bench', 'agentab', '.state');
const CHARS_PER_TOKEN = 3.0;
// Kiro built-in caps: read_file 2,000 lines / 250 KB, grep_search 100 matches / ~10k chars. The shell cap is an
// assumption (Kiro does not document it): generous, so that it never favours arm B.
const READ_CAP = { lines: 2000, chars: 250_000, label: '2000 lines / 250 KB' };
const SEARCH_CAP = { lines: 100, chars: 10_000, label: '100 matches / 10k chars' };
const SHELL_CAP = { lines: 2000, chars: 100_000, label: '2000 lines / 100k chars' };
const NATIVE = new Set(['grep', 'egrep', 'find', 'ls', 'cat', 'head', 'tail', 'sed', 'wc', 'awk', 'sort', 'uniq', 'cut', 'tr', 'nl', 'tree', 'git']);
// diff/status may refresh .git/index: only in the test-task copies, never in the shared bench/repos checkouts
const GIT_EXPLORE = new Set(['grep', 'log', 'show', 'ls-files', 'blame']);
const GIT_TEST = new Set([...GIT_EXPLORE, 'diff', 'status']);
const KOPT_EXPLORE = ['find', 'read', 'outline', 'refs'];
const KOPT_TEST = [...KOPT_EXPLORE, 'run', 'expand'];
// Test-runner flags that write files, watch, or open a UI.
const TEST_FORBIDDEN = /^(?:-u|--update|-w|--watch|--ui|--open|--coverage(?:\..*|=.*)?|--outputFile(?:\..*|=.*)?|--api(?:\..*|=.*)?|--inspect.*|--browser.*|--standalone)$/;
const FIND_FORBIDDEN = /^-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/;

function parseArgs(argv) {
  const out = { arm: '', repo: '', task: '', run: '', rep: '1', command: '', log: true };
  const sep = argv.indexOf('--');
  const head = sep >= 0 ? argv.slice(0, sep) : argv;
  out.command = sep >= 0 ? argv.slice(sep + 1).join(' ') : '';
  for (let i = 0; i < head.length; i++) {
    const k = head[i].replace(/^--/, '');
    if (k === 'no-log') out.log = false;
    else if (k in out) out[k] = head[++i] ?? '';
  }
  return out;
}

let args;
function fail(msg, code = 2) {
  const out = `error: ${msg}\n`;
  // a refused command still costs the agent a turn: it is logged like any other call
  if (args?.log && args.run && args.task && args.arm) writeLog({ ts: new Date().toISOString(), ms: 0, cmd: args.command, refused: true, chars: out.length, tokens: Math.ceil(out.length / CHARS_PER_TOKEN), lines: 1, truncated: false, exit: code });
  process.stdout.write(out);
  process.exit(code);
}

function writeLog(rec) {
  const logDir = join(process.env.AGENTAB_LOGS ? resolve(process.env.AGENTAB_LOGS) : join(ROOT, 'bench', 'agentab', 'logs'), args.run);
  mkdirSync(logDir, { recursive: true });
  const rep = Number(args.rep) || 1;
  const file = `${args.arm}-${args.repo}-${args.task}${rep > 1 ? `.r${rep}` : ''}.jsonl`;
  appendFileSync(join(logDir, file), JSON.stringify({ arm: args.arm, repo: args.repo, task: args.task, rep, ...rec }) + '\n');
}

/**
 * Shell-aware split of a command line: pipeline segments (split on unquoted | || && ; and newlines) and their
 * words with quotes removed. Flags what the read-only guard must refuse outside quotes.
 */
function splitCommand(cmd) {
  const segments = [];
  let words = [];
  let word = '';
  let inWord = false;
  let quote = '';
  const problems = new Set();
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endSeg = () => {
    endWord();
    if (words.length) segments.push(words);
    words = [];
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote === "'") {
      if (c === "'") quote = '';
      else word += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = '';
      else if (c === '\\' && i + 1 < cmd.length && '"\\$`'.includes(cmd[i + 1])) word += cmd[++i];
      else {
        if (c === '`' || (c === '$' && /[({A-Za-z_]/.test(cmd[i + 1] ?? ''))) problems.add('substitution');
        word += c;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
      continue;
    }
    if (c === '\\' && i + 1 < cmd.length) {
      word += cmd[++i];
      inWord = true;
      continue;
    }
    if (c === ' ' || c === '\t') {
      endWord();
      continue;
    }
    if (c === '\n' || c === ';') {
      endSeg();
      continue;
    }
    if (c === '|' || c === '&') {
      if (c === '&' && cmd[i + 1] !== '&') {
        problems.add('background');
        continue;
      }
      if (cmd[i + 1] === c) i++;
      endSeg();
      continue;
    }
    if (c === '2' && !inWord && cmd.startsWith('2>&1', i)) {
      i += 3;
      continue;
    }
    if (c === '>' || c === '<') problems.add('redirection');
    if (c === '`' || (c === '$' && /[({A-Za-z_]/.test(cmd[i + 1] ?? ''))) problems.add('substitution');
    if (c === '~' && !inWord) problems.add('home');
    word += c;
    inWord = true;
  }
  if (quote) problems.add('unbalanced quotes');
  endSeg();
  return { segments, problems: [...problems] };
}

/** A test command both arms may run in test tasks: `npx vitest run ...`, `npm test ...`, `npm run test ...`. */
function isTestCommand(words) {
  const [p, a, b] = words;
  if (p === 'npx' && a === 'vitest' && b === 'run') return true;
  if (p === 'npm' && (a === 'test' || a === 't')) return true;
  if (p === 'npm' && a === 'run' && b === 'test') return true;
  return false;
}

function checkTestCommand(words) {
  const bad = words.find((w) => TEST_FORBIDDEN.test(w));
  return bad ? `test flag ${bad} is not allowed (it writes files or never exits)` : undefined;
}

function isInside(base, p) {
  const rel = relative(base, p);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Paths must stay inside the repository: no `..`, no existing absolute path (or glob) elsewhere. */
function checkPaths(words, repoDir) {
  for (const w of words.slice(1)) {
    const v = w.replace(/^--?[A-Za-z-]+=/, '');
    if (/(^|[\\/])\.\.([\\/]|$)/.test(v)) return `"${w}": paths must stay inside the repository`;
    if (isAbsolute(v) && !isInside(repoDir, v) && (existsSync(v) || /[*?[]/.test(v) || existsSync(dirname(v)) && dirname(v) !== '/')) {
      return `"${w}": paths must stay inside the repository`;
    }
  }
  return undefined;
}

function readMeta(run) {
  const file = join(STATE, run, 'meta.json');
  if (!existsSync(file)) fail(`run "${run}" is not prepared: node bench/agentab/prepare.mjs --run ${run}`);
  const meta = JSON.parse(readFileSync(file, 'utf8'));
  // prepare.mjs smoke-tests through this wrapper (--no-log) before it marks the run ready
  if (meta.ready !== true && args.log) fail(`run "${run}" is not ready: its prepare.mjs did not finish`);
  return meta;
}

args = parseArgs(process.argv.slice(2));
if (!['A', 'B'].includes(args.arm)) fail('--arm must be A or B');
if (!args.run) fail('--run is required');
if (!args.task) fail('--task is required');
if (!args.command.trim()) fail("no command after --: ... -- '<command>'");
const meta = readMeta(args.run);
const repo = meta.repos?.[args.repo];
if (!args.repo || !repo) fail(`unknown repo "${args.repo}" for run ${args.run}`);
const testMode = repo.mode === 'test';
const rep = Number(args.rep);
if (!Number.isInteger(rep) || rep < 1 || rep > (meta.reps ?? 1)) {
  args.log = false; // not a run of this task: nothing to log
  fail(`--rep must be 1..${meta.reps ?? 1} for run ${args.run}`);
}
// test tasks: every repetition has its own copies (kopt run caches results per repository)
const repoDir = testMode ? (repo.reps?.[rep - 1] ?? repo.dirs)[args.arm] : repo.dir;
if (!repoDir || !existsSync(repoDir)) fail(`repository folder missing: ${repoDir}`);
const runDir = join(STATE, args.run);
const koptBin = meta.koptBin;

// ---- read-only guard --------------------------------------------------------------------------------------------
const cmd = args.command;
const { segments, problems } = splitCommand(cmd);
const WHY = {
  redirection: 'redirections (> <) are not allowed (read-only; 2>&1 is fine)',
  substitution: 'command substitution and $variables are not allowed',
  background: 'background jobs (&) are not allowed',
  home: '~ is outside the repository',
  'unbalanced quotes': 'unbalanced quotes: put the whole command in single quotes and use double quotes inside',
};
if (problems.length) fail(problems.map((p) => WHY[p] ?? p).join('; '));
if (!segments.length) fail('empty command');
const koptAllowed = testMode ? KOPT_TEST : KOPT_EXPLORE;
let usesKopt = false;
let koptSub = '';
let isSearch = false;
let isTest = false;
for (const words of segments) {
  const prog = words[0];
  if (prog === 'kopt') {
    if (args.arm !== 'B') fail('kopt is not available in this arm');
    const sub = words[1];
    if (!koptAllowed.includes(sub)) fail(`only kopt ${koptAllowed.join('/')} are allowed`);
    if (words.includes('--root')) fail('--root is set by the wrapper');
    if (sub === 'run') {
      // options first, then one quoted command line or `-- argv...`
      let i = 2;
      while (i < words.length && /^--(max-tokens|timeout|fresh|cwd)$/.test(words[i])) i += words[i] === '--fresh' ? 1 : 2;
      const rest = words[i] === '--' ? words.slice(i + 1) : words.slice(i);
      const inner = rest.length === 1 ? splitCommand(rest[0]) : { segments: [rest], problems: [] };
      if (inner.problems.length || inner.segments.length !== 1 || !isTestCommand(inner.segments[0])) {
        fail('kopt run is limited to the test commands of this task: npx vitest run [args], npm test [-- args]');
      }
      const bad = checkTestCommand(inner.segments[0]) ?? checkPaths(inner.segments[0], repoDir);
      if (bad) fail(bad);
    }
    const badPath = checkPaths(words, repoDir);
    if (badPath) fail(badPath);
    usesKopt = true;
    koptSub ||= sub;
    continue;
  }
  if (testMode && isTestCommand(words)) {
    const bad = checkTestCommand(words);
    if (bad) fail(bad);
    isTest = true;
  } else {
    if (!NATIVE.has(prog)) {
      const extra = [args.arm === 'B' ? 'kopt' : '', testMode ? 'npx vitest run, npm test' : ''].filter(Boolean);
      fail(`"${prog}" is not allowed; use: ${[...NATIVE].join(', ')}${extra.length ? `, ${extra.join(', ')}` : ''}`);
    }
    const gitAllowed = testMode ? GIT_TEST : GIT_EXPLORE;
    if (prog === 'git' && !gitAllowed.has(words[1])) fail(`only these read-only git subcommands are allowed: ${[...gitAllowed].join(', ')}`);
    if (prog === 'git' && words.some((w) => /^--output(=|$)|^--ext-diff$/.test(w))) fail('git --output / --ext-diff are not allowed');
    if (prog === 'sed' && words.some((w) => /^-[A-Za-z]*i/.test(w) || w === '--in-place')) fail('sed -i is not allowed');
    if (prog === 'find' && words.some((w) => FIND_FORBIDDEN.test(w))) fail('find -exec/-delete/-fprint are not allowed');
    if (prog === 'git' && words.some((w) => /^(-O|--open-files-in-pager)/.test(w))) fail('git grep -O is not allowed');
    if ((prog === 'sort' || prog === 'tree') && words.some((w) => /^-o|^--output/.test(w))) fail(`${prog} -o writes a file: not allowed`);
    if (prog === 'uniq' && words.slice(1).filter((w) => !w.startsWith('-')).length > 1) fail('uniq with an output file is not allowed');
    if (prog === 'awk' && words.slice(1).some((w) => /\bsystem\b|\bgetline\b|[>|]/.test(w) && !w.startsWith('-'))) {
      fail('awk programs may not use system, getline, > or | (read-only)');
    }
  }
  const bad = checkPaths(words, repoDir);
  if (bad) fail(bad);
  if (['grep', 'egrep', 'find'].includes(prog) || (prog === 'git' && ['grep', 'ls-files'].includes(words[1]))) isSearch = true;
}

// ---- environment: isolated user state, never the real ~/.kopt, ~/.kiro or kopt cache ------------------------------
const home = join(runDir, 'home');
// no KOPT_* of the operator's shell reaches an agent's command: the wrapper sets the ones kopt needs below
const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('KOPT_')));
const env = {
  ...inherited,
  // npx/npm/node of the Node that runs this wrapper (Kiro starts kopt with an absolute node path too)
  PATH: `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
  HOME: home,
  USERPROFILE: home,
  KOPT_HOME: join(runDir, 'kopt-home'),
  KOPT_CACHE_DIR: join(runDir, 'cache'),
  KOPT_KIRO_HOME: join(runDir, 'kiro'),
  KOPT_KIRO_USER_SETTINGS: join(runDir, 'kiro-user', 'settings.json'),
  KOPT_KIRO_CLI: 'none',
  GIT_OPTIONAL_LOCKS: '0',
  NO_COLOR: '1',
  FORCE_COLOR: '0',
  npm_config_update_notifier: 'false',
  npm_config_fund: 'false',
  npm_config_audit: 'false',
};
// Explore repos use the index prepared for this run (bench/repos stays untouched). Test repos use the isolated kopt
// cache.
if (!testMode && repo.dataDir) env.KOPT_DATA_DIR = repo.dataDir;
const session = `ab-${args.run}-${args.arm}-${args.task}${rep > 1 ? `-r${rep}` : ''}`;

// ---- test tasks: the test commands never see kopt's variables ----------------------------------------------------
// kopt needs its variables (KOPT_HOME, KOPT_CACHE_DIR, ... and KOPT_SESSION for its dedup ledger), but the command a
// test task runs must not get any: `kopt run` passes its whole environment to the command it runs (KOPT_RUN=1 added),
// and in round 2 the wrapper's KOPT_SESSION reached kopt's own test suite that way (test/cli.test.ts failed in every
// arm-B run, and the agents chased that failure). In test tasks, `npx` and `npm` (the only test commands allowed)
// resolve to these shims, first on PATH in both arms: they drop every KOPT_* variable and exec the real npx / npm.
// Run directly or through `kopt run`, in arm A or B, the tests then run in the same environment.
function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
function testShims() {
  const dir = join(runDir, 'test-shims');
  mkdirSync(dir, { recursive: true });
  const nodeBin = dirname(process.execPath);
  for (const name of ['npx', 'npm']) {
    const real = existsSync(join(nodeBin, name)) ? join(nodeBin, name) : name;
    const body =
      '#!/bin/sh\n' +
      `# bench/agentab/run.mjs: ${name} for the commands of a test task, without kopt's variables (whichever arm runs it)\n` +
      "for v in $(env | sed -n 's/^\\(KOPT_[A-Za-z0-9_]*\\)=.*/\\1/p'); do unset \"$v\"; done\n" +
      `p=; IFS=:; for d in $PATH; do [ "$d" = ${shq(dir)} ] || p="\${p:+$p:}$d"; done; unset IFS; PATH=$p; export PATH\n` +
      `exec ${shq(real)} "$@"\n`;
    const file = join(dir, name);
    if (existsSync(file) && readFileSync(file, 'utf8') === body) continue;
    // agents of the same run may start in parallel: write aside, then rename
    const tmp = `${file}.${process.pid}`;
    writeFileSync(tmp, body);
    chmodSync(tmp, 0o755);
    renameSync(tmp, file);
  }
  return dir;
}
if (testMode) env.PATH = `${testShims()}${process.platform === 'win32' ? ';' : ':'}${env.PATH}`;

// ---- arm B: kopt's real session governor, as Kiro would call it before a built-in tool ---------------------------
function governor() {
  if (args.arm !== 'B' || usesKopt) return undefined;
  let event;
  if (isTest) event = { tool_name: 'execute_bash', tool_input: { command: cmd } };
  else if (segments.length === 1 && segments[0][0] === 'cat') {
    const paths = segments[0].slice(1).filter((w) => !w.startsWith('-'));
    if (paths.length) event = { tool_name: 'fs_read', tool_input: { operations: paths.map((p) => ({ mode: 'Line', path: p })) } };
  }
  if (!event) return undefined;
  const payload = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: session, cwd: repoDir, ...event });
  const r = spawnSync(process.execPath, [koptBin, 'hook'], { cwd: repoDir, env: { ...env, KOPT_ROOT: repoDir }, input: payload, encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 2) return undefined;
  // The same message Kiro shows, with MCP tool names spelled as the CLI commands this arm uses.
  return (r.stderr || 'kopt governor: blocked')
    .trim()
    .replace(/kopt_run with command="([^"]*)"(?: cwd="[^"]*")?/g, 'kopt run "$1"')
    .replace(/kopt_outline path=/g, 'kopt outline ')
    .replace(/kopt_(read|expand|find|refs|outline|run)\b/g, 'kopt $1')
    .replace(/read with offset\/limit/g, 'read a line range (sed -n a,bp)');
}

const t0 = Date.now();
let out;
let status;
let blocked = false;
const veto = governor();
if (veto) {
  out = veto;
  status = 2;
  blocked = true;
} else {
  // `kopt` is a shell function bound to the snapshot of the kopt build and to this repository.
  // `kopt read|find --fresh` is the MCP tools' fresh:true (resend code this session was already sent, which the dedup
  // ledger answers with "unchanged ... pass fresh:true to resend"). The CLI has no such flag, so the wrapper drops it
  // and runs that one call outside the session's ledger: the code comes back in full, as with fresh:true.
  // kopt runs on this wrapper's Node, by absolute path, as Kiro starts it (kopt setup writes an absolute node path)
  const node = JSON.stringify(process.execPath);
  const bin = JSON.stringify(koptBin);
  const dir = JSON.stringify(repoDir);
  const prelude = usesKopt
    ? 'kopt() { local sub="$1"; shift; local a=() f=""; for x in "$@"; do ' +
      'if [ "$x" = "--fresh" ] && { [ "$sub" = read ] || [ "$sub" = find ]; }; then f=1; else a+=("$x"); fi; done; ' +
      `if [ -n "$f" ]; then env -u KOPT_SESSION ${node} ${bin} "$sub" --root ${dir} "\${a[@]}"; else ${node} ${bin} "$sub" --root ${dir} "\${a[@]}"; fi; }\n`
    : '';
  const res = spawnSync('bash', ['-c', prelude + cmd], {
    cwd: repoDir,
    env: usesKopt ? { ...env, KOPT_SESSION: session } : env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: testMode ? 900_000 : 180_000,
    killSignal: 'SIGKILL',
  });
  status = res.status;
  const stderr = (res.stderr ?? '').replace(/^.*ExperimentalWarning.*\n?/gm, '').replace(/^\(Use `node --trace-warnings.*\n?/gm, '');
  out = (res.stdout ?? '') + stderr;
  // the dedup hint in CLI spelling (see the prelude above)
  if (usesKopt) {
    out = out
      .replace(/pass fresh:\s?true to resend/g, 'pass --fresh to resend')
      // kopt_run's pointer to its stored log, in the CLI spelling of the same kopt_read call
      .replace(/kopt_read (o[0-9a-f]+) \(grep=<regex> filters it\)/g, 'kopt read $1 (--grep "<regex>" filters it)');
  }
}

// ---- Kiro-like caps on native output (kopt output is already budgeted by the tool itself) -------------------------
let truncated = false;
if (!usesKopt && !blocked) {
  const cap = isTest ? SHELL_CAP : isSearch ? SEARCH_CAP : READ_CAP;
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
  if (truncated) out += `\n[output truncated: ${cap.label} cap]`;
}
if (!out.trim()) out = `(no output, exit ${status ?? 'timeout'})`;

if (args.log) {
  const raw = usesKopt && koptSub === 'run' ? /raw ~(\d+) tok/.exec(out)?.[1] : undefined;
  writeLog({
    ts: new Date(t0).toISOString(), ms: Date.now() - t0, cmd,
    kopt: usesKopt, koptSub: koptSub || undefined, test: isTest || (koptSub === 'run') || undefined, blocked: blocked || undefined,
    chars: out.length, tokens: Math.ceil(out.length / CHARS_PER_TOKEN), lines: out.split('\n').length, truncated, exit: status,
    rawTokens: raw ? Number(raw) : undefined,
  });
}
process.stdout.write(out.endsWith('\n') ? out : out + '\n');
// the agent sees the command's exit status, as in Kiro's shell tool (2 = refused or blocked by the governor)
process.exitCode = blocked ? 2 : (status ?? 124);
