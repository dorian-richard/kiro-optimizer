import { CfnOutput, Duration, Stack } from 'aws-cdk-lib';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import type * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import { METRICS_NAMESPACE as NS } from './service.js';

/**
 * Metric contract (namespace `KiroOptimizer`), EMF lines on stdout from `kopt serve` (src/mcp/emf.ts) and
 * from the snapshot sync (docker/s3sync.mjs):
 *   Calls, TokensOut, BaselineTokens, Credits  dims [Tool], plus [Repo] only with KOPT_EMF_REPO_DIMENSION=1
 *                                              (context repoMetricDimension); [] when neither applies
 *   SnapshotsUpdated, SyncErrors, SyncDurationMs  dims []
 * Non-dimension properties (Logs Insights only, no metric cost): Repo (when not a dimension), Kind, User,
 * Session, Decision, DurationMs.
 * BaselineTokens exists only when the counterfactual is exact, so honest savings are computed per log line
 * (calls that carry a baseline) rather than by dividing two unrelated sums.
 */
export const METRICS = {
  calls: 'Calls',
  tokensOut: 'TokensOut',
  baseline: 'BaselineTokens',
  credits: 'Credits',
  syncUpdated: 'SnapshotsUpdated',
  syncErrors: 'SyncErrors',
} as const;

export interface KoptObservabilityProps {
  prefix: string;
  alb: elbv2.ApplicationLoadBalancer;
  targetGroup: elbv2.ApplicationTargetGroup;
  service: ecs.FargateService;
  logGroup: logs.ILogGroup;
  key: kms.IKey;
  alarmEmail?: string;
  /** `filters`: derive the same metrics with Logs metric filters (use only if EMF extraction is unavailable). */
  metricsSource: 'emf' | 'filters';
  /** The server emits the `[Repo]` dimension: chart per-repo metrics. Otherwise per-repo views use Logs Insights. */
  repoMetricDimension: boolean;
  indexerProjectPrefix?: string;
  indexerLogGroup?: logs.ILogGroup;
}

const searchExpr = (dim: 'Tool' | 'Repo', metric: string, stat: string, periodSec: number) =>
  `SEARCH('{${NS},${dim}} MetricName="${metric}"', '${stat}', ${periodSec})`;

export class KoptObservability extends Construct {
  readonly topic: sns.Topic;
  readonly dashboard: cw.Dashboard;

