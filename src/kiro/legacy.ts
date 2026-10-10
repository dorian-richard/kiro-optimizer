// Kiro IDE 0.x support: legacy `.kiro.hook` files, which 0.x only reads from <workspace>/.kiro/hooks/ (there is no
// global hooks directory before IDE 1.0). The kopt MCP server writes them on its first start in a workspace when the
// installed IDE is 0.x (opt out: KOPT_LEGACY_WORKSPACE_HOOKS=0 / config kiro.legacyWorkspaceHooks = "off") and adds
// them to .git/info/exclude so `git status` stays clean. `kopt uninstall` removes them (workspaces are registered
// in <userDir>/legacy-hooks.json).
//
// Which legacy triggers are worth installing (verified in the 0.12.318 bundle, kiro.kiro-agent/dist/extension.js):
//  - runCommand output defaults to "Command executed successfully with no output." even when the command prints
//    nothing (handleHookExecute / RunHookCommand.executeCommand), and
//  - preToolUse: any runCommand output makes the agent see "Tool ... was intercepted by PreToolUse hooks ... The tool
//    was NOT executed" (runPreToolUseHooks), so EVERY matched tool call would cost an extra model turn;
//  - postToolUse: the same text is appended to every matched tool result;
//  - fileEdited / fileCreated / fileDeleted runCommand hooks open a new chat session per event (ThenRunCommand);
//  - agentStop output routes the agent graph back to another turn (USER_HOOK_AGENT_STOP -> INTENT_OVERRIDE);
//  - sessionStart runCommand results are dropped in ACP mode (handleHooksSessionStart returns []).
// So only `promptSubmit` is installed: it front-loads index pointers when retrieval is confident (silent prompts
// cost one short "no output" line) and never intercepts tools. The governor (read/command gating) needs IDE >= 1.0.
// Each runCommand hook asks the user once per workspace before its first run (kiroAgent.approvedHookCommands).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isUnsafeRoot, type KoptConfig } from '../core/config.js';
import { writePrivateFile } from '../telemetry/fsutil.js';
import { hookCommandLine, resolveKoptCommand, type KoptCommand } from './command.js';
import { detectIde, readSurfacesCache, writeSurfacesCache, type IdeInfo } from './detect.js';
import { readText, sha1 } from './plan.js';
import { hostEnv, isFile, readJsonFile, type HostEnv } from './paths.js';

export const LEGACY_PREFIX = 'kopt-';
export const LEGACY_EXCLUDE_MARK = '# kopt (Kiro IDE 0.x hooks, written by the kopt MCP server)';

export interface LegacyHookFile {
  enabled: boolean;
  name: string;
  description: string;
  version: string;
  when: { type: string; patterns?: string[]; toolTypes?: string[] };
  then: { type: 'runCommand'; command: string; timeout?: number };
}

/** The legacy hooks kopt installs, by file name. */
export function legacyHookFiles(cmd: KoptCommand): Record<string, LegacyHookFile> {
  return {
    'kopt-prompt.kiro.hook': {
      enabled: true,
      name: 'kopt: prompt pointers',
      description: 'kopt: adds a few index pointers (kopt_read #id) to the prompt when retrieval is confident; otherwise silent. Written by the kopt MCP server for Kiro IDE 0.x; remove with kopt uninstall.',
      version: '1',
      when: { type: 'promptSubmit' },
      then: { type: 'runCommand', command: hookCommandLine(cmd, 'legacy', ['promptSubmit', '--legacy']), timeout: 10 },
    },
  };
}

export type LegacyMode = 'auto' | 'on' | 'off';

/** A cached "no IDE found" result is re-checked after this long. */
const SURFACES_CACHE_TTL_MS = 24 * 3600_000;

/**
 * The installed Kiro IDE, from the surfaces cache kopt setup / doctor write, kept current: the IDE updates itself
 * (0.x -> 1.x), so the version is re-read from the cached package.json (one small file); a cache without an IDE, or
 * whose package.json is gone, is re-detected once it is a day old.
 */
export function currentIde(userDir: string, h: HostEnv = hostEnv(), now = Date.now()): IdeInfo | undefined {
  const cached = readSurfacesCache(userDir);
  const ide = cached?.ide;
  if (ide?.path && isFile(ide.path)) {
    const v = readJsonFile<{ version?: string }>(ide.path)?.version;
    const m = typeof v === 'string' ? /(\d+)\.(\d+)\.(\d+)/.exec(v) : null;
    return m ? { ...ide, version: m[0], major: Number(m[1]) } : ide;
  }
  if (cached && now - (cached.at ?? 0) < SURFACES_CACHE_TTL_MS) return ide;
  const found = detectIde(h);
  if (cached || found) writeSurfacesCache(userDir, { ...(cached ?? {}), ide: found });
  return found;
}

/** Should the MCP server write legacy hooks into workspaces on this machine? */
export function legacyHooksWanted(config: KoptConfig, h: HostEnv = hostEnv()): boolean {
  const mode: LegacyMode = config.kiro?.legacyWorkspaceHooks ?? 'auto';
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  const ide = currentIde(config.userDir, h);
  return !!ide && ide.major < 1;
}

