// `kopt uninstall`: removes exactly what `kopt setup` / `kopt init` / the MCP server wrote, nothing else.
// Idempotent: a second run finds nothing to remove.
//   - JSON configs: only the `kopt` server entry (mcp.json) and chat.defaultAgent when it is still "kopt";
//   - kopt-named files (hooks/kopt.json, agents/kopt*.json, steering/kopt*.md) when kopt wrote them and nobody edited
//     them since (sha1 manifest); an edited copy is kept and reported (`--force` removes it too);
//   - marked blocks (kiroignore) and the ".kiroignore" settings entry only when setup added it;
//   - legacy IDE 0.x workspace hooks registered by the MCP server, with their .git/info/exclude lines;
//   - the hook launcher (~/.kopt/bin) and the private copy of kopt (~/.kopt/runtime) setup may have installed;
//   - the index caches: kopt's per-project folders only (unless keepIndex); ~/.kopt only with purge.
// A home directory or a filesystem root is never a workspace: `kopt uninstall` run from ~ never touches ~/.kopt.

import { existsSync, readdirSync, rmdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cacheRoot, isUnsafeRoot, userDirFor } from '../core/config.js';
import { samePath } from '../telemetry/fsutil.js';
import { launcherPath } from './command.js';
import { removeArrayValue } from './jsonc.js';
import { removeKiroignoreBlock } from './kiroignore.js';
import { legacyWorkspaces, removeLegacyWorkspaceHooks } from './legacy.js';
import { hostEnv, kiroCliSettingsPath, kiroHomeDir, kiroUserSettingsPath, type HostEnv } from './paths.js';
import { isEmptyJsonResidue, parseJsonObject, Plan, readState, readText, statePath, writeState, type InstallResult } from './plan.js';
import { DEFAULT_AGENT_SETTING, IGNORE_SETTING, readTemplate } from './setup.js';

export interface UninstallOptions {
  /** Project whose workspace files (`kopt init`) are removed too. */
  root?: string;
  /** user = ~/.kiro and caches; workspace = only `root`; all (default) = both. */
  scope?: 'user' | 'workspace' | 'all';
  keepIndex?: boolean;
  /** Also delete ~/.kopt (telemetry, governor sessions). */
  purge?: boolean;
  /** Also remove kopt's files the user edited since kopt wrote them (kept and reported otherwise). */
  force?: boolean;
  dryRun?: boolean;
  h?: HostEnv;
}

/** Files kopt owns, relative to a `.kiro` directory. */
const OWNED = [['hooks', 'kopt.json'], ['agents', 'kopt.json'], ['agents', 'kopt-explorer.json'], ['steering', 'kopt.md'], ['steering', 'kopt-specs.md']];

function looksLikeKopt(text: string | undefined): boolean {
  return text !== undefined && /kopt/i.test(text);
}

function removeMcpEntry(plan: Plan, path: string, deleteIfEmpty = false): void {
  const text = readText(path);
  if (text === undefined) return;
  let doc: Record<string, any>;
  try {
    doc = parseJsonObject(text, path);
  } catch {
    plan.notes.push(`${path} is not valid JSON; remove the "kopt" server entry manually if present.`);
    return;
  }
  if (!doc.mcpServers || typeof doc.mcpServers !== 'object' || !('kopt' in doc.mcpServers)) return;
  const { kopt: _removed, ...rest } = doc.mcpServers;
  doc.mcpServers = rest;
  // a workspace mcp.json that only held kopt (written by kopt init) goes away entirely
  if (deleteIfEmpty && Object.keys(doc).length === 1 && Object.keys(rest).length === 0) plan.remove(path);
  else plan.merged(path, JSON.stringify(doc, null, 2) + '\n');
}

/** Content kopt writes for a file whatever the machine (steering), to recognise a copy written before the manifest. */
function pristine(rel: string[]): string | undefined {
  if (rel[0] !== 'steering') return undefined;
  try {
    return readTemplate(join('steering', rel[1]));
  } catch {
    return undefined;
  }
}

/**
 * Remove kopt's own files under a `.kiro` folder: those whose content is exactly what kopt wrote (manifest hash). A
 * copy the user edited since is kept and reported, unless `force`.
 */
