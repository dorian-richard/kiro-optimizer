// Kiro integration. Global (zero-config) mode is `kopt setup` (setup.ts): user-level files only, nothing written
// into projects. `kopt init` (installKiro below) is the optional per-project mode: the same files under
// <root>/.kiro, plus a workspace .kiroignore.
//
// Locations (kiro.dev docs, verified 2026-10): workspace `.kiro/{settings/mcp.json,steering,hooks,agents}`,
// user `~/.kiro/...` (KIRO_HOME overrides); global ignore `~/.kiro/settings/kiroignore` (IDE: always honoured);
// workspace `.kiroignore` is honoured by CLI V3, and by the IDE only when listed in the VS Code-style setting
// `kiroAgent.agentIgnoreFiles` (default [] in the 0.12.318 workbench), stored in `<root>/.vscode/settings.json`
// (workspace) or the Kiro user settings.json. Idempotent: unchanged files are skipped; files kopt wrote earlier are
// updated only if the user did not edit them since (sha1 manifest), otherwise `force` is required.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defaultConfig, loadConfig, usesProjectDataDir } from '../core/config.js';
import { hookCommandLine, isTransientPath, shellArg, type KoptCommand } from './command.js';
import { ensureArrayValue } from './jsonc.js';
import { kiroignoreBlock, mergeKiroignore, suggestKiroignore } from './kiroignore.js';
import { hostEnv } from './paths.js';
import { Plan, readState, readText, writeState, type InstallResult } from './plan.js';
import { AUTO_APPROVE, DEFAULT_EXPLORER_MODEL, IGNORE_SETTING, MCP_TIMEOUTS, mergeMcpServer, readTemplate, renderTemplate, setupUser, userCommand, writeLauncher } from './setup.js';

export { suggestKiroignore, kiroignoreBlock, mergeKiroignore, removeKiroignoreBlock } from './kiroignore.js';
export { kiroHomeDir, kiroUserSettingsPath, kiroCliSettingsPath, hostEnv, type HostEnv } from './paths.js';
export { AUTO_APPROVE, DEFAULT_EXPLORER_MODEL, GENERIC_IGNORE, MCP_TIMEOUTS, globalInstall, privateInstall, setupUser, writeUserConfig, type SetupOptions, type SetupResult, type GlobalInstall, type NpmRunner } from './setup.js';
export { uninstallKiro, type UninstallOptions } from './uninstall.js';
export { runDoctor, formatChecks, runHookCommand, type Check, type DoctorReport } from './doctor.js';
export { detectSurfaces, detectIde, detectCli, describeSurfaces, hookPlan, type Surfaces, type SurfaceChoice } from './detect.js';
export { resolveKoptCommand, hookCommandLine, launcherPath, launcherScript, stableNodePath, type KoptCommand } from './command.js';
export { ensureLegacyWorkspaceHooks, removeLegacyWorkspaceHooks, legacyHooksWanted, legacyHookFiles } from './legacy.js';
export type { InstallResult } from './plan.js';

export interface InstallOptions {
  root: string;
  scope: 'workspace' | 'user';
  explorerModel?: string;
  dryRun?: boolean;
  force?: boolean;
}

/** Quote one argv element for the shell Kiro uses to run hook commands. */
export function shellQuote(arg: string): string {
  return shellArg(arg);
}

/**
 * How Kiro starts kopt on this machine: absolute Node + bin.js for MCP, the private launcher for hooks
 * (KOPT_HOOK_COMMAND=node|shim forces another form; KOPT_CLI sets bin.js).
 */
export function koptCommand(): KoptCommand {
  return userCommand(hostEnv(), process.env.KOPT_CLI || undefined);
}

/** Hook command line for workspace hook files. */
export function hookCommand(source = 'workspace'): string {
  return hookCommandLine(koptCommand(), source);
}

/** The `kopt` server entry for mcp.json (local stdio server). */
export function mcpServerEntry(o: Pick<InstallOptions, 'root' | 'scope'>, cmd: KoptCommand = koptCommand()): Record<string, unknown> {
  const args = [...cmd.mcp.args];
  if (o.scope === 'workspace') args.push('--root', resolve(o.root));
  return { command: cmd.mcp.command, args, autoApprove: [...AUTO_APPROVE], ...MCP_TIMEOUTS };
}