function gitExcludePath(root: string): string | undefined {
  const dotGit = join(root, '.git');
  try {
    if (statSync(dotGit).isDirectory()) return join(dotGit, 'info', 'exclude');
  } catch {
    return undefined;
  }
  // worktree / submodule: .git is a file pointing elsewhere
  try {
    const out = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: root, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
    return out ? resolve(root, out) : undefined;
  } catch {
    return undefined;
  }
}

function addExclude(root: string, entries: string[]): void {
  const file = gitExcludePath(root);
  if (!file) return;
  const text = readText(file) ?? '';
  const lines = text.split(/\r?\n/);
  const missing = entries.filter((e) => !lines.includes(e));
  if (!missing.length) return;
  const block = (lines.includes(LEGACY_EXCLUDE_MARK) ? [] : [LEGACY_EXCLUDE_MARK]).concat(missing);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text + (text && !text.endsWith('\n') ? '\n' : '') + block.join('\n') + '\n');
}

function removeExclude(root: string): boolean {
  const file = gitExcludePath(root);
  const text = file ? readText(file) : undefined;
  if (!file || text === undefined) return false;
  const kept = text.split(/\r?\n/).filter((l) => l !== LEGACY_EXCLUDE_MARK && !/^\/?\.kiro\/hooks\/kopt-[^/]*\.kiro\.hook$/.test(l));
  const next = kept.join('\n');
  if (next === text) return false;
  writeFileSync(file, next);
  return true;
}

function registryPath(userDir: string): string {
  return join(userDir, 'legacy-hooks.json');
}

export function legacyWorkspaces(userDir: string): Record<string, Record<string, string>> {
  try {
    const v = JSON.parse(readText(registryPath(userDir)) ?? '');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function saveRegistry(userDir: string, reg: Record<string, Record<string, string>>): void {
  writePrivateFile(registryPath(userDir), JSON.stringify(reg, null, 2) + '\n');
}

/** Drop a workspace from the registry (its hooks were removed). */
export function forgetLegacyWorkspace(userDir: string, root: string): void {
  const reg = legacyWorkspaces(userDir);
  if (!(root in reg)) return;
  delete reg[root];
  try {
    if (Object.keys(reg).length) saveRegistry(userDir, reg);
    else rmSync(registryPath(userDir), { force: true });
  } catch {
    // best effort
  }
}

export interface LegacyResult {
  written: string[];
  skipped: string[];
}

/**
 * Write kopt's legacy hook files into `<root>/.kiro/hooks/` (idempotent). A file the user edited since kopt wrote it
 * is kept. Returns what was written. Never throws.
 */
export function ensureLegacyWorkspaceHooks(root: string, config: KoptConfig, o: { cmd?: KoptCommand; h?: HostEnv } = {}): LegacyResult {
  const res: LegacyResult = { written: [], skipped: [] };
  try {
    if (isUnsafeRoot(root)) return res;
    const cmd = o.cmd ?? resolveKoptCommand({ h: o.h });
    const reg = legacyWorkspaces(config.userDir);
    const mine = reg[root] ?? {};
    const dir = join(root, '.kiro', 'hooks');
    for (const [name, hook] of Object.entries(legacyHookFiles(cmd))) {
      const path = join(dir, name);
      const content = JSON.stringify(hook, null, 2) + '\n';
      const existing = readText(path);
      if (existing === content) {
        res.skipped.push(path);
        continue;
      }
      if (existing !== undefined && mine[name] !== sha1(existing)) {
        res.skipped.push(path); // edited by the user: keep
        continue;
      }
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, content);
      mine[name] = sha1(content);
      res.written.push(path);
    }
    if (res.written.length) {
      reg[root] = mine;
      saveRegistry(config.userDir, reg);
      addExclude(root, Object.keys(legacyHookFiles(cmd)).map((n) => `/.kiro/hooks/${n}`));
    }
  } catch {
    // best effort: a read-only workspace must not break the MCP server
  }
  return res;
}

/** Remove kopt's legacy hook files (and their git exclude lines) from one workspace. Returns removed paths. */
export function removeLegacyWorkspaceHooks(root: string, dryRun = false): string[] {
  const removed: string[] = [];
  const dir = join(root, '.kiro', 'hooks');
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.startsWith(LEGACY_PREFIX) && n.endsWith('.kiro.hook'));
  } catch {
    names = [];
  }
  for (const n of names) {
    const path = join(dir, n);
    const text = readText(path) ?? '';
    if (!/kopt(\.cmd)?\\?['"]? hook|kopt[\\/]dist[\\/]|bin\.js\\?['"]? hook/.test(text)) continue; // not ours
    removed.push(path);
    if (!dryRun) rmSync(path, { force: true });
  }
  if (!dryRun) {
    removeExclude(root);
    for (const d of [dir, join(root, '.kiro')]) {
      try {
        if (existsSync(d) && readdirSync(d).length === 0) rmdirSync(d);
      } catch {
        // not empty or not ours
      }
    }
  }
  return removed;
}
