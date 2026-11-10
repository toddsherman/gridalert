// Build data/wind-stations.json: the airport stations in each metro whose gusts can
// explain a blackout. Stations that are windy all the time are left out, because a ridge
// in the same county says nothing about the city (docs/CAUSE_CHECKS.md).
//
// usage: node scripts/build_wind_stations.ts
// Station history comes from Iowa State's archive, cached in .cache/backtest.
import fs from 'node:fs';
import { metroForCounty } from '../lib/geo.ts';
import { metros } from '../lib/registry.ts';
import { icaoOf, loadStations, readingsFor, windyDays } from './lib/stations.ts';

/** Days of 45+ mph in the two years of history. */
const MAX_WINDY_DAYS = 40;
const STATION_INFO = 'https://aviationweather.gov/api/data/stationinfo';
const LOOKUP_BATCH = 200;
/**
 * Past this from the middle of a metro's stations, a gust says nothing about the metro. A Wind
 * Advisory doesn't narrow it down in counties the size of San Bernardino's, so distance has to.
 */
const MAX_SPREAD_KM = 140;

const median = (list: number[]) => list.slice().sort((a, b) => a - b)[list.length >> 1];

function nearTheRest(ids: string[], live: Map<string, [number, number]>): string[] {
  const points = ids.map((id) => live.get(id)!);
  const [lon, lat] = [median(points.map((p) => p[0])), median(points.map((p) => p[1]))];
  return ids.filter((id) => {
    const [x, y] = live.get(id)!;
    return Math.hypot((x - lon) * Math.cos((lat * Math.PI) / 180), y - lat) * 111.2 <= MAX_SPREAD_KM;
  });
}

/**
 * Where the live feed puts each station. An id can mean different places here and in the archive:
 * the archive's T89 is Castroville, Texas, while the live KT89 is at Lajitas, 430 km away.
 */
async function onLiveFeed(ids: string[]): Promise<Map<string, [number, number]>> {
  const known = new Map<string, [number, number]>();
  for (let i = 0; i < ids.length; i += LOOKUP_BATCH) {
    const res = await fetch(`${STATION_INFO}?ids=${ids.slice(i, i + LOOKUP_BATCH).join(',')}&format=json`, { headers: { 'user-agent': 'GridAlert station list' } });
    if (!res.ok) throw new Error(`station lookup failed: ${res.status}`);
    for (const s of await res.json()) if (s.siteType?.includes('METAR')) known.set(s.icaoId, [s.lon, s.lat]);
  }
  return known;
}

const stations = await loadStations();
// Stations carry Connecticut's old counties, which metroForCounty knows and metros don't.
const byMetro = new Map<string, string[]>();
for (const [fips, sids] of stations) {
  const cbsa = metroForCounty(fips);
  if (cbsa) byMetro.set(cbsa, [...new Set([...(byMetro.get(cbsa) ?? []), ...sids])]);
}
const all = [...new Set([...byMetro.values()].flat())];

const windy = new Set<string>();
for (const sid of all) if (windyDays(await readingsFor(sid)) > MAX_WINDY_DAYS) windy.add(sid);

const live = await onLiveFeed(all.filter((s) => !windy.has(s)).map(icaoOf));
const out = Object.fromEntries(
  [...byMetro]
    .map(([cbsa, sids]) => [cbsa, sids.filter((s) => !windy.has(s)).map(icaoOf).filter((id) => live.has(id))] as const)
    .map(([cbsa, ids]) => [cbsa, nearTheRest(ids, live).sort()] as const)
    .filter(([, ids]) => ids.length)
    .sort(([a], [b]) => a.localeCompare(b)),
);

fs.writeFileSync('data/wind-stations.json', `${JSON.stringify(out, null, 1)}\n`);
const kept = new Set(Object.values(out).flat()).size;
console.log(`${all.length} metro stations, ${windy.size} too windy, ${all.length - windy.size - kept} not on the live feed, ${kept} kept across ${Object.keys(out).length} of ${metros.length} metros`);
console.log(`metros with none: ${metros.filter((m) => !out[m.cbsa]).map((m) => m.name.split(',')[0]).join('; ')}`);
