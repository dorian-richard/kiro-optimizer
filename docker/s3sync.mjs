#!/usr/bin/env node
// Pulls per-repo index snapshots from S3 into <reposDir>/<repo>/index.db for the central query service.
//
// Layout written by the indexer (CodeBuild):
//   s3://<bucket>/<prefix><repo>/latest.json   {"commit","key","indexedAt",...}
//   s3://<bucket>/<key>                        gzip of a self-contained SQLite index
//
// Zero dependencies on purpose (fetch + SigV4 + zlib + node:sqlite): the runtime image needs neither the
// AWS CLI (~200 MB, its own Python) nor the AWS SDK, and the whole download path is streamed.
//
// Usage: node s3sync.mjs            one pass, exit 0 even if some repos failed (server must still start)
//        node s3sync.mjs --loop 300 pass every 300 s, forever
// Env:   KOPT_SNAPSHOT_BUCKET (required), KOPT_SNAPSHOT_PREFIX (default "repos/"), KOPT_REPOS_DIR (/data/repos),
//        AWS_REGION, KOPT_SYNC_REPOS (comma allowlist; skips ListBucket), KOPT_SYNC_CONCURRENCY (4),
//        KOPT_SYNC_VERIFY (quick|none), KOPT_SYNC_PRUNE (1 = delete local repos gone from S3),
//        KOPT_S3_ENDPOINT (path-style endpoint, tests/MinIO), KOPT_SYNC_EMF (0 disables metric lines),
//        KOPT_METRICS_NAMESPACE (KiroOptimizer), KOPT_REPOS_ACL + KOPT_ACL_KEY (copy the group->repos ACL
//        object to that local path; `kopt serve` reloads it on change).

import { createHash, createHmac } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { createGunzip } from 'node:zlib';

export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const log = (msg) => process.stderr.write(`kopt-sync: ${msg}\n`);

// ---------------------------------------------------------------------------------------------- SigV4

/** RFC 3986 encoding as required by SigV4 (encodeURIComponent leaves !'()* unescaped). */
export function rfc3986(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

/**
 * Sign a request with AWS Signature Version 4 (header auth). S3 flavour: the path is used as-is
 * (already encoded once by the caller), no double encoding.
 * Returns the headers to send (input headers + x-amz-date, x-amz-content-sha256, security token, authorization).
 */
export function signV4({ method, url, region, service, credentials, headers = {}, payloadHash = EMPTY_SHA256, now = new Date() }) {
  const u = new URL(url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const all = { ...headers, host: u.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash };
  if (credentials.sessionToken) all['x-amz-security-token'] = credentials.sessionToken;

  const lower = Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]);
  lower.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const canonicalHeaders = lower.map(([k, v]) => `${k}:${v}\n`).join('');
  const signedHeaders = lower.map(([k]) => k).join(';');

  const query = [...u.searchParams.entries()]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalRequest = [method, u.pathname || '/', query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + credentials.secretAccessKey, date), region), service), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  const out = Object.fromEntries(lower);
  out.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  delete out.host; // fetch sets Host itself
  return out;
}

// ----------------------------------------------------------------------------------------- credentials

/** Env keys, else the ECS/Fargate container credentials endpoint. Cached until 5 min before expiry. */
export function credentialsProvider(env = process.env) {
  let cached;
  return async () => {
    if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
      return { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN };
    }
    if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.creds;
    let url;
    if (env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI) url = `http://169.254.170.2${env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI}`;
    else if (env.AWS_CONTAINER_CREDENTIALS_FULL_URI) url = env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
    else throw new Error('no AWS credentials (set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or run in ECS with a task role)');
    const headers = {};
    const token = env.AWS_CONTAINER_AUTHORIZATION_TOKEN
      || (env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE ? readFileSync(env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE, 'utf8').trim() : '');
    if (token) headers.authorization = token;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`container credentials endpoint returned HTTP ${res.status}`);
    const j = await res.json();
    const creds = { accessKeyId: j.AccessKeyId, secretAccessKey: j.SecretAccessKey, sessionToken: j.Token };
    cached = { creds, expiresAt: j.Expiration ? Date.parse(j.Expiration) : Date.now() + 15 * 60_000 };
    return creds;
  };
}

