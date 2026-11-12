import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatEvent } from './alerts/notify.ts';
import { drillEvent, drillMonth, rehearse, runDrill } from './drill.ts';
import { DEFAULT_SETTINGS } from './types.ts';

const NOW = new Date(Date.UTC(2026, 11, 1, 17, 2));

describe('the monthly drill', () => {
  it('raises the high-priority alert for a made-up blackout, about ten minutes in', () => {
    const result = rehearse(DEFAULT_SETTINGS, NOW);
    assert.equal(result.ok, true);
    assert.equal(result.customers, 80_000);
    assert.ok(result.minutes! >= 10 && result.minutes! <= 20, `took ${result.minutes} minutes`);
  });

  it('follows the level the owner has set', () => {
    assert.equal(rehearse({ ...DEFAULT_SETTINGS, unexplainedCustomers: 200_000 }, NOW).ok, true);
  });

  it('is not thrown by where the owner has limited alerts to', () => {
    assert.equal(rehearse({ ...DEFAULT_SETTINGS, states: ['NY'], mutedMetros: ['26420'] }, NOW).ok, true);
  });

  it('fails, and says why, when high-priority alerts are turned off', () => {
    const result = rehearse({ ...DEFAULT_SETTINGS, unexplainedCustomers: 0 }, NOW);
    assert.equal(result.ok, false);
    assert.match(result.reason!, /turned off/);
  });

  it('fails when the outage can never open as a blackout', () => {
    const result = rehearse({ ...DEFAULT_SETTINGS, thresholdPeople: 10_000_000, confirmPolls: 99 }, NOW);
    assert.equal(result.ok, false);
    assert.match(result.reason!, /never opened/);
  });

  it('reports rules that throw as a failure', () => {
    const message = formatEvent(runDrill(null as never, NOW));
    assert.match(message.title, /FAILED/);
  });

  it('is due from noon Eastern on the 1st, once a month', () => {
    assert.equal(drillMonth(new Date(Date.UTC(2026, 11, 1, 16, 59))), undefined);
    assert.equal(drillMonth(new Date(Date.UTC(2026, 11, 1, 17, 0))), '2026-12');
    assert.equal(drillMonth(new Date(Date.UTC(2026, 11, 31, 3))), '2026-12');
  });

  it('is sent at the priority of a real alert, and says it is a test', () => {
    const passed = formatEvent(drillEvent({ ok: true, customers: 80_000, minutes: 10 }, NOW.toISOString()));
    assert.equal(passed.urgent, true);
    assert.match(passed.title, /^Drill passed: this is a test/);
    assert.match(passed.body, /Nothing is out/);
    const failed = formatEvent(drillEvent({ ok: false, customers: 80_000, reason: 'no alert was raised' }, NOW.toISOString()));
    assert.equal(failed.urgent, true);
    assert.match(failed.title, /^Drill FAILED/);
    assert.match(failed.body, /no alert was raised/);
  });
});
