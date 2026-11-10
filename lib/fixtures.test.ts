import assert from 'node:assert/strict';
import fs from 'node:fs';
import { afterEach, describe, it } from 'node:test';
import { readFires, readGusts, readKp, readQuakes, readStormReports, readWeatherAlerts } from './causes/feeds.ts';
import { OFFICIAL_FEEDS, readOfficialFeed } from './causes/news.ts';
import { readNotices } from './causes/operators.ts';
import { readArcgis } from './sources/generic.ts';
import { ShapeError } from './sources/http.ts';
import { readKubra } from './sources/kubra.ts';
import { readOdin } from './sources/odin.ts';

// Real responses, saved by scripts/save-fixtures.ts. Every reader has to work on its real
// document, and has to fail, not report nothing, on one that's changed. A maintenance page is
// the commonest case: it's a 200 that would otherwise read as nothing going on.

const NOW = new Date(Date.UTC(2026, 10, 2, 4));
const fixture = (name: string) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const MAINTENANCE = '<html><body><h1>Down for maintenance</h1></body></html>';
const EMPTY_JSON = '{}';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const serve = (body: string | ((url: string) => string | Response)) => {
  globalThis.fetch = (async (url: string) => {
    const reply = typeof body === 'string' ? body : body(String(url));
    return typeof reply === 'string' ? new Response(reply) : reply;
  }) as unknown as typeof fetch;
};

const kp = JSON.parse(fixture('kp.json'));
const kpNow = new Date(Date.parse(`${kp.at(-1).time_tag}Z`) + 3_600_000);
const odin = JSON.parse(fixture('odin.json'));
const odinNow = Math.max(...odin.map((r: { reportedstarttime: string }) => Date.parse(r.reportedstarttime))) + 3_600_000;

const cases: Array<{ name: string; file: string; read: () => Promise<unknown>; changed: string[] }> = [
  { name: 'National Weather Service', file: 'nws.json', read: () => readWeatherAlerts(['TX'], NOW), changed: [EMPTY_JSON, '{"type":"Error","title":"Unavailable"}', MAINTENANCE] },
  { name: 'Storm Prediction Center', file: 'spc.csv', read: () => readStormReports(NOW), changed: [MAINTENANCE, 'Time,Speed,Location,County,State,Lat,Lon,Comments\n'] },
  { name: 'Aviation Weather Center', file: 'metar.json', read: () => readGusts(['KJFK']), changed: ['{"error":"gone"}', '[{"station":"KJFK"}]', MAINTENANCE] },
  { name: 'National Interagency Fire Center', file: 'wfigs.json', read: () => readFires(), changed: [EMPTY_JSON, '{"error":{"code":400,"message":"Invalid query"}}', MAINTENANCE] },
  { name: 'US Geological Survey', file: 'usgs.json', read: () => readQuakes(), changed: [EMPTY_JSON, '{"features":[]}', MAINTENANCE] },
  { name: 'NOAA Space Weather', file: 'kp.json', read: () => readKp(kpNow), changed: ['[]', '[["time_tag","Kp"]]', '[{"time_tag":"2026-01-01T00:00:00","Kp":1}]', MAINTENANCE] },
  { name: 'MISO', file: 'miso.json', read: () => readNotices('MISO', NOW), changed: ['[]', '[{"notifications":[]}]', EMPTY_JSON, MAINTENANCE] },
  { name: 'PJM', file: 'pjm.html', read: () => readNotices('PJM', NOW), changed: [MAINTENANCE] },
  { name: 'SPP', file: 'spp.html', read: () => readNotices('SWPP', NOW), changed: [MAINTENANCE, '<h3>East BAA: Normal</h3>'] },
  { name: 'ISO New England', file: 'isone.html', read: () => readNotices('ISNE', NOW), changed: [MAINTENANCE] },
  { name: 'New York ISO', file: 'nyiso.csv', read: () => readNotices('NYIS', NOW), changed: [MAINTENANCE] },
  { name: 'California ISO', file: 'caiso.json', read: () => readNotices('CISO', NOW), changed: [EMPTY_JSON, '{"CurrentEvents":[]}', MAINTENANCE] },
  { name: 'CISA', file: 'rss.xml', read: () => readOfficialFeed(OFFICIAL_FEEDS[0]), changed: [MAINTENANCE, '<rss></rss>'] },
  { name: 'DOE ODIN', file: 'odin.json', read: () => readOdin(odinNow), changed: ['[]', EMPTY_JSON, MAINTENANCE] },
  { name: 'ArcGIS feeds', file: 'arcgis.json', read: () => readArcgis({ layerUrl: 'https://x.test/FeatureServer/0', outField: 'out' }), changed: [EMPTY_JSON, '{"error":{"message":"Invalid field"}}', MAINTENANCE] },
];

