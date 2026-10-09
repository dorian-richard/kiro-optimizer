// Recognition of verbose test/build shell commands (the main credit sink: full logs re-billed every turn).

export interface CommandInfo {
  /** Command as the agent wrote it (trimmed). */
  command: string;
  /** Command without a leading `cd <dir> &&` prefix. */
  core: string;
  /** Directory from a leading `cd <dir> &&` prefix, if any. */
  cdDir?: string;
  /** 'test' | 'build' when the command is a verbose test/build run. */
  kind?: 'test' | 'build';
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
const VERSION_ONLY = /^(-v|-V|--version|version|-h|--help|help)$/;

function basename(p: string): string {
  const s = p.replace(/^["']|["']$/g, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return (i >= 0 ? s.slice(i + 1) : s).toLowerCase().replace(/\.(cmd|bat|exe|sh|ps1)$/, '');
}

function tokenize(segment: string): string[] {
  return segment.trim().split(/\s+/).filter(Boolean);
}

/** Classify one simple command (no `&&`, `|`...). */
function classifySimple(tokens: string[]): 'test' | 'build' | undefined {
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
  if (!t.length) return undefined;
  const prog = basename(t[0]);
  const args = t.slice(1);
  const a0 = args[0]?.toLowerCase();
  const nonFlag = args.filter((a) => !a.startsWith('-')).map((a) => a.toLowerCase());
  if (args.length && args.every((a) => VERSION_ONLY.test(a))) return undefined;

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
  for (const seg of core.split(/&&|\|\||;|\||\n/)) {
    const k = classifySimple(tokenize(seg));
    if (k === 'test') { kind = 'test'; break; }
    if (k === 'build') kind = 'build';
  }
  const key = `${cdDir ?? ''}|${core.replace(/\s+/g, ' ')}`;
  return { command, core, cdDir, kind, key };
}
