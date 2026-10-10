#!/usr/bin/env node
// Writes the exact per-agent prompts of an A/B run prepared by prepare.mjs.
//
// Arm B's prompt carries what Kiro puts in front of the model when kopt is installed: the steering file
// (templates/steering/kopt.md), the kopt MCP server instructions (none since v0.2's 4-tool surface) and the
// descriptions and listed parameters of the tools Kiro lists (kopt_find, kopt_read, kopt_refs, kopt_run), all taken
// from the run's snapshot of the kopt build, with MCP tool names spelled as the CLI commands the wrapper runs.
//
// usage: node bench/agentab/prompts.mjs --run <label> --mode explore|test --out <file.json> [--tasks <file>] [--seed n]
//          [--reps n]
//
// --reps n (default: the run's meta.reps, else 1): n runs per arm and task, interleaved. The order is n blocks, one
// per repetition, each a seeded shuffle of every (task, arm): A and B alternate over time, so a drift of the agents
// (load, model version) hits both arms alike. Ids are <arm>-<task> for one repetition, <arm>-<task>-r<k> for several.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STATE = process.env.AGENTAB_STATE ? resolve(process.env.AGENTAB_STATE) : join(ROOT, 'bench', 'agentab', '.state');
const WRAPPER = join(ROOT, 'bench', 'agentab', 'run.mjs');

function parseArgs(argv) {
  const o = { run: '', mode: '', out: '', tasks: '', seed: 1, reps: 0 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    if (k in o) o[k] = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!o.run || !['explore', 'test'].includes(o.mode) || !o.out) throw new Error('usage: --run <label> --mode explore|test --out <file.json>');
  o.seed = Number(o.seed) || 1;
  o.reps = Math.max(0, Math.floor(Number(o.reps) || 0));
  return o;
}

