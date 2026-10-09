import { Annotations, Aws, CfnOutput, Duration, RemovalPolicy, Size, Stack } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { retentionDays } from '../util.js';
import type { OAuthEndpoints } from './auth.js';
import { ACL_KEY, PREFIX } from './data.js';

export const CONTAINER_NAME = 'kopt';
export const CONTAINER_PORT = 8080;
export const METRICS_NAMESPACE = 'KiroOptimizer';
/** Routes of `kopt serve` forwarded by the ALB when restrictPaths is on (ALB conditions take 5 values max). */
export const ALLOWED_PATHS = ['/mcp*', '/.well-known/*', '/telemetry*', '/healthz'];

export interface KoptServiceProps {
  prefix: string;
  vpc: ec2.IVpc;
  subnets: ec2.SubnetSelection;
  bucket: s3.IBucket;
  key: kms.IKey;
  oauth: OAuthEndpoints;
  oauthMetadataMode: 'self' | 'issuer';
  /**
   * Require the telemetry scope (instead of the MCP scope) on POST /telemetry, so developer machines can hold a
   * token that cannot query code. Sets KOPT_AUTH_TELEMETRY_SCOPES; needs `kopt serve --auth-telemetry-scopes`.
   */
  separateTelemetryScope: boolean;
  /** Keep the `[Repo]` EMF dimension (KOPT_EMF_REPO_DIMENSION=1): one metric series per repo and metric. */
  repoMetricDimension: boolean;
  /** Sync s3://<bucket>/config/repos-acl.json to the task and enforce it (group -> repos). */
  reposAcl: boolean;
  /** Repository root holding the Dockerfile (used when imageUri is not set). */
  repoRoot: string;
  imageUri?: string;
  serveCommand: string[];
  taskCpu: number;
  taskMemoryMiB: number;
  ephemeralStorageGiB: number;
  desiredCount: number;
  minTasks: number;
  maxTasks: number;
  cpuTargetPercent: number;
  syncIntervalSec: number;
  syncInitialTimeoutSec: number;
  certificateArn?: string;
  domainName?: string;
  hostedZone?: { id: string; name: string };
  internetFacing: boolean;
  allowedCidrs: string[];
  restrictPaths: boolean;
  stickySessions: boolean;
  enableExecuteCommand: boolean;
  logRetentionDays: number;
  containerInsights: boolean;
  retainLogs: boolean;
}

/**
 * Query tier: ECS Fargate (ARM64) running `kopt serve` behind an ALB. Snapshots are pulled from S3 by the
 * container entrypoint (docker/entrypoint.sh); tokens are validated by the server against Cognito's JWKS.
 */
export class KoptService extends Construct {
  readonly alb: elbv2.ApplicationLoadBalancer;
  readonly listener: elbv2.ApplicationListener;
  readonly targetGroup: elbv2.ApplicationTargetGroup;
  readonly service: ecs.FargateService;
  readonly cluster: ecs.Cluster;
  readonly logGroup: logs.LogGroup;
  /** Base URL developers use (`https://kopt.example.com`). */
  readonly publicUrl: string;
  /** MCP endpoint (`<publicUrl>/mcp`) that goes into Kiro's mcp.json. */
  readonly mcpUrl: string;
  readonly sessionSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: KoptServiceProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const https = !!props.certificateArn;
    const listenerPort = https ? 443 : 80;

