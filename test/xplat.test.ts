// Cross-platform behaviour (Linux, macOS, Windows): path normalization, CRLF/BOM sources end to end, shell
// selection, process-tree kills, rename retries, PowerShell output, parse workers. Platform-specific logic is
// tested on every OS through injected platforms; real-process tests run on the OS executing the suite.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { defaultConfig, type KoptConfig } from '../src/core/config.js';
import { newToolContext } from '../src/core/context.js';
import { isCacheableCommand, parseCommand, relativizeRoot, runCommand } from '../src/compress/index.js';
import { decodeClixml, normalizeOutput, stripPowerShellErrorNoise } from '../src/compress/normalize.js';
import {
  execCapture,
  findOnPath,
  joinCommand,
  powershellScript,
  quoteArg,
  resolveShell,
  shellFor,
  shellKindOf,
  treeKillCommand,
} from '../src/compress/runner.js';
import { backgroundSpawnOptions, koptInvocation, tsxImportUrl } from '../src/hooks/spawn.js';
import { extractFile, indexRepo } from '../src/indexer/index.js';
import { createPreparer, workerExecArgv } from '../src/indexer/pool.js';
import { prepareFile, type PrepJob } from '../src/indexer/prepare.js';
import { normalizeRel } from '../src/indexer/walker.js';
import { find, outline, read } from '../src/retrieval/index.js';
import { splitLines } from '../src/retrieval/source.js';
import { Store } from '../src/store/store.js';
import {
  atomicWrite,
  readJson,
  renameWithRetry,
  renameWithRetryAsync,
  repoRelative,
  samePath,
  stripBom,
  withFileLock,
} from '../src/telemetry/fsutil.js';

const WIN = process.platform === 'win32';
const dirs: string[] = [];
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `kopt-xplat-${prefix}-`));
  dirs.push(d);
  return d;
}

