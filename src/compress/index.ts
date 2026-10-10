// compress: kopt_run (run a command, return a compact verdict), kopt_expand (more of a stored log, which the model
// reaches as `kopt_read <handle>`),
// pure output compression and the workspace fingerprint used to skip identical re-runs.

import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ExpandParams, RunParams } from '../core/api.js';
import type { ToolContext } from '../core/context.js';
import { estimateTokens, truncateLines } from '../core/tokens.js';
import type { ToolResult } from '../core/types.js';
import { longRunningReason, parseCommand } from './command.js';
import { expandOutput } from './expand.js';
import { fingerprintPartsAsync, workspaceFingerprint as fingerprint, type FingerprintParts } from './fingerprint.js';
import { capLine } from './filters/common.js';
import { compressNormalized, VERDICT_FILTERS } from './filters/index.js';
import { normalizeOutput } from './normalize.js';
import { OutputStore, sha1, type RunEntry } from './outputs.js';
import { DEFAULT_TIMEOUT_SEC, execCapture, type ExecResult } from './runner.js';

export { normalizeOutput } from './normalize.js';
export { longRunningReason, parseCommand } from './command.js';
export { fingerprintParts, fingerprintPartsAsync } from './fingerprint.js';
export { killActiveCommands } from './runner.js';

const MIN_BUDGET = 60;
const MAX_TIMEOUT_SEC = 6 * 3600;
/** Outputs up to this size are returned as they are, under a one-line `exit N` header. */
export const SMALL_OUTPUT_TOKENS = 120;
/** A cached result this short is re-sent whole rather than replaced by a "same as run X" line. */
const SHORT_RESEND_TOKENS = 60;

/** Pure: normalize, pick a filter by command/output signature and compress within `maxTokens`. */
export function compressOutput(command: string, output: string, exitCode: number, maxTokens: number): { text: string; filter: string } {
  return compressNormalized(command, normalizeOutput(output), exitCode, Math.max(1, maxTokens));
}

/** Workspace fingerprint used to detect "same command, nothing changed" (kopt's data dir is ignored). */
export function workspaceFingerprint(root: string, exclude?: string[]): string {
  return fingerprint(root, exclude);
}

export function expand(p: ExpandParams, ctx: ToolContext): ToolResult {
  return expandOutput(p, ctx);
}

// ---------------------------------------------------------------------------------------------------------------
// Cacheability: only commands whose output depends on the workspace alone may be answered from cache.

const BENIGN = new Set([
  'cd', 'pushd', 'popd', 'echo', 'printf', 'true', ':', 'export', 'set', 'source', '.', 'tee', 'grep', 'egrep', 'rg',
  'head', 'tail', 'cat', 'sed', 'awk', 'sort', 'uniq', 'wc', 'cut', 'tr', 'test', '[',
  // PowerShell and cmd.exe equivalents (kopt_run uses PowerShell on Windows)
  'chdir', 'set-location', 'sl', 'push-location', 'pop-location', 'write-output', 'write-host', 'select-object',
  'select-string', 'sls', 'where-object', 'sort-object', 'measure-object', 'tee-object', 'out-null', 'out-string',
  'out-host', 'get-content', 'gc', 'type', 'findstr', 'more',
]);
const WRAPPERS = new Set(['uv', 'poetry', 'pipenv', 'hatch', 'pdm', 'rye', 'bundle', 'conda']);
const TEST_TOOLS = new Set([
  'pytest', 'py.test', 'unittest', 'nose2', 'jest', 'vitest', 'tsc', 'vue-tsc', 'tsgo', 'eslint', 'mvn', 'mvnw',
  'mvnd', 'gradle', 'gradlew', 'gotestsum', 'react-scripts', 'craco', 'mypy', 'ruff', 'flake8', 'pylint', 'black', 'prettier',
  'mocha', 'ava', 'jasmine', 'karma', 'rspec', 'phpunit', 'pest', 'paratest', 'phpstan', 'psalm', 'rubocop', 'ktlint',
  'detekt', 'golangci-lint', 'staticcheck', 'pyright', 'basedpyright', 'tox', 'nox', 'ctest', 'biome', 'oxlint',
  'stylelint', 'nyc', 'c8',
]);
/** Goals/tasks/subcommands with effects outside the workspace (case-sensitive: `-c Release` is a build config). */
const SIDE_EFFECT_ARG_RE = /^(?:deploy|publish\w*|release|push|upload\w*|login|logout)$|^(?:deploy|release|site-deploy|docker|jib):/;
const SCRIPT_DENY_RE = /^(?:dev|start|serve|watch|preview|deploy|publish|release|install|i|add|remove|rm|uninstall|upgrade|update|up|ci|link|unlink|login|logout|exec|x|dlx|create|init|outdated|audit)$/;

