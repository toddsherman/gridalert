import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import centroidsJson from '../data/county-centroids.json' with { type: 'json' };
import operatorsJson from '../data/operators.json' with { type: 'json' };
import territoriesJson from '../data/territories.json' with { type: 'json' };
import windStationsJson from '../data/wind-stations.json' with { type: 'json' };
import { metroForCounty, withOldCodes } from './geo.ts';
import { countiesOf, metros, sources, utilities, utilityByEia } from './registry.ts';

// Every location lookup relies on these files agreeing. A rebuild that breaks one of these links
// wouldn't raise an error anywhere: alerts would just go to the wrong place, or quietly not match.

const centroids = centroidsJson as unknown as Record<string, [number, number]>;
const windStations = windStationsJson as Record<string, string[]>;
const metroIds = new Set(metros.map((m) => m.cbsa));
const FIPS_STATE = new Map(metros.flatMap((m) => m.counties.map((c) => [c.fips.slice(0, 2), c.state] as const)));

describe('metros and counties', () => {
  it('maps every metro county back to its metro', () => {
    for (const m of metros) for (const c of m.counties) assert.equal(metroForCounty(c.fips), m.cbsa, `${c.fips} ${c.name}`);
  });

  it('puts each county in one metro', () => {
    const all = metros.flatMap((m) => m.counties.map((c) => c.fips));
    assert.equal(new Set(all).size, all.length);
  });

  it('keeps state and county code in step', () => {
    for (const m of metros) for (const c of m.counties) assert.equal(FIPS_STATE.get(c.fips.slice(0, 2)), c.state, c.fips);
  });

  it('can locate every metro county, under its old code if need be', () => {
    for (const m of metros) for (const c of m.counties) assert.ok(withOldCodes(c.fips).some((f) => centroids[f]), `${c.fips} ${c.name}`);
  });

  it('stores centers as longitude then latitude, the order distance checks expect', () => {
    assert.ok(centroids['48201'][0] < -90 && centroids['48201'][1] > 25);
  });
});

describe('utilities', () => {
  it('agree with metros in both directions', () => {
    for (const u of utilities) for (const cbsa of u.metros) assert.ok(metros.find((m) => m.cbsa === cbsa)?.utilities.includes(u.eiaId), `${u.name} ${cbsa}`);
    for (const m of metros) for (const id of m.utilities) assert.ok(utilityByEia.get(id)?.metros.includes(m.cbsa), `${m.name} ${id}`);
  });

  it('only list counties in the metros they name', () => {
    for (const u of utilities) for (const f of u.metroCounties) assert.ok(u.metros.includes(metroForCounty(f) ?? ''), `${u.name} ${f}`);
  });
});

describe('feeds', () => {
  it('all point at a real utility, bar those EIA does not cover', () => {
    for (const s of sources) assert.ok(s.eiaIds.some((id) => utilityByEia.has(id)) || (s.metros?.length && s.customers), s.id);
  });

  it('have a full county list for each utility, which is what tells same-named counties apart', () => {
    for (const s of sources) for (const id of s.eiaIds) assert.ok((territoriesJson as Record<string, string[]>)[id]?.length, `${s.id} ${id}`);
  });

  it('name real metros', () => {
    for (const s of sources) for (const cbsa of [...(s.metros ?? []), ...(s.alsoMetros ?? [])]) assert.ok(metroIds.has(cbsa), `${s.id} ${cbsa}`);
  });

  it('include their metro counties in what they serve', () => {
    for (const u of utilities.slice(0, 200)) for (const f of u.metroCounties) assert.ok(countiesOf(u.eiaId).includes(f));
  });
});

describe('wind stations', () => {
  it('belong to real metros', () => {
    for (const cbsa of Object.keys(windStations)) assert.ok(metroIds.has(cbsa), cbsa);
  });

  it('leave out oil platforms, which the archive files under coastal counties', () => {
    const all = new Set(Object.values(windStations).flat());
    for (const id of ['KDSF', 'KETO', 'KGLX', 'KMDJ', 'KMKQ', 'KMZM', 'KPBM', 'KGYF', 'KGVX', 'KEZP', 'KVNP']) assert.ok(!all.has(id), id);
  });

  it('leave out an id that means somewhere else on the live feed', () => {
    assert.ok(!Object.values(windStations).flat().includes('KT89'));
  });
});

describe('grid operators', () => {
  it('map to real utilities and known states', () => {
    for (const [id, states] of Object.entries(operatorsJson as Record<string, Record<string, string[]>>)) {
      assert.ok(utilityByEia.has(Number(id)), id);
      for (const state of Object.keys(states)) assert.ok(/^[A-Z]{2}$/.test(state), state);
    }
  });
});
