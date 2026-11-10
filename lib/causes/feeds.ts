import { resolveReportCounty } from '../geo.ts';
import { expectShape, getJson, getText, pool } from '../sources/http.ts';
import { type OperatorNotice, readNotices } from './operators.ts';
import { CONTEXT_EVENTS, EXPLAINING_EVENTS, FIRE_MIN_ACRES, WIND_GUST_MPH } from './rules.ts';

const NWS = 'https://api.weather.gov/alerts';
const SPC = 'https://www.spc.noaa.gov/climo/reports';
const USGS = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson';
const KP = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json';
const METAR = 'https://aviationweather.gov/api/data/metar';
const WFIGS = 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0/query';

const HOUR = 3_600_000;
/** Warnings are searched by issue time, so look back past the longest window in use. */
const WEATHER_LOOKBACK_MS = 6 * HOUR;
const WEATHER_PAGE_LIMIT = 4;
/** How far back to search once NWS is readable again. Its API keeps about a week. */
const WEATHER_MAX_LOOKBACK_MS = 48 * HOUR;
/**
 * Each Kp row is dated from the start of its 3-hour period and appears only once the period
 * ends, so just before each update the newest is 6 hours old plus NOAA's delay. At exactly 6
 * hours this read as a broken feed at every update.
 */
export const KP_MAX_AGE_MS = 9 * HOUR;
/** Enough to reach 3 hours before a start even when the alert opened well after it. */
const GUST_HOURS = 6;
/**
 * The feed stops at 400 reports, newest first, and allows about 100 requests a minute.
 * A quiet station files 10 reports in 6 hours, so this leaves room for a stormy one.
 */
const STATIONS_PER_REQUEST = 25;
const GUST_CONCURRENCY = 4;
const KNOTS_TO_MPH = 1.15078;
/** A reading above this is a bad sensor, not wind. */
const MAX_GUST_MPH = 130;
/** No single source may hold up an alert for longer than this. */
const SOURCE_DEADLINE_MS = 10_000;
/** The airport feed takes several seconds on a first read, and a check needs several reads. */
const GUST_DEADLINE_MS = 25_000;

export interface WeatherAlert {
  id: string;
  event: string;
  start: number;
  end: number;
  fips: string[];
}

export interface StormReport {
  kind: 'tornado' | 'wind';
  at: number;
  fips?: string;
  place: string;
}

export interface Wildfire {
  name: string;
  fips: string;
  acres: number;
  discoveredAt: number;
}

export interface Quake {
  id: string;
  magnitude: number;
  place: string;
  at: number;
  lon: number;
  lat: number;
  url?: string;
}

export interface KpReading {
  at: number;
  kp: number;
}

/** A reading from an airport weather station, at the strength that matters. */
export interface GustReading {
  station: string;
  at: number;
  mph: number;
}

/** What each check found this poll. Null means that source could not be read. */
export interface World {
  weather: WeatherAlert[] | null;
  reports: StormReport[] | null;
  gusts: GustReading[] | null;
  fires: Wildfire[] | null;
  quakes: Quake[] | null;
  kp: KpReading[] | null;
  /** Per operator, read only when a blackout is large enough for a notice to matter. */
  notices?: Record<string, OperatorNotice[] | null>;
}

export function parseWeatherAlerts(doc: any): WeatherAlert[] {
  const out: WeatherAlert[] = [];
  for (const feature of doc?.features ?? []) {
    const p = feature?.properties;
    if (!p?.event || p.messageType === 'Cancel') continue;
    if (!EXPLAINING_EVENTS.has(p.event) && !CONTEXT_EVENTS.has(p.event)) continue;
    const start = Date.parse(p.onset ?? p.effective ?? p.sent);
    const end = Date.parse(p.ends ?? p.expires);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    // SAME codes are 0 plus the county FIPS; a non-zero prefix is part of a county.
    const fips = (p.geocode?.SAME ?? []).map((code: string) => code.slice(1));
    out.push({ id: String(p.id), event: p.event, start, end, fips });
  }
  return out;
}

/** The SPC day runs 12Z to 12Z, so times before noon UTC fall on the next date. */
export function convectiveDayStart(at: Date): number {
  const day = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), 12);
  return at.getTime() >= day ? day : day - 24 * HOUR;
}

