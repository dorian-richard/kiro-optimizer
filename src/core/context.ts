import type { KoptConfig } from './config.js';
import type { TelemetryEvent } from './types.js';

/**
 * Per-session memory of what was already sent to the model, so tools can answer
 * "unchanged, already shown" instead of re-sending the same code.
 *
 * Kiro compaction replaces MCP tool results with "Tool response contents truncated for brevity",
 * so dedup is bounded by a window (calls + minutes) and every tool accepts `fresh: true` to bypass it.
 */
export class Ledger {
  private calls = 0;
  private seen = new Map<string, { call: number; at: number; digest: string }>();

  constructor(private readonly windowCalls: number, private readonly windowMinutes: number, private readonly enabled = true) {}

  /** Must be called once per tool invocation. */
  tick(): number {
    return ++this.calls;
  }

  /**
   * True when `key` was sent with the same `digest` recently enough to be still in context.
   */
  wasShown(key: string, digest: string, now = Date.now()): boolean {
    if (!this.enabled) return false;
    const e = this.seen.get(key);
    if (!e || e.digest !== digest) return false;
    return this.calls - e.call <= this.windowCalls && now - e.at <= this.windowMinutes * 60_000;
  }

  /** Call number at which `key` was last shown, if any. */
  shownAt(key: string): number | undefined {
    return this.seen.get(key)?.call;
  }

  markShown(key: string, digest: string, now = Date.now()): void {
    this.seen.set(key, { call: this.calls, at: now, digest });
  }

  get callCount(): number {
    return this.calls;
  }
}

/** Everything a tool implementation needs besides its own parameters. */
export interface ToolContext {
  config: KoptConfig;
  ledger: Ledger;
  /** Session id (MCP session or Kiro session) for telemetry. */
  session?: string;
  /** Logical repo name for telemetry / multi-repo servers. */
  repo?: string;
  /** Fire-and-forget telemetry sink. */
  emit: (event: TelemetryEvent) => void;
}

export function newToolContext(config: KoptConfig, emit: (e: TelemetryEvent) => void = () => {}, session?: string, repo?: string): ToolContext {
  return {
    config,
    ledger: new Ledger(config.dedup.windowCalls, config.dedup.windowMinutes, config.dedup.enabled),
    session,
    repo,
    emit,
  };
}
