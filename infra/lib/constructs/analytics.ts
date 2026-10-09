import { CfnOutput, Stack } from 'aws-cdk-lib';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as glue from 'aws-cdk-lib/aws-glue';
import type * as kms from 'aws-cdk-lib/aws-kms';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { PREFIX } from './data.js';

export interface KoptAnalyticsProps {
  prefix: string;
  bucket: s3.IBucket;
  key: kms.IKey;
  retainData: boolean;
  /** Create the Glue table over Kiro's daily user-activity CSV export. */
  kiroUsageExport: boolean;
  kiroUsageRegion?: string;
}

/** Static columns of Kiro's user_report CSV, in documented order (per-model `<model>_messages` columns follow and are ignored). */
export const KIRO_USER_REPORT_COLUMNS = [
  'date', 'userid', 'client_type', 'chat_conversations', 'credits_used', 'overage_cap', 'overage_credits_used',
  'overage_enabled', 'profileid', 'subscription_tier', 'total_messages', 'new_user', 'user_email',
] as const;

const OPEN_CSV_SERDE = {
  serializationLibrary: 'org.apache.hadoop.hive.serde2.OpenCSVSerde',
  parameters: { separatorChar: ',', quoteChar: '"', escapeChar: '\\' },
};
const TEXT_IO = {
  inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
  outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
};

/**
 * Glue/Athena layer to compare Kiro credits before/after kopt by cohort (difference-in-differences):
 * - `kiro_user_report`: Kiro's daily per-user CSV (Credits_Used is the only billing-grade signal Kiro exports),
 * - `kopt_cohorts`: CSV maintained by the team (user_email, cohort, start_date),
 * - named queries in a KMS-encrypted workgroup.
 */
export class KoptAnalytics extends Construct {
  readonly databaseName: string;
  readonly workGroupName: string;

  constructor(scope: Construct, id: string, props: KoptAnalyticsProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const db = `${props.prefix.toLowerCase().replace(/[^a-z0-9_]/g, '_')}_analytics`;
    this.databaseName = db;
    const bucketUrl = `s3://${props.bucket.bucketName}`;

    const database = new glue.CfnDatabase(this, 'Database', {
      catalogId: stack.account,
      databaseInput: { name: db, description: 'KiroOptimizer: Kiro usage export + cohorts' },
    });

    if (props.kiroUsageExport) {
      const region = props.kiroUsageRegion ?? stack.region;
      const base = `${bucketUrl}/${PREFIX.kiroUsage}AWSLogs/${stack.account}/KiroLogs/user_report/${region}/`;
      const t = new glue.CfnTable(this, 'KiroUserReport', {
        catalogId: stack.account,
        databaseName: db,
        tableInput: {
          name: 'kiro_user_report',
          description: 'Kiro daily per-user activity (CSV, one file per client type, written 02:00 UTC)',
          tableType: 'EXTERNAL_TABLE',
          parameters: {
            classification: 'csv',
            'skip.header.line.count': '1',
            // Partition projection: no crawler and no MSCK REPAIR; `dt` is the export day (activity of the previous day).
            'projection.enabled': 'true',
            'projection.dt.type': 'date',
            'projection.dt.format': 'yyyy/MM/dd',
            'projection.dt.range': '2025/01/01,NOW',
            'projection.dt.interval': '1',
            'projection.dt.interval.unit': 'DAYS',
            'storage.location.template': `${base}\${dt}/00/`,
          },
          partitionKeys: [{ name: 'dt', type: 'string' }],
          storageDescriptor: {
            location: base,
            ...TEXT_IO,
            serdeInfo: OPEN_CSV_SERDE,
            // OpenCSVSerde reads everything as text; queries cast explicitly.
            columns: KIRO_USER_REPORT_COLUMNS.map((name) => ({ name, type: 'string' })),
          },
        },
      });
      t.addResourceDependency(database);
    }

    const cohorts = new glue.CfnTable(this, 'Cohorts', {
      catalogId: stack.account,
      databaseName: db,
      tableInput: {
        name: 'kopt_cohorts',
        description: 'Pilot/control cohorts: user_email,cohort,start_date (YYYY-MM-DD), CSV with header',
        tableType: 'EXTERNAL_TABLE',
        parameters: { classification: 'csv', 'skip.header.line.count': '1' },
        storageDescriptor: {
          location: `${bucketUrl}/${PREFIX.cohorts}`,
          ...TEXT_IO,
          serdeInfo: OPEN_CSV_SERDE,
          columns: [
            { name: 'user_email', type: 'string' },
            { name: 'cohort', type: 'string' },
            { name: 'start_date', type: 'string' },
          ],
        },
      },
    });
    cohorts.addResourceDependency(database);

    this.workGroupName = `${props.prefix}-analytics`;
    const wg = new athena.CfnWorkGroup(this, 'WorkGroup', {
      name: this.workGroupName,
      description: 'KiroOptimizer savings analysis',
      recursiveDeleteOption: !props.retainData,
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
        publishCloudWatchMetricsEnabled: true,
        bytesScannedCutoffPerQuery: 10 * 1024 ** 3,
        resultConfiguration: {
          outputLocation: `${bucketUrl}/${PREFIX.athenaResults}`,
          encryptionConfiguration: { encryptionOption: 'SSE_KMS', kmsKey: props.key.keyArn },
        },
      },
    });

