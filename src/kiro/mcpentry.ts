// The `kopt` entry of Kiro's mcp.json: the hooks check that a kopt tool can be called before pointing the agent to
// it, and the MCP server skips the work done only for kopt_run when the user turned it off.

import { join } from 'node:path';
import { koptToolName } from '../hooks/tools.js';
import { readTextFile } from '../telemetry/fsutil.js';
import { kiroHomeDir } from './paths.js';

/** The `kopt` entry of mcp.json (workspace config wins over user config; user config only without a root), when present. */
export function koptMcpEntry(root: string | undefined): Record<string, any> | undefined {
  const files = [join(kiroHomeDir(), 'settings', 'mcp.json')];
  if (root) files.unshift(join(root, '.kiro', 'settings', 'mcp.json'));
  for (const file of files) {
    try {
      const cfg = JSON.parse(readTextFile(file));
      const s = cfg?.mcpServers?.kopt;
      if (s && typeof s === 'object' && !Array.isArray(s)) return s;
    } catch { /* missing or invalid */ }
  }
  return undefined;
}

/** Is the kopt MCP server configured and enabled? */
export function koptMcpInstalled(root: string): boolean {
  const s = koptMcpEntry(root);
  return !!s && s.disabled !== true;
}

/** Does this mcp.json entry turn kopt_run off (the server off, `disabledTools` lists it, or env KOPT_DISABLE_RUN=1)? */
function runTurnedOff(s: Record<string, any>): boolean {
  if (s.disabled === true) return true;
  const disabled = Array.isArray(s.disabledTools) ? s.disabledTools.map(String) : [];
  if (disabled.some((t: string) => koptToolName(t) === 'kopt_run' || t === '*')) return true;
  const env = s.env && typeof s.env === 'object' ? s.env : {};
  return String(env.KOPT_DISABLE_RUN ?? '') === '1';
}

/**
 * Can the agent call kopt_run? The server registers it unless its entry disables it (`disabledTools` lists it, or
 * env KOPT_DISABLE_RUN=1). Redirecting to a tool the model cannot call would cost two requests for nothing.
 */
export function koptRunAvailable(root: string): boolean {
  const s = koptMcpEntry(root);
  return !!s && !runTurnedOff(s);
}

/**
 * Has the user turned kopt_run off for this server (KOPT_DISABLE_RUN=1 in its environment, or its mcp.json entry)?
 * Unlike koptRunAvailable, a server with no entry found (configured elsewhere) counts as on: it is running.
 */
export function koptRunTurnedOff(root: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (String(env.KOPT_DISABLE_RUN ?? '') === '1') return true;
  const s = koptMcpEntry(root);
  return !!s && runTurnedOff(s);
}
