// Synthesis assertions for the two stacks (run: npm test, or npx tsx --test test/*.test.ts).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { App } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { buildKopt } from '../lib/stacks.js';
import { validateRepos, type RepoEntry } from '../lib/repos.js';

const INFRA = fileURLToPath(new URL('..', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CDK_CONTEXT = JSON.parse(readFileSync(join(INFRA, 'cdk.json'), 'utf8')).context as Record<string, unknown>;
const outdirs: string[] = [];
after(() => outdirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const REPOS: RepoEntry[] = validateRepos([
  { name: 'billing-api', source: { type: 'GITHUB', owner: 'acme', repo: 'billing-api', branch: 'main' } },
  { name: 'legacy.erp', source: { type: 'CODECOMMIT', repo: 'legacy-erp', branch: 'master' }, computeType: 'LARGE' },
  { name: 'docs', source: { type: 'S3', location: 's3://acme-src/docs.zip' } },
]);
// Prebuilt image: keeps most tests from staging the Docker build context.
const IMAGE = '123456789012.dkr.ecr.eu-central-1.amazonaws.com/kopt:0.1.0';

function synth(ctx: Record<string, unknown> = {}, repos: RepoEntry[] = REPOS) {
  const outdir = mkdtempSync(join(tmpdir(), 'kopt-cdk-'));
  outdirs.push(outdir);
  const app = new App({ outdir, context: { ...CDK_CONTEXT, imageUri: IMAGE, ...ctx } });
  const { data, svc } = buildKopt(app, { repoRoot: REPO_ROOT, infraDir: INFRA, repos });
  const assembly = app.synth();
  return { app, data, svc, assembly, dataT: Template.fromStack(data), svcT: Template.fromStack(svc) };
}

describe('defaults (internal ALB, no certificate)', () => {
  const { svc, svcT, dataT, assembly } = synth();

  it('creates an internal ALB with an HTTP listener restricted to the VPC CIDR and a warning', () => {
    svcT.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', { Scheme: 'internal' });
    svcT.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 1);
    svcT.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      Protocol: 'HTTP',
      DefaultActions: [Match.objectLike({ Type: 'fixed-response' })],
    });
    svcT.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: Match.stringLikeRegexp('kopt ALB'),
      SecurityGroupIngress: [Match.objectLike({ FromPort: 80, CidrIp: { 'Fn::GetAtt': [Match.anyValue(), 'CidrBlock'] } })],
    });
    Annotations.fromStack(svc).hasWarning('*', Match.stringLikeRegexp('HTTP-only listener'));
  });

  it('forwards only the kopt paths', () => {
    svcT.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Priority: 10,
      Conditions: [{ Field: 'path-pattern', PathPatternConfig: { Values: ['/mcp*', '/.well-known/*', '/telemetry*', '/healthz'] } }],
    });
  });

  it('runs kopt serve on ARM64 Fargate 2 vCPU / 8 GB with the OAuth + snapshot environment', () => {
    const td = Object.values(svcT.findResources('AWS::ECS::TaskDefinition'))[0] as any;
    assert.equal(td.Properties.Cpu, '2048');
    assert.equal(td.Properties.Memory, '8192');
    assert.deepEqual(td.Properties.RuntimePlatform, { CpuArchitecture: 'ARM64', OperatingSystemFamily: 'LINUX' });
    assert.deepEqual(td.Properties.EphemeralStorage, { SizeInGiB: 60 });
    const c = td.Properties.ContainerDefinitions[0];
    assert.deepEqual(c.Command, ['node', '--disable-warning=ExperimentalWarning', '/app/dist/cli.js', 'serve', '--port', '8080', '--repos-dir', '/data/repos']);
    assert.equal(c.LinuxParameters.InitProcessEnabled, true);
    const env = Object.fromEntries(c.Environment.map((e: any) => [e.Name, e.Value]));
    for (const k of ['KOPT_AUTH_ISSUER', 'KOPT_AUTH_CLIENT_ID', 'KOPT_AUTH_JWKS', 'KOPT_SNAPSHOT_BUCKET', 'KOPT_RESOURCE_URL']) {
      assert.ok(env[k], `${k} is set`);
    }
    assert.equal(env.KOPT_AUTH_SCOPES, 'kopt/mcp');
    assert.equal(env.KOPT_AUTH_METADATA, 'self');
    assert.equal(env.KOPT_HOST, '0.0.0.0');
    assert.equal(env.KOPT_DISABLE_RUN, '1');
    assert.equal(env.SYNC_INTERVAL_SEC, '300');
    assert.equal(env.KOPT_REPOS_ACL, undefined);
    assert.equal(env.KOPT_AUTH_TELEMETRY_SCOPES, undefined, 'telemetry scope split is opt-in');
    assert.equal(env.KOPT_EMF_REPO_DIMENSION, '0', 'no per-repo metric series by default');
    assert.match(JSON.stringify(env.KOPT_AUTH_ISSUER), /https:\/\/cognito-idp\.eu-central-1\.amazonaws\.com\//);
    assert.doesNotMatch(JSON.stringify(env.KOPT_RESOURCE_URL), /\/mcp/, 'resource = server base URL');
    assert.deepEqual(c.Secrets.map((x: any) => x.Name), ['KOPT_SESSION_SECRET']);
    assert.equal(c.Image['Fn::Join'] ? 'join' : typeof c.Image, 'join', 'ECR image reference');
  });

  it('keeps 2 tasks with circuit breaker and CPU autoscaling 2..6', () => {
    svcT.hasResourceProperties('AWS::ECS::Service', {
      DesiredCount: 2,
      LaunchType: 'FARGATE',
      DeploymentConfiguration: Match.objectLike({ DeploymentCircuitBreaker: { Enable: true, Rollback: true }, MinimumHealthyPercent: 100 }),
      NetworkConfiguration: { AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: 'DISABLED' }) },
    });
    svcT.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', { MinCapacity: 2, MaxCapacity: 6 });
    svcT.hasResourceProperties('AWS::ApplicationAutoScaling::ScalingPolicy', {
      TargetTrackingScalingPolicyConfiguration: Match.objectLike({
        TargetValue: 60,
        PredefinedMetricSpecification: { PredefinedMetricType: 'ECSServiceAverageCPUUtilization' },
      }),
    });
  });

  it('gives the task role read-only, prefix-scoped access to snapshots', () => {
    const policies = svcT.findResources('AWS::IAM::Policy');
    const task = Object.entries(policies).find(([id]) => id.includes('TaskTaskRole'))![1] as any;
    const stmts = task.Properties.PolicyDocument.Statement;
    const actions = stmts.flatMap((s: any) => [].concat(s.Action));
    assert.deepEqual(actions.sort(), ['kms:Decrypt', 's3:GetObject', 's3:ListBucket']);
    assert.match(JSON.stringify(stmts.find((s: any) => s.Action === 's3:GetObject').Resource), /\/repos\/\*/);
    assert.deepEqual(stmts.find((s: any) => s.Action === 'kms:Decrypt').Condition, { StringEquals: { 'kms:ViaService': 's3.eu-central-1.amazonaws.com' } });
  });

  it('creates one ARM CodeBuild project per repo with webhook, nightly full rebuild and per-repo IAM', () => {
    svcT.resourceCountIs('AWS::CodeBuild::Project', 3);
    svcT.hasResourceProperties('AWS::CodeBuild::Project', {
      Name: 'kopt-index-billing-api',
      Environment: Match.objectLike({ Type: 'ARM_CONTAINER', Image: 'aws/codebuild/amazonlinux-aarch64-standard:3.0', ComputeType: 'BUILD_GENERAL1_SMALL' }),
      Triggers: { Webhook: true, FilterGroups: [[{ Type: 'EVENT', Pattern: 'PUSH' }, { Type: 'HEAD_REF', Pattern: '^refs/heads/main$' }]] },
      Source: Match.objectLike({ Type: 'GITHUB', GitCloneDepth: 1 }),
    });
    svcT.hasResourceProperties('AWS::CodeBuild::Project', {
      Name: 'kopt-index-legacy-erp',
      Environment: Match.objectLike({ ComputeType: 'BUILD_GENERAL1_LARGE' }),
      Source: Match.objectLike({ Type: 'CODECOMMIT' }),
    });
    const bs = JSON.parse((Object.values(svcT.findResources('AWS::CodeBuild::Project'))[0] as any).Properties.Source.BuildSpec);
    assert.deepEqual(bs.phases.install['runtime-versions'], { nodejs: 22 });
    assert.match(bs.phases.build.commands[0], /\$KOPT_CMD index --root .* --snapshot/);
    // kopt is installed from the public GitHub repository by default, at the `main` ref.
    assert.equal(bs.phases.install.commands.length, 2);
    assert.equal(
      bs.phases.install.commands[1],
      'rm -rf /tmp/kopt-pkg && mkdir -p /tmp/kopt-pkg && npm pack --silent --pack-destination /tmp/kopt-pkg "${KOPT_SOURCE}#${KOPT_REF}" ' +
        '&& npm install -g --no-audit --no-fund /tmp/kopt-pkg/*.tgz',
    );
    const proj = (Object.values(svcT.findResources('AWS::CodeBuild::Project'))[0] as any).Properties;
    const cbEnv = Object.fromEntries(proj.Environment.EnvironmentVariables.map((e: any) => [e.Name, e.Value]));
    assert.equal(cbEnv.KOPT_SOURCE, 'github:dorian-richard/kiro-optimizer');
    assert.equal(cbEnv.KOPT_REF, 'main');
    assert.equal(cbEnv.KOPT_CMD, 'kopt');
    assert.equal(cbEnv.KOPT_ORIGIN, 'github:dorian-richard/kiro-optimizer#main');
    // nightly rules (one per repo, staggered) + CodeCommit push rule
    const rules = Object.values(svcT.findResources('AWS::Events::Rule')) as any[];
    const nightly = rules.filter((r) => r.Properties.ScheduleExpression);
    assert.equal(nightly.length, 3);
    assert.deepEqual(nightly.map((r) => r.Properties.ScheduleExpression).sort(), ['cron(0 1 * * ? *)', 'cron(3 1 * * ? *)', 'cron(6 1 * * ? *)']);
    assert.match(nightly[0].Properties.Targets[0].Input, /KOPT_FULL/);
    assert.ok(rules.some((r) => JSON.stringify(r.Properties.EventPattern ?? {}).includes('CodeCommit Repository State Change')));
    const policies = Object.entries(svcT.findResources('AWS::IAM::Policy')) as [string, any][];
    const billing = policies.find(([id]) => id.includes('Repobillingapi') && id.includes('RoleDefault'))![1];
    const obj = billing.Properties.PolicyDocument.Statement.find((s: any) => s.Sid === 'SnapshotObjects');
    assert.match(JSON.stringify(obj.Resource), /\/repos\/billing-api\/\*/);
  });

  it('wires alarms, the dashboard and the encrypted SNS topic', () => {
    svcT.resourceCountIs('AWS::CloudWatch::Alarm', 5);
    svcT.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
    svcT.resourceCountIs('AWS::Logs::QueryDefinition', 3);
    svcT.resourceCountIs('AWS::Logs::MetricFilter', 0);
    svcT.hasResourceProperties('AWS::SNS::Topic', { KmsMasterKeyId: Match.anyValue() });
    svcT.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: Match.objectLike({ source: ['aws.codebuild'], detail: Match.objectLike({ 'project-name': [{ prefix: 'kopt-index-' }] }) }),
    });
    const body = JSON.stringify((Object.values(svcT.findResources('AWS::CloudWatch::Dashboard'))[0] as any).Properties.DashboardBody);
    for (const w of ['Calls by tool', 'TokensOut by tool', 'BaselineTokens vs TokensOut', 'Exact savings by tool', 'Kiro credits per day', 'Hook blocks']) assert.ok(body.includes(w), w);
    assert.ok(body.includes('TokensOut by repo (Logs Insights)'), 'per-repo view from the logs by default');
    assert.ok(!body.includes('KiroOptimizer,Repo'), 'no [Repo] metric search by default');
    assert.match(body, /Kind = .{0,8}hook.{0,12} and Decision = .{0,8}block/, 'hook blocks come from the Decision property');
    assert.ok(body.includes('KiroOptimizer'));
  });

  it('encrypts and locks down the snapshot bucket', () => {
    dataT.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
      Properties: Match.objectLike({
        BucketEncryption: { ServerSideEncryptionConfiguration: [{ BucketKeyEnabled: true, ServerSideEncryptionByDefault: Match.objectLike({ SSEAlgorithm: 'aws:kms' }) }] },
        VersioningConfiguration: { Status: 'Enabled' },
        PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
        LifecycleConfiguration: { Rules: Match.arrayWith([Match.objectLike({ Prefix: 'repos/', TagFilters: [{ Key: 'kopt-latest', Value: 'false' }], ExpirationInDays: 30 })]) },
      }),
    });
    dataT.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } })]) },
    });
    dataT.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
  });

  it('creates a public PKCE client for Kiro with the kopt scopes', () => {
    dataT.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
      AllowedOAuthFlows: ['code'],
      AllowedOAuthFlowsUserPoolClient: true,
      CallbackURLs: ['http://localhost:33418/oauth/callback'],
      SupportedIdentityProviders: ['COGNITO'],
      ExplicitAuthFlows: ['ALLOW_REFRESH_TOKEN_AUTH'],
    });
    dataT.hasResourceProperties('AWS::Cognito::UserPoolResourceServer', {
      Identifier: 'kopt',
      Scopes: [{ ScopeName: 'mcp', ScopeDescription: Match.anyValue() }, { ScopeName: 'telemetry', ScopeDescription: Match.anyValue() }],
    });
    dataT.hasResourceProperties('AWS::Cognito::UserPool', { AdminCreateUserConfig: { AllowAdminCreateUserOnly: true } });
    dataT.resourceCountIs('AWS::Cognito::UserPoolDomain', 1);
  });

  it('defines the Kiro usage Glue table, cohorts and Athena queries', () => {
    dataT.resourceCountIs('AWS::Glue::Table', 2);
    dataT.resourceCountIs('AWS::Athena::NamedQuery', 3);
    dataT.hasResourceProperties('AWS::Glue::Table', {
      TableInput: Match.objectLike({
        Name: 'kiro_user_report',
        PartitionKeys: [{ Name: 'dt', Type: 'string' }],
        Parameters: Match.objectLike({ 'projection.enabled': 'true', 'projection.dt.format': 'yyyy/MM/dd' }),
      }),
    });
    dataT.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Principal: { Service: 'q.amazonaws.com' }, Action: 's3:PutObject' })]) },
    });
  });

  it('needs no context lookups', () => {
    assert.equal((assembly.manifest as any).missing, undefined);
  });

  it('uses neutral names in tags and package metadata', () => {
    const pkg = JSON.parse(readFileSync(join(INFRA, 'package.json'), 'utf8'));
    assert.equal(pkg.name, 'kiro-optimizer-infra');
    assert.equal(pkg.license, 'MIT');
    const bucket = Object.values((dataT.toJSON() as any).Resources).find((r: any) => r.Type === 'AWS::S3::Bucket') as any;
    assert.deepEqual(bucket.Properties.Tags, [
      { Key: 'ManagedBy', Value: 'cdk' },
      { Key: 'Project', Value: 'KiroOptimizer' },
    ]);
  });
});

