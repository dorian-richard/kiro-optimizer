// Event recording, kept dependency-light: hooks import this on every tool call.

import { appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { basename, join } from 'node:path';
import type { KoptConfig } from '../core/config.js';
import type { TelemetryEvent } from '../core/types.js';

export function telemetryDir(config: KoptConfig): string {
  return join(config.userDir, 'telemetry');
}

export function dayFileName(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10) + '.jsonl';
}

let cachedUser: { key: string; value: string | undefined } | undefined;

/**
 * Pseudonymous user id: first 12 hex of sha256(username@hostname). Overrides: env KOPT_USER,
 * or `telemetry.user` in config (string = use as is, false / "none" = omit).
 */
export function telemetryUser(config: KoptConfig): string | undefined {
  const override = (config.telemetry as { user?: unknown }).user;
  const env = process.env.KOPT_USER;
  const key = `${String(override)}|${env ?? ''}`;
  if (cachedUser?.key === key) return cachedUser.value;
  let value: string | undefined;
  if (env) value = env;
  else if (override === false || override === 'none' || override === 'off') value = undefined;
  else if (typeof override === 'string' && override) value = override;
  else {
    let name = process.env.USER || process.env.USERNAME || 'unknown';
    try { name = userInfo().username || name; } catch { /* no passwd entry (containers) */ }
    // lazy: keeps node:crypto off the hook fast path until an event is actually recorded
    const { createHash } = process.getBuiltinModule('node:crypto');
    value = createHash('sha256').update(`${name}@${hostname()}`).digest('hex').slice(0, 12);
  }
  cachedUser = { key, value };
  return value;
}

export function telemetryRepo(config: KoptConfig): string {
  return config.central.repoName || basename(config.root);
}

const madeDirs = new Set<string>();

/** Append one event (sync, never throws). Adds ts/user/repo when missing. */
export function record(event: TelemetryEvent, config: KoptConfig): void {
  try {
    if (!config.telemetry.enabled) return;
    const e: TelemetryEvent = { ...event, ts: event.ts || Date.now() };
    if (e.user === undefined) {
      const u = telemetryUser(config);
      if (u) e.user = u;
    }
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
