// Event recording, kept dependency-light: hooks import this on every tool call.

import { appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { KoptConfig } from '../core/config.js';
import type { TelemetryEvent } from '../core/types.js';

export function telemetryDir(config: KoptConfig): string {
  return join(config.userDir, 'telemetry');
}

export function dayFileName(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10) + '.jsonl';
}

/** Repo label of an event: the project folder name. */
export function telemetryRepo(config: KoptConfig): string {
  return basename(config.root);
}

const madeDirs = new Set<string>();

/** Append one event (sync, never throws). Adds ts/repo when missing. */
export function record(event: TelemetryEvent, config: KoptConfig): void {
  try {
    if (!config.telemetry.enabled) return;
    const e: TelemetryEvent = { ...event, ts: event.ts || Date.now() };
    if (e.repo === undefined) e.repo = telemetryRepo(config);
    const dir = telemetryDir(config);
    const file = join(dir, dayFileName(e.ts));
    const line = JSON.stringify(e) + '\n';
    if (!madeDirs.has(dir)) {
      mkdirSync(dir, { recursive: true });
      madeDirs.add(dir);
    }
    // one write() per line keeps concurrent appends from interleaving (O_APPEND)
    try {
      appendFileSync(file, line);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      mkdirSync(dir, { recursive: true });
      appendFileSync(file, line);
    }
  } catch {
    // telemetry must never break the caller
  }
}

/** Day files sorted by name (= by date). */
export function dayFiles(config: KoptConfig): string[] {
  const dir = telemetryDir(config);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort();
}

/** Day files are deleted after this many days. */
export const RETAIN_DAYS = 90;

/** Delete day files older than RETAIN_DAYS (one directory listing; never throws). */
export function pruneTelemetry(config: KoptConfig, now: number = Date.now()): void {
  try {
    const cutoff = dayFileName(now - RETAIN_DAYS * 86400_000);
    for (const name of dayFiles(config)) {
      if (name >= cutoff) break;
      try {
        unlinkSync(join(telemetryDir(config), name));
      } catch {
        // retried next time
      }
    }
  } catch {
    // telemetry must never break the caller
  }
}
