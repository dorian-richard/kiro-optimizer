// compress: kopt_run (run a command, return a compact verdict), kopt_expand (more of a stored log),
// pure output compression and the workspace fingerprint used to skip identical re-runs.

import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ExpandParams, RunParams } from '../core/api.js';
import type { ToolContext } from '../core/context.js';
import { estimateTokens, truncateLines } from '../core/tokens.js';
import type { ToolResult } from '../core/types.js';
import { parseCommand } from './command.js';
import { expandOutput } from './expand.js';
import { workspaceFingerprint as fingerprint } from './fingerprint.js';
import { compressNormalized } from './filters/index.js';
import { normalizeOutput } from './normalize.js';
import { OutputStore, sha1, type RunEntry } from './outputs.js';
import { DEFAULT_TIMEOUT_SEC, execCapture } from './runner.js';

export { normalizeOutput } from './normalize.js';
export { parseCommand } from './command.js';
export { killActiveCommands } from './runner.js';

const MIN_BUDGET = 60;
const MAX_TIMEOUT_SEC = 6 * 3600;

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
]);
/** Goals/tasks/subcommands with effects outside the workspace (case-sensitive: `-c Release` is a build config). */
const SIDE_EFFECT_ARG_RE = /^(?:deploy|publish\w*|release|push|upload\w*|login|logout)$|^(?:deploy|release|site-deploy|docker|jib):/;
const WATCH_RE = /--watch(?:All)?\b|(?:^|\s)-w(?:\s|$)|--serve\b/;
const SCRIPT_DENY_RE = /^(?:dev|start|serve|watch|preview|deploy|publish|release|install|i|add|remove|rm|uninstall|upgrade|update|up|ci|link|unlink|login|logout|exec|x|dlx|create|init|outdated|audit)$/;

function firstArg(args: string[]): string | undefined {
  return args.find((a) => !a.startsWith('-'));
}

