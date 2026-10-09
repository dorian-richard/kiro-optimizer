// docker/s3sync.mjs: SigV4 against AWS's published vectors, then end-to-end sync against a fake S3.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { startFakeS3, type FakeS3 } from './helpers/fake-s3.js';

const SYNC_PATH = fileURLToPath(new URL('../../docker/s3sync.mjs', import.meta.url));
const ENTRYPOINT = fileURLToPath(new URL('../../docker/entrypoint.sh', import.meta.url));
const sync: any = await import(SYNC_PATH);

// AWS Signature V4 examples for S3 (AWS docs, "Examples: Signature Calculations in AWS Signature Version 4").
const EXAMPLE_CREDS = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
const EXAMPLE_DATE = new Date('2013-05-24T00:00:00Z');

describe('signV4', () => {
  it('matches the AWS GET Object example', () => {
    const h = sync.signV4({
      method: 'GET',
      url: 'https://examplebucket.s3.amazonaws.com/test.txt',
      region: 'us-east-1',
      service: 's3',
      credentials: EXAMPLE_CREDS,
      headers: { range: 'bytes=0-9' },
      now: EXAMPLE_DATE,
    });
    assert.equal(
      h.authorization,
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
    assert.equal(h['x-amz-date'], '20130524T000000Z');
    assert.equal(h.host, undefined, 'host is left to fetch');
  });

  it('matches the AWS GET Bucket (list objects) example, query parameters sorted', () => {
    const h = sync.signV4({
      method: 'GET',
      url: 'https://examplebucket.s3.amazonaws.com/?prefix=J&max-keys=2',
      region: 'us-east-1',
      service: 's3',
      credentials: EXAMPLE_CREDS,
      now: EXAMPLE_DATE,
    });
    assert.match(h.authorization, /Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7$/);
  });

  it('adds the session token as a signed header', () => {
    const h = sync.signV4({
      method: 'GET', url: 'https://b.s3.eu-central-1.amazonaws.com/k', region: 'eu-central-1', service: 's3',
      credentials: { ...EXAMPLE_CREDS, sessionToken: 'tok' }, now: EXAMPLE_DATE,
    });
    assert.equal(h['x-amz-security-token'], 'tok');
    assert.match(h.authorization, /SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token,/);
  });

  it('encodes keys per RFC 3986', () => {
    assert.equal(sync.rfc3986("a b!'()*"), 'a%20b%21%27%28%29%2A');
    const s3 = new sync.S3Client({ bucket: 'b', region: 'eu-west-3', credentials: async () => EXAMPLE_CREDS });
    assert.equal(s3.url('repos/my repo/x.db.gz'), 'https://b.s3.eu-west-3.amazonaws.com/repos/my%20repo/x.db.gz');
  });
});

describe('parseCommonPrefixes', () => {
  it('extracts prefixes and decodes entities', () => {
    const xml = '<ListBucketResult><CommonPrefixes><Prefix>repos/a/</Prefix></CommonPrefixes><CommonPrefixes><Prefix>repos/b&amp;c/</Prefix></CommonPrefixes></ListBucketResult>';
    assert.deepEqual(sync.parseCommonPrefixes(xml), ['repos/a/', 'repos/b&c/']);
  });
});

/** Async on purpose: the fake S3 lives in this process, a sync spawn would deadlock it. */
function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (status) => {
      clearTimeout(t);
      resolve({ status, stdout, stderr });
    });
  });
}

function makeIndex(path: string, marker: string): Buffer {
  rmSync(path, { force: true });
  const db = new DatabaseSync(path);
  // WAL on purpose: the sync must convert the copy to rollback-journal mode.
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE files(id INTEGER PRIMARY KEY, path TEXT);");
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('marker', marker);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  const buf = readFileSync(path);
  return gzipSync(buf);
}

function readMarker(path: string): { marker: string; journal: string } {
  const db = new DatabaseSync(path, { readOnly: true });
  const marker = (db.prepare("SELECT value FROM meta WHERE key = 'marker'").get() as { value: string }).value;
  const journal = String(Object.values(db.prepare('PRAGMA journal_mode').get() as object)[0]);
  db.close();
  return { marker, journal };
}