export async function installKiro(o: InstallOptions): Promise<InstallResult> {
  const root = resolve(o.root);
  const workspace = o.scope === 'workspace';
  if (!workspace) {
    // user scope = the global (setup) layout, without the global npm install step
    const r = await setupUser({ noInstallStep: true, dryRun: o.dryRun, force: o.force, explorerModel: o.explorerModel });
    return { written: r.written, skipped: r.skipped, notes: r.notes, removed: r.removed };
  }

  const userDir = defaultConfig(root).userDir;
  const plan = new Plan(!!o.dryRun, !!o.force, userDir);
  const state = readState(userDir);
  let cmd = koptCommand();
  if (isTransientPath(cmd.bin)) {
    return { written: [], skipped: [], notes: ['kopt runs from the npx cache, which npm deletes: run kopt setup first (it installs kopt for good), then kopt init.'], removed: [] };
  }
  // the hooks below run the user-level launcher (~/.kopt/bin/kopt): write it when missing or stale
  cmd = writeLauncher(plan, cmd, process.platform);

  const base = join(root, '.kiro');

  // 1. MCP server
  const mcpPath = join(base, 'settings', 'mcp.json');
  mergeMcpServer(plan, mcpPath, mcpServerEntry(o, cmd), { force: !!o.force });
  if (cmd.kind !== 'shim') {
    plan.notes.push('the MCP entry and the hooks use absolute paths of this machine (Node, kopt, ~/.kopt/bin): keep .kiro/settings/mcp.json and .kiro/hooks/kopt.json out of git (or set KOPT_HOOK_COMMAND=shim for the portable bare `kopt` form), or use kopt setup on each machine.');
  }

  // 2. steering
  for (const name of ['kopt.md', 'kopt-specs.md']) plan.own(join(base, 'steering', name), readTemplate(join('steering', name)));

  // 3. hooks (IDE 1.x / CLI V3)
  plan.own(join(base, 'hooks', 'kopt.json'), JSON.stringify(renderTemplate('hooks/kopt.json', hookCommandLine(cmd, 'workspace')), null, 2) + '\n');
  plan.notes.push('hooks use the .kiro/hooks v1 format (Kiro IDE 1.x / CLI V3); Kiro CLI 2.x uses the agent from kopt setup, Kiro IDE 0.x the legacy hooks the MCP server writes.');

  // 4. explorer agent
  const agent = JSON.parse(readTemplate('agents/kopt-explorer.json'));
  agent.model = o.explorerModel || agent.model || DEFAULT_EXPLORER_MODEL;
  plan.own(join(base, 'agents', 'kopt-explorer.json'), JSON.stringify(agent, null, 2) + '\n');

  // 5. workspace ignore file; .kopt only when this repo keeps its index in <root>/.kopt (per-project mode)
  const perProject = usesProjectDataDir(loadConfig(root));
  const ws = { ...(state.workspaces?.[root] ?? {}) };
  const suggestion = await suggestKiroignore(root);
  if (perProject) {
    // raw command logs belong behind kopt_expand, never in a whole-file read
    suggestion.patterns.unshift('/.kopt/');
    suggestion.reasons['/.kopt/'] = 'kopt data (index, raw command logs: use kopt_expand)';
  }
  const path = join(root, '.kiroignore');
  plan.merged(path, mergeKiroignore(readText(path), kiroignoreBlock(suggestion)));

  if (perProject && existsSync(join(root, '.git'))) {
    const gi = join(root, '.gitignore');
    const text = readText(gi) ?? '';
    const has = text.split(/\r?\n/).some((l) => /^\/?\.kopt\/?(\*\*?)?$/.test(l.trim()));
    if (!has) ws.gitignoreAdded = true;
    plan.merged(gi, has ? undefined : text + (text && !text.endsWith('\n') ? '\n' : '') + '.kopt/\n');
  }

  // 6. IDE setting so the IDE honours .kiroignore (default: no ignore files)
  const settingsPath = join(root, '.vscode', 'settings.json');
  try {
    const next = ensureArrayValue(readText(settingsPath), IGNORE_SETTING, '.kiroignore');
    if (next !== undefined) ws.vscodeIgnoreSettingAdded = true;
    plan.merged(settingsPath, next);
  } catch (err) {
    plan.skipped.push(settingsPath);
    plan.notes.push(`could not update ${settingsPath} (${(err as Error).message}): in Kiro Settings, add ".kiroignore" to "Agent Ignore Files" (${IGNORE_SETTING}).`);
  }

  plan.finish();
  if (!o.dryRun && (ws.gitignoreAdded || ws.vscodeIgnoreSettingAdded)) {
    writeState(userDir, { ...state, workspaces: { ...(state.workspaces ?? {}), [root]: ws } });
  }
  if (o.dryRun) plan.notes.unshift('dry run: nothing was written.');
  return plan.result();
}
