import assert from 'node:assert/strict';
import { afterEach, it, mock } from 'node:test';
import { readOdin } from './odin.ts';

afterEach(() => mock.restoreAll());

const NOW = Date.UTC(2026, 10, 2, 4);
const FRESH = '2026-11-02T03:30:00+00:00';

/** Serves the rows, and ODIN's own account of when it last rebuilt them if one is given. */
function stubFeed(rows: unknown[], processed?: string) {
  mock.method(globalThis, 'fetch', async (url: string) => {
    if (!String(url).includes('/exports/')) return processed ? new Response(JSON.stringify({ metas: { default: { data_processed: processed } } })) : new Response('gone', { status: 500 });
    return new Response(JSON.stringify(rows.map((r) => ({ reportedstarttime: FRESH, ...(r as object) }))), { status: 200 });
  });
}

it('folds merged companies into their current EIA id so they are not double counted', async () => {
  stubFeed([
    { utility_id: '20387', name: 'WEST PENN POWER COMPANY,20387', communitydescriptor: '42125', metersaffected: 1037 },
    { utility_id: '12390', name: 'METROPOLITAN EDISON CO,12390', communitydescriptor: '42011', metersaffected: 31 },
  ]);
  const rows = await readOdin(NOW);
  assert.deepEqual(rows.map((r) => r.eiaId), [66101, 66101]);
});

it('resolves slugs, pads FIPS and keeps unknown reporters', async () => {
  stubFeed([
    { utility_id: 'pugetsoundenergy', name: 'Puget Sound Energy Inc,pugetsoundenergy', communitydescriptor: '53073', metersaffected: 23 },
    { utility_id: '803', name: 'ARIZONA PUBLIC SERVICE CO,803', communitydescriptor: '4025', metersaffected: 22 },
    { utility_id: 'bentonpud', name: 'PUD No 1 of Benton County,bentonpud', communitydescriptor: '53005', metersaffected: 1 },
  ]);
  const rows = await readOdin(NOW);
  assert.equal(rows[0].eiaId, 15500);
  assert.equal(rows[1].fips, '04025');
  assert.equal(rows[1].utilityName, 'ARIZONA PUBLIC SERVICE CO');
  assert.equal(rows[2].eiaId, null);
});

it('refuses an empty or frozen export, either of which would read as a quiet night', async () => {
  stubFeed([]);
  await assert.rejects(readOdin(NOW), /changed shape/);
  mock.restoreAll();
  stubFeed([{ utility_id: '803', name: 'A,803', communitydescriptor: '4025', metersaffected: 2, reportedstarttime: '2026-11-01T12:00:00+00:00' }]);
  await assert.rejects(readOdin(NOW), /stopped updating/);
});

const OLD_OUTAGE = { utility_id: '803', name: 'A,803', communitydescriptor: '4025', metersaffected: 2, reportedstarttime: '2026-11-01T12:00:00+00:00' };

it('goes by when ODIN last rebuilt its data, so a night with no new outage is not a stoppage', async () => {
  stubFeed([OLD_OUTAGE], '2026-11-02T03:45:00+00:00');
  assert.equal((await readOdin(NOW)).length, 1);
});

it('counts as stopped when ODIN has not rebuilt its data for hours, however new its outages look', async () => {
  stubFeed([{ ...OLD_OUTAGE, reportedstarttime: FRESH }], '2026-11-02T01:30:00+00:00');
  await assert.rejects(readOdin(NOW), /stopped updating/);
});

it('refuses a row with no count, rather than reading nobody out', async () => {
  stubFeed([{ utility_id: '803', name: 'A,803', communitydescriptor: '4025' }]);
  await assert.rejects(readOdin(NOW), /metersaffected is missing/);
});
