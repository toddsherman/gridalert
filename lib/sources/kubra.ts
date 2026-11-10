import type { UtilityCause } from '../types.ts';
import { FetchError, getJson, requireCount, toCount } from './http.ts';
import type { AreaReading, KubraConfig, KubraLegacyConfig, Reading } from './types.ts';

const BASE = 'https://kubra.io/';
/** Tile zoom to start a cause walk from: about one county across. */
const TILE_ZOOM = 9;
const MAX_TILE_ZOOM = 15;
/** Tile requests per utility per check. A large storm samples rather than walks it all. */
const TILE_BUDGET = 24;

const STATE_ABBR: Record<string, string> = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA', Colorado: 'CO', Connecticut: 'CT',
  Delaware: 'DE', 'District of Columbia': 'DC', Florida: 'FL', Georgia: 'GA', Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL',
  Indiana: 'IN', Iowa: 'IA', Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME', Maryland: 'MD',
  Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN', Mississippi: 'MS', Missouri: 'MO', Montana: 'MT',
  Nebraska: 'NE', Nevada: 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY',
  'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK', Oregon: 'OR', Pennsylvania: 'PA',
  'Rhode Island': 'RI', 'South Carolina': 'SC', 'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT',
  Vermont: 'VT', Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY',
};

const STATE_BY_LOWER = Object.fromEntries(Object.entries(STATE_ABBR).map(([name, abbr]) => [name.toLowerCase(), abbr]));

function normalizeState(value?: string): string | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^[A-Z]{2}$/.test(v)) return v;
  return STATE_BY_LOWER[v.toLowerCase()];
}

function areaKind(key: string): AreaReading['kind'] {
  if (key.includes('county') || key.includes('parish')) return 'county';
  if (key.includes('zip')) return 'zip';
  if (/city|town|muni|village|boro|twp/.test(key)) return 'city';
  return 'region';
}

/**
 * Walk a report tree and return its most useful level. Many trees go
 * county > town, so descent stops at a county: its totals are what metro
 * attribution needs, and town rows below it would lose that. A tree without key
 * fields can set stopDepth, which treats that depth as counties.
 */
export function flattenReport(node: any, inherited?: string, out: AreaReading[] = [], stopDepth?: number, depth = 0): AreaReading[] {
  const list: any[] = Array.isArray(node) ? node : (node?.areas ?? []);
  for (const area of list) {
    const name = area.name ?? area.area_name;
    const key = String(area.key ?? '').toLowerCase();
    const stop = stopDepth !== undefined ? depth === stopDepth : areaKind(key) === 'county';
    if (!stop && Array.isArray(area.areas) && area.areas.length) {
      // Only a parent's name can be a state: "Washington" as a leaf is a county.
      const state = normalizeState(area.geopolitical) ?? normalizeState(name) ?? inherited;
      flattenReport(area.areas, state, out, stopDepth, depth + 1);
      continue;
    }
    if (!name) continue;
    out.push({
      state: normalizeState(area.geopolitical) ?? inherited,
      name: String(name),
      kind: stopDepth !== undefined ? 'county' : areaKind(key),
      customersOut: toCount(area.cust_a),
      customersServed: toCount(area.cust_s) || undefined,
    });
  }
  return out;
}

const KIND_RANK: Record<AreaReading['kind'], number> = { county: 0, city: 1, zip: 2, region: 3, other: 4 };

/** Choose the most useful report: county beats city beats ZIP. */
function bestAreas(reports: AreaReading[][]): AreaReading[] | undefined {
  const usable = reports.filter((r) => r.length > 0);
  usable.sort((a, b) => KIND_RANK[a[0].kind] - KIND_RANK[b[0].kind]);
  return usable[0];
}

interface KubraDeployment {
  deploymentId: string;
  summarySource: string;
  reportSources: string[];
  /** Incident tile path with a {q} placeholder for the quadkey. */
  clusterSource?: string;
}

// Configuration documents are immutable per deployment id, so a warm function
// instance can skip re-reading them on every poll.
const deployments = new Map<string, KubraDeployment>();

