// `kopt setup`: one-shot, idempotent, user-level installation. After it, kopt starts by itself in every project
// opened in Kiro IDE or Kiro CLI, and nothing is written into projects (the index lives in the user cache dir).
//
// Files (all under ~/.kiro unless noted; KIRO_HOME / KOPT_KIRO_HOME relocate it):
//   settings/mcp.json        mcpServers.kopt = { command: "kopt", args: ["mcp"], autoApprove: read-only tools } (merge)
//   hooks/kopt.json          v1 hooks: IDE 1.x and CLI V3 (global hooks)
//   agents/kopt.json         CLI 2.x agent with embedded object-form hooks + includeMcpJson, set as chat.defaultAgent
//                            in settings/cli.json (only when unset, or with --force)
//   agents/kopt-explorer.json  read-only exploration sub-agent on a cheaper model
//   steering/kopt.md, kopt-specs.md  global steering
//   settings/kiroignore      generic token-sink patterns (marked block, merged)
//   <IDE user settings.json> kiroAgent.agentIgnoreFiles += ".kiroignore" (IDE only honours workspace .kiroignore then)
// IDE 0.x has no global hooks: the MCP server writes workspace legacy hooks itself (see legacy.ts).

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathFor, userDirFor } from '../core/config.js';
import { packageRoot } from '../hooks/spawn.js';
import { binPath, hookCommandLine, resolveKoptCommand, type KoptCommand } from './command.js';
import { describeSurfaces, detectSurfaces, hookPlan, writeSurfacesCache, type HookPlan, type SurfaceChoice, type Surfaces, type VersionRunner } from './detect.js';
import { ensureArrayValue } from './jsonc.js';
import { kiroignoreBlock, mergeKiroignore, type KiroignoreSuggestion } from './kiroignore.js';
import { hostEnv, isNpxCachePath, kiroCliSettingsPath, kiroHomeDir, kiroUserSettingsPath, type HostEnv } from './paths.js';
import { deepEqual, parseJsonObject, Plan, readState, readText, writeState, type InstallResult, type SetupState } from './plan.js';

export const PACKAGE_NAME = 'kiro-optimizer';
export const DEFAULT_INSTALL_SPEC = 'github:dorian-richard/kiro-optimizer';
/** Read-only tools: auto-approved. kopt_run executes commands and keeps Kiro's approval prompt. */
export const AUTO_APPROVE = ['kopt_find', 'kopt_read', 'kopt_outline', 'kopt_refs', 'kopt_expand'];
export const DEFAULT_EXPLORER_MODEL = 'claude-haiku-4.5';
export const IGNORE_SETTING = 'kiroAgent.agentIgnoreFiles';
export const DEFAULT_AGENT_SETTING = 'chat.defaultAgent';

/** Patterns safe in every repository, for the user-wide ~/.kiro/settings/kiroignore. */
export const GENERIC_IGNORE: KiroignoreSuggestion = (() => {
  const patterns = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'poetry.lock', 'composer.lock', 'Gemfile.lock', 'go.sum',
    '*.min.js', '*.min.css', '*.js.map', '*.css.map', '__snapshots__/', '*.snap'];
  const reasons: Record<string, string> = {};
  for (const p of patterns) reasons[p] = p.includes('map') ? 'source maps' : p.includes('min') ? 'minified code' : p.includes('snap') ? 'test snapshots' : 'lockfile';
  return { patterns, reasons };
})();

export function templatesDir(): string {
  return join(packageRoot(), 'templates');
}

export function readTemplate(rel: string): string {
  return readFileSync(join(templatesDir(), rel), 'utf8');
}

function replaceStrings(x: unknown, from: string, to: string): unknown {
  if (typeof x === 'string') return x.split(from).join(to);
  if (Array.isArray(x)) return x.map((v) => replaceStrings(v, from, to));
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, replaceStrings(v, from, to)]));
  return x;
}

/** A JSON template with `{{KOPT}}` replaced by a hook command line. */
export function renderTemplate(rel: string, hookCommand: string): Record<string, any> {
  return replaceStrings(JSON.parse(readTemplate(rel)), '{{KOPT}}', hookCommand) as Record<string, any>;
}