/** True when an identical re-run with an unchanged workspace may be answered from the cache. */
export function isCacheableCommand(command: string): boolean {
  if (WATCH_RE.test(command)) return false;
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

// ---------------------------------------------------------------------------------------------------------------
// runCommand

function result(text: string, meta?: Record<string, unknown>): ToolResult {
  return { text, tokens: estimateTokens(text), meta };
}

function displayCommand(command: string): string {
  const one = command.replace(/\s*\n\s*/g, ' ⏎ ').replace(/\s+/g, ' ').trim();
  return one.length > 200 ? `${one.slice(0, 199)}…` : one;
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
  relCwd: string;
  exitCode: number;
  durationMs: number;
  /** Normalized output (as stored in the log). */
  normalized: string;
  baselineTokens: number;
  handle: string;
  maxTokens: number;
  root: string;
  timedOutSec?: number;
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

/** Header + compressed body (+ expand pointer when something was elided), within maxTokens. */
function renderRun(o: RenderInput): { text: string; filter: string; elided: boolean } {
  let forModel = relativizeRoot(o.normalized, rootVariants(o.root));
  // The stored log ends with a timeout marker (for kopt_expand); the header line below already says it.
  if (o.timedOutSec) forModel = forModel.replace(/\n?\[kopt\] timed out after \d+s – process tree killed$/, '');
  const secs = formatSecs(o.durationMs);
  const head = (tok: number) =>
    `$ ${o.relCwd ? `cd ${o.relCwd} && ` : ''}${displayCommand(o.command)} · exit ${o.exitCode} · ${secs}s · ~${tok} tok (raw ~${o.baselineTokens})`;
  const trailer = `full output: kopt_expand ${o.handle}`;
  const timeoutLine = o.timedOutSec ? `timed out after ${o.timedOutSec}s (process tree killed); output so far:` : '';
  const reserve = estimateTokens(head(99999)) + estimateTokens(trailer) + estimateTokens(timeoutLine) + 3;
  const compressed = compressNormalized(o.command, forModel, o.exitCode, Math.max(30, o.maxTokens - reserve));
  const elided = compressed.filter !== 'none' && (compressed.text !== forModel || (o.droppedChars ?? 0) > 0);
  const body = [timeoutLine, compressed.text].filter(Boolean).join('\n');
  const build = (tok: number) => [head(tok), body, elided ? trailer : ''].filter(Boolean).join('\n');
  // The header states the result's own size: iterate until the number is stable.
  let text = build(0);
  for (let k = 0, tok = estimateTokens(text); k < 3; k++) {
    text = build(tok);
    const t = estimateTokens(text);
    if (t === tok) break;
    tok = t;
  }
  if (estimateTokens(text) > o.maxTokens) text = truncateLines(text, o.maxTokens).text;
  return { text, filter: compressed.filter, elided };
}

export async function runCommand(p: RunParams, ctx: ToolContext): Promise<ToolResult> {
  const call = ctx.ledger.tick();
  const cfg = ctx.config;
  const command = String(p.command ?? '').trim();
  if (!command) return result('kopt_run: empty command');
  if (process.env.KOPT_DISABLE_RUN === '1') {
    return result('kopt_run is disabled on this server (central mode) – run the command with the local shell tool', { refused: true });
  }
  const loc = normalizeRelCwd(cfg.root, p.cwd);
  if (!loc) return result(`kopt_run: cwd must be inside the repo (got ${p.cwd})`);
  if (!existsSync(loc.abs)) return result(`kopt_run: cwd not found: ${loc.rel}`);
  const maxTokens = Math.max(MIN_BUDGET, Math.floor(p.maxTokens ?? cfg.budgets.run));
  const store = new OutputStore(cfg.dataDir);
  const key = sha1(`${command.replace(/\s+/g, ' ')}\0${loc.rel}`);
  const cacheable = isCacheableCommand(command);
  const exclude = [cfg.dataDir];

  if (cacheable && !p.fresh) {
    const hit = cachedResult(store, key, workspaceFingerprint(cfg.root, exclude), maxTokens, ctx);
    if (hit) return hit;
  }

  const timeoutSec = Math.min(MAX_TIMEOUT_SEC, Math.max(1, Math.floor(p.timeoutSec ?? DEFAULT_TIMEOUT_SEC)));
  const res = await execCapture({ command, cwd: loc.abs, timeoutMs: timeoutSec * 1000 });
  let normalized = normalizeOutput(res.output);
  if (res.timedOut) normalized = `${normalized}\n[kopt] timed out after ${timeoutSec}s – process tree killed`.trim();
  const baselineTokens = estimateTokens(normalized);
  const rawTokens = estimateTokens(res.output);

  // Everything below is synchronous: no other kopt_run of this process can interleave with the index update.
  const idx = store.load();
  // Post-run state: if the command itself touched untracked files, the next identical call still matches.
  const storable = cacheable && !res.timedOut && !res.spawnError;
  const fpAfter = storable ? workspaceFingerprint(cfg.root, exclude) : '';
  const handle = store.newHandle(idx, `${command}\0${fpAfter}`);
  const { text, filter, elided } = renderRun({
    command, relCwd: loc.rel, exitCode: res.exitCode, durationMs: res.durationMs, normalized, baselineTokens, handle, maxTokens,
    root: cfg.root, timedOutSec: res.timedOut ? timeoutSec : undefined, droppedChars: res.droppedChars,
  });

  try {
    store.writeLog(idx, handle, normalized, command);
    if (storable) {
      const entry: RunEntry = {
        command, cwd: loc.rel, fingerprint: fpAfter, handle, exitCode: res.exitCode, text, call, at: Date.now(), baselineTokens,
        rawTokens, filter, durationMs: res.durationMs, maxTokens, droppedChars: res.droppedChars,
      };
      idx.runs[key] = entry;
    } else delete idx.runs[key];
    store.save(idx);
  } catch (err) {
    process.stderr.write(`kopt: cannot store output: ${(err as Error).message}\n`);
  }
  ctx.ledger.markShown(`run:${key}`, sha1(text));
  return {
    text,
    tokens: estimateTokens(text),
    baselineTokens,
    meta: {
      handle, filter, exitCode: res.exitCode, durationMs: res.durationMs, cached: false, cacheable, elided,
      rawTokens, timedOut: res.timedOut, droppedChars: res.droppedChars, outputChars: res.totalChars,
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
  if (ctx.ledger.wasShown(ledgerKey, sha1(entry.text)) && entry.maxTokens === maxTokens) {
    // Still in the model's context: one line instead of re-sending the same verdict. Not re-marked, so the
    // dedup window keeps counting from the call that actually sent the full text.
    const text = `identical to previous run ${entry.handle} (call ${ctx.ledger.shownAt(ledgerKey)}, exit ${entry.exitCode}, no file changed since) – pass fresh:true to re-run`;
    return { text, tokens: estimateTokens(text), baselineTokens: entry.baselineTokens, meta };
  }
  const prefix = `identical to previous run ${entry.handle} (no file changed since) – pass fresh:true to re-run`;
  let body = entry.text;
  if (entry.maxTokens !== maxTokens || estimateTokens(`${prefix}\n${body}`) > maxTokens) {
    // Different budget requested (or no room for the prefix): re-compress the stored log, no re-execution.
    const log = store.readLog(entry.handle);
    if (log === undefined) return undefined;
    body = renderRun({
      command: entry.command, relCwd: entry.cwd, exitCode: entry.exitCode, durationMs: entry.durationMs ?? 0, normalized: log,
      baselineTokens: entry.baselineTokens, handle: entry.handle, maxTokens: Math.max(30, maxTokens - estimateTokens(prefix) - 1),
      root: ctx.config.root, droppedChars: entry.droppedChars,
    }).text;
  } else {
    ctx.ledger.markShown(ledgerKey, sha1(entry.text));
  }
  const text = `${prefix}\n${body}`;
  return { text, tokens: estimateTokens(text), baselineTokens: entry.baselineTokens, meta };
}