/** MCP spelling -> CLI spelling, for text the model reads. */
function cliSpelling(text) {
  return text
    .replace(/`kopt_find` mode=pack/g, '`kopt find "<words>" --pack`')
    .replace(/`kopt_read #id`/g, '`kopt read "#id"`')
    .replace(/`kopt_read path:a-b`/g, '`kopt read path:a-b`')
    .replace(/`kopt_run`/g, '`kopt run "<command>"`')
    .replace(/kopt_read #handle/g, 'kopt read "#handle"')
    .replace(/mode "pack"/g, '--pack')
    .replace(/\bmode[= ]pack\b/g, '--pack')
    .replace(/\bmode[= ]outline\b/g, '--mode outline')
    .replace(/\bgrep \(regex\)/g, '--grep (regex)')
    .replace(/fresh:\s?true/g, '--fresh')
    .replace(/startLine\/endLine/g, '--start/--end')
    .replace(/\bmaxTokens\b/g, '--max-tokens')
    .replace(/kopt_(find|read|outline|refs|run|expand)\b/g, 'kopt $1');
}

/** The always-on steering of the run's snapshot (prepare.mjs copies templates/ next to dist/). */
function steeringBody(koptBin) {
  const raw = readFileSync(join(dirname(dirname(koptBin)), 'templates', 'steering', 'kopt.md'), 'utf8');
  return cliSpelling(raw.replace(/^---[\s\S]*?---\s*/, '').replace(/^# kopt\s*/m, '').trim());
}

/** Seeded Fisher-Yates (mulberry32), so the run order is reproducible. */
function shuffle(items, seed) {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const o = parseArgs(process.argv.slice(2));
// the prompts name this Node (absolute path) for the wrapper, which runs kopt with it: kopt needs Node >= 22.13
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 13)) throw new Error(`Node ${process.version}: kopt needs Node >= 22.13; run prompts.mjs with it (absolute path)`);
const metaFile = join(STATE, o.run, 'meta.json');
if (!existsSync(metaFile)) throw new Error(`run ${o.run} is not prepared (${metaFile})`);
const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
if (meta.ready !== true) throw new Error(`run ${o.run} is not ready: prepare.mjs did not finish`);
const tools = await import(pathToFileURL(join(dirname(meta.koptBin), 'mcp', 'tools.js')).href);
const desc = Object.fromEntries(tools.toolDefinitions().map((d) => [d.name, cliSpelling(d.description)]));
const instructions = cliSpelling(tools.serverInstructions());
const node = process.execPath;
const reps = o.reps || meta.reps || 1;
if (reps > (meta.reps || 1) && o.mode === 'test') throw new Error(`run ${o.run} was prepared for ${meta.reps || 1} repetition(s) of the test tasks (prepare.mjs --reps)`);
const repArg = (rep) => (reps > 1 ? ` --rep ${rep}` : '');
const idOf = (arm, task, rep) => (reps > 1 ? `${arm}-${task}-r${rep}` : `${arm}-${task}`);
const call = (arm, repo, task, rep) => `${node} ${WRAPPER} --arm ${arm} --repo ${repo} --task ${task}${repArg(rep)} --run ${o.run} -- '<command>'`;

const nativeLine = (test) => `grep, egrep, find, ls, cat, head, tail, sed -n, wc, awk, sort, uniq, cut, tr, nl, tree, read-only git (grep, log, show, ls-files, blame${test ? ', diff, status' : ''}), and pipes between them`;

function rules(arm, repo, task, test, rep) {
  return [
    'How to run commands (strict):',
    '- Use only the Bash tool, and only to run commands through this wrapper, one command per call:',
    `  ${call(arm, repo, task, rep)}`,
    '- <command> runs in the repository root. Put the whole command in single quotes; inside it use double quotes only.',
    `- Allowed: ${nativeLine(test)}${test ? '; and the test commands `npx vitest run [files] [-t "<test name>"] [--reporter <name>]` and `npm test [-- args]` (no watch, update or coverage flags)' : ''}. Paths stay inside the repository. Long outputs are truncated like Kiro's built-in tools (search: 100 lines / 10k chars; file reads: 2,000 lines${test ? '; command output: 2,000 lines / 100k chars' : ''}).`,
    '- Do not use any other tool (no Read, Grep, Glob, Task, web), do not read files any other way, do not modify anything.',
  ].join('\n');
}

/**
 * Arm B's extra prompt: the kopt commands Kiro lists, with the parameters their MCP schemas list (in CLI spelling;
 * the other parameters are accepted and the outputs name them where they help), their descriptions, the server
 * instructions (if any) and the always-on steering, as Kiro would put them in front of the model.
 */
function koptSection(test) {
  for (const t of ['kopt_find', 'kopt_read', 'kopt_refs', 'kopt_run']) if (!desc[t]) throw new Error(`the kopt build of run ${o.run} does not list ${t}`);
  const lines = [
    'kopt commands (through the same wrapper; quote "#handles"):',
    `- kopt find "<query>" [--pack]: ${desc.kopt_find}`,
    `- kopt read "<target>" [--mode outline]: ${desc.kopt_read}`,
    `- kopt refs "<target>": ${desc.kopt_refs}`,
  ];
  if (test) lines.push(`- kopt run "<command>": ${desc.kopt_run}`);
  if (instructions) lines.push(instructions);
  lines.push(steeringBody(meta.koptBin));
  return lines.join('\n');
}

const items = [];
if (o.mode === 'explore') {
  const tasks = JSON.parse(readFileSync(o.tasks || join(ROOT, 'bench', 'agentab', 'tasks-explore.json'), 'utf8'));
  for (const t of tasks) {
    if (!meta.explore.includes(t.id)) throw new Error(`task ${t.id} is not part of run ${o.run}`);
    for (let rep = 1; rep <= reps; rep++) for (const arm of ['A', 'B']) {
      const prompt = [
        `You are a coding agent in Kiro, answering a developer's question about the ${t.repo} repository (a large open-source codebase, checked out read-only). Explore the code with commands, then answer.`,
        '',
        `Question: ${t.question}`,
        '',
        rules(arm, t.repo, t.id, false, rep),
        ...(arm === 'B' ? ['', koptSection(false)] : []),
        '',
        'Stop exploring as soon as you have enough evidence, then give your final answer:',
        '- the explanation, at most 200 words;',
        '- a line "FILES:" followed by the relevant files (paths from the repository root), one per line;',
        '- a line "SYMBOLS:" followed by every relevant function, method or class as "path:line Name", one per line.',
      ].join('\n');
      items.push({
        id: idOf(arm, t.id, rep), repo: t.repo, arm, task: t.id, rep, kind: t.kind, prompt,
        gold: { files: t.gold.files, symbols: t.gold.symbols.map((s) => s.name) },
      });
    }
  }
} else {
  const spec = JSON.parse(readFileSync(o.tasks || join(ROOT, 'bench', 'agentab', 'tasks-run.json'), 'utf8'));
  for (const t of spec.tasks) {
    if (!meta.tests.includes(t.id)) throw new Error(`task ${t.id} is not part of run ${o.run}`);
    const repo = `kopt-${t.id}`;
    const injected = meta.repos[repo].injected;
    for (let rep = 1; rep <= reps; rep++) for (const arm of ['A', 'B']) {
      const prompt = [
        'You are a coding agent in Kiro, working in the kopt repository (a TypeScript CLI; tests run with vitest).',
        '',
        `Task: ${spec.question}`,
        '',
        rules(arm, repo, t.id, true, rep),
        ...(arm === 'B' ? ['', koptSection(true)] : []),
        '',
        'Stop as soon as you have found the root cause, then give your final answer:',
        '- a line "FAILING:" followed by the failing tests (test file > test name), one per line;',
        '- a line "ROOT CAUSE: path:line functionName";',
        '- the explanation and the fix, at most 150 words.',
      ].join('\n');
      items.push({
        id: idOf(arm, t.id, rep), repo, arm, task: t.id, rep, kind: 'test', prompt,
        gold: { files: t.gold.files, symbols: t.gold.symbols.map((s) => s.name), alsoAccept: t.gold.symbols.flatMap((s) => s.alsoAccept ?? []), line: injected.line },
      });
    }
  }
}

// one shuffled block per repetition: both arms of every task run once before any runs again
const order = [];
for (let rep = 1; rep <= reps; rep++) order.push(...shuffle(items.filter((i) => i.rep === rep).map((i) => i.id), o.seed + rep - 1));
const doc = {
  run: o.run,
  mode: o.mode,
  reps,
  createdAt: new Date().toISOString(),
  commit: meta.commit,
  wrapper: WRAPPER,
  node,
  answers: join(ROOT, 'bench', 'agentab', 'logs', o.run, 'answers', '<id>.md'),
  order,
  items,
};
mkdirSync(dirname(resolve(o.out)), { recursive: true });
writeFileSync(resolve(o.out), JSON.stringify(doc, null, 2) + '\n');
process.stderr.write(`prompts: ${items.length} prompts (${o.mode}) -> ${resolve(o.out)}\n`);