async function resolveDeployment(cfg: KubraConfig, deploymentId: string): Promise<KubraDeployment> {
  const key = `${cfg.viewId}:${deploymentId}`;
  const cached = deployments.get(key);
  if (cached) return cached;
  const doc = await getJson(`${BASE}stormcenter/api/v1/stormcenters/${cfg.instanceId}/views/${cfg.viewId}/configuration/${deploymentId}?preview=false`);
  const summary = doc?.config?.summary?.data?.interval_generation_data?.source;
  const reports = doc?.config?.reports?.data?.interval_generation_data ?? [];
  const layers: any[] = doc?.config?.layers?.data?.interval_generation_data ?? [];
  const cluster = layers.find((l) => String(l?.type).startsWith('CLUSTER_LAYER'));
  const deployment = {
    deploymentId,
    summarySource: summary ?? 'public/summary-1/data.json',
    reportSources: (Array.isArray(reports) ? reports : []).map((r: any) => r.source).filter(Boolean),
    clusterSource: [cluster?.source].flat()[0],
  };
  deployments.set(key, deployment);
  return deployment;
}

export async function readKubra(cfg: KubraConfig): Promise<Reading> {
  const state = await getJson(`${BASE}stormcenter/api/v1/stormcenters/${cfg.instanceId}/views/${cfg.viewId}/currentState?preview=false`);
  const dataPath: string | undefined = state?.data?.interval_generation_data;
  if (!dataPath) throw new Error('Kubra currentState has no interval_generation_data');
  const deployment = await resolveDeployment(cfg, state.stormcenterDeploymentId);

  const summary = (await getJson(`${BASE}${dataPath}/${deployment.summarySource}`))?.summaryFileData;
  const totals: any[] = summary?.totals ?? [];
  if (!totals.length) throw new Error('Kubra summary has no totals');

  const chosen = cfg.sumTotals ? totals : [totals[cfg.totalIndex ?? 0]];
  const customersOut = chosen.reduce((sum, t) => sum + requireCount(t?.total_cust_a, 'Kubra total_cust_a'), 0);
  const customersServed = chosen.reduce((sum, t) => sum + toCount(t?.total_cust_s), 0) || undefined;
  const incidents = chosen.reduce((sum, t) => sum + toCount(t?.total_outages), 0);

  const reports = await Promise.all(
    deployment.reportSources.slice(0, 3).map((src) =>
      getJson(`${BASE}${dataPath}/${src}`)
        .then((doc) => flattenReport(doc?.file_data))
        .catch(() => [] as AreaReading[]),
    ),
  );
  const areas = bestAreas(reports);

  return {
    customersOut,
    customersServed,
    incidents,
    areas,
    areasMissing: deployment.reportSources.length > 0 && customersOut > 0 && !areas,
    asOf: summary?.date_generated,
    mode: summary?.page_mode?.mode,
  };
}

