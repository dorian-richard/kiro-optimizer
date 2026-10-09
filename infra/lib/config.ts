// Typed view over CDK context (cdk.json "context" + `-c key=value`). Every key is documented in
// infra/README.md and docs/DEPLOYMENT.md; `-c` values arrive as strings, so parsing is lenient.

import type { Node } from 'constructs';

export type MetricsSource = 'emf' | 'filters';
export type OAuthMetadataMode = 'self' | 'issuer';
export type CognitoPlan = 'LITE' | 'ESSENTIALS' | 'PLUS';

export interface KoptSettings {
  /** Only from context: a concrete account enables lookups, which need credentials. */
  account?: string;
  region: string;
  /** Explicit AZs (default with a known account: <region>a, <region>b...; without: Fn::GetAZs). */
  availabilityZones: string[];
  bucketName?: string;
  stackPrefix: string;
  retainData: boolean;
  tags: Record<string, string>;

  // network
  vpcId?: string;
  vpcCidr: string;
  maxAzs: number;
  natGateways: number;
  interfaceEndpoints: boolean;

  // service
  imageUri?: string;
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
  hostedZoneId?: string;
  hostedZoneName?: string;
  internetFacing: boolean;
  allowedCidrs: string[];
  restrictPaths: boolean;
  stickySessions: boolean;
  serveCommand: string[];
  enableExecuteCommand: boolean;
  logRetentionDays: number;
  containerInsights: boolean;

  /** Emit the per-repo `[Repo]` metric dimension (one metric series per repo and metric: cost). */
  repoMetricDimension: boolean;

  // auth
  cognitoDomainPrefix?: string;
  cognitoFeaturePlan: CognitoPlan;
  oauthCallbackPort: number;
  oauthCallbackHosts: string[];
  resourceServerId: string;
  oauthMetadataMode: OAuthMetadataMode;
  /** `/telemetry` requires `<resourceServerId>/telemetry` instead of the MCP scope (needs server support). */
  separateTelemetryScope: boolean;
  reposAcl: boolean;
  refreshTokenDays: number;
  samlMetadataUrl?: string;
  samlProviderName: string;
  samlEmailAttribute: string;
  oidcIssuerUrl?: string;
  oidcClientId?: string;
  oidcClientSecretName?: string;
  oidcProviderName: string;
  disableCognitoLogin: boolean;

  // indexer
  reposFile: string;
  /** npm git spec installed by default (`npm install -g <koptSource>#<koptRef>`). */
  koptSource: string;
  /** Git ref (branch, tag or commit) of `koptSource`. */
  koptRef: string;
  /** Registry package and version, used with CodeArtifact. */
  koptPackage: string;
  koptVersion: string;
  /** Replaces the default install step when set (internal registry, S3 tarball...). */
  indexerInstallCommand: string;
  indexerCommand: string;
  codeArtifactDomain?: string;
  codeArtifactRepository?: string;
  indexerComputeType: 'SMALL' | 'MEDIUM' | 'LARGE';
  indexerTimeoutMinutes: number;
  indexerInVpc: boolean;
  webhooks: boolean;
  nightlyReindex: boolean;
  nightlyHourUtc: number;

  // data / analytics / observability
  snapshotRetentionDays: number;
  kiroUsageExport: boolean;
  kiroUsageRegion?: string;
  alarmEmail?: string;
  metricsSource: MetricsSource;
}

export const DEFAULT_SERVE_COMMAND = [
  'node', '--disable-warning=ExperimentalWarning', '/app/dist/cli.js', 'serve', '--port', '8080', '--repos-dir', '/data/repos',
];
/** Public repository the indexer installs kopt from by default (npm git dependency spec). */
export const DEFAULT_KOPT_SOURCE = 'github:dorian-richard/kiro-optimizer';
export const DEFAULT_KOPT_REF = 'main';
export const DEFAULT_KOPT_PACKAGE = 'kiro-optimizer';

type Ctx = (key: string) => unknown;