    // ---------------------------------------------------------------- load balancer
    const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc: props.vpc,
      description: 'kopt ALB: listener ingress from allowed CIDRs only',
      allowAllOutbound: false,
    });
    const cidrs = props.allowedCidrs.length ? props.allowedCidrs : [props.internetFacing ? '0.0.0.0/0' : props.vpc.vpcCidrBlock];
    for (const cidr of cidrs) {
      albSg.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(listenerPort), `kopt ${https ? 'HTTPS' : 'HTTP'} from ${cidr}`);
      if (https) albSg.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(80), `HTTP->HTTPS redirect from ${cidr}`);
    }
    if (!props.allowedCidrs.length && !props.internetFacing) {
      Annotations.of(this).addWarning('allowedCidrs not set: the internal ALB only accepts the VPC CIDR. Add your VPN / Direct Connect ranges.');
    }

    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: props.vpc,
      internetFacing: props.internetFacing,
      securityGroup: albSg,
      vpcSubnets: props.internetFacing ? { subnetType: ec2.SubnetType.PUBLIC } : props.subnets,
      // MCP Streamable HTTP may hold an SSE response open while a tool runs.
      idleTimeout: Duration.seconds(120),
      dropInvalidHeaderFields: true,
      http2Enabled: true,
    });

    const host = props.domainName ?? this.alb.loadBalancerDnsName;
    this.publicUrl = `${https ? 'https' : 'http'}://${host}`;
    this.mcpUrl = `${this.publicUrl}/mcp`;
    if (!https) {
      Annotations.of(this).addWarning(
        'No certificateArn: HTTP-only listener. Kiro only accepts https:// for non-localhost MCP servers; ' +
        'use this mode for smoke tests (curl, SSH tunnel to localhost) or behind a TLS-terminating proxy.',
      );
    } else if (!props.domainName) {
      Annotations.of(this).addWarning('certificateArn without domainName: the certificate will not match the ALB DNS name.');
    }

    // ---------------------------------------------------------------- cluster + task
    this.cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: props.vpc,
      containerInsightsV2: props.containerInsights ? ecs.ContainerInsights.ENABLED : ecs.ContainerInsights.DISABLED,
    });

    this.logGroup = new logs.LogGroup(this, 'Logs', {
      retention: retentionDays(props.logRetentionDays),
      encryptionKey: props.key,
      removalPolicy: props.retainLogs ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    const taskDef = new ecs.FargateTaskDefinition(this, 'Task', {
      cpu: props.taskCpu,
      memoryLimitMiB: props.taskMemoryMiB,
      ephemeralStorageGiB: props.ephemeralStorageGiB,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });

    // Least privilege: read snapshots only (no write, no other prefixes).
    taskDef.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'ReadSnapshots',
      actions: ['s3:GetObject'],
      resources: [props.bucket.arnForObjects(`${PREFIX.snapshots}*`)],
    }));
    taskDef.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'ListSnapshots',
      actions: ['s3:ListBucket'],
      resources: [props.bucket.bucketArn],
      conditions: { StringLike: { 's3:prefix': [PREFIX.snapshots, `${PREFIX.snapshots}*`] } },
    }));
    taskDef.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'DecryptSnapshots',
      actions: ['kms:Decrypt'],
      resources: [props.key.keyArn],
      conditions: { StringEquals: { 'kms:ViaService': `s3.${stack.region}.amazonaws.com` } },
    }));

    if (props.reposAcl) {
      taskDef.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
        sid: 'ReadReposAcl',
        actions: ['s3:GetObject'],
        resources: [props.bucket.arnForObjects(ACL_KEY)],
      }));
    }

    // Replicas sign MCP session ids with the same secret so any task can resume any session (no ALB affinity needed).
    // AWS-managed key on purpose: the CMK lives in the data stack and a cross-stack grant would make its key policy
    // reference this stack's execution role (dependency cycle); the value is an HMAC key, not customer data.
    this.sessionSecret = new secretsmanager.Secret(this, 'SessionSecret', {
      description: 'kopt serve: HMAC key for MCP session ids, shared by all tasks',
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
    });

    const o = props.oauth;
    // Names follow `kopt serve` options (src/cli.ts: --auth-issuer <-> KOPT_AUTH_ISSUER, ...).
    const environment: Record<string, string> = {
      KOPT_HOST: '0.0.0.0',
      KOPT_REPOS_DIR: '/data/repos',
      KOPT_DISABLE_RUN: '1',
      // OAuth 2.1 resource server (RFC 9728) backed by Cognito
      KOPT_RESOURCE_URL: this.publicUrl,
      KOPT_AUTH_ISSUER: o.issuer,
      KOPT_AUTH_JWKS: o.jwksUri,
      KOPT_AUTH_CLIENT_ID: o.clientId,
      KOPT_AUTH_SCOPES: o.mcpScope,
      KOPT_AUTH_METADATA: props.oauthMetadataMode,
      // Per-repo metric series cost money (about $0.30 per series and month); Repo stays a log property for Logs Insights.
      KOPT_EMF_REPO_DIMENSION: props.repoMetricDimension ? '1' : '0',
      // snapshot sync (docker/s3sync.mjs); its EMF lines share the server namespace
      KOPT_SNAPSHOT_BUCKET: props.bucket.bucketName,
      KOPT_SNAPSHOT_PREFIX: PREFIX.snapshots,
      KOPT_S3_REGION: stack.region,
      KOPT_METRICS_NAMESPACE: METRICS_NAMESPACE,
      SYNC_INTERVAL_SEC: String(props.syncIntervalSec),
      SYNC_INITIAL_TIMEOUT_SEC: String(props.syncInitialTimeoutSec),
    };
    if (props.separateTelemetryScope) environment.KOPT_AUTH_TELEMETRY_SCOPES = o.telemetryScope;
    if (props.reposAcl) {
      environment.KOPT_REPOS_ACL = '/data/repos-acl.json';
      environment.KOPT_ACL_KEY = ACL_KEY;
    }

    taskDef.addContainer(CONTAINER_NAME, {
      containerName: CONTAINER_NAME,
      image: this.image(props),
      command: props.serveCommand,
      environment,
      secrets: { KOPT_SESSION_SECRET: ecs.Secret.fromSecretsManager(this.sessionSecret) },
      portMappings: [{ containerPort: CONTAINER_PORT, name: 'http', appProtocol: ecs.AppProtocol.http }],
      logging: ecs.LogDrivers.awsLogs({
        logGroup: this.logGroup,
        streamPrefix: 'kopt',
        // Never block the server on CloudWatch Logs back-pressure.
        mode: ecs.AwsLogDriverMode.NON_BLOCKING,
        maxBufferSize: Size.mebibytes(25),
      }),
      healthCheck: {
        command: ['CMD-SHELL', `node -e "fetch('http://127.0.0.1:${CONTAINER_PORT}/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"`],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
        // ECS caps startPeriod at 300 s; the initial S3 sync is bounded below that (syncInitialTimeoutSec <= 270).
        startPeriod: Duration.seconds(Math.min(300, props.syncInitialTimeoutSec + 30)),
      },
      stopTimeout: Duration.seconds(30),
      linuxParameters: new ecs.LinuxParameters(this, 'Linux', { initProcessEnabled: true }),
    });

    // ---------------------------------------------------------------- service
    const serviceSg = new ec2.SecurityGroup(this, 'ServiceSg', {
      vpc: props.vpc,
      description: 'kopt tasks: ingress from the ALB only, egress HTTPS only (S3, Cognito JWKS, ECR, Logs)',
      allowAllOutbound: false,
    });
    serviceSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS egress');

    this.service = new ecs.FargateService(this, 'Service', {
      cluster: this.cluster,
      taskDefinition: taskDef,
      desiredCount: props.desiredCount,
      vpcSubnets: props.subnets,
      securityGroups: [serviceSg],
      assignPublicIp: false,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      circuitBreaker: { enable: true, rollback: true },
      healthCheckGracePeriod: Duration.seconds(props.syncInitialTimeoutSec + 120),
      enableExecuteCommand: props.enableExecuteCommand,
      platformVersion: ecs.FargatePlatformVersion.LATEST,
      propagateTags: ecs.PropagatedTagSource.SERVICE,
      availabilityZoneRebalancing: ecs.AvailabilityZoneRebalancing.ENABLED,
    });

    this.targetGroup = new elbv2.ApplicationTargetGroup(this, 'Targets', {
      vpc: props.vpc,
      port: CONTAINER_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      targets: [this.service.loadBalancerTarget({ containerName: CONTAINER_NAME, containerPort: CONTAINER_PORT })],
      healthCheck: {
        path: '/healthz',
        healthyHttpCodes: '200',
        interval: Duration.seconds(15),
        timeout: Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      deregistrationDelay: Duration.seconds(30),
      loadBalancingAlgorithmType: elbv2.TargetGroupLoadBalancingAlgorithmType.LEAST_OUTSTANDING_REQUESTS,
      // Best effort only: MCP clients rarely keep cookies, so the server must not depend on task affinity.
      stickinessCookieDuration: props.stickySessions ? Duration.hours(1) : undefined,
    });

    const forward = elbv2.ListenerAction.forward([this.targetGroup]);
    const defaultAction = props.restrictPaths
      ? elbv2.ListenerAction.fixedResponse(404, { contentType: 'text/plain', messageBody: 'not found' })
      : forward;
    if (https) {
      this.listener = this.alb.addListener('Https', {
        port: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificates: [elbv2.ListenerCertificate.fromArn(props.certificateArn!)],
        sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
        open: false,
        defaultAction,
      });
      this.alb.addListener('HttpRedirect', {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        open: false,
        defaultAction: elbv2.ListenerAction.redirect({ protocol: 'HTTPS', port: '443', permanent: true }),
      });
    } else {
      this.listener = this.alb.addListener('Http', { port: 80, protocol: elbv2.ApplicationProtocol.HTTP, open: false, defaultAction });
    }
    if (props.restrictPaths) {
      this.listener.addAction('Kopt', {
        priority: 10,
        conditions: [elbv2.ListenerCondition.pathPatterns(ALLOWED_PATHS)],
        action: forward,
      });
    }

    const scaling = this.service.autoScaleTaskCount({ minCapacity: props.minTasks, maxCapacity: props.maxTasks });
    scaling.scaleOnCpuUtilization('Cpu', {
      targetUtilizationPercent: props.cpuTargetPercent,
      scaleInCooldown: Duration.minutes(5),
      scaleOutCooldown: Duration.minutes(1),
    });

    if (props.hostedZone && props.domainName) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
        hostedZoneId: props.hostedZone.id,
        zoneName: props.hostedZone.name,
      });
      new route53.ARecord(this, 'Alias', {
        zone,
        recordName: props.domainName,
        target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(this.alb)),
      });
    }

    new CfnOutput(this, 'McpUrl', { value: this.mcpUrl, description: 'Kiro mcp.json "url"' });
    new CfnOutput(this, 'TelemetryUrl', { value: `${this.publicUrl}/telemetry` });
    new CfnOutput(this, 'ProtectedResourceMetadataUrl', { value: `${this.publicUrl}/.well-known/oauth-protected-resource` });
    new CfnOutput(this, 'AlbDnsName', { value: this.alb.loadBalancerDnsName });
    new CfnOutput(this, 'ClusterName', { value: this.cluster.clusterName });
    new CfnOutput(this, 'ServiceName', { value: this.service.serviceName });
    new CfnOutput(this, 'LogGroupName', { value: this.logGroup.logGroupName });
  }

  private image(props: KoptServiceProps): ecs.ContainerImage {
    if (!props.imageUri) {
      // Built at deploy time by cdk-assets (docker buildx for linux/arm64) and pushed to the bootstrap ECR repo.
      return ecs.ContainerImage.fromAsset(props.repoRoot, { file: 'Dockerfile', platform: Platform.LINUX_ARM64 });
    }
    const m = /^(\d{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?\/([^:@]+)(?:[:@](.+))?$/.exec(props.imageUri);
    if (!m) return ecs.ContainerImage.fromRegistry(props.imageUri);
    const [, account, region, name, ref] = m;
    const repo = ecr.Repository.fromRepositoryAttributes(this, 'ImageRepo', {
      repositoryName: name,
      repositoryArn: `arn:${Aws.PARTITION}:ecr:${region}:${account}:repository/${name}`,
    });
    // fromEcrRepository also grants the execution role pull rights on that repository.
    return ecs.ContainerImage.fromEcrRepository(repo, ref ?? 'latest');
  }
}