// ------------------------------------------------------------------------------------------- S3 client

export class S3Client {
  constructor({ bucket, region, endpoint, credentials }) {
    if (!bucket) throw new Error('bucket is required');
    this.bucket = bucket;
    this.region = region || 'us-east-1';
    this.endpoint = endpoint ? endpoint.replace(/\/+$/, '') : undefined;
    this.credentials = credentials;
  }

  url(key, query) {
    const path = key.split('/').map(rfc3986).join('/');
    const base = this.endpoint ? `${this.endpoint}/${this.bucket}` : `https://${this.bucket}.s3.${this.region}.amazonaws.com`;
    const qs = query ? '?' + new URLSearchParams(query).toString() : '';
    return `${base}/${path}${qs}`;
  }

  /** Signed GET with retries on throttling, 5xx and network errors. Returns the Response (caller consumes body). */
  async get(key, query) {
    const url = this.url(key, query);
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
      try {
        const headers = signV4({ method: 'GET', url, region: this.region, service: 's3', credentials: await this.credentials() });
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(10 * 60_000) });
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`GET ${key}: HTTP ${res.status}`);
          await res.body?.cancel();
          continue;
        }
        return res;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  /** Parsed JSON object, or undefined when the key does not exist. */
  async getJson(key) {
    const res = await this.get(key);
    if (res.status === 404) {
      await res.body?.cancel();
      return undefined;
    }
    if (!res.ok) throw new Error(`GET ${key}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return JSON.parse(await res.text());
  }

  /** Immediate "sub-directories" of prefix (ListObjectsV2 with delimiter). */
  async listPrefixes(prefix) {
    const out = [];
    let token;
    do {
      const query = { 'list-type': '2', prefix, delimiter: '/' };
      if (token) query['continuation-token'] = token;
      const res = await this.get('', query);
      const xml = await res.text();
      if (!res.ok) throw new Error(`ListObjectsV2 ${prefix}: HTTP ${res.status} ${xml.slice(0, 200)}`);
      out.push(...parseCommonPrefixes(xml));
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? xmlText(xml, 'NextContinuationToken') : undefined;
    } while (token);
    return out;
  }
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => XML_ENTITIES[e]);
function xmlText(xml, tag) {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return m ? unxml(m[1]) : undefined;
}

export function parseCommonPrefixes(xml) {
  const out = [];
  for (const block of xml.matchAll(/<CommonPrefixes>([\s\S]*?)<\/CommonPrefixes>/g)) {
    const p = xmlText(block[1], 'Prefix');
    if (p) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- sync

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 1) + '\n');
  renameSync(tmp, file);
}

let sqliteMod;
async function loadSqlite() {
  if (sqliteMod === undefined) {
    try {
      sqliteMod = await import('node:sqlite');
    } catch {
      sqliteMod = null;
    }
  }
  return sqliteMod;
}

/**
 * Make the downloaded file safe to swap in: force rollback-journal mode (a WAL-mode header would make
 * readers look for index.db-wal, which after a rename may belong to the previous snapshot) and
 * optionally run quick_check so a truncated/corrupt download never replaces a good index.
 */
async function prepareDb(file, verify) {
  const sqlite = await loadSqlite();
  if (!sqlite) return;
  const db = new sqlite.DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode=DELETE');
    const meta = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
    if (!meta || Number(meta.n) !== 1) throw new Error('not a kopt index (no meta table)');
    if (verify !== 'none') {
      const row = db.prepare('PRAGMA quick_check').get();
      const result = row ? Object.values(row)[0] : 'no result';
      if (result !== 'ok') throw new Error(`quick_check failed: ${result}`);
    }
  } finally {
    db.close();
  }
}

/** Sync one repo. Returns 'updated' | 'unchanged' | 'missing'. Throws on failure (local index untouched). */
export async function syncRepo(s3, repo, opts) {
  const { prefix, reposDir, verify } = opts;
  const pointer = await s3.getJson(`${prefix}${repo}/latest.json`);
  if (!pointer) return 'missing';
  const key = String(pointer.key || '');
  if (!key.startsWith(`${prefix}${repo}/`) || !key.endsWith('.db.gz') || key.includes('..')) {
    throw new Error(`latest.json points outside the repo prefix: ${key}`);
  }
  const dir = join(reposDir, repo);
  const dest = join(dir, 'index.db');
  const stateFile = join(dir, 'snapshot.json');
  const fingerprint = `${key}|${pointer.commit ?? ''}|${pointer.indexedAt ?? ''}`;
  if (readJson(stateFile)?.fingerprint === fingerprint && existsSync(dest)) return 'unchanged';

  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.index.db.${process.pid}.${Date.now()}.tmp`);
  try {
    const res = await s3.get(key);
    if (!res.ok || !res.body) throw new Error(`GET ${key}: HTTP ${res.status}`);
    let bytes = 0;
    const count = new Transform({
      transform(chunk, _enc, cb) {
        bytes += chunk.length;
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), count, createGunzip(), createWriteStream(tmp));
    await prepareDb(tmp, verify);
    // rename(2) is atomic: open connections keep reading the old inode until the server reopens.
    renameSync(tmp, dest);
    writeJsonAtomic(stateFile, { fingerprint, ...pointer, gzBytes: bytes, syncedAt: new Date().toISOString() });
    return 'updated';
  } finally {
    rmSync(tmp, { force: true });
    rmSync(`${tmp}-journal`, { force: true });
  }
}

async function pool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export function optionsFromEnv(env = process.env) {
  let prefix = env.KOPT_SNAPSHOT_PREFIX ?? 'repos/';
  if (prefix && !prefix.endsWith('/')) prefix += '/';
  return {
    bucket: env.KOPT_SNAPSHOT_BUCKET,
    region: env.KOPT_S3_REGION || env.AWS_REGION || env.AWS_DEFAULT_REGION,
    endpoint: env.KOPT_S3_ENDPOINT || undefined,
    prefix,
    reposDir: env.KOPT_REPOS_DIR || '/data/repos',
    repos: (env.KOPT_SYNC_REPOS || '').split(',').map((s) => s.trim()).filter(Boolean),
    concurrency: Math.max(1, Number(env.KOPT_SYNC_CONCURRENCY) || 4),
    verify: env.KOPT_SYNC_VERIFY === 'none' ? 'none' : 'quick',
    prune: env.KOPT_SYNC_PRUNE === '1',
    emf: env.KOPT_SYNC_EMF !== '0',
    namespace: env.KOPT_METRICS_NAMESPACE || 'KiroOptimizer',
    aclKey: env.KOPT_REPOS_ACL ? env.KOPT_ACL_KEY || 'config/repos-acl.json' : undefined,
    aclPath: env.KOPT_REPOS_ACL || undefined,
  };
}

/**
 * Copy the ACL object to its local path (atomic). A missing object leaves the local file alone, so a
 * deleted ACL never silently opens every repo to everyone; the server fails closed if it never existed.
 */
export async function syncAcl(s3, key, dest) {
  const res = await s3.get(key);
  if (res.status === 404) {
    await res.body?.cancel();
    return 'missing';
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${key}: HTTP ${res.status}`);
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${key}: expected {"group": ["repo"|"*"]}`);
  if (existsSync(dest) && readFileSync(dest, 'utf8') === text) return 'unchanged';
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, dest);
  return 'updated';
}