describe('HTTPS with domain, hosted zone and an explicit account', () => {
  const { svcT, assembly } = synth({
    account: '123456789012',
    certificateArn: 'arn:aws:acm:eu-central-1:123456789012:certificate/abc',
    domainName: 'kopt.example.internal',
    hostedZoneId: 'Z123456ABCDEFG',
    hostedZoneName: 'example.internal',
    allowedCidrs: '10.0.0.0/8,172.16.0.0/12',
    alarmEmail: 'ops@example.com',
  });

  it('serves HTTPS (TLS 1.3 policy) and redirects HTTP', () => {
    svcT.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443,
      Protocol: 'HTTPS',
      SslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06',
      Certificates: [{ CertificateArn: 'arn:aws:acm:eu-central-1:123456789012:certificate/abc' }],
    });
    svcT.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      DefaultActions: [Match.objectLike({ Type: 'redirect', RedirectConfig: Match.objectLike({ Protocol: 'HTTPS', Port: '443' }) })],
    });
    svcT.hasResourceProperties('AWS::EC2::SecurityGroup', {
      SecurityGroupIngress: Match.arrayWith([Match.objectLike({ CidrIp: '172.16.0.0/12', FromPort: 443 })]),
    });
  });

  it('publishes the https resource URL and a DNS alias', () => {
    svcT.hasResourceProperties('AWS::Route53::RecordSet', { Name: 'kopt.example.internal.', Type: 'A' });
    const td = Object.values(svcT.findResources('AWS::ECS::TaskDefinition'))[0] as any;
    const env = Object.fromEntries(td.Properties.ContainerDefinitions[0].Environment.map((e: any) => [e.Name, e.Value]));
    assert.equal(env.KOPT_RESOURCE_URL, 'https://kopt.example.internal');
    svcT.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'ops@example.com' });
  });

  it('uses fixed AZs instead of a credentialed lookup', () => {
    assert.equal((assembly.manifest as any).missing, undefined);
    svcT.hasResourceProperties('AWS::EC2::Subnet', { AvailabilityZone: 'eu-central-1a' });
    svcT.hasResourceProperties('AWS::EC2::Subnet', { AvailabilityZone: 'eu-central-1b' });
  });
});

