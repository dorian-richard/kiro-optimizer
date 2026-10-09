import { readFileSync } from 'node:fs';
import { Aws, CfnOutput, Duration, Stack } from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import type * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { supportsWebhook, type RepoEntry } from '../repos.js';
import { retentionDays } from '../util.js';
import { PREFIX } from './data.js';

const BUILD_SCRIPT = readFileSync(new URL('../indexer/index-repo.sh', import.meta.url), 'utf8');

export interface KoptIndexerProps {
  prefix: string;
  repos: RepoEntry[];
  bucket: s3.IBucket;
  key: kms.IKey;
  /** npm git spec installed by default, e.g. `github:dorian-richard/kiro-optimizer`. */
  koptSource: string;
  /** Git ref of `koptSource` (branch, tag or commit). */
  koptRef: string;
  /** Registry package and version (CodeArtifact install). */
  koptPackage: string;
  koptVersion: string;
  /** Shell prefix that runs the kopt CLI (`$KOPT_CMD index --snapshot ... --repo ...`). */
  indexerCommand: string;
  /** Replaces the default install command (internal registry, S3 tarball...). */
  installCommand: string;
  codeArtifact?: { domain: string; repository: string };
  computeType: 'SMALL' | 'MEDIUM' | 'LARGE';
  timeoutMinutes: number;
  webhooks: boolean;
  nightly?: { hourUtc: number };
  logRetentionDays: number;
  vpc?: { vpc: ec2.IVpc; subnets: ec2.SubnetSelection };
}

