import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, type KoptConfig } from '../src/core/config.js';
import { collectKiroCredits, dayFileName, pruneTelemetry, record, RETAIN_DAYS, stats } from '../src/telemetry/index.js';

let tmp: string;
let prevKiroHome: string | undefined;
const FIXTURE_HOME = join(__dirname, 'fixtures', 'kiro', 'home');

function makeConfig(name: string): KoptConfig {
  const root = join(tmp, name);
  mkdirSync(root, { recursive: true });
  const c = defaultConfig(root);
  c.userDir = join(root, '.user');
  c.dataDir = join(root, '.kopt');
  return c;
}

function lines(c: KoptConfig): any[] {
  const dir = join(c.userDir, 'telemetry');
  return readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort()
    .flatMap((n) => readFileSync(join(dir, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}

/** Kiro home copy with old mtimes (turns are "settled"). */
function kiroHomeCopy(name: string): string {
  const home = join(tmp, name);
  cpSync(FIXTURE_HOME, home, { recursive: true });
  const old = new Date(Date.now() - 3600_000);
  const touch = (p: string) => utimesSync(p, old, old);
  touch(join(home, 'sessions', 'cli', '7d1e5f00-cli-session.json'));
  touch(join(home, 'sessions', '9f2c1e', '0b6a1c2d-ide-session', 'messages.jsonl'));
  return home;
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'kopt-tel-'));
  prevKiroHome = process.env.KOPT_KIRO_HOME;
  process.env.KOPT_KIRO_HOME = join(tmp, 'empty-kiro-home');
});

afterAll(() => {
  if (prevKiroHome === undefined) delete process.env.KOPT_KIRO_HOME;
  else process.env.KOPT_KIRO_HOME = prevKiroHome;
  rmSync(tmp, { recursive: true, force: true });
});

describe('record', () => {
  it('appends one JSON line per event to the UTC day file, labelled with the project folder', () => {
    const c = makeConfig('acme-api');
    const ts = Date.UTC(2026, 9, 9, 12);
    record({ ts, kind: 'tool', tool: 'kopt_find', tokensOut: 120 }, c);
    record({ ts, kind: 'hook', tool: 'read_file', tokensOut: 900, repo: 'explicit' }, c);
    const file = join(c.userDir, 'telemetry', '2026-10-09.jsonl');
    const evs = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(evs).toHaveLength(2);
    expect(evs[0]).toEqual({ ts, kind: 'tool', tool: 'kopt_find', tokensOut: 120, repo: 'acme-api' });
    expect(evs[1].repo).toBe('explicit');
    expect(dayFileName(ts)).toBe('2026-10-09.jsonl');
  });

  it('honours the enabled switch and never throws', () => {
    const c = makeConfig('rec2');
    record({ ts: Date.now(), kind: 'tool' }, c);
    expect(lines(c)).toHaveLength(1);
    const off = makeConfig('rec-off');
    off.telemetry.enabled = false;
    record({ ts: Date.now(), kind: 'tool' }, off);
    expect(() => readdirSync(join(off.userDir, 'telemetry'))).toThrow();
    const broken = makeConfig('rec-broken');
    writeFileSync(join(broken.root, 'file'), 'x');
    broken.userDir = join(broken.root, 'file', 'sub');
    expect(() => record({ ts: Date.now(), kind: 'tool' }, broken)).not.toThrow();
  });
});

describe('pruneTelemetry', () => {
  it(`keeps ${RETAIN_DAYS} days of day files and ignores other files`, () => {
    const c = makeConfig('prune');
    const now = Date.UTC(2026, 9, 9, 12);
    const day = (d: number) => dayFileName(now - d * 86400_000);
    const dir = join(c.userDir, 'telemetry');
    mkdirSync(dir, { recursive: true });
    for (const f of [day(RETAIN_DAYS + 30), day(RETAIN_DAYS + 1), day(RETAIN_DAYS), day(0), 'credits-cursor.json']) writeFileSync(join(dir, f), '{}\n');
    pruneTelemetry(c, now);
    expect(readdirSync(dir).sort()).toEqual([day(RETAIN_DAYS), day(0), 'credits-cursor.json'].sort());
    // no telemetry dir yet: nothing to do, nothing created
    const none = makeConfig('prune-none');
    expect(() => pruneTelemetry(none, now)).not.toThrow();
    expect(existsSync(join(none.userDir, 'telemetry'))).toBe(false);
  });
});

