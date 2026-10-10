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

// ---------------------------------------------------------------------------------------------------------------
// Commands that never exit by themselves (watch modes, dev servers, followers). kopt_run would wait for them until
// its timeout, so it refuses them with a hint instead. Pure: the governor can use it before redirecting.

/** `--watch`, `--watchAll`, `--watch-all`, `--hot`, `--serve` (not `--watch=false` / `--watch false`). */
const WATCH_FLAG_RE = /^--(?:watch(?:All|-all)?|hot|serve)(?:=(.*))?$/;
/** Programs whose `-w` means watch (elsewhere it is a workspace, worker count, word match...). */
const DASH_W_WATCH = new Set([
  'tsc', 'vue-tsc', 'tsgo', 'vitest', 'mocha', 'rollup', 'babel', 'sass', 'node-sass', 'tailwindcss', 'postcss',
  'webpack', 'coffee', 'stylus', 'ava', 'tsup', 'swc', 'esbuild', 'lessc',
]);
/** Programs that always run until stopped. */
const SERVER_PROGRAMS = new Set([
  'nodemon', 'ts-node-dev', 'tsnd', 'webpack-dev-server', 'http-server', 'live-server', 'lite-server', 'json-server',
  'serve', 'remix-serve', 'start-storybook', 'uvicorn', 'gunicorn', 'hypercorn', 'daphne', 'waitress-serve',
  'sphinx-autobuild', 'ptw', 'pytest-watch', 'rackup', 'puma', 'unicorn', 'guard', 'air', 'reflex', 'entr',
  'watchexec', 'watchman-make', 'fswatch', 'watch', 'azurite', 'http.server',
]);
/** program -> first non-option argument that starts a server / watcher (`*` = any, including none). */
const SERVER_SUBCOMMANDS: Record<string, RegExp> = {
  vite: /^(?:dev|serve|preview|\*)$/,
  next: /^(?:dev|start)$/,
  nuxt: /^(?:dev|start|preview)$/,
  nuxi: /^(?:dev|start|preview)$/,
  astro: /^(?:dev|preview)$/,
  remix: /^dev$/,
  gatsby: /^(?:develop|serve)$/,
  docusaurus: /^(?:start|serve)$/,
  vuepress: /^dev$/,
  vitepress: /^(?:dev|preview)$/,
  storybook: /^dev$/,
  expo: /^start$/,
  'react-native': /^start$/,
  'react-scripts': /^start$/,
  craco: /^start$/,
  'vue-cli-service': /^serve$/,
  ng: /^(?:serve|s)$/,
  ember: /^(?:serve|server|s)$/,
  hugo: /^(?:server|serve)$/,
  jekyll: /^(?:serve|s|server)$/,
  mkdocs: /^serve$/,
  webpack: /^serve$/,
  // bare `parcel index.html` starts the dev server too
  parcel: /^(?!build$|help$)/,
  tsx: /^watch$/,
  vitest: /^(?:watch|dev)$/,
  cargo: /^watch$/,
  dotnet: /^watch$/,
  flask: /^run$/,
  fastapi: /^(?:dev|run)$/,
  streamlit: /^run$/,
  jupyter: /^(?:notebook|lab|server)$/,
  rails: /^(?:server|s)$/,
  foreman: /^start$/,
  overmind: /^start$/,
  symfony: /^(?:serve|server:start)$/,
  skaffold: /^dev$/,
  tilt: /^up$/,
  wrangler: /^dev$/,
  netlify: /^dev$/,
  vercel: /^dev$/,
  firebase: /^(?:emulators:start|serve)$/,
  func: /^start$/,
  serverless: /^offline$/,
  sls: /^offline$/,
  gulp: /^(?:watch|serve|dev)$/,
  grunt: /^(?:watch|serve)$/,
  ionic: /^serve$/,
  quasar: /^dev$/,
  umi: /^dev$/,
  'browser-sync': /^start$/,
  deno: /^serve$/,
  minikube: /^tunnel$/,
};
/** npm-style script names that start a server or a watcher (`build:dev` is a one-shot build: not matched). */
const SCRIPT_RE = /^(?:dev|develop|start|serve|server|watch|preview)(?:[:_-].*)?$|[:_-](?:watch|serve)$/;
const MAVEN_SERVER_GOAL_RE = /^(?:spring-boot:run|quarkus:dev|jetty:run(?:-war)?|tomcat7?:run(?:-war)?|wildfly:run|liberty:(?:dev|run)|micronaut:run|cargo:run)$/;
const GRADLE_SERVER_TASK_RE = /^(?::?[\w-]+:)*(?:bootRun|run|appRun|appStart|jettyRun|tomcatRun|quarkusDev|liveDev)$/;
const PHP_ARTISAN_RE = /^(?:serve|queue:work|queue:listen|horizon|octane:start|reverb:start|schedule:work|pail)$/;

function firstPositional(args: string[]): string | undefined {
  return args.find((a) => !a.startsWith('-'));
}

function hasWatchFlag(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const m = WATCH_FLAG_RE.exec(args[i]);
    if (!m) continue;
    const value = m[1] ?? (/^(?:true|false)$/.test(args[i + 1] ?? '') ? args[i + 1] : undefined);
    if (value === 'false' || value === '0') continue;
    return args[i].replace(/=.*$/, '');
  }
  return undefined;
}