/** The tile covering a point, as a Bing-style quadkey. */
export function quadkey(lon: number, lat: number, zoom: number): string {
  const n = 2 ** zoom;
  const sin = Math.sin((lat * Math.PI) / 180);
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor((0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * n);
  let key = '';
  for (let i = zoom; i > 0; i--) {
    const bit = 1 << (i - 1);
    key += String((x & bit ? 1 : 0) + (y & bit ? 2 : 0));
  }
  return key;
}

/** Kubra stores positions as encoded polylines; a marker is a single point. */
export function decodePoint(encoded: string): [number, number] {
  const values: number[] = [];
  let shift = 0;
  let result = 0;
  for (let i = 0; i < encoded.length && values.length < 2; i++) {
    const byte = encoded.charCodeAt(i) - 63;
    result |= (byte & 0x1f) << shift;
    shift += 5;
    if (byte < 0x20) {
      values.push((result & 1 ? ~(result >> 1) : result >> 1) / 1e5);
      shift = 0;
      result = 0;
    }
  }
  return [values[1], values[0]];
}

/**
 * Tally incidents from one tile, and return the tiles to open for its clusters.
 * Clusters carry no cause, so the only way to one is down to its incidents.
 */
export function readTile(fileData: any[], zoom: number, totals: Map<string, number>, seen: Set<string>): string[] {
  const children: string[] = [];
  for (const item of fileData) {
    const desc = item?.desc;
    if (desc?.cluster) {
      const point = item?.geom?.p?.[0];
      if (point && zoom < MAX_TILE_ZOOM) children.push(quadkey(...decodePoint(point), Math.min(zoom + 2, MAX_TILE_ZOOM)));
      continue;
    }
    const id = String(desc?.inc_id ?? item?.id);
    if (seen.has(id)) continue;
    seen.add(id);
    // Labels come by language, and some incidents carry only the utility's own code, like {"orig":"-NDA-"}.
    const stated = desc?.cause && typeof desc.cause === 'object' ? (desc.cause['EN-US'] ?? desc.cause.orig) : desc?.cause;
    const cause = typeof stated === 'string' ? stated.trim() : '';
    totals.set(cause, (totals.get(cause) ?? 0) + toCount(desc?.cust_a));
  }
  return children;
}

/** Customers out per stated cause around the given points, from the map's incident tiles. */
export async function readKubraCauses(cfg: KubraConfig, points: Array<[number, number]>): Promise<UtilityCause[]> {
  const state = await getJson(`${BASE}stormcenter/api/v1/stormcenters/${cfg.instanceId}/views/${cfg.viewId}/currentState?preview=false`);
  const template: string | undefined = state?.data?.cluster_interval_generation_data;
  const { clusterSource } = await resolveDeployment(cfg, state.stormcenterDeploymentId);
  if (!template || !clusterSource) return [];

  const queue = [...new Set(points.map(([lon, lat]) => quadkey(lon, lat, TILE_ZOOM)))];
  const opened = new Set<string>();
  const incidents = new Set<string>();
  const totals = new Map<string, number>();
  while (queue.length && opened.size < TILE_BUDGET) {
    const key = queue.shift()!;
    if (opened.has(key)) continue;
    opened.add(key);
    const path = template.replace('{qkh}', key.slice(-3).split('').reverse().join(''));
    try {
      const tile = await getJson(`${BASE}${path}/${clusterSource.replace('{q}', key)}`);
      queue.push(...readTile(tile?.file_data ?? [], key.length, totals, incidents));
    } catch (err) {
      // Tiles only exist where there are outages.
      if (!(err instanceof FetchError) || (err.status !== 403 && err.status !== 404)) throw err;
    }
  }
  return [...totals].map(([cause, customers]) => ({ cause, customers })).filter((c) => c.customers > 0);
}

export async function readKubraLegacy(cfg: KubraLegacyConfig): Promise<Reading> {
  const base = cfg.baseUrl.replace(/\/$/, '');
  const { directory } = await getJson<{ directory: string }>(`${base}/metadata.json?_=${Date.now()}`);
  if (!directory) throw new Error('metadata.json has no directory');
  const data = await getJson(`${base}/${directory}/data.json`);
  const summary = data?.summaryFileData ?? data;
  // Older deployments publish totals directly on summaryFileData.
  const totals = summary?.totals?.[0] ?? summary ?? {};

  const files = cfg.reportFiles ?? (cfg.reportFile ? [cfg.reportFile] : []);
  const docs = await Promise.all(files.map((file) => getJson(`${base}/${directory}/${file}`).catch(() => null)));
  const flat = docs.flatMap((doc) => flattenReport(doc?.file_data, cfg.state, [], cfg.reportDepth));
  const areas = flat.length ? flat : undefined;

  const customersOut = requireCount(totals.total_cust_a, 'Kubra total_cust_a');
  return {
    customersOut,
    customersServed: toCount(totals.total_cust_s) || undefined,
    incidents: toCount(totals.total_outages),
    areas,
    areasMissing: files.length > 0 && customersOut > 0 && !areas,
    asOf: summary?.date_generated,
  };
}
