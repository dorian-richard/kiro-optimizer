// Shell command line parsing, only deep enough to recognise which tool(s) a command runs.
// `FOO=1 npx jest --ci && ./gradlew test | tee log` -> segments [jest --ci] [gradlew test] [tee log].

export interface Segment {
  /** Lower-cased basename without .exe/.cmd/.bat/.sh/.ps1, e.g. `gradlew`, `pytest`, `npm`. */
  program: string;
  args: string[];
  /** Guessed segment: `yarn jest` may run the `jest` binary (or a script named jest). */
  alias?: boolean;
}

export interface CommandInfo {
  raw: string;
  segments: Segment[];
}

const SEPARATORS = new Set(['&&', '||', ';', '|', '&', '\n', '(', ')', '|&']);

/** Quote-aware split into words and separator tokens. Good enough for detection, not for execution. */
function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let quote: '"' | "'" | undefined;
  const push = () => {
    if (has) out.push(cur);
    cur = '';
    has = false;
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = undefined;
      else if (c === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
      continue;
    }
    // Backslash escapes only shell-special characters, so Windows paths (C:\tools\mvnw.cmd) survive.
    if (c === '\\' && i + 1 < line.length && /[\s"'\\$`;&|<>()]/.test(line[i + 1])) {
      cur += line[++i];
      has = true;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      push();
      continue;
    }
    const two = line.slice(i, i + 2);
    if (two === '&&' || two === '||' || two === '|&') {
      push();
      out.push(two);
      i++;
      continue;
    }
    if (c === ';' || c === '|' || c === '&' || c === '\n' || c === '(' || c === ')') {
      push();
      out.push(c);
      continue;
    }
    cur += c;
    has = true;
  }
  push();
  return out;
}

export function programName(word: string): string {
  const base = word.split(/[\\/]/).pop() ?? word;
  return base.toLowerCase().replace(/\.(exe|cmd|bat|sh|ps1)$/, '');
}

/** `FOO=1 cmd` (POSIX) and `$env:FOO='1'; cmd` (PowerShell) environment assignments. */
const ENV_ASSIGN = /^(?:\$env:)?[A-Za-z_][A-Za-z0-9_]*=/i;
/** Prefix commands that just run their argument. Value = number of leading positional args to skip. */
const PREFIX_WRAPPERS: Record<string, number> = {
  time: 0, env: 0, sudo: 0, nice: 0, nohup: 0, command: 0, exec: 0, stdbuf: 0, unbuffer: 0, caffeinate: 0,
  'xvfb-run': 0, 'cross-env': 0, dotenv: 0, timeout: 1, gtimeout: 1, npx: 0, bunx: 0, pnpx: 0,
};
/** `<runner> run|exec <prog>` style wrappers. */
const RUN_WRAPPERS: Record<string, string[]> = {
  uv: ['run'], poetry: ['run'], pipenv: ['run'], hatch: ['run'], pdm: ['run'], rye: ['run'], bundle: ['exec'],
  pnpm: ['exec', 'dlx'], yarn: ['exec', 'dlx'], npm: ['exec', 'x'], conda: ['run'],
};

function unwrap(words: string[], depth = 0): Segment[] {
  let i = 0;
  while (i < words.length && ENV_ASSIGN.test(words[i])) i++;
  if (i >= words.length) return [];
  const prog = programName(words[i]);
  const rest = words.slice(i + 1);
  if (depth < 4) {
    if (prog in PREFIX_WRAPPERS) {
      let j = 0;
      // skip wrapper flags (e.g. `nice -n 5`, `npx --yes`, `env -i`) and env assignments
      while (j < rest.length && (rest[j].startsWith('-') || ENV_ASSIGN.test(rest[j]))) {
        if (/^-(n|u|g|p|s|k)$/.test(rest[j]) && prog !== 'npx') j++;
        j++;
      }
      j += PREFIX_WRAPPERS[prog];
      if (j < rest.length) return unwrap(rest.slice(j), depth + 1);
    }
    if (RUN_WRAPPERS[prog] && rest.length > 1 && RUN_WRAPPERS[prog].includes(rest[0])) {
      let j = 1;
      while (j < rest.length && rest[j].startsWith('-')) j++;
      if (j < rest.length) return [{ program: prog, args: rest }, ...unwrap(rest.slice(j), depth + 1)];
    }
    if (/^(python[\d.]*|py|pypy3?)$/.test(prog)) {
      const m = rest.indexOf('-m');
      if (m >= 0 && m + 1 < rest.length) return unwrap(rest.slice(m + 1), depth + 1);
    }
    if (/^(sh|bash|zsh|dash|cmd)$/.test(prog)) {
      const c = rest.findIndex((w) => w === '-c' || w.toLowerCase() === '/c');
      if (c >= 0 && c + 1 < rest.length) return parseCommand(rest.slice(c + 1).join(' ')).segments;
    }
  }
  const seg: Segment = { program: prog, args: rest };
  // `yarn jest` / `pnpm vitest`: the package manager may run a binary directly.
  if ((prog === 'yarn' || prog === 'pnpm' || prog === 'bun') && rest.length && !rest[0].startsWith('-')) {
    return [seg, { program: programName(rest[0]), args: rest.slice(1), alias: true }];
  }
  return [seg];
}

export function parseCommand(raw: string): CommandInfo {
  const tokens = tokenize(raw);
  const segments: Segment[] = [];
  let words: string[] = [];
  const flush = () => {
    if (words.length) segments.push(...unwrap(words));
    words = [];
  };
  for (const t of tokens) {
    if (SEPARATORS.has(t)) flush();
    else if (/^\d?[<>]/.test(t)) continue; // redirection operator glued to target
    else words.push(t);
  }
  flush();
  return { raw, segments };
}

/** True if any segment runs `program` (exact basename), optionally with a first non-flag arg in `subcommands`. */
export function runs(cmd: CommandInfo, programs: string[] | RegExp, subcommands?: string[] | RegExp): boolean {
  return cmd.segments.some((s) => {
    const okProg = Array.isArray(programs) ? programs.includes(s.program) : programs.test(s.program);
    if (!okProg) return false;
    if (!subcommands) return true;
    return s.args.some((a, idx) => {
      if (idx > 3) return false;
      return Array.isArray(subcommands) ? subcommands.includes(a) : subcommands.test(a);
    });
  });
}

/** First non-option argument of the first segment running `program`, skipping `-C dir` style options. */
export function subcommandOf(cmd: CommandInfo, programs: string[]): string | undefined {
  for (const s of cmd.segments) {
    if (!programs.includes(s.program)) continue;
    for (let i = 0; i < s.args.length; i++) {
      const a = s.args[i];
      if (a === '-C' || a === '-c' || a === '--git-dir' || a === '--work-tree' || a === '--prefix' || a === '--cwd') {
        i++;
        continue;
      }
      if (a.startsWith('-')) continue;
      return a;
    }
  }
  return undefined;
}