export interface McpMergeOptions {
  force?: boolean;
  /** Keep an existing remote (url) kopt entry instead of replacing it with a local one (team mode). */
  keepRemote?: boolean;
}

/**
 * Merge the `kopt` server entry into an mcp.json. User fields (env, disabled, disabledTools, timeouts, autoApprove)
 * and key order are kept; only how the server is reached is refreshed. Invalid JSON is never overwritten.
 */
export function mergeMcpServer(plan: Plan, path: string, desired: Record<string, unknown>, o: McpMergeOptions = {}): void {
  let doc: Record<string, any>;
  try {
    doc = parseJsonObject(readText(path), path);
  } catch (err) {
    plan.skipped.push(path);
    plan.notes.push(`${(err as Error).message}; add "kopt" under mcpServers manually.`);
    return;
  }
  const servers: Record<string, any> = doc.mcpServers && typeof doc.mcpServers === 'object' && !Array.isArray(doc.mcpServers) ? doc.mcpServers : {};
  const current = servers.kopt;
  const remote = typeof desired.url === 'string';
  if (o.keepRemote && !remote && current && typeof current === 'object' && typeof current.url === 'string' && !o.force) {
    plan.skipped.push(path);
    plan.notes.push(`${path}: kopt is configured as a remote (central) server; kept (use --force to switch to the local server).`);
    return;
  }
  let next: Record<string, unknown>;
  if (!current || typeof current !== 'object' || o.force) {
    next = desired;
  } else {
    const prevOauth = current.oauth && typeof current.oauth === 'object' ? current.oauth : {};
    const updates: Record<string, unknown> = remote
      ? { url: desired.url, oauth: { ...prevOauth, ...(desired.oauth as object) }, oauthScopes: desired.oauthScopes }
      : { command: desired.command, args: desired.args };
    const drop = remote ? ['command', 'args'] : ['url', 'oauth', 'oauthScopes', 'headers'];
    next = {};
    for (const [k, v] of Object.entries(current)) {
      if (drop.includes(k)) continue;
      next[k] = k in updates ? updates[k] : v;
    }
    for (const [k, v] of Object.entries(updates)) if (!(k in next)) next[k] = v;
    if (!Array.isArray(current.autoApprove)) next.autoApprove = desired.autoApprove;
  }
  if (deepEqual(current, next)) {
    plan.skipped.push(path);
    return;
  }
  doc.mcpServers = { ...servers, kopt: next };
  plan.merged(path, JSON.stringify(doc, null, 2) + '\n');
}

export interface UserConfigOptions {
  h: HostEnv;
  cmd: KoptCommand;
  plan: Plan;
  hooks: HookPlan;
  surfaces: Surfaces;
  state: SetupState;
  forced?: SurfaceChoice;
  explorerModel?: string;
  /** MCP entry to install instead of the local server (team mode: remote URL + OAuth). */
  mcpEntry?: Record<string, unknown>;
}

/** Shared user-level paths kopt may create; recorded in `state.createdPaths` when they did not exist before. */
function creatablePaths(h: HostEnv): string[] {
  const kh = kiroHomeDir(h);
  const p = pathFor(h.platform);
  const out = [kh, p.join(kh, 'settings'), p.join(kh, 'hooks'), p.join(kh, 'agents'), p.join(kh, 'steering'),
    p.join(kh, 'settings', 'mcp.json'), kiroCliSettingsPath(h)];
  // the IDE user settings.json and the folders above it, up to (not including) the home dir
  const settings = kiroUserSettingsPath(h);
  out.push(settings);
  const home = p.resolve(h.home);
  for (let d = p.dirname(settings); d.startsWith(home + p.sep) && d !== home; d = p.dirname(d)) out.push(d);
  return [...new Set(out)];
}