function firstArg(args: string[]): string | undefined {
  return args.find((a) => !a.startsWith('-'));
}

/** True when an identical re-run with an unchanged workspace may be answered from the cache. */
export function isCacheableCommand(command: string): boolean {
  if (longRunningReason(command)) return false;
  const cmd = parseCommand(command);
  if (cmd.segments.some((s) => s.args.some((a) => !a.startsWith('-') && SIDE_EFFECT_ARG_RE.test(a)))) return false;
  // At least one real tool; `echo`/`cat` alone are not worth caching.
  if (!cmd.segments.some((s) => !BENIGN.has(s.program))) return false;
  for (const s of cmd.segments) {
    if (s.alias) continue; // decided by its package-manager segment
    const p = s.program;
    const sub = firstArg(s.args);
    if (BENIGN.has(p) || WRAPPERS.has(p) || TEST_TOOLS.has(p)) {
      if ((p === 'gradle' || p === 'gradlew') && s.args.some((a) => /^(?:run|bootRun|appRun|jettyRun)$/.test(a))) return false;
      if (/^mvn/.test(p) && s.args.some((a) => /:run$|^exec:|^jetty:/.test(a))) return false;
      continue;
    }
    if (p === 'git') {
      if (!sub || !['log', 'show', 'diff', 'status', 'reflog', 'blame', 'ls-files', 'shortlog', 'describe', 'rev-parse'].includes(sub)) return false;
      continue;
    }
    if (p === 'go') {
      if (!sub || !['test', 'build', 'vet'].includes(sub)) return false;
      continue;
    }
    if (p === 'cargo') {
      if (!sub || !['build', 'b', 'check', 'c', 'test', 't', 'clippy', 'doc', 'nextest', 'fmt'].includes(sub)) return false;
      continue;
    }
    if (p === 'dotnet') {
      if (!sub || !['build', 'test', 'msbuild', 'vstest', 'format'].includes(sub)) return false;
      continue;
    }
    if (p === 'next') {
      if (sub !== 'lint') return false;
      continue;
    }
    if (p === 'bazel' || p === 'bazelisk') {
      if (!sub || !['build', 'test', 'query', 'cquery', 'aquery', 'coverage'].includes(sub)) return false;
      continue;
    }
    if (p === 'sbt') {
      // sbt "testOnly x" / sbt test / sbt compile; `run`, `publish`, `release` stay uncached
      if (!s.args.length || !s.args.every((a) => a.startsWith('-') || /^(?:[\w-]+\/)?(?:test|testOnly|testQuick|compile|Test\/compile|clean|scalafmtCheck|scalafmtCheckAll)\b/.test(a))) return false;
      continue;
    }
    if (p === 'php') {
      // php artisan test / php vendor/bin/phpunit
      if (!/(?:^|\/)(?:phpunit|pest|paratest)$/.test(s.args[0] ?? '') && !(/artisan$/.test(s.args[0] ?? '') && s.args[1] === 'test')) return false;
      continue;
    }
    if (p === 'rake' || p === 'rails') {
      if (!sub || !/^(?:test|spec)(?::\S+)?$/.test(sub)) return false;
      continue;
    }
    if (p === 'npm' || p === 'yarn' || p === 'pnpm' || p === 'bun') {
      let script = sub;
      if (p === 'npm' || sub === 'run' || sub === 'run-script') {
        if (!sub || !['test', 't', 'tst', 'run', 'run-script'].includes(sub)) return false;
        if (sub === 'run' || sub === 'run-script') script = firstArg(s.args.slice(s.args.indexOf(sub) + 1));
      }
      if (!script || SCRIPT_DENY_RE.test(script) || /dev|start|serve|watch|deploy|publish/.test(script)) return false;
      continue;
    }
    // A segment we do not know (docker, curl, make, ./script.sh...) may depend on state outside the workspace.
    // `yarn jest` style aliases appear as extra segments and are covered by the checks above.
    return false;
  }
  return true;
}