for (const { name, file, read, changed } of cases) {
  describe(name, () => {
    it('reads its real document', async () => {
      serve(fixture(file));
      await read();
    });

    for (const body of changed) {
      it(`fails on ${body.slice(0, 40)}`, async () => {
        serve(body);
        await assert.rejects(read());
      });
    }
  });
}

describe('a changed document, as opposed to a site being down', () => {
  it('is reported as such, because that one needs a code fix', async () => {
    serve(MAINTENANCE);
    await assert.rejects(readNotices('PJM', NOW), ShapeError);
    serve('{"CurrentEvents":[]}');
    await assert.rejects(readNotices('CISO', NOW), ShapeError);
  });
});

describe('New York ISO files', () => {
  it('copes with today\'s file not existing yet', async () => {
    let first = true;
    serve(() => {
      if (first) {
        first = false;
        return fixture('nyiso.csv');
      }
      return new Response('', { status: 404 });
    });
    await readNotices('NYIS', NOW);
  });

  it('fails if neither day has a file, since then nothing was read', async () => {
    serve(() => new Response('', { status: 404 }));
    await assert.rejects(readNotices('NYIS', NOW), ShapeError);
  });
});

describe('the storm warning check', () => {
  it('still counts active warnings if the recent history fails', async () => {
    serve((url) => (url.includes('/active') ? fixture('nws.json') : new Response('', { status: 503 })));
    await readWeatherAlerts(['TX'], NOW);
  });

  it('fails if active warnings cannot be read', async () => {
    serve((url) => (url.includes('/active') ? new Response('', { status: 503 }) : fixture('nws.json')));
    await assert.rejects(readWeatherAlerts(['TX'], NOW));
  });

  it('looks back past a gap, but only so far', async () => {
    const asked: string[] = [];
    serve((url) => {
      asked.push(url);
      return fixture('nws.json');
    });
    await readWeatherAlerts(['TX'], NOW, NOW.getTime() - 10 * 3_600_000);
    const since = (at: string) => Date.parse(new URL(at).searchParams.get('start')!);
    assert.equal(since(asked.find((u) => u.includes('start='))!), NOW.getTime() - 16 * 3_600_000);
    asked.length = 0;
    await readWeatherAlerts(['TX'], NOW, NOW.getTime() - 500 * 3_600_000);
    assert.equal(since(asked.find((u) => u.includes('start='))!), NOW.getTime() - 48 * 3_600_000);
  });
});

describe('Kubra', () => {
  const cfg = { instanceId: 'i', viewId: 'v' };
  const route = (summary: string, report: string | Response) => (url: string) => {
    if (url.includes('currentState')) return fixture('kubra-state.json');
    if (url.includes('/configuration/')) return fixture('kubra-config.json');
    return url.includes('summary') ? summary : report;
  };
  const summary = (total: unknown) => JSON.stringify({ summaryFileData: { totals: [total], date_generated: '2026-11-02T03:00:00Z' } });

  it('reads its real documents', async () => {
    serve(route(fixture('kubra-summary.json'), fixture('kubra-report.json')));
    const reading = await readKubra(cfg);
    assert.equal(typeof reading.customersOut, 'number');
  });

  it('fails if the total disappears, rather than reading nobody out', async () => {
    serve(route(summary({ total_outages: 3 }), fixture('kubra-report.json')));
    await assert.rejects(readKubra({ ...cfg, viewId: 'a' }), /total_cust_a is missing/);
  });

  it('flags a county report that failed while people are out', async () => {
    serve(route(summary({ total_cust_a: { val: 500 }, total_cust_s: 1_000_000, total_outages: 3 }), new Response('', { status: 503 })));
    assert.equal((await readKubra({ ...cfg, viewId: 'b' })).areasMissing, true);
  });

  it('does not flag it when nobody is out', async () => {
    serve(route(summary({ total_cust_a: { val: 0 }, total_cust_s: 1_000_000, total_outages: 0 }), new Response('', { status: 503 })));
    assert.equal((await readKubra({ ...cfg, viewId: 'c' })).areasMissing, false);
  });
});
