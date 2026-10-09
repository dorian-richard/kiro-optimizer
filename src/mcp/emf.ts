// CloudWatch Embedded Metric Format lines for central usage metrics (HTTP mode writes them to stdout;
// the container log driver ships them to CloudWatch Logs, which extracts the metrics).

import type { TelemetryEvent } from '../core/types.js';

export const EMF_NAMESPACE = 'KiroOptimizer';

const METRIC_UNITS = { Calls: 'Count', TokensOut: 'Count', BaselineTokens: 'Count', Credits: 'None' } as const;
type MetricName = keyof typeof METRIC_UNITS;

const str = (v: unknown, max = 200): string | undefined => (typeof v === 'string' && v.length ? v.slice(0, max) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

export interface EmfOptions {
  /**
   * Also emit the [Repo] dimension set. Every repo then adds one metric series per metric (cost), so it is off
   * unless KOPT_EMF_REPO_DIMENSION=1; Repo always stays a log property (Logs Insights can group by it).
   */
  repoDimension?: boolean;
}

/**
 * One EMF JSON line for a telemetry event, or undefined when it carries no metric.
 * Dimension sets: [Tool] when present, plus [Repo] when enabled (none -> namespace-level aggregate).
 * `user` overrides the event's self-declared user (callers pass the authenticated principal).
 */
export function toEmf(e: Partial<TelemetryEvent>, user?: string, o: EmfOptions = {}): string | undefined {
  const repoDimension = o.repoDimension ?? process.env.KOPT_EMF_REPO_DIMENSION === '1';
  const values: Partial<Record<MetricName, number>> = {};
  if (e.kind === 'tool' || e.kind === 'hook') values.Calls = 1;
  const tokensOut = num(e.tokensOut);
  if (tokensOut !== undefined) values.TokensOut = tokensOut;
  const baseline = num(e.baselineTokens);
  if (baseline !== undefined) values.BaselineTokens = baseline;
  const credits = num(e.credits);
  if (credits !== undefined) values.Credits = credits;
  const names = Object.keys(values) as MetricName[];
  if (!names.length) return undefined;

  const tool = str(e.tool, 100);
  const repo = str(e.repo, 200);
  const dims: string[][] = [];
  if (tool) dims.push(['Tool']);
  if (repo && repoDimension) dims.push(['Repo']);
  if (!dims.length) dims.push([]);

  const ts = num(e.ts);
  const doc: Record<string, unknown> = {
    _aws: {
      Timestamp: ts !== undefined && ts > 1e12 ? Math.round(ts) : Date.now(),
      CloudWatchMetrics: [
        { Namespace: EMF_NAMESPACE, Dimensions: dims, Metrics: names.map((Name) => ({ Name, Unit: METRIC_UNITS[Name] })) },
      ],
    },
    ...values,
  };
  if (tool) doc.Tool = tool;
  if (repo) doc.Repo = repo;
  // Non-dimension properties: searchable in Logs Insights without creating metric series.
  const props: Record<string, string | number | undefined> = {
    Kind: str(e.kind, 20),
    User: str(user, 200) ?? str(e.user, 200),
    Session: str(e.session, 100),
    Decision: str(e.decision, 40),
    DurationMs: num(e.durationMs),
  };
  for (const [k, v] of Object.entries(props)) if (v !== undefined) doc[k] = v;
  return JSON.stringify(doc);
}