/** One full pass over all repos. Never throws for per-repo failures. */
export async function syncOnce(opts, credentials = credentialsProvider()) {
  const started = Date.now();
  const s3 = new S3Client({ bucket: opts.bucket, region: opts.region, endpoint: opts.endpoint, credentials });
  const summary = { repos: 0, updated: 0, unchanged: 0, missing: 0, failed: 0, pruned: 0, errors: [] };
  let repos = opts.repos;
  if (!repos.length) {
    repos = (await s3.listPrefixes(opts.prefix)).map((p) => p.slice(opts.prefix.length).replace(/\/$/, ''));
  }
  repos = repos.filter((r) => {
    if (REPO_RE.test(r) && r !== '.' && r !== '..') return true;
    log(`skipping invalid repo name "${r}"`);
    return false;
  });
  summary.repos = repos.length;
  mkdirSync(opts.reposDir, { recursive: true });
  if (opts.aclKey && opts.aclPath) {
    try {
      const r = await syncAcl(s3, opts.aclKey, opts.aclPath);
      if (r !== 'unchanged') log(`repos ACL ${opts.aclKey}: ${r}`);
    } catch (err) {
      summary.failed++;
      summary.errors.push(`acl: ${err.message}`);
      log(`repos ACL ${opts.aclKey}: FAILED ${err.message}`);
    }
  }
  await pool(repos, opts.concurrency, async (repo) => {
    try {
      const r = await syncRepo(s3, repo, opts);
      summary[r]++;
      if (r === 'updated') log(`${repo}: updated`);
    } catch (err) {
      summary.failed++;
      summary.errors.push(`${repo}: ${err.message}`);
      log(`${repo}: FAILED ${err.message}`);
    }
  });
  if (opts.prune && !opts.repos.length) {
    const keep = new Set(repos);
    for (const d of readdirSync(opts.reposDir, { withFileTypes: true })) {
      if (d.isDirectory() && !keep.has(d.name) && REPO_RE.test(d.name)) {
        rmSync(join(opts.reposDir, d.name), { recursive: true, force: true });
        summary.pruned++;
      }
    }
  }
  summary.durationMs = Date.now() - started;
  return summary;
}

