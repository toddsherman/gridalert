import zlib from 'node:zlib';
import { expectShape, getText, readBody, safeUrl } from '../sources/http.ts';

/**
 * GDELT's 15-minute bulk files, which its search API points heavy users to. Free and keyless.
 * This is the public bucket itself: the data.gdeltproject.org CDN caches a 404 for an hour,
 * so one early request elsewhere can hide a file long after it's up.
 */
const GKG_BASE = 'https://storage.googleapis.com/data.gdeltproject.org/gdeltv2';
const OUTAGE_THEME = 'POWER_OUTAGE';

const COLUMN = { date: 1, source: 3, url: 4, themes: 7, locations: 9, extras: 26 };
const GKG_COLUMNS = 27;
const ZIP_HEADER = 30;
const US_CITY = '3';
/** A file runs to about 2 MB zipped and 8 MB open. */
const MAX_ZIP_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 128 * 1024 * 1024;

export interface NewsPlace {
  name: string;
  state: string;
  lat: number;
  lon: number;
}

export interface NewsItem {
  at: number;
  source: string;
  url: string;
  title: string;
  places: NewsPlace[];
  /** From a federal agency rather than the news. */
  official?: boolean;
}

export const gkgUrl = (at: number) => {
  const d = new Date(Math.floor(at / 900_000) * 900_000).toISOString();
  return `${GKG_BASE}/${d.slice(0, 19).replace(/[-:T]/g, '')}.gkg.csv.zip`;
};

/** GDELT's zips hold one file, so this needs no zip library. */
export function unzipSingle(zip: Buffer): string {
  const nameLength = zip.readUInt16LE(26);
  const extraLength = zip.readUInt16LE(28);
  return zlib.inflateRawSync(zip.subarray(ZIP_HEADER + nameLength + extraLength), { maxOutputLength: MAX_FILE_BYTES }).toString('utf8');
}

const ENTITIES: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
/** Decode HTML entities. A number past the end of Unicode stays as it is, since it would otherwise throw. */
export const decodeEntities = (text: string) =>
  text.replace(/&(?:#(\d+|x[\da-f]+)|(\w+));/gi, (all, code, name) => {
    if (!code) return ENTITIES[name] ?? all;
    const point = code[0].toLowerCase() === 'x' ? Number.parseInt(code.slice(1), 16) : Number(code);
    return point <= 0x10ffff ? String.fromCodePoint(point) : all;
  });

function placesOf(locations: string): NewsPlace[] {
  return locations.split(';').flatMap((location): NewsPlace[] => {
    const [type, fullName, country, adm1, lat, lon] = location.split('#');
    if (type !== US_CITY || country !== 'US') return [];
    return [{ name: fullName.split(',')[0], state: adm1.slice(2), lat: Number(lat), lon: Number(lon) }];
  });
}

function parseGkgRow(line: string): NewsItem[] {
  if (!line.includes(OUTAGE_THEME)) return [];
  const c = line.split('\t');
  if (!c[COLUMN.themes]?.split(';').includes(OUTAGE_THEME)) return [];
  const title = decodeEntities(c[COLUMN.extras]?.match(/<PAGE_TITLE>(.*?)<\/PAGE_TITLE>/)?.[1] ?? '').trim();
  const places = placesOf(c[COLUMN.locations] ?? '');
  const url = safeUrl(c[COLUMN.url] ?? '');
  if (!title || !places.length || !url) return [];
  const d = c[COLUMN.date];
  const at = Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +d.slice(8, 10), +d.slice(10, 12), +d.slice(12, 14));
  return [{ at, source: c[COLUMN.source], url, title, places }];
}

/** Stories GDELT tagged as about a power outage, with a US place in them. One bad row can't lose the file. */
export function parseGkg(csv: string): NewsItem[] {
  return csv.split('\n').flatMap((line): NewsItem[] => {
    try {
      return parseGkgRow(line);
    } catch {
      return [];
    }
  });
}

export function distanceKm([lon1, lat1]: [number, number], [lon2, lat2]: [number, number]): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

