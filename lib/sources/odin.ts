import { expectShape, getJson, requireCount } from './http.ts';

const EXPORT_URL =
  'https://ornl.opendatasoft.com/api/explore/v2.1/catalog/datasets/odin-real-time-outages-county/exports/json' +
  '?select=utility_id,name,communitydescriptor,metersaffected,reportedstarttime';
/** The newest outage in a live feed is minutes old. This long means ODIN has stopped updating. */
const MAX_AGE_MS = 6 * 3_600_000;

/** ODIN identifies a few utilities by slug rather than EIA number. */
const SLUG_TO_EIA: Record<string, number> = {
  pugetsoundenergy: 15500,
  avista: 20169,
  holycrossenergy: 8817,
  centrallincolnpud: 3264,
};

/**
 * Companies EIA has merged but ODIN still reports separately. Without this, their
 * outages are counted twice: once here and once in the merged company's own feed.
 */
const MERGED_EIA: Record<number, number> = {
  12390: 66101, // Metropolitan Edison -> FirstEnergy Pennsylvania Electric
  14711: 66101, // Pennsylvania Electric
  14716: 66101, // Pennsylvania Power
  20387: 66101, // West Penn Power
};

export interface OdinRow {
  eiaId: number | null;
  utilityName: string;
  fips: string;
  customersOut: number;
}

export async function readOdin(now = Date.now()): Promise<OdinRow[]> {
  const rows = await getJson<any[]>(EXPORT_URL);
  expectShape(Array.isArray(rows) && rows.length > 0, 'ODIN export');
  const newest = Math.max(...rows.map((r) => Date.parse(r.reportedstarttime ?? '')).filter(Number.isFinite));
  if (!Number.isFinite(newest) || now - newest > MAX_AGE_MS) throw new Error('ODIN has stopped updating');
  return rows.map((r) => {
    const id = String(r.utility_id ?? '');
    const raw = /^\d+$/.test(id) ? Number(id) : (SLUG_TO_EIA[id] ?? null);
    const eiaId = raw != null ? (MERGED_EIA[raw] ?? raw) : null;
    return {
      eiaId,
      utilityName: String(r.name ?? '').replace(/,[^,]*$/, ''),
      fips: String(r.communitydescriptor ?? '').padStart(5, '0'),
      customersOut: requireCount(r.metersaffected, 'ODIN metersaffected'),
    };
  });
}