function segmentReason(s: Segment): string | undefined {
  const p = s.program;
  const args = s.args;
  // `--no-watch` / `--watch=false` / `--single-run` turn a watch mode off (a server still runs: checked below)
  const noWatch = args.some((a) => /^--no-watch$|^--watch(?:All)?=false$|^--single-?run$/i.test(a));
  // detached / daemon modes return at once
  if ((p === 'symfony' || p === 'docker' || p === 'docker-compose' || p === 'podman') && args.some((a) => a === '-d' || a === '--daemon' || a === '--detach')) return undefined;
  const flag = noWatch ? undefined : hasWatchFlag(args);
  if (flag) return `${flag} never exits`;
  if (!noWatch && DASH_W_WATCH.has(p) && args.includes('-w')) return '-w (watch) never exits';
  if ((p === 'gradle' || p === 'gradlew') && args.some((a) => a === '-t' || a === '--continuous')) return 'continuous build never exits';
  if (SERVER_PROGRAMS.has(p)) return `${p} runs until stopped`;
  const sub = firstPositional(args);
  const subRe = SERVER_SUBCOMMANDS[p];
  if (subRe && (sub ? subRe.test(sub) : subRe.test('*'))) return `${p}${sub ? ` ${sub}` : ''} runs until stopped`;
  if (p === 'ng' && sub === 'test' && !noWatch) return 'ng test watches by default (add --watch=false)';
  if ((p === 'npm' || p === 'yarn' || p === 'pnpm' || p === 'bun') && !s.alias) {
    let script = sub;
    if (sub === 'run' || sub === 'run-script') script = firstPositional(args.slice(args.indexOf(sub) + 1));
    else if (p === 'npm' && sub !== 'start') script = undefined; // `npm test`, `npm ci`...: npm commands, not scripts
    if (script && SCRIPT_RE.test(script)) return `script "${script}" usually runs until stopped`;
  }
  if (/^mvn/.test(p) && args.some((a) => MAVEN_SERVER_GOAL_RE.test(a))) return 'server goal runs until stopped';
  if ((p === 'gradle' || p === 'gradlew') && args.some((a) => GRADLE_SERVER_TASK_RE.test(a))) return 'run task runs until stopped';
  if (p === 'sbt' && args.some((a) => a.startsWith('~'))) return '~ (continuous) never exits';
  if (/^python[\d.]*$|^py$/.test(p) && args[0]?.endsWith('manage.py') && args[1] === 'runserver') return 'runserver runs until stopped';
  if (p === 'manage.py' && sub === 'runserver') return 'runserver runs until stopped';
  if (p === 'php' && (args[0] === '-S' || (args[0]?.endsWith('artisan') && PHP_ARTISAN_RE.test(args[1] ?? '')))) return 'server runs until stopped';
  if (p === 'artisan' && PHP_ARTISAN_RE.test(sub ?? '')) return 'server runs until stopped';
  if (p === 'mix' && sub === 'phx.server') return 'phx.server runs until stopped';
  if ((p === 'tail' || p === 'journalctl') && args.some((a) => /^-[a-zA-Z]*[fF][a-zA-Z]*$/.test(a))) return `${p} -f never exits`;
  if (p === 'docker' || p === 'docker-compose' || p === 'podman' || p === 'podman-compose') {
    const words = args.filter((a) => !a.startsWith('-'));
    const i = words[0] === 'compose' ? 1 : 0;
    const verb = words[i];
    if (verb === 'up' && !args.some((a) => a === '-d' || a === '--detach' || /^-[a-zA-Z]*d[a-zA-Z]*$/.test(a))) return `${p} up without -d runs until stopped`;
    if ((verb === 'logs' || verb === 'events') && (verb === 'events' || args.some((a) => a === '-f' || a === '--follow'))) return `${p} ${verb} follows forever`;
    if (verb === 'stats' && !args.includes('--no-stream')) return `${p} stats streams forever`;
  }
  if (p === 'kubectl' || p === 'oc') {
    const verb = firstPositional(args);
    if (verb === 'port-forward' || verb === 'proxy') return `${p} ${verb} runs until stopped`;
    if (verb === 'logs' && args.some((a) => a === '-f' || a === '--follow')) return `${p} logs -f follows forever`;
    if (args.includes('-w')) return `${p} -w watches forever`;
  }
  if (p === 'celery' && args.some((a) => /^(?:worker|beat|flower)$/.test(a))) return `celery ${args.find((a) => /^(?:worker|beat|flower)$/.test(a))} runs until stopped`;
  if (p === 'sam' && args[0] === 'local' && /^start-/.test(args[1] ?? '')) return 'sam local runs until stopped';
  if (p === 'pytest' && args.some((a) => a === '-f' || a === '--looponfail')) return 'pytest --looponfail never exits';
  if (p === 'iex' && args.join(' ').includes('phx.server')) return 'phx.server runs until stopped';
  return undefined;
}

/**
 * Why `command` would not exit by itself (watch mode, dev server, log follower), or undefined. Commands bounded by
 * `timeout N`, or sent to the background with a trailing `&`, are fine.
 */
export function longRunningReason(command: string): string | undefined {
  const raw = command.trim();
  // `timeout 30 npm run dev`; `npm run dev & sleep 5 && curl ...` (a job sent to the background with `&`, not
  // PowerShell's call operator `& .\gradlew.bat`)
  if (/(?:^|[;&|(]\s*)g?timeout\s+(?:-\S+\s+)*\d/.test(raw) || /[^\s&>|;(]\s*&(?![&>\d])/.test(raw)) return undefined;
  for (const s of parseCommand(raw).segments) {
    const why = segmentReason(s);
    if (why) return why;
  }
  return undefined;
}
