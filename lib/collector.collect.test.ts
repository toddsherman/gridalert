import assert from 'node:assert/strict';
import { before, beforeEach, describe, it, mock } from 'node:test';
import type { LastGoodMap } from './collector.ts';
import type { Reading } from './sources/types.ts';
import { DEFAULT_SETTINGS } from './types.ts';

// Everything real except the network, to drive whole polls through collect.

const NOW = new Date(Date.UTC(2026, 10, 2, 4));
let readings: Record<string, Reading | Error>;
let odin: Array<{ eiaId: number | null; utilityName: string; fips: string; customersOut: number }> | Error;

type Collect = typeof import('./collector.ts')['collect'];
let collect: Collect;
let registry: typeof import('./registry.ts');

const run = (previous: LastGoodMap = {}) => collect(previous, DEFAULT_SETTINGS, NOW);
const metroCandidate = (result: Awaited<ReturnType<Collect>>, cbsa: string) => result.candidates.find((c) => c.key === `metro:${cbsa}`)!;

before(async () => {
  mock.module('./sources/read.ts', {
    namedExports: {
      readSource: async (s: { id: string }) => {
        const r = readings[s.id];
        if (r instanceof Error) throw r;
        return r ?? { customersOut: 1 };
      },
      validateReading: (await import('./sources/read.ts')).validateReading,
    },
  });
  mock.module('./sources/odin.ts', {
    namedExports: {
      readOdin: async () => {
        if (odin instanceof Error) throw odin;
        return odin;
      },
    },
  });
  ({ collect } = await import('./collector.ts'));
  registry = await import('./registry.ts');
});

beforeEach(() => {
  readings = {};
  odin = [];
});

/** The first single-metro feed of at least this many customers. */
const singleMetroFeed = (min: number) => registry.sources.find((s) => !s.metros && s.eiaIds.length === 1 && registry.utilityByEia.get(s.eiaIds[0])?.metros.length === 1 && registry.customersOf(s) >= min)!;
const multiMetroFeed = () => registry.sources.find((s) => !s.metros && s.eiaIds.length === 1 && (registry.utilityByEia.get(s.eiaIds[0])?.metros.length ?? 0) >= 3 && registry.customersOf(s) >= 100_000)!;

describe('one bad feed', () => {
  it('cannot claim more customers than the utility has', async () => {
    const feed = singleMetroFeed(10_000);
    readings[feed.id] = { customersOut: Math.round(registry.customersOf(feed) * 2) };
    const { snapshot } = await run();
    const row = snapshot.utilities.find((u) => u.id === feed.id)!;
    assert.equal(row.health, 'down');
    assert.equal(row.customersOut, 0);
    assert.match(row.error!, /exceeds registered/);
  });

  it('cannot invent a blackout in a city it does not serve', async () => {
    const feed = singleMetroFeed(50_000);
    const home = registry.utilityByEia.get(feed.eiaIds[0])!.metros[0];
    const faraway = registry.metros.find((m) => m.cbsa !== home && m.population > 3_000_000 && m.counties[0].state !== registry.utilityByEia.get(feed.eiaIds[0])!.states[0])!;
    const county = faraway.counties[0];
    readings[feed.id] = { customersOut: 40_000, customersServed: 500_000, areas: [{ state: county.state, name: county.name, kind: 'county', customersOut: 40_000 }] };
    const result = await run();
    assert.ok(result.snapshot.metros.find((m) => m.cbsa === faraway.cbsa)!.customersOut < 100, 'only the background from its own feeds');
    assert.ok(result.snapshot.unmatchedAreas.some((a) => a.source === feed.id));
    // Its own count isn't lost: it stays with the metro the feed does serve.
    assert.ok(result.snapshot.metros.find((m) => m.cbsa === home)!.customersOut >= 40_000);
  });
});