/** CodeBuild project name for a repo; also used by observability for failure notifications. */
export function projectNameFor(prefix: string, repo: string): string {
  return `${prefix.toLowerCase()}-index-${repo.replace(/[^A-Za-z0-9_-]/g, '-')}`.slice(0, 150);
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

const NPM_GLOBAL = 'npm install -g --no-audit --no-fund';
const PACK_DIR = '/tmp/kopt-pkg';

/**
 * Install phase of every index build: puts `kopt` on the PATH. In order of precedence:
 * 1. `installCommand` verbatim (internal registry, `aws s3 cp s3://<bucket>/dist/... && npm i -g ...`);
 * 2. CodeArtifact: `aws codeartifact login`, then `npm install -g <koptPackage>@<koptVersion>`;
 * 3. default: build the package from the public GitHub repository at `koptRef`, then install it globally.
 *    `npm pack <git spec>` runs the package's `prepare` build with its dev dependencies; a direct
 *    `npm install -g <git spec>` does not (npm 10: the prepare step fails with `tsc: command not found`).
 * The CodeArtifact login is kept in front of a custom command. `origin` is recorded in latest.json.
 */
export function indexerInstall(p: Pick<KoptIndexerProps, 'koptSource' | 'koptRef' | 'koptPackage' | 'koptVersion' | 'installCommand' | 'codeArtifact'>): {
  commands: string[];
  origin: string;
} {
  const commands: string[] = [];
  if (p.codeArtifact) {
    commands.push(`aws codeartifact login --tool npm --domain ${p.codeArtifact.domain} --domain-owner ${Aws.ACCOUNT_ID} --repository ${p.codeArtifact.repository}`);
  }
  if (p.installCommand) {
    commands.push(p.installCommand);
    return { commands, origin: 'custom' };
  }
  if (p.codeArtifact) {
    commands.push(`${NPM_GLOBAL} "\${KOPT_PACKAGE}@\${KOPT_VERSION}"`);
    return { commands, origin: `${p.koptPackage}@${p.koptVersion}` };
  }
  commands.push(
    `rm -rf ${PACK_DIR} && mkdir -p ${PACK_DIR} && npm pack --silent --pack-destination ${PACK_DIR} "\${KOPT_SOURCE}#\${KOPT_REF}" && ${NPM_GLOBAL} ${PACK_DIR}/*.tgz`,
  );
  return { commands, origin: `${p.koptSource}#${p.koptRef}` };
}

/**
 * One CodeBuild project per repo (ARM, Node 22): push webhook (or CodeCommit rule) + nightly full rebuild.
 * Each project's role can only touch its own `repos/<repo>/` prefix.
 */
export class KoptIndexer extends Construct {
  readonly projects: codebuild.Project[] = [];
  readonly projectNamePrefix: string;
  readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: KoptIndexerProps) {
    super(scope, id);
    this.projectNamePrefix = `${props.prefix.toLowerCase()}-index-`;

    this.logGroup = new logs.LogGroup(this, 'Logs', {
      retention: retentionDays(props.logRetentionDays),
      encryptionKey: props.key,
    });

    const install = indexerInstall(props);

    props.repos.forEach((repo, i) => {
      const safeId = repo.name.replace(/[^A-Za-z0-9]/g, '');
      const id = `Repo${safeId || i}${i}`;
      const projectName = projectNameFor(props.prefix, repo.name);
      const webhook = (repo.webhook ?? props.webhooks) && supportsWebhook(repo.source.type);
      const isGit = repo.source.type !== 'S3';

      const project = new codebuild.Project(this, id, {
        projectName,
        description: `kopt index snapshot for ${repo.name}`,
        source: this.makeSource(`${id}Src`, repo, webhook),
        environment: {
          buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0,
          computeType: codebuild.ComputeType[repo.computeType ?? props.computeType],
          privileged: false,
        },
        environmentVariables: {
          REPO: { value: repo.name },
          BUCKET: { value: props.bucket.bucketName },
          SNAPSHOT_PREFIX: { value: PREFIX.snapshots.replace(/\/$/, '') },
          KOPT_SOURCE: { value: props.koptSource },
          KOPT_REF: { value: props.koptRef },
          KOPT_PACKAGE: { value: props.koptPackage },
          KOPT_VERSION: { value: props.koptVersion },
          KOPT_ORIGIN: { value: install.origin },
          KOPT_CMD: { value: props.indexerCommand },
          KOPT_FULL: { value: '0' },
          npm_config_update_notifier: { value: 'false' },
        },
        buildSpec: codebuild.BuildSpec.fromObject({
          version: '0.2',
          env: { shell: 'bash' },
          phases: {
            install: {
              'runtime-versions': { nodejs: 22 },
              commands: [
                // kopt needs node:sqlite unflagged (Node >= 22.13); fail fast with a clear message otherwise.
                `node -e "const [a,b]=process.versions.node.split('.').map(Number);if(a<22||(a===22&&b<13)){console.error('kopt needs Node >= 22.13, image has '+process.version);process.exit(1)}"`,
                ...install.commands,
              ],
            },
            build: { commands: [`(\n${BUILD_SCRIPT}\n)`] },
          },
          cache: { paths: ['/root/.npm/**/*'] },
        }),
        timeout: Duration.minutes(repo.timeoutMinutes ?? props.timeoutMinutes),
        queuedTimeout: Duration.hours(8),
        encryptionKey: props.key,
        logging: { cloudWatch: { logGroup: this.logGroup, prefix: repo.name } },
        cache: isGit
          ? codebuild.Cache.local(codebuild.LocalCacheMode.SOURCE, codebuild.LocalCacheMode.CUSTOM)
          : codebuild.Cache.local(codebuild.LocalCacheMode.CUSTOM),
        ...(props.vpc ? { vpc: props.vpc.vpc, subnetSelection: props.vpc.subnets } : {}),
      });

      this.grantRepoPrefix(project, repo.name, props);

      if (repo.source.type === 'CODECOMMIT') {
        const cc = this.node.findChild(`${id}Src`) as codecommit.IRepository;
        cc.onCommit(`${id}OnPush`, {
          branches: [repo.source.branch!],
          target: new targets.CodeBuildProject(project),
        });
      }

      if (props.nightly) {
        // Stagger repos 3 minutes apart so 50 projects do not hit the account build concurrency at once.
        const offset = i * 3;
        new events.Rule(this, `${id}Nightly`, {
          description: `kopt nightly full re-index of ${repo.name}`,
          schedule: events.Schedule.cron({ minute: String(offset % 60), hour: String((props.nightly.hourUtc + Math.floor(offset / 60)) % 24) }),
          targets: [new targets.CodeBuildProject(project, {
            event: events.RuleTargetInput.fromObject({
              environmentVariablesOverride: [{ name: 'KOPT_FULL', value: '1', type: 'PLAINTEXT' }],
            }),
          })],
        });
      }
      this.projects.push(project);
    });

    new CfnOutput(this, 'IndexerProjects', {
      value: props.repos.length ? `${this.projectNamePrefix}* (${props.repos.length} projects)` : 'none (infra/repos.json is empty)',
      description: `aws codebuild start-build --project-name ${this.projectNamePrefix}<repo>`,
    });
  }

  private makeSource(id: string, repo: RepoEntry, webhook: boolean): codebuild.ISource {
    const s = repo.source;
    const branch = s.branch ?? 'main';
    const filters = webhook
      ? [codebuild.FilterGroup.inEventOf(codebuild.EventAction.PUSH).andHeadRefIs(`^refs/heads/${escapeRegex(branch)}$`)]
      : undefined;
    // Shallow clone: the index only needs the working tree; the commit comes from CODEBUILD_RESOLVED_SOURCE_VERSION.
    const common = { branchOrRef: branch, cloneDepth: 1, fetchSubmodules: false, webhook, webhookFilters: filters };
    switch (s.type) {
      case 'GITHUB':
        return codebuild.Source.gitHub({ owner: s.owner!, repo: s.repo!, reportBuildStatus: false, ...common });
      case 'GITHUB_ENTERPRISE':
        return codebuild.Source.gitHubEnterprise({ httpsCloneUrl: s.location!, reportBuildStatus: false, ...common });
      case 'BITBUCKET':
        return codebuild.Source.bitBucket({ owner: s.owner!, repo: s.repo!, reportBuildStatus: false, ...common });
      case 'CODECOMMIT':
        return codebuild.Source.codeCommit({
          repository: codecommit.Repository.fromRepositoryName(this, id, s.repo!),
          branchOrRef: branch,
          cloneDepth: 1,
          fetchSubmodules: false,
        });
      case 'S3': {
        const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(s.location!)!;
        return codebuild.Source.s3({ bucket: s3.Bucket.fromBucketName(this, id, m[1]), path: m[2] });
      }
    }
  }

  private grantRepoPrefix(project: codebuild.Project, repo: string, props: KoptIndexerProps): void {
    const repoPrefix = `${PREFIX.snapshots}${repo}/`;
    const stack = Stack.of(this);
    project.addToRolePolicy(new iam.PolicyStatement({
      sid: 'SnapshotObjects',
      actions: ['s3:GetObject', 's3:PutObject', 's3:PutObjectTagging'],
      resources: [props.bucket.arnForObjects(`${repoPrefix}*`)],
    }));
    project.addToRolePolicy(new iam.PolicyStatement({
      sid: 'SnapshotList',
      actions: ['s3:ListBucket'],
      resources: [props.bucket.bucketArn],
      conditions: { StringLike: { 's3:prefix': [`${repoPrefix}*`] } },
    }));
    // Optional `aws s3 cp s3://<bucket>/dist/kopt-x.y.z.tgz` install path (no package registry needed).
    project.addToRolePolicy(new iam.PolicyStatement({
      sid: 'KoptDist',
      actions: ['s3:GetObject'],
      resources: [props.bucket.arnForObjects(`${PREFIX.dist}*`)],
    }));
    project.addToRolePolicy(new iam.PolicyStatement({
      sid: 'SnapshotKms',
      actions: ['kms:GenerateDataKey', 'kms:Decrypt'],
      resources: [props.key.keyArn],
      conditions: { StringEquals: { 'kms:ViaService': `s3.${stack.region}.amazonaws.com` } },
    }));
    if (props.codeArtifact) {
      const { domain, repository } = props.codeArtifact;
      const arn = (res: string) => `arn:${Aws.PARTITION}:codeartifact:${stack.region}:${stack.account}:${res}`;
      project.addToRolePolicy(new iam.PolicyStatement({
        sid: 'CodeArtifactToken',
        actions: ['codeartifact:GetAuthorizationToken'],
        resources: [arn(`domain/${domain}`)],
      }));
      project.addToRolePolicy(new iam.PolicyStatement({
        sid: 'CodeArtifactRead',
        actions: ['codeartifact:GetRepositoryEndpoint', 'codeartifact:ReadFromRepository'],
        resources: [arn(`repository/${domain}/${repository}`)],
      }));
      project.addToRolePolicy(new iam.PolicyStatement({
        sid: 'CodeArtifactBearer',
        actions: ['sts:GetServiceBearerToken'],
        resources: ['*'],
        conditions: { StringEquals: { 'sts:AWSServiceName': 'codeartifact.amazonaws.com' } },
      }));
    }
  }
}
