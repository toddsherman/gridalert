import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyChecks, areaCounties, causeLine, causesHere, causeStatus, needsCheck, operatorsToRead, statementsDue, stormCheckFailed, syncBlackouts, takeNotices, trimBlackouts, withCause, withNews, withRead, withStatements } from './blackouts.ts';
import { formatEvent } from './alerts/notify.ts';
import type { World } from './causes/feeds.ts';
import { sources } from './registry.ts';
import { DEFAULT_SETTINGS, EMPTY_ENGINE, type AlertEvent, type Blackout, type EngineState, type OpenAlert, type Snapshot } from './types.ts';

const HOUR = 3_600_000;
const OPENED = '2026-11-01T18:10:00.000Z';
const STARTED = '2026-11-01T18:00:00.000Z';
const HOUSTON = '26420';
const HARRIS = '48201';
const quiet: World = { weather: [], reports: [], fires: [], quakes: [], kp: [], gusts: [] };

function alert(over: Partial<OpenAlert> = {}): OpenAlert {
  return { key: `metro:${HOUSTON}`, scope: 'metro', label: 'Houston, TX', openedAt: OPENED, startedAt: STARTED, lastSeenAt: OPENED, people: 20_000, peakPeople: 20_000, notifiedPeople: 20_000, belowPolls: 0, ...over };
}

const engine = (...alerts: OpenAlert[]): EngineState => ({ ...EMPTY_ENGINE, open: Object.fromEntries(alerts.map((a) => [a.key, a])) });

function snapshot(customersOut = 8000, counties = [{ fips: HARRIS, name: 'Harris', customersOut }]): Snapshot {
  const metro = { cbsa: HOUSTON, name: 'Houston, TX', states: ['TX'], population: 7_000_000, customersOut, estimatedPeople: customersOut * 2.5, utilities: [{ id: 'centerpoint', name: 'CenterPoint', customersOut }], counties, coverage: 1, gaps: [] };
  return { metros: [metro], utilities: [] } as unknown as Snapshot;
}

const open = (over: Partial<Blackout> = {}): Blackout => ({ ...syncBlackouts([], engine(alert()), snapshot(), 2.5, OPENED)[0], ...over });

describe('syncBlackouts', () => {
  it('opens a record from an alert', () => {
    const b = open();
    assert.equal(b.id, `metro:${HOUSTON}:${OPENED}`);
    assert.equal(b.startedAt, STARTED);
    assert.equal(b.cause, 'checking');
    assert.equal(b.peakCustomers, 8000);
    assert.deepEqual(b.counties, [HARRIS]);
  });

  it('dates an alert from before start tracking by when it opened', () => {
    assert.equal(syncBlackouts([], engine(alert({ startedAt: undefined })), snapshot(), 2.5, OPENED)[0].startedAt, OPENED);
  });

  it('does not reset a record that is still open', () => {
    const first = open({ cause: 'unknown', checked: ['storm warnings'] });
    const [b] = syncBlackouts([first], engine(alert({ people: 30_000, peakPeople: 30_000 })), snapshot(12_000), 2.5, OPENED);
    assert.equal(b.cause, 'unknown');
    assert.deepEqual(b.checked, ['storm warnings']);
    assert.equal(b.peakPeople, 30_000);
    assert.equal(b.peakCustomers, 12_000);
  });

  it('keeps the peak when the count falls', () => {
    const [b] = syncBlackouts([open({ peakCustomers: 50_000 })], engine(alert()), snapshot(1000), 2.5, OPENED);
    assert.equal(b.peakCustomers, 50_000);
  });

  it('records when the count last set a new high', () => {
    const first = open();
    const flat = syncBlackouts([first], engine(alert()), snapshot(), 2.5, '2026-11-01T19:00:00.000Z')[0];
    assert.equal(flat.peakAt, OPENED);
    const higher = syncBlackouts([flat], engine(alert({ peakPeople: 90_000 })), snapshot(), 2.5, '2026-11-01T20:00:00.000Z')[0];
    assert.equal(higher.peakAt, '2026-11-01T20:00:00.000Z');
  });

  it('reports the alert\'s own peak when created after the outage has fallen', () => {
    const [b] = syncBlackouts([], engine(alert({ people: 2000, peakPeople: 50_000 })), snapshot(800), 2.5, OPENED);
    assert.equal(b.peakCustomers, 20_000);
  });

  it('notes a sudden jump inside an open blackout as a surge', () => {
    const t = (minute: number) => Date.parse(STARTED) + minute * 60_000;
    const trail = { t: [t(0), t(60), t(120), t(125), t(130)], people: { [`metro:${HOUSTON}`]: [12_000, 12_000, 12_000, 40_000, 80_000] } };
    const [b] = syncBlackouts([], { ...engine(alert({ peakPeople: 80_000 })), trail }, snapshot(), 2.5, OPENED);
    assert.equal(b.surgeAt, new Date(t(125)).toISOString());
    assert.equal(b.surgeCustomers, 27_200);
  });

  it('keeps the surge after the count stops climbing', () => {
    const first = open({ surgeAt: OPENED, surgeCustomers: 27_200 });
    const [b] = syncBlackouts([first], { ...engine(alert()), trail: { t: [1, 2], people: { [`metro:${HOUSTON}`]: [80_000, 70_000] } } }, snapshot(), 2.5, OPENED);
    assert.equal(b.surgeCustomers, 27_200);
  });

  it('does not call the first rise a surge', () => {
    const t = (minute: number) => Date.parse(STARTED) + minute * 60_000;
    const trail = { t: [t(0), t(5), t(10)], people: { [`metro:${HOUSTON}`]: [100, 20_000, 80_000] } };
    assert.equal(syncBlackouts([], { ...engine(alert()), trail }, snapshot(), 2.5, OPENED)[0].surgeAt, undefined);
  });

  it('closes a record when its alert is gone', () => {
    const [b] = syncBlackouts([open()], engine(), snapshot(), 2.5, '2026-11-01T20:00:00.000Z');
    assert.equal(b.resolvedAt, '2026-11-01T20:00:00.000Z');
  });

  it('treats a reopened alert as a new blackout', () => {
    const list = syncBlackouts([open({ resolvedAt: '2026-11-01T19:00:00.000Z' })], engine(alert({ openedAt: '2026-11-01T22:00:00.000Z', startedAt: '2026-11-01T21:50:00.000Z' })), snapshot(), 2.5, '2026-11-01T22:00:00.000Z');
    assert.equal(list.length, 2);
    assert.equal(list[0].startedAt, '2026-11-01T21:50:00.000Z');
  });

  it('ignores a county with only a trace of the outage', () => {
    const counties = [{ fips: HARRIS, name: 'Harris', customersOut: 7900 }, { fips: '48039', name: 'Brazoria', customersOut: 100 }];
    assert.deepEqual(open({ ...syncBlackouts([], engine(alert()), snapshot(8000, counties), 2.5, OPENED)[0] }).counties, [HARRIS]);
  });
});