const READ_ONLY_GIT = new Set(['log', 'show', 'diff', 'status', 'reflog', 'blame', 'ls-files', 'shortlog', 'describe', 'rev-parse']);
const READ_ONLY = new Set([
  'cd', 'pushd', 'popd', 'echo', 'printf', 'true', ':', 'grep', 'egrep', 'rg', 'head', 'tail', 'cat', 'sort', 'uniq', 'wc',
  'cut', 'tr', 'test', '[', 'chdir', 'set-location', 'sl', 'push-location', 'pop-location', 'write-output', 'select-object',
  'select-string', 'sls', 'where-object', 'sort-object', 'measure-object', 'get-content', 'gc', 'type', 'findstr', 'more',
]);

/**
 * Cacheable commands that only read (git log/diff/status/ls-files... piped through grep, head...): they cannot
 * change their own inputs, so the state before the run is the state their output belongs to, and the second
 * workspace fingerprint (a `git status` of the whole checkout, a second or more on a 50k-file repository) is skipped.
 */
export function isReadOnlyCommand(command: string): boolean {
  const cmd = parseCommand(command);
  if (!cmd.segments.length) return false;
  for (const s of cmd.segments) {
    if (s.program === 'git') {
      const sub = firstArg(s.args);
      if (!sub || !READ_ONLY_GIT.has(sub)) return false;
    } else if (!READ_ONLY.has(s.program)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// runCommand

function result(text: string, meta?: Record<string, unknown>): ToolResult {
  return { text, tokens: estimateTokens(text), meta };
}

function displayCommand(command: string): string {
  const one = command.replace(/\s*\n\s*/g, ' ⏎ ').replace(/\s+/g, ' ').trim();
  return one.length > 120 ? `${one.slice(0, 119)}…` : one;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Absolute paths under the repo root -> repo-relative (saves tokens, matches the `path:line` convention).
 * Windows: matches the root with either separator (and JSON-escaped), ignoring case, and turns the rest of the
 * path into forward slashes (`C:\repo\src\a.ts:3` -> `src/a.ts:3`).
 */
export function relativizeRoot(text: string, roots: string[], platform: NodeJS.Platform = process.platform): string {
  let out = text;
  const win = platform === 'win32';
  const ci = win || platform === 'darwin';
  for (const root of roots) {
    const trimmed = root ? root.replace(/[\\/]+$/, '') : '';
    // Never strip a bare filesystem root (`/`, `C:`): it would mangle every absolute path in the output.
    if (!trimmed || /^[A-Za-z]:$/.test(trimmed)) continue;
    const variants = new Set([trimmed]);
    if (win) {
      variants.add(trimmed.replace(/\\/g, '/'));
      variants.add(trimmed.replace(/\//g, '\\'));
      variants.add(trimmed.replace(/\//g, '\\').replace(/\\/g, '\\\\'));
    }
    for (const v of variants) {
      const hay = ci ? out.toLowerCase() : out;
      if (!hay.includes(ci ? v.toLowerCase() : v)) continue;
      const re = new RegExp(`${escapeRe(v)}(?:[\\\\/]+([^\\s:'"),\\]<>|]*)|(?=[\\s:'"),\\]]|$))`, ci ? 'gmi' : 'gm');
      out = out.replace(re, (_m, rest: string | undefined) => {
        if (rest === undefined || rest === '') return '.';
        return win ? rest.replace(/\\+/g, '/') : rest;
      });
    }
  }
  return out;
}

function formatSecs(ms: number): string {
  const s = ms / 1000;
  return s >= 100 ? String(Math.round(s)) : s.toFixed(1);
}

function normalizeRelCwd(root: string, cwd: string | undefined): { rel: string; abs: string } | undefined {
  const abs = resolve(root, cwd && cwd.trim() ? cwd.trim() : '.');
  const rel = relative(root, abs);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return { rel: rel.split(sep).join('/'), abs };
}

interface RenderInput {
  command: string;
  exitCode: number;
  durationMs: number;
  /** Normalized output (as stored in the log). */
  normalized: string;
  baselineTokens: number;
  handle: string;
  maxTokens: number;
  root: string;
  timedOutSec?: number;
  cancelled?: boolean;
  droppedChars?: number;
}

function rootVariants(root: string): string[] {
  const roots = new Set([root]);
  // realpath: macOS /var -> /private/var; native realpath also expands Windows 8.3 short names (RUNNER~1)
  // and fixes the case, which is what compilers and test runners print.
  for (const real of [realpathSync, realpathSync.native]) {
    try {
      roots.add(real(root));
    } catch {
      /* keep configured root */
    }
  }
  return [...roots];
}

const TIMEOUT_MARKER_RE = /\n?\[kopt\] (?:timed out after \d+s|cancelled) – process tree killed$/;

/**
 * One header line + output. The header carries what the model cannot see elsewhere: the exit code, the duration,
 * and for a compressed result the size of the full log (the command itself is in the model's own tool call).
 * Small outputs, and outputs a filter cannot make smaller than themselves, are returned as they are.
 */
function renderRun(o: RenderInput): { text: string; filter: string; elided: boolean } {
  let forModel = relativizeRoot(o.normalized, rootVariants(o.root));
  // The stored log ends with a timeout marker (for kopt_read <handle>); the header line below already says it.
  if (o.timedOutSec || o.cancelled) forModel = forModel.replace(TIMEOUT_MARKER_RE, '');
  const secs = formatSecs(o.durationMs);
  const status = o.timedOutSec
    ? `exit ${o.exitCode} · timed out after ${o.timedOutSec}s, process tree killed; output so far`
    : o.cancelled
      ? `exit ${o.exitCode} · cancelled after ${secs}s, process tree killed; output so far`
      : `exit ${o.exitCode}${o.durationMs >= 1000 ? ` · ${secs}s` : ''}`;
  const trailer = `full output: kopt_read ${o.handle} (grep=<regex> filters it)`;
  const rawTokens = estimateTokens(forModel);
  const verbatim = (): { text: string; filter: string; elided: boolean } => {
    const body = forModel.trim() ? forModel : '(no output)';
    return { text: `${status}\n${body}`, filter: 'raw', elided: false };
  };
  const cut = (o.droppedChars ?? 0) > 0;
  const rawHead = `${status} · raw ~${o.baselineTokens} tok`;
  const reserve = estimateTokens(rawHead) + estimateTokens(trailer) + 3;
  if (!cut && rawTokens <= SMALL_OUTPUT_TOKENS && estimateTokens(status) + rawTokens + 1 <= o.maxTokens) {
    // A passing run of a known test/build/lint tool is its verdict line (`3 passed in 0.12s`) even when short:
    // the session banner and progress lines around it carry nothing. Anything else small comes back as is.
    if (o.exitCode === 0 && !o.timedOutSec && !o.cancelled) {
      const c = compressNormalized(o.command, forModel, 0, Math.max(30, o.maxTokens - reserve), { passthroughTokens: 0 });
      if (VERDICT_FILTERS.has(c.filter) && (estimateTokens(c.text) + estimateTokens(trailer)) * 2 <= rawTokens) {
        return { text: [rawHead, c.text, trailer].join('\n'), filter: c.filter, elided: true };
      }
    }
    return verbatim();
  }

  const compressed = compressNormalized(o.command, forModel, o.exitCode, Math.max(30, o.maxTokens - reserve));
  const elided = compressed.filter !== 'none' && (compressed.text !== forModel || cut);
  // Never return more than the output itself: when the filter saves less than its header and pointer cost,
  // the raw output (if it fits the budget) is the better answer.
  if (!cut && estimateTokens(compressed.text) + estimateTokens(trailer) + 8 >= rawTokens && estimateTokens(status) + rawTokens + 1 <= o.maxTokens) {
    return verbatim();
  }
  let text = [elided ? rawHead : status, compressed.text, elided ? trailer : ''].filter(Boolean).join('\n');
  if (estimateTokens(text) > o.maxTokens) text = truncateLines(text, o.maxTokens).text;
  return { text, filter: compressed.filter, elided };
}

function refuseLongRunning(command: string, reason: string): ToolResult {
  const text =
    `kopt_run: not run, \`${displayCommand(command)}\` never exits (${reason}). ` +
    'Run it in the background with the shell, or pass timeoutSec to capture its first seconds.';
  return result(text, { refused: 'long-running', reason, exitCode: 2 });
}

interface Execution {
  res: ExecResult;
  result: ToolResult;
}

/** Identical commands (same command line and cwd) running in this process: a retry joins the run in progress. */
const inflight = new Map<string, { job: Promise<Execution>; follow: (signal?: AbortSignal) => void }>();

/**
 * Cancellation shared by every caller waiting for one run: the command is killed only once all of them have
 * cancelled (a caller without a signal, e.g. the CLI, never does). A parallel identical call keeps the run alive
 * when the first caller's MCP request is cancelled.
 */
function sharedCancel(): { signal: AbortSignal; follow: (signal?: AbortSignal) => void } {
  const controller = new AbortController();
  let waiting = 0;
  let pinned = false;
  return {
    signal: controller.signal,
    follow(signal) {
      if (!signal) {
        pinned = true;
        return;
      }
      waiting++;
      const drop = () => {
        if (--waiting === 0 && !pinned) controller.abort(signal.reason);
      };
      if (signal.aborted) drop();
      else signal.addEventListener('abort', drop, { once: true });
    },
  };
}

export interface RunOptions {
  /** Cancels the command (e.g. the MCP request was cancelled): its process tree is killed. */
  signal?: AbortSignal;
}

export async function runCommand(p: RunParams, ctx: ToolContext, opts: RunOptions = {}): Promise<ToolResult> {
  const call = ctx.ledger.tick();
  const cfg = ctx.config;
  const command = String(p.command ?? '').trim();
  // Nothing ran: exit code 2 (usage error) so `kopt run` in a script fails too.
  if (!command) return result('kopt_run: empty command', { exitCode: 2 });
  const loc = normalizeRelCwd(cfg.root, p.cwd);
  if (!loc) return result(`kopt_run: cwd must be inside the repo (got ${p.cwd})`, { exitCode: 2 });
  if (!existsSync(loc.abs)) return result(`kopt_run: cwd not found: ${loc.rel}`, { exitCode: 2 });
  const maxTokens = Math.max(MIN_BUDGET, Math.floor(p.maxTokens ?? cfg.budgets.run));
  const timeoutSec = Math.min(MAX_TIMEOUT_SEC, Math.max(1, Math.floor(p.timeoutSec ?? DEFAULT_TIMEOUT_SEC)));
  // An explicit timeoutSec is the way to run a server or watcher for a bounded time (e.g. to see it start).
  if (p.timeoutSec === undefined) {
    const why = longRunningReason(command);
    if (why) return refuseLongRunning(command, why);
  }
  const key = sha1(`${command.replace(/\s+/g, ' ')}\0${loc.rel}`);

  // A client that timed out and retried (or a parallel identical call) waits for the run in progress instead of
  // starting the same build twice.
  const running = p.fresh ? undefined : inflight.get(key);
  if (running) {
    running.follow(opts.signal);
    const joined = await running.job;
    ctx.ledger.markShown(`run:${key}`, sha1(joined.result.text));
    return { ...joined.result, meta: { ...joined.result.meta, joined: true } };
  }

  const store = new OutputStore(cfg.dataDir);
  const cacheable = isCacheableCommand(command);
  const readOnly = cacheable && isReadOnlyCommand(command);
  const exclude = [cfg.dataDir];
  const cancel = sharedCancel();
  // Registered before the (asynchronous) fingerprint, so an identical call arriving meanwhile joins this one.
  const job = (async (): Promise<Execution & { cached?: boolean }> => {
    // Taken before the run: compared with the state after it, so an edit made while the command runs is never
    // attached to this output.
    const before = cacheable ? await fingerprintPartsAsync(cfg.root, exclude) : undefined;
    if (before && !p.fresh) {
      const hit = cachedResult(store, key, before.key, maxTokens, ctx);
      if (hit) return { res: undefined as unknown as ExecResult, result: hit, cached: true };
    }
    return execute({ command, loc, key, call, cacheable, readOnly, before, timeoutSec, maxTokens, store, exclude, ctx, signal: cancel.signal });
  })();
  const entry = { job, follow: cancel.follow };
  inflight.set(key, entry);
  cancel.follow(opts.signal);
  try {
    const { result: r, cached } = await job;
    // a cached answer did its own ledger bookkeeping (a "same as run X" line is never re-marked)
    if (!cached) ctx.ledger.markShown(`run:${key}`, sha1(r.text));
    return r;
  } finally {
    if (inflight.get(key) === entry) inflight.delete(key);
  }
}

interface ExecuteInput {
  command: string;
  loc: { rel: string; abs: string };
  key: string;
  call: number;
  cacheable: boolean;
  /** Only reads: the state before the run is its state after (no second fingerprint). */
  readOnly: boolean;
  before: FingerprintParts | undefined;
  timeoutSec: number;
  maxTokens: number;
  store: OutputStore;
  exclude: string[];
  ctx: ToolContext;
  signal?: AbortSignal;
}

async function execute(i: ExecuteInput): Promise<Execution> {
  const cfg = i.ctx.config;
  const res = await execCapture({ command: i.command, cwd: i.loc.abs, timeoutMs: i.timeoutSec * 1000, signal: i.signal });
  let normalized = normalizeOutput(res.output);
  if (res.timedOut) normalized = `${normalized}\n[kopt] timed out after ${i.timeoutSec}s – process tree killed`.trim();
  else if (res.cancelled) normalized = `${normalized}\n[kopt] cancelled – process tree killed`.trim();
  const baselineTokens = estimateTokens(normalized);
  const rawTokens = estimateTokens(res.output);

  // State after the run: cached only when the inputs did not change while the command ran. The command's own
  // ignored outputs (target/, dist/...) are part of the stored key, so a later rebuild invalidates it.
  const after = i.cacheable && !res.timedOut && !res.cancelled && !res.spawnError ? (i.readOnly ? i.before : await fingerprintPartsAsync(cfg.root, i.exclude)) : undefined;
  const storable = !!after && !!i.before && after.inputs === i.before.inputs;

  // Everything below is synchronous: no other kopt_run of this process can interleave with the index update.
  const idx = i.store.load();
  const handle = i.store.newHandle(idx, `${i.command}\0${after?.key ?? ''}`);
  const { text, filter, elided } = renderRun({
    command: i.command, exitCode: res.exitCode, durationMs: res.durationMs, normalized, baselineTokens, handle, maxTokens: i.maxTokens,
    root: cfg.root, timedOutSec: res.timedOut ? i.timeoutSec : undefined, cancelled: res.cancelled, droppedChars: res.droppedChars,
  });

  try {
    i.store.writeLog(idx, handle, normalized, i.command);
    if (storable) {
      const entry: RunEntry = {
        command: i.command, cwd: i.loc.rel, fingerprint: after!.key, handle, exitCode: res.exitCode, text, call: i.call, at: Date.now(),
        baselineTokens, rawTokens, filter, durationMs: res.durationMs, maxTokens: i.maxTokens, droppedChars: res.droppedChars,
      };
      idx.runs[i.key] = entry;
    } else delete idx.runs[i.key];
    i.store.save(idx);
  } catch (err) {
    process.stderr.write(`kopt: cannot store output: ${(err as Error).message}\n`);
  }
  return {
    res,
    result: {
      text,
      tokens: estimateTokens(text),
      baselineTokens,
      meta: {
        handle, filter, exitCode: res.exitCode, durationMs: res.durationMs, cached: false, cacheable: i.cacheable, stored: storable, elided,
        rawTokens, timedOut: res.timedOut, cancelled: res.cancelled, droppedChars: res.droppedChars, outputChars: res.totalChars,
      },
    },
  };
}

function cachedResult(store: OutputStore, key: string, fp: string, maxTokens: number, ctx: ToolContext): ToolResult | undefined {
  const idx = store.load();
  const entry = idx.runs[key];
  if (!entry || entry.fingerprint !== fp || !store.has(entry.handle)) return undefined;
  const out = idx.outputs[entry.handle];
  if (out) {
    out.used = Date.now();
    try {
      store.save(idx);
    } catch {
      /* LRU bookkeeping is best effort */
    }
  }
  const ledgerKey = `run:${key}`;
  const meta = { handle: entry.handle, filter: entry.filter, exitCode: entry.exitCode, cached: true, cacheable: true, rawTokens: entry.rawTokens };
  if (ctx.ledger.wasShown(ledgerKey, sha1(entry.text)) && entry.maxTokens === maxTokens && estimateTokens(entry.text) > SHORT_RESEND_TOKENS) {
    // Probably still in the model's context: one line instead of re-sending the same result. It carries the
    // verdict line, because the ledger is per server process and a new chat (or a compacted one) never saw the
    // first answer. Not re-marked, so the dedup window keeps counting from the call that sent the full text.
    const verdict = entry.text.split('\n')[1]?.trim();
    const text =
      `exit ${entry.exitCode} · same as run ${entry.handle} (call ${ctx.ledger.shownAt(ledgerKey)}), no file changed since` +
      `${verdict ? `: ${capLine(verdict, 200)}` : ''} · log: kopt_read ${entry.handle}; fresh:true re-runs`;
    return { text, tokens: estimateTokens(text), baselineTokens: entry.baselineTokens, meta };
  }
  const prefix = `cached run ${entry.handle}: no file changed since (fresh:true re-runs)`;
  let body = entry.text;
  if (entry.maxTokens !== maxTokens || estimateTokens(`${prefix}\n${body}`) > maxTokens) {
    // Different budget requested (or no room for the prefix): re-compress the stored log, no re-execution.
    const log = store.readLog(entry.handle);
    if (log === undefined) return undefined;
    body = renderRun({
      command: entry.command, exitCode: entry.exitCode, durationMs: entry.durationMs ?? 0, normalized: log,
      baselineTokens: entry.baselineTokens, handle: entry.handle, maxTokens: Math.max(30, maxTokens - estimateTokens(prefix) - 1),
      root: ctx.config.root, droppedChars: entry.droppedChars,
    }).text;
  } else {
    ctx.ledger.markShown(ledgerKey, sha1(entry.text));
  }
  const text = `${prefix}\n${body}`;
  return { text, tokens: estimateTokens(text), baselineTokens: entry.baselineTokens, meta };
}
