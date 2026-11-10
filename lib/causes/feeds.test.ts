import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { convectiveDayStart, parseFires, parseGusts, parseKp, parseQuakes, parseStormReports, parseWeatherAlerts, readGusts, readKp, within } from './feeds.ts';

const feature = (properties: object) => ({ properties });

describe('parseWeatherAlerts', () => {
  const base = { id: 'a', messageType: 'Alert', onset: '2026-11-01T10:00:00-05:00', ends: '2026-11-01T11:00:00-05:00', geocode: { SAME: ['048201', '048157'] } };

  it('reads county FIPS from SAME codes', () => {
    const [alert] = parseWeatherAlerts({ features: [feature({ ...base, event: 'Tornado Warning' })] });
    assert.deepEqual(alert.fips, ['48201', '48157']);
    assert.equal(alert.start, Date.parse('2026-11-01T15:00:00Z'));
  });

  it('falls back to expires when a warning has no end', () => {
    const [alert] = parseWeatherAlerts({ features: [feature({ ...base, event: 'Wind Advisory', ends: null, expires: '2026-11-01T12:00:00-05:00' })] });
    assert.equal(alert.end, Date.parse('2026-11-01T17:00:00Z'));
  });

  it('skips cancellations and unrelated products', () => {
    const features = [feature({ ...base, event: 'Tornado Warning', messageType: 'Cancel' }), feature({ ...base, event: 'Dense Fog Advisory' })];
    assert.deepEqual(parseWeatherAlerts({ features }), []);
  });
});

describe('storm reports', () => {
  const csv = [
    'Time,F_Scale,Location,County,State,Lat,Lon,Comments',
    '1830,UNK,2 N Katy,Harris,TX,29.8,-95.8,Tornado on the ground, trees down (HGX)',
    'Time,Speed,Location,County,State,Lat,Lon,Comments',
    '0115,UNK,Tampa,Hillsborough,FL,27.9,-82.4,Power lines down (TBW)',
    'Time,Size,Location,County,State,Lat,Lon,Comments',
    '1900,100,Austin,Travis,TX,30.2,-97.7,Quarter hail (EWX)',
  ].join('\n');

  it('keeps tornado and wind rows, resolves counties, and skips hail', () => {
    const rows = parseStormReports(csv, Date.UTC(2026, 10, 1, 12));
    assert.deepEqual(rows.map((r) => [r.kind, r.fips]), [['tornado', '48201'], ['wind', '12057']]);
  });

  it('places times after midnight UTC on the next calendar day', () => {
    const rows = parseStormReports(csv, Date.UTC(2026, 10, 1, 12));
    assert.equal(rows[0].at, Date.UTC(2026, 10, 1, 18, 30));
    assert.equal(rows[1].at, Date.UTC(2026, 10, 2, 1, 15));
  });

  it('starts the storm day at 12Z', () => {
    assert.equal(convectiveDayStart(new Date(Date.UTC(2026, 10, 1, 16))), Date.UTC(2026, 10, 1, 12));
    assert.equal(convectiveDayStart(new Date(Date.UTC(2026, 10, 1, 6))), Date.UTC(2026, 9, 31, 12));
  });
});

describe('other sources', () => {
  it('reads wildfires, skipping rows with no county', () => {
    const doc = { features: [{ attributes: { IncidentName: 'Oak', POOFips: '06037', IncidentSize: 2500, FireDiscoveryDateTime: 1000 } }, { attributes: { IncidentName: 'Elm', FireDiscoveryDateTime: 1000 } }] };
    assert.deepEqual(parseFires(doc), [{ name: 'Oak', fips: '06037', acres: 2500, discoveredAt: 1000 }]);
  });

  it('reads earthquakes', () => {
    const doc = { features: [{ id: 'ci1', properties: { mag: 6.1, place: '10 km S of Ridgecrest, CA', time: 5000, url: 'https://x' }, geometry: { coordinates: [-117.6, 35.6, 8] } }] };
    assert.deepEqual(parseQuakes(doc), [{ id: 'ci1', magnitude: 6.1, place: '10 km S of Ridgecrest, CA', at: 5000, lon: -117.6, lat: 35.6, url: 'https://x' }]);
  });

  it('reads Kp values as UTC', () => {
    assert.deepEqual(parseKp([{ time_tag: '2026-10-25T03:00:00', Kp: 8.33 }]), [{ at: Date.UTC(2026, 9, 25, 3), kp: 8.33 }]);
  });
});