describe('syncOnce (fake S3)', () => {
  let s3: FakeS3;
  let dir: string;
  const creds = async () => ({ accessKeyId: 'AKID', secretAccessKey: 'secret' });
  const opts = () => ({
    ...sync.optionsFromEnv({ KOPT_SNAPSHOT_BUCKET: 'snap', KOPT_S3_ENDPOINT: s3.url, KOPT_REPOS_DIR: join(dir, 'repos'), AWS_REGION: 'eu-central-1' }),
  });
  const publish = (repo: string, commit: string, marker: string) => {
    const key = `repos/${repo}/${commit}.db.gz`;
    s3.objects.set(key, makeIndex(join(dir, `${repo}-${commit}.src.db`), marker));
    s3.objects.set(`repos/${repo}/latest.json`, Buffer.from(JSON.stringify({ commit, key, indexedAt: new Date().toISOString() })));
  };

  before(async () => {
    s3 = await startFakeS3('snap');
    dir = mkdtempSync(join(tmpdir(), 'kopt-sync-'));
  });
  after(async () => {
    await s3.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('downloads every repo, then skips unchanged ones', async () => {
    publish('alpha', 'aaaaaaa1', 'alpha-1');
    publish('beta', 'bbbbbbb1', 'beta-1');
    s3.objects.set('repos/gamma/readme.txt', Buffer.from('no pointer yet'));

    const first = await sync.syncOnce(opts(), creds);
    assert.deepEqual({ repos: first.repos, updated: first.updated, missing: first.missing, failed: first.failed }, { repos: 3, updated: 2, missing: 1, failed: 0 });
    const alpha = readMarker(join(dir, 'repos/alpha/index.db'));
    assert.deepEqual(alpha, { marker: 'alpha-1', journal: 'delete' });
    const state = JSON.parse(readFileSync(join(dir, 'repos/alpha/snapshot.json'), 'utf8'));
    assert.equal(state.commit, 'aaaaaaa1');
    assert.ok(s3.requests.every((r) => r.authorized), 'every request is SigV4 signed');

    const second = await sync.syncOnce(opts(), creds);
    assert.equal(second.updated, 0);
    assert.equal(second.unchanged, 2);
  });

  it('replaces the index atomically when latest.json moves', async () => {
    publish('alpha', 'aaaaaaa2', 'alpha-2');
    const r = await sync.syncOnce(opts(), creds);
    assert.equal(r.updated, 1);
    assert.equal(readMarker(join(dir, 'repos/alpha/index.db')).marker, 'alpha-2');
  });

  it('keeps the current index when a download is corrupt', async () => {
    s3.objects.set('repos/beta/bbbbbbb2.db.gz', gzipSync(Buffer.from('this is not sqlite')));
    s3.objects.set('repos/beta/latest.json', Buffer.from(JSON.stringify({ commit: 'bbbbbbb2', key: 'repos/beta/bbbbbbb2.db.gz' })));
    const r = await sync.syncOnce(opts(), creds);
    assert.equal(r.failed, 1);
    assert.equal(readMarker(join(dir, 'repos/beta/index.db')).marker, 'beta-1');
  });

  it('rejects pointers outside the repo prefix', async () => {
    s3.objects.set('repos/beta/latest.json', Buffer.from(JSON.stringify({ commit: 'x', key: 'repos/alpha/aaaaaaa2.db.gz' })));
    const r = await sync.syncOnce(opts(), creds);
    assert.equal(r.failed, 1);
    assert.match(r.errors[0], /outside the repo prefix/);
  });

  it('honours an explicit allowlist without listing the bucket', async () => {
    const before = s3.requests.length;
    const r = await sync.syncOnce({ ...opts(), repos: ['alpha'] }, creds);
    assert.equal(r.repos, 1);
    assert.ok(s3.requests.slice(before).every((q) => !q.path.includes('list-type')));
  });

  it('copies the repos ACL atomically and keeps it when the object disappears', async () => {
    const aclPath = join(dir, 'acl.json');
    s3.objects.set('config/repos-acl.json', Buffer.from('{"payments":["alpha"],"*":["beta"]}'));
    const env = { KOPT_SNAPSHOT_BUCKET: 'snap', KOPT_S3_ENDPOINT: s3.url, KOPT_REPOS_DIR: join(dir, 'repos'), KOPT_REPOS_ACL: aclPath };
    const o = { ...sync.optionsFromEnv(env), repos: ['alpha'] };
    assert.equal(o.aclKey, 'config/repos-acl.json');
    await sync.syncOnce(o, creds);
    assert.deepEqual(JSON.parse(readFileSync(aclPath, 'utf8')), { payments: ['alpha'], '*': ['beta'] });
    s3.objects.delete('config/repos-acl.json');
    const r = await sync.syncOnce(o, creds);
    assert.equal(r.failed, 0);
    assert.ok(existsSync(aclPath), 'last good ACL kept');
    s3.objects.set('config/repos-acl.json', Buffer.from('["not","an","object"]'));
    const bad = await sync.syncOnce(o, creds);
    assert.equal(bad.failed, 1);
    assert.deepEqual(JSON.parse(readFileSync(aclPath, 'utf8')), { payments: ['alpha'], '*': ['beta'] });
  });

  it('emits a CloudWatch EMF line', () => {
    const line = JSON.parse(sync.emfLine('KiroOptimizer', { updated: 2, failed: 1, durationMs: 42, repos: 3 }, 1700000000000));
    assert.equal(line._aws.CloudWatchMetrics[0].Namespace, 'KiroOptimizer');
    assert.deepEqual(line._aws.CloudWatchMetrics[0].Dimensions, [[]]);
    assert.equal(line.SyncErrors, 1);
    assert.equal(line.SnapshotsUpdated, 2);
    assert.equal(line.Kind, 'sync');
  });

  it('entrypoint.sh syncs first, then execs the server command', async () => {
    publish('delta', 'ddddddd1', 'delta-1');
    const reposDir = join(dir, 'ep-repos');
    const res = await run('sh', [ENTRYPOINT, 'node', '-e', 'process.stdout.write("served:" + process.env.KOPT_REPOS_DIR)'], {
        PATH: process.env.PATH,
        KOPT_SNAPSHOT_BUCKET: 'snap',
        KOPT_S3_ENDPOINT: s3.url,
        KOPT_REPOS_DIR: reposDir,
        KOPT_SYNC_SCRIPT: SYNC_PATH,
        AWS_ACCESS_KEY_ID: 'AKID',
        AWS_SECRET_ACCESS_KEY: 'secret',
        AWS_REGION: 'eu-central-1',
        SYNC_INTERVAL_SEC: '0',
    }, 30_000);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /served:/);
    assert.match(res.stdout, /"SnapshotsUpdated":\d/);
    assert.ok(existsSync(join(reposDir, 'delta/index.db')));
    assert.equal(readMarker(join(reposDir, 'delta/index.db')).marker, 'delta-1');
  });

  it('entrypoint.sh still starts the server when S3 is unreachable', async () => {
    const res = await run('sh', [ENTRYPOINT, 'node', '-e', 'process.stdout.write("served")'], {
        PATH: process.env.PATH,
        KOPT_SNAPSHOT_BUCKET: 'snap',
        KOPT_S3_ENDPOINT: 'http://127.0.0.1:9',
        KOPT_REPOS_DIR: join(dir, 'ep2'),
        KOPT_SYNC_SCRIPT: SYNC_PATH,
        AWS_ACCESS_KEY_ID: 'AKID',
        AWS_SECRET_ACCESS_KEY: 'secret',
        SYNC_INTERVAL_SEC: '0',
    }, 60_000);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /served$/);
    assert.match(res.stderr, /pass FAILED/);
  });
});
