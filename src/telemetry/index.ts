// Local-first telemetry: synchronous JSONL append per UTC day, shipped in gzip ndjson batches.
//
// Files: <userDir>/telemetry/<YYYY-MM-DD>.jsonl, ship cursor <userDir>/telemetry/ship-cursor.json
// (byte offset per file, advanced only after a 2xx), credits cursor in credits.ts.

import { closeSync, openSync, readFileSync, readSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { KoptConfig } from '../core/config.js';
import { atomicWrite, readJson, withFileLockAsync } from './fsutil.js';
import { collectKiroCredits } from './credits.js';
import { dayFiles, record, telemetryDir } from './record.js';

export { record, telemetryDir, telemetryUser, telemetryRepo, dayFileName, dayFiles } from './record.js';
export { collectKiroCredits } from './credits.js';
export { stats } from './stats.js';

export const SHIP_BATCH = 500;
const SHIP_TIMEOUT_MS = 5000;
const RETAIN_DAYS = 90;

function readFrom(path: string, offset: number): Buffer {
  const size = statSync(path).size;
  if (size <= offset) return Buffer.alloc(0);
  const buf = Buffer.alloc(size - offset);
  const fd = openSync(path, 'r');
  try {
    let read = 0;
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, offset + read);
      if (n <= 0) break;
      read += n;
    }
    return read === buf.length ? buf : buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function bearerToken(config: KoptConfig): string | undefined {
  const fromEnv = process.env[config.telemetry.tokenEnv];
  if (fromEnv) return fromEnv.trim();
  try {
    const t = readFileSync(join(config.userDir, 'token'), 'utf8').trim();
    return t || undefined;
  } catch {
    return undefined;
  }
}

/** Collect new Kiro credit records into the local log. Returns how many were added. */
export function collectAndRecord(config: KoptConfig): number {
  try {
    const events = collectKiroCredits(config);
    for (const e of events) record(e, config);
    return events.length;
  } catch {
    return 0;
  }
}

function pruneOld(config: KoptConfig, cursor: Record<string, number>): void {
  const cutoff = new Date(Date.now() - RETAIN_DAYS * 86400_000).toISOString().slice(0, 10);
  for (const name of dayFiles(config)) {
    if (name.slice(0, 10) >= cutoff) break;
    try { unlinkSync(join(telemetryDir(config), name)); } catch { /* ignore */ }
    delete cursor[name];
  }
}

async function post(endpoint: string, lines: string[], token: string | undefined): Promise<boolean> {
  const body = gzipSync(Buffer.from(lines.join('\n') + '\n', 'utf8'));
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-ndjson',
    'Content-Encoding': 'gzip',
    'User-Agent': 'kopt-telemetry/1',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetch(endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(SHIP_TIMEOUT_MS) });
    await res.arrayBuffer().catch(() => undefined);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Collect Kiro credits, then send unsent lines to `telemetry.endpoint` in batches of 500.
 * The cursor only moves past a batch after a 2xx, so failures are retried next time.
 * `failed` = lines still unsent because of an error. Concurrent ships are serialized by a lock.
 */
export async function ship(config: KoptConfig): Promise<{ sent: number; failed: number }> {
  if (!config.telemetry.enabled) return { sent: 0, failed: 0 };
  collectAndRecord(config);
  const endpoint = config.telemetry.endpoint;
  const dir = telemetryDir(config);
  const cursorPath = join(dir, 'ship-cursor.json');
  const result = await withFileLockAsync(join(dir, 'ship.lock'), async () => {
    const cursor = readJson<Record<string, number>>(cursorPath, {});
    pruneOld(config, cursor);
    if (!endpoint) {
      atomicWrite(cursorPath, JSON.stringify(cursor));
      return { sent: 0, failed: 0 };
    }
    const token = bearerToken(config);
    let sent = 0;
    let failed = 0;
    let stop = false;
    for (const name of dayFiles(config)) {
      const path = join(dir, name);
      let offset = cursor[name] ?? 0;
      let chunk: Buffer;
      try { chunk = readFrom(path, offset); } catch { continue; }
      if (!chunk.length) continue;
      // only complete lines: a concurrent writer may be mid-append
      const lastNl = chunk.lastIndexOf(0x0a);
      if (lastNl < 0) continue;
      const lines: { text: string; end: number }[] = [];
      let start = 0;
      while (start <= lastNl) {
        const nl = chunk.indexOf(0x0a, start);
        const text = chunk.subarray(start, nl).toString('utf8').trim();
        if (text) lines.push({ text, end: offset + nl + 1 });
        start = nl + 1;
      }
      const fileEnd = offset + lastNl + 1;
      for (let i = 0; i < lines.length && !stop; i += SHIP_BATCH) {
        const batch = lines.slice(i, i + SHIP_BATCH);
        if (await post(endpoint, batch.map((l) => l.text), token)) {
          sent += batch.length;
          offset = i + SHIP_BATCH >= lines.length ? fileEnd : batch[batch.length - 1].end;
          cursor[name] = offset;
          atomicWrite(cursorPath, JSON.stringify(cursor));
        } else {
          failed += lines.length - i;
          stop = true;
        }
      }
      if (lines.length === 0) {
        cursor[name] = fileEnd;
        atomicWrite(cursorPath, JSON.stringify(cursor));
      }
      if (stop) {
        // count what remains in later files too, so callers can report the backlog
        for (const later of dayFiles(config).filter((n) => n > name)) {
          try {
            const rest = readFrom(join(dir, later), cursor[later] ?? 0);
            failed += rest.toString('utf8').split('\n').filter((l) => l.trim()).length;
          } catch { /* ignore */ }
        }
        break;
      }
    }
    return { sent, failed };
  });
  return result ?? { sent: 0, failed: 0 };
}
