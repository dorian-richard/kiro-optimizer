import { App, Stack, Tags, type StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { loadSettings, type KoptSettings } from './config.js';
import { KoptAnalytics } from './constructs/analytics.js';
import { KoptAuth } from './constructs/auth.js';
import { KoptData } from './constructs/data.js';
import { KoptIndexer } from './constructs/indexer.js';
import { KoptNetwork } from './constructs/network.js';
import { KoptObservability } from './constructs/observability.js';
import { KoptService } from './constructs/service.js';
import { loadRepos, type RepoEntry } from './repos.js';

export interface KoptDataStackProps extends StackProps {
  settings: KoptSettings;
}

/** Stateful resources (retained by default): KMS key, S3 bucket, Cognito, Glue/Athena. */
export class KoptDataStack extends Stack {
  readonly data: KoptData;
  readonly auth: KoptAuth;
  readonly analytics: KoptAnalytics;

  constructor(scope: Construct, id: string, props: KoptDataStackProps) {
    super(scope, id, props);
    const s = props.settings;
    this.data = new KoptData(this, 'KoptData', {
      prefix: s.stackPrefix,
      retainData: s.retainData,
      snapshotRetentionDays: s.snapshotRetentionDays,
      kiroUsageExport: s.kiroUsageExport,
      kiroUsageRegion: s.kiroUsageRegion,
      bucketName: s.bucketName,
    });
    this.auth = new KoptAuth(this, 'KoptAuth', {
      prefix: s.stackPrefix,
      retainData: s.retainData,
      featurePlan: s.cognitoFeaturePlan,
      domainPrefix: s.cognitoDomainPrefix,
      callbackPort: s.oauthCallbackPort,
      callbackHosts: s.oauthCallbackHosts,
      resourceServerId: s.resourceServerId,
      refreshTokenDays: s.refreshTokenDays,
      saml: s.samlMetadataUrl ? { metadataUrl: s.samlMetadataUrl, name: s.samlProviderName, emailAttribute: s.samlEmailAttribute } : undefined,
      oidc: s.oidcIssuerUrl
        ? { issuerUrl: s.oidcIssuerUrl, clientId: s.oidcClientId!, clientSecretName: s.oidcClientSecretName!, name: s.oidcProviderName }
        : undefined,
      disableCognitoLogin: s.disableCognitoLogin,
    });
    this.analytics = new KoptAnalytics(this, 'KoptAnalytics', {
      prefix: s.stackPrefix,
      bucket: this.data.bucket,
      key: this.data.key,
      retainData: s.retainData,
      kiroUsageExport: s.kiroUsageExport,
      kiroUsageRegion: s.kiroUsageRegion,
    });
  }
}

export interface KoptAppStackProps extends StackProps {
  settings: KoptSettings;
  repos: RepoEntry[];
  dataStack: KoptDataStack;
  repoRoot: string;
}

/** Stateless resources: network, query service, indexer, observability. Safe to destroy/recreate. */
export class KoptAppStack extends Stack {
  readonly network: KoptNetwork;
  readonly service: KoptService;
  readonly indexer: KoptIndexer;
  readonly observability: KoptObservability;
  private fixedAzs?: string[];

  constructor(scope: Construct, id: string, props: KoptAppStackProps) {
    super(scope, id, props);
    const s = props.settings;
    this.fixedAzs = s.availabilityZones.length ? s.availabilityZones : undefined;
    const { data, auth } = props.dataStack;

    this.network = new KoptNetwork(this, 'KoptNetwork', {
      vpcId: s.vpcId,
      cidr: s.vpcCidr,
      maxAzs: s.maxAzs,
      natGateways: s.natGateways,
      interfaceEndpoints: s.interfaceEndpoints,
    });

    this.service = new KoptService(this, 'KoptService', {
      prefix: s.stackPrefix,
      vpc: this.network.vpc,
      subnets: this.network.privateSubnets,
      bucket: data.bucket,
      key: data.key,
      oauth: auth.endpoints,
      oauthMetadataMode: s.oauthMetadataMode,
      separateTelemetryScope: s.separateTelemetryScope,
      repoMetricDimension: s.repoMetricDimension,
      reposAcl: s.reposAcl,
      repoRoot: props.repoRoot,
      imageUri: s.imageUri,
      serveCommand: s.serveCommand,
      taskCpu: s.taskCpu,
      taskMemoryMiB: s.taskMemoryMiB,
      ephemeralStorageGiB: s.ephemeralStorageGiB,
      desiredCount: s.desiredCount,
      minTasks: s.minTasks,
      maxTasks: s.maxTasks,
      cpuTargetPercent: s.cpuTargetPercent,
      syncIntervalSec: s.syncIntervalSec,
      syncInitialTimeoutSec: s.syncInitialTimeoutSec,
      certificateArn: s.certificateArn,
      domainName: s.domainName,
      hostedZone: s.hostedZoneId && s.hostedZoneName ? { id: s.hostedZoneId, name: s.hostedZoneName } : undefined,
      internetFacing: s.internetFacing,
      allowedCidrs: s.allowedCidrs,
      restrictPaths: s.restrictPaths,
      stickySessions: s.stickySessions,
      enableExecuteCommand: s.enableExecuteCommand,
      logRetentionDays: s.logRetentionDays,
      containerInsights: s.containerInsights,
      retainLogs: s.retainData,
    });

    this.indexer = new KoptIndexer(this, 'KoptIndexer', {
      prefix: s.stackPrefix,
      repos: props.repos,
      bucket: data.bucket,
      key: data.key,
      koptSource: s.koptSource,
      koptRef: s.koptRef,
      koptPackage: s.koptPackage,
      koptVersion: s.koptVersion,
      indexerCommand: s.indexerCommand,
      installCommand: s.indexerInstallCommand,
      codeArtifact: s.codeArtifactDomain ? { domain: s.codeArtifactDomain, repository: s.codeArtifactRepository! } : undefined,
      computeType: s.indexerComputeType,
      timeoutMinutes: s.indexerTimeoutMinutes,
      webhooks: s.webhooks,
      nightly: s.nightlyReindex ? { hourUtc: s.nightlyHourUtc } : undefined,
      logRetentionDays: s.logRetentionDays,
      vpc: s.indexerInVpc ? { vpc: this.network.vpc, subnets: this.network.privateSubnets } : undefined,
    });

    this.observability = new KoptObservability(this, 'KoptObservability', {
      prefix: s.stackPrefix,
      alb: this.service.alb,
      targetGroup: this.service.targetGroup,
      service: this.service.service,
      logGroup: this.service.logGroup,
      key: data.key,
      alarmEmail: s.alarmEmail,
      metricsSource: s.metricsSource,
      repoMetricDimension: s.repoMetricDimension,
      indexerProjectPrefix: props.repos.length ? this.indexer.projectNamePrefix : undefined,
      indexerLogGroup: this.indexer.logGroup,
    });
  }

  /** Fixed AZs when the account is concrete: the default getter would trigger a credentialed lookup at synth. */
  override get availabilityZones(): string[] {
    return this.fixedAzs ?? super.availabilityZones;
  }
}

export interface BuildOptions {
  /** Directory holding the Dockerfile (repo root). */
  repoRoot: string;
  /** Directory against which a relative `reposFile` is resolved (infra/). */
  infraDir: string;
  /** Override repos.json (tests). */
  repos?: RepoEntry[];
}

/** Instantiate both stacks on `app` from its context. */
export function buildKopt(app: App, opts: BuildOptions): { settings: KoptSettings; data: KoptDataStack; svc: KoptAppStack } {
  const settings = loadSettings(app.node);
  const repos = opts.repos ?? loadRepos(settings.reposFile, opts.infraDir);
  const env = { account: settings.account, region: settings.region };
  const p = settings.stackPrefix;

  const data = new KoptDataStack(app, `${p}-Data`, {
    env,
    settings,
    terminationProtection: settings.retainData,
    description: 'KiroOptimizer central deployment: KMS, S3 snapshots, Cognito, analytics (stateful)',
  });
  const svc = new KoptAppStack(app, `${p}-App`, {
    env,
    settings,
    repos,
    dataStack: data,
    repoRoot: opts.repoRoot,
    description: 'KiroOptimizer central deployment: VPC, ECS query service, CodeBuild indexers, observability',
  });
  svc.addStackDependency(data);
  for (const [k, v] of Object.entries(settings.tags)) Tags.of(app).add(k, v);
  return { settings, data, svc };
}