describe('an incomplete picture', () => {
  it('does not let ODIN going down clear Houston', async () => {
    const quiet = await run();
    assert.equal(metroCandidate(quiet, '26420').complete, true);
    odin = new Error('down');
    const down = await run();
    assert.equal(down.snapshot.odinDown, true);
    assert.equal(metroCandidate(down, '26420').complete, false);
  });

  it('does not let a dead feed clear its metro', async () => {
    const feed = singleMetroFeed(100_000);
    const home = registry.utilityByEia.get(feed.eiaIds[0])!.metros[0];
    readings[feed.id] = new Error('down');
    assert.equal(metroCandidate(await run(), home).complete, false);
  });

  it('does not raise a utility alert because a county report failed', async () => {
    const feed = multiMetroFeed();
    const counties = { [registry.utilityByEia.get(feed.eiaIds[0])!.metroCounties[0]]: 800, [registry.utilityByEia.get(feed.eiaIds[0])!.metroCounties[1]]: 200 };
    readings[feed.id] = { customersOut: 5_000, areasMissing: true };
    const { candidates, snapshot, lastGood } = await run({ [feed.id]: { at: NOW.toISOString(), customersOut: 1_000, counties } });
    const utility = candidates.find((c) => c.key === `utility:${feed.id}`)!;
    assert.equal(utility.customers, 0);
    assert.equal(utility.complete, false);
    assert.equal(snapshot.utilities.find((u) => u.id === feed.id)!.attributedOut, 5_000);
    assert.equal(Object.values(lastGood[feed.id].counties)[0], 4_000);
  });

  it('sends what a feed cannot place to the utility, so it still alerts', async () => {
    const feed = multiMetroFeed();
    readings[feed.id] = { customersOut: 30_000, areas: [{ name: 'Nowhere In Particular', kind: 'county', customersOut: 30_000 }] };
    const { candidates } = await run();
    assert.equal(candidates.find((c) => c.key === `utility:${feed.id}`)!.customers, 30_000);
  });
});

describe('zero readings', () => {
  it('dates a run of zeros and clears it when the count moves', async () => {
    const feed = singleMetroFeed(100_000);
    readings[feed.id] = { customersOut: 0 };
    const first = await run();
    assert.equal(first.lastGood[feed.id].zeroSince, NOW.toISOString());
    const carried = await collect({ [feed.id]: { ...first.lastGood[feed.id], zeroSince: '2026-11-01T00:00:00.000Z' } }, DEFAULT_SETTINGS, NOW);
    assert.equal(carried.snapshot.utilities.find((u) => u.id === feed.id)!.zeroSince, '2026-11-01T00:00:00.000Z');
    readings[feed.id] = { customersOut: 4 };
    assert.equal((await run(first.lastGood)).lastGood[feed.id].zeroSince, undefined);
  });

  it('counts polls where ODIN sees outages a feed says it does not have', async () => {
    const feed = singleMetroFeed(100_000);
    readings[feed.id] = { customersOut: 0 };
    odin = [{ eiaId: feed.eiaIds[0], utilityName: 'x', fips: '48201', customersOut: 500 }];
    const first = await run();
    assert.equal((await run(first.lastGood)).lastGood[feed.id].odinAhead, 2);
    readings[feed.id] = { customersOut: 400 };
    assert.equal((await run(first.lastGood)).lastGood[feed.id].odinAhead, 0);
  });
});

describe('placing a county name', () => {
  const placed = async (id: string, name: string) => {
    readings[id] = { customersOut: 500, areas: [{ name, kind: 'county', customersOut: 500 }] };
    return Object.keys((await run()).lastGood[id].counties);
  };

  it('uses the whole territory to tell two states apart, not only metro counties', async () => {
    assert.deepEqual(await placed('dominion-seed', 'Rockingham'), ['51165']);
    assert.deepEqual(await placed('dominion-seed', 'Mecklenburg'), ['51117']);
    assert.deepEqual(await placed('inland-power', 'Lincoln'), ['53043']);
  });

  it('leaves a name it truly can not settle unplaced, rather than making it a town', async () => {
    assert.deepEqual(await placed('dominion-seed', 'Halifax'), []);
  });

  it('still reads a town written where a county would go', async () => {
    assert.deepEqual(await placed('brightridge', 'JONESBOROUGH'), ['47179']);
  });

  it('does not take a state for a town of the same name', async () => {
    assert.deepEqual(await placed('okefenoke-remc', 'Florida'), []);
  });
});
