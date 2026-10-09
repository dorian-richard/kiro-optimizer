#!/usr/bin/env node
// In-container driver for the competitor benchmark.
//
// Runs INSIDE a sandboxed Docker container (never on the host). For one tool and one repo it:
//   1. copies the read-only checkout (/src) to a writable work dir, because every tool writes its
//      index next to the code (.kirograph/, .codegraph/, .kopt/);
//   2. builds the index with the tool's own CLI and times it (indexMs);
//   3. for each task, starts a FRESH MCP server over stdio (one agent session = one first step),
//      calls the tool's primary context tool once with the task input, and records the exact text
//      the agent would receive;
//   4. writes <label>-<repo>[-question].jsonl and <label>-<repo>.meta.json to /results.
//
// Usage (see bench/competitors/run.sh):
//   node /opt/harness/run-tool.mjs --tool kirograph|codegraph|kopt --repo <name>
//        [--mode default|embeddings] [--inputs search,question] [--tasks /tasks/<repo>.json]
//        [--src /src] [--work /work] [--out /results] [--only id1,id2]
//        [--index-timeout 5400] [--query-timeout 300]

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// ---------------------------------------------------------------------------------------------
// arguments

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument: ${a}`);
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const TOOL = String(args.tool ?? '');
const REPO = String(args.repo ?? '');
const MODE = String(args.mode ?? 'default');
const INPUTS = String(args.inputs ?? 'search').split(',').filter(Boolean);
const TASKS_FILE = String(args.tasks ?? `/tasks/${REPO}.json`);
const SRC = String(args.src ?? '/src');
const WORK = String(args.work ?? '/work');
const OUT = String(args.out ?? '/results');
const ONLY = args.only ? new Set(String(args.only).split(',')) : null;
const INDEX_TIMEOUT_MS = Number(args['index-timeout'] ?? 5400) * 1000;
const QUERY_TIMEOUT_MS = Number(args['query-timeout'] ?? 300) * 1000;
const CHARS_PER_TOKEN = 3.0; // same estimator as `kopt bench` (src/core/tokens.ts)

if (!TOOL || !REPO) {
  process.stderr.write('usage: run-tool.mjs --tool <kirograph|codegraph|kopt> --repo <name> [--mode default|embeddings]\n');
  process.exit(2);
}
for (const f of INPUTS) {
  if (f !== 'search' && f !== 'question') throw new Error(`--inputs accepts search and/or question, got ${f}`);
}

const ROOT = join(WORK, REPO);
const LABEL = MODE === 'default' ? TOOL : `${TOOL}-${MODE}`;
const LOG_DIR = join(OUT, 'logs');
const LOG_FILE = join(LOG_DIR, `${LABEL}-${REPO}.log`);

// Environment for every tool process. Network is already off (--network none); these only stop
// tools from trying (and timing out) and keep output free of ANSI colour codes.
const TOOL_ENV = {
  ...process.env,
  NO_COLOR: '1',
  FORCE_COLOR: '0',
  CI: '1',
  DO_NOT_TRACK: '1',
  CODEGRAPH_TELEMETRY: '0',
  CODEGRAPH_NO_DOWNLOAD: '1',
  HF_HUB_OFFLINE: '1',
  TRANSFORMERS_OFFLINE: '1',
};

// ---------------------------------------------------------------------------------------------
// tool adapters: how a user indexes, how Kiro launches the MCP server, which tool an agent calls

function patchJson(file, patch) {
  const cur = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...cur, ...patch }, null, 2) + '\n');
}

const ADAPTERS = {
  kirograph: {
    pkg: 'kirograph',
    modes: ['default', 'embeddings'],
    // `kirograph init` writes .kirograph/config.json with every opt-in feature off (embeddings off).
    // The interactive installer (`kirograph install`) pre-selects "Core only" and then "Semantic
    // embeddings: yes" with nomic-embed-text-v1.5 + the cosine engine: that is the `embeddings` mode.
    index(root, mode) {
      const steps = [{ cmd: 'kirograph', args: ['init', root] }];
      if (mode === 'embeddings') {
        steps.push({
          fn: () =>
            patchJson(join(root, '.kirograph', 'config.json'), {
              enableEmbeddings: true,
              embeddingModel: 'nomic-ai/nomic-embed-text-v1.5',
              embeddingDim: 768,
              semanticEngine: 'cosine',
              useVecIndex: false,
            }),
          label: 'enable embeddings in .kirograph/config.json',
        });
      }
      steps.push({ cmd: 'kirograph', args: ['index', root] });
      return steps;
    },
    indexDirs: (root) => [join(root, '.kirograph')],
    status: (root) => ({ cmd: 'kirograph', args: ['status', root] }),
    // What `kirograph install --target kiro` writes to .kiro/settings/mcp.json.
    server: (root) => ({ command: 'kirograph', args: ['serve', '--mcp', '--path', root] }),
    tool: 'kirograph_context',
    // Defaults of the tool: maxNodes 20, detail "full" (code snippets included).
    toolArgs: (input) => ({ task: input }),
  },
  codegraph: {
    pkg: '@colbymchenry/codegraph',
    modes: ['default'],
    // `codegraph init` creates .codegraph/ and builds the full graph in one step. No embeddings exist.
    index: (root) => [{ cmd: 'codegraph', args: ['init', '--yes', root] }],
    indexDirs: (root) => [join(root, '.codegraph')],
    status: (root) => ({ cmd: 'codegraph', args: ['status', root] }),
    // What `codegraph install` writes for every agent: {command: codegraph, args: [serve, --mcp]};
    // the project is resolved from the client (roots/rootUri) or the working directory.
    server: () => ({ command: 'codegraph', args: ['serve', '--mcp'] }),
    tool: 'codegraph_explore',
    // Defaults of the tool: maxFiles from the size tier, ~24K-char output cap on repos >= 500 files.
    toolArgs: (input) => ({ query: input }),
  },
  kopt: {
    pkg: 'kiro-optimizer',
    modes: ['default'],
    index: (root) => [{ cmd: 'kopt', args: ['index', '--root', root] }],
    indexDirs: (root) => [
      join(root, '.kopt'),
      join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'kopt'),
      join(homedir(), '.kopt'),
    ],
    status: null, // the `kopt index` summary line is kept instead
    server: (root) => ({ command: 'kopt', args: ['mcp', '--root', root] }),
    tool: 'kopt_find',
    // Same call as the `kopt-pack` strategy of `kopt bench`: default budget (budgets.pack).
    toolArgs: (input) => ({ query: input, mode: 'pack' }),
  },
};

const adapter = ADAPTERS[TOOL];
if (!adapter) throw new Error(`unknown tool ${TOOL} (known: ${Object.keys(ADAPTERS).join(', ')})`);
if (!adapter.modes.includes(MODE)) throw new Error(`tool ${TOOL} has no mode ${MODE} (modes: ${adapter.modes.join(', ')})`);

// ---------------------------------------------------------------------------------------------
// helpers

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
const estTokens = (s) => (s ? Math.ceil(s.length / CHARS_PER_TOKEN) : 0);
const now = () => performance.now();

function log(line) {
  appendFileSync(LOG_FILE, line.endsWith('\n') ? line : line + '\n');
}

function tail(s, max) {
  return s.length > max ? '…' + s.slice(s.length - max) : s;
}

function dirSize(p) {
  if (!existsSync(p)) return 0;
  const st = lstatSync(p);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const e of readdirSync(p)) total += dirSize(join(p, e));
  return total;
}

function run(cmd, argv, opts = {}) {
  const t0 = now();
  const r = spawnSync(cmd, argv, {
    cwd: opts.cwd ?? ROOT,
    env: TOOL_ENV,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: opts.timeout ?? INDEX_TIMEOUT_MS,
    maxBuffer: 256 * 1024 * 1024,
  });
  const ms = Math.round(now() - t0);
  const out = stripAnsi(`${r.stdout ?? ''}${r.stderr ?? ''}`);
  log(`$ ${cmd} ${argv.join(' ')}  (exit ${r.status}${r.signal ? `, signal ${r.signal}` : ''}, ${ms} ms)\n${tail(out, 20000)}`);
  return { ms, status: r.status, signal: r.signal, error: r.error ? String(r.error.message ?? r.error) : null, out };
}

/** Like run(), but asynchronous with a heartbeat on stdout (index steps can take an hour). */
function runLong(cmd, argv, opts = {}) {
  return new Promise((resolve) => {
    const t0 = now();
    const timeout = opts.timeout ?? INDEX_TIMEOUT_MS;
    const child = spawn(cmd, argv, { cwd: opts.cwd ?? ROOT, env: TOOL_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const keep = (d) => {
      out += d.toString();
      if (out.length > 4_000_000) out = out.slice(-2_000_000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let signal = null;
    const beat = setInterval(() => {
      process.stdout.write(`  … ${cmd} ${argv[0]} running for ${Math.round((now() - t0) / 1000)} s\n`);
    }, 60000);
    const killer = setTimeout(() => {
      signal = 'SIGKILL (timeout)';
      child.kill('SIGKILL');
    }, timeout);
    const done = (status, error) => {
      clearInterval(beat);
      clearTimeout(killer);
      const ms = Math.round(now() - t0);
      const clean = stripAnsi(out);
      log(`$ ${cmd} ${argv.join(' ')}  (exit ${status}${signal ? `, signal ${signal}` : ''}, ${ms} ms)\n${tail(clean, 20000)}`);
      resolve({ ms, status, signal, error, out: clean });
    };
    child.on('error', (e) => done(null, String(e.message ?? e)));
    child.on('close', (code, sig) => {
      if (sig && !signal) signal = sig;
      done(code, null);
    });
  });
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function p90(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.9 * s.length) - 1)];
}

function textOf(result) {
  // What Kiro forwards to the model: the text content items, in order.
  const items = Array.isArray(result?.content) ? result.content : [];
  return items
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
}

async function withSession(fn) {
  const spec = adapter.server(ROOT);
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    cwd: ROOT,
    env: TOOL_ENV,
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (d) => {
    if (stderr.length < 200000) stderr += d.toString();
  });
  // The client advertises no `roots` capability, like a minimal MCP host; tools fall back to
  // --path / the working directory, which is the project root.
  const client = new Client({ name: 'kopt-competitor-bench', version: '1.0.0' }, { capabilities: {} });
  const t0 = now();
  try {
    await client.connect(transport, { timeout: QUERY_TIMEOUT_MS });
    const startupMs = Math.round(now() - t0);
    return await fn(client, startupMs);
  } finally {
    try {
      await client.close();
    } catch {
      /* server already gone */
    }
    if (stderr.trim()) log(`[server stderr]\n${tail(stripAnsi(stderr), 8000)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// main

async function main() {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
  writeFileSync(LOG_FILE, `# ${LABEL} on ${REPO} — ${new Date().toISOString()}\n`);

  const taskFile = JSON.parse(readFileSync(TASKS_FILE, 'utf8'));
  const tasks = taskFile.tasks.filter((t) => !ONLY || ONLY.has(t.id));
  const errors = [];

  const toolVersion = (() => {
    try {
      const pj = JSON.parse(readFileSync(join('/opt/tool/node_modules', adapter.pkg, 'package.json'), 'utf8'));
      return pj.version;
    } catch {
      try {
        return JSON.parse(readFileSync('/opt/tool/package.json', 'utf8')).version;
      } catch {
        return null;
      }
    }
  })();

  // 1. writable copy of the checkout (not timed as indexing)
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  const copy = run('cp', ['-a', `${SRC}/.`, ROOT], { cwd: WORK, timeout: 600000 });
  if (copy.status !== 0) throw new Error(`copy of ${SRC} failed: ${copy.out}`);
  const headCommit = run('git', ['-c', `safe.directory=${ROOT}`, 'rev-parse', 'HEAD'], { timeout: 30000 }).out.trim() || null;

  // 2. index
  const indexSteps = [];
  let lastIndexOut = '';
  let indexMs = 0;
  let indexOk = true;
  for (const step of adapter.index(ROOT, MODE)) {
    if (step.fn) {
      try {
        step.fn();
        indexSteps.push({ step: step.label, ok: true });
      } catch (e) {
        indexOk = false;
        errors.push(`${step.label}: ${e.message}`);
        break;
      }
      continue;
    }
    const r = await runLong(step.cmd, step.args);
    lastIndexOut = r.out;
    indexMs += r.ms;
    indexSteps.push({ command: [step.cmd, ...step.args].join(' '), ms: r.ms, exit: r.status, signal: r.signal });
    if (r.status !== 0) {
      indexOk = false;
      errors.push(`index step "${[step.cmd, ...step.args].join(' ')}" failed (exit ${r.status}${r.signal ? `, ${r.signal}` : ''}${r.error ? `, ${r.error}` : ''}): ${tail(r.out, 1500)}`);
      break;
    }
  }
  const indexDirs = adapter.indexDirs(ROOT).filter((d) => existsSync(d));
  const indexSizeBytes = indexDirs.reduce((a, d) => a + dirSize(d), 0);
  const modelDir = join(homedir(), '.kirograph', 'models');
  const modelBytes = TOOL === 'kirograph' && MODE === 'embeddings' ? dirSize(modelDir) : 0;
  let indexStatus = null;
  if (indexOk && adapter.status) {
    const s = adapter.status(ROOT);
    const r = run(s.cmd, s.args, { timeout: 120000 });
    indexStatus = tail(r.out.trim(), 4000);
  } else if (indexOk) {
    indexStatus = tail(lastIndexOut.trim(), 4000);
  }

  // 3. tool surface (fixed per-request overhead the agent pays: tool schemas + server instructions)
  let surface = null;
  if (indexOk) {
    try {
      surface = await withSession(async (client, startupMs) => {
        const tools = (await client.listTools(undefined, { timeout: QUERY_TIMEOUT_MS })).tools ?? [];
        const instructions = client.getInstructions?.() ?? '';
        const toolsJson = JSON.stringify(tools);
        return {
          serverInfo: client.getServerVersion?.() ?? null,
          startupMs,
          toolCount: tools.length,
          toolNames: tools.map((t) => t.name),
          toolsChars: toolsJson.length,
          toolsEstTokens: estTokens(toolsJson),
          instructionsChars: instructions.length,
          instructionsEstTokens: estTokens(instructions),
          primaryToolListed: tools.some((t) => t.name === adapter.tool),
          tools,
          instructions,
        };
      });
      writeFileSync(join(OUT, `${LABEL}.surface.json`), JSON.stringify(surface, null, 2) + '\n');
    } catch (e) {
      errors.push(`tools/list failed: ${e.message}`);
    }
  }

  // 4. one fresh session per task: connect, call the primary tool once, disconnect
  const perInput = {};
  for (const field of INPUTS) {
    const file = join(OUT, `${LABEL}-${REPO}${field === 'search' ? '' : `-${field}`}.jsonl`);
    writeFileSync(file, '');
    const queryMsList = [];
    const startupMsList = [];
    let failures = 0;
    for (const t of tasks) {
      const input = field === 'search' ? t.search ?? t.question : t.question;
      const rec = {
        taskId: t.id,
        input,
        output: '',
        toolCalls: 1,
        indexMs,
        queryMs: null,
        // extra fields (not required by the scorer)
        kind: t.kind,
        inputField: field,
        tool: adapter.tool,
        args: adapter.toolArgs(input),
        startupMs: null,
        isError: false,
        error: null,
      };
      if (!indexOk) {
        rec.error = 'index failed';
        failures++;
      } else {
        try {
          await withSession(async (client, startupMs) => {
            rec.startupMs = startupMs;
            const t0 = now();
            const res = await client.callTool({ name: adapter.tool, arguments: rec.args }, undefined, {
              timeout: QUERY_TIMEOUT_MS,
            });
            rec.queryMs = Math.round(now() - t0);
            rec.output = textOf(res);
            rec.isError = Boolean(res?.isError);
            const nonText = (res?.content ?? []).filter((c) => c?.type !== 'text').map((c) => c?.type);
            if (nonText.length) rec.nonTextContent = nonText;
          });
          if (rec.queryMs !== null) queryMsList.push(rec.queryMs);
          if (rec.startupMs !== null) startupMsList.push(rec.startupMs);
          if (rec.isError) failures++;
        } catch (e) {
          rec.error = String(e?.message ?? e);
          failures++;
          log(`[task ${t.id}] error: ${rec.error}`);
        }
      }
      rec.chars = rec.output.length;
      rec.estTokens = estTokens(rec.output);
      appendFileSync(file, JSON.stringify(rec) + '\n');
      process.stdout.write(
        `${LABEL} ${REPO} ${field} ${t.id}: ${rec.error ? `ERROR ${rec.error}` : `${rec.chars} chars, ${rec.queryMs} ms`}\n`,
      );
    }
    perInput[field] = {
      file: file.replace(`${OUT}/`, ''),
      tasks: tasks.length,
      failures,
      queryMsMedian: median(queryMsList),
      queryMsP90: p90(queryMsList),
      startupMsMedian: median(startupMsList),
    };
    if (failures) errors.push(`${failures}/${tasks.length} ${field} queries failed or returned isError`);
  }

  // 5. meta
  const meta = {
    label: LABEL,
    tool: TOOL,
    package: adapter.pkg,
    version: toolVersion,
    mode: MODE,
    repo: taskFile.repo,
    headCommit,
    commitMatchesTasks: taskFile.repo?.commit ? headCommit === taskFile.repo.commit : null,
    date: new Date().toISOString(),
    container: {
      node: process.version,
      arch: process.arch,
      platform: process.platform,
      cpus: (await import('node:os')).cpus().length,
      memBytes: (await import('node:os')).totalmem(),
      network: 'none',
    },
    primaryTool: adapter.tool,
    toolArgsExample: adapter.toolArgs('<input>'),
    serverCommand: adapter.server('/work/<repo>'),
    oneSessionPerTask: true,
    indexOk,
    indexMs,
    indexSteps,
    copyMs: copy.ms,
    indexDirs: indexDirs.map((d) => d.replace(ROOT, '<repo>')),
    indexSizeBytes,
    modelBytes,
    indexStatus,
    surface: surface
      ? {
          serverInfo: surface.serverInfo,
          toolCount: surface.toolCount,
          toolNames: surface.toolNames,
          toolsChars: surface.toolsChars,
          toolsEstTokens: surface.toolsEstTokens,
          instructionsChars: surface.instructionsChars,
          instructionsEstTokens: surface.instructionsEstTokens,
          primaryToolListed: surface.primaryToolListed,
          file: `${LABEL}.surface.json`,
        }
      : null,
    inputs: perInput,
    charsPerToken: CHARS_PER_TOKEN,
    errors,
  };
  writeFileSync(join(OUT, `${LABEL}-${REPO}.meta.json`), JSON.stringify(meta, null, 2) + '\n');
  process.stdout.write(
    `${LABEL} ${REPO}: index ${indexOk ? 'ok' : 'FAILED'} in ${indexMs} ms, ${(indexSizeBytes / 1e6).toFixed(1)} MB; ` +
      `${errors.length} error(s)\n`,
  );
}

main().catch((e) => {
  process.stderr.write(`run-tool: ${e?.stack ?? e}\n`);
  try {
    log(`FATAL ${e?.stack ?? e}`);
  } catch {
    /* log dir missing */
  }
  process.exit(1);
});