describe('collectKiroCredits', () => {
  it('parses CLI sidecars and unified-harness usage summaries once (cursor)', () => {
    const home = kiroHomeCopy('home1');
    process.env.KOPT_KIRO_HOME = home;
    try {
      const c = makeConfig('collect');
      const evs = collectKiroCredits(c);
      expect(evs).toHaveLength(3);
      const cli = evs.filter((e) => e.meta?.source === 'kiro-cli');
      expect(cli.map((e) => e.credits)).toEqual([0.103, 0.5]);
      expect(cli[0]).toMatchObject({ kind: 'credits', session: '7d1e5f00-cli-session', repo: 'acme-api', durationMs: 12500, ts: 1791000000000 });
      expect(cli[0].meta).toMatchObject({ model: 'claude-sonnet-4.6', requests: 2, toolUses: 3, contextPct: 7.3 });
      expect(cli[1].durationMs).toBe(4200);
      const ide = evs.find((e) => e.meta?.source === 'kiro-unified')!;
      expect(ide).toMatchObject({ credits: 0.43, session: '0b6a1c2d-ide-session', repo: 'web-shop', durationMs: 30000, ts: Date.parse('2026-10-08T10:00:30.000Z') });
      expect(ide.meta?.tools).toEqual(['read_file', 'grep_search', 'str_replace']);
      // second collection: nothing new
      expect(collectKiroCredits(c)).toEqual([]);

      // a new CLI turn and a new IDE turn appear
      const cliPath = join(home, 'sessions', 'cli', '7d1e5f00-cli-session.json');
      const doc = JSON.parse(readFileSync(cliPath, 'utf8'));
      doc.session_state.conversation_metadata.user_turn_metadatas.push({ metering_usage: [{ value: 1.25, unit: 'credit' }] });
      writeFileSync(cliPath, JSON.stringify(doc));
      const old = new Date(Date.now() - 3600_000);
      utimesSync(cliPath, old, old);
      appendFileSync(join(home, 'sessions', '9f2c1e', '0b6a1c2d-ide-session', 'messages.jsonl'),
        '{"id":"exec-2-usage","timestamp":"2026-10-08T11:00:00.000Z","payload":{"type":"usage_summary","promptTurnSummaries":[{"unit":"credit","usage":2}],"elapsedTime":1000}}\n');
      const more = collectKiroCredits(c);
      expect(more.map((e) => e.credits).sort()).toEqual([1.25, 2]);
    } finally {
      process.env.KOPT_KIRO_HOME = join(tmp, 'empty-kiro-home');
    }
  });

  it('does not double count when the IDE rewrites messages.jsonl, and leaves an in-progress CLI turn for later', () => {
    const home = kiroHomeCopy('home2');
    process.env.KOPT_KIRO_HOME = home;
    try {
      const c = makeConfig('collect2');
      expect(collectKiroCredits(c)).toHaveLength(3);
      // rewrite smaller (compaction): same usage id must not be re-collected
      const msgs = join(home, 'sessions', '9f2c1e', '0b6a1c2d-ide-session', 'messages.jsonl');
      const usageLine = readFileSync(msgs, 'utf8').split('\n').find((l) => l.includes('usage_summary'))!;
      writeFileSync(msgs, usageLine + '\n');
      expect(collectKiroCredits(c)).toEqual([]);
      // CLI file modified just now: its last turn is not settled yet
      const cliPath = join(home, 'sessions', 'cli', '7d1e5f00-cli-session.json');
      const doc = JSON.parse(readFileSync(cliPath, 'utf8'));
      doc.session_state.conversation_metadata.user_turn_metadatas.push({ metering_usage: [{ value: 3, unit: 'credit' }] });
      writeFileSync(cliPath, JSON.stringify(doc));
      expect(collectKiroCredits(c)).toEqual([]);
      const old = new Date(Date.now() - 60_000);
      utimesSync(cliPath, old, old);
      expect(collectKiroCredits(c).map((e) => e.credits)).toEqual([3]);
    } finally {
      process.env.KOPT_KIRO_HOME = join(tmp, 'empty-kiro-home');
    }
  });

  it('survives garbage files', () => {
    const home = join(tmp, 'home-garbage');
    mkdirSync(join(home, 'sessions', 'cli'), { recursive: true });
    mkdirSync(join(home, 'sessions', 'h', 's'), { recursive: true });
    writeFileSync(join(home, 'sessions', 'cli', 'bad.json'), '{not json');
    writeFileSync(join(home, 'sessions', 'cli', 'weird.json'), JSON.stringify({ user_turn_metadatas: [null, 5, { metering_usage: 'x' }] }));
    writeFileSync(join(home, 'sessions', 'h', 's', 'messages.jsonl'), 'garbage\n{"payload":{"type":"usage_summary","promptTurnSummaries":"nope"}}\n');
    process.env.KOPT_KIRO_HOME = home;
    try {
      const evs = collectKiroCredits(makeConfig('garbage'));
      expect(evs.every((e) => e.kind === 'credits' && typeof e.credits === 'number')).toBe(true);
    } finally {
      process.env.KOPT_KIRO_HOME = join(tmp, 'empty-kiro-home');
    }
  });
});