export interface NewsArea {
  /** Cities and counties. A story naming one still needs a place in the same state, since names repeat. */
  names: string[];
  utilities: string[];
  states: ReadonlySet<string>;
  points: Array<[number, number]>;
}

/** County centers can sit well away from their cities, so this is wide. */
const NEAR_KM = 50;
const ON_TOPIC = /outage|blackout|without power|lost power|lose power|losing power|no power|power (?:is |was |has been |remains )?(?:out|back|restored|cut|down|failure|loss)|lights (?:out|go)|electric|substation|transformer/i;

const unaccented = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '');
const named = (title: string, name: string) => new RegExp(`\\b${unaccented(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(unaccented(title));

/** Whether a story is about a power cut in this area. GDELT's places can be wrong, so a name in the headline also counts. */
export function isAbout(item: NewsItem, area: NewsArea): boolean {
  if (!ON_TOPIC.test(item.title)) return false;
  const near = item.places.some((p) => area.points.some((c) => distanceKm(c, [p.lon, p.lat]) <= NEAR_KM));
  const local = item.places.some((p) => area.states.has(p.state)) && area.names.some((n) => named(item.title, n));
  return near || local || area.utilities.some((u) => named(item.title, u));
}

/** Whether a headline with no place data names this area or its utilities. */
export const namesArea = (title: string, area: NewsArea) => [...area.names, ...area.utilities].some((n) => named(title, n));

/** The FBI's feed refuses requests from cloud servers, so its statements arrive only through the news. */
export const OFFICIAL_FEEDS = [
  { name: 'CISA news', source: 'CISA', url: 'https://www.cisa.gov/news.xml' },
  { name: 'CISA alerts', source: 'CISA', url: 'https://www.cisa.gov/cybersecurity-advisories/alerts.xml' },
];

/** Most of what these agencies post has nothing to do with the grid. */
const GRID = /electric(?:al|ity)? (?:grid|sector|utilit\w*|system|infrastructure)|power (?:grid|outages?|plants?|sector|substations?)|substation|transformers?\b|blackout|grid operator|energy sector|energy infrastructure/i;

/** Statements about the grid from an RSS or Atom feed, newest first as published. */
export function parseOfficial(xml: string, source: string): NewsItem[] {
  return [...xml.matchAll(/<(item|entry)>(.*?)<\/\1>/gs)].flatMap((m): NewsItem[] => {
    const block = m[2];
    const title = decodeEntities((block.match(/<title[^>]*>(.*?)<\/title>/s)?.[1] ?? '').replace(/<!\[CDATA\[|\]\]>/g, '').trim());
    const at = Date.parse(block.match(/<(?:pubDate|published|updated)>(.*?)<\//)?.[1] ?? '');
    if (!title || Number.isNaN(at) || !GRID.test(title)) return [];
    const url = safeUrl(block.match(/<link[^>]*?(?:href="([^"]+)"[^>]*\/?>|>(.*?)<\/link>)/)?.slice(1).find(Boolean) ?? '');
    return url ? [{ at, source, url, title, places: [], official: true }] : [];
  });
}

/** Almost nothing here is about the grid, so a page that's changed has to show up some other way. */
export async function readOfficialFeed(feed: (typeof OFFICIAL_FEEDS)[number]): Promise<NewsItem[]> {
  const xml = await getText(feed.url);
  expectShape(/<(?:rss|feed)\b/.test(xml) && /<(?:item|entry)>/.test(xml), `${feed.name} feed`);
  return parseOfficial(xml, feed.source);
}

export async function readOfficial(): Promise<NewsItem[]> {
  const feeds = await Promise.allSettled(OFFICIAL_FEEDS.map(readOfficialFeed));
  const read = feeds.flatMap((f) => (f.status === 'fulfilled' ? f.value : []));
  if (feeds.every((f) => f.status === 'rejected')) throw new Error('no official feed answered');
  return read;
}

/** Wording that points at people rather than weather or wear. It can only ever flag a story, never settle a cause. */
const DELIBERATE = /cyber ?-?attack|cyber ?-?security incident|\bhack(?:ed|ers?|ing)\b|ransomware|sabotage|terroris|vandal|intentional|\btargeted\b|\battack(?:ed|s)?\b|gunfire|shots? fired|shot at|criminal|foul play|\barson\b|explosive/i;
/** Foreign wars fill the news, but a state named as the attacker here must still count, so only the battlefields are left out. */
const NOT_THE_GRID = /heart attack|panic attack|shark attack|ukrain|gaza|israel|lebanon/i;

export const soundsDeliberate = (title: string) => DELIBERATE.test(title) && !NOT_THE_GRID.test(title);

/** Outlets with editors, whose report can stand alone. Anyone else needs a second source. */
const TRUSTED_OUTLETS: ReadonlySet<string> = new Set(['abcnews.go.com', 'apnews.com', 'axios.com', 'bbc.co.uk', 'bbc.com', 'bloomberg.com', 'cbsnews.com', 'cnn.com', 'foxnews.com', 'nbcnews.com', 'npr.org', 'nytimes.com', 'pbs.org', 'politico.com', 'reuters.com', 'thehill.com', 'usatoday.com', 'washingtonpost.com', 'wsj.com']);

export const outletOf = (source: string) => source.toLowerCase().replace(/^www\./, '');
export const isTrustedOutlet = (source: string) => TRUSTED_OUTLETS.has(outletOf(source));

const GKG_INDEX = `${GKG_BASE}/lastupdate.txt`;
const FILE_MS = 900_000;
/** After a gap, how many 15-minute files to catch up on. */
const CATCH_UP_FILES = 4;
const KEEP_MS = 48 * 3_600_000;

export interface NewsLog {
  /** The newest GDELT file read. */
  through: number;
  items: NewsItem[];
}

const fileTime = (url: string) => {
  const d = url.match(/(\d{14})\.gkg/)?.[1];
  return d ? Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +d.slice(8, 10), +d.slice(10, 12)) : 0;
};

/** Null when GDELT has no such file, which is normal: its index lists a file before it's up. */
async function readGkg(at: number): Promise<NewsItem[] | null> {
  const res = await fetch(gkgUrl(at), { signal: AbortSignal.timeout(20_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GDELT ${res.status}`);
  const csv = unzipSingle(await readBody(res, MAX_ZIP_BYTES));
  expectShape(csv.slice(0, csv.indexOf('\n')).split('\t').length === GKG_COLUMNS, 'GDELT GKG');
  return parseGkg(csv).filter((i) => ON_TOPIC.test(i.title));
}