describe('withNews', () => {
  const NOW = Date.parse(STARTED) + 2 * HOUR;
  const big = (over: Partial<Blackout> = {}) => open({ peakCustomers: 60_000, ...over });
  const houston = { name: 'Houston', state: 'TX', lat: 29.76, lon: -95.37 };
  const story = (title: string, minutes = 30, over = {}) => ({ at: Date.parse(STARTED) + minutes * 60_000, source: 'khou.com', url: `u:${title}`, title, places: [houston], ...over });
  const log = (...items: Array<ReturnType<typeof story>>) => ({ through: NOW, items });

  it('adds a story about the area', () => {
    const [entry] = withNews(big(), log(story('Thousands lose power in Houston')), NOW).timeline!;
    assert.equal(entry.title, 'Thousands lose power in Houston');
    assert.equal(entry.source, 'khou.com');
    assert.equal(entry.deliberate, undefined);
  });

  it('flags wording that points at people', () => {
    assert.equal(withNews(big(), log(story("Sheriff: 'intentional vandalism' caused power outage")), NOW).timeline![0].deliberate, true);
  });

  it('counts copies of a wire story once', () => {
    const copies = [story('Thousands lose power in Houston', 30, { source: 'a.com', url: 'a' }), story('Thousands Lose Power in Houston', 40, { source: 'b.com', url: 'b' })];
    assert.equal(withNews(big(), log(...copies), NOW).timeline!.length, 1);
  });

  it('keeps what it already has', () => {
    const first = withNews(big(), log(story('Thousands lose power in Houston')), NOW);
    assert.equal(withNews(first, log(story('Outage in Houston is over', 90)), NOW).timeline!.length, 2);
  });

  it('skips stories from well before the blackout', () => {
    assert.equal(withNews(big(), log(story('Thousands lose power in Houston', -120)), NOW).timeline, undefined);
  });

  it('records how far the news was read, so silence means something', () => {
    assert.equal(withNews(big(), log(), NOW).newsThrough, new Date(NOW).toISOString());
    assert.equal(withNews(big(), { through: 0, items: [] }, NOW).newsThrough, undefined);
  });

  it('skips blackouts too small to matter', () => {
    assert.equal(withNews(open({ peakCustomers: 9_999 }), log(story('Thousands lose power in Houston')), NOW).timeline, undefined);
  });

  it('keeps collecting for a day after a blackout closes, then stops', () => {
    const closed = big({ resolvedAt: STARTED });
    assert.equal(withNews(closed, log(story('Thousands lose power in Houston')), Date.parse(STARTED) + 23 * HOUR).timeline!.length, 1);
    assert.equal(withNews(closed, log(story('Thousands lose power in Houston')), Date.parse(STARTED) + 25 * HOUR).timeline, undefined);
  });

  it('attaches an unplaced official statement only to a large blackout', () => {
    const statement = story('CISA Statement on Electric Sector Incident', 30, { source: 'CISA', places: [], official: true });
    assert.equal(withNews(big(), log(statement), NOW).timeline![0].official, true);
    assert.equal(withNews(big({ peakCustomers: 20_000 }), log(statement), NOW).timeline, undefined);
  });

  it('keeps official and deliberate entries when there are too many', () => {
    const many = Array.from({ length: 20 }, (_, i) => story(`Power outage in Houston, update ${i}`, i));
    const b = withNews(big(), log(...many, story('Houston substation attacked, outage follows', 500)), NOW);
    assert.equal(b.timeline!.length, 12);
    assert.ok(b.timeline!.some((e) => e.deliberate));
  });
});

describe('reading stories for statements', () => {
  const story = (url: string, over = {}) => ({ at: STARTED, source: 's', title: url, url, ...over });
  const alerted = (over: Partial<Blackout> = {}) => open({ unexplainedNoticeAt: OPENED, timeline: [story('a'), story('b')], ...over });
  const statement = (quote: string) => ({ at: STARTED, source: 's', url: 'a', speaker: 'Entergy', speakerType: 'utility' as const, cause: 'equipment' as const, claim: 'c', quote });
  const NOW = Date.parse(STARTED) + HOUR;

  it('reads a blackout that sent a high-priority alert and has new stories', () => {
    assert.equal(statementsDue([open(), alerted()], NOW)?.unexplainedNoticeAt, OPENED);
    assert.ok(statementsDue([alerted({ unexplainedNoticeAt: undefined, deliberateNoticeAt: OPENED })], NOW));
  });

  it('skips one with no alert, nothing new, or official statements only', () => {
    assert.equal(statementsDue([open({ timeline: [story('a')] })], NOW), undefined);
    assert.equal(statementsDue([alerted({ statementUrls: ['a', 'b'] })], NOW), undefined);
    assert.equal(statementsDue([alerted({ timeline: [story('a', { official: true })] })], NOW), undefined);
  });

  it('stops after six reads, which is what caps the cost', () => {
    assert.equal(statementsDue([alerted({ statementReads: 6 })], NOW), undefined);
  });

  it('records what was read, so nothing is paid for twice, even if nothing came of it', () => {
    const b = withRead(alerted(), ['a', 'b']);
    assert.deepEqual(b.statementUrls, ['a', 'b']);
    assert.equal(b.statementReads, 1);
    assert.equal(statementsDue([b], NOW), undefined);
  });

  it('keeps one copy of a statement found again later', () => {
    const once = withStatements(alerted(), [statement('failed transformer')]);
    assert.equal(withStatements(once, [statement('failed transformer'), statement('a second thing')]).statements?.length, 2);
  });

  it('never changes the cause, even when a utility states one', () => {
    const before = alerted({ cause: 'unknown', checked: ['storm warnings'] });
    const after = withStatements(before, [statement('failed transformer')]);
    assert.equal(after.cause, 'unknown');
    assert.deepEqual(after.evidence, before.evidence);
  });
});

