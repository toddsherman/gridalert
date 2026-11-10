import assert from 'node:assert/strict';
import { afterEach, it, mock } from 'node:test';
import { readArcgis, readArcgisCauses, readJson, readJsonCauses, readRegex } from './generic.ts';

afterEach(() => mock.restoreAll());

const stub = (body: unknown) => mock.method(globalThis, 'fetch', async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 }));

it('sums a list and maps areas', async () => {
  stub({ outages: [{ 'County Name': 'Nassau', 'Customers Out': '1,204', 'Customers Served': '31,567' }, { 'County Name': 'Duval', 'Customers Out': '0', 'Customers Served': '500' }] });
  const r = await readJson({ url: 'https://x.test', listPath: 'outages', outField: 'Customers Out', servedField: 'Customers Served', areaField: 'County Name', state: 'FL' });
  assert.equal(r.customersOut, 1204);
  assert.equal(r.customersServed, 32067);
  assert.deepEqual(r.areas?.[0], { state: 'FL', name: 'Nassau', kind: 'county', customersOut: 1204, customersServed: 31567 });
});

it('reads each row\'s state from a multi-state feed', async () => {
  stub([
    { numPeople: 40, county: 'DENVER', additionalProperties: [{ property: 'states', value: 'CO' }] },
    { numPeople: 7, county: 'YOAKUM', additionalProperties: [{ property: 'states', value: ['TX'] }] },
    { numPeople: 3, county: 'HENNEPIN', additionalProperties: [] },
  ]);
  const r = await readJson({ url: 'https://x.test', listPath: '', outField: 'numPeople', areaField: 'county', stateProperty: 'states' });
  assert.equal(r.customersOut, 50);
  assert.deepEqual(r.areas?.map((a) => a.state), ['CO', 'TX', undefined]);
});

it('keeps unnamed rows in the total but not in the areas', async () => {
  stub([{ n: 5, c: 'Wake' }, { n: 3 }]);
  const r = await readJson({ url: 'https://x.test', listPath: '', outField: 'n', areaField: 'c' });
  assert.equal(r.customersOut, 8);
  assert.equal(r.areas?.length, 1);
});

it('prefers a published total over a summed list', async () => {
  stub({ total: 900, rows: [{ n: 1 }] });
  const r = await readJson({ url: 'https://x.test', listPath: 'rows', outField: 'n', totalPath: 'total' });
  assert.equal(r.customersOut, 900);
});

it('fails loudly when a feed changes shape', async () => {
  stub({ somethingElse: true });
  await assert.rejects(readJson({ url: 'https://x.test', listPath: 'rows', outField: 'n' }), /not an array/);
  await assert.rejects(readJson({ url: 'https://x.test', totalPath: 'a.b' }), /missing/);
});

it('sums every match in markup when asked', async () => {
  stub('<outages><outage numOut="12"/><outage numOut="1,030"/></outages>');
  const r = await readRegex({ url: 'https://x.test', pattern: 'numOut="([\\d,]+)"', sumAll: true });
  assert.equal(r.customersOut, 1042);
  assert.equal(r.incidents, 2);
});

it('counts zero, not an error, when a sum finds no rows', async () => {
  stub('<outages></outages>');
  assert.equal((await readRegex({ url: 'https://x.test', pattern: 'numOut="(\\d+)"', sumAll: true })).customersOut, 0);
});

it('surfaces ArcGIS errors, which arrive with HTTP 200', async () => {
  stub({ error: { code: 400, message: 'Invalid query' } });
  await assert.rejects(readArcgis({ layerUrl: 'https://x.test/0', outField: 'n' }), /Invalid query/);
});

it('reads causes by area, so they can be limited to a blackout\'s counties', async () => {
  const asked: string[] = [];
  mock.method(globalThis, 'fetch', async (url: string) => {
    asked.push(url);
    return new Response(JSON.stringify({ features: [{ attributes: { Why: 'Tree', County: 'Kern', out_sum: 12 } }, { attributes: { Why: 'Tree', County: 'Ventura', out_sum: 0 } }] }));
  });
  const rows = await readArcgisCauses({ layerUrl: 'https://x.test/0', outField: 'n', causeField: 'Why', areaField: 'County', state: 'CA' });
  assert.deepEqual(rows, [{ cause: 'Tree', customers: 12, place: { name: 'Kern', state: 'CA', kind: 'county' } }]);
  assert.equal(new URL(asked[0]).searchParams.get('groupByFieldsForStatistics'), 'Why,County');
});

it('reads causes row by row from a JSON feed, with the place of each', async () => {
  stub({ rows: [{ c: 'Tree', a: 'Kern', n: 3 }, { c: 'Tree', a: 'Inyo', n: 4 }] });
  assert.deepEqual((await readJsonCauses({ url: 'https://x.test/', listPath: 'rows', outField: 'n', causeField: 'c', areaField: 'a', state: 'CA' })).map((r) => r.place?.name), ['Kern', 'Inyo']);
});
