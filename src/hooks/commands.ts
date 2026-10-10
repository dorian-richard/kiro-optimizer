// Recognition of test/build shell commands (the main credit sink: full logs re-billed every turn).
//
// `kind` marks one-shot test/build runs (duplicate-run detection, telemetry). `verbose` marks the subset whose output
// is predictably long: only those are worth a governor redirect to kopt_run, which costs one extra model request.
// Quiet commands (tsc, go vet, go build, a test narrowed to one file or test id) are not redirected: their passing
// output is a few lines, which kopt_run returns as is (plus a header). Long-running commands (watch modes, dev
// servers, `run` goals) are neither: kopt_run would wait for its timeout. Anything kopt_run itself refuses as
// never-ending (`longRunningReason`) is long-running here too, so a redirect never leads to a refusal.

import { longRunningReason } from '../compress/command.js';

export interface CommandInfo {
  /** Command as the agent wrote it (trimmed). */
  command: string;
  /** Command without a leading `cd <dir> &&` prefix. */
  core: string;
  /** Directory from a leading `cd <dir> &&` prefix, if any. */
  cdDir?: string;
  /** 'test' | 'build' when the command is a one-shot test/build run. */
  kind?: 'test' | 'build';
  /** True when its output is predictably long (full suites, Maven/Gradle/MSBuild/cargo builds...). */
  verbose: boolean;
  /** True for watch modes, dev servers and `run` goals: never redirected, never treated as a test/build run. */
  longRunning: boolean;
  /** Normalized identity used for "same command" checks. */
  key: string;
}

// Wrappers that do not change which tool runs.
// `&` is PowerShell's call operator (`& npm test`, `& 'C:\x\gradlew.bat' build`).
const WRAPPERS = new Set(['time', 'nice', 'nohup', 'sudo', 'env', 'command', 'exec', 'npx', 'bunx', 'pnpx', 'xvfb-run', 'caffeinate', '&']);
const RUNNERS: Record<string, string[]> = {
  // `<runner> <sub> ...` prefixes that just exec the next command
  uv: ['run'], poetry: ['run'], pipenv: ['run'], pdm: ['run'], hatch: ['run'], bundle: ['exec'], dotenv: ['--'],
  pnpm: ['exec', 'dlx'], yarn: ['exec', 'dlx'], npm: ['exec'],
};

const TEST_SCRIPT = /^(test|tests|e2e|unit|integration|spec|ci)([:_.-].*)?$/;
const BUILD_SCRIPT = /^(build|compile|typecheck|type-check|tsc|verify|check|package|dist)([:_.-].*)?$/;
/** Scripts that only type-check or lint: silent when they pass. */
const QUIET_SCRIPT = /^(typecheck|type-check|tsc|check|lint)([:_.-].*)?$/;
const VERSION_ONLY = /^(-v|-V|--version|version|-h|--help|help)$/;

// Long-running: watch modes, dev servers, application `run` goals (they never exit on their own).
const WATCH_FLAG = /^(--watch(All)?(=true)?|-w|--serve|--continuous)$/;
const RUN_SCRIPT = /^(dev|start|serve|server|watch|preview|storybook)([:_.-].*)?$|[:_.-](watch|serve)$/i;
const MAVEN_RUN_GOAL = /(^|:)(run|exec|start)$|^exec:|^(spring-boot|jetty|tomcat\d*|quarkus|liberty|wildfly|cargo|appengine|micronaut):(run|dev|start|exec)|^quarkus:dev$/i;
const GRADLE_RUN_TASK = /^(:?[\w-]+:)*(run|bootRun|appRun|jettyRun|tomcatRun|quarkusDev|bootTestRun|runIde|continuous)$/;

/** A test/build invocation narrowed to a file, a test id or a name filter (short output when it passes). */
function narrowed(args: string[]): boolean {
  return args.some((a) =>
    /::|^-k$|^-t$|^-m$|^--testNamePattern|^--grep$|^-g$|^--filter|^--tests?(=|$)|^-Dtest=|^-Dit\.test=|^--test-name-pattern|^-run$|^-run=/.test(a) ||
    /\.(test|spec)\.[cm]?[jt]sx?$|(^|[\\/])(test_[^\\/]+|[^\\/]+_test|[^\\/]+Tests?|[^\\/]+Spec)\.(py|go|java|kt|cs|rb|php|scala)$|\.py$/.test(a) ||
    /^[A-Za-z_]\w*(\.[A-Za-z_]\w*){2,}$/.test(a)); // a dotted test label (Django app.tests.Case)
}

