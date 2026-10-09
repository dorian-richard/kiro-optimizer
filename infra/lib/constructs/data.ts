import { Aws, CfnOutput, Duration, Fn, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/** S3 layout shared by the indexer, the query service, analytics and docs. */
export const PREFIX = {
  snapshots: 'repos/',
  kiroUsage: 'kiro-usage/',
  cohorts: 'cohorts/',
  athenaResults: 'athena-results/',
  dist: 'dist/',
  config: 'config/',
} as const;

/** Group -> repos ACL read by the server (KOPT_REPOS_ACL), synced from S3 when `reposAcl` is on. */
export const ACL_KEY = `${PREFIX.config}repos-acl.json`;

/** Object tag maintained by the indexer: lifecycle expires snapshots that are no longer the latest. */
export const LATEST_TAG = 'kopt-latest';

export interface KoptDataProps {
  prefix: string;
  retainData: boolean;
  snapshotRetentionDays: number;
  /** Allow Kiro's daily user-activity CSV export (service principal q.amazonaws.com) to write kiro-usage/. */
  kiroUsageExport: boolean;
  /** Region of the Kiro profile (the export is written from there). Defaults to the stack region. */
  kiroUsageRegion?: string;
  /** Default `<prefix>-<account>-<region>` (lower case). */
  bucketName?: string;
}

/**
 * Customer-managed KMS key + the snapshot/analytics bucket. Source code snapshots (index + gzip blobs)
 * never leave the client account.
 */
export class KoptData extends Construct {
  readonly key: kms.Key;
  readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: KoptDataProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const removalPolicy = props.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    this.key = new kms.Key(this, 'Key', {
      alias: `alias/${props.prefix.toLowerCase()}`,
      description: 'KiroOptimizer: snapshots, logs, analytics and notifications',
      enableKeyRotation: true,
      removalPolicy,
    });

    // CloudWatch Logs encrypts the service/indexer log groups with this key.
    this.key.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowCloudWatchLogs',
      principals: [new iam.ServicePrincipal(`logs.${stack.region}.amazonaws.com`)],
      actions: ['kms:Encrypt*', 'kms:Decrypt*', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:Describe*'],
      resources: ['*'],
      conditions: { ArnLike: { 'kms:EncryptionContext:aws:logs:arn': `arn:${Aws.PARTITION}:logs:${stack.region}:${stack.account}:log-group:*` } },
    }));
    // CloudWatch alarms publish to the KMS-encrypted SNS topic (the EventBridge grant is added by the rule target).
    this.key.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowAlarmPublishing',
      principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
      actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
      resources: ['*'],
    }));

    // Explicit name: the key policy can reference the bucket ARN without a Ref (key <-> bucket cycle).
    const bucketName = props.bucketName ?? Fn.join('-', [props.prefix.toLowerCase(), Aws.ACCOUNT_ID, Aws.REGION]);
    const bucketArn = `arn:${Aws.PARTITION}:s3:::${bucketName}`;
    this.bucket = new s3.Bucket(this, 'Bucket', {
      bucketName,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.key,
      bucketKeyEnabled: true,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy,
      lifecycleRules: [
        {
          // The indexer tags the snapshot it publishes kopt-latest=true and flips the previous one to false.
          id: 'expire-superseded-snapshots',
          prefix: PREFIX.snapshots,
          tagFilters: { [LATEST_TAG]: 'false' },
          expiration: Duration.days(props.snapshotRetentionDays),
        },
        {
          id: 'expire-noncurrent-versions',
          noncurrentVersionExpiration: Duration.days(props.snapshotRetentionDays),
          expiredObjectDeleteMarker: true,
          abortIncompleteMultipartUploadAfter: Duration.days(7),
        },
        { id: 'expire-athena-results', prefix: PREFIX.athenaResults, expiration: Duration.days(30) },
      ],
    });

    if (props.kiroUsageExport) {
      const kiroRegion = props.kiroUsageRegion ?? stack.region;
      // Bucket policy documented by Kiro for the user-activity CSV export.
      this.bucket.addToResourcePolicy(new iam.PolicyStatement({
        sid: 'KiroLogsWrite',
        principals: [new iam.ServicePrincipal('q.amazonaws.com')],
        actions: ['s3:PutObject'],
        resources: [this.bucket.arnForObjects(`${PREFIX.kiroUsage}*`)],
        conditions: {
          StringEquals: { 'aws:SourceAccount': stack.account },
          ArnLike: { 'aws:SourceArn': `arn:${Aws.PARTITION}:codewhisperer:${kiroRegion}:${stack.account}:*` },
        },
      }));
      // SSE-KMS default encryption: the exporting service needs a data key, only for this bucket.
      this.key.addToResourcePolicy(new iam.PolicyStatement({
        sid: 'AllowKiroUsageExport',
        principals: [new iam.ServicePrincipal('q.amazonaws.com')],
        actions: ['kms:GenerateDataKey*', 'kms:Decrypt'],
        resources: ['*'],
        conditions: {
          StringLike: { 'kms:EncryptionContext:aws:s3:arn': [bucketArn, `${bucketArn}/${PREFIX.kiroUsage}*`] },
        },
      }));
    }

    new CfnOutput(this, 'BucketName', { value: this.bucket.bucketName, description: 'Snapshots (repos/), Kiro usage export (kiro-usage/), cohorts (cohorts/)' });
    new CfnOutput(this, 'KmsKeyArn', { value: this.key.keyArn });
    if (props.kiroUsageExport) {
      new CfnOutput(this, 'KiroUsageExportUri', {
        value: `s3://${this.bucket.bucketName}/${PREFIX.kiroUsage}`,
        description: 'Kiro console > Settings > Kiro user activity reports > S3 location',
      });
    }
  }
}
