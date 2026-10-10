// Filter registry and selection. A filter is chosen by command (strong signal) or output signature (fallback,
// e.g. `make test` running pytest); package-manager wrappers score low so the inner tool's filter wins.

import { estimateTokens } from '../../core/tokens.js';
import { parseCommand, type CommandInfo } from '../command.js';
import { bazel } from './bazel.js';
import { cargo } from './cargo.js';
import { capLine, fit, type Filter } from './common.js';
import { dotnet } from './dotnet.js';
import { eslint } from './eslint.js';
import { generic } from './generic.js';
import { git } from './git.js';
import { go } from './go.js';
import { gradle } from './gradle.js';
import { jest, vitest } from './jest.js';
import { json } from './json.js';
import { maven } from './maven.js';
import { mocha } from './mocha.js';
import { nodeTest } from './nodetest.js';
import { npm } from './npm.js';
import { phpunit } from './phpunit.js';
import { pytest, unittest } from './pytest.js';
import { rspec } from './rspec.js';
import { sbt } from './sbt.js';
import { tsc } from './tsc.js';
import { xunit } from './xunit.js';

export const FILTERS: readonly Filter[] = [
  pytest, unittest, jest, vitest, mocha, nodeTest, rspec, phpunit, maven, gradle, sbt, dotnet, xunit, go, tsc, eslint, cargo, bazel, git, json, npm,
];

/** Outputs this small are returned verbatim: nothing to gain, and verbatim is always trustworthy. */
export const PASSTHROUGH_TOKENS = 120;
/** Test, build and lint filters whose success output is a complete verdict line. */
export const VERDICT_FILTERS: ReadonlySet<string> = new Set([
  'pytest', 'unittest', 'jest', 'vitest', 'mocha', 'node-test', 'rspec', 'phpunit', 'maven', 'gradle', 'sbt', 'dotnet', 'xunit', 'go', 'tsc',
  'eslint', 'cargo', 'bazel',
]);
const SAMPLE_CHARS = 64 * 1024;

export function selectFilter(cmd: CommandInfo, output: string): Filter {
  const sample = output.length <= SAMPLE_CHARS * 2 ? output : `${output.slice(0, SAMPLE_CHARS)}\n${output.slice(-SAMPLE_CHARS)}`;
  let best: Filter = generic;
  let bestScore = 0;
  for (const f of FILTERS) {
    const s = f.match(cmd, sample);
    if (s > bestScore) {
      best = f;
      bestScore = s;
    }
  }
  return best;
}

/** Filter chosen from the command alone (used before running, e.g. to decide cacheability). */
export function filterForCommand(command: string): Filter {
  return selectFilter(parseCommand(command), '');
}

/**
 * Compress already-normalized output. Never exceeds `maxTokens`; falls back to the generic filter when the
 * specialised one does not recognise the output or throws.
 */
export function compressNormalized(
  command: string,
  text: string,
  exitCode: number,
  maxTokens: number,
  opts: { passthroughTokens?: number } = {},
): { text: string; filter: string } {
  if (!text.trim()) return { text: '(no output)', filter: 'none' };
  if (estimateTokens(text) <= Math.min(maxTokens, opts.passthroughTokens ?? PASSTHROUGH_TOKENS)) return { text, filter: 'raw' };
  const cmd = parseCommand(command);
  const lines = text.split('\n');
  const filter = selectFilter(cmd, text);
  let out: string | undefined;
  let name = filter.name;
  if (filter !== generic) {
    try {
      out = filter.compress({ command: cmd, lines, exitCode, maxTokens });
    } catch (err) {
      process.stderr.write(`kopt: ${filter.name} filter failed (${(err as Error).message}); using generic\n`);
      out = undefined;
    }
  }
  if (out === undefined || !out.trim()) {
    out = generic.compress({ command: cmd, lines, exitCode, maxTokens })!;
    name = filter === generic ? 'generic' : `${filter.name}>generic`;
  }
  out = out.split('\n').map((l) => capLine(l)).join('\n');
  return { text: fit(out, maxTokens), filter: name };
}