/** Write every user-level Kiro file kopt needs (see the header). */
export function writeUserConfig(o: UserConfigOptions): void {
  const { h, cmd, plan, hooks, state } = o;
  const kh = kiroHomeDir(h);
  const j = (...p: string[]) => join(kh, ...p);
  const missingBefore = creatablePaths(h).filter((p) => !existsSync(p));
  try {
    writeUserFiles(o, kh, j);
  } finally {
    if (!plan.dryRun) {
      const created = missingBefore.filter((p) => existsSync(p));
      if (created.length) state.createdPaths = [...new Set([...(state.createdPaths ?? []), ...created])];
    }
  }
}

function writeUserFiles(o: UserConfigOptions, kh: string, j: (...p: string[]) => string): void {
  const { h, cmd, plan, hooks, state } = o;

  // 1. MCP server (no --root: the server finds the project from MCP roots / its cwd)
  mergeMcpServer(plan, j('settings', 'mcp.json'), o.mcpEntry ?? { ...cmd.mcp, autoApprove: [...AUTO_APPROVE] }, { force: plan.force, keepRemote: true });

  // 2. v1 hooks (IDE 1.x, CLI V3)
  if (hooks.globalV1) {
    plan.own(j('hooks', 'kopt.json'), JSON.stringify(renderTemplate('hooks/kopt.json', hookCommandLine(cmd, 'global')), null, 2) + '\n');
  }

  // 3. CLI 2.x agent with embedded hooks, as the default agent
  if (hooks.cliAgent) {
    const agent = renderTemplate('agents/kopt.json', hookCommandLine(cmd, 'agent'));
    const cliSettingsPath = kiroCliSettingsPath(h);
    let cliSettings: Record<string, any> | undefined;
    try {
      cliSettings = parseJsonObject(readText(cliSettingsPath), cliSettingsPath);
    } catch (err) {
      plan.notes.push(`${(err as Error).message}: default agent not set; run: kiro-cli settings ${DEFAULT_AGENT_SETTING} kopt`);
    }
    // Custom agents inherit global steering unless chat.disableInheritingDefaultResources (kiro-cli 2.28 setting).
    if (cliSettings?.['chat.disableInheritingDefaultResources'] === true) agent.resources = ['file://~/.kiro/steering/kopt.md'];
    plan.own(j('agents', 'kopt.json'), JSON.stringify(agent, null, 2) + '\n');
    if (cliSettings) {
      const cur = cliSettings[DEFAULT_AGENT_SETTING];
      if (cur === 'kopt') {
        plan.skipped.push(cliSettingsPath);
      } else if (cur === undefined || cur === '' || plan.force) {
        cliSettings[DEFAULT_AGENT_SETTING] = 'kopt';
        plan.merged(cliSettingsPath, JSON.stringify(cliSettings, null, 2) + '\n');
        state.defaultAgentSet = true;
      } else {
        plan.skipped.push(cliSettingsPath);
        plan.notes.push(`Kiro CLI default agent is "${cur}"; kept. Use kiro-cli chat --agent kopt, or re-run kopt setup --force to make kopt the default.`);
      }
    }
  }

  // 4. explorer sub-agent
  const explorer = JSON.parse(readTemplate('agents/kopt-explorer.json'));
  explorer.model = o.explorerModel || explorer.model || DEFAULT_EXPLORER_MODEL;
  plan.own(j('agents', 'kopt-explorer.json'), JSON.stringify(explorer, null, 2) + '\n');

  // 5. global steering
  for (const name of ['kopt.md', 'kopt-specs.md']) plan.own(j('steering', name), readTemplate(join('steering', name)));

  // 6. global ignore file (generic patterns only: directory names like target/ can be source code elsewhere)
  const ki = j('settings', 'kiroignore');
  plan.merged(ki, mergeKiroignore(readText(ki), kiroignoreBlock(GENERIC_IGNORE)));

  // 7. IDE: honour workspace .kiroignore files too (kiroAgent.agentIgnoreFiles defaults to [])
  const ide = o.forced === 'ide' || o.forced === 'all' || !!o.surfaces.ide;
  if (ide) {
    const settingsPath = kiroUserSettingsPath(h);
    try {
      const next = ensureArrayValue(readText(settingsPath), IGNORE_SETTING, '.kiroignore');
      plan.merged(settingsPath, next);
      if (next !== undefined) state.ideIgnoreSettingAdded = true;
    } catch (err) {
      plan.skipped.push(settingsPath);
      plan.notes.push(`could not update ${settingsPath} (${(err as Error).message}): in Kiro Settings, add ".kiroignore" to "Agent Ignore Files" (${IGNORE_SETTING}).`);
    }
  }
}