  constructor(scope: Construct, id: string, props: KoptObservabilityProps) {
    super(scope, id);
    const stack = Stack.of(this);

    this.topic = new sns.Topic(this, 'Alarms', { displayName: `${props.prefix} alarms`, masterKey: props.key, enforceSSL: true });
    if (props.alarmEmail) this.topic.addSubscription(new subs.EmailSubscription(props.alarmEmail));
    const action = new cwActions.SnsAction(this.topic);

    if (props.metricsSource === 'filters') this.addMetricFilters(props.logGroup);

    // ---------------------------------------------------------------- alarms
    const tgMetrics = props.targetGroup.metrics;
    const albMetrics = props.alb.metrics;
    const fiveMin = Duration.minutes(5);

    const alb5xx = new cw.Alarm(this, 'Alb5xx', {
      alarmDescription: 'kopt: 5xx responses (ALB + targets) over 5 minutes',
      metric: new cw.MathExpression({
        expression: 'FILL(elb, 0) + FILL(tgt, 0)',
        usingMetrics: {
          elb: albMetrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, { period: fiveMin, statistic: 'Sum' }),
          tgt: tgMetrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, { period: fiveMin, statistic: 'Sum' }),
        },
        period: fiveMin,
        label: '5xx',
      }),
      threshold: 10,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });

    const unhealthy = new cw.Alarm(this, 'UnhealthyHosts', {
      alarmDescription: 'kopt: at least one target failing /healthz',
      metric: tgMetrics.unhealthyHostCount({ period: Duration.minutes(1), statistic: 'Maximum' }),
      threshold: 1,
      evaluationPeriods: 5,
      datapointsToAlarm: 3,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });

    const noHealthy = new cw.Alarm(this, 'NoHealthyHosts', {
      alarmDescription: 'kopt: no healthy target, the MCP endpoint is down',
      metric: tgMetrics.healthyHostCount({ period: Duration.minutes(1), statistic: 'Minimum' }),
      threshold: 1,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      comparisonOperator: cw.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cw.TreatMissingData.BREACHING,
    });

    const latency = new cw.Alarm(this, 'LatencyP95', {
      alarmDescription: 'kopt: p95 target response time above 2 s',
      metric: tgMetrics.targetResponseTime({ period: fiveMin, statistic: 'p95' }),
      threshold: 2,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });

    const syncErrors = new cw.Alarm(this, 'SnapshotSyncErrors', {
      alarmDescription: 'kopt: snapshot sync from S3 failing (indexes on tasks are getting stale)',
      metric: new cw.Metric({ namespace: NS, metricName: METRICS.syncErrors, statistic: 'Sum', period: Duration.minutes(15) }),
      threshold: 3,
      evaluationPeriods: 2,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });

    for (const a of [alb5xx, unhealthy, noHealthy, latency, syncErrors]) {
      a.addAlarmAction(action);
      a.addOkAction(action);
    }

    // Indexer failures: one EventBridge rule for all projects instead of one alarm per repo.
    if (props.indexerProjectPrefix) {
      new events.Rule(this, 'IndexerFailed', {
        description: 'kopt: notify on failed/timed-out index builds',
        eventPattern: {
          source: ['aws.codebuild'],
          detailType: ['CodeBuild Build State Change'],
          detail: {
            'build-status': ['FAILED', 'TIMED_OUT', 'FAULT'],
            'project-name': [{ prefix: props.indexerProjectPrefix }],
          },
        },
        targets: [new targets.SnsTopic(this.topic, {
          message: events.RuleTargetInput.fromText(
            `kopt indexer ${events.EventField.fromPath('$.detail.build-status')}: ${events.EventField.fromPath('$.detail.project-name')} ` +
            `(${events.EventField.fromPath('$.detail.build-id')})`,
          ),
        })],
      });
    }

    // ---------------------------------------------------------------- dashboard
    const hour = 3600;
    const day = 86400;
    const bySearch = (dim: 'Tool' | 'Repo', metric: string) =>
      new cw.MathExpression({ expression: searchExpr(dim, metric, 'Sum', hour), label: '', period: Duration.hours(1), usingMetrics: {} });
    // Sum over the [Tool] set only: every tool/hook event carries a Tool, and the [Repo] set repeats the same events.
    const toolTotal = (metric: string, label: string) =>
      new cw.MathExpression({ expression: `SUM(${searchExpr('Tool', metric, 'Sum', hour)})`, label, period: Duration.hours(1), usingMetrics: {} });
    const logs1 = [props.logGroup.logGroupName];

    this.dashboard = new cw.Dashboard(this, 'Dashboard', {
      dashboardName: `${props.prefix}-savings`,
      defaultInterval: Duration.days(7),
    });
    this.dashboard.addWidgets(
      new cw.TextWidget({
        markdown:
          '## KiroOptimizer\n' +
          'Savings only count calls with an **exact** counterfactual (full command output for run, full file for outline/skeleton). ' +
          'Billing truth = Kiro credits per user (Athena named query `kopt-credits-by-cohort`).',
        width: 24,
        height: 2,
      }),
    );
    const byRepo = props.repoMetricDimension
      ? new cw.GraphWidget({ title: 'TokensOut by repo', left: [bySearch('Repo', METRICS.tokensOut)], stacked: true, width: 8 })
      : new cw.LogQueryWidget({
          // No [Repo] metric dimension by default (one series per repo costs money): read it from the log lines.
          title: 'TokensOut by repo (Logs Insights)',
          logGroupNames: logs1,
          view: cw.LogQueryVisualizationType.TABLE,
          queryLines: [
            'filter Kind = "tool" and ispresent(Repo)',
            'stats count(*) as calls, sum(TokensOut) as tokensOut by Repo',
            'sort tokensOut desc',
            'limit 25',
          ],
          width: 8,
        });
    this.dashboard.addWidgets(
      new cw.GraphWidget({ title: 'Calls by tool', left: [bySearch('Tool', METRICS.calls)], stacked: true, width: 8 }),
      new cw.GraphWidget({ title: 'TokensOut by tool', left: [bySearch('Tool', METRICS.tokensOut)], stacked: true, width: 8 }),
      byRepo,
    );
    this.dashboard.addWidgets(
      new cw.GraphWidget({
        title: 'BaselineTokens vs TokensOut (savings)',
        left: [toolTotal(METRICS.baseline, 'BaselineTokens (exact counterfactual)'), toolTotal(METRICS.tokensOut, 'TokensOut (all calls)')],
        width: 12,
      }),
      new cw.LogQueryWidget({
        title: 'Exact savings by tool (calls with a measured baseline)',
        logGroupNames: logs1,
        view: cw.LogQueryVisualizationType.TABLE,
        queryLines: [
          'filter ispresent(BaselineTokens)',
          'stats count(*) as calls, sum(BaselineTokens) as baseline, sum(TokensOut) as returned, 100 * (1 - sum(TokensOut) / sum(BaselineTokens)) as savedPct by Tool',
          'sort baseline desc',
        ],
        width: 12,
      }),
    );
    this.dashboard.addWidgets(
      new cw.LogQueryWidget({
        title: 'Kiro credits per day (reported by kopt clients)',
        logGroupNames: logs1,
        view: cw.LogQueryVisualizationType.BAR,
        queryLines: ['filter Kind = "credits"', 'stats sum(Credits) as credits by bin(1d)'],
        width: 12,
      }),
      new cw.LogQueryWidget({
        title: 'Hook blocks (governor) per hour',
        logGroupNames: logs1,
        view: cw.LogQueryVisualizationType.LINE,
        queryLines: ['filter Kind = "hook" and Decision = "block"', 'stats count(*) as blocks by bin(1h)'],
        width: 12,
      }),
    );
    this.dashboard.addWidgets(
      new cw.GraphWidget({
        title: 'ALB requests / 5xx',
        left: [albMetrics.requestCount({ period: fiveMin, label: 'requests' })],
        right: [
          albMetrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, { period: fiveMin, label: 'ELB 5xx' }),
          tgMetrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, { period: fiveMin, label: 'target 5xx' }),
        ],
        width: 6,
      }),
      new cw.GraphWidget({
        title: 'Latency (s)',
        left: [
          tgMetrics.targetResponseTime({ period: fiveMin, statistic: 'p50', label: 'p50' }),
          tgMetrics.targetResponseTime({ period: fiveMin, statistic: 'p95', label: 'p95' }),
        ],
        width: 6,
      }),
      new cw.GraphWidget({
        title: 'Tasks: CPU / memory (%)',
        left: [props.service.metricCpuUtilization({ period: fiveMin }), props.service.metricMemoryUtilization({ period: fiveMin })],
        right: [tgMetrics.healthyHostCount({ period: Duration.minutes(1), label: 'healthy targets' })],
        width: 6,
      }),
      new cw.GraphWidget({
        title: 'Snapshot sync',
        left: [
          new cw.Metric({ namespace: NS, metricName: METRICS.syncUpdated, statistic: 'Sum', period: Duration.hours(1), label: 'snapshots updated' }),
          new cw.Metric({ namespace: NS, metricName: METRICS.syncErrors, statistic: 'Sum', period: Duration.hours(1), label: 'errors' }),
        ],
        width: 6,
      }),
    );
    const indexerPrefix = props.indexerProjectPrefix;
    const topRepos = new cw.LogQueryWidget({
      title: 'Top repos and users by tokens returned',
      logGroupNames: logs1,
      view: cw.LogQueryVisualizationType.TABLE,
      queryLines: [
        'filter Kind = "tool"',
        'stats count(*) as calls, sum(TokensOut) as tokensOut, sum(BaselineTokens) as baseline by Repo, User',
        'sort tokensOut desc',
        'limit 20',
      ],
      width: 12,
    });
    if (indexerPrefix) {
      // SEARCH matches the project-name token; one series per repo summed into a single line.
      const cb = (metric: string, label: string) => new cw.MathExpression({
        expression: `SUM(SEARCH('{AWS/CodeBuild,ProjectName} MetricName="${metric}" ${indexerPrefix.replace(/-$/, '')}', 'Sum', ${day}))`,
        label,
        period: Duration.days(1),
        usingMetrics: {},
      });
      this.dashboard.addWidgets(
        new cw.GraphWidget({ title: 'Index builds per day', left: [cb('SucceededBuilds', 'succeeded'), cb('FailedBuilds', 'failed')], view: cw.GraphWidgetView.BAR, width: 12 }),
        topRepos,
      );
    } else {
      this.dashboard.addWidgets(topRepos);
    }

    // ---------------------------------------------------------------- saved Logs Insights queries
    new logs.QueryDefinition(this, 'QTokensByRepoUser', {
      queryDefinitionName: `${props.prefix}/tokens-by-repo-and-user`,
      logGroups: [props.logGroup],
      queryString: new logs.QueryString({
        filterStatements: ['Kind = "tool"'],
        statsStatements: ['count(*) as calls, sum(TokensOut) as tokensOut, sum(BaselineTokens) as baseline by Repo, User, Tool'],
        sort: 'tokensOut desc',
        limit: 200,
      }),
    });
    new logs.QueryDefinition(this, 'QHookBlocks', {
      queryDefinitionName: `${props.prefix}/hook-blocks`,
      logGroups: [props.logGroup],
      queryString: new logs.QueryString({
        filterStatements: ['Kind = "hook"', 'Decision = "block"'],
        statsStatements: ['count(*) as blocks by Tool, User'],
        sort: 'blocks desc',
        limit: 200,
      }),
    });
    new logs.QueryDefinition(this, 'QErrors', {
      queryDefinitionName: `${props.prefix}/errors`,
      logGroups: [props.logGroup, ...(props.indexerLogGroup ? [props.indexerLogGroup] : [])],
      queryString: new logs.QueryString({
        fields: ['@timestamp', '@logStream', '@message'],
        filterStatements: ['@message like /(?i)(error|exception|failed|fatal)/'],
        sort: '@timestamp desc',
        limit: 200,
      }),
    });

    new CfnOutput(this, 'DashboardUrl', {
      value: `https://${stack.region}.console.aws.amazon.com/cloudwatch/home?region=${stack.region}#dashboards:name=${this.dashboard.dashboardName}`,
    });
    new CfnOutput(this, 'AlarmTopicArn', { value: this.topic.topicArn });
  }

  /** Fallback when EMF lines are not turned into metrics: same names from the JSON log lines ([Tool] set only). */
  private addMetricFilters(logGroup: logs.ILogGroup): void {
    const F = logs.FilterPattern;
    const withTool = (field: string) => F.all(F.numberValue(field, '>=', 0), F.exists('$.Tool'));
    const sync = (field: string) => F.all(F.stringValue('$.Kind', '=', 'sync'), F.numberValue(field, '>=', 1));
    const defs: Array<[string, logs.IFilterPattern, string, Record<string, string> | undefined]> = [
      [METRICS.calls, withTool('$.Calls'), '$.Calls', { Tool: '$.Tool' }],
      [METRICS.tokensOut, withTool('$.TokensOut'), '$.TokensOut', { Tool: '$.Tool' }],
      [METRICS.baseline, withTool('$.BaselineTokens'), '$.BaselineTokens', { Tool: '$.Tool' }],
      [METRICS.credits, F.numberValue('$.Credits', '>=', 0), '$.Credits', undefined],
      [METRICS.syncErrors, sync('$.SyncErrors'), '$.SyncErrors', undefined],
      [METRICS.syncUpdated, sync('$.SnapshotsUpdated'), '$.SnapshotsUpdated', undefined],
    ];
    for (const [name, pattern, value, dimensions] of defs) {
      new logs.MetricFilter(this, `Mf${name}`, {
        logGroup,
        metricNamespace: NS,
        metricName: name,
        filterPattern: pattern,
        metricValue: value,
        dimensions,
      });
    }
  }
}