describe('grid operator notices on a blackout', () => {
  const entergy = { utilities: [{ id: 'entergy-new-orleans', name: 'Entergy New Orleans', customersOut: 60_000 }], states: ['LA'], peakCustomers: 60_000 };
  const odin = { utilities: [{ id: 'odin-13478', name: 'Entergy New Orleans', customersOut: 60_000 }], states: ['LA'], peakCustomers: 60_000 };

  it('reads the operator that serves the lead utility, by its EIA number', () => {
    assert.deepEqual(operatorsToRead([open(odin)]), ['MISO']);
  });

  it('skips a blackout too small for a notice to change anything', () => {
    assert.deepEqual(operatorsToRead([open({ ...odin, peakCustomers: 9_999 })]), []);
  });

  it('finds no operator for a utility it cannot place', () => {
    assert.deepEqual(operatorsToRead([open({ ...entergy, utilities: [{ id: 'nobody', name: 'x', customersOut: 1 }] })]), []);
  });

  it('explains a blackout from an order in its own region, and says the order is not a reason', () => {
    const cut = { operator: 'MISO', title: 'Maximum Generation Event Step 3 (EEA 3)', level: 'cut' as const, start: Date.parse(STARTED), end: Date.parse(STARTED) + HOUR, states: ['LA'], url: 'u' };
    const late = new Date(Date.parse(STARTED) + 2 * HOUR);
    const b = applyChecks(open({ ...odin, cause: 'unknown', checked: ['storm warnings'], unexplainedNoticeAt: OPENED, people: 150_000 }), { ...quiet, notices: { MISO: [cut] } }, undefined, late);
    assert.equal(b.cause, 'explained');
    assert.ok(b.checked.includes('grid operator notices'));
    const { events } = takeNotices([b], DEFAULT_SETTINGS, late.toISOString());
    assert.equal(events[0].kind, 'explained');
    assert.match(events[0].detail, /MISO ordered power cuts: Maximum Generation Event Step 3 \(EEA 3\)\. That says who cut the power, not why\./);
  });
});

describe('reading tracking', () => {
  const SIDE = '48157';
  const next = (prev: Blackout, customers: number, at: string, counties = [{ fips: HARRIS, name: 'Harris', customersOut: customers }]) => syncBlackouts([prev], engine(alert({ people: customers * 2.5 })), snapshot(customers, counties), 2.5, at)[0];
  const LATER = '2026-11-01T18:15:00.000Z';
  const first = (customers = 60_000) => ({ ...syncBlackouts([], engine(alert()), snapshot(customers), 2.5, OPENED)[0], people: customers * 2.5 });

  it('starts from the first reading of a new blackout', () => {
    assert.deepEqual(first().reading, { at: OPENED, parts: { [HARRIS]: 60_000 }, before: 0 });
  });

  it('keeps the reading while the count sits still', () => {
    assert.deepEqual(next(first(), 60_000, LATER).reading, first().reading);
  });

  it('ignores a tick too small to mean anything', () => {
    assert.equal(next(first(), 60_020, LATER).reading?.at, OPENED);
  });

  it('notes a real move, with the total just before it', () => {
    assert.deepEqual(next(first(), 60_100, LATER).reading, { at: LATER, parts: { [HARRIS]: 60_100 }, before: 60_000 });
  });

  it('counts a fall as a move, but not a collapse, which is how a flipping feed looks', () => {
    assert.equal(next(first(), 30_000, LATER).reading?.at, LATER);
    assert.equal(next(first(), 11_000, LATER).reading?.at, OPENED);
  });

  it('counts a second county joining as a move', () => {
    const counties = [{ fips: HARRIS, name: 'Harris', customersOut: 60_000 }, { fips: SIDE, name: 'Fort Bend', customersOut: 20_000 }];
    assert.equal(next(first(), 80_000, LATER, counties).reading?.at, LATER);
  });

  it('ignores a minor county ticking beside a stuck one', () => {
    const start = syncBlackouts([], engine(alert()), snapshot(60_500, [{ fips: HARRIS, name: 'Harris', customersOut: 60_000 }, { fips: SIDE, name: 'Fort Bend', customersOut: 500 }]), 2.5, OPENED)[0];
    assert.equal(next(start, 60_900, LATER, [{ fips: HARRIS, name: 'Harris', customersOut: 60_000 }, { fips: SIDE, name: 'Fort Bend', customersOut: 900 }]).reading?.at, OPENED);
  });

  it('falls back on the utility when a feed has no county detail', () => {
    assert.deepEqual(syncBlackouts([], engine(alert()), snapshot(60_000, []), 2.5, OPENED)[0].reading?.parts, { centerpoint: 60_000 });
  });

  it('does not hold back a record made before this check', () => {
    const old = { ...first(), reading: undefined };
    assert.equal(next(old, 60_000, LATER).reading?.before, 60_000);
  });
});

describe('areaCounties', () => {
  it('falls back to the whole metro without county detail', () => {
    assert.ok(areaCounties(open({ counties: [] })).length > 3);
  });
});

