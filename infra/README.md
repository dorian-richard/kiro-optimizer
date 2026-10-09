# KiroOptimizer: AWS deployment (CDK v2)

CDK app for the **centralized** mode: one `kopt serve` fleet answers every developer's Kiro (IDE and CLI)
over Streamable HTTP and OAuth. It serves per-repo index snapshots built by CodeBuild and stored in S3.
The full deployment guide (prerequisites, OAuth, security, costs, operations) is
[`docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md).

```
Kiro --HTTPS+OAuth--> ALB (internal) --> ECS Fargate ARM64 (kopt serve, N tasks)
                                            ^ entrypoint: S3 snapshot sync at start + every 5 min
CodeBuild (1 project / repo, webhook + nightly; installs kopt from GitHub by default)
    --> s3://<bucket>/repos/<repo>/{<commit>.db.gz, latest.json}
Cognito (public PKCE client, scopes kopt/mcp kopt/telemetry) --> JWT validated by the server
EMF on stdout --> CloudWatch metrics "KiroOptimizer" --> dashboard + alarms; Kiro usage CSV --> Glue/Athena
```

## Stacks

| Stack | Constructs | Notes |
|---|---|---|
| `Kopt-Data` (stateful, termination-protected, `RETAIN`) | `KoptData` (KMS CMK, S3 bucket), `KoptAuth` (Cognito), `KoptAnalytics` (Glue, Athena) | Deploy first. |
| `Kopt-App` (stateless) | `KoptNetwork`, `KoptService` (ALB + Fargate), `KoptIndexer` (CodeBuild), `KoptObservability` | Safe to destroy and recreate. |

Cross-stack references are *weak* (`Fn::GetStackOutput`, CDK flag `@aws-cdk/core:defaultCrossStackReferences=weak`),
so there are no CloudFormation export locks between the stacks.

## Commands

```bash
cd infra
npm install
npm run typecheck
npm test                                   # node:test + aws-cdk-lib/assertions + script tests (~5 s)

# Synth without AWS credentials or lookups (env-agnostic account):
npx cdk synth -c reposFile=repos.example.json
# Synth for a real account (no lookups either: AZs default to <region>a/<region>b):
npx cdk synth -c account=123456789012 -c region=eu-central-1 \
  -c certificateArn=arn:aws:acm:eu-central-1:123456789012:certificate/... \
  -c domainName=kopt.example.internal -c 'allowedCidrs=["10.0.0.0/8"]'

# Deploy (you run this; nothing deploys from CI by default):
npx cdk bootstrap aws://123456789012/eu-central-1
npx cdk deploy Kopt-Data Kopt-App -c account=... -c region=...
```

`Kopt-App` builds the image from the repository's `Dockerfile` (linux/arm64) at deploy time. From an x86 machine
that needs `docker buildx` with QEMU. Otherwise pass a prebuilt image with `-c imageUri=<ecr uri>:<tag>`.

## Context keys

Set them in `cdk.json` or pass `-c key=value` (lists accept JSON or comma-separated values).

| Key | Default | Meaning |
|---|---|---|
| `region` | `eu-central-1` (or `CDK_DEFAULT_REGION`) | Use the Kiro profile region (us-east-1 or eu-central-1): the usage export bucket must be there. |
| `account` | unset | 12 digits. Only from context: a concrete account would otherwise trigger credentialed lookups. |
| `availabilityZones` | `<region>a,b` if `account` is set | Explicit AZs (avoids the AZ lookup). |
| `stackPrefix` | `Kopt` | Prefix for stack and resource names. |
| `retainData` | `true` | Keep the KMS key, bucket, user pool and logs on stack deletion; turns on termination protection. |
| `tags` | `{}` | Extra tags on every resource, e.g. `{"CostCenter":"1234"}` (`Project=KiroOptimizer` and `ManagedBy=cdk` are always set). |
| `bucketName` | `<prefix>-<account>-<region>` | Name of the snapshot/analytics bucket. |
| `vpcId` | unset | Use an existing VPC (`Vpc.fromLookup`, needs `account` and credentials). Tasks go in its private subnets with egress. |
| `vpcCidr` / `maxAzs` / `natGateways` | `10.42.0.0/16` / `2` / `1` | New VPC. `natGateways=0` gives isolated subnets plus ECR/Logs endpoints (the server then cannot reach Cognito's JWKS: warning). |
| `interfaceEndpoints` | `false` | ECR api/dkr + Logs interface endpoints. |
| `imageUri` | unset | Prebuilt image (ECR URIs get pull rights). Unset: build `../Dockerfile`. |
| `taskCpu` / `taskMemoryMiB` / `ephemeralStorageGiB` | `2048` / `8192` / `60` | Fargate ARM64 task size. |
| `desiredCount` / `minTasks` / `maxTasks` / `cpuTargetPercent` | `2` / `2` / `6` / `60` | Service size and CPU target tracking. |
| `syncIntervalSec` / `syncInitialTimeoutSec` | `300` / `240` | S3 snapshot re-sync period (0 = off) and the bound on the blocking first sync (at most 270 because of ECS health-check limits). |
| `certificateArn` | unset | ACM certificate. Unset gives an **HTTP-only** listener restricted to `allowedCidrs` plus a warning (Kiro needs HTTPS for non-localhost URLs). |
| `domainName` | unset | Public host name (`kopt.example.internal`). Becomes the resource URL. |
| `hostedZoneId` + `hostedZoneName` | unset | Creates an alias record for `domainName` (use a private hosted zone for an internal ALB). |
| `internetFacing` | `false` | Internet-facing ALB. Without a certificate it requires `allowedCidrs`. |
| `allowedCidrs` | VPC CIDR (internal) | Client ranges allowed on the listener (VPN, Direct Connect). |
| `restrictPaths` | `true` | ALB forwards only `/mcp*`, `/.well-known/*`, `/telemetry*`, `/healthz`; anything else gets 404. |
| `stickySessions` | `true` | Best-effort cookie affinity. Not required: replicas share `KOPT_SESSION_SECRET`. |
| `serveCommand` | `node --disable-warning=ExperimentalWarning /app/dist/cli.js serve --port 8080 --repos-dir /data/repos` | Container command; the rest is passed as env vars. |
| `enableExecuteCommand` / `containerInsights` / `logRetentionDays` | `false` / `false` / `30` | Operations. |
| `repoMetricDimension` | `false` | Sets `KOPT_EMF_REPO_DIMENSION`. `false`: token metrics only have the `[Tool]` dimension and the dashboard reads per-repo numbers with Logs Insights (`Repo` stays a log field). `true`: adds the `[Repo]` dimension (one metric series per repo and metric, about $45/month for 50 repos) and a per-repo metric graph. |
| `cognitoDomainPrefix` | `<prefix>-<account>` | Hosted UI domain prefix (globally unique per region). |
| `cognitoFeaturePlan` | `ESSENTIALS` | `LITE`, `ESSENTIALS` or `PLUS`. |
| `oauthCallbackPort` / `oauthCallbackHosts` | `33418` / `localhost` | Loopback redirect registered on the public client: `http://localhost:33418/oauth/callback`, the `redirectUri` that `kopt init --remote` writes by default. Cognito accepts plain http only for `localhost`; add `127.0.0.1` only after checking it is accepted. |
| `resourceServerId` | `kopt` | Scopes `kopt/mcp` (required by the server) and `kopt/telemetry`. |
| `separateTelemetryScope` | `false` | Sets `KOPT_AUTH_TELEMETRY_SCOPES=<resourceServerId>/telemetry`: `POST /telemetry` then requires the telemetry scope instead of `kopt/mcp`. Needs a `kopt serve` that supports per-route scopes (`--auth-telemetry-scopes`); older servers ignore it. |
| `oauthMetadataMode` | `self` | `self`: the server publishes RFC 8414 metadata with itself as issuer (Kiro's exact issuer check and PKCE advertisement). `issuer`: advertise Cognito directly. |
| `reposAcl` | `false` | Sync `s3://<bucket>/config/repos-acl.json` (`{"group": ["repo"\|"*"]}`, groups = `cognito:groups`) to the tasks and enforce it. **Upload it before enabling** (the server fails closed). |
| `refreshTokenDays` | `30` | Refresh token lifetime, i.e. how often developers log in again. |
| `samlMetadataUrl` (+ `samlProviderName`, `samlEmailAttribute`) | unset | Federate IAM Identity Center, Entra ID or Okta via SAML. |
| `oidcIssuerUrl` + `oidcClientId` + `oidcClientSecretName` (+ `oidcProviderName`) | unset | Federate an OIDC IdP (the secret is read from Secrets Manager through a dynamic reference). |
| `disableCognitoLogin` | `false` | Federated login only. |
| `reposFile` | `repos.json` | Repos to index (see below). `repos.example.json` shows every source type. |
| `koptSource` / `koptRef` | `github:dorian-richard/kiro-optimizer` / `main` | Default install: `npm pack "<koptSource>#<koptRef>"` (builds from source) then `npm install -g` of the tarball. Pin `koptRef` to the tag or commit of the deployed image in production. A fork or mirror works too (`git+https://...`). |
| `koptPackage` / `koptVersion` | `kiro-optimizer` / `0.1.0` | Registry package installed instead when CodeArtifact is configured. |
| `codeArtifactDomain` + `codeArtifactRepository` | unset | Adds `aws codeartifact login --tool npm` (and the IAM it needs), then installs `<koptPackage>@<koptVersion>`. |
| `indexerInstallCommand` | unset | Replaces the install step (internal registry, `aws s3 cp s3://<bucket>/dist/kiro-optimizer-x.y.z.tgz /tmp/ && npm i -g /tmp/kiro-optimizer-x.y.z.tgz`...). The CodeArtifact login still runs first when configured. |
| `indexerCommand` | `kopt` | Shell prefix for `index --root ... --snapshot ... --repo ...`. |
| `indexerComputeType` / `indexerTimeoutMinutes` / `indexerInVpc` | `SMALL` / `60` / `false` | CodeBuild ARM size; run inside the VPC for private Git servers. |
| `webhooks` | `true` | Push webhooks on the default branch (GitHub, GitHub Enterprise, Bitbucket; needs CodeBuild source credentials). |
| `nightlyReindex` / `nightlyHourUtc` | `true` / `1` | Nightly full rebuild per repo, staggered 3 minutes apart. |
| `snapshotRetentionDays` | `30` | Expiry of superseded snapshots (`kopt-latest=false` tag) and noncurrent versions. |
| `kiroUsageExport` / `kiroUsageRegion` | `true` / stack region | Bucket policy + Glue table for Kiro's daily user-activity CSV under `kiro-usage/`. |
| `alarmEmail` | unset | Email subscription on the alarm topic. |
| `metricsSource` | `emf` | `filters`: derive the metrics with Logs metric filters (only if EMF extraction does not happen; never both). |

## repos.json

```json
[
  { "name": "billing-api", "source": { "type": "GITHUB", "owner": "acme", "repo": "billing-api", "branch": "main" } },
  { "name": "portal", "source": { "type": "GITHUB_ENTERPRISE", "location": "https://ghe.acme.com/web/portal.git", "branch": "main" } },
  { "name": "payments", "source": { "type": "BITBUCKET", "owner": "acme", "repo": "payments", "branch": "develop" } },
  { "name": "legacy-erp", "source": { "type": "CODECOMMIT", "repo": "legacy-erp", "branch": "master" }, "computeType": "LARGE", "timeoutMinutes": 120 },
  { "name": "docs", "source": { "type": "S3", "location": "s3://acme-sources/docs.zip" }, "webhook": false }
]
```

`name` becomes the S3 prefix, the repo name in MCP answers and the ACL key (`[A-Za-z0-9._-]`).
CodeCommit triggers through an EventBridge rule; S3 sources only rebuild nightly or on a manual `start-build`.

## Container contract (Dockerfile + docker/)

* `docker/entrypoint.sh` does a blocking `s3sync.mjs` pass (bounded), then runs it every `SYNC_INTERVAL_SEC`
  in the background, then `exec`s the command.
* `docker/s3sync.mjs` has no dependencies (fetch + SigV4 + zlib + `node:sqlite`). It reads
  `repos/<repo>/latest.json`, streams and gunzips `<commit>.db.gz` to a temp file, forces
  `journal_mode=DELETE`, runs `quick_check`, then renames the file over `/data/repos/<repo>/index.db` (atomic).
  A corrupt download never replaces a good index. It writes EMF `SnapshotsUpdated/SyncErrors`.
* Server env (read by `kopt serve`): `KOPT_HOST`, `KOPT_REPOS_DIR`, `KOPT_RESOURCE_URL`, `KOPT_AUTH_ISSUER`,
  `KOPT_AUTH_JWKS`, `KOPT_AUTH_CLIENT_ID`, `KOPT_AUTH_SCOPES`, `KOPT_AUTH_METADATA`, `KOPT_SESSION_SECRET`
  (Secrets Manager), `KOPT_EMF_REPO_DIMENSION` (`0`/`1`), `KOPT_AUTH_TELEMETRY_SCOPES` when
  `separateTelemetryScope` is on, and `KOPT_REPOS_ACL` when `reposAcl` is on.
* Indexer env (CodeBuild): `REPO`, `BUCKET`, `SNAPSHOT_PREFIX`, `KOPT_SOURCE`, `KOPT_REF`, `KOPT_PACKAGE`,
  `KOPT_VERSION`, `KOPT_ORIGIN`, `KOPT_CMD`, `KOPT_FULL`. `latest.json` records the installed version
  (`koptVersion`, from `kopt --version`) and `koptOrigin`.

## Tests

`npm test` runs `tsx --test test/*.test.ts`:

* `synth.test.ts`: assertions on both templates (listeners, IAM scoping, task definition, Cognito client, lifecycle, alarms, indexer install sources, telemetry scope and metric dimension flags, options, validation, no organization-specific names).
* `s3sync.test.ts`: SigV4 against AWS's published vectors, sync against an in-process fake S3, and the entrypoint end to end.
* `indexer-script.test.ts`: the CodeBuild build script with fake `aws` and `kopt` binaries (pointer ordering, retagging, stale-build guard, recorded version and origin, failures).