describe('the Kp feed', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  // As NOAA's feed stood at 06:00 UTC on 2026-11-03, before the 03:00 period was published.
  const rows = [{ time_tag: '2026-11-03T00:00:00', Kp: 1.67, a_running: 6, station_count: 8 }];

  it('is fine just before an update, when its newest row is a little over 6 hours old', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify(rows))) as unknown as typeof fetch;
    assert.equal((await readKp(new Date(Date.UTC(2026, 10, 3, 6, 0, 41)))).length, 1);
  });

  it('counts as broken once it has missed an update', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify(rows))) as unknown as typeof fetch;
    await assert.rejects(readKp(new Date(Date.UTC(2026, 10, 3, 9, 30))), /NOAA Kp index/);
  });
});

describe('within', () => {
  // Started in each test, since one made when the file loads can finish before a busy run reaches it.
  const slow = () => new Promise((resolve) => setTimeout(() => resolve('late'), 40).unref());

  it('counts a slow source as not run', async () => {
    assert.equal(await within(slow(), 'test', 1), null);
  });

  it('lets a source take as long as its own limit allows', async () => {
    assert.equal(await within(slow(), 'test', 1_000), 'late');
  });
});

describe('parseGusts', () => {
  const report = (rawOb: string) => ({ icaoId: 'KPIT', obsTime: 1000, rawOb });
  const mph = (rawOb: string) => parseGusts([report(rawOb)]).map((g) => Math.round(g.mph));

  it('reads a gust in knots as mph', () => {
    assert.deepEqual(parseGusts([report('METAR KPIT 300151Z 27030G53KT 10SM RMK AO2')]).map((g) => ({ ...g, mph: Math.round(g.mph) })), [{ station: 'KPIT', at: 1_000_000, mph: 61 }]);
  });

  it('reads the peak in the remarks, which can beat the reported gust', () => {
    assert.deepEqual(mph('METAR KPIT 300151Z 27020G36KT 10SM RMK AO2 PK WND 27053/0135 SLP100'), [61]);
    assert.deepEqual(mph('METAR KPIT 300151Z 27005KT 10SM RMK AO2 PK WND 27041/35 SLP100'), [47]);
  });

  it('reads variable and three-digit winds', () => {
    assert.deepEqual(mph('METAR KPIT 300151Z VRB10G45KT 10SM'), [52]);
    assert.deepEqual(mph('METAR KPIT 300151Z 27060G100KT 10SM'), [115]);
  });

  it('skips reports below the level, with no gust, or with a broken sensor', () => {
    assert.deepEqual(mph('METAR KPIT 300151Z 27020G38KT 10SM'), []);
    assert.deepEqual(mph('METAR KPIT 300151Z 27020KT 10SM RMK AO2'), []);
    assert.deepEqual(mph('METAR KPIT 300151Z 27020G150KT 10SM'), []);
  });

  it('ignores anything that is not a usable report', () => {
    assert.deepEqual(parseGusts(null), []);
    assert.deepEqual(parseGusts([{ rawOb: 'METAR KPIT 300151Z 27030G53KT' }]), []);
  });
});

describe('readGusts', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('asks for a few stations at a time, because the feed stops at 400 reports', async () => {
    const asked: string[][] = [];
    globalThis.fetch = (async (url: string) => {
      const ids = new URL(url).searchParams.get('ids')!.split(',');
      asked.push(ids);
      return new Response(JSON.stringify(ids.slice(0, 1).map((icaoId) => ({ icaoId, obsTime: 1000, rawOb: `METAR ${icaoId} 300151Z 27030G53KT` }))));
    }) as typeof fetch;
    const stations = Array.from({ length: 60 }, (_, i) => `K${i}`);
    const gusts = await readGusts(stations);
    assert.equal(asked.flat().length, 60);
    assert.ok(asked.every((ids) => ids.length <= 25));
    assert.equal(gusts.length, asked.length);
  });

  it('treats an empty answer as no reports, not a failure', async () => {
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
    assert.deepEqual(await readGusts(['KPIT']), []);
  });

  it('fails as a whole if a request fails, so a gap is never read as calm', async () => {
    globalThis.fetch = (async () => new Response('', { status: 503 })) as typeof fetch;
    await assert.rejects(readGusts(['KPIT']));
  });

  it('asks for nothing when there are no stations', async () => {
    globalThis.fetch = (async () => assert.fail('should not fetch')) as typeof fetch;
    assert.deepEqual(await readGusts([]), []);
  });
});

describe('storm reports in Virginia cities and Washington', () => {
  it('places reports SPC writes differently', () => {
    const csv = ['Time,Speed,Location,County,State,Lat,Lon,Comments', '1810,UNK,3 W Suffolk,City of Suffolk,VA,36.7,-76.6,x', '1820,UNK,Washington,District of Colum,DC,38.9,-77.0,x', '1830,UNK,2 E Annapolis,ANZ536,MD,38.9,-76.4,x'].join('\n');
    assert.deepEqual(parseStormReports(csv, 0).map((r) => r.fips), ['51800', '11001', undefined]);
  });
});
