// Persistent store of command outputs: <dataDir>/outputs/<handle>.log + index.json (run cache + LRU metadata).
// Logs often contain secrets (env dumps, connection strings in stack traces): the folder is private to the user
// (0700) and every file in it is 0600 (POSIX; Windows profile folders are already per-user).

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renameWithRetry } from '../telemetry/fsutil.js';

export const MAX_OUTPUTS = 200;
export const MAX_OUTPUT_BYTES = 200 * 1024 * 1024;
export const HANDLE_RE = /^o[0-9a-f]{6}$/;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
/** Folders already made private by this process. */
const secured = new Set<string>();

export interface RunEntry {
  command: string;
  cwd: string;
  fingerprint: string;
  handle: string;
  exitCode: number;
  /** Full result text as returned the first time (header + body + expand pointer). */
  text: string;
  /** Ledger call number of the original run (same session only). */
  call: number;
  at: number;
  baselineTokens: number;
  rawTokens: number;
  filter: string;
  durationMs?: number;
  /** Budget the text was compressed for; another budget re-compresses the stored log. */
  maxTokens?: number;
  droppedChars?: number;
}

export interface OutputEntry {
  bytes: number;
  lines: number;
  command: string;
  at: number;
  used: number;
}

export interface OutputIndex {
  v: 1;
  counter: number;
  runs: Record<string, RunEntry>;
  outputs: Record<string, OutputEntry>;
}

export function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

export class OutputStore {
  readonly dir: string;
  private readonly indexPath: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'outputs');
    this.indexPath = join(this.dir, 'index.json');
  }

  load(): OutputIndex {
    try {
      const idx = JSON.parse(readFileSync(this.indexPath, 'utf8')) as OutputIndex;
      if (idx && idx.v === 1 && idx.runs && idx.outputs) return idx;
    } catch {
      /* missing or corrupt: start over */
    }
    return { v: 1, counter: 0, runs: {}, outputs: {} };
  }

  save(idx: OutputIndex): void {
    this.ensureDir();
    // Atomic replace: the MCP server and the CLI may both write. On Windows a concurrent reader makes the
    // rename fail for a few milliseconds (sharing violation): retried, and the temp file never lingers.
    const tmp = `${this.indexPath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(idx), { mode: FILE_MODE });
    try {
      renameWithRetry(tmp, this.indexPath);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        /* already gone */
      }
      throw err;
    }
  }

  logPath(handle: string): string {
    return join(this.dir, `${handle}.log`);
  }

  has(handle: string): boolean {
    return HANDLE_RE.test(handle) && existsSync(this.logPath(handle));
  }

  newHandle(idx: OutputIndex, seed: string): string {
    for (;;) {
      idx.counter++;
      const handle = `o${sha1(`${seed}\0${idx.counter}`).slice(0, 6)}`;
      if (!idx.outputs[handle] && !existsSync(this.logPath(handle))) return handle;
    }
  }

  writeLog(idx: OutputIndex, handle: string, text: string, command: string): void {
    this.ensureDir();
    writeFileSync(this.logPath(handle), text, { mode: FILE_MODE });
    const now = Date.now();
    idx.outputs[handle] = { bytes: Buffer.byteLength(text), lines: text ? text.split('\n').length : 0, command, at: now, used: now };
    this.evict(idx);
  }

  /**
   * A log by handle (kopt_read o3fad54): only the strict handle form, and only a plain file kopt wrote. A link
   * left in the folder (pointing at a repo's .env, say) is not one of its logs and is never followed.
   */
  readLog(handle: string): string | undefined {
    if (!HANDLE_RE.test(handle)) return undefined;
    try {
      const p = this.logPath(handle);
      if (!lstatSync(p).isFile()) return undefined;
      return readFileSync(p, 'utf8');
    } catch {
      return undefined;
    }
  }

  /** LRU retention: at most MAX_OUTPUTS logs and MAX_OUTPUT_BYTES in total; run-cache entries follow their log. */
  evict(idx: OutputIndex, maxOutputs = MAX_OUTPUTS, maxBytes = MAX_OUTPUT_BYTES): void {
    const entries = Object.entries(idx.outputs).sort((a, b) => a[1].used - b[1].used);
    let total = entries.reduce((n, [, e]) => n + e.bytes, 0);
    let count = entries.length;
    for (const [handle, e] of entries) {
      if (count <= maxOutputs && total <= maxBytes) break;
      this.remove(idx, handle);
      total -= e.bytes;
      count--;
    }
    // Orphan logs (index lost or written by a racing process long ago).
    try {
      const cutoff = Date.now() - 3600_000;
      for (const f of readdirSync(this.dir)) {
        const m = /^(o[0-9a-f]{6})\.log$/.exec(f);
        const strayTmp = /^index\.json\.\d+\.\d+\.tmp$/.test(f);
        if (!strayTmp && (!m || idx.outputs[m[1]])) continue;
        const p = join(this.dir, f);
        try {
          if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
        } catch {
          /* removed meanwhile, or still open on Windows */
        }
      }
    } catch {
      /* best effort */
    }
  }

  private remove(idx: OutputIndex, handle: string): void {
    delete idx.outputs[handle];
    for (const [k, r] of Object.entries(idx.runs)) if (r.handle === handle) delete idx.runs[k];
    try {
      unlinkSync(this.logPath(handle));
    } catch {
      /* already gone */
    }
  }

  private ensureDir(): void {
    if (secured.has(this.dir) && existsSync(this.dir)) return;
    if (!existsSync(this.dir)) {
      // `mode` applies to every folder created here, the data dir included.
      mkdirSync(this.dir, { recursive: true, mode: DIR_MODE });
      // Keep logs out of `git status` / `git add .` (and therefore out of the workspace fingerprint).
      try {
        writeFileSync(join(this.dir, '.gitignore'), '*\n');
      } catch {
        /* not fatal */
      }
    } else if (process.platform !== 'win32') {
      // Written by an older kopt with default permissions: tighten the folder and the files already in it.
      try {
        if ((statSync(this.dir).mode & 0o077) !== 0) {
          chmodSync(this.dir, DIR_MODE);
          for (const f of readdirSync(this.dir)) {
            try {
              chmodSync(join(this.dir, f), FILE_MODE);
            } catch {
              /* removed meanwhile */
            }
          }
        }
      } catch {
        /* not ours to change */
      }
    }
    secured.add(this.dir);
  }
}