function removeOwnedFiles(plan: Plan, kiroDir: string, force: boolean): void {
  for (const rel of OWNED) {
    const path = join(kiroDir, ...rel);
    const text = readText(path);
    if (!looksLikeKopt(text)) continue;
    if (force || plan.isOurs(path, text) || text === pristine(rel)) plan.remove(path);
    else {
      plan.kept.push(path);
      plan.notes.push(`kept ${path}: edited since kopt wrote it (delete it yourself, or run kopt uninstall --force).`);
    }
  }
}

/** A per-project cache folder kopt created (`<name>-<hash8>` holding an index, command logs or nothing). */
function isKoptCacheFolder(dir: string, name: string): boolean {
  if (!/^.+-[0-9a-f]{8}$/.test(name)) return false;
  try {
    const entries = readdirSync(dir);
    return entries.length === 0 || entries.some((e) => /^(index\.db(-wal|-shm)?|outputs|dirty|\.refresh-spawned)$/.test(e));
  } catch {
    return false;
  }
}

/** Delete kopt's per-project folders in the cache root, then the root itself when nothing else is left in it. */
function removeCaches(plan: Plan, cache: string, dryRun: boolean): void {
  if (!existsSync(cache)) return;
  let entries: string[] = [];
  try {
    entries = readdirSync(cache);
  } catch {
    return;
  }
  let left = 0;
  for (const name of entries) {
    const dir = join(cache, name);
    if (isKoptCacheFolder(dir, name)) plan.removeDir(dir);
    else left++;
  }
  if (left === 0) {
    if (dryRun) plan.removed.push(cache);
    else {
      try {
        rmdirSync(cache);
        plan.removed.push(cache);
      } catch {
        // not empty (a build finished meanwhile): leave it
      }
    }
  }
}

function removeIgnoreBlock(plan: Plan, path: string): void {
  const next = removeKiroignoreBlock(readText(path));
  if (next === undefined) return;
  if (next.trim()) plan.merged(path, next);
  else plan.remove(path);
}

