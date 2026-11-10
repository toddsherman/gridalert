import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { feedNotes, hugeFeedsOut, type CheckHealth, platformReadings, platformWrong } from './health.ts';
import { digestLines, dueDigest, nextCheck, shapeChanges } from './probes.ts';
import { sources, customersOf } from './registry.ts';
import type { UtilityStatus } from './types.ts';

const HOUR = 3_600_000;
const NOOn = Date.UTC(2026, 10, 2, 12, 7);
const iso = (hoursAgo: number) => new Date(NOOn - hoursAgo * HOUR).toISOString();
const failed = (over: Partial<CheckHealth> = {}): CheckHealth => ({ failsInARow: 1, lastOkAt: iso(1), lastFailAt: iso(0), lastError: 'x', ...over });

describe('nextCheck', () => {
  it('counts failures in a row and clears them on a good read', () => {
    const one = nextCheck(undefined, { ok: false, error: 'HTTP 503', shape: false }, iso(1));
    const two = nextCheck(one, { ok: false, error: 'HTTP 503', shape: false }, iso(0));
    assert.equal(two.failsInARow, 2);
    const back = nextCheck(two, { ok: true, rows: 4 }, iso(0));
    assert.equal(back.failsInARow, 0);
    assert.equal(back.lastError, undefined);
    assert.equal(back.rows, 4);
    assert.equal(back.lastFailAt, iso(0));
  });
});

describe('shapeChanges', () => {
  it('speaks up on the second probe, and only once', () => {
    assert.deepEqual(shapeChanges({}, { MISO: failed({ shape: true }) }).broken, []);
    assert.deepEqual(shapeChanges({}, { MISO: failed({ shape: true, failsInARow: 2 }) }).broken, ['MISO']);
    assert.deepEqual(shapeChanges({}, { MISO: failed({ shape: true, failsInARow: 3, noticedAt: iso(1) }) }).broken, []);
  });

  it('leaves a site that is merely down for the digest', () => {
    assert.deepEqual(shapeChanges({}, { MISO: failed({ failsInARow: 5 }) }).broken, []);
  });

  it('says when one it spoke up about is fixed', () => {
    assert.deepEqual(shapeChanges({ MISO: failed({ noticedAt: iso(2) }) }, { MISO: { failsInARow: 0, lastOkAt: iso(0) } }).fixed, ['MISO']);
  });
});

