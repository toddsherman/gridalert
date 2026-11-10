import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { areaNames, findSimultaneous, unrelated } from './simultaneous.ts';
import { DEFAULT_SETTINGS, type Blackout, type Evidence } from './types.ts';

const T0 = Date.UTC(2026, 10, 1, 18);
const AT = new Date(T0 + 40 * 60_000).toISOString();
const iso = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const settings = DEFAULT_SETTINGS;

function blackout(name: string, minute: number, over: Partial<Blackout> = {}): Blackout {
  return {
    id: `metro:${name}:${iso(minute)}`, key: `metro:${name}`, scope: 'metro', label: `${name}-Other, TX`, link: '/', states: ['TX'], startedAt: iso(minute), openedAt: iso(minute + 5),
    people: 30_000, peakPeople: 30_000, peakCustomers: 12_000, utilities: [{ id: `util-${name}`, name: `${name} Power`, customersOut: 12_000 }], counties: [], cause: 'unknown', evidence: [],
    checked: ['storm warnings', 'wildfires'], utilityCauses: [], ...over,
  };
}

const three = () => [blackout('Houston', 0), blackout('Miami', 10), blackout('Atlanta', 25)];
const find = (list: Blackout[], prev: ReturnType<typeof findSimultaneous>['list'] = [], s = settings) => findSimultaneous(prev, list, s, AT);
const storm: Evidence = { id: 'x', kind: 'storm-report', strong: true, label: 'Damaging wind reported near Katy, TX', source: 'x', at: iso(0) };
const advisory: Evidence = { id: 'y', kind: 'weather', strong: false, label: 'Wind Advisory, Harris County, TX', source: 'x', at: iso(0) };