describe('options', () => {
  it('builds the image from the repo Dockerfile by default (linux/arm64 asset)', () => {
    const { assembly } = synth({ imageUri: '' }, []);
    const assets = JSON.parse(readFileSync(join(assembly.directory, 'Kopt-App.assets.json'), 'utf8'));
    const images = Object.values(assets.dockerImages ?? {}) as any[];
    assert.equal(images.length, 1);
    assert.equal(images[0].source.platform, 'linux/arm64');
    assert.equal(images[0].source.dockerFile, 'Dockerfile');
  });

  it('metricsSource=filters adds Logs metric filters with the same names', () => {
    const { svcT } = synth({ metricsSource: 'filters' }, []);
    svcT.resourceCountIs('AWS::Logs::MetricFilter', 6);
    svcT.hasResourceProperties('AWS::Logs::MetricFilter', {
      FilterPattern: Match.stringLikeRegexp('\\$\\.Calls'),
      MetricTransformations: [Match.objectLike({ MetricNamespace: 'KiroOptimizer', MetricName: 'Calls', Dimensions: [{ Key: 'Tool', Value: '$.Tool' }] })],
    });
  });

  it('federates a SAML IdP and can hide the Cognito login', () => {
    const { dataT } = synth({ samlMetadataUrl: 'https://portal.sso.eu-central-1.amazonaws.com/saml/metadata/abc', samlProviderName: 'IdentityCenter', disableCognitoLogin: true }, []);
    dataT.hasResourceProperties('AWS::Cognito::UserPoolIdentityProvider', { ProviderType: 'SAML', ProviderName: 'IdentityCenter' });
    // provider referenced by Ref (ordering dependency on the IdP); no native Cognito login left
    dataT.hasResourceProperties('AWS::Cognito::UserPoolClient', { SupportedIdentityProviders: [{ Ref: Match.stringLikeRegexp('Saml') }] });
  });

  it('kiroUsageExport=false drops the export policy and its queries', () => {
    const { dataT } = synth({ kiroUsageExport: false }, []);
    dataT.resourceCountIs('AWS::Glue::Table', 1);
    dataT.resourceCountIs('AWS::Athena::NamedQuery', 0);
    assert.ok(!JSON.stringify(dataT.toJSON()).includes('q.amazonaws.com'));
  });

  it('allows 127.0.0.1 callbacks and a custom port when asked', () => {
    const { dataT } = synth({ oauthCallbackHosts: 'localhost,127.0.0.1', oauthCallbackPort: '40000' }, []);
    dataT.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      CallbackURLs: ['http://localhost:40000/oauth/callback', 'http://127.0.0.1:40000/oauth/callback'],
    });
  });

  it('reposAcl syncs the ACL object and lets the task read only that key', () => {
    const { svcT } = synth({ reposAcl: true }, []);
    const td = Object.values(svcT.findResources('AWS::ECS::TaskDefinition'))[0] as any;
    const env = Object.fromEntries(td.Properties.ContainerDefinitions[0].Environment.map((e: any) => [e.Name, e.Value]));
    assert.equal(env.KOPT_REPOS_ACL, '/data/repos-acl.json');
    assert.equal(env.KOPT_ACL_KEY, 'config/repos-acl.json');
    const task = Object.entries(svcT.findResources('AWS::IAM::Policy')).find(([id]) => id.includes('TaskTaskRole'))![1] as any;
    const acl = task.Properties.PolicyDocument.Statement.find((x: any) => x.Sid === 'ReadReposAcl');
    assert.match(JSON.stringify(acl.Resource), /\/config\/repos-acl\.json"/);
  });

  it('pins the kopt ref, or installs from CodeArtifact, or runs a custom install command', () => {
    const buildspec = (ctx: Record<string, unknown>) => {
      const { svcT } = synth(ctx, REPOS.slice(0, 1));
      const p = (Object.values(svcT.findResources('AWS::CodeBuild::Project'))[0] as any).Properties;
      const env = Object.fromEntries(p.Environment.EnvironmentVariables.map((e: any) => [e.Name, e.Value]));
      // A buildspec holding a token (the CodeArtifact login uses AWS::AccountId) is an Fn::Join.
      const raw = p.Source.BuildSpec;
      const text = typeof raw === 'string' ? raw : raw['Fn::Join'][1].map((x: unknown) => (typeof x === 'string' ? x : '<token>')).join(raw['Fn::Join'][0]);
      return { cmds: JSON.parse(text).phases.install.commands.slice(1) as string[], env, svcT };
    };

    const pinned = buildspec({ koptRef: 'v0.2.0' });
    assert.equal(pinned.env.KOPT_REF, 'v0.2.0');
    assert.equal(pinned.env.KOPT_ORIGIN, 'github:dorian-richard/kiro-optimizer#v0.2.0');

    const ca = buildspec({ codeArtifactDomain: 'tools', codeArtifactRepository: 'npm-internal', koptVersion: '0.3.1' });
    assert.equal(ca.cmds.length, 2);
    assert.equal(ca.cmds[0], 'aws codeartifact login --tool npm --domain tools --domain-owner <token> --repository npm-internal');
    assert.equal(ca.cmds[1], 'npm install -g --no-audit --no-fund "${KOPT_PACKAGE}@${KOPT_VERSION}"');
    assert.equal(ca.env.KOPT_PACKAGE, 'kiro-optimizer');
    assert.equal(ca.env.KOPT_ORIGIN, 'kiro-optimizer@0.3.1');
    const policy = JSON.stringify(ca.svcT.findResources('AWS::IAM::Policy'));
    assert.match(policy, /codeartifact:GetAuthorizationToken/);

    const tarball = 'aws s3 cp s3://my-bucket/dist/kiro-optimizer-0.1.0.tgz /tmp/ && npm i -g /tmp/kiro-optimizer-0.1.0.tgz';
    const custom = buildspec({ indexerInstallCommand: tarball });
    assert.deepEqual(custom.cmds, [tarball]);
    assert.equal(custom.env.KOPT_ORIGIN, 'custom');
    assert.equal(custom.env.KOPT_CMD, 'kopt');
  });

  it('separateTelemetryScope requires kopt/telemetry on /telemetry (server env)', () => {
    const { svcT } = synth({ separateTelemetryScope: true }, []);
    const td = Object.values(svcT.findResources('AWS::ECS::TaskDefinition'))[0] as any;
    const env = Object.fromEntries(td.Properties.ContainerDefinitions[0].Environment.map((e: any) => [e.Name, e.Value]));
    assert.equal(env.KOPT_AUTH_SCOPES, 'kopt/mcp');
    assert.equal(env.KOPT_AUTH_TELEMETRY_SCOPES, 'kopt/telemetry');
  });

  it('repoMetricDimension=true keeps the [Repo] metric dimension and charts it', () => {
    const { svcT } = synth({ repoMetricDimension: true }, []);
    const td = Object.values(svcT.findResources('AWS::ECS::TaskDefinition'))[0] as any;
    const env = Object.fromEntries(td.Properties.ContainerDefinitions[0].Environment.map((e: any) => [e.Name, e.Value]));
    assert.equal(env.KOPT_EMF_REPO_DIMENSION, '1');
    const body = JSON.stringify((Object.values(svcT.findResources('AWS::CloudWatch::Dashboard'))[0] as any).Properties.DashboardBody);
    assert.ok(body.includes('KiroOptimizer,Repo'));
    assert.ok(!body.includes('TokensOut by repo (Logs Insights)'));
  });

  it('natGateways=0 uses isolated subnets with ECR/Logs endpoints', () => {
    const { svcT } = synth({ natGateways: 0 }, []);
    svcT.resourceCountIs('AWS::EC2::NatGateway', 0);
    svcT.resourceCountIs('AWS::EC2::VPCEndpoint', 4);
  });
});