describe('digestLines', () => {
  it('waits six hours before mentioning an outside check', () => {
    assert.deepEqual(digestLines({ PJM: failed({ lastOkAt: iso(5) }) }, null, NOOn), []);
    assert.match(digestLines({ PJM: failed({ lastOkAt: iso(7) }) }, null, NOOn)[0], /PJM hasn't been readable since/);
  });
});

describe('dueDigest', () => {
  const noon = new Date(NOOn);
  const lines = ['A feed is out.'];

  it('sends nothing before the hour, or twice in a day', () => {
    assert.equal(dueDigest({}, lines, 200, 16, new Date(NOOn - 3 * HOUR)).message, undefined);
    assert.equal(dueDigest({ digestAt: iso(0) }, lines, 200, 16, noon).message, undefined);
  });

  it('sends what changed, and stays silent when nothing has', () => {
    const first = dueDigest({ watchingAt: iso(24) }, lines, 200, 16, noon);
    assert.equal(first.message?.body, 'A feed is out.');
    assert.equal(dueDigest({ digest: lines, digestAt: iso(24), watchingAt: iso(24) }, lines, 200, 16, noon).message, undefined);
  });

  it('says when everything has recovered', () => {
    assert.match(dueDigest({ digest: lines, digestAt: iso(24), watchingAt: iso(24) }, [], 200, 16, noon).message!.body, /has recovered/);
  });

  it('sends one line a week, so silence never has to mean it broke', () => {
    const week = dueDigest({ digest: [], digestAt: iso(24), watchingAt: iso(24 * 7) }, [], 228, 16, noon);
    assert.equal(week.message?.title, 'GridAlert is still watching');
    assert.match(week.message!.body, /228 feeds are live and 16 outside checks are readable/);
    assert.equal(week.state.watchingAt, noon.toISOString());
  });

  it('keeps a long list short', () => {
    const many = Array.from({ length: 20 }, (_, i) => `Line ${i}`);
    assert.match(dueDigest({ watchingAt: iso(24) }, many, 1, 1, noon).message!.body, /And 8 more\.$/);
  });
});

describe('platform readings', () => {
  const kubra = sources.filter((s) => s.method === 'kubra' && customersOf(s) >= 250_000).slice(0, 10);
  const row = (id: string, customersOut: number, over: Partial<UtilityStatus> = {}) => ({ id, name: id, eiaIds: [], method: 'kubra', granularity: 'county', health: 'ok', via: 'direct', customersOut, attributedOut: 0, ...over }) as UtilityStatus;

  it('counts feeds at exactly 0 or not working', () => {
    const [p] = platformReadings({ utilities: kubra.map((s, i) => row(s.id, i < 6 ? 0 : 50)) });
    assert.equal(p.zero, 6);
    assert.equal(platformWrong(p, false), true);
  });

  it('stays quiet at what a calm day looks like', () => {
    const [p] = platformReadings({ utilities: kubra.map((s, i) => row(s.id, i < 3 ? 0 : 50)) });
    assert.equal(platformWrong(p, false), false);
  });

  it('needs to fall further to clear than it took to open', () => {
    const [p] = platformReadings({ utilities: kubra.map((s, i) => row(s.id, i < 5 ? 0 : 50)) });
    assert.equal(platformWrong(p, false), false);
    assert.equal(platformWrong(p, true), true);
  });
});

describe('feedNotes', () => {
  const big = sources.find((s) => customersOf(s) >= 1_000_000)!;
  const mid = sources.find((s) => customersOf(s) >= 250_000 && customersOf(s) < 1_000_000)!;
  const small = sources.find((s) => customersOf(s) >= 10_000 && customersOf(s) < 100_000)!;
  const row = (id: string, over: Partial<UtilityStatus>) => ({ id, name: id, eiaIds: [], method: 'json', granularity: 'county', health: 'ok', via: 'direct', customersOut: 0, attributedOut: 0, ...over }) as UtilityStatus;
  const notes = (...rows: UtilityStatus[]) => feedNotes({ utilities: rows }, NOOn);

  it('notes a large feed down or frozen for six hours', () => {
    assert.match(notes(row(big.id, { health: 'down', lastOkAt: iso(7) }))[0], /has been out since/);
    assert.match(notes(row(big.id, { health: 'frozen', frozenSince: iso(7) }))[0], /has been out since/);
    assert.deepEqual(notes(row(big.id, { health: 'down', lastOkAt: iso(5) })), []);
  });

  it('picks out a feed of a million customers that has been out for an hour', () => {
    const out = (...rows: UtilityStatus[]) => hugeFeedsOut({ utilities: rows }, NOOn).map((u) => u.id);
    assert.deepEqual(out(row(big.id, { health: 'down', lastOkAt: iso(2) }), row(big.id, { health: 'frozen', frozenSince: iso(2) })), [big.id, big.id]);
    assert.deepEqual(out(row(big.id, { health: 'down', lastOkAt: iso(0.5) }), row(mid.id, { health: 'down', lastOkAt: iso(9) }), row(big.id, { lastOkAt: iso(2) })), []);
  });

  it('holds zero runs to the size of the feed', () => {
    assert.match(notes(row(big.id, { zeroSince: iso(25) }))[0], /has read exactly 0/);
    assert.deepEqual(notes(row(mid.id, { zeroSince: iso(25) })), []);
    assert.match(notes(row(mid.id, { zeroSince: iso(73) }))[0], /has read exactly 0/);
  });

  it('leaves small feeds to the coverage table', () => {
    assert.deepEqual(notes(row(small.id, { health: 'down', lastOkAt: iso(100), zeroSince: iso(1000) })), []);
  });

  it('notes a feed reading 0 while ODIN disagrees', () => {
    assert.match(notes(row(small.id, { odinAhead: 3 }))[0], /reads 0 while ODIN shows outages/);
  });
});