describe('causeStatus', () => {
  const started = Date.parse(STARTED);
  const strong = { id: 'x', kind: 'weather', strong: true, label: 'x', source: 'x', at: STARTED } as const;

  const readAt = (ms: number) => ({ 'storm warnings': new Date(ms).toISOString() });

  it('is checking until warnings have had time to appear', () => {
    assert.equal(causeStatus({ evidence: [], checkReads: readAt(started + 4 * 60_000), startedAt: STARTED }, started + 5 * 60_000), 'checking');
  });

  it('becomes unknown once settled with nothing found', () => {
    assert.equal(causeStatus({ evidence: [], checkReads: readAt(started + HOUR), startedAt: STARTED }, started + HOUR), 'unknown');
  });

  it('does not rest on a read from before the settle time', () => {
    assert.equal(causeStatus({ evidence: [], checkReads: readAt(started + 60_000), startedAt: STARTED }, started + 15 * 60_000), 'checking');
  });

  it('stops waiting for storm warnings after 30 minutes, so an NWS outage cannot silence alerts', () => {
    assert.equal(causeStatus({ evidence: [], startedAt: STARTED }, started + 29 * 60_000), 'checking');
    assert.equal(causeStatus({ evidence: [], startedAt: STARTED }, started + 30 * 60_000), 'unknown');
  });

  it('is explained as soon as strong evidence exists', () => {
    assert.equal(causeStatus({ evidence: [strong], startedAt: STARTED }, started), 'explained');
  });

  it('stays unknown with only context', () => {
    assert.equal(causeStatus({ evidence: [{ ...strong, strong: false }], checkReads: readAt(started + HOUR), startedAt: STARTED }, started + HOUR), 'unknown');
  });
});

describe('applyChecks', () => {
  const later = new Date(Date.parse(STARTED) + HOUR);

  it('explains a blackout from a storm that hit long after a small first rise', () => {
    const lateStorm = { id: 'l', event: 'Severe Thunderstorm Warning', start: Date.parse(STARTED) + 6 * HOUR, end: Date.parse(STARTED) + 7 * HOUR, fips: [HARRIS] };
    const now = new Date(Date.parse(STARTED) + 7 * HOUR);
    const quietPeak = applyChecks(open(), { ...quiet, weather: [lateStorm] }, undefined, now);
    assert.equal(quietPeak.cause, 'unknown');
    const grew = applyChecks(open({ peakAt: now.toISOString() }), { ...quiet, weather: [lateStorm] }, undefined, now);
    assert.equal(grew.cause, 'explained');
  });

  const storm = { id: 's', event: 'Tornado Warning', start: Date.parse(STARTED), end: Date.parse(STARTED) + HOUR, fips: [HARRIS] };

  it('explains a blackout from a warning in an affected county', () => {
    const b = applyChecks(open(), { ...quiet, weather: [storm] }, undefined, later);
    assert.equal(b.cause, 'explained');
    assert.equal(b.evidence[0].source, 'National Weather Service');
  });

  it('remembers checks that ran before a source failed', () => {
    const first = applyChecks(open(), quiet, undefined, later);
    const second = applyChecks(first, { ...quiet, weather: null }, undefined, later);
    assert.ok(second.checked.includes('storm warnings'));
    assert.equal(second.cause, 'unknown');
  });

  it('does not repeat evidence across polls', () => {
    const first = applyChecks(open(), { ...quiet, weather: [storm] }, undefined, later);
    assert.equal(applyChecks(first, { ...quiet, weather: [storm] }, undefined, later).evidence.length, 1);
  });

  it('accepts what a utility states when it covers the outage', () => {
    const b = applyChecks(open(), quiet, [{ cause: 'Storm/Weather', customers: 7000 }], later);
    assert.equal(b.cause, 'explained');
    assert.deepEqual(b.utilityCauses, [{ cause: 'Storm/Weather', customers: 7000 }]);
  });

  it('keeps earlier utility causes when a later read returns nothing', () => {
    const first = applyChecks(open(), quiet, [{ cause: 'Pending Investigation', customers: 7000 }], later);
    assert.equal(applyChecks(first, quiet, [], later).utilityCauses.length, 1);
  });
});

describe('wind gusts on a blackout', () => {
  const start = Date.parse(STARTED);
  const advisory = { id: 'w', event: 'Wind Advisory', start: start - HOUR, end: start + HOUR, fips: [HARRIS] };
  const now = new Date(start + HOUR);

  it('explains a Houston blackout from any station in the metro', () => {
    const b = applyChecks(open(), { ...quiet, weather: [advisory], gusts: [{ station: 'KIAH', at: start, mph: 50 }] }, undefined, now);
    assert.equal(b.cause, 'explained');
    assert.match(causeLine(b)!, /Measured gust of 50 mph at KIAH during a Wind Advisory/);
  });

  it('leaves it unknown without the Wind Advisory, and says the gust was seen', () => {
    const b = applyChecks(open(), { ...quiet, gusts: [{ station: 'KIAH', at: start, mph: 50 }] }, undefined, now);
    assert.equal(b.cause, 'unknown');
    assert.equal(b.evidence[0].strong, false);
  });

  it('stands down an alert when the gust arrives after it was sent', () => {
    const sent = open({ cause: 'unknown', unexplainedNoticeAt: OPENED, peakCustomers: 60_000, people: 150_000 });
    const b = applyChecks(sent, { ...quiet, weather: [advisory], gusts: [{ station: 'KIAH', at: start, mph: 50 }] }, undefined, now);
    assert.equal(takeNotices([b], DEFAULT_SETTINGS, OPENED).events[0].kind, 'explained');
  });

  it('never acts where a metro has no usable stations', () => {
    const b = applyChecks(open({ key: 'metro:11100', counties: ['48375'] }), { ...quiet, gusts: [{ station: 'KAMA', at: start, mph: 60 }] }, undefined, now);
    assert.ok(!b.checked.includes('gusts during a Wind Advisory'));
    assert.deepEqual(b.evidence, []);
  });
});