/** Long-running command (watch / dev server / run goal)? `prog` is the basename, `args` its arguments. */
function longRunningSimple(prog: string, args: string[]): boolean {
  if (args.some((a) => WATCH_FLAG.test(a))) return true;
  const nonFlag = args.filter((a) => !a.startsWith('-'));
  const a0 = nonFlag[0]?.toLowerCase();
  switch (prog) {
    case 'mvn': case 'mvnw': case 'mvnd':
      return nonFlag.some((g) => MAVEN_RUN_GOAL.test(g));
    case 'gradle': case 'gradlew':
      return nonFlag.some((t) => GRADLE_RUN_TASK.test(t)) || args.includes('-t') || args.includes('--continuous');
    case 'npm': case 'pnpm': case 'yarn': case 'bun': {
      if (a0 === 'start' || a0 === 'dev' || a0 === 'serve') return true;
      const script = a0 === 'run' || a0 === 'run-script' ? nonFlag[1] : prog === 'npm' ? undefined : a0;
      return !!script && RUN_SCRIPT.test(script);
    }
    case 'ng': return a0 === 'serve' || (a0 === 'test' && !args.some((a) => /^--watch=false$|^--no-watch$/.test(a)));
    case 'next': case 'nuxt': case 'vite': case 'astro': case 'remix': return !a0 || a0 === 'dev' || a0 === 'start' || a0 === 'preview';
    case 'webpack': return a0 === 'serve' || args.includes('--watch');
    case 'webpack-dev-server': case 'nodemon': case 'ts-node-dev': case 'live-server': case 'http-server': case 'serve': return true;
    case 'dotnet': return a0 === 'run' || a0 === 'watch';
    case 'cargo': return a0 === 'run' || a0 === 'watch';
    case 'go': return a0 === 'run';
    case 'make': case 'gmake': return nonFlag.some((t) => /^(run|serve|dev|watch|start)([-_].*)?$/.test(t));
    case 'manage.py': return a0 === 'runserver';
    case 'python': case 'python3': case 'py': return nonFlag.some((x) => /manage\.py$/.test(x)) && nonFlag.includes('runserver');
    case 'flask': case 'uvicorn': case 'gunicorn': case 'hypercorn': return true;
    case 'rails': return a0 === 's' || a0 === 'server';
    case 'mix': return nonFlag.includes('phx.server');
    case 'jest': case 'vitest': case 'karma': return args.includes('--watch') || args.includes('--watchAll') || (prog === 'vitest' && (a0 === 'watch' || a0 === 'dev'));
    case 'tsc': return args.includes('-w') || args.includes('--watch');
    case 'sbt': return nonFlag.some((t) => /^~/.test(t) || t === 'run');
    default: return false;
  }
}

function basename(p: string): string {
  const s = p.replace(/^["']|["']$/g, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return (i >= 0 ? s.slice(i + 1) : s).toLowerCase().replace(/\.(cmd|bat|exe|sh|ps1)$/, '');
}

function tokenize(segment: string): string[] {
  return segment.trim().split(/\s+/).filter(Boolean);
}

interface Simple { kind?: 'test' | 'build'; verbose: boolean; longRunning: boolean }

/** Classify one simple command (no `&&`, `|`...). */
function classifySimple(tokens: string[]): Simple {
  let t = [...tokens];
  // strip env assignments and wrappers
  for (let guard = 0; guard < 8 && t.length; guard++) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0])) { t.shift(); continue; }
    const b = basename(t[0]);
    if (WRAPPERS.has(b)) { t.shift(); while (t[0]?.startsWith('-')) t.shift(); continue; }
    const subs = RUNNERS[b];
    if (subs && t[1] && subs.includes(t[1])) { t = t.slice(2); continue; }
    break;
  }
  const none: Simple = { verbose: false, longRunning: false };
  if (!t.length) return none;
  const prog = basename(t[0]);
  const args = t.slice(1);
  if (args.length && args.every((a) => VERSION_ONLY.test(a))) return none;
  if (longRunningSimple(prog, args)) return { verbose: false, longRunning: true };
  const kind = kindOf(prog, args);
  if (!kind) return none;
  return { kind, verbose: verboseRun(prog, args, kind), longRunning: false };
}