export function parseStormReports(csv: string, dayStart: number): StormReport[] {
  const out: StormReport[] = [];
  let kind: StormReport['kind'] | null = null;
  for (const line of csv.split('\n')) {
    if (line.startsWith('Time,')) {
      const column = line.split(',')[1];
      kind = column === 'F_Scale' ? 'tornado' : column === 'Speed' ? 'wind' : null;
      continue;
    }
    if (!kind) continue;
    const [time, , location, county, state] = line.split(',');
    if (!/^\d{4}$/.test(time ?? '') || !county || !state) continue;
    const hhmm = Number(time);
    const minutes = Math.floor(hhmm / 100) * 60 + (hhmm % 100);
    const fromNoon = hhmm >= 1200 ? minutes - 720 : minutes + 720;
    out.push({ kind, at: dayStart + fromNoon * 60_000, fips: resolveReportCounty(county, state.trim()), place: `${location}, ${state}`.trim() });
  }
  return out;
}

/** The strongest gust in a raw report. A peak often falls between reports, so the remarks count too. */
export function parseGusts(rows: any): GustReading[] {
  const out: GustReading[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const raw = String(row?.rawOb ?? '');
    const knots = [...raw.matchAll(/\b(?:\d{3}|VRB)\d{2,3}G(\d{2,3})KT\b/g), ...raw.matchAll(/\bPK WND \d{3}(\d{2,3})\//g)].map((m) => Number(m[1]));
    if (!knots.length || !row.icaoId || !row.obsTime) continue;
    const mph = Math.max(...knots) * KNOTS_TO_MPH;
    if (mph >= WIND_GUST_MPH && mph <= MAX_GUST_MPH) out.push({ station: String(row.icaoId), at: Number(row.obsTime) * 1000, mph });
  }
  return out;
}

export function parseFires(doc: any): Wildfire[] {
  return (doc?.features ?? [])
    .map((f: any) => f.attributes ?? {})
    .filter((a: any) => a.POOFips && a.FireDiscoveryDateTime)
    .map((a: any) => ({ name: String(a.IncidentName ?? 'Unnamed fire'), fips: String(a.POOFips), acres: Number(a.IncidentSize) || 0, discoveredAt: Number(a.FireDiscoveryDateTime) }));
}

export function parseQuakes(doc: any): Quake[] {
  return (doc?.features ?? [])
    .filter((f: any) => f?.properties?.mag != null && f?.geometry?.coordinates)
    .map((f: any) => ({
      id: String(f.id),
      magnitude: Number(f.properties.mag),
      place: String(f.properties.place ?? 'Unknown location'),
      at: Number(f.properties.time),
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
      url: f.properties.url,
    }));
}

export function parseKp(rows: any): KpReading[] {
  return (Array.isArray(rows) ? rows : [])
    .map((r: any) => ({ at: Date.parse(`${r.time_tag}Z`), kp: Number(r.Kp) }))
    .filter((r) => Number.isFinite(r.at) && Number.isFinite(r.kp));
}

async function readWeatherPages(url: string): Promise<WeatherAlert[]> {
  const headers = { accept: 'application/geo+json' };
  const out: WeatherAlert[] = [];
  let next: string | undefined = url;
  for (let page = 0; next && page < WEATHER_PAGE_LIMIT; page++) {
    const doc: any = await getJson(next, { headers });
    expectShape(doc?.type === 'FeatureCollection' && doc.updated && Array.isArray(doc.features), 'NWS alerts');
    out.push(...parseWeatherAlerts(doc));
    next = doc?.pagination?.next;
  }
  return out;
}

/**
 * Active warnings catch multi-day ones; recent history catches those that have just ended.
 * readThrough is the last successful read, so warnings issued during an NWS outage are found.
 */
export async function readWeatherAlerts(states: string[], now: Date, readThrough = now.getTime()): Promise<WeatherAlert[]> {
  const area = `area=${states.join(',')}`;
  const from = Math.max(Math.min(now.getTime(), readThrough) - WEATHER_LOOKBACK_MS, now.getTime() - WEATHER_MAX_LOOKBACK_MS);
  const [active, recent] = await Promise.allSettled([
    readWeatherPages(`${NWS}/active?status=actual&${area}`),
    readWeatherPages(`${NWS}?status=actual&${area}&start=${new Date(from).toISOString()}&end=${now.toISOString()}`),
  ]);
  if (active.status === 'rejected') throw active.reason;
  // History only adds warnings that have just ended, so active ones alone still count as a read.
  const ended = recent.status === 'fulfilled' ? recent.value : [];
  return [...new Map([...active.value, ...ended].map((a) => [a.id, a])).values()];
}

/** Each file holds a table each of tornado, wind and hail reports, with or without rows in them. */
const reportsFile = async (name: string) => {
  const csv = await getText(`${SPC}/${name}`);
  expectShape(csv.match(/^Time,/gm)?.length === 3, 'SPC storm reports');
  return csv;
};

export async function readStormReports(now: Date): Promise<StormReport[]> {
  const today = convectiveDayStart(now);
  const [current, previous] = await Promise.all([reportsFile('today_filtered.csv'), reportsFile('yesterday_filtered.csv')]);
  return [...parseStormReports(current, today), ...parseStormReports(previous, today - 24 * HOUR)];
}

export async function readFires(): Promise<Wildfire[]> {
  const params = new URLSearchParams({
    where: `IncidentTypeCategory='WF' AND IncidentSize>=${FIRE_MIN_ACRES} AND FireOutDateTime IS NULL`,
    outFields: 'IncidentName,POOFips,IncidentSize,FireDiscoveryDateTime',
    returnGeometry: 'false',
    f: 'json',
  });
  const doc = await getJson(`${WFIGS}?${params}`);
  expectShape(!doc?.error && Array.isArray(doc?.features), 'NIFC fires');
  return parseFires(doc);
}

export async function readQuakes(): Promise<Quake[]> {
  const doc = await getJson(USGS);
  expectShape(doc?.metadata?.status === 200 && doc.metadata.generated && Array.isArray(doc.features), 'USGS earthquakes');
  return parseQuakes(doc);
}

export async function readKp(now: Date): Promise<KpReading[]> {
  const rows = parseKp(await getJson(KP));
  expectShape(rows.some((r) => now.getTime() - r.at < KP_MAX_AGE_MS), 'NOAA Kp index');
  return rows;
}

export async function readGusts(stations: string[]): Promise<GustReading[]> {
  const groups: string[][] = [];
  for (let i = 0; i < stations.length; i += STATIONS_PER_REQUEST) groups.push(stations.slice(i, i + STATIONS_PER_REQUEST));
  const pages = await pool(groups, GUST_CONCURRENCY, async (ids) => {
    // The feed answers with an empty body when these stations have nothing to report.
    const text = await getText(`${METAR}?ids=${ids.join(',')}&format=json&hours=${GUST_HOURS}`);
    if (!text) return [];
    const rows = JSON.parse(text);
    expectShape(Array.isArray(rows) && (!rows.length || rows.some((r) => r?.rawOb)), 'METAR reports');
    return parseGusts(rows);
  });
  return pages.flat();
}

export function within<T>(work: Promise<T>, name: string, limit = SOURCE_DEADLINE_MS): Promise<T | null> {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('deadline passed')), limit);
  });
  return Promise.race([work, deadline])
    .catch((err: Error) => {
      console.error(`${name} check failed:`, err.message);
      return null;
    })
    .finally(() => clearTimeout(timer));
}

export async function gatherWorld(states: string[], stations: string[], operators: string[], now: Date, readThrough?: number): Promise<World> {
  const [weather, reports, gusts, fires, quakes, kp, notices] = await Promise.all([
    within(readWeatherAlerts(states, now, readThrough), 'weather'),
    within(readStormReports(now), 'storm report'),
    within(readGusts(stations), 'wind gust', GUST_DEADLINE_MS),
    within(readFires(), 'wildfire'),
    within(readQuakes(), 'earthquake'),
    within(readKp(now), 'space weather'),
    Promise.all(operators.map(async (o) => [o, await within(readNotices(o, now), `${o} notice`)] as const)),
  ]);
  return { weather, reports, gusts, fires, quakes, kp, notices: Object.fromEntries(notices) };
}
