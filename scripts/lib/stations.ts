// Airport weather stations and their history, from Iowa State's archive.
import fs from 'node:fs';
import { geoContains } from 'd3-geo';
import { feature } from 'topojson-client';
import { metroForCounty } from '../../lib/geo.ts';
import { CACHE, cached, statePrefix } from './warnings.ts';

export const ASOS = 'https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py';
export const COLUMNS = 'data=gust&data=peak_wind_gust&tz=Etc/UTC&format=onlycomma&latlon=no&missing=empty&trace=empty&direct=no&report_type=3&report_type=4';
const NETWORK = 'https://mesonet.agron.iastate.edu/geojson/network';
const KNOTS_TO_MPH = 1.15078;
/** Readings under this are never close to a rule, so they aren't kept. */
const KEEP_MPH = 35;
/** A reading above this is a bad sensor, not wind. */
const MAX_MPH = 130;

export interface Gust {
  at: number;
  sid: string;
  /** The highest of the reported gust and the peak in the remarks. */
  mph: number;
  /** The reported gust alone. */
  gust: number;
}

export function parseGusts(csv: string): Gust[] {
  const out: Gust[] = [];
  for (const line of csv.split('\n').slice(1)) {
    const [sid, valid, gust, peak] = line.split(',');
    if (!valid) continue;
    const reported = (Number(gust) || 0) * KNOTS_TO_MPH;
    const mph = Math.max(reported, (Number(peak) || 0) * KNOTS_TO_MPH);
    if (mph >= KEEP_MPH && mph <= MAX_MPH) out.push({ at: Date.parse(`${valid.replace(' ', 'T')}Z`), sid, mph, gust: reported });
  }
  return out;
}

/** Iowa State drops the K from US airports. Alaska, Hawaii and Puerto Rico keep four letters. */
export const icaoOf = (sid: string) => (/^[A-Z]{4}$/.test(sid) ? sid : `K${sid}`);

/** County borders here are simplified, so an airport beside one can fall just outside it. */
const BORDER_MARGIN_DEGREES = 0.05;

const atlas = JSON.parse(fs.readFileSync('node_modules/us-atlas/counties-10m.json', 'utf8'));
const counties: any[] = (feature(atlas, atlas.objects.counties) as any).features;

/** A county's shape, or all of its metro's. The archive files some airports under a neighbor. */
const areaOf = (fips: string) => {
  const metro = metroForCounty(fips);
  return counties.filter((c) => (metro ? metroForCounty(String(c.id)) === metro : String(c.id) === fips));
};

function inArea(fips: string, [lon, lat]: [number, number]): boolean {
  const shapes = areaOf(fips);
  if (!shapes.length) return true;
  const reach = [0, BORDER_MARGIN_DEGREES, -BORDER_MARGIN_DEGREES];
  const stretch = 1 / Math.cos((lat * Math.PI) / 180);
  return shapes.some((shape) => reach.some((y) => reach.some((x) => geoContains(shape, [lon + x * stretch, lat + y]))));
}

/**
 * Station ids by county. The archive gives every
 * station the nearest county, which puts oil platforms in the Gulf in New Orleans, so a
 * station has to really be there.
 */
export async function loadStations(): Promise<Map<string, string[]>> {
  const byCounty = new Map<string, string[]>();
  for (const state of statePrefix.keys()) {
    const text = await cached(`${CACHE}/stations-${state}.json`, `${NETWORK}/${state}_ASOS.geojson`).catch(() => '');
    if (!text) continue;
    for (const f of JSON.parse(text).features) {
      const ugc: string | null = f.properties.ugc_county;
      const prefix = ugc && statePrefix.get(ugc.slice(0, 2));
      if (!ugc || !prefix) continue;
      const fips = `${prefix}${ugc.slice(3)}`;
      if (!inArea(fips, f.geometry.coordinates)) continue;
      byCounty.set(fips, [...(byCounty.get(fips) ?? []), f.properties.sid]);
    }
  }
  return byCounty;
}

export async function readingsFor(sid: string): Promise<Gust[]> {
  const url = `${ASOS}?station=${sid}&${COLUMNS}&year1=2023&month1=12&day1=31&year2=2026&month2=1&day2=2`;
  return parseGusts(await cached(`${CACHE}/asos-${sid}.csv`, url));
}

/** Days with a reading of 45+ mph, a measure of how windy a station always is. */
export const windyDays = (list: Gust[]) => new Set(list.filter((g) => g.mph >= 45).map((g) => Math.floor(g.at / 86_400_000))).size;