describe('findSimultaneous', () => {
  it('flags three unrelated areas starting within 30 minutes', () => {
    const { list, events } = find(three());
    assert.equal(list.length, 1);
    assert.equal(list[0].members.length, 3);
    assert.equal(events[0].kind, 'simultaneous');
    assert.equal(events[0].label, 'Houston, Miami and Atlanta');
    assert.equal(events[0].customers, 36_000);
    assert.match(events[0].detail, /3 unrelated areas started within 25 minutes/);
    assert.match(events[0].detail, /No storm warnings or wildfires found in any of them/);
    assert.match(events[0].detail, /does not mean an attack/);
  });

  it('does not flag two areas', () => {
    assert.deepEqual(find(three().slice(0, 2)).events, []);
  });

  it('does not flag starts spread beyond the window', () => {
    assert.deepEqual(find([blackout('Houston', 0), blackout('Miami', 20), blackout('Atlanta', 40)]).events, []);
  });

  it('ignores an area below the customer level', () => {
    assert.deepEqual(find([...three().slice(0, 2), blackout('Atlanta', 5, { peakCustomers: 9_999 })]).events, []);
  });

  it('ignores areas that are still being checked or are explained', () => {
    assert.deepEqual(find([...three().slice(0, 2), blackout('Atlanta', 5, { cause: 'checking' })]).events, []);
    assert.deepEqual(find([...three().slice(0, 2), blackout('Atlanta', 5, { cause: 'explained', evidence: [storm] })]).events, []);
  });

  it('ignores an area with weather context, because a windy front can start several at once', () => {
    assert.deepEqual(find([...three().slice(0, 2), blackout('Atlanta', 5, { evidence: [advisory] })]).events, []);
  });

  it('leaves out an area whose count has not moved, until the hold runs out', () => {
    const stuck = { reading: { at: iso(5), parts: {}, before: 0 } };
    assert.deepEqual(find([...three().slice(0, 2), blackout('Atlanta', 5, stuck)]).events, []);
    const late = findSimultaneous([], [...three().slice(0, 2), blackout('Atlanta', 5, stuck)], settings, iso(70));
    assert.match(late.events[0].detail, /The count in Atlanta has not moved/);
  });

  it('counts an area whose count has moved', () => {
    const moved = { reading: { at: iso(10), parts: {}, before: 12_000 } };
    assert.equal(find([...three().slice(0, 2), blackout('Atlanta', 5, moved)]).events.length, 1);
    assert.doesNotMatch(find([...three().slice(0, 2), blackout('Atlanta', 5, moved)]).events[0].detail, /has not moved/);
  });

  it('still counts an area where a utility map only shows context', () => {
    const label: Evidence = { ...advisory, kind: 'utility', label: 'Utility map says Equipment Problems' };
    assert.equal(find([...three().slice(0, 2), blackout('Atlanta', 5, { evidence: [label] })]).events.length, 1);
  });

  it('counts one utility across several areas only once', () => {
    const shared = { utilities: [{ id: 'one-utility', name: 'One', customersOut: 1 }] };
    assert.deepEqual(find([blackout('Houston', 0, shared), blackout('Miami', 5, shared), blackout('Atlanta', 10)]).events, []);
  });

  it('counts a reopened alert in one area only once', () => {
    assert.deepEqual(find([blackout('Houston', 0), { ...blackout('Houston', 10), id: 'second' }, blackout('Miami', 15)]).events, []);
  });

  it('does not flag a group that has fully ended', () => {
    assert.deepEqual(find(three().map((b) => ({ ...b, resolvedAt: AT }))).events, []);
  });

  it('flags a group while at least one area is still out', () => {
    const list = three();
    list[0].resolvedAt = AT;
    list[1].resolvedAt = AT;
    assert.equal(find(list).events.length, 1);
  });

  it('counts a sudden jump inside an area that already had an alert open', () => {
    const busy = blackout('Atlanta', -180, { surgeAt: iso(15), surgeCustomers: 12_000, peakCustomers: 20_000 });
    const { events } = find([...three().slice(0, 2), busy]);
    assert.equal(events.length, 1);
    assert.match(events[0].detail, /started within 15 minutes/);
  });

  it('ignores a jump too small to count, even in a large blackout', () => {
    const busy = blackout('Atlanta', -180, { surgeAt: iso(15), surgeCustomers: 6_000, peakCustomers: 80_000 });
    assert.deepEqual(find([...three().slice(0, 2), busy]).events, []);
  });

  it('notes when every area reaches us through one vendor', () => {
    const kubra = (id: string) => ({ utilities: [{ id, name: id, customersOut: 1 }] });
    const { events } = find([blackout('Houston', 0, kubra('dominion-seed')), blackout('Miami', 5, kubra('comed')), blackout('Atlanta', 10, kubra('dominion-sc'))]);
    assert.match(events[0].detail, /reach us through Kubra/);
    assert.doesNotMatch(find(three()).events[0].detail, /reach us through/);
  });

  it('can be turned off, and honors changed levels', () => {
    assert.deepEqual(find(three(), [], { ...settings, simultaneousAreas: 0 }).events, []);
    assert.equal(find(three().slice(0, 2), [], { ...settings, simultaneousAreas: 2 }).events.length, 1);
    assert.deepEqual(find(three(), [], { ...settings, simultaneousCustomers: 20_000 }).events, []);
  });

  it('alerts once, and adds a late starter without another alert', () => {
    const first = find(three());
    const again = find(three(), first.list);
    assert.deepEqual(again.events, []);
    const later = find([...three(), blackout('Denver', 28)], first.list);
    assert.deepEqual(later.events, []);
    assert.equal(later.list[0].members.length, 4);
  });

  it('stands down once when explanations leave too few areas', () => {
    const first = find(three());
    const list = three();
    list[0] = { ...list[0], cause: 'explained', evidence: [storm] };
    const later = find(list, first.list);
    assert.equal(later.events[0].kind, 'simultaneous-explained');
    assert.match(later.events[0].detail, /Fewer than 3 areas remain unexplained \(2 left\)/);
    assert.match(later.events[0].detail, /Houston: Damaging wind reported near Katy, TX/);
    assert.ok(later.list[0].standDownAt);
    assert.deepEqual(find(list, later.list).events, []);
  });

  it('keeps standing while enough areas remain', () => {
    const list = [...three(), blackout('Denver', 15)];
    const first = find(list);
    list[0] = { ...list[0], cause: 'explained', evidence: [storm] };
    const later = find(list, first.list);
    assert.deepEqual(later.events, []);
    assert.equal(later.list[0].standDownAt, undefined);
  });

  it('does not reuse a stood-down group to raise a new alert for the same blackouts', () => {
    const first = find(three());
    const list = three();
    list[0] = { ...list[0], cause: 'explained', evidence: [storm] };
    const down = find(list, first.list);
    assert.deepEqual(find(three(), down.list).events, []);
  });

  it('lets blackouts from a stood-down group join a new one with a new area in it', () => {
    const first = find(three());
    const list = three();
    list[0] = { ...list[0], cause: 'explained', evidence: [storm] };
    const down = find(list, first.list);
    const again = find([list[0], list[1], list[2], blackout('Denver', 15)], down.list);
    assert.deepEqual(again.events.map((e) => e.kind), ['simultaneous']);
    assert.notEqual(again.list[0].id, again.list[1].id);
  });

  it('closes a group whose blackouts are past checking, so old records leaving cannot stand it down', () => {
    const first = find(three());
    const longGone = three().map((b) => ({ ...b, resolvedAt: '2026-11-01T18:00:00.000Z' }));
    const closed = findSimultaneous(first.list, longGone, settings, '2026-11-03T18:00:00.000Z');
    assert.ok(closed.list[0].closedAt);
    assert.deepEqual(closed.events, []);
    assert.deepEqual(findSimultaneous(closed.list, longGone.slice(0, 1), settings, '2026-11-04T18:00:00.000Z').events, []);
  });
});

describe('helpers', () => {
  it('keeps the largest blackout for a shared utility', () => {
    const shared = { utilities: [{ id: 'one', name: 'One', customersOut: 1 }] };
    const kept = unrelated([blackout('Houston', 0, { ...shared, peakCustomers: 5 }), blackout('Miami', 5, { ...shared, peakCustomers: 9 })]);
    assert.deepEqual(kept.map((b) => b.key), ['metro:Miami']);
  });

  it('names a handful of areas and summarizes the rest', () => {
    assert.equal(areaNames(['A', 'B'].map((n) => blackout(n, 0))), 'A and B');
    assert.equal(areaNames(['A', 'B', 'C', 'D', 'E', 'F'].map((n) => blackout(n, 0))), 'A, B, C, D and 2 more');
  });
});
