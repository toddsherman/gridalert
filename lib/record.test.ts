import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyChecks } from './blackouts.ts';
import { outcomeOf, spanOf, trackRecord } from './record.ts';
import type { Blackout, Evidence, SimultaneousOutage } from './types.ts';

const LEVEL = 50_000;
const START = '2026-11-08T04:45:00.000Z';
const after = (minutes: number) => new Date(Date.parse(START) + minutes * 60_000).toISOString();

const gust: Evidence = { id: 'gust', kind: 'wind-gust', strong: true, label: 'Measured gust of 47 mph at KSEA during a Wind Advisory', source: 'AWC', at: after(29) };

function blackout(over: Partial<Blackout> = {}): Blackout {
  return { id: `metro:42660:${over.startedAt ?? START}`, key: 'metro:42660', scope: 'metro', label: 'Seattle-Tacoma-Bellevue, WA', link: '/metros/42660', states: ['WA'], startedAt: START, openedAt: after(5), resolvedAt: after(600), people: 0, peakPeople: 25_000, peakCustomers: 10_000, utilities: [], counties: [], cause: 'unknown', evidence: [], checked: [], utilityCauses: [], ...over };
}

describe('spanOf', () => {
  it('reads as minutes, then hours', () => {
    assert.equal(spanOf(35 * 60_000), '35 minutes');
    assert.equal(spanOf(60_000), '1 minute');
    assert.equal(spanOf(0), '1 minute');
    assert.equal(spanOf(3 * 3_600_000), '3 hours');
  });
});

describe('outcomeOf', () => {
  it('says a large outage was explained, how fast, and that nothing was sent', () => {
    const b = blackout({ peakCustomers: 73_164, jumpCustomers: 58_089, cause: 'explained', evidence: [gust], explainedAt: after(35) });
    assert.equal(outcomeOf(b, LEVEL), 'Reached the alert level: 58,089 customers went out within 30 minutes. Explained 35 minutes in: Measured gust of 47 mph at KSEA during a Wind Advisory. No alert was sent.');
  });

  it('falls back to the last check for records from before the time was stored', () => {
    const b = blackout({ jumpCustomers: 58_089, cause: 'explained', evidence: [gust], checkedAt: after(35) });
    assert.match(outcomeOf(b, LEVEL), /Explained 35 minutes in/);
  });

  it('says a smaller one was under the level', () => {
    assert.equal(outcomeOf(blackout({ peakCustomers: 41_291, jumpCustomers: 41_142 }), LEVEL), 'Under the alert level. No cause was found. No alert was sent.');
  });

  it('counts a slow outage of three times the level', () => {
    assert.match(outcomeOf(blackout({ peakCustomers: 160_000, jumpCustomers: 20_000 }), LEVEL), /^Reached the alert level: over 150,000 customers out\./);
  });

  it('reports an alert that still stands', () => {
    const b = blackout({ jumpCustomers: 60_000, peakCustomers: 60_000, unexplainedNoticeAt: after(15) });
    assert.match(outcomeOf(b, LEVEL), /An alert went out 15 minutes in\. No cause was found\.$/);
  });

  it('reports an alert that was stood down', () => {
    const b = blackout({ jumpCustomers: 60_000, peakCustomers: 60_000, cause: 'explained', evidence: [gust], unexplainedNoticeAt: after(15), explainedNoticeAt: after(40), explainedAt: after(40) });
    assert.match(outcomeOf(b, LEVEL), /An alert went out 15 minutes in\. It was stood down 25 minutes later: Measured gust/);
  });

  it('measures from a new jump when an explained outage reopened', () => {
    const b = blackout({ jumpCustomers: 60_000, checkFrom: after(120), unexplainedNoticeAt: after(135) });
    assert.match(outcomeOf(b, LEVEL), /An alert went out 15 minutes in/);
  });

  it('says so when a report of a deliberate cause sent the alert', () => {
    assert.match(outcomeOf(blackout({ deliberateNoticeAt: after(90) }), LEVEL), /^Under the alert level\. No cause was found\. An alert went out because it was reported as deliberate, unconfirmed\.$/);
  });
});

describe('trackRecord', () => {
  const seattle = blackout({ peakCustomers: 73_164, jumpCustomers: 58_089, cause: 'explained', evidence: [gust], explainedAt: after(35) });
  const sacramento = blackout({ id: 'metro:40900:x', key: 'metro:40900', label: 'Sacramento-Roseville-Folsom, CA', link: '/metros/40900', startedAt: '2026-11-03T21:00:00.000Z', peakCustomers: 41_291, jumpCustomers: 41_142 });
  const small = blackout({ id: 'small', startedAt: '2026-11-01T00:05:00.000Z', peakCustomers: 6_000 });

  it('counts everything, and lists only what came near the level', () => {
    const r = trackRecord([seattle, sacramento, small], [], { unexplainedCustomers: LEVEL });
    assert.deepEqual({ since: r.since, tracked: r.tracked, reached: r.reached, explained: r.explained, alerts: r.alerts }, { since: '2026-11-01T00:05:00.000Z', tracked: 3, reached: 1, explained: 1, alerts: 0 });
    assert.deepEqual(r.rows.map((x) => [x.label, x.customers, x.alerted]), [['Seattle-Tacoma-Bellevue, WA', 73_164, false], ['Sacramento-Roseville-Folsom, CA', 41_291, false]]);
  });

  it('counts alerts of every kind, and always lists an outage that sent one', () => {
    const sent = blackout({ id: 'sent', peakCustomers: 8_000, deliberateNoticeAt: after(90) });
    const r = trackRecord([sent, seattle], [{ id: 's', startedAt: START, members: [], noticeAt: after(20) } satisfies SimultaneousOutage], { unexplainedCustomers: LEVEL });
    assert.equal(r.alerts, 2);
    assert.deepEqual(r.rows.map((x) => [x.id, x.alerted]), [['sent', true], [seattle.id, false]]);
  });

  it('follows the level the owner has set', () => {
    assert.equal(trackRecord([sacramento], [], { unexplainedCustomers: 40_000 }).reached, 1);
  });

  it('still lists large outages when alerts are turned off', () => {
    const r = trackRecord([seattle, small], [], { unexplainedCustomers: 0 });
    assert.equal(r.reached, 0);
    assert.equal(r.rows.length, 1);
  });

  it('is empty with nothing stored', () => {
    assert.deepEqual(trackRecord([], [], { unexplainedCustomers: LEVEL }), { since: undefined, tracked: 0, reached: 0, explained: 0, alerts: 0, rows: [] });
  });
});

describe('when a cause is found', () => {
  const QUIET = { weather: [], reports: [], gusts: [], fires: [], quakes: [], kp: [] };

  it('is stored once, and cleared if the cause no longer stands', () => {
    const first = applyChecks(blackout({ evidence: [gust], resolvedAt: undefined }), QUIET, [], new Date(after(35)));
    assert.equal(first.cause, 'explained');
    assert.equal(first.explainedAt, after(35));
    assert.equal(applyChecks(first, QUIET, [], new Date(after(40))).explainedAt, after(35));
    assert.equal(applyChecks(blackout({ resolvedAt: undefined }), QUIET, [], new Date(after(35))).explainedAt, undefined);
  });
});