export type NpmRunner = (args: string[]) => { status: number | null; stdout: string; stderr: string };

/** Run npm: through npm's own CLI script when we were started by npm/npx (no shell), else the `npm` on PATH. */
export function defaultNpmRunner(env: NodeJS.ProcessEnv = process.env): NpmRunner {
  return (args) => {
    const npmCli = env.npm_execpath && /npm-cli\.(c?js)$/.test(env.npm_execpath) ? env.npm_execpath : undefined;
    const opts = { encoding: 'utf8' as const, env, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'], timeout: 15 * 60_000, windowsHide: true };
    // npm.cmd needs a shell on Windows, which joins argv unquoted: quote paths with spaces (C:\Users\Jane Doe\...)
    const winArg = (a: string) => (/[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
    const r = npmCli
      ? spawnSync(process.execPath, [npmCli, ...args], opts)
      : process.platform === 'win32'
        ? spawnSync('npm.cmd', args.map(winArg), { ...opts, shell: true })
        : spawnSync('npm', args, opts);
    return { status: r.status, stdout: r.stdout ?? '', stderr: (r.stderr ?? '') || (r.error?.message ?? '') };
  };
}

export interface GlobalInstall {
  action: 'not-needed' | 'skipped' | 'installed' | 'failed';
  detail: string;
  /** Installed package directory, when known. */
  packageDir?: string;
  /** kopt's bin.js inside it. */
  bin?: string;
}

function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Global `node_modules` dir reported by `npm root -g` ('' when npm is unavailable). */
function npmGlobalRoot(npm: NpmRunner): string {
  const r = npm(['root', '-g']);
  return r.status === 0 ? (r.stdout.trim().split(/\r?\n/).pop() ?? '').trim() : '';
}

const isTarball = (spec: string) => /\.(tgz|tar\.gz)$/i.test(spec);

/**
 * Copy of a built package without its build-time lifecycle scripts: `npm pack <folder>` always runs `prepare`
 * (`--ignore-scripts` does not stop it, npm 10), and `prepare` (tsc) cannot run in the npx cache, which has no
 * devDependencies. Only what npm would publish is copied (`files`, plus package.json / README / LICENSE).
 */
function stagePrebuilt(pkgRoot: string, into: string): string {
  const stage = join(into, 'stage');
  mkdirSync(stage, { recursive: true });
  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as Record<string, any>;
  if (pkg.scripts) for (const k of ['prepare', 'prepack', 'postpack', 'preinstall', 'install', 'postinstall']) delete pkg.scripts[k];
  writeFileSync(join(stage, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  const entries: string[] = Array.isArray(pkg.files) ? pkg.files.filter((f: unknown): f is string => typeof f === 'string') : readdirSync(pkgRoot);
  for (const name of [...entries, 'README.md', 'LICENSE']) {
    const rel = name.replace(/^\.?[\\/]+/, '').replace(/[\\/]+$/, '');
    if (!rel || rel === 'package.json' || rel === 'node_modules' || rel === '.git' || /[*?[]/.test(rel)) continue;
    const from = join(pkgRoot, rel);
    if (existsSync(from)) cpSync(from, join(stage, rel), { recursive: true, filter: (src) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(src.slice(pkgRoot.length)) });
  }
  return stage;
}

/**
 * `npm install -g <git spec>` cannot build a package that has a `prepare` script: npm prepares the git clone with a
 * nested `npm install` that inherits global mode, so devDependencies (tsc) land in the global prefix instead of the
 * clone and the build fails ("tsc: command not found", reproduced with npm 10.9). So kopt is always packed first
 * (`npm pack`, which prepares a git spec correctly), and the tarball is installed globally. A copy that is already
 * built (the npx cache) is packed as-is: no download, no rebuild, and no symlink into the npx cache (which npm purges).
 */
function packForGlobalInstall(npm: NpmRunner, source: string, prebuilt: boolean): { tarball?: string; dir?: string; error?: string } {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), 'kopt-pack-'));
    const out = join(dir, 'out');
    mkdirSync(out);
    const what = prebuilt ? stagePrebuilt(source, dir) : source;
    const r = npm(['pack', what, '--pack-destination', out, '--json', '--global=false', '--no-fund', '--no-audit']);
    const tgz = readdirSync(out).find(isTarball);
    if (r.status !== 0 || !tgz) {
      const tail = (r.stderr || r.stdout).trim().split(/\r?\n/).slice(-3).join(' | ');
      return { dir, error: `npm pack ${source} failed (${tail || `exit ${r.status}`})` };
    }
    return { dir, tarball: join(out, tgz) };
  } catch (err) {
    return { dir, error: `npm pack ${source} failed (${(err as Error).message})` };
  }
}

/**
 * Make kopt a permanent global command when it runs from the npx cache (or any non-global copy). A checkout used for
 * development is left alone unless `want` is true. `want: false` (--no-global) skips the step.
 * Source: `spec` / `KOPT_INSTALL_SPEC` when given, else the running copy when it is built (dist/bin.js), else
 * `DEFAULT_INSTALL_SPEC`; anything but a tarball is packed first (see `packForGlobalInstall`).
 */
export function globalInstall(o: { want?: boolean; spec?: string; npm?: NpmRunner; pkgRoot?: string; dryRun?: boolean } = {}): GlobalInstall {
  const pkgRoot = o.pkgRoot ?? packageRoot();
  if (o.want === false) return { action: 'skipped', detail: 'global install skipped (--no-global)', packageDir: pkgRoot, bin: binPath(pkgRoot) };
  const npm = o.npm ?? defaultNpmRunner();
  const rootG = npmGlobalRoot(npm);
  const fromNpx = isNpxCachePath(pkgRoot + sep);
  const real = realpathOr(pkgRoot);
  const under = (dir: string, parent: string) => (dir + sep).startsWith(parent + sep);
  if (rootG && !fromNpx && (under(pkgRoot, rootG) || under(real, realpathOr(rootG)))) {
    return { action: 'not-needed', detail: `kopt is installed globally (${pkgRoot})`, packageDir: pkgRoot, bin: binPath(pkgRoot) };
  }
  const devCheckout = existsSync(join(pkgRoot, 'src', 'cli.ts')) || existsSync(join(pkgRoot, '.git'));
  if (!fromNpx && devCheckout && o.want !== true) {
    return { action: 'not-needed', detail: `running from a checkout (${pkgRoot}); \`npm link\` it or pass --global`, packageDir: pkgRoot, bin: binPath(pkgRoot) };
  }
  const explicit = o.spec || process.env.KOPT_INSTALL_SPEC;
  const prebuilt = !explicit && existsSync(join(pkgRoot, 'dist', 'bin.js')) && existsSync(join(pkgRoot, 'package.json'));
  const source = explicit || (prebuilt ? pkgRoot : DEFAULT_INSTALL_SPEC);
  if (o.dryRun) return { action: 'skipped', detail: isTarball(source) ? `would run: npm install -g ${source}` : `would run: npm pack ${source} && npm install -g <tarball>` };
  const failed = (detail: string): GlobalInstall => ({ action: 'failed', detail, packageDir: pkgRoot, bin: binPath(pkgRoot) });
  let packDir: string | undefined;
  try {
    let target = source;
    if (!isTarball(source)) {
      const packed = packForGlobalInstall(npm, source, prebuilt);
      packDir = packed.dir;
      if (!packed.tarball) return failed(packed.error ?? `npm pack ${source} failed`);
      target = packed.tarball;
    }
    const r = npm(['install', '-g', target, '--no-fund', '--no-audit']);
    if (r.status !== 0) {
      const tail = (r.stderr || r.stdout).trim().split(/\r?\n/).slice(-3).join(' | ');
      return failed(`npm install -g ${source} failed (${tail || `exit ${r.status}`})`);
    }
    const root = rootG || npmGlobalRoot(npm);
    const packageDir = root ? join(root, PACKAGE_NAME) : undefined;
    const bin = packageDir ? binPath(packageDir) : undefined;
    if (!bin || !existsSync(bin)) return failed(`npm install -g ${source} finished but ${bin ?? 'the package'} is missing`);
    return { action: 'installed', detail: `installed kopt globally from ${prebuilt ? 'the npx copy' : source} (${packageDir})`, packageDir, bin };
  } finally {
    if (packDir) {
      try {
        rmSync(packDir, { recursive: true, force: true });
      } catch {
        // temp dir: best effort
      }
    }
  }
}

export interface SetupOptions {
  /** Install for these surfaces whatever is detected. */
  surface?: SurfaceChoice;
  /** undefined = auto (only from npx / non-global copies), false = --no-global, true = always. */
  global?: boolean;
  installSpec?: string;
  dryRun?: boolean;
  force?: boolean;
  explorerModel?: string;
  h?: HostEnv;
  runVersion?: VersionRunner;
  npm?: NpmRunner;
  /** Command Kiro will run (tests); default: resolved from PATH / the installed package. */
  command?: KoptCommand;
  pkgRoot?: string;
  /** Skip the global install step entirely (`kopt init --user`). */
  noInstallStep?: boolean;
}

export interface SetupResult extends InstallResult {
  surfaces: Surfaces;
  hooks: HookPlan;
  command: KoptCommand;
  install: GlobalInstall;
}

export async function setupUser(o: SetupOptions = {}): Promise<SetupResult> {
  const h = o.h ?? hostEnv();
  const userDir = userDirFor({ platform: h.platform, env: h.env, home: h.home });
  const install: GlobalInstall = o.noInstallStep
    ? { action: 'skipped', detail: 'no global install step' }
    : globalInstall({ want: o.global, spec: o.installSpec, npm: o.npm, pkgRoot: o.pkgRoot, dryRun: o.dryRun });
  const surfaces = detectSurfaces(h, { surface: o.surface, run: o.runVersion });
  const forced = o.surface ?? (surfaces.ide || surfaces.cli ? undefined : 'all');
  const hooks = hookPlan(surfaces, forced);
  const bin = h.env.KOPT_CLI || install.bin;
  const force = h.env.KOPT_HOOK_COMMAND === 'node' || h.env.KOPT_HOOK_COMMAND === 'shim' ? h.env.KOPT_HOOK_COMMAND : undefined;
  const command = o.command ?? resolveKoptCommand({ h, bin, force });
  const plan = new Plan(!!o.dryRun, !!o.force, userDir);
  const state = readState(userDir);
  writeUserConfig({ h, cmd: command, plan, hooks, surfaces, state, forced, explorerModel: o.explorerModel });
  plan.finish();
  if (!o.dryRun) {
    writeState(userDir, { ...state, version: readPackageVersion(), at: Date.now() });
    writeSurfacesCache(userDir, surfaces);
  }
  if (!surfaces.ide && !surfaces.cli) plan.notes.push(`${describeSurfaces(surfaces)}: configured for every Kiro surface.`);
  if (hooks.legacyWorkspace) {
    plan.notes.push(`Kiro IDE ${surfaces.ide!.version} (0.x) has no global hooks: the kopt MCP server adds a prompt-pointer hook to each workspace it serves (excluded from git). The full session governor needs Kiro IDE 1.x.`);
  }
  if (command.kind === 'node') {
    plan.notes.push(`kopt is not on PATH (or its node is older than 22.13): Kiro will run ${command.shell}.`);
  }
  if (o.dryRun) plan.notes.unshift('dry run: nothing was written.');
  return { ...plan.result(), surfaces, hooks, command, install };
}

export function readPackageVersion(): string {
  try {
    return JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