    if (props.kiroUsageExport) {
      const q1 = new athena.CfnNamedQuery(this, 'CreditsByCohort', {
        database: db,
        workGroup: wg.name,
        name: 'kopt-credits-by-cohort',
        description: 'Average Kiro credits per active user-day, before/after start_date, per cohort (last 120 days)',
        queryString: CREDITS_BY_COHORT_SQL(db),
      });
      q1.addResourceDependency(wg);
      const q2 = new athena.CfnNamedQuery(this, 'CreditsDiffInDiff', {
        database: db,
        workGroup: wg.name,
        name: 'kopt-credits-diff-in-diff',
        description: 'Difference-in-differences of credits per user-day: (pilot after - before) - (control after - before)',
        queryString: DIFF_IN_DIFF_SQL(db),
      });
      q2.addResourceDependency(wg);
      const q3 = new athena.CfnNamedQuery(this, 'CreditsDaily', {
        database: db,
        workGroup: wg.name,
        name: 'kopt-credits-daily',
        description: 'Kiro credits and messages per export day and client type (last 60 days)',
        queryString: DAILY_SQL(db),
      });
      q3.addResourceDependency(wg);
    }

    new CfnOutput(this, 'GlueDatabase', { value: db });
    new CfnOutput(this, 'AthenaWorkGroup', { value: this.workGroupName });
    new CfnOutput(this, 'CohortsUri', { value: `${bucketUrl}/${PREFIX.cohorts}cohorts.csv`, description: 'Upload user_email,cohort,start_date' });
  }
}

const USAGE_CTE = (db: string, days: number) => `usage AS (
  SELECT lower(trim(user_email)) AS email,
         date(date_parse(dt, '%Y/%m/%d')) AS day,
         sum(coalesce(try_cast(credits_used AS double), 0)) AS credits,
         sum(coalesce(try_cast(total_messages AS double), 0)) AS messages
  FROM ${db}.kiro_user_report
  WHERE dt >= date_format(current_date - interval '${days}' day, '%Y/%m/%d')
  GROUP BY 1, 2
),
cohorts AS (
  SELECT lower(trim(user_email)) AS email, lower(trim(cohort)) AS cohort, date(trim(start_date)) AS start_date
  FROM ${db}.kopt_cohorts
)`;

const CREDITS_BY_COHORT_SQL = (db: string) => `WITH ${USAGE_CTE(db, 120)}
SELECT c.cohort,
       CASE WHEN u.day < c.start_date THEN 'before' ELSE 'after' END AS period,
       count(DISTINCT u.email) AS users,
       count(*) AS user_days,
       round(avg(u.credits), 2) AS avg_credits_per_user_day,
       round(approx_percentile(u.credits, 0.5), 2) AS median_credits_per_user_day,
       round(avg(u.messages), 1) AS avg_messages_per_user_day
FROM usage u
JOIN cohorts c ON u.email = c.email
WHERE u.credits > 0
GROUP BY 1, 2
ORDER BY 1, 2 DESC;`;

const DIFF_IN_DIFF_SQL = (db: string) => `WITH ${USAGE_CTE(db, 120)},
cells AS (
  SELECT c.cohort, CASE WHEN u.day < c.start_date THEN 'before' ELSE 'after' END AS period, avg(u.credits) AS avg_credits
  FROM usage u JOIN cohorts c ON u.email = c.email
  WHERE u.credits > 0
  GROUP BY 1, 2
)
SELECT
  max(CASE WHEN cohort = 'pilot' AND period = 'after' THEN avg_credits END)
    - max(CASE WHEN cohort = 'pilot' AND period = 'before' THEN avg_credits END) AS pilot_delta,
  max(CASE WHEN cohort = 'control' AND period = 'after' THEN avg_credits END)
    - max(CASE WHEN cohort = 'control' AND period = 'before' THEN avg_credits END) AS control_delta,
  (max(CASE WHEN cohort = 'pilot' AND period = 'after' THEN avg_credits END)
    - max(CASE WHEN cohort = 'pilot' AND period = 'before' THEN avg_credits END))
  - (max(CASE WHEN cohort = 'control' AND period = 'after' THEN avg_credits END)
    - max(CASE WHEN cohort = 'control' AND period = 'before' THEN avg_credits END)) AS did_credits_per_user_day
FROM cells;`;

const DAILY_SQL = (db: string) => `SELECT date(date_parse(dt, '%Y/%m/%d')) AS export_day,
       client_type,
       count(DISTINCT userid) AS users,
       round(sum(coalesce(try_cast(credits_used AS double), 0)), 2) AS credits,
       round(sum(coalesce(try_cast(overage_credits_used AS double), 0)), 2) AS overage_credits,
       sum(coalesce(try_cast(total_messages AS bigint), 0)) AS messages
FROM ${db}.kiro_user_report
WHERE dt >= date_format(current_date - interval '60' day, '%Y/%m/%d')
GROUP BY 1, 2
ORDER BY 1 DESC, 2;`;
