import centroidsJson from '../data/county-centroids.json' with { type: 'json' };
import windStationsJson from '../data/wind-stations.json' with { type: 'json' };
import { assess, type CauseArea } from './causes/assess.ts';
import { gatherWorld } from './causes/feeds.ts';
import { isAbout, namesArea, type NewsArea, type NewsItem, type NewsLog, outletOf } from './causes/news.ts';
import { eastern, orList } from './format.ts';
import { withOldCodes } from './geo.ts';
import { metroByCbsa, type RegistryMetro } from './registry.ts';
import { PATHS, readDoc, writeDoc } from './store.ts';
import type { AlertEvent, MetroStatus } from './types.ts';

/**
 * A backstop for areas no feed can see. Some metros never have a readable feed, and ODIN, which
 * is the only view of Houston, stops for hours on most days. A blackout there can't be measured,
 * so the news is watched instead. It's weak: replayed against 25 real large outages it caught 8,
 * the first story a median of 4.3 hours in (docs/CAUSE_CHECKS.md, "The news backstop"). That's
 * late and partial, but it's the only thing that would say so at all. What it sends is marked as
 * reported, never as measured, and goes to the owner only.
 */

const HOUR = 3_600_000;
const centroids = centroidsJson as unknown as Record<string, [number, number]>;
const windStations = windStationsJson as Record<string, string[]>;

/** Under this share of a metro's customers on a live feed, a blackout there could go unseen. */
export const BLIND_COVERAGE = 0.5;
/** Stories this old are about something that has already been and gone. */
const STORY_WINDOW_MS = 6 * HOUR;
/** A headline has to put the outage at least this large, in customers, homes or people. */
const LARGE_REPORT = 20_000;
/** News trails an outage by hours, so causes are looked for this far back from the first story. */
const CAUSE_LOOKBACK_MS = 6 * HOUR;
/** How long to keep trying when storm warnings can't be read, before sending with that said. */
const STORM_WAIT_MS = HOUR / 2;
/** One notice per area in this long, however many stories follow. */
const EPISODE_MS = 24 * HOUR;
const MAX_STORIES = 4;

