// infra/lib/indexer/index-repo.sh run exactly as the buildspec does, with fake `aws` and `kopt` binaries.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { gunzipSync } from 'node:zlib';

const SCRIPT = readFileSync(new URL('../lib/indexer/index-repo.sh', import.meta.url), 'utf8');

// Maps the few aws CLI calls the script makes onto a directory.
const FAKE_AWS = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const root = process.env.FAKE_S3_DIR;
const a = process.argv.slice(2);
const opt = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
const file = (k) => path.join(root, k);
if (a[0] === 's3' && a[1] === 'cp') {
  const m = /^s3:\\/\\/[^/]+\\/(.+)$/.exec(a[2]);
  if (!m || !fs.existsSync(file(m[1]))) { console.error('fatal error: An error occurred (404)'); process.exit(1); }
  fs.copyFileSync(file(m[1]), a[3]);
} else if (a[0] === 's3api' && a[1] === 'put-object') {
  const k = opt('--key');
  fs.mkdirSync(path.dirname(file(k)), { recursive: true });
  fs.copyFileSync(opt('--body'), file(k));
  const t = opt('--tagging');
  if (t) fs.writeFileSync(file(k) + '.tags', t.split('=')[1]);
  fs.appendFileSync(path.join(root, '_calls.log'), 'put ' + k + '\\n');
} else if (a[0] === 's3api' && a[1] === 'put-object-tagging') {
  const k = opt('--key');
  fs.writeFileSync(file(k) + '.tags', /Value=([a-z]+)/.exec(opt('--tagging'))[1]);
} else { console.error('fake aws: unsupported ' + a.join(' ')); process.exit(2); }
`;

// Fake kopt: records its arguments and a run counter in the snapshot (WAL mode, like the real Store).
const FAKE_KOPT = `const { DatabaseSync } = require('node:sqlite');
const a = process.argv.slice(2);
if (a[0] === '--version') { if (!process.env.FAKE_KOPT_NO_VERSION) console.log('0.2.0-test'); process.exit(0); }
if (process.env.FAKE_KOPT_FAIL) { console.error('boom'); process.exit(3); }
const out = a[a.indexOf('--snapshot') + 1], repo = a[a.indexOf('--repo') + 1];
const db = new DatabaseSync(out);
db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
const row = db.prepare("SELECT value FROM meta WHERE key='runs'").get();
db.prepare("INSERT OR REPLACE INTO meta VALUES ('runs', ?)").run(String(row ? Number(row.value) + 1 : 1));
db.prepare("INSERT OR REPLACE INTO meta VALUES ('repo', ?)").run(repo);
db.prepare("INSERT OR REPLACE INTO meta VALUES ('root', ?)").run(a[a.indexOf('--root') + 1]);
db.close();
`;

describe('index-repo.sh', () => {
  let dir: string;
  let s3dir: string;
  let bin: string;
  let work: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'kopt-idx-'));
    s3dir = join(dir, 's3');
    bin = join(dir, 'bin');
    work = join(dir, 'src'); // not a git checkout: exercises the nogit fallback when needed
    for (const d of [s3dir, bin, work]) mkdirSync(d, { recursive: true });
    writeFileSync(join(bin, 'aws'), FAKE_AWS);
    chmodSync(join(bin, 'aws'), 0o755);
    writeFileSync(join(dir, 'fake-kopt.cjs'), FAKE_KOPT);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  function build(env: Record<string, string>) {
    rmSync(join(dir, 'work'), { recursive: true, force: true });
    return spawnSync('bash', ['-c', `(\n${SCRIPT}\n)`], {
      cwd: work,
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: dir,
        FAKE_S3_DIR: s3dir,
        REPO: 'billing',
        BUCKET: 'snap',
        SNAPSHOT_PREFIX: 'repos',
        KOPT_CMD: `node --disable-warning=ExperimentalWarning ${join(dir, 'fake-kopt.cjs')}`,
        KOPT_VERSION: '0.1.0',
        KOPT_ORIGIN: 'github:dorian-richard/kiro-optimizer#main',
        CODEBUILD_BUILD_ID: 'kopt-index-billing:1',
        KOPT_WORK_DIR: join(dir, 'work'),
        ...env,
      },
      encoding: 'utf8',
      timeout: 60_000,
    });
  }
  const latest = () => JSON.parse(readFileSync(join(s3dir, 'repos/billing/latest.json'), 'utf8'));
  const tag = (key: string) => readFileSync(join(s3dir, `${key}.tags`), 'utf8');
  const meta = (key: string, k: string) => {
    const p = join(dir, 'meta.db');
    writeFileSync(p, gunzipSync(readFileSync(join(s3dir, key))));
    const db = new DatabaseSync(p, { readOnly: true });
    const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(k) as { value: string } | undefined;
    db.close();
    return r?.value;
  };
  const runs = (key: string) => {
    const p = join(dir, 'check.db');
    writeFileSync(p, gunzipSync(readFileSync(join(s3dir, key))));
    const db = new DatabaseSync(p, { readOnly: true });
    const r = db.prepare("SELECT value FROM meta WHERE key='runs'").get() as { value: string };
    const j = String(Object.values(db.prepare('PRAGMA journal_mode').get() as object)[0]);
    db.close();
    return { runs: Number(r.value), journal: j };
  };

  it('publishes the snapshot then the pointer', () => {
    const r = build({ CODEBUILD_RESOLVED_SOURCE_VERSION: 'c1c1c1c1', CODEBUILD_START_TIME: '1000' });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const l = latest();
    assert.equal(l.commit, 'c1c1c1c1');
    assert.equal(l.key, 'repos/billing/c1c1c1c1.db.gz');
    assert.equal(l.buildStartedAt, 1000);
    assert.equal(l.koptVersion, '0.2.0-test', 'version reported by the installed kopt');
    assert.equal(l.koptOrigin, 'github:dorian-richard/kiro-optimizer#main');
    assert.equal(tag(l.key), 'true');
    assert.deepEqual(runs(l.key), { runs: 1, journal: 'delete' });
    const calls = readFileSync(join(s3dir, '_calls.log'), 'utf8').trim().split('\n');
    assert.deepEqual(calls, ['put repos/billing/c1c1c1c1.db.gz', 'put repos/billing/latest.json'], 'snapshot before pointer');
  });

  it('publishes a full snapshot per build, indexes CODEBUILD_SRC_DIR and retags the previous one', () => {
    const r = build({ CODEBUILD_RESOLVED_SOURCE_VERSION: 'c2c2c2c2', CODEBUILD_START_TIME: '2000', CODEBUILD_SRC_DIR: work });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(latest().commit, 'c2c2c2c2');
    assert.equal(latest().nightly, false);
    assert.equal(runs('repos/billing/c2c2c2c2.db.gz').runs, 1);
    assert.equal(meta('repos/billing/c2c2c2c2.db.gz', 'root'), work);
    assert.equal(tag('repos/billing/c1c1c1c1.db.gz'), 'false');
    assert.equal(tag('repos/billing/c2c2c2c2.db.gz'), 'true');
  });

  it('nightly rebuild of the same commit keeps its tag and flags the pointer', () => {
    const r = build({ CODEBUILD_RESOLVED_SOURCE_VERSION: 'c2c2c2c2', CODEBUILD_START_TIME: '3000', KOPT_FULL: '1' });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(latest().buildStartedAt, 3000);
    assert.equal(latest().nightly, true);
    assert.equal(tag('repos/billing/c2c2c2c2.db.gz'), 'true');
  });

  it('never moves the pointer backwards when an older build finishes last', () => {
    const r = build({ CODEBUILD_RESOLVED_SOURCE_VERSION: 'c0c0c0c0', CODEBUILD_START_TIME: '1500' });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /pointer left unchanged/);
    assert.equal(latest().commit, 'c2c2c2c2');
    assert.equal(tag('repos/billing/c0c0c0c0.db.gz'), 'false');
  });

  it('falls back to KOPT_VERSION when kopt prints no version, and sanitizes the origin', () => {
    const r = build({
      CODEBUILD_RESOLVED_SOURCE_VERSION: 'c3c3c3c3',
      CODEBUILD_START_TIME: '3500',
      FAKE_KOPT_NO_VERSION: '1',
      KOPT_ORIGIN: 'custom"},"x":"y',
    });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(latest().koptVersion, '0.1.0');
    assert.equal(latest().koptOrigin, 'customx:y', 'quotes and braces stripped, pointer stays valid JSON');
  });

  it('falls back to a build-time key without git metadata (S3 sources)', () => {
    const r = build({ CODEBUILD_RESOLVED_SOURCE_VERSION: 'arn:aws:s3:::src/x.zip', CODEBUILD_START_TIME: '4000' });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(latest().commit, /^nogit-\d{8}T\d{6}Z$/);
  });

  it('fails without touching the pointer when kopt index fails', () => {
    const before = readFileSync(join(s3dir, 'repos/billing/latest.json'), 'utf8');
    const r = build({ CODEBUILD_RESOLVED_SOURCE_VERSION: 'c9c9c9c9', CODEBUILD_START_TIME: '9000', FAKE_KOPT_FAIL: '1' });
    assert.notEqual(r.status, 0);
    assert.equal(readFileSync(join(s3dir, 'repos/billing/latest.json'), 'utf8'), before);
    assert.ok(!existsSync(join(s3dir, 'repos/billing/c9c9c9c9.db.gz')));
  });
});
