import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { frozenSince, type LastGood, stuckSince, trackChanges } from './collector.ts';

const T0 = Date.UTC(2026, 10, 1, 18);
const HOUR = 3_600_000;
const iso = (hours: number) => new Date(T0 + hours * HOUR).toISOString();
const good = (over: Partial<LastGood> = {}): LastGood => ({ at: iso(0), customersOut: 500, counties: {}, ...over });
const track = (prior: LastGood | undefined, hours: number, reading = { customersOut: 500, asOf: 'a' as string | undefined }) => {
  const at = iso(hours);
  return { ...good({ at, customersOut: reading.customersOut }), ...trackChanges(reading, prior, at) };
};

describe('trackChanges', () => {
  it('dates a new clock and a new reading from now', () => {
    const first = track(undefined, 0);
    assert.equal(first.clockAt, iso(0));
    assert.equal(first.digestAt, iso(0));
  });

  it('keeps the old date while nothing changes', () => {
    const later = track(track(undefined, 0), 1);
    assert.equal(later.clockAt, iso(0));
    assert.equal(later.digestAt, iso(0));
  });

  it('notices a clock moving on its own, and a reading on its own', () => {
    const clock = track(track(undefined, 0), 1, { customersOut: 500, asOf: 'b' });
    assert.equal(clock.clockAt, iso(1));
    assert.equal(clock.digestAt, iso(0));
    const reading = track(track(undefined, 0), 1, { customersOut: 501, asOf: 'a' });
    assert.equal(reading.clockAt, iso(0));
    assert.equal(reading.digestAt, iso(1));
  });

  it('notices a change inside the area list when the total is the same', () => {
    const areas = (a: number, b: number) => [{ name: 'A', kind: 'county' as const, customersOut: a }, { name: 'B', kind: 'county' as const, customersOut: b }];
    const one = trackChanges({ customersOut: 10, areas: areas(4, 6) }, undefined, iso(0));
    const two = trackChanges({ customersOut: 10, areas: areas(6, 4) }, good(one), iso(1));
    assert.equal(two.digestAt, iso(1));
  });

  it('leaves the clock out of a feed that has none', () => {
    const noClock = track(undefined, 0, { customersOut: 500, asOf: undefined });
    assert.equal(noClock.clock, undefined);
    assert.equal(noClock.clockAt, undefined);
  });
});

describe('frozenSince', () => {
  const now = T0 + 24 * HOUR;
  const hoursAgo = (hours: number) => new Date(now - hours * HOUR).toISOString();

  it('calls a feed live while its clock runs', () => {
    assert.equal(frozenSince(good({ clockAt: hoursAgo(1.9), digestAt: hoursAgo(1.9) }), now), undefined);
  });

  it('calls a feed frozen once its clock has stopped for two hours, whatever it reads', () => {
    assert.equal(frozenSince(good({ customersOut: 0, clockAt: hoursAgo(2), digestAt: hoursAgo(2) }), now), hoursAgo(2));
  });

  it('gives a feed with no clock twelve hours, and only with outages showing', () => {
    assert.equal(frozenSince(good({ digestAt: hoursAgo(11.9) }), now), undefined);
    assert.equal(frozenSince(good({ digestAt: hoursAgo(12) }), now), hoursAgo(12));
    assert.equal(frozenSince(good({ customersOut: 99, digestAt: hoursAgo(48) }), now), undefined);
  });

  it('catches a stuck reading behind a clock that always runs', () => {
    assert.equal(frozenSince(good({ clockAt: hoursAgo(0), digestAt: hoursAgo(12) }), now), hoursAgo(12));
  });
});

describe('stuckSince', () => {
  const now = T0 + 24 * HOUR;
  const minutesAgo = (m: number) => new Date(now - m * 60_000).toISOString();

  it('flags a large feed whose clock has stopped for 45 minutes', () => {
    assert.equal(stuckSince(good({ clockAt: minutesAgo(45) }), true, 500_000, now), minutesAgo(45));
    assert.equal(stuckSince(good({ clockAt: minutesAgo(44) }), true, 500_000, now), undefined);
  });

  it('flags a large feed that has stopped answering', () => {
    assert.equal(stuckSince(good({ at: minutesAgo(50) }), false, 500_000, now), minutesAgo(50));
  });

  it('ignores a small feed', () => {
    assert.equal(stuckSince(good({ clockAt: minutesAgo(600) }), true, 99_999, now), undefined);
  });

  it('cannot judge a feed that answers but has no clock', () => {
    assert.equal(stuckSince(good({ at: minutesAgo(1) }), true, 500_000, now), undefined);
  });

  it('cannot judge a feed it has never read', () => {
    assert.equal(stuckSince(undefined, false, 500_000, now), undefined);
  });
});