function str(ctx: Ctx, key: string): string | undefined {
  const v = ctx(key);
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

function bool(ctx: Ctx, key: string, def: boolean): boolean {
  const v = ctx(key);
  if (v === undefined || v === null || v === '') return def;
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(s)) return true;
  if (['false', '0', 'no', 'off'].includes(s)) return false;
  throw new Error(`context ${key}: expected a boolean, got "${v}"`);
}

function num(ctx: Ctx, key: string, def: number, min: number, max: number): number {
  const v = ctx(key);
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`context ${key}: expected a number in [${min}, ${max}], got "${v}"`);
  return n;
}

/** Accepts a JSON array, a JSON-array string (`-c 'k=["a","b"]'`) or a comma-separated string. */
function list(ctx: Ctx, key: string, def: string[]): string[] {
  const v = ctx(key);
  if (v === undefined || v === null || v === '') return def;
  if (Array.isArray(v)) return v.map(String);
  const s = String(v).trim();
  if (s.startsWith('[')) {
    const parsed = JSON.parse(s);
    if (!Array.isArray(parsed)) throw new Error(`context ${key}: expected an array`);
    return parsed.map(String);
  }
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

function oneOf<T extends string>(ctx: Ctx, key: string, allowed: readonly T[], def: T): T {
  const v = str(ctx, key);
  if (v === undefined) return def;
  const hit = allowed.find((a) => a.toLowerCase() === v.toLowerCase());
  if (!hit) throw new Error(`context ${key}: expected one of ${allowed.join('|')}, got "${v}"`);
  return hit;
}

function record(ctx: Ctx, key: string): Record<string, string> {
  const v = ctx(key);
  if (v === undefined || v === null || v === '') return {};
  const obj = typeof v === 'string' ? JSON.parse(v) : v;
  if (typeof obj !== 'object' || Array.isArray(obj)) throw new Error(`context ${key}: expected an object`);
  return Object.fromEntries(Object.entries(obj as Record<string, unknown>).map(([k, x]) => [k, String(x)]));
}

const CIDR_RE = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;

export function loadSettings(node: Node, env: NodeJS.ProcessEnv = process.env): KoptSettings {
  const ctx: Ctx = (k) => node.tryGetContext(k);
  const region = str(ctx, 'region') ?? env.CDK_DEFAULT_REGION ?? 'eu-central-1';

  const s: KoptSettings = {
    // Deliberately not CDK_DEFAULT_ACCOUNT: a concrete account turns AZ/VPC resolution into lookups that
    // need credentials, and synth must work without any.
    account: str(ctx, 'account'),
    region,
    availabilityZones: list(ctx, 'availabilityZones', []),
    bucketName: str(ctx, 'bucketName'),
    stackPrefix: str(ctx, 'stackPrefix') ?? 'Kopt',
    retainData: bool(ctx, 'retainData', true),
    tags: { Project: 'KiroOptimizer', ManagedBy: 'cdk', ...record(ctx, 'tags') },

    vpcId: str(ctx, 'vpcId'),
    vpcCidr: str(ctx, 'vpcCidr') ?? '10.42.0.0/16',
    maxAzs: num(ctx, 'maxAzs', 2, 2, 6),
    natGateways: num(ctx, 'natGateways', 1, 0, 6),
    interfaceEndpoints: bool(ctx, 'interfaceEndpoints', false),

    imageUri: str(ctx, 'imageUri'),
    taskCpu: num(ctx, 'taskCpu', 2048, 256, 16384),
    taskMemoryMiB: num(ctx, 'taskMemoryMiB', 8192, 512, 122880),
    ephemeralStorageGiB: num(ctx, 'ephemeralStorageGiB', 60, 21, 200),
    desiredCount: num(ctx, 'desiredCount', 2, 1, 100),
    minTasks: num(ctx, 'minTasks', 2, 1, 100),
    maxTasks: num(ctx, 'maxTasks', 6, 1, 100),
    cpuTargetPercent: num(ctx, 'cpuTargetPercent', 60, 10, 95),
    syncIntervalSec: num(ctx, 'syncIntervalSec', 300, 0, 86400),
    syncInitialTimeoutSec: num(ctx, 'syncInitialTimeoutSec', 240, 30, 270),
    certificateArn: str(ctx, 'certificateArn'),
    domainName: str(ctx, 'domainName'),
    hostedZoneId: str(ctx, 'hostedZoneId'),
    hostedZoneName: str(ctx, 'hostedZoneName'),
    internetFacing: bool(ctx, 'internetFacing', false),
    allowedCidrs: list(ctx, 'allowedCidrs', []),
    restrictPaths: bool(ctx, 'restrictPaths', true),
    stickySessions: bool(ctx, 'stickySessions', true),
    serveCommand: list(ctx, 'serveCommand', DEFAULT_SERVE_COMMAND),
    enableExecuteCommand: bool(ctx, 'enableExecuteCommand', false),
    logRetentionDays: num(ctx, 'logRetentionDays', 30, 1, 3653),
    containerInsights: bool(ctx, 'containerInsights', false),
    repoMetricDimension: bool(ctx, 'repoMetricDimension', false),

    cognitoDomainPrefix: str(ctx, 'cognitoDomainPrefix'),
    cognitoFeaturePlan: oneOf(ctx, 'cognitoFeaturePlan', ['LITE', 'ESSENTIALS', 'PLUS'] as const, 'ESSENTIALS'),
    oauthCallbackPort: num(ctx, 'oauthCallbackPort', 33418, 1024, 65535),
    oauthCallbackHosts: list(ctx, 'oauthCallbackHosts', ['localhost']),
    resourceServerId: str(ctx, 'resourceServerId') ?? 'kopt',
    oauthMetadataMode: oneOf(ctx, 'oauthMetadataMode', ['self', 'issuer'] as const, 'self'),
    separateTelemetryScope: bool(ctx, 'separateTelemetryScope', false),
    reposAcl: bool(ctx, 'reposAcl', false),
    refreshTokenDays: num(ctx, 'refreshTokenDays', 30, 1, 3650),
    samlMetadataUrl: str(ctx, 'samlMetadataUrl'),
    samlProviderName: str(ctx, 'samlProviderName') ?? 'CorporateSAML',
    samlEmailAttribute: str(ctx, 'samlEmailAttribute') ?? 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
    oidcIssuerUrl: str(ctx, 'oidcIssuerUrl'),
    oidcClientId: str(ctx, 'oidcClientId'),
    oidcClientSecretName: str(ctx, 'oidcClientSecretName'),
    oidcProviderName: str(ctx, 'oidcProviderName') ?? 'CorporateOIDC',
    disableCognitoLogin: bool(ctx, 'disableCognitoLogin', false),

    reposFile: str(ctx, 'reposFile') ?? 'repos.json',
    koptSource: str(ctx, 'koptSource') ?? DEFAULT_KOPT_SOURCE,
    koptRef: str(ctx, 'koptRef') ?? DEFAULT_KOPT_REF,
    koptPackage: str(ctx, 'koptPackage') ?? DEFAULT_KOPT_PACKAGE,
    koptVersion: str(ctx, 'koptVersion') ?? '0.1.0',
    indexerInstallCommand: str(ctx, 'indexerInstallCommand') ?? '',
    indexerCommand: str(ctx, 'indexerCommand') ?? 'kopt',
    codeArtifactDomain: str(ctx, 'codeArtifactDomain'),
    codeArtifactRepository: str(ctx, 'codeArtifactRepository'),
    indexerComputeType: oneOf(ctx, 'indexerComputeType', ['SMALL', 'MEDIUM', 'LARGE'] as const, 'SMALL'),
    indexerTimeoutMinutes: num(ctx, 'indexerTimeoutMinutes', 60, 5, 2160),
    indexerInVpc: bool(ctx, 'indexerInVpc', false),
    webhooks: bool(ctx, 'webhooks', true),
    nightlyReindex: bool(ctx, 'nightlyReindex', true),
    nightlyHourUtc: num(ctx, 'nightlyHourUtc', 1, 0, 23),

    snapshotRetentionDays: num(ctx, 'snapshotRetentionDays', 30, 1, 3650),
    kiroUsageExport: bool(ctx, 'kiroUsageExport', true),
    kiroUsageRegion: str(ctx, 'kiroUsageRegion'),
    alarmEmail: str(ctx, 'alarmEmail'),
    metricsSource: oneOf(ctx, 'metricsSource', ['emf', 'filters'] as const, 'emf'),
  };

  // Cross-field validation: fail at synth time, not halfway through a deployment.
  if (s.minTasks > s.maxTasks) throw new Error('context minTasks must be <= maxTasks');
  s.desiredCount = Math.min(Math.max(s.desiredCount, s.minTasks), s.maxTasks);
  for (const c of s.allowedCidrs) if (!CIDR_RE.test(c)) throw new Error(`context allowedCidrs: invalid CIDR "${c}"`);
  if (!CIDR_RE.test(s.vpcCidr)) throw new Error(`context vpcCidr: invalid CIDR "${s.vpcCidr}"`);
  for (const h of s.oauthCallbackHosts) {
    if (h !== 'localhost' && h !== '127.0.0.1') throw new Error(`context oauthCallbackHosts: only localhost / 127.0.0.1 are allowed (Kiro loopback), got "${h}"`);
  }
  if (!/^[a-z0-9-]{1,63}$/.test(s.cognitoDomainPrefix ?? 'ok') || /aws|amazon|cognito/.test(s.cognitoDomainPrefix ?? '')) {
    throw new Error('context cognitoDomainPrefix: lowercase letters, digits and hyphens only, and must not contain aws/amazon/cognito');
  }
  if (!/^[A-Za-z0-9_.:/-]{1,256}$/.test(s.resourceServerId)) throw new Error('context resourceServerId: invalid identifier');
  if (s.internetFacing && !s.certificateArn && s.allowedCidrs.length === 0) {
    throw new Error('internet-facing ALB without certificateArn requires an explicit allowedCidrs list');
  }
  if ((s.hostedZoneId || s.hostedZoneName) && !(s.hostedZoneId && s.hostedZoneName && s.domainName)) {
    throw new Error('context hostedZoneId, hostedZoneName and domainName must be set together');
  }
  if (s.oidcIssuerUrl && !(s.oidcClientId && s.oidcClientSecretName)) {
    throw new Error('context oidcClientId and oidcClientSecretName (Secrets Manager name) are required with oidcIssuerUrl');
  }
  if (s.disableCognitoLogin && !s.samlMetadataUrl && !s.oidcIssuerUrl) {
    throw new Error('disableCognitoLogin requires a federated IdP (samlMetadataUrl or oidcIssuerUrl)');
  }
  // These end up inside shell commands and latest.json: keep them to plain spec characters.
  if (!/^[A-Za-z0-9][A-Za-z0-9@:._/+-]{0,199}$/.test(s.koptSource)) throw new Error(`context koptSource: invalid npm git spec "${s.koptSource}"`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(s.koptRef) || s.koptRef.includes('..')) throw new Error(`context koptRef: invalid git ref "${s.koptRef}"`);
  if (!/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]{0,213}$/.test(s.koptPackage)) throw new Error(`context koptPackage: invalid npm package name "${s.koptPackage}"`);
  if (!/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,99}$/.test(s.koptVersion)) throw new Error(`context koptVersion: invalid version "${s.koptVersion}"`);
  if (!!s.codeArtifactDomain !== !!s.codeArtifactRepository) {
    throw new Error('context codeArtifactDomain and codeArtifactRepository must be set together');
  }
  if (s.vpcId && !s.account) throw new Error('context vpcId (Vpc.fromLookup) requires context "account"');
  if (s.account && !/^\d{12}$/.test(s.account)) throw new Error(`context account: expected 12 digits, got "${s.account}"`);
  if (s.account && !s.vpcId && s.availabilityZones.length === 0) {
    s.availabilityZones = 'abcdef'.slice(0, s.maxAzs).split('').map((x) => `${region}${x}`);
  }
  if (s.bucketName && !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(s.bucketName)) throw new Error('context bucketName: invalid S3 bucket name');
  if (s.serveCommand.length === 0) throw new Error('context serveCommand must not be empty');
  return s;
}