describe('needsCheck', () => {
  const now = Date.parse(STARTED) + 10 * HOUR;
  it('stops once explained', () => assert.equal(needsCheck(open({ cause: 'explained' }), now), false));
  it('runs while open', () => assert.equal(needsCheck(open(), now), true));
  it('runs for a while after closing, then stops', () => {
    assert.equal(needsCheck(open({ resolvedAt: new Date(now - HOUR).toISOString() }), now), true);
    assert.equal(needsCheck(open({ resolvedAt: new Date(now - 4 * HOUR).toISOString() }), now), false);
  });
});

describe('trimBlackouts', () => {
  it('drops the oldest small records but never large or open ones', () => {
    const small = Array.from({ length: 1600 }, (_, i) => open({ id: String(i), peakCustomers: 5000, resolvedAt: OPENED }));
    const large = open({ id: 'large', peakCustomers: 60_000, resolvedAt: OPENED });
    const live = open({ id: 'live', peakCustomers: 5000 });
    const kept = trimBlackouts([live, ...small, large]);
    assert.equal(kept.length, 1502);
    assert.ok(kept.some((b) => b.id === 'large'));
    assert.ok(kept.some((b) => b.id === 'live'));
  });
});

describe('how fast a blackout came', () => {
  const trail = (values: number[], minutes = 5) => ({ t: values.map((_, i) => Date.parse(STARTED) + i * minutes * 60_000), people: { [`metro:${HOUSTON}`]: values } });
  const sync = (values: number[]) => syncBlackouts([], { ...engine(alert()), trail: trail(values) }, snapshot(), 2.5, OPENED)[0];

  it('records the most customers lost within 30 minutes', () => {
    assert.equal(sync([5_000, 5_000, 155_000, 155_000]).jumpCustomers, 60_000);
  });

  it('does not mistake a slow climb for a jump', () => {
    assert.equal(sync([0, 10_000, 20_000, 30_000, 40_000, 50_000, 60_000, 70_000, 80_000]).jumpCustomers, 24_000);
  });

  it('does not forget a jump once the count falls again', () => {
    const first = sync([5_000, 155_000]);
    const later = syncBlackouts([first], { ...engine(alert()), trail: trail([5_000, 5_000]) }, snapshot(), 2.5, OPENED)[0];
    assert.equal(later.jumpCustomers, 60_000);
  });
});