/** Is the output of this test/build run predictably long? */
function verboseRun(prog: string, args: string[], kind: 'test' | 'build'): boolean {
  const nonFlag = args.filter((a) => !a.startsWith('-')).map((a) => a.toLowerCase());
  const a0 = nonFlag[0];
  const quiet = args.some((a) => /^(-q|--quiet|--silent)$/.test(a));
  switch (prog) {
    case 'tsc': case 'ninja': return false; // silent when it passes; an error list is what the agent needs
    case 'go': return a0 === 'test' && !narrowed(args) && nonFlag.some((x) => x.endsWith('...'));
    case 'mvn': case 'mvnw': case 'mvnd': case 'gradle': case 'gradlew':
      // without -q Maven and Gradle log every plugin / task, even for one test; with -q only problems are printed
      return !quiet;
    case 'npm': case 'pnpm': case 'yarn': case 'bun': {
      const script = a0 === 'run' || a0 === 'run-script' ? nonFlag[1] : a0;
      if (script && QUIET_SCRIPT.test(script)) return false;
      return !narrowed(args.slice(1));
    }
    case 'make': case 'gmake': case 'msbuild': case 'xcodebuild': case 'ant': case 'cmake': case 'bazel': case 'bazelisk': case 'sbt':
      return true;
    case 'dotnet': return !narrowed(args);
    case 'cargo': return !(kind === 'test' && narrowed(args) && quiet);
    case 'python': case 'python3': case 'py': {
      // `python -m pytest ...` / `python manage.py test`: the module flag and the script are not filters
      const m = args.indexOf('-m');
      const rest = (m >= 0 ? [...args.slice(0, m), ...args.slice(m + 2)] : args).filter((a) => !/(^|[\\/])manage\.py$/.test(a));
      return !narrowed(rest);
    }
    default:
      return kind === 'test' ? !narrowed(args) : true;
  }
}

function kindOf(prog: string, args: string[]): 'test' | 'build' | undefined {
  const a0 = args[0]?.toLowerCase();
  const nonFlag = args.filter((a) => !a.startsWith('-')).map((a) => a.toLowerCase());
  switch (prog) {
    case 'mvn': case 'mvnw': case 'mvnd':
    case 'gradle': case 'gradlew':
      return nonFlag.some((g) => /test|verify|check|integration/.test(g)) ? 'test' : 'build';
    case 'npm': case 'pnpm': case 'yarn': case 'bun': {
      if (!a0) return undefined; // bare `yarn` / `pnpm` = install
      if (a0 === 'test' || a0 === 't' || a0 === 'tst') return 'test';
      const script = a0 === 'run' || a0 === 'run-script' ? args[1]?.toLowerCase() : (prog === 'npm' ? undefined : a0);
      if (!script) return undefined;
      if (TEST_SCRIPT.test(script)) return 'test';
      if (BUILD_SCRIPT.test(script)) return 'build';
      return undefined;
    }
    case 'jest': case 'vitest': case 'mocha': case 'ava': case 'karma': case 'jasmine': case 'pytest': case 'py.test':
    case 'tox': case 'nox': case 'nosetests': case 'rspec': case 'phpunit': case 'pest': case 'ctest': case 'nextest':
      return 'test';
    case 'tsc': case 'msbuild': case 'xcodebuild': case 'ninja': case 'ant':
      return 'build';
    case 'playwright': return a0 === 'test' ? 'test' : undefined;
    case 'cypress': return a0 === 'run' ? 'test' : undefined;
    case 'ng': case 'nx': case 'turbo': case 'lerna': {
      const sub = nonFlag.find((x) => x !== 'run' && x !== 'run-many' && x !== 'affected');
      if (!sub) return nonFlag.includes('run-many') || nonFlag.includes('affected') ? 'build' : undefined;
      const s = sub.includes(':') ? sub.split(':').pop()! : sub;
      if (TEST_SCRIPT.test(s)) return 'test';
      if (BUILD_SCRIPT.test(s)) return 'build';
      return undefined;
    }
    case 'go':
      if (a0 === 'test' || a0 === 'vet') return 'test';
      if (a0 === 'build' || a0 === 'install') return 'build';
      return undefined;
    case 'dotnet':
      if (a0 === 'test') return 'test';
      if (a0 === 'build' || a0 === 'publish' || a0 === 'msbuild') return 'build';
      return undefined;
    case 'cargo':
      if (a0 === 'test' || a0 === 'nextest' || a0 === 'bench') return 'test';
      if (a0 === 'build' || a0 === 'check' || a0 === 'clippy') return 'build';
      return undefined;
    case 'make': case 'gmake': {
      const target = nonFlag.find((x) => !x.includes('='));
      if (!target) return 'build';
      if (/^(test|tests|check|ci|e2e|unit|integration)([-_].*)?$/.test(target)) return 'test';
      if (/^(all|build|compile|dist|package|release)([-_].*)?$/.test(target)) return 'build';
      return undefined;
    }
    case 'mix': case 'swift': case 'flutter': case 'dart': case 'deno': case 'sbt': case 'bazel': case 'bazelisk': case 'rake': case 'meson':
      if (nonFlag.some((x) => x === 'test' || x === 'spec' || x === 'tests')) return 'test';
      if (nonFlag.some((x) => x === 'build' || x === 'compile')) return 'build';
      return undefined;
    case 'cmake': return args.includes('--build') ? 'build' : undefined;
    case 'python': case 'python3': case 'py': {
      const m = args.indexOf('-m');
      const mod = m >= 0 ? args[m + 1]?.toLowerCase() : undefined;
      if (mod && /^(pytest|unittest|tox|nox|nose2?)$/.test(mod)) return 'test';
      if (nonFlag.some((x) => /manage\.py$/.test(x)) && nonFlag.includes('test')) return 'test';
      return undefined;
    }
    case 'manage.py': return a0 === 'test' ? 'test' : undefined;
    default:
      return undefined;
  }
}

