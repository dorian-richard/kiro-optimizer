import type { KoptConfig } from './config.js';
import type { TelemetryEvent } from './types.js';

/**
 * Per-session memory of what was already sent to the model, so tools can answer
 * "unchanged, already shown" instead of re-sending the same code.
 *
 * Kiro compaction replaces MCP tool results with "Tool response contents truncated for brevity",
 * so dedup is bounded by a window (calls + minutes) and every tool accepts `fresh: true` to bypass it.
 */
/** What a Ledger remembers, as JSON (a CLI session keeps it in a file between calls). */
export interface LedgerState {
  calls: number;
  seen: Array<[string, { call: number; at: number; digest: string }]>;
  ranges: Array<[string, Array<{ key: string; start: number; end: number }>]>;
}

export class Ledger {
  private calls = 0;
  private seen = new Map<string, { call: number; at: number; digest: string }>();
  /** Line ranges sent per path (a symbol inside an already-sent range is "unchanged" too). */
  readonly ranges = new Map<string, Array<{ key: string; start: number; end: number }>>();

  constructor(private readonly windowCalls: number, private readonly windowMinutes: number, private readonly enabled = true) {}

  /** The entries still inside the dedup window, as JSON. */
  toState(now = Date.now()): LedgerState {
    const seen = [...this.seen.entries()].filter(([, e]) => this.calls - e.call <= this.windowCalls && now - e.at <= this.windowMinutes * 60_000);
    const keep = new Set(seen.map(([k]) => k));
    const ranges = [...this.ranges.entries()].map(([p, arr]) => [p, arr.filter((r) => keep.has(r.key))] as [string, typeof arr]).filter(([, arr]) => arr.length);
    return { calls: this.calls, seen, ranges };
  }

  /** Restores a saved state (ignored when malformed). */
  load(state: unknown): void {
    const st = state as Partial<LedgerState> | undefined;
    if (!st || typeof st.calls !== 'number' || !Array.isArray(st.seen) || !Array.isArray(st.ranges)) return;
    this.calls = st.calls;
    this.seen = new Map(st.seen);
    this.ranges.clear();
    for (const [p, arr] of st.ranges) this.ranges.set(p, arr);
  }

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
  /** Repo label for telemetry (project folder name). */
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