describe('takeNotices', () => {
  const AT = '2026-11-01T19:00:00.000Z';
  const storm = { id: 'x', kind: 'weather', strong: true, label: 'Tornado Warning, Harris County, TX', source: 'x', at: STARTED } as const;
  const large = (over: Partial<Blackout> = {}) => open({ cause: 'unknown', peakCustomers: 60_000, jumpCustomers: 60_000, people: 150_000, checked: ['storm warnings', 'wildfires'], utilities: [{ id: 'centerpoint', name: 'CenterPoint', customersOut: 60_000 }], reading: undefined, ...over });
  const take = (b: Blackout, settings = DEFAULT_SETTINGS) => takeNotices([b], settings, AT);

  it('alerts on a large blackout with no known cause', () => {
    const { list, events } = take(large());
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'unexplained');
    assert.equal(events[0].id, `${large().id}:unexplained`);
    assert.equal(list[0].unexplainedNoticeAt, AT);
    assert.match(events[0].detail, /No storm warnings or wildfires found/);
    assert.match(events[0].detail, /CenterPoint/);
    assert.match(events[0].detail, /does not mean an attack/);
  });

  it('shows weather that was noted but did not count, so a reader can weigh it', () => {
    const wind = { ...storm, strong: false, label: 'Wind Advisory, Harris County, TX' };
    assert.match(take(large({ evidence: [wind] })).events[0].detail, /Also noted, but not enough to explain it: Wind Advisory, Harris County, TX/);
    assert.doesNotMatch(take(large()).events[0].detail, /Also noted/);
  });

  it('alerts only once', () => {
    assert.deepEqual(take(large({ unexplainedNoticeAt: AT })).events, []);
  });

  describe('when it ends', () => {
    const ended = (over: Partial<Blackout> = {}) => large({ unexplainedNoticeAt: STARTED, resolvedAt: AT, ...over });

    it('says so once after an alert, and never after an ordinary outage', () => {
      const { list, events } = take(ended());
      assert.equal(events[0].kind, 'resolved');
      assert.equal(events[0].blind, undefined);
      assert.deepEqual(take(list[0]).events, []);
      assert.deepEqual(take(large({ resolvedAt: AT, cause: 'explained' })).events, []);
    });

    it('stays quiet once the alert was withdrawn, unless a report of a deliberate act went out', () => {
      assert.deepEqual(take(ended({ explainedNoticeAt: STARTED, cause: 'explained' })).events, []);
      assert.equal(take(ended({ explainedNoticeAt: STARTED, cause: 'explained', deliberateNoticeAt: STARTED, deliberateOfficialAt: STARTED })).events[0].kind, 'resolved');
    });

    it('does not claim the power is back when the data went dark', () => {
      const [event] = take(ended({ blindSince: STARTED })).events;
      assert.equal(event.blind, true);
      assert.match(event.detail, /isn't known whether the power is back/);
    });
  });

  it('leaves a slow climb to the ordinary alert, since that is what a storm looks like', () => {
    assert.deepEqual(take(large({ jumpCustomers: 12_000, peakCustomers: 90_000, people: 225_000 })).events, []);
  });

  it('alerts on a slow climb once it is big enough, in case an attack is staged over hours', () => {
    const big = take(large({ jumpCustomers: 12_000, peakCustomers: 150_000, people: 375_000 }));
    assert.equal(big.events[0].kind, 'unexplained');
    assert.doesNotMatch(big.events[0].detail, /within 30 minutes/);
  });

  it('says how fast it happened', () => {
    assert.match(take(large()).events[0].detail, /About 60,000 customers went out within 30 minutes/);
  });

  describe('with a count that has not moved', () => {
    const since = (minutes: number) => new Date(Date.parse(AT) - minutes * 60_000).toISOString();
    const steady = (minutes: number, before = 500) => ({ reading: { at: since(minutes), parts: { [HARRIS]: 60_000 }, before } });

    it('waits while the count has sat on one reading since reaching the level', () => {
      assert.deepEqual(take(large(steady(59))).events, []);
    });

    it('sends it after an hour, and says why it may be wrong', () => {
      const { events } = take(large(steady(60)));
      assert.equal(events[0].kind, 'unexplained');
      assert.match(events[0].detail, /has not moved since .* so this may be a false reading/);
    });

    it('sends it at once if the count moved at or above the level', () => {
      const { events } = take(large(steady(1, 55_000)));
      assert.equal(events.length, 1);
      assert.doesNotMatch(events[0].detail, /false reading/);
    });

  });

  it('stays quiet below the watch level, including a small unknown', () => {
    assert.deepEqual(take(large({ peakCustomers: 24_999, jumpCustomers: 24_999, people: 62_000 })).events, []);
  });

  describe('the watch level', () => {
    const near = (over: Partial<Blackout> = {}) => large({ peakCustomers: 41_291, jumpCustomers: 41_142, people: 100_000, link: '/metros/26420', ...over });

    it('tells the owner once about a sudden jump under the alert level', () => {
      const { list, events } = take(near());
      assert.equal(events.length, 1);
      assert.equal(events[0].kind, 'watch');
      assert.equal(events[0].link, '/metros/26420');
      assert.equal(list[0].watchNoticeAt, AT);
      assert.equal(list[0].unexplainedNoticeAt, undefined);
      assert.match(events[0].detail, /About 41,142 customers went out within 30 minutes/);
      assert.match(events[0].detail, /under the alert level of 50,000 customers, so this went only to you\.$/);
      assert.deepEqual(take(list[0]).events, []);
    });

    it('is not urgent, and carries a search link', () => {
      const m = formatEvent(take(near()).events[0]);
      assert.match(m.title, /^Watch, under the alert level: /);
      assert.equal(m.urgent, undefined);
      assert.ok(m.search);
    });

    it('follows the same conditions as the alert', () => {
      assert.deepEqual(take(near({ cause: 'checking' })).events, []);
      assert.deepEqual(take(near({ cause: 'explained' })).events, []);
      assert.deepEqual(take(near({ resolvedAt: AT })).events, []);
      // Mostly back already.
      assert.deepEqual(take(near({ people: 20_000 })).events, []);
      // A count that hasn't moved since it jumped is held, as a likely bad reading.
      assert.deepEqual(take(near({ reading: { at: AT, parts: { a: 41_142 }, before: 100 } })).events, []);
    });

    it('leaves a slow climb alone, and anything at the alert level to the alert', () => {
      assert.deepEqual(take(near({ jumpCustomers: 12_000, peakCustomers: 120_000, people: 300_000 })).events, []);
      assert.deepEqual(take(large()).events.map((e) => e.kind), ['unexplained']);
      // Held at the alert level, which is the alert's to wait out.
      assert.deepEqual(take(large({ reading: { at: AT, parts: { a: 60_000 }, before: 100 } })).events, []);
    });

    it('can be turned off, and is off when alerts are', () => {
      assert.deepEqual(take(near(), { ...DEFAULT_SETTINGS, watchCustomers: 0 }).events, []);
      assert.deepEqual(take(near(), { ...DEFAULT_SETTINGS, unexplainedCustomers: 0 }).events, []);
    });

    it('still lets the alert go out if the outage grows', () => {
      const watched = take(near()).list[0];
      assert.deepEqual(take({ ...watched, peakCustomers: 70_000, jumpCustomers: 55_000, people: 170_000 }).events.map((e) => e.kind), ['unexplained']);
    });
  });

  it('stays quiet while still checking or once explained', () => {
    assert.deepEqual(take(large({ cause: 'checking' })).events, []);
    assert.deepEqual(take(large({ cause: 'explained' })).events, []);
  });

  it('stays quiet after a blackout has ended', () => {
    assert.deepEqual(take(large({ resolvedAt: AT })).events, []);
  });

  it('ignores a peak the count has already fallen from, like a one-poll glitch', () => {
    assert.deepEqual(take(large({ people: 5_000 })).events, []);
  });

  it('can be turned off', () => {
    assert.deepEqual(take(large(), { ...DEFAULT_SETTINGS, unexplainedCustomers: 0 }).events, []);
  });

  it('honors a changed level', () => {
    assert.equal(take(large({ peakCustomers: 30_000, people: 75_000 }), { ...DEFAULT_SETTINGS, unexplainedCustomers: 25_000 }).events.length, 1);
  });

  it('withdraws the alert when a cause turns up, even after the blackout ended', () => {
    const { list, events } = take(large({ cause: 'explained', unexplainedNoticeAt: AT, resolvedAt: AT, evidence: [storm] }));
    assert.equal(events[0].kind, 'explained');
    assert.match(events[0].detail, /Tornado Warning, Harris County, TX/);
    assert.equal(list[0].explainedNoticeAt, AT);
  });

  it('withdraws only once, and never without an earlier alert', () => {
    assert.deepEqual(take(large({ cause: 'explained', unexplainedNoticeAt: AT, explainedNoticeAt: AT, evidence: [storm] })).events, []);
    assert.deepEqual(take(large({ cause: 'explained', evidence: [storm] })).events, []);
  });
});

describe('causeLine', () => {
  it('leads with the strongest evidence', () => {
    const b = open({ evidence: [{ id: 'x', kind: 'weather', strong: true, label: 'Tornado Warning, Harris County, TX', source: 'x', at: STARTED }] });
    assert.equal(causeLine(b), 'Likely cause: Tornado Warning, Harris County, TX.');
  });

  it('says exactly what was checked', () => {
    assert.equal(causeLine(open({ checked: ['storm warnings', 'wildfires', 'earthquakes'] })), 'Cause unknown so far: no storm warnings, wildfires or earthquakes found.');
  });

  it('claims nothing before any check has run', () => {
    assert.equal(causeLine(open()), undefined);
  });
});