// Commands that only read: they never change the workspace (no effect on "nothing changed since the last run").
const READ_ONLY = new Set([
  'ls', 'dir', 'cat', 'type', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'find', 'fd', 'tree', 'pwd', 'echo',
  'printf', 'wc', 'stat', 'file', 'which', 'where', 'whoami', 'env', 'printenv', 'date', 'du', 'df', 'diff', 'cmp', 'sort', 'uniq', 'cut', 'awk',
  'jq', 'yq', 'xxd', 'od', 'hexdump', 'basename', 'dirname', 'realpath', 'readlink', 'true', 'false', 'test', 'get-content', 'get-childitem',
  'select-string', 'get-location', 'gci', 'gc', 'sls', 'cd', 'chdir', 'set-location', 'sl', 'pushd', 'popd', 'push-location', 'pop-location',
  'ps', 'top', 'uname', 'hostname', 'id', 'sleep', 'history', 'man', 'help', 'kopt',
]);
const GIT_READ_ONLY = /^(status|log|diff|show|blame|branch|remote|rev-parse|ls-files|ls-tree|grep|describe|shortlog|config|reflog|whatchanged|cat-file|tag)$/;

/**
 * True when a shell command line can only read: every simple command is a known reader (`ls`, `cat`, `grep`, `git
 * status`...). Anything else (sed -i, git checkout, npm install, codegen, formatters, redirections into files) may
 * have changed the workspace.
 */
export function isReadOnlyCommand(raw: string): boolean {
  const command = String(raw ?? '').trim();
  if (!command) return true;
  // output redirection into a file (not 2>&1 or >/dev/null)
  if (/(^|[^0-9&>])>{1,2}\s*(?!&|\/dev\/null|nul\b|\$null)[^\s|&;]/i.test(command.replace(/2>&1|>&2/g, ''))) return false;
  for (const seg of command.split(/&&|\|\||;|\||\n/)) {
    const t = tokenize(seg);
    while (t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0])) t.shift();
    if (!t.length) continue;
    const prog = basename(t[0]);
    if (prog === 'git') {
      const sub = t.slice(1).find((a) => !a.startsWith('-'));
      if (!sub || !GIT_READ_ONLY.test(sub)) return false;
      if (sub === 'branch' && t.some((a) => /^-[dDmMcC]$|^--(delete|move|copy)$/.test(a))) return false;
      if ((sub === 'config' || sub === 'tag' || sub === 'remote') && t.filter((a) => !a.startsWith('-')).length > 2) return false;
      continue;
    }
    if (prog === 'sed' && t.some((a) => /^-i|^--in-place/.test(a))) return false;
    if (!READ_ONLY.has(prog)) return false;
  }
  return true;
}

/** Analyze a shell command line. Splitting ignores quoting on purpose: good enough for classification. */
export function analyzeCommand(raw: string): CommandInfo {
  const command = String(raw ?? '').trim();
  let core = command;
  let cdDir: string | undefined;
  // POSIX `cd`, cmd `cd /d` / `chdir` / `pushd`, PowerShell `Set-Location` / `sl` / `Push-Location`
  const cd = /^(?:cd|chdir|pushd|set-location|sl|push-location)\s+(?:\/d\s+)?("[^"]+"|'[^']+'|[^\s;&|]+)\s*(&&|;)\s*/i.exec(command);
  if (cd) {
    cdDir = cd[1].replace(/^["']|["']$/g, '');
    core = command.slice(cd[0].length).trim();
  }
  let kind: 'test' | 'build' | undefined;
  let verbose = false;
  let longRunning = false;
  // a trailing `&` (background job) never finishes from the agent's point of view either
  if (/[^&]&\s*$/.test(core)) longRunning = true;
  for (const seg of core.split(/&&|\|\||;|\||\n/)) {
    const c = classifySimple(tokenize(seg));
    if (c.longRunning) longRunning = true;
    if (c.verbose) verbose = true;
    if (c.kind === 'test') kind = 'test';
    else if (c.kind === 'build' && kind !== 'test') kind = 'build';
  }
  // kopt_run refuses these (pytest --looponfail, --hot, followers...): never redirect a command to a refusal
  if (!longRunning && longRunningReason(core)) longRunning = true;
  if (longRunning) {
    kind = undefined;
    verbose = false;
  }
  const key = `${cdDir ?? ''}|${core.replace(/\s+/g, ' ')}`;
  return { command, core, cdDir, kind, verbose, longRunning, key };
}