/** Bring the rolling log up to date. Reads only once GDELT has published something new. */
export async function advanceNews(log: NewsLog, now: Date): Promise<NewsLog> {
  const latest = fileTime((await getText(GKG_INDEX)).split('\n').find((l) => l.includes('.gkg.')) ?? '');
  if (latest <= log.through) return log;
  const first = Math.max(log.through + FILE_MS, latest - (CATCH_UP_FILES - 1) * FILE_MS);
  const stamps = Array.from({ length: (latest - first) / FILE_MS + 1 }, (_, i) => first + i * FILE_MS);
  const statements = readOfficial().catch((err: Error) => {
    console.error('official statements failed:', err.message);
    return [] as NewsItem[];
  });
  const [files, official] = await Promise.all([Promise.all(stamps.map(readGkg)), statements]);
  // The newest file may just not be up yet, so that one is tried again. A hole behind it is a real gap.
  const reached = files.findLastIndex(Boolean);
  if (reached < 0) return log;
  const known = new Set(log.items.map((i) => i.url));
  // A file goes up about 12 minutes before the time it's named for.
  const fresh = [...files.flatMap((f) => f ?? []), ...official].filter((i) => !known.has(i.url) && known.add(i.url)).map((i) => ({ ...i, at: Math.min(i.at, now.getTime()) }));
  const cutoff = now.getTime() - KEEP_MS;
  return { through: stamps[reached], items: [...log.items, ...fresh].filter((i) => i.at >= cutoff) };
}