const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  // never read the developer's real ~/.kiro (global kiroignore) from the indexer
  savedEnv.KOPT_KIRO_HOME = process.env.KOPT_KIRO_HOME;
  process.env.KOPT_KIRO_HOME = tempDir('kirohome');
});
afterAll(() => {
  if (savedEnv.KOPT_KIRO_HOME === undefined) delete process.env.KOPT_KIRO_HOME;
  else process.env.KOPT_KIRO_HOME = savedEnv.KOPT_KIRO_HOME;
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

// ---------------------------------------------------------------------------------------------------------------

describe('path normalization', () => {
  const root = 'C:\\Users\\dev\\repo';

  it('turns Windows absolute paths into repo-relative forward-slash paths', () => {
    expect(repoRelative(root, 'C:\\Users\\dev\\repo\\src\\main\\A.java', 'win32')).toBe('src/main/A.java');
    expect(repoRelative(root, 'C:/Users/dev/repo/src/a.ts', 'win32')).toBe('src/a.ts');
    expect(repoRelative(root, 'C:\\Users\\dev\\repo', 'win32')).toBe('');
    expect(repoRelative(root, 'C:\\Users\\dev\\repo\\', 'win32')).toBe('');
    expect(repoRelative(`${root}\\`, 'C:\\Users\\dev\\repo\\x.ts', 'win32')).toBe('x.ts');
  });

  it('matches the root case-insensitively on Windows and keeps the caller spelling of the rest', () => {
    expect(repoRelative(root, 'c:\\users\\DEV\\Repo\\src\\Main.java', 'win32')).toBe('src/Main.java');
    expect(repoRelative('/home/dev/repo', '/home/dev/Repo/a.ts', 'linux')).toBeUndefined();
    expect(repoRelative('/Users/dev/repo', '/users/dev/REPO/a.ts', 'darwin')).toBe('a.ts');
  });

  it('understands long paths, UNC shares and file URLs', () => {
    expect(repoRelative(root, '\\\\?\\C:\\Users\\dev\\repo\\src\\a.ts', 'win32')).toBe('src/a.ts');
    expect(repoRelative('\\\\server\\share\\repo', '\\\\server\\share\\repo\\lib\\b.cs', 'win32')).toBe('lib/b.cs');
    expect(repoRelative(root, 'file:///C:/Users/dev/repo/src/a%20b.ts', 'win32')).toBe('src/a b.ts');
    expect(repoRelative('/srv/repo', 'file:///srv/repo/x/y.py', 'linux')).toBe('x/y.py');
  });

  it('normalizes relative paths and rejects everything outside the root', () => {
    expect(repoRelative(root, 'src\\main\\A.java', 'win32')).toBe('src/main/A.java');
    expect(repoRelative(root, '.\\src\\.\\a.ts', 'win32')).toBe('src/a.ts');
    expect(repoRelative(root, 'src\\..\\lib\\b.ts', 'win32')).toBe('lib/b.ts');
    expect(repoRelative(root, '..\\other\\a.ts', 'win32')).toBeUndefined();
    expect(repoRelative(root, 'C:\\Users\\dev\\repo2\\a.ts', 'win32')).toBeUndefined();
    expect(repoRelative(root, 'D:\\repo\\a.ts', 'win32')).toBeUndefined();
    expect(repoRelative('/srv/repo', '/srv/repository/a.ts', 'linux')).toBeUndefined();
  });

  it('treats the macOS /private aliases of /var and /tmp as the same directory', () => {
    expect(repoRelative('/var/folders/x/repo', '/private/var/folders/x/repo/src/a.ts', 'darwin')).toBe('src/a.ts');
    expect(repoRelative('/private/tmp/repo', '/tmp/repo/a.ts', 'darwin')).toBe('a.ts');
    expect(repoRelative('/var/x/repo', '/private/var/x/repo/a.ts', 'linux')).toBeUndefined();
  });

  it('walker.normalizeRel gives DB paths for any input form', () => {
    expect(normalizeRel(root, 'C:\\Users\\dev\\repo\\src\\a.ts', 'win32')).toBe('src/a.ts');
    expect(normalizeRel(root, 'c:/users/dev/repo/src/a.ts', 'win32')).toBe('src/a.ts');
    expect(normalizeRel(root, 'src\\a.ts', 'win32')).toBe('src/a.ts');
    expect(normalizeRel('/srv/repo', '/srv/repo/./src//a.ts', 'linux')).toBe('src/a.ts');
    // outside the root: cleaned but never a valid repo path
    expect(normalizeRel(root, 'D:\\elsewhere\\a.ts', 'win32')).toBe('D:/elsewhere/a.ts');
  });

  it('samePath ignores separators, trailing slashes and (Windows/macOS) case', () => {
    expect(samePath('C:\\Repo\\', 'c:/repo', 'win32')).toBe(true);
    expect(samePath('/a/B', '/a/b', 'linux')).toBe(false);
    expect(samePath('/a/b/', '/a/b', 'linux')).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('CRLF and BOM sources: extract -> index -> read', () => {
  const JAVA = [
    'package demo;',
    '',
    '/** Computes totals. */',
    'public class Totals {',
    '  /** Sum of the amounts. */',
    '  public int total(int a, int b) {',
    '    return a + b;',
    '  }',
    '',
    '  public int twice(int a) {',
    '    return total(a, a);',
    '  }',
    '}',
    '',
  ];
  const TS = ['export function greet(name: string): string {', '  return `hi ${name}`;', '}', '', 'export const answer = 42;', ''];
  const crlf = (lines: string[]) => lines.join('\r\n');
  const lf = (lines: string[]) => lines.join('\n');
  let root: string;
  let cfg: KoptConfig;
  let store: Store;

  beforeAll(async () => {
    root = tempDir('crlf');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'Totals.java'), crlf(JAVA));
    writeFileSync(join(root, 'src', 'greet.ts'), '\uFEFF' + crlf(TS));
    cfg = defaultConfig(root);
    cfg.dataDir = join(tempDir('crlf-data'), '.kopt');
    store = Store.open(join(cfg.dataDir, 'index.db'), { root });
    await indexRepo(store, { config: cfg });
  });
  afterAll(() => {
    try {
      store.close();
    } catch {
      /* closed */
    }
  });

  it('extracts the same lines, signatures and docs from CRLF as from LF text', async () => {
    const a = await extractFile('src/Totals.java', lf(JAVA));
    const b = await extractFile('src/Totals.java', crlf(JAVA));
    const view = (f: typeof a) => f!.symbols.map((s) => [s.qualifiedName, s.startLine, s.endLine, s.signature, s.doc ?? '']);
    expect(view(b)).toEqual(view(a));
    expect(JSON.stringify(view(b))).not.toContain('\\r');
    const total = b!.symbols.find((s) => s.name === 'total')!;
    expect([total.startLine, total.endLine]).toEqual([6, 8]);
  });

  it('indexes repo-relative forward-slash paths', () => {
    const paths = (store.db.prepare('SELECT path FROM files ORDER BY path').all() as Array<{ path: string }>).map((r) => r.path);
    expect(paths).toEqual(['src/Totals.java', 'src/greet.ts']);
  });

  it('read returns code without CR, with the right line numbers', () => {
    const r = read(store, { target: 'Totals.total' }, newToolContext(cfg));
    expect(r.text).not.toContain('\r');
    expect(r.text).toContain('src/Totals.java:6-8');
    expect(r.text).toContain(['  public int total(int a, int b) {', '    return a + b;', '  }'].join('\n'));
    const range = read(store, { target: 'src/Totals.java:10-12' }, newToolContext(cfg));
    expect(range.text).not.toContain('\r');
    expect(range.text).toContain(JAVA.slice(9, 12).join('\n'));
  });

  it('byte offsets point into the file as stored (BOM and CR included)', () => {
    const raw = readFileSync(join(root, 'src', 'greet.ts'));
    const row = (name: string) => store.db.prepare('SELECT start_byte AS a, end_byte AS b FROM symbols WHERE name = ?').get(name) as { a: number; b: number };
    const greet = row('greet');
    expect(greet.a).toBe(3);
    expect(raw.subarray(greet.a, greet.b).toString('utf8')).toBe(crlf(TS.slice(0, 3)));
    const java = readFileSync(join(root, 'src', 'Totals.java'));
    const twice = row('twice');
    expect(java.subarray(twice.a, twice.b).toString('utf8')).toBe(crlf(JAVA.slice(9, 12)).trimStart());
  });

  it('read of a BOM file never returns the BOM', () => {
    const r = read(store, { target: 'greet' }, newToolContext(cfg));
    expect(r.text).toContain('src/greet.ts:1-3');
    expect(r.text).not.toContain('\uFEFF');
    expect(r.text).not.toContain('\r');
    expect(r.text).toContain('export function greet(name: string): string {\n  return `hi ${name}`;\n}');
  });

  it('outline and find output carry no CR', () => {
    const o = outline(store, { path: 'src/Totals.java' }, newToolContext(cfg));
    expect(o.text).toContain('total');
    expect(o.text).not.toContain('\r');
    const f = find(store, { query: 'total amounts' }, newToolContext(cfg));
    expect(f.text).toContain('src/Totals.java');
    expect(f.text).not.toContain('\r');
  });

  it('a CRLF file edited after indexing is still read without CR', () => {
    const edited = [...JAVA];
    edited.splice(5, 0, '  // inserted line', '  // another');
    writeFileSync(join(root, 'src', 'Totals.java'), crlf(edited));
    const r = read(store, { target: 'Totals.twice', fresh: true }, newToolContext(cfg));
    expect(r.text).not.toContain('\r');
    expect(r.text).toContain('public int twice(int a) {');
  });

  it('splitLines drops CR of CRLF and of mixed endings, but keeps a lone CR inside a line', () => {
    expect(splitLines('a\r\nb\nc\r\n')).toEqual(['a', 'b', 'c']);
    expect(splitLines('a\rb\r\nc')).toEqual(['a\rb', 'c']);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('shell selection', () => {
  const has = (...paths: string[]) => (p: string) => paths.includes(p);
  const decode = (args: string[]) => Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');

  it('POSIX: bash when available (even if the login shell is zsh), else sh', () => {
    expect(shellFor('npm test', { platform: 'linux', env: { SHELL: '/bin/zsh' }, exists: has('/bin/bash') })).toEqual({
      file: '/bin/bash',
      args: ['-c', 'npm test'],
      verbatim: false,
      kind: 'posix',
    });
    expect(resolveShell({ platform: 'darwin', env: { SHELL: '/opt/homebrew/bin/bash' }, exists: has('/opt/homebrew/bin/bash', '/bin/bash') }).file).toBe(
      '/opt/homebrew/bin/bash',
    );
    expect(resolveShell({ platform: 'linux', env: {}, exists: () => false })).toEqual({ file: '/bin/sh', kind: 'posix' });
  });

  it('Windows: pwsh from PATH first (accepts &&), with an encoded script and process-scope Bypass', () => {
    const env = { Path: 'C:\\Windows\\system32;"C:\\Program Files\\PowerShell\\7"', SystemRoot: 'C:\\Windows' };
    const sh = shellFor('cd api && npm test', {
      platform: 'win32',
      env,
      exists: has('C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'),
    });
    expect(sh.file).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe');
    expect(sh.kind).toBe('powershell');
    expect(sh.verbatim).toBe(false);
    expect(sh.args.slice(0, 7)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-OutputFormat', 'Text']);
    expect(decode(sh.args)).toBe(powershellScript('cd api && npm test'));
  });

  it('Windows: Windows PowerShell 5.1 from System32 when pwsh is absent, then cmd.exe', () => {
    const env = { PATH: 'C:\\Windows\\system32', SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\system32\\cmd.exe' };
    const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    expect(resolveShell({ platform: 'win32', env, exists: has(ps) })).toEqual({ file: ps, kind: 'powershell' });
    expect(shellFor('npm test', { platform: 'win32', env, exists: () => false })).toEqual({
      file: 'C:\\Windows\\system32\\cmd.exe',
      args: ['/d', '/s', '/c', '"npm test"'],
      verbatim: true,
      kind: 'cmd',
    });
  });

  it('KOPT_SHELL overrides the choice on every platform', () => {
    expect(shellFor('dir', { platform: 'win32', env: { KOPT_SHELL: 'cmd.exe' } })).toMatchObject({ file: 'cmd.exe', kind: 'cmd', verbatim: true });
    expect(shellFor('ls', { platform: 'win32', env: { kopt_shell: 'C:\\Program Files\\Git\\bin\\bash.exe' } })).toEqual({
      file: 'C:\\Program Files\\Git\\bin\\bash.exe',
      args: ['-c', 'ls'],
      verbatim: false,
      kind: 'posix',
    });
    expect(shellKindOf('"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"')).toBe('powershell');
    expect(shellKindOf('/usr/local/bin/pwsh')).toBe('powershell');
    expect(shellKindOf('C:\\Windows\\system32\\CMD.EXE')).toBe('cmd');
  });

  it('very long PowerShell commands fall back to -Command (Windows command-line limit)', () => {
    const long = `echo ${'x'.repeat(20_000)}`;
    const sh = shellFor(long, { platform: 'win32', env: { KOPT_SHELL: 'pwsh.exe' } });
    expect(sh.args).not.toContain('-EncodedCommand');
    expect(sh.args[sh.args.length - 2]).toBe('-Command');
  });

  it('the PowerShell wrapper maps exit codes like a POSIX shell', () => {
    const s = powershellScript('npm test');
    expect(s.split('\n')[1]).toBe('npm test');
    expect(s).toContain('exit $__koptCode');
    expect(s).toContain("'CommandNotFoundException*') { exit 127 }");
    expect(s).toContain("$ProgressPreference = 'SilentlyContinue'");
  });

  it('quotes arguments for each shell family', () => {
    expect(quoteArg('it\'s', 'posix')).toBe(`'it'\\''s'`);
    expect(quoteArg('a b', 'powershell')).toBe(`'a b'`);
    expect(quoteArg("it's", 'powershell')).toBe(`'it''s'`);
    expect(quoteArg('-x', 'powershell')).toBe(`'-x'`);
    expect(quoteArg('C:\\Program Files\\node.exe', 'cmd')).toBe('"C:\\Program Files\\node.exe"');
    expect(quoteArg('say "hi"', 'cmd')).toBe('"say ""hi"""');
    expect(quoteArg('src/a.ts', 'cmd')).toBe('src/a.ts');
  });

  it('joins argv into a command line PowerShell can run (call operator before a quoted program)', () => {
    expect(joinCommand(['C:\\Program Files\\nodejs\\node.exe', '-e', 'process.exit(3)'], 'powershell')).toBe(
      "& 'C:\\Program Files\\nodejs\\node.exe' '-e' 'process.exit(3)'",
    );
    expect(joinCommand(['npm', 'test'], 'powershell')).toBe('npm test');
    expect(joinCommand(['sh', '-c', "echo 'a'; exit 3"], 'posix')).toBe(`sh -c 'echo '\\''a'\\''; exit 3'`);
    expect(joinCommand(['C:\\Program Files\\x.exe', 'a b'], 'cmd')).toBe('"C:\\Program Files\\x.exe" "a b"');
  });

  it('finds executables on PATH with the platform separator', () => {
    expect(findOnPath('git.exe', { platform: 'win32', env: { PATH: 'C:\\a;C:\\Git\\cmd' }, exists: has('C:\\Git\\cmd\\git.exe') })).toBe('C:\\Git\\cmd\\git.exe');
    expect(findOnPath('git', { platform: 'linux', env: { PATH: '/usr/local/bin:/usr/bin' }, exists: has('/usr/bin/git') })).toBe('/usr/bin/git');
    expect(findOnPath('git', { platform: 'linux', env: {}, exists: () => true })).toBeUndefined();
  });

  it('this machine uses PowerShell on Windows and a POSIX shell elsewhere', () => {
    expect(resolveShell().kind).toBe(process.env.KOPT_SHELL ? shellKindOf(process.env.KOPT_SHELL) : WIN ? 'powershell' : 'posix');
  });
});

describe('Windows command lines', () => {
  it('recognises the program behind PowerShell call operators, .cmd/.bat shims and Windows paths', () => {
    const progs = (c: string) => parseCommand(c).segments.map((s) => s.program);
    expect(progs("& 'C:\\Program Files\\Maven\\bin\\mvn.cmd' -q test")).toContain('mvn');
    expect(progs('.\\gradlew.bat test --offline')).toEqual(['gradlew']);
    expect(progs('npm.cmd run build')).toEqual(['npm']);
    expect(progs("$env:CI='1'; npx.cmd jest --ci")).toEqual(['jest']);
  });

  it('keeps PowerShell pipelines and cd chains cacheable like their bash forms', () => {
    expect(isCacheableCommand('npm test | Select-Object -Last 50')).toBe(true);
    expect(isCacheableCommand("$env:CI='1'; npm test")).toBe(true);
    expect(isCacheableCommand('Set-Location api; mvn -q test')).toBe(true);
    expect(isCacheableCommand('& .\\gradlew.bat test')).toBe(true);
    expect(isCacheableCommand('cmd /c "npm test"')).toBe(true);
    expect(isCacheableCommand('Invoke-WebRequest https://example.com')).toBe(false);
  });
});

describe('process-tree kill', () => {
  it('builds taskkill /T /F on Windows, nothing (process-group signal) on POSIX', () => {
    expect(treeKillCommand(4242, { platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, exists: () => true })).toEqual({
      file: 'C:\\Windows\\System32\\taskkill.exe',
      args: ['/pid', '4242', '/T', '/F'],
    });
    expect(treeKillCommand(7, { platform: 'win32', env: {}, exists: () => false })).toEqual({ file: 'taskkill.exe', args: ['/pid', '7', '/T', '/F'] });
    expect(treeKillCommand(7, { platform: 'linux' })).toBeUndefined();
    expect(treeKillCommand(7, { platform: 'darwin' })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('kopt_run on this OS', () => {
  const kind = resolveShell().kind;
  const nodeCmd = (code: string) => {
    const dir = tempDir('run-scripts');
    const file = join(dir, 'script.cjs');
    writeFileSync(file, code);
    const line = [process.execPath, file].map((a) => quoteArg(a, kind)).join(' ');
    return kind === 'powershell' ? `& ${line}` : line;
  };

  it('propagates the exit code and output of a failing command', async () => {
    const r = await execCapture({ command: nodeCmd("console.error('boom: 42'); process.exit(3)"), cwd: tmpdir(), timeoutMs: 30_000 });
    expect(r.exitCode).toBe(3);
    expect(normalizeOutput(r.output)).toContain('boom: 42');
  });

  it('prints repo-relative forward-slash paths for files under the root', async () => {
    const root = tempDir('relpaths');
    mkdirSync(join(root, 'src'), { recursive: true });
    const cfg = defaultConfig(root);
    cfg.dataDir = join(tempDir('relpaths-data'), '.kopt');
    const r = await runCommand(
      { command: nodeCmd(`console.log(require('path').join(${JSON.stringify(root)}, 'src', 'a.ts') + ':3: error: nope'); process.exit(1)`) },
      newToolContext(cfg),
    );
    expect(r.text).toContain('src/a.ts:3: error: nope');
    expect(r.text).not.toContain(root);
  });

  it.runIf(WIN)('Windows: cmd.exe and Windows PowerShell 5.1 propagate exit codes too', async () => {
    const prev = process.env.KOPT_SHELL;
    try {
      process.env.KOPT_SHELL = process.env.ComSpec || 'cmd.exe';
      const viaCmd = await execCapture({ command: `"${process.execPath}" -e "process.exit(4)"`, cwd: tmpdir(), timeoutMs: 30_000 });
      expect(viaCmd.exitCode).toBe(4);
      process.env.KOPT_SHELL = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const viaPs = await execCapture({ command: `& '${process.execPath}' -e 'process.exit(5)'`, cwd: tmpdir(), timeoutMs: 60_000 });
      expect(viaPs.exitCode).toBe(5);
      const unknown = await execCapture({ command: 'definitely-not-a-command-kopt', cwd: tmpdir(), timeoutMs: 60_000 });
      expect(unknown.exitCode).toBe(127);
    } finally {
      if (prev === undefined) delete process.env.KOPT_SHELL;
      else process.env.KOPT_SHELL = prev;
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('output normalization', () => {
  it('drops byte order marks and CRLF', () => {
    expect(normalizeOutput('\uFEFFline one\r\nline two\r\n')).toBe('line one\nline two');
  });

  it('decodes PowerShell CLIXML error streams and drops progress records', () => {
    const clixml = [
      'before',
      '#< CLIXML',
      '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T></TN><MS><I64 N="SourceId">1</I64><PR N="Record"><AV>Preparing modules for first use.</AV></PR></MS></Obj><S S="Error">npm : ERR! missing script: &quot;tset&quot;_x000D__x000A_</S><S S="Error">At line:1 char:1_x000D__x000A_</S></Objs>',
      'after',
    ];
    expect(decodeClixml(clixml)).toEqual(['before', 'npm : ERR! missing script: "tset"', 'At line:1 char:1', 'after']);
    expect(normalizeOutput(clixml.join('\r\n'))).toBe('before\nnpm : ERR! missing script: "tset"\nAt line:1 char:1\nafter');
  });

  it('reduces Windows PowerShell 5.1 error blocks to their message (native stderr loses its prefix)', () => {
    const ps51 = [
      'node : 42',
      'At line:2 char:1',
      "+ & 'C:\\Program Files\\nodejs\\node.exe' -e 'console.error(42)'",
      '+ ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
      '    + CategoryInfo          : NotSpecified: (42:String) [], RemoteException',
      '    + FullyQualifiedErrorId : NativeCommandError',
      ' ',
      'more stderr',
      "nope-kopt : The term 'nope-kopt' is not recognized as the name of a cmdlet, function, script file, or operable program.",
      'At line:2 char:1',
      '+ nope-kopt',
      '+ ~~~~~~~~~',
      '    + CategoryInfo          : ObjectNotFound: (nope-kopt:String) [], CommandNotFoundException',
      '    + FullyQualifiedErrorId : CommandNotFoundException',
    ];
    expect(normalizeOutput(ps51.join('\r\n')).split('\n')).toEqual([
      '42',
      'more stderr',
      "nope-kopt : The term 'nope-kopt' is not recognized as the name of a cmdlet, function, script file, or operable program.",
    ]);
  });

  it('reduces pwsh 7 ConciseView error blocks to one line', () => {
    const pwsh7 = [
      'Get-Item: ',
      'Line |',
      '   3 |  Get-Item /nonexistent-kopt',
      '     |  ~~~~~~~~~~~~~~~~~~~~~~~~~~',
      "     | Cannot find path '/nonexistent-kopt' because it does not exist.",
      '42',
    ];
    expect(normalizeOutput(pwsh7.join('\n')).split('\n')).toEqual(["Get-Item: Cannot find path '/nonexistent-kopt' because it does not exist.", '42']);
    // lines that merely look similar stay untouched
    expect(stripPowerShellErrorNoise(['At line:2 char:1', 'x'])).toEqual(['At line:2 char:1', 'x']);
    expect(stripPowerShellErrorNoise(['summary:', 'Line |', 'plain'])).toEqual(['summary:', 'Line |', 'plain']);
  });

  it('relativizes Windows paths in any case and separator, with forward slashes', () => {
    const root = 'C:\\Users\\dev\\repo';
    const text = [
      'C:\\Users\\dev\\repo\\src\\a.ts(12,5): error TS2322: nope',
      'c:\\users\\dev\\repo\\src\\b.ts:3',
      'at Object.<anonymous> (C:/Users/dev/repo/test/c.test.js:7:9)',
      '"file":"C:\\\\Users\\\\dev\\\\repo\\\\src\\\\d.ts"',
      'cwd C:\\Users\\dev\\repo done',
      'C:\\Users\\dev\\repo2\\x.ts stays',
    ].join('\n');
    expect(relativizeRoot(text, [root], 'win32').split('\n')).toEqual([
      'src/a.ts(12,5): error TS2322: nope',
      'src/b.ts:3',
      'at Object.<anonymous> (test/c.test.js:7:9)',
      '"file":"src/d.ts"',
      'cwd . done',
      'C:\\Users\\dev\\repo2\\x.ts stays',
    ]);
    // POSIX: case-sensitive, backslashes untouched, never strips a bare filesystem root
    expect(relativizeRoot('/srv/repo/a\\b.txt and /srv/Repo/c', ['/srv/repo'], 'linux')).toBe('a\\b.txt and /srv/Repo/c');
    expect(relativizeRoot('/usr/lib/x C:\\x', ['/', 'C:\\'], 'win32')).toBe('/usr/lib/x C:\\x');
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('rename retry and atomic writes', () => {
  const err = (code: string) => Object.assign(new Error(code), { code });

  it('retries transient Windows sharing violations, then succeeds', () => {
    let calls = 0;
    renameWithRetry('a', 'b', {
      platform: 'win32',
      rename: () => {
        if (++calls < 3) throw err(calls === 1 ? 'EPERM' : 'EBUSY');
      },
    });
    expect(calls).toBe(3);
  });

  it('throws at once on POSIX and for non-transient errors', () => {
    let calls = 0;
    const fail = (code: string) => () => {
      calls++;
      throw err(code);
    };
    expect(() => renameWithRetry('a', 'b', { platform: 'linux', rename: fail('EPERM') })).toThrow('EPERM');
    expect(calls).toBe(1);
    calls = 0;
    expect(() => renameWithRetry('a', 'b', { platform: 'win32', rename: fail('ENOENT') })).toThrow('ENOENT');
    expect(calls).toBe(1);
  });

  it('gives up after the timeout when the file stays locked', () => {
    let calls = 0;
    const t0 = Date.now();
    expect(() =>
      renameWithRetry('a', 'b', {
        platform: 'win32',
        timeoutMs: 60,
        rename: () => {
          calls++;
          throw err('EACCES');
        },
      }),
    ).toThrow('EACCES');
    expect(calls).toBeGreaterThan(1);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('async variant behaves the same', async () => {
    let calls = 0;
    await renameWithRetryAsync('a', 'b', {
      platform: 'win32',
      rename: async () => {
        if (++calls < 2) throw err('EBUSY');
      },
    });
    expect(calls).toBe(2);
    await expect(renameWithRetryAsync('a', 'b', { platform: 'darwin', rename: async () => Promise.reject(err('EPERM')) })).rejects.toThrow('EPERM');
  });

  it('atomicWrite replaces files and leaves no temp file behind', () => {
    const dir = tempDir('atomic');
    const file = join(dir, 'state.json');
    atomicWrite(file, '{"v":1}');
    atomicWrite(file, '{"v":2}');
    expect(readFileSync(file, 'utf8')).toBe('{"v":2}');
    expect(readdirSync(dir)).toEqual(['state.json']);
  });

  it('readJson and stripBom accept files written with a BOM', () => {
    const dir = tempDir('bom');
    const file = join(dir, 'mcp.json');
    writeFileSync(file, '\uFEFF{"mcpServers":{}}');
    expect(readJson(file, { fallback: true })).toEqual({ mcpServers: {} });
    expect(stripBom('\uFEFFx')).toBe('x');
    expect(stripBom('x')).toBe('x');
  });

  it('withFileLock runs the function and releases the lock', () => {
    const dir = tempDir('lock');
    const lock = join(dir, 'a.lock');
    expect(withFileLock(lock, () => existsSync(lock))).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('background spawns and the kopt command line', () => {
  const prev = process.env.KOPT_CLI;
  afterEach(() => {
    if (prev === undefined) delete process.env.KOPT_CLI;
    else process.env.KOPT_CLI = prev;
  });

  it('detached, hidden, no inherited stdio', () => {
    const o = backgroundSpawnOptions('/repo');
    expect(o).toMatchObject({ cwd: '/repo', detached: true, stdio: 'ignore', windowsHide: true });
    expect((o.env as NodeJS.ProcessEnv).KOPT_BACKGROUND).toBe('1');
  });

  it('runs node by absolute path; TypeScript entries get tsx as a file URL (Windows-safe)', () => {
    const dir = tempDir('entry');
    const js = join(dir, 'bin.js');
    const ts = join(dir, 'cli.ts');
    writeFileSync(js, '');
    writeFileSync(ts, '');
    process.env.KOPT_CLI = js;
    expect(koptInvocation()).toEqual([process.execPath, '--no-warnings=ExperimentalWarning', js]);
    process.env.KOPT_CLI = ts;
    const inv = koptInvocation();
    expect(inv[0]).toBe(process.execPath);
    expect(inv[inv.indexOf('--import') + 1]).toMatch(/^file:\/\//);
    expect(inv[inv.length - 1]).toBe(ts);
    expect(tsxImportUrl()).toMatch(/^file:\/\/.*tsx/);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('parse worker pool', () => {
  let root: string;
  let jobs: PrepJob[];
  beforeAll(() => {
    root = tempDir('pool');
    jobs = [];
    for (let i = 0; i < 160; i++) {
      const rel = `src/m${i}.ts`;
      const text = `export function fn${i}(x: number): number {\r\n  return x + ${i};\r\n}\r\nexport class C${i} { run() { return fn${i}(1); } }\r\n`;
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, rel), text);
      jobs.push({ abs: join(root, rel), rel, size: text.length, mtimeMs: 0, maxBytes: 1_000_000, withBlobs: false });
    }
  });

  it('pins a bare `--import tsx` to an absolute file URL and drops inspector flags', () => {
    expect(workerExecArgv(['--inspect=9229', '--import', 'tsx'], true, 'file:///x/tsx/dist/loader.mjs')).toEqual(['--import', 'file:///x/tsx/dist/loader.mjs']);
    expect(workerExecArgv(['--no-warnings'], true, 'file:///x/tsx/dist/loader.mjs')).toEqual(['--no-warnings', '--import', 'file:///x/tsx/dist/loader.mjs']);
    expect(workerExecArgv(['--no-warnings'], false, 'file:///x/tsx/dist/loader.mjs')).toEqual(['--no-warnings']);
  });

  it('parses in worker threads with the same results as in-process', async () => {
    const errors = vi.spyOn(process.stderr, 'write');
    try {
      const pool = createPreparer(jobs.length, { workers: 2 });
      expect(pool.window).toBeGreaterThan(16); // a real pool, not the inline fallback
      const viaPool = await Promise.all(jobs.map((j) => pool.run(j)));
      expect((pool as unknown as { healthy: boolean }).healthy).toBe(true);
      await pool.close();
      const inline = await Promise.all(jobs.slice(0, 5).map((j) => prepareFile(j)));
      const names = (p: (typeof viaPool)[number]) => (p.kind === 'file' ? p.file.symbols.map((s) => `${s.qualifiedName}:${s.startLine}-${s.endLine}`) : [p.kind]);
      expect(viaPool.slice(0, 5).map(names)).toEqual(inline.map(names));
      expect(viaPool.every((p) => p.kind === 'file')).toBe(true);
      expect(errors.mock.calls.map((c) => String(c[0])).join('')).not.toMatch(/parse worker failed|cannot start parse workers/);
    } finally {
      errors.mockRestore();
    }
  });

  it('falls back to in-process parsing when workers cannot start', async () => {
    const errors = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const pool = createPreparer(jobs.length, { workers: 2, script: new URL('./does-not-exist-worker.js', import.meta.url) });
      const out = await Promise.all(jobs.slice(0, 20).map((j) => pool.run(j)));
      await pool.close();
      expect(out.every((p) => p.kind === 'file')).toBe(true);
      expect(errors.mock.calls.map((c) => String(c[0])).join('')).toMatch(/parse worker failed|cannot start parse workers/);
    } finally {
      errors.mockRestore();
    }
  });
});
