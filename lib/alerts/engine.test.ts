import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_SETTINGS, EMPTY_ENGINE, type EngineState, type Settings } from '../types.ts';
import { type Candidate, evaluate } from './engine.ts';

const settings: Settings = { ...DEFAULT_SETTINGS };
const t = (minute: number) => new Date(Date.UTC(2026, 9, 31, 12, minute));

function candidate(people: number, over: Partial<Candidate> = {}): Candidate {
  return {
    key: 'metro:12580',
    scope: 'metro',
    label: 'Baltimore, MD',
    people,
    customers: Math.round(people / 2.5),
    detail: '',
    link: '/metros/12580',
    states: ['MD'],
    complete: true,
    ...over,
  };
}

function run(start: EngineState, values: number[], s: Settings = settings, over: Partial<Candidate> = {}) {
  let state = start;
  const kinds: string[] = [];
  values.forEach((people, i) => {
    const r = evaluate(state, [candidate(people, over)], s, t(i * 5));
    state = r.state;
    kinds.push(...r.events.map((e) => e.kind));
  });
  return { state, kinds };
}

describe('opening', () => {
  it('ignores values under the threshold', () => {
    assert.deepEqual(run(EMPTY_ENGINE, [9_999, 9_999, 9_999]).kinds, []);
  });

  it('opens only after the confirmation window', () => {
    assert.deepEqual(run(EMPTY_ENGINE, [10_000]).kinds, []);
    assert.deepEqual(run(EMPTY_ENGINE, [10_000, 12_000]).kinds, ['opened']);
  });

  it('a one-poll blip never alerts', () => {
    assert.deepEqual(run(EMPTY_ENGINE, [20_000, 100, 20_000, 100]).kinds, []);
  });

  it('skips confirmation for huge events', () => {
    assert.deepEqual(run(EMPTY_ENGINE, [50_000]).kinds, ['opened']);
  });

  it('honors state filters and muted metros', () => {
    assert.deepEqual(run(EMPTY_ENGINE, [60_000], { ...settings, states: ['CA'] }).kinds, []);
    assert.deepEqual(run(EMPTY_ENGINE, [60_000], { ...settings, mutedMetros: ['12580'] }).kinds, []);
  });

  it('respects a tuned threshold', () => {
    const quiet = { ...settings, thresholdPeople: 50_000 };
    assert.deepEqual(run(EMPTY_ENGINE, [20_000, 20_000, 20_000], quiet).kinds, []);
  });
});

describe('open alerts', () => {
  it('does not renotify while steady', () => {
    assert.deepEqual(run(EMPTY_ENGINE, [12_000, 12_000, 13_000, 14_000, 15_000]).kinds, ['opened']);
  });

  it('escalates when the event doubles, and again from the new level', () => {
    const { kinds } = run(EMPTY_ENGINE, [10_000, 10_000, 21_000, 22_000, 43_000]);
    assert.deepEqual(kinds, ['opened', 'escalated', 'escalated']);
  });

  it('does not flap around the threshold', () => {
    const { kinds } = run(EMPTY_ENGINE, [12_000, 12_000, 9_000, 11_000, 8_000, 12_000, 7_000]);
    assert.deepEqual(kinds, ['opened']);
  });

  it('resolves only after sustained recovery', () => {
    const low = Array(6).fill(1_000);
    assert.deepEqual(run(EMPTY_ENGINE, [12_000, 12_000, ...low.slice(0, 5)]).kinds, ['opened']);
    assert.deepEqual(run(EMPTY_ENGINE, [12_000, 12_000, ...low]).kinds, ['opened', 'resolved']);
  });

  it('a rebound resets the clear countdown', () => {
    const { kinds } = run(EMPTY_ENGINE, [12_000, 12_000, 1_000, 1_000, 1_000, 1_000, 1_000, 6_000, 1_000, 1_000, 1_000, 1_000, 1_000]);
    assert.deepEqual(kinds, ['opened']);
  });

  it('tracks the peak through resolution', () => {
    let state = run(EMPTY_ENGINE, [12_000, 30_000]).state;
    assert.equal(state.open['metro:12580'].peakPeople, 30_000);
    const low = Array(5).fill(100);
    state = run(state, low).state;
    const r = evaluate(state, [candidate(100)], settings, t(55));
    assert.equal(r.events[0].kind, 'resolved');
    assert.equal(r.events[0].peakPeople, 30_000);
  });

  it('stays open when its area disappears from the data', () => {
    const { state } = run(EMPTY_ENGINE, [12_000, 12_000]);
    const r = evaluate(state, [], settings, t(30));
    assert.deepEqual(r.events, []);
    assert.ok(r.state.open['metro:12580']);
  });

  it('never resolves on incomplete data, however long it lasts', () => {
    const { state } = run(EMPTY_ENGINE, [12_000, 12_000]);
    const { kinds, state: after } = run(state, Array(20).fill(0), settings, { complete: false });
    assert.deepEqual(kinds, []);
    assert.ok(after.open['metro:12580']);
  });

  it('keeps tracking an open alert after its metro is muted', () => {
    const { state } = run(EMPTY_ENGINE, [12_000, 12_000]);
    const muted = { ...settings, mutedMetros: ['12580'] };
    assert.deepEqual(run(state, Array(6).fill(100), muted).kinds, ['resolved']);
  });
});