/** CloudWatch Embedded Metric Format line (stdout -> awslogs -> metrics). */
export function emfLine(namespace, summary, ts = Date.now()) {
  return JSON.stringify({
    _aws: {
      Timestamp: ts,
      CloudWatchMetrics: [{
        Namespace: namespace,
        Dimensions: [[]],
        Metrics: [
          { Name: 'SnapshotsUpdated', Unit: 'Count' },
          { Name: 'SyncErrors', Unit: 'Count' },
          { Name: 'SyncDurationMs', Unit: 'Milliseconds' },
        ],
      }],
    },
    Kind: 'sync',
    SnapshotsUpdated: summary.updated,
    SyncErrors: summary.failed,
    SyncDurationMs: summary.durationMs,
    repos: summary.repos,
  });
}

async function runPass(opts) {
  let summary;
  try {
    summary = await syncOnce(opts);
  } catch (err) {
    // listing/credentials failure: count it as one error so the alarm fires, keep the process alive
    summary = { repos: 0, updated: 0, unchanged: 0, missing: 0, failed: 1, pruned: 0, durationMs: 0, errors: [err.message] };
    log(`pass FAILED: ${err.message}`);
  }
  log(`${summary.repos} repos · ${summary.updated} updated · ${summary.unchanged} unchanged · ${summary.missing} without snapshot · ${summary.failed} failed · ${summary.durationMs} ms`);
  if (opts.emf) process.stdout.write(emfLine(opts.namespace, summary) + '\n');
  return summary;
}

async function main(argv) {
  const opts = optionsFromEnv();
  if (!opts.bucket) {
    log('KOPT_SNAPSHOT_BUCKET is not set');
    return 2;
  }
  const loopIdx = argv.indexOf('--loop');
  if (loopIdx < 0) {
    await runPass(opts);
    return 0;
  }
  const intervalMs = Math.max(30, Number(argv[loopIdx + 1]) || 300) * 1000;
  const stop = () => process.exit(0);
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  // setTimeout chain (not setInterval) so a slow pass never overlaps the next one
  for (;;) {
    await new Promise((r) => setTimeout(r, intervalMs));
    await runPass(opts);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    log(`fatal: ${err.stack || err}`);
    process.exit(1);
  });
}