describe('stats', () => {
  it('reports kopt tools with honest savings, governor blocks, context intake and credits per day', () => {
    const c = makeConfig('stats');
    const now = Date.now();
    record({ ts: now, kind: 'tool', tool: 'kopt_run', tokensOut: 300, baselineTokens: 9000 }, c);
    record({ ts: now, kind: 'tool', tool: 'kopt_run', tokensOut: 200, baselineTokens: 1000 }, c);
    record({ ts: now, kind: 'tool', tool: 'kopt_find', tokensOut: 250 }, c);
    record({ ts: now, kind: 'hook', tool: 'read_file', tokensOut: 4000 }, c);
    record({ ts: now, kind: 'hook', tool: 'read_file', tokensOut: 2000 }, c);
    record({ ts: now, kind: 'hook', tool: 'execute_bash', tokensOut: 1500 }, c);
    record({ ts: now, kind: 'hook', tool: 'read_file', decision: 'block', meta: { reason: 'big-read' } }, c);
    record({ ts: now, kind: 'hook', tool: 'execute_bash', decision: 'block', meta: { reason: 'verbose-cmd' } }, c);
    record({ ts: now, kind: 'hook', tool: 'execute_bash', decision: 'block', meta: { reason: 'verbose-cmd' } }, c);
    record({ ts: now, kind: 'session', session: 'a', meta: { event: 'stop', toolCalls: 10 } }, c);
    record({ ts: now, kind: 'session', session: 'a', meta: { event: 'stop', toolCalls: 30 } }, c);
    record({ ts: now, kind: 'credits', credits: 1.5, session: 'a' }, c);
    record({ ts: now, kind: 'credits', credits: 0.5, session: 'a' }, c);
    record({ ts: now - 20 * 86400_000, kind: 'credits', credits: 99, session: 'old' }, c);
    const out = stats(c, { days: 7 });
    const day = new Date(now).toISOString().slice(0, 10);
    expect(out).toMatch(/^kopt stats · .*\(7d\) · 13 events/);
    expect(out).toMatch(/kopt_run\s+2\s+500\s+250\s+10k\s+95%/);
    expect(out).toMatch(/kopt_find\s+1\s+250\s+250\s+-\s+-/);
    expect(out).toContain('governor blocks: verbose-cmd 2 · big-read 1');
    expect(out).toContain('sessions: 1 · tool calls/session avg 30, max 30');
    expect(out).toMatch(/read_file\s+2\s+6\.0k\s+3\.0k\s+80%/);
    expect(out).toMatch(new RegExp(`${day}\\s+2\\.00\\s+2\\s+1\\.000`));
    expect(out).not.toContain('99');
    expect(stats(makeConfig('stats-empty'))).toContain('no telemetry yet');
  });
});
