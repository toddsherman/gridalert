// Weather history shared by the backtests: Iowa State's warning archive and SPC storm reports.
import fs from 'node:fs';
import geo from '../../data/geo.json' with { type: 'json' };
import { parseStormReports, type StormReport, type WeatherAlert } from '../../lib/causes/feeds.ts';

export const CACHE = '.cache/backtest';
export const IEM = 'https://mesonet.agron.iastate.edu/cgi-bin/request/gis/watchwarn.py';
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

const SPC = 'https://www.spc.noaa.gov/climo/reports';
// NWS renumbers forecast zones, so older warnings need older zone files.
const ZONE_FILES = ['bp02ap19', 'bp22mr22', 'bp05mr24', 'bp18mr25', 'bp16ap26'];

export type Zones = Map<string, Set<string>>;

const VTEC: Record<string, string> = {
  'TO.W': 'Tornado Warning', 'SV.W': 'Severe Thunderstorm Warning', 'EW.W': 'Extreme Wind Warning', 'HW.W': 'High Wind Warning',
  'HU.W': 'Hurricane Warning', 'TR.W': 'Tropical Storm Warning', 'SS.W': 'Storm Surge Warning', 'IS.W': 'Ice Storm Warning',
  'WS.W': 'Winter Storm Warning', 'BZ.W': 'Blizzard Warning', 'WI.Y': 'Wind Advisory', 'FF.W': 'Flash Flood Warning', 'FL.W': 'Flood Warning',
  'FA.W': 'Flood Warning', 'WW.Y': 'Winter Weather Advisory', 'LE.W': 'Lake Effect Snow Warning', 'EH.W': 'Excessive Heat Warning',
  'XH.W': 'Extreme Heat Warning', 'EC.W': 'Extreme Cold Warning', 'WC.W': 'Extreme Cold Warning', 'FW.W': 'Red Flag Warning', 'DS.W': 'Dust Storm Warning',
  'TO.A': 'Tornado Watch', 'SV.A': 'Severe Thunderstorm Watch', 'HU.A': 'Hurricane Watch', 'TR.A': 'Tropical Storm Watch', 'HW.A': 'High Wind Watch', 'WS.A': 'Winter Storm Watch',
};

export const statePrefix = new Map(Object.entries(geo.index as Record<string, string>).map(([key, fips]) => [key.split('|')[0], fips.slice(0, 2)]));

export async function cached(path: string, url: string): Promise<string> {
  if (fs.existsSync(path)) return fs.readFileSync(path, 'utf8');
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { 'user-agent': 'GridAlert backtest (one-off research)' }, signal: AbortSignal.timeout(120_000) }).catch(() => null);
    // The connection can drop partway through a body, as well as before one.
    const text = res?.ok ? await res.text().catch(() => null) : null;
    if (text !== null) {
      fs.writeFileSync(path, text);
      await new Promise((resolve) => setTimeout(resolve, 250));
      return text;
    }
    if (attempt >= 3) throw new Error(`failed: ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 5_000 * (attempt + 1)));
  }
}

function addZones(zones: Zones, text: string) {
  for (const line of text.split('\n')) {
    const cols = line.split('|');
    if (cols.length < 7) continue;
    zones.set(cols[4], (zones.get(cols[4]) ?? new Set()).add(cols[6]));
  }
}

export async function loadZones(): Promise<Zones> {
  fs.mkdirSync(CACHE, { recursive: true });
  const zones: Zones = new Map();
  for (const file of ZONE_FILES) addZones(zones, await cached(`${CACHE}/${file}.dbx`, `https://www.weather.gov/source/gis/Shapefiles/County/${file}.dbx`));
  return zones;
}

export /** CSV rows have no quoted commas in the columns used here. */
function parseWarnings(csv: string, zones: Zones): WeatherAlert[] {
  const [head, ...rows] = csv.split('\n');
  const cols = head.split(',');
  const col = (name: string) => cols.indexOf(name);
  const [issue, expire, phenomena, significance, ugc] = ['utc_issue', 'utc_expire', 'phenomena', 'significance', 'ugc'].map(col);
  const out: WeatherAlert[] = [];
  for (const row of rows) {
    const c = row.split(',');
    const event = VTEC[`${c[phenomena]}.${c[significance]}`];
    const code = c[ugc];
    if (!event || !code) continue;
    const state = code.slice(0, 2);
    const fips = code[2] === 'C' ? [`${statePrefix.get(state)}${code.slice(3)}`] : [...(zones.get(`${state}${code.slice(3)}`) ?? [])];
    if (!fips.length) continue;
    out.push({ id: `${event}:${code}:${c[issue]}`, event, start: Date.parse(`${c[issue].replace(' ', 'T')}:00Z`), end: Date.parse(`${c[expire].replace(' ', 'T')}:00Z`), fips });
  }
  return out;
}

export async function stormReportsFor(dayStart: number): Promise<StormReport[]> {
  const iso = new Date(dayStart).toISOString();
  const stamp = `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}`;
  const csv = await cached(`${CACHE}/spc-${stamp}.csv`, `${SPC}/${stamp}_rpts_filtered.csv`).catch(() => '');
  return parseStormReports(csv, dayStart);
}