describe('withCause', () => {
  const event = (kind: AlertEvent['kind']): AlertEvent => ({ id: 'e', kind, key: `metro:${HOUSTON}`, scope: 'metro', label: 'Houston', at: OPENED, people: 1, peakPeople: 1, customers: 1, openedAt: OPENED, detail: '', link: '' });
  const list = [open({ checked: ['storm warnings'] })];

  it('adds the cause to an opening notice', () => {
    assert.equal(withCause(event('opened'), list).cause, 'Cause unknown so far: no storm warnings found.');
  });

  it('leaves resolved and unexplained notices alone', () => {
    assert.equal(withCause(event('resolved'), list).cause, undefined);
    assert.equal(withCause(event('unexplained'), list).cause, undefined);
  });
});

describe('checks that have gone stale', () => {
  const start = Date.parse(STARTED);
  const at = (minutes: number) => new Date(start + minutes * 60_000);

  it('stops claiming a check it can no longer read', () => {
    const read = applyChecks(open(), quiet, undefined, at(20));
    assert.ok(read.checked.includes('storm warnings'));
    const later = applyChecks(read, { ...quiet, weather: null }, undefined, at(60));
    assert.ok(!later.checked.includes('storm warnings'));
    assert.ok(later.checked.includes('earthquakes'));
  });

  it('says so when storm warnings could not be read', () => {
    const b = applyChecks(open({ peakCustomers: 80_000, jumpCustomers: 80_000, people: 200_000, reading: undefined }), { ...quiet, weather: null }, undefined, at(40));
    assert.equal(b.cause, 'unknown');
    const { events } = takeNotices([b], DEFAULT_SETTINGS, at(40).toISOString());
    assert.match(events[0].detail, /Storm warnings could not be read/);
    assert.doesNotMatch(events[0].detail, /No storm warnings/);
  });

  it('flags a poll that needed storm warnings and could not read them', () => {
    const b = applyChecks(open(), { ...quiet, weather: null }, undefined, at(20));
    assert.equal(stormCheckFailed([b], at(20).toISOString()), true);
    const read = applyChecks(open(), quiet, undefined, at(20));
    assert.equal(stormCheckFailed([read], at(20).toISOString()), false);
  });
});

describe('a large blackout and a utility map', () => {
  const at = new Date(Date.parse(STARTED) + HOUR);
  const large = open({ peakCustomers: 90_000 });
  const stated = [{ cause: 'Storm/Weather', customers: 80_000 }];

  it('is not explained by a map label alone, which one bad reading could plant', () => {
    assert.equal(applyChecks(large, quiet, stated, at).cause, 'unknown');
  });

  it('is explained once a weather source agrees', () => {
    const windy = { ...quiet, weather: [{ id: 'w', event: 'Wind Advisory', start: Date.parse(STARTED), end: Date.parse(STARTED) + HOUR, fips: [HARRIS] }] };
    assert.equal(applyChecks(large, windy, stated, at).cause, 'explained');
  });
});

describe('Connecticut', () => {
  it('matches a storm warning issued under the old county codes', () => {
    const hartford = open({ key: 'metro:25540', states: ['CT'], counties: ['09110'], peakAt: STARTED });
    const storm = { id: 'w', event: 'Severe Thunderstorm Warning', start: Date.parse(STARTED), end: Date.parse(STARTED) + HOUR, fips: ['09003'] };
    assert.equal(applyChecks(hartford, { ...quiet, weather: [storm] }, undefined, new Date(Date.parse(STARTED) + HOUR)).cause, 'explained');
  });
});

describe('a new blackout inside an old one', () => {
  const surged = (customers: number) => {
    const t = [0, 1, 2].map((n) => Date.parse(STARTED) + n * 2 * HOUR);
    return { ...engine(alert({ openedAt: OPENED, people: customers * 2.5, peakPeople: customers * 2.5 })), trail: { t, people: { [`metro:${HOUSTON}`]: [2_000, 2_000, customers * 2.5] } } };
  };
  const explained = open({ cause: 'explained', evidence: [{ id: 'w', kind: 'weather', strong: true, label: 'old storm', source: 'NWS', at: STARTED }], checked: ['storm warnings'], unexplainedNoticeAt: OPENED, explainedNoticeAt: OPENED });
  const at = new Date(Date.parse(STARTED) + 4 * HOUR).toISOString();

  it('reopens the checks when the count jumps past the alert level', () => {
    const [b] = syncBlackouts([explained], surged(60_000), snapshot(), 2.5, at);
    assert.equal(b.cause, 'checking');
    assert.deepEqual(b.evidence, []);
    assert.equal(b.unexplainedNoticeAt, undefined);
    assert.ok(b.checkFrom);
  });

  it('leaves a small rise alone', () => {
    assert.equal(syncBlackouts([explained], surged(10_000), snapshot(), 2.5, at)[0].cause, 'explained');
  });

  it('reopens once per jump, so a storm that explains it again stays explained', () => {
    const [b] = syncBlackouts([explained], surged(60_000), snapshot(), 2.5, at);
    const again = { ...b, cause: 'explained' as const };
    assert.equal(syncBlackouts([again], surged(60_000), snapshot(), 2.5, at)[0].cause, 'explained');
  });
});

describe('a feed that dies with the power', () => {
  const at = new Date(Date.parse(STARTED) + HOUR / 2).toISOString();
  const held = open({ cause: 'unknown', peakCustomers: 80_000, jumpCustomers: 80_000, people: 200_000, checked: ['storm warnings'], reading: { at: STARTED, parts: {}, before: 0 } });

  it('does not wait for a count that can no longer move', () => {
    assert.deepEqual(takeNotices([held], DEFAULT_SETTINGS, at).events, []);
    const { events } = takeNotices([{ ...held, blindSince: STARTED }], DEFAULT_SETTINGS, at);
    assert.equal(events[0].kind, 'unexplained');
    assert.match(events[0].detail, /stopped at .* which can happen when the power is out/);
  });
});

