import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assess, type CauseArea } from './assess.ts';
import type { World } from './feeds.ts';

const HOUR = 3_600_000;
const start = Date.UTC(2026, 10, 1, 18);
const HARRIS = '48201';
const area: CauseArea = { fips: new Set([HARRIS]), points: [[-95.4, 29.9]], start };
const quiet: World = { weather: [], reports: [], fires: [], quakes: [], kp: [], gusts: [] };

const warning = (event: string, over = {}) => ({ id: event, event, start: start - HOUR, end: start + HOUR, fips: [HARRIS], ...over });

describe('grid operator notices', () => {
  const served: CauseArea = { ...area, operators: new Set(['MISO']), states: new Set(['LA']) };
  const notice = (over = {}) => ({ operator: 'MISO', title: 'Maximum Generation Event Step 3 (EEA 3)', level: 'cut' as const, start: start - HOUR, end: start + HOUR, states: ['AR', 'LA', 'MS', 'TX'], url: 'https://www.misoenergy.org/x', ...over });
  const found = (notices: Array<ReturnType<typeof notice>> | null, at = served) => assess(at, { ...quiet, notices: { MISO: notices } });

  it('explains a blackout when the operator ordered cuts in that area', () => {
    const [e] = found([notice()]).evidence;
    assert.equal(e.kind, 'operator');
    assert.equal(e.strong, true);
    assert.equal(e.label, 'MISO ordered power cuts: Maximum Generation Event Step 3 (EEA 3)');
    assert.equal(e.url, 'https://www.misoenergy.org/x');
  });

  it('does not let an order in another region explain it', () => {
    assert.deepEqual(found([notice({ states: ['IL', 'IN', 'KY', 'MO'] })]).evidence, []);
  });

  it('does not let an order it cannot place explain it', () => {
    assert.deepEqual(found([notice({ states: ['??'] })]).evidence, []);
  });

  it('counts an order covering the whole operator', () => {
    assert.equal(found([notice({ states: [] })]).evidence[0].strong, true);
  });

  it('shows an emergency without letting it explain anything', () => {
    const [e] = found([notice({ title: 'EEA 2', level: 'emergency' as const })]).evidence;
    assert.equal(e.strong, false);
    assert.equal(e.label, 'MISO grid emergency: EEA 2');
  });

  it('ignores a notice well outside the window', () => {
    assert.deepEqual(found([notice({ start: start - 10 * HOUR, end: start - 9 * HOUR })]).evidence, []);
  });

  it('reports each notice once, however many times it was updated', () => {
    assert.equal(found([notice(), notice()]).evidence.length, 1);
  });

  it('says the check ran only if the operator could be read', () => {
    assert.ok(found([]).checked.includes('grid operator notices'));
    assert.ok(!found(null).checked.includes('grid operator notices'));
    assert.ok(!assess(served, quiet).checked.includes('grid operator notices'));
  });

  it('makes no claim where no readable operator runs the grid', () => {
    assert.ok(!found([], area).checked.includes('grid operator notices'));
  });
});

describe('wind gusts', () => {
  const stations = new Set(['KHOU', 'KIAH']);
  const windy: CauseArea = { ...area, stations };
  const advisory = warning('Wind Advisory');
  const gust = (over = {}) => ({ station: 'KHOU', at: start - HOUR, mph: 52, ...over });
  const found = (world: Partial<World>, at = windy) => assess(at, { ...quiet, ...world }).evidence.filter((e) => e.kind === 'wind-gust');

  it('explains a blackout when a gust backs up a Wind Advisory', () => {
    const [e] = found({ weather: [advisory], gusts: [gust()] });
    assert.equal(e.strong, true);
    assert.equal(e.label, 'Measured gust of 52 mph at KHOU during a Wind Advisory');
  });

  it('only notes a gust with no Wind Advisory', () => {
    const [e] = found({ gusts: [gust()] });
    assert.equal(e.strong, false);
    assert.equal(e.label, 'Measured gust of 52 mph at KHOU, with no Wind Advisory');
  });

  it('does not treat a Wind Advisory alone as an explanation', () => {
    assert.deepEqual(found({ weather: [advisory], gusts: [] }), []);
  });

  it('reports the strongest gust', () => {
    assert.match(found({ weather: [advisory], gusts: [gust(), gust({ station: 'KIAH', mph: 61 }), gust({ mph: 47 })] })[0].label, /61 mph at KIAH/);
  });

  it('ignores stations outside the metro', () => {
    assert.deepEqual(found({ weather: [advisory], gusts: [gust({ station: 'KDEN' })] }), []);
  });

  it('ignores gusts outside the window', () => {
    assert.deepEqual(found({ weather: [advisory], gusts: [gust({ at: start - 4 * HOUR })] }), []);
    assert.deepEqual(found({ weather: [advisory], gusts: [gust({ at: start + 3 * HOUR })] }), []);
    assert.equal(found({ weather: [advisory], gusts: [gust({ at: start + 3 * HOUR })] }, { ...windy, end: start + 2 * HOUR }).length, 1);
  });

  it('needs the Wind Advisory in an affected county, at the right time', () => {
    assert.equal(found({ weather: [warning('Wind Advisory', { fips: ['06037'] })], gusts: [gust()] })[0].strong, false);
    assert.equal(found({ weather: [warning('Wind Advisory', { start: start + 3 * HOUR, end: start + 4 * HOUR })], gusts: [gust()] })[0].strong, false);
  });

  it('only claims the check where there are stations and the feed answered', () => {
    assert.ok(assess(windy, quiet).checked.includes('gusts during a Wind Advisory'));
    assert.ok(!assess(area, quiet).checked.includes('gusts during a Wind Advisory'));
    assert.ok(!assess({ ...area, stations: new Set() }, quiet).checked.includes('gusts during a Wind Advisory'));
    assert.ok(!assess(windy, { ...quiet, gusts: null }).checked.includes('gusts during a Wind Advisory'));
  });
});