describe('multiple areas', () => {
  it('tracks areas independently', () => {
    const a = (people: number) => candidate(people);
    const b = (people: number) => candidate(people, { key: 'metro:47900', label: 'Washington, DC' });
    let r = evaluate(EMPTY_ENGINE, [a(12_000), b(100)], settings, t(0));
    r = evaluate(r.state, [a(12_000), b(100)], settings, t(5));
    assert.deepEqual(r.events.map((e) => e.key), ['metro:12580']);
  });
});

describe('when data goes missing', () => {
  const opened = () => run(EMPTY_ENGINE, [50_000]).state;
  const later = (hours: number) => new Date(t(0).getTime() + hours * 3_600_000);

  it('keeps the last trusted count, so a dying feed cannot talk an alert down', () => {
    const { state } = evaluate(opened(), [candidate(0, { complete: false })], settings, later(1));
    assert.equal(state.open['metro:12580'].people, 50_000);
    assert.ok(state.open['metro:12580'].blindSince);
  });

  it('takes the lower count once data is complete again', () => {
    const blind = evaluate(opened(), [candidate(0, { complete: false })], settings, later(1)).state;
    const { state } = evaluate(blind, [candidate(20_000)], settings, later(2));
    assert.equal(state.open['metro:12580'].people, 20_000);
    assert.equal(state.open['metro:12580'].blindSince, undefined);
  });

  it('closes after 12 hours with no complete reading, and says it cannot tell', () => {
    const blind = evaluate(opened(), [candidate(0, { complete: false })], settings, later(1)).state;
    assert.equal(evaluate(blind, [candidate(0, { complete: false })], settings, later(12)).events.length, 0);
    const { state, events } = evaluate(blind, [candidate(0, { complete: false })], settings, later(13));
    assert.equal(state.open['metro:12580'], undefined);
    assert.equal(events[0].blind, true);
    assert.match(events[0].detail, /can't say whether the power is back/);
  });

  it('does not close a blind alert while the count that is left is still high', () => {
    const blind = evaluate(opened(), [candidate(30_000, { complete: false })], settings, later(1)).state;
    assert.ok(evaluate(blind, [candidate(30_000, { complete: false })], settings, later(14)).state.open['metro:12580']);
  });

  it('closes an alert whose area has left the list, after a wait', () => {
    assert.ok(evaluate(opened(), [], settings, later(11)).state.open['metro:12580']);
    const { state, events } = evaluate(opened(), [], settings, later(13));
    assert.equal(state.open['metro:12580'], undefined);
    assert.equal(events[0].blind, true);
  });
});