describe('validation', () => {
  const bad = (ctx: Record<string, unknown>, re: RegExp) => assert.throws(() => synth(ctx, []), re);

  it('rejects unsafe or inconsistent context', () => {
    bad({ internetFacing: true }, /requires an explicit allowedCidrs/);
    bad({ allowedCidrs: '10.0.0.0/33x' }, /invalid CIDR/);
    bad({ oauthCallbackHosts: 'example.com' }, /only localhost/);
    bad({ vpcId: 'vpc-123' }, /requires context "account"/);
    bad({ minTasks: 5, maxTasks: 2 }, /minTasks must be <= maxTasks/);
    bad({ cognitoDomainPrefix: 'my-aws-login' }, /must not contain aws/);
    bad({ hostedZoneId: 'Z1' }, /must be set together/);
    bad({ disableCognitoLogin: true }, /requires a federated IdP/);
    bad({ koptRef: 'main; curl evil' }, /koptRef: invalid git ref/);
    bad({ koptRef: '../x' }, /koptRef: invalid git ref/);
    bad({ koptSource: 'github:a/b"; rm -rf /' }, /koptSource: invalid/);
    bad({ koptPackage: 'Bad Name' }, /koptPackage: invalid/);
  });

  it('rejects invalid repos.json entries', () => {
    assert.throws(() => validateRepos([{ name: '../x', source: { type: 'GITHUB', owner: 'o', repo: 'r' } }]), /invalid name/);
    assert.throws(() => validateRepos([{ name: 'a', source: { type: 'GITLAB' } }]), /source.type/);
    assert.throws(() => validateRepos([{ name: 'a', source: { type: 'GITHUB', owner: 'o' } }]), /source.repo is required/);
    assert.throws(() => validateRepos([
      { name: 'A', source: { type: 'CODECOMMIT', repo: 'a' } },
      { name: 'a', source: { type: 'CODECOMMIT', repo: 'b' } },
    ]), /duplicate/);
    assert.equal(validateRepos([{ name: 'x', source: { type: 'CODECOMMIT', repo: 'x' } }])[0].source.branch, 'main');
  });
});