describe('assess', () => {
  it('finds nothing in a quiet world and records every check as run', () => {
    const { evidence, checked } = assess(area, quiet);
    assert.deepEqual(evidence, []);
    assert.deepEqual(checked, ['storm warnings', 'storm reports', 'wildfires', 'earthquakes', 'space weather']);
  });

  it('does not claim a check whose source failed', () => {
    const { checked } = assess(area, { ...quiet, weather: null, quakes: null });
    assert.deepEqual(checked, ['storm reports', 'wildfires', 'space weather']);
  });

  it('treats a severe storm warning in the county as strong', () => {
    const [e] = assess(area, { ...quiet, weather: [warning('Severe Thunderstorm Warning')] }).evidence;
    assert.equal(e.strong, true);
    assert.equal(e.label, 'Severe Thunderstorm Warning, Harris County, TX');
  });

  it('treats a wind advisory as context only', () => {
    const [e] = assess(area, { ...quiet, weather: [warning('Wind Advisory')] }).evidence;
    assert.equal(e.strong, false);
  });

  it('ignores warnings in another county', () => {
    assert.deepEqual(assess(area, { ...quiet, weather: [warning('Tornado Warning', { fips: ['12057'] })] }).evidence, []);
  });

  it('counts a warning that ended shortly before the start, but not one long past', () => {
    const recent = warning('Tornado Warning', { start: start - 2 * HOUR, end: start - HOUR });
    const old = warning('Tornado Warning', { start: start - 7 * HOUR, end: start - 4 * HOUR });
    assert.equal(assess(area, { ...quiet, weather: [recent] }).evidence.length, 1);
    assert.equal(assess(area, { ...quiet, weather: [old] }).evidence.length, 0);
  });

  it('finds a storm that arrives after the first rise but before the peak', () => {
    const later = warning('Severe Thunderstorm Warning', { start: start + 6 * HOUR, end: start + 7 * HOUR });
    assert.equal(assess(area, { ...quiet, weather: [later] }).evidence.length, 0);
    assert.equal(assess({ ...area, end: start + 7 * HOUR }, { ...quiet, weather: [later] }).evidence.length, 1);
  });

  it('applies the whole climb to storm reports too', () => {
    const reports = [{ kind: 'wind' as const, at: start + 6 * HOUR, fips: HARRIS, place: 'Katy, TX' }];
    assert.equal(assess({ ...area, end: start + 7 * HOUR }, { ...quiet, reports }).evidence.length, 1);
  });

  it('collapses many warnings for one storm into one line per product', () => {
    const weather = [warning('Tornado Warning'), warning('Tornado Warning', { id: 'b' })];
    assert.equal(assess(area, { ...quiet, weather }).evidence.length, 1);
  });

  it('matches storm reports by county and time', () => {
    const reports = [{ kind: 'wind' as const, at: start, fips: HARRIS, place: 'Katy, TX' }];
    const [e] = assess(area, { ...quiet, reports }).evidence;
    assert.equal(e.label, 'Damaging wind reported near Katy, TX');
    assert.deepEqual(assess(area, { ...quiet, reports: [{ ...reports[0], at: start - 6 * HOUR }] }).evidence, []);
  });

  it('counts a recent large fire in the county but not an old one', () => {
    const fresh = { name: 'Oak', fips: HARRIS, acres: 4000, discoveredAt: start - 24 * HOUR };
    assert.equal(assess(area, { ...quiet, fires: [fresh] }).evidence[0].strong, true);
    assert.deepEqual(assess(area, { ...quiet, fires: [{ ...fresh, discoveredAt: start - 30 * 24 * HOUR }] }).evidence, []);
  });

  it('scales earthquake reach with magnitude', () => {
    const quake = { id: 'q', magnitude: 5.2, place: 'Texas', at: start, lon: -95.4, lat: 29.9 };
    const distant = { ...quake, lon: -93.4 }; // about 190 km away
    assert.equal(assess(area, { ...quiet, quakes: [quake] }).evidence.length, 1);
    assert.equal(assess(area, { ...quiet, quakes: [distant] }).evidence.length, 0);
    assert.equal(assess(area, { ...quiet, quakes: [{ ...distant, magnitude: 6.4 }] }).evidence.length, 1);
  });

  it('notes a severe geomagnetic storm without treating it as an explanation', () => {
    const [e] = assess(area, { ...quiet, kp: [{ at: start - HOUR, kp: 8.3 }] }).evidence;
    assert.equal(e.strong, false);
    assert.equal(assess(area, { ...quiet, kp: [{ at: start - HOUR, kp: 6 }] }).evidence.length, 0);
  });
});