export async function uninstallKiro(o: UninstallOptions = {}): Promise<InstallResult> {
  const h = o.h ?? hostEnv();
  const scope = o.scope ?? 'all';
  const userDir = userDirFor({ platform: h.platform, env: h.env, home: h.home });
  const plan = new Plan(!!o.dryRun, true, userDir);
  const state = readState(userDir);

  if (scope !== 'workspace') {
    const kh = kiroHomeDir(h);
    removeMcpEntry(plan, join(kh, 'settings', 'mcp.json'));
    removeOwnedFiles(plan, kh, !!o.force);
    removeIgnoreBlock(plan, join(kh, 'settings', 'kiroignore'));

    const cliPath = kiroCliSettingsPath(h);
    try {
      const cli = parseJsonObject(readText(cliPath), cliPath);
      if (cli[DEFAULT_AGENT_SETTING] === 'kopt') {
        delete cli[DEFAULT_AGENT_SETTING];
        plan.merged(cliPath, JSON.stringify(cli, null, 2) + '\n');
      }
    } catch {
      // not ours to repair
    }

    if (state.ideIgnoreSettingAdded) {
      const settingsPath = kiroUserSettingsPath(h);
      try {
        plan.merged(settingsPath, removeArrayValue(readText(settingsPath), IGNORE_SETTING, '.kiroignore'));
      } catch {
        plan.notes.push(`could not edit ${settingsPath}: remove ".kiroignore" from ${IGNORE_SETTING} manually if you want.`);
      }
    }

    for (const ws of Object.keys(legacyWorkspaces(userDir))) {
      for (const p of removeLegacyWorkspaceHooks(ws, !!o.dryRun)) plan.removed.push(p);
    }

    if (!o.keepIndex) removeCaches(plan, cacheRoot({ platform: h.platform, env: h.env, home: h.home }), !!o.dryRun);
    // the hook launcher and the private copy of kopt (installed when the global npm install was not possible)
    const launcher = launcherPath(h);
    const launcherText = readText(launcher);
    if (launcherText !== undefined && (o.force || plan.isOurs(launcher, launcherText) || /kopt launcher written by `kopt setup`/.test(launcherText))) plan.remove(launcher);
    if (existsSync(join(userDir, 'runtime'))) plan.removeDir(join(userDir, 'runtime'));
    for (const f of ['surfaces.json', 'legacy-hooks.json', 'setup-state.json']) plan.remove(join(userDir, f));
    if (!o.dryRun) {
      try {
        if (readdirSync(join(userDir, 'bin')).length === 0) rmdirSync(join(userDir, 'bin'));
      } catch {
        // missing or not empty
      }
    }

    // shared files and folders setup created: gone again once only kopt's (now empty) residue is left in them
    const created = [...(state.createdPaths ?? [])].sort((a, b) => b.length - a.length);
    for (const p of created) {
      const text = readText(p);
      if (text !== undefined && isEmptyJsonResidue(text)) plan.remove(p);
    }
    if (!o.dryRun) {
      for (const d of created) {
        try {
          if (existsSync(d) && statSync(d).isDirectory() && readdirSync(d).length === 0) {
            rmdirSync(d);
            plan.removed.push(d);
          }
        } catch {
          // not empty or not ours to remove
        }
      }
    }
  }

  // a home directory or a filesystem root is not a project: its .kiro is the user-level one and its .kopt is ~/.kopt
  const workspaceRoot = o.root ? resolve(o.root) : undefined;
  const isWorkspace = !!workspaceRoot && !isUnsafeRoot(workspaceRoot, h.home) && !samePath(join(workspaceRoot, '.kopt'), userDir) && !samePath(join(workspaceRoot, '.kiro'), kiroHomeDir(h));
  if (scope !== 'user' && workspaceRoot && !isWorkspace && scope === 'workspace') {
    plan.notes.push(`${workspaceRoot} is not a project folder (home directory or filesystem root): nothing removed there.`);
  }
  if (scope !== 'user' && workspaceRoot && isWorkspace) {
    const root = workspaceRoot;
    const k = join(root, '.kiro');
    removeMcpEntry(plan, join(k, 'settings', 'mcp.json'), true);
    removeOwnedFiles(plan, k, !!o.force);
    for (const p of removeLegacyWorkspaceHooks(root, !!o.dryRun)) if (!plan.removed.includes(p)) plan.removed.push(p);
    removeIgnoreBlock(plan, join(root, '.kiroignore'));
    const ws = state.workspaces?.[root];
    if (ws?.vscodeIgnoreSettingAdded) {
      const vs = join(root, '.vscode', 'settings.json');
      try {
        const next = removeArrayValue(readText(vs), IGNORE_SETTING, '.kiroignore');
        // the exact residue of a settings file kopt init created: remove it
        if (next !== undefined && /^\{\s*"kiroAgent\.agentIgnoreFiles":\s*\[\s*\]\s*\}\s*$/.test(next)) {
          plan.remove(vs);
          if (!o.dryRun) {
            try {
              if (readdirSync(join(root, '.vscode')).length === 0) rmdirSync(join(root, '.vscode'));
            } catch {
              // not empty
            }
          }
        } else plan.merged(vs, next);
      } catch {
        // leave it
      }
    }
    if (ws?.gitignoreAdded) {
      const gi = join(root, '.gitignore');
      const text = readText(gi);
      if (text !== undefined) {
        const next = text.split('\n').filter((l) => l.trim() !== '.kopt/').join('\n');
        if (next !== text) plan.merged(gi, next);
      }
    }
    if (!o.keepIndex && existsSync(join(root, '.kopt'))) plan.removeDir(join(root, '.kopt'));
    if (!o.dryRun && state.workspaces?.[root] && !o.purge) {
      delete state.workspaces[root];
      if (existsSync(statePath(userDir))) writeState(userDir, state);
    }
    // empty .kiro dirs left behind by kopt init
    if (!o.dryRun) {
      for (const d of [join(k, 'settings'), join(k, 'hooks'), join(k, 'agents'), join(k, 'steering'), k]) {
        try {
          if (existsSync(d) && readdirSync(d).length === 0) rmdirSync(d);
        } catch {
          // not empty
        }
      }
    }
  }

  // a file first stripped of kopt's entry, then deleted as empty residue, is reported once (removed)
  plan.written = plan.written.filter((p) => !plan.removed.includes(p));
  plan.finish();
  if (o.purge && scope !== 'workspace' && existsSync(userDir)) plan.removeDir(userDir);
  if (o.dryRun) plan.notes.unshift('dry run: nothing was removed.');
  return plan.result();
}