describe('reports of a deliberate cause', () => {
  const at = new Date(Date.parse(STARTED) + HOUR).toISOString();
  const entry = (source: string, over = {}) => ({ at: STARTED, source, title: `Hackers hit grid, says ${source}`, url: `https://${source}/a`, deliberate: true, ...over });
  const take = (b: Blackout) => takeNotices([b], DEFAULT_SETTINGS, at);

  it('needs more than one unknown site', () => {
    assert.deepEqual(take(open({ timeline: [entry('a.example')] })).events, []);
    assert.equal(take(open({ timeline: [entry('a.example'), entry('b.example')] })).events.length, 1);
  });

  it('counts two pages of one site once', () => {
    assert.deepEqual(take(open({ timeline: [entry('a.example'), entry('www.a.example', { title: 'Second story' })] })).events, []);
  });

  it('takes an outlet with editors alone', () => {
    assert.equal(take(open({ timeline: [entry('reuters.com')] })).events.length, 1);
  });

  it('still lets an agency speak after a news report has gone out', () => {
    const first = take(open({ timeline: [entry('reuters.com')] })).list[0];
    assert.deepEqual(take(first).events, []);
    const withAgency = { ...first, timeline: [...first.timeline!, entry('CISA', { official: true })] };
    const second = take(withAgency);
    assert.equal(second.events.length, 1);
    assert.deepEqual(take(second.list[0]).events, []);
  });

  it('does not treat a general agency headline as a report of this blackout', () => {
    const notice = (title: string) => ({ at: Date.parse(STARTED), source: 'FBI', url: 'https://fbi.gov/x', title, places: [], official: true });
    const b = open({ peakCustomers: 80_000 });
    const log = (title: string) => ({ through: 1, items: [notice(title)] });
    assert.equal(withNews(b, log('FBI warns of attacks on power grid operators'), Date.parse(at)).timeline![0].deliberate, undefined);
    assert.equal(withNews(b, log('FBI investigating attack on Houston substation'), Date.parse(at)).timeline![0].deliberate, true);
  });
});

describe('what a read costs', () => {
  const alerted = open({ unexplainedNoticeAt: OPENED, timeline: [{ at: STARTED, source: 's', title: 'a', url: 'a' }] });

  it('stops reading stories about an old blackout', () => {
    assert.ok(statementsDue([alerted], Date.parse(STARTED) + 71 * HOUR));
    assert.equal(statementsDue([alerted], Date.parse(STARTED) + 73 * HOUR), undefined);
  });

  it('keeps those who should know ahead of the crowd', () => {
    const say = (speaker: string, speakerType: 'public' | 'utility') => ({ at: STARTED, source: 's', url: 'a', speaker, speakerType, cause: 'unknown' as const, claim: 'c', quote: speaker });
    const crowd = Array.from({ length: 8 }, (_, i) => say(`Resident ${i}`, 'public'));
    const b = withStatements({ ...alerted, statements: crowd }, [say('The utility', 'utility')]);
    assert.equal(b.statements!.length, 8);
    assert.equal(b.statements![0].speaker, 'The utility');
  });
});

describe('an open alert', () => {
  it('reopens a record an overlapping run closed by mistake', () => {
    const [b] = syncBlackouts([open({ resolvedAt: OPENED })], engine(alert()), snapshot(), 2.5, OPENED);
    assert.equal(b.resolvedAt, undefined);
  });

  it('caps large records too, at years of them', () => {
    const closed = Array.from({ length: 2_100 }, (_, i) => open({ id: String(i), peakCustomers: 60_000, resolvedAt: STARTED }));
    assert.equal(trimBlackouts(closed).length, 2_000);
  });
});

describe('causes a utility states', () => {
  const source = (id: string) => sources.find((s) => s.id === id)!;
  const county = (name: string, customers: number, cause = 'Equipment Problems') => ({ cause, customers, place: { name, state: 'CA', kind: 'county' as const } });
  const losAngeles = new Set(['06037']);

  it('keeps only those in the blackout\'s counties, as most feeds report their whole system', () => {
    const rows = [county('Los Angeles', 437, 'Metallic Balloons in Equipment'), county('Kern', 300), county('Ventura', 53)];
    assert.deepEqual(causesHere(source('sce'), rows, losAngeles).map((r) => r.customers), [437]);
  });

  it('drops a row a multi-metro feed can not place', () => {
    assert.deepEqual(causesHere(source('sce'), [{ cause: 'Equipment Problems', customers: 300 }], losAngeles), []);
  });

  it('leaves a feed that serves one metro alone, since it can only mean that metro', () => {
    const rows = [{ cause: 'Tree', customers: 300 }];
    const single = sources.find((s) => s.method === 'arcgis' && s.id === 'tacoma-power')!;
    assert.deepEqual(causesHere(single, rows, losAngeles), rows);
  });

  it('leaves Kubra alone, as its come from the map around the blackout', () => {
    const rows = [{ cause: 'Tree', customers: 300 }];
    assert.deepEqual(causesHere(sources.find((s) => s.method === 'kubra')!, rows, losAngeles), rows);
  });

  it('remembers named causes on the record, and not what is still being looked into', () => {
    const later = new Date(Date.parse(STARTED) + HOUR);
    const b = applyChecks(open(), quiet, [{ cause: 'Vehicle accident', customers: 500 }, { cause: 'Analyzing Problem', customers: 900 }], later);
    assert.deepEqual(b.knownCauses, [{ cause: 'Vehicle accident', customers: 500 }]);
    assert.deepEqual(applyChecks(b, quiet, [], later).knownCauses, b.knownCauses);
  });
});