const WORD_SIZES: Array<[RegExp, number]> = [
  [/hundreds of thousands/i, 200_000],
  [/tens of thousands/i, 20_000],
  [/\b(?:massive|widespread|citywide|city-wide|major) (?:power )?(?:outage|blackout)/i, LARGE_REPORT],
];
const COUNTED = /(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(k\b|thousand|million)?/gi;

/** The largest number of customers a headline claims, or 0 if it doesn't say. Years and small counts don't qualify. */
export function reportedSize(title: string): number {
  let size = 0;
  for (const [pattern, value] of WORD_SIZES) if (pattern.test(title)) size = Math.max(size, value);
  for (const m of title.matchAll(COUNTED)) {
    const unit = m[2]?.toLowerCase();
    const n = Number(m[1].replaceAll(',', '')) * (unit === 'million' ? 1_000_000 : unit ? 1_000 : 1);
    // A bare four-digit number is as likely a year as a count.
    if (!unit && !m[1].includes(',')) continue;
    size = Math.max(size, n);
  }
  return size;
}

export interface ReportedStory {
  at: string;
  source: string;
  title: string;
  url: string;
}

export interface Report {
  cbsa: string;
  label: string;
  /** When the first qualifying story was seen. */
  firstAt: string;
  noticeAt?: string;
  /** What ordinary cause was found, which ends it without a notice. */
  explainedBy?: string;
  stories: ReportedStory[];
}

export type ReportsDoc = Record<string, Report>;

function newsAreaOf(metro: RegistryMetro): NewsArea {
  const cities = metro.name.split(',')[0].split(/--|[-/]/).map((s) => s.trim()).filter((s) => s.length > 3);
  return {
    names: [...cities, ...metro.counties.map((c) => c.name)],
    utilities: [],
    states: new Set(metro.counties.map((c) => c.state)),
    points: metro.counties.flatMap((c) => withOldCodes(c.fips)).flatMap((f) => (centroids[f] ? [centroids[f]] : [])),
  };
}

/**
 * Stories reporting a large outage in this metro. The headline has to name the place and give
 * a size, because nothing measured stands behind the story. In the replay, taking stories that
 * were only placed nearby caught 14 of 25 but counted eight times as often by chance, and asking
 * for a second outlet halved what was caught and pushed it to 7 hours.
 */
export function largeReports(metro: RegistryMetro, items: NewsItem[], now: number): NewsItem[] {
  const area = newsAreaOf(metro);
  return items.filter((i) => !i.official && now - i.at <= STORY_WINDOW_MS && reportedSize(i.title) >= LARGE_REPORT && namesArea(i.title, area) && isAbout(i, area));
}

function causeAreaOf(metro: RegistryMetro, firstStory: number): CauseArea {
  const fips = metro.counties.flatMap((c) => withOldCodes(c.fips));
  return { fips: new Set(fips), points: fips.flatMap((f) => (centroids[f] ? [centroids[f]] : [])), stations: new Set(windStations[metro.cbsa] ?? []), states: new Set(metro.counties.map((c) => c.state)), start: firstStory - CAUSE_LOOKBACK_MS, end: firstStory };
}

function noticeOf(report: Report, coverage: number, checked: string[], stormsRead: boolean, at: string): AlertEvent {
  const first = report.stories[0];
  const outlets = new Set(report.stories.map((s) => outletOf(s.source)));
  const who = outlets.size === 1 ? first.source : `${outlets.size} outlets`;
  const ruledOut = checked.length ? `No ${orList(checked)} found.` : '';
  const storms = stormsRead ? '' : " Storm warnings couldn't be read, so a storm isn't ruled out.";
  const detail = `${who} report${outlets.size === 1 ? 's' : ''} a large outage here, where GridAlert can read only ${Math.round(coverage * 100)}% of customers. This is from the news, not measured. First report ${eastern(first.at)} ET: "${first.title}" ${ruledOut}${storms}`.trim();
  return { id: `reported:${report.cbsa}:${report.firstAt}`, kind: 'reported', key: `reported:${report.cbsa}`, scope: 'metro', label: report.label, at, people: 0, peakPeople: 0, customers: 0, openedAt: report.firstAt, detail, link: '/coverage', areas: [report.label] };
}

/**
 * One poll of the backstop. Returns the notices now due, and the record to save.
 * `checkCauses` reads the weather and the rest for one metro, and is only called when stories qualify.
 */
export async function findReports(
  doc: ReportsDoc,
  blind: Array<Pick<MetroStatus, 'cbsa' | 'coverage'>>,
  news: NewsLog,
  now: Date,
  checkCauses: (area: CauseArea, states: string[], stations: string[]) => Promise<{ strong?: string; checked: string[] }>,
): Promise<{ doc: ReportsDoc; events: AlertEvent[] }> {
  const at = now.toISOString();
  const next: ReportsDoc = Object.fromEntries(Object.entries(doc).filter(([, r]) => now.getTime() - Date.parse(r.firstAt) < EPISODE_MS));
  const events: AlertEvent[] = [];
  for (const { cbsa, coverage } of blind) {
    const metro = metroByCbsa.get(cbsa);
    if (!metro) continue;
    const prior = next[cbsa];
    if (prior?.noticeAt || prior?.explainedBy) continue;
    const found = largeReports(metro, news.items, now.getTime());
    if (!found.length) continue;
    const stories = found.sort((a, b) => a.at - b.at).slice(0, MAX_STORIES).map((i) => ({ at: new Date(i.at).toISOString(), source: i.source, title: i.title, url: i.url }));
    let report: Report = { cbsa, label: metro.name, firstAt: prior?.firstAt ?? at, stories };

    const area = causeAreaOf(metro, Date.parse(stories[0].at));
    const { strong, checked } = await checkCauses(area, [...(area.states ?? [])], [...(area.stations ?? [])]);
    const stormsRead = checked.includes('storm warnings');
    if (strong) report = { ...report, explainedBy: strong };
    else if (stormsRead || now.getTime() - Date.parse(report.firstAt) >= STORM_WAIT_MS) {
      report = { ...report, noticeAt: at };
      events.push(noticeOf(report, coverage, checked, stormsRead, at));
    }
    next[cbsa] = report;
  }
  return { doc: next, events };
}

async function readCauses(area: CauseArea, states: string[], stations: string[], now: Date) {
  const world = await gatherWorld(states, stations, [], now, area.start);
  const { evidence, checked } = assess(area, world);
  return { strong: evidence.find((e) => e.strong)?.label, checked };
}

/** Watch the news for the metros this poll couldn't see. Costs one small read unless a story qualifies. */
export async function refreshReports(metros: MetroStatus[], now: Date): Promise<AlertEvent[]> {
  const blind = metros.filter((m) => m.coverage < BLIND_COVERAGE);
  if (!blind.length) return [];
  const news = (await readDoc<NewsLog>(PATHS.news, { fresh: true }))?.value;
  if (!news?.items.length) return [];
  const stored = (await readDoc<ReportsDoc>(PATHS.reports, { fresh: true }))?.value ?? {};
  const { doc, events } = await findReports(stored, blind, news, now, (area, states, stations) => readCauses(area, states, stations, now));
  if (JSON.stringify(doc) !== JSON.stringify(stored)) await writeDoc(PATHS.reports, doc);
  return events;
}
