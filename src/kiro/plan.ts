// Idempotent file writer shared by `kopt init`, `kopt setup` and `kopt uninstall`.
//
// Files kopt owns entirely are tracked in a sha1 manifest (<userDir>/kiro-install.json): a re-run updates a file kopt
// wrote itself (e.g. a stale command path) but keeps a file the user edited since, unless `force`.

import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stripBom, writePrivateFile } from '../telemetry/fsutil.js';

export interface InstallResult {
  written: string[];
  skipped: string[];
  notes: string[];
  /** Files deleted (uninstall). */
  removed?: string[];
  /** kopt files kept because the user edited them (uninstall). */
  kept?: string[];
}

/** File text without a UTF-8 BOM (Notepad and Windows PowerShell 5 write one into JSON files), or undefined. */
export function readText(path: string): string | undefined {
  try {
    return stripBom(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

export const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

/** Key-order-insensitive structural equality (JSON values). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((v, i) => deepEqual(v, (b as unknown[])[i]));
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => deepEqual((a as any)[k], (b as any)[k]));
}

export class Plan {
  written: string[] = [];
  skipped: string[] = [];
  notes: string[] = [];
  removed: string[] = [];
  kept: string[] = [];
  private manifest: Record<string, string>;
  private readonly manifestPath: string;
  private manifestDirty = false;

  constructor(readonly dryRun: boolean, readonly force: boolean, userDir: string) {
    this.manifestPath = join(userDir, 'kiro-install.json');
    try {
      this.manifest = JSON.parse(stripBom(readFileSync(this.manifestPath, 'utf8')));
    } catch {
      this.manifest = {};
    }
  }

  private write(path: string, content: string, mode?: number): void {
    this.written.push(path);
    if (this.dryRun) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, mode === undefined ? undefined : { mode });
    if (mode !== undefined && process.platform !== 'win32') chmodSync(path, mode);
  }

  /** Was this exact content written by kopt (manifest hash match)? */
  isOurs(path: string, content: string | undefined = readText(path)): boolean {
    return content !== undefined && this.manifest[path] === sha1(content);
  }

  /** Is a manifest entry recorded for this path (kopt wrote some version of it)? */
  isTracked(path: string): boolean {
    return path in this.manifest;
  }

  /** A file kopt owns entirely (template-derived). `mode`: POSIX permissions (e.g. 0o755 for the launcher). */
  own(path: string, content: string, mode?: number): void {
    const existing = readText(path);
    if (existing === content) {
      this.skipped.push(path);
      this.track(path, content);
      return;
    }
    if (existing !== undefined && !this.isOurs(path, existing) && !this.force) {
      this.skipped.push(path);
      this.notes.push(`${path} exists with local changes; kept (use --force to overwrite).`);
      return;
    }
    this.write(path, content, mode);
    this.track(path, content);
  }

  /** A file shared with the user: `content` is the full merged result, written only when it changed. */
  merged(path: string, content: string | undefined): void {
    if (content === undefined || readText(path) === content) {
      this.skipped.push(path);
      return;
    }
    this.write(path, content);
  }

  /** Delete a file kopt owns. */
  remove(path: string): void {
    if (readText(path) === undefined) return;
    this.removed.push(path);
    if (!this.dryRun) rmSync(path, { force: true });
    if (path in this.manifest) {
      delete this.manifest[path];
      this.manifestDirty = true;
    }
  }

  /** Delete a directory tree (caches). */
  removeDir(path: string): void {
    this.removed.push(path);
    if (!this.dryRun) rmSync(path, { recursive: true, force: true });
  }

  private track(path: string, content: string): void {
    const h = sha1(content);
    if (this.manifest[path] !== h) {
      this.manifest[path] = h;
      this.manifestDirty = true;
    }
  }

  finish(): void {
    if (this.dryRun || !this.manifestDirty) return;
    try {
      if (Object.keys(this.manifest).length === 0) {
        rmSync(this.manifestPath, { force: true });
        return;
      }
      writePrivateFile(this.manifestPath, JSON.stringify(this.manifest, null, 2));
    } catch {
      // the manifest is a convenience
    }
  }

  result(): InstallResult {
    return { written: this.written, skipped: this.skipped, notes: this.notes, removed: this.removed, kept: this.kept };
  }
}

/** Parse a JSON object file; `undefined` content = empty object; throws a readable error otherwise. */
export function parseJsonObject(text: string | undefined, path: string): Record<string, any> {
  if (text === undefined || !text.trim()) return {};
  let doc: unknown;
  try {
    doc = JSON.parse(stripBom(text));
  } catch (err) {
    throw new Error(`${path} is not valid JSON (${(err as Error).message})`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${path} is not a JSON object`);
  return doc as Record<string, any>;
}

/** What setup/init changed in files shared with the user, so uninstall can revert exactly that. */
export interface SetupState {
  version?: string;
  at?: number;
  /** '.kiroignore' was added to kiroAgent.agentIgnoreFiles in the IDE user settings.json. */
  ideIgnoreSettingAdded?: boolean;
  /** chat.defaultAgent was set to "kopt" in ~/.kiro/settings/cli.json. */
  defaultAgentSet?: boolean;
  /** Per workspace (kopt init): what was added to shared files. */
  workspaces?: Record<string, { vscodeIgnoreSettingAdded?: boolean; gitignoreAdded?: boolean }>;
  /**
   * User-level shared files and directories that did not exist before kopt created them (mcp.json, cli.json, the IDE
   * settings.json, ~/.kiro and its sub-folders...). Uninstall deletes them again once nothing but kopt's residue is
   * left in them (an empty JSON object / empty folder), so a machine returns to its pre-setup state.
   */
  createdPaths?: string[];
}

/** JSON text whose every value is an empty object or array (`{}`, `{"mcpServers": {}}`, `{"k": []}`). */
export function isEmptyJsonResidue(text: string | undefined): boolean {
  if (text === undefined) return false;
  const empty = (v: unknown): boolean =>
    Array.isArray(v) ? v.length === 0 : !!v && typeof v === 'object' && Object.values(v as object).every(empty);
  try {
    const doc: unknown = JSON.parse(stripBom(text).trim() || '{}');
    return !!doc && typeof doc === 'object' && !Array.isArray(doc) && empty(doc);
  } catch {
    return false;
  }
}

export function statePath(userDir: string): string {
  return join(userDir, 'setup-state.json');
}

export function readState(userDir: string): SetupState {
  try {
    const v = JSON.parse(stripBom(readFileSync(statePath(userDir), 'utf8')));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

export function writeState(userDir: string, s: SetupState, dryRun = false): void {
  if (dryRun) return;
  try {
    writePrivateFile(statePath(userDir), JSON.stringify(s, null, 2) + '\n');
  } catch {
    // best effort
  }
}
