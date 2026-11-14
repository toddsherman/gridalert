import centroidsJson from '../data/county-centroids.json' with { type: 'json' };
import windStationsJson from '../data/wind-stations.json' with { type: 'json' };
import { biggestJump, latestRise } from './alerts/trail.ts';
import { assess, type CauseArea } from './causes/assess.ts';
import { gatherWorld, within, type World } from './causes/feeds.ts';
import { advanceNews, isAbout, isTrustedOutlet, namesArea, type NewsArea, type NewsItem, type NewsLog, outletOf, soundsDeliberate } from './causes/news.ts';
import { operatorsFor } from './causes/operators.ts';
import { alertBar, CHECK_FRESH_MS, heldBack, JUMP_WINDOW_MS, LARGE_CUSTOMERS, MIN_COUNTY_SHARE, readingMoved, readingSteady, RECHECK_AFTER_CLOSE_MS, SETTLE_MS, SIMULTANEOUS_WINDOW_MS, STORM_WAIT_MS, SURGE_CUSTOMERS } from './causes/rules.ts';
import { extractStatements, MAX_ARTICLES, readArticles, statementClient } from './causes/statements.ts';
import { utilityEvidence, withKnownCauses } from './causes/utility.ts';
import { eastern, num, orList } from './format.ts';
import { metroForCounty, withOldCodes } from './geo.ts';
import { metrosFor, placer } from './places.ts';
import { metroByCbsa, sources, utilityByEia } from './registry.ts';
import { readCauses } from './sources/read.ts';
import type { PlacedCause, Source } from './sources/types.ts';
import { PATHS, readDoc, swapDoc, writeDoc } from './store.ts';
import type { AlertEvent, AlertKind, Blackout, CauseCheck, CauseStatus, CountReading, EngineState, Evidence, MetroUtility, OpenAlert, Settings, Snapshot, Statement, TimelineEntry, UtilityCause } from './types.ts';

const HOUR = 3_600_000;
const UTILITY_CHECK_MS = HOUR / 4;
const MAX_COUNTIES = 20;
const MAX_EVIDENCE = 8;
const MAX_UTILITY_CAUSES = 5;
/** Smaller blackouts kept in the list. Large ones are never dropped. */
const SMALL_BLACKOUTS_KEPT = 1_500;
/** Years of large ones, so the list can't grow without end. */
const LARGE_BLACKOUTS_KEPT = 2_000;
/** Share of the unexplained level still out for the alert to fire, which rules out a one-poll glitch. */
const STILL_OUT_SHARE = 0.5;
/** Operator pages are large, and smaller blackouts can't send a high-priority alert anyway. */
const OPERATOR_CHECK_CUSTOMERS = 10_000;
/** News lags an outage by hours, so a closed blackout keeps collecting it for a while. */
const NEWS_AFTER_CLOSE_MS = 24 * HOUR;
const NEWS_BEFORE_START_MS = HOUR;
const TIMELINE_SIZE = 12;
/** News can't be allowed to hold up an alert. It takes about a second, and the next poll covers the same ground. */
const NEWS_DEADLINE_MS = 12_000;
const NO_NEWS: NewsLog = { through: 0, items: [] };
/** Reads of a blackout's stories. Each new batch costs a few cents, so this caps it. */
const STATEMENT_READS = 6;
const STATEMENTS_KEPT = 8;
/** Past this a story changes nothing, so a blackout stops being worth paying to read. */
const STATEMENT_MAX_AGE_MS = 72 * HOUR;
/** Headlines go into alerts, and anyone can write one. */
const HEADLINE_CHARS = 200;

const centroids = centroidsJson as unknown as Record<string, [number, number]>;
const windStations = windStationsJson as Record<string, string[]>;

interface AreaNow {
  link: string;
  states: string[];
  customers: number;
  utilities: MetroUtility[];
  counties: string[];
  parts: CountReading['parts'];
}

function metroArea(cbsa: string, snapshot: Snapshot): AreaNow {
  const row = snapshot.metros.find((m) => m.cbsa === cbsa);
  const out = row?.customersOut ?? 0;
  const counties = row?.counties ?? [];
  const placed = counties.some((c) => c.customersOut >= out * MIN_COUNTY_SHARE);
  return {
    link: `/metros/${cbsa}`,
    states: row?.states ?? [],
    customers: out,
    utilities: row?.utilities.slice(0, 4) ?? [],
    // One stray outage in a far county shouldn't let a storm there explain this.
    counties: counties.filter((c) => c.customersOut >= out * MIN_COUNTY_SHARE).map((c) => c.fips),
    parts: Object.fromEntries(placed ? counties.map((c) => [c.fips, c.customersOut]) : (row?.utilities ?? []).map((u) => [u.id, u.customersOut])),
  };
}

function utilityArea(id: string, snapshot: Snapshot): AreaNow {
  const row = snapshot.utilities.find((u) => u.id === id);
  const eiaIds = sources.find((s) => s.id === id)?.eiaIds ?? [];
  return {
    link: '/coverage',
    states: [...new Set(eiaIds.flatMap((e) => utilityByEia.get(e)?.states ?? []))],
    customers: row?.customersOut ?? 0,
    utilities: row ? [{ id, name: row.name, customersOut: row.customersOut }] : [],
    counties: [],
    parts: row ? { [id]: row.customersOut } : {},
  };
}

/** A jump well after the blackout began, which would otherwise be hidden inside it. */
function surgeOf(a: OpenAlert, engine: EngineState, peoplePerCustomer: number): Pick<Blackout, 'surgeAt' | 'surgeCustomers'> | undefined {
  const rise = engine.trail && latestRise(engine.trail, a.key);
  if (!rise) return undefined;
  const customers = Math.round(rise.people / peoplePerCustomer);
  if (customers < SURGE_CUSTOMERS || rise.at - Date.parse(a.startedAt ?? a.openedAt) <= SIMULTANEOUS_WINDOW_MS) return undefined;
  return { surgeAt: new Date(rise.at).toISOString(), surgeCustomers: customers };
}

/** The most customers this blackout has lost in one go so far. */
const jumpOf = (a: OpenAlert, engine: EngineState, peoplePerCustomer: number) => (engine.trail ? Math.round(biggestJump(engine.trail, a.key, Date.parse(a.startedAt ?? a.openedAt), JUMP_WINDOW_MS) / peoplePerCustomer) : 0);

/** Keep the last distinct reading. A record from before this check isn't held back. */
function nextReading(b: Blackout | undefined, area: AreaNow, peoplePerCustomer: number, at: string): CountReading {
  if (!b?.reading) return { at, parts: area.parts, before: b ? area.customers : 0 };
  if (!readingMoved(b.reading.parts, area.parts, area.customers)) return b.reading;
  return { at, parts: area.parts, before: b.people / peoplePerCustomer };
}

const areaOf = (a: OpenAlert, snapshot: Snapshot) => (a.scope === 'metro' ? metroArea(a.key.replace('metro:', ''), snapshot) : utilityArea(a.key.replace('utility:', ''), snapshot));

/** Create a record for each open alert, keep open ones current, and close the rest. */
export function syncBlackouts(prev: Blackout[], engine: EngineState, snapshot: Snapshot, peoplePerCustomer: number, at: string): Blackout[] {
  const byId = new Map(prev.map((b) => [b.id, b]));
  const openIds = new Set<string>();

  for (const a of Object.values(engine.open)) {
    const id = `${a.key}:${a.openedAt}`;
    openIds.add(id);
    const area = areaOf(a, snapshot);
    const existing = byId.get(id);
    // A record made partway through an alert still has to report the alert's own peak.
    const peakCustomers = Math.max(existing?.peakCustomers ?? 0, area.customers, Math.round(a.peakPeople / peoplePerCustomer));
    const surge = surgeOf(a, engine, peoplePerCustomer);
    // An explanation is final, which must not let an old storm hide a new blackout in the same place.
    const reopened = existing?.cause === 'explained' && (surge?.surgeCustomers ?? 0) >= LARGE_CUSTOMERS && existing.checkFrom !== surge?.surgeAt;
    byId.set(id, {
      ...(existing ?? { id, key: a.key, scope: a.scope, startedAt: a.startedAt ?? a.openedAt, openedAt: a.openedAt, cause: 'checking' as CauseStatus, evidence: [], checked: [], utilityCauses: [] }),
      ...(reopened && { cause: 'checking' as CauseStatus, evidence: [], checked: [], checkReads: {}, checkFrom: surge?.surgeAt, explainedAt: undefined, unexplainedNoticeAt: undefined, explainedNoticeAt: undefined }),
      // An overlapping run could have closed this while the alert was open.
      resolvedAt: undefined,
      blindSince: a.blindSince,
      label: a.label,
      link: area.link,
      states: area.states.length ? area.states : (existing?.states ?? []),
      people: a.people,
      peakPeople: a.peakPeople,
      peakCustomers,
      peakAt: !existing || a.peakPeople > existing.peakPeople ? at : existing.peakAt,
      ...surge,
      jumpCustomers: Math.max(existing?.jumpCustomers ?? 0, jumpOf(a, engine, peoplePerCustomer)),
      reading: nextReading(existing, area, peoplePerCustomer, at),
      utilities: area.customers >= peakCustomers || !existing ? area.utilities : existing.utilities,
      counties: [...new Set([...(existing?.counties ?? []), ...area.counties])].slice(0, MAX_COUNTIES),
    });
  }

  return [...byId.values()]
    .map((b) => (b.resolvedAt || openIds.has(b.id) ? b : { ...b, resolvedAt: at }))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function needsCheck(b: Blackout, now: number): boolean {
  if (b.cause === 'explained') return false;
  return !b.resolvedAt || now - Date.parse(b.resolvedAt) < RECHECK_AFTER_CLOSE_MS;
}

/** The counties to compare against: those hit, or failing that everywhere it could be. */
export function areaCounties(b: Blackout): string[] {
  if (b.counties.length) return b.counties;
  if (b.scope === 'metro') return metroByCbsa.get(b.key.replace('metro:', ''))?.counties.map((c) => c.fips) ?? [];
  const eiaIds = sources.find((s) => s.id === b.key.replace('utility:', ''))?.eiaIds ?? [];
  return [...new Set(eiaIds.flatMap((e) => utilityByEia.get(e)?.metroCounties ?? []))];
}

function operatorsOf(b: Blackout): string[] {
  const eiaIds = b.utilities.flatMap((u) => (u.id.startsWith('odin-') ? [Number(u.id.slice('odin-'.length))] : (sources.find((s) => s.id === u.id)?.eiaIds ?? [])));
  return [...new Set(eiaIds.flatMap((id) => b.states.flatMap((state) => operatorsFor(id, state))))];
}

/** Which operators' notices are worth reading for these blackouts. */
export function operatorsToRead(list: Blackout[]): string[] {
  return [...new Set(list.filter((b) => b.peakCustomers >= OPERATOR_CHECK_CUSTOMERS).flatMap(operatorsOf))];
}

function causeArea(b: Blackout): CauseArea {
  const fips = areaCounties(b);
  const start = Date.parse(b.checkFrom ?? b.startedAt);
  const stations = new Set(fips.flatMap((f) => windStations[metroForCounty(f) ?? ''] ?? []));
  return { fips: new Set(fips.flatMap(withOldCodes)), points: fips.flatMap(withOldCodes).flatMap((f) => (centroids[f] ? [centroids[f]] : [])), stations, operators: new Set(operatorsOf(b)), states: new Set(b.states), start, end: b.peakAt ? Math.max(start, Date.parse(b.peakAt)) : start };
}

export function causeStatus(b: Pick<Blackout, 'evidence' | 'startedAt' | 'checkReads' | 'checkFrom'>, now: number): CauseStatus {
  if (b.evidence.some((e) => e.strong)) return 'explained';
  const start = Date.parse(b.checkFrom ?? b.startedAt);
  if (now - start < SETTLE_MS) return 'checking';
  // A read from before the settle time can't speak for what came after it.
  const read = b.checkReads?.['storm warnings'];
  if (read && Date.parse(read) - start >= SETTLE_MS) return 'unknown';
  return now - start >= STORM_WAIT_MS ? 'unknown' : 'checking';
}

function mergeEvidence(existing: Evidence[], found: Evidence[]): Evidence[] {
  const byId = new Map([...existing, ...found].map((e) => [e.id, e]));
  return [...byId.values()].sort((a, b) => Number(b.strong) - Number(a.strong)).slice(0, MAX_EVIDENCE);
}

/** Fold one round of checks into a record. A check that failed simply adds nothing. */
export function applyChecks(b: Blackout, world: World, utilityCauses: UtilityCause[] | undefined, now: Date): Blackout {
  const at = now.toISOString();
  const { evidence, checked } = assess(causeArea(b), world);
  const weatherAgrees = [...b.evidence, ...evidence].some((e) => e.kind === 'weather' || e.kind === 'storm-report' || e.kind === 'wind-gust');
  const stated = utilityCauses ? utilityEvidence(utilityCauses, b.peakCustomers, at, weatherAgrees) : null;
  const checkReads = { ...b.checkReads, ...Object.fromEntries(checked.map((c) => [c, at])) };
  const next: Blackout = {
    ...b,
    evidence: mergeEvidence(b.evidence, stated ? [...evidence, stated] : evidence),
    // "No storm warnings found" is only true if the warnings were read lately.
    checked: (Object.keys(checkReads) as CauseCheck[]).filter((c) => now.getTime() - Date.parse(checkReads[c]!) < CHECK_FRESH_MS),
    checkReads,
    checkedAt: at,
    ...(utilityCauses && {
      utilityCauses: utilityCauses.length ? utilityCauses.slice().sort((x, y) => y.customers - x.customers).slice(0, MAX_UTILITY_CAUSES) : b.utilityCauses,
      knownCauses: withKnownCauses(b.knownCauses, utilityCauses).slice(0, MAX_UTILITY_CAUSES),
      utilityCheckedAt: at,
    }),
  };
  const cause = causeStatus(next, now.getTime());
  return { ...next, cause, explainedAt: cause === 'explained' ? (b.explainedAt ?? at) : undefined };
}

/**
 * Only what a feed says about this blackout's counties. Most feeds report their whole system, so a
 * utility in several metros would otherwise blame this outage on one somewhere else. One that
 * can't say where an outage is can only speak for a blackout if it serves just the one metro.
 */
export function causesHere(source: Source, rows: PlacedCause[], counties: ReadonlySet<string>): PlacedCause[] {
  if (source.method === 'kubra' || metrosFor(source).length <= 1) return rows;
  const place = placer(source);
  return rows.filter((r) => r.place && counties.has(place(r.place) ?? ''));
}

async function readStatedCauses(b: Blackout): Promise<UtilityCause[]> {
  const area = causeArea(b);
  const points = area.points.slice(0, MAX_COUNTIES);
  const results = await Promise.all(
    b.utilities.map(async (u) => {
      const source = sources.find((s) => s.id === u.id);
      if (!source) return null;
      const rows = await within(readCauses(source, points), `${u.id} cause`);
      return rows && causesHere(source, rows, area.fips);
    }),
  );
  const totals = new Map<string, number>();
  for (const c of results.flat()) if (c) totals.set(c.cause, (totals.get(c.cause) ?? 0) + c.customers);
  return [...totals].map(([cause, customers]) => ({ cause, customers }));
}

function newsArea(b: Blackout): NewsArea {
  const metro = b.scope === 'metro' ? metroByCbsa.get(b.key.replace('metro:', '')) : undefined;
  const fips = areaCounties(b);
  const cities = b.scope === 'metro' ? b.label.split(',')[0].split(/--|[-/]/).map((s) => s.trim()).filter((s) => s.length > 3) : [];
  return {
    names: [...cities, ...(metro?.counties.filter((c) => fips.includes(c.fips)).map((c) => c.name) ?? [])],
    utilities: b.utilities.map((u) => u.name),
    states: new Set(b.states),
    points: fips.flatMap(withOldCodes).flatMap((f) => (centroids[f] ? [centroids[f]] : [])),
  };
}

const entryOf = (i: NewsItem, placed: boolean): TimelineEntry => ({ at: new Date(i.at).toISOString(), source: i.source, title: i.title, url: i.url, ...(i.official && { official: true }), ...(placed && soundsDeliberate(i.title) && { deliberate: true }) });

/** Anything official or pointing at people outranks the rest, then the earliest reports. */
const rank = (e: TimelineEntry) => (e.official ? 0 : e.deliberate ? 1 : 2);

/** Add what's been said about a blackout. Copies of one wire story count once. */
export function withNews(b: Blackout, log: NewsLog, now: number): Blackout {
  if (b.peakCustomers < OPERATOR_CHECK_CUSTOMERS || (b.resolvedAt && now - Date.parse(b.resolvedAt) >= NEWS_AFTER_CLOSE_MS)) return b;
  const area = newsArea(b);
  const news = log.items;
  const from = Date.parse(b.startedAt) - NEWS_BEFORE_START_MS;
  const large = b.peakCustomers >= LARGE_CUSTOMERS;
  // An agency's statement has no place data. Unless it names this area it's background, not a report of this blackout.
  const found = news.filter((i) => i.at >= from && (i.official ? large || isAbout(i, area) : isAbout(i, area))).map((i) => entryOf(i, !i.official || namesArea(i.title, area)));
  const read = log.through ? { newsThrough: new Date(log.through).toISOString() } : {};
  if (!found.length) return { ...b, ...read };
  const byTitle = new Map([...(b.timeline ?? []), ...found].map((e) => [e.title.toLowerCase(), e]));
  const kept = [...byTitle.values()].sort((x, y) => rank(x) - rank(y) || x.at.localeCompare(y.at)).slice(0, TIMELINE_SIZE);
  return { ...b, ...read, timeline: kept.sort((x, y) => x.at.localeCompare(y.at)) };
}

/** One poll of the news log. A failure only means the timeline waits for the next poll. */
async function refreshNews(now: Date): Promise<NewsLog> {
  const log = (await readDoc<NewsLog>(PATHS.news, { fresh: true }))?.value ?? NO_NEWS;
  const next = await advanceNews(log, now);
  if (next !== log) await writeDoc(PATHS.news, next);
  return next;
}

const unreadStories = (b: Blackout) => (b.timeline ?? []).filter((e) => !e.official && !b.statementUrls?.includes(e.url));

/** The blackout most worth reading now: a recent one that sent a high-priority alert and has new stories. */
export function statementsDue(list: Blackout[], now: number): Blackout | undefined {
  return list.find((b) => (b.unexplainedNoticeAt || b.deliberateNoticeAt) && (b.statementReads ?? 0) < STATEMENT_READS && now - Date.parse(b.startedAt) < STATEMENT_MAX_AGE_MS && unreadStories(b).length > 0);
}

/** Count a read of these stories. Done first, so one that fails after it's been billed still counts. */
export const withRead = (b: Blackout, urls: string[]): Blackout => ({ ...b, statementUrls: [...(b.statementUrls ?? []), ...urls], statementReads: (b.statementReads ?? 0) + 1 });

/** Those who should know come before anyone else, so later statements from them aren't crowded out. */
const speakerRank = (s: Statement) => (s.speakerType === 'public' ? 2 : s.speakerType === 'reporter' ? 1 : 0);

/** Fold what was read into a record. It's shown on the page and never touches the cause. */
export function withStatements(b: Blackout, found: Statement[]): Blackout {
  const seen = new Set<string>();
  const statements = [...(b.statements ?? []), ...found].filter((s) => {
    const key = `${s.speaker}:${s.quote}`.toLowerCase();
    return !seen.has(key) && seen.add(key);
  });
  return { ...b, statements: statements.sort((x, y) => speakerRank(x) - speakerRank(y)).slice(0, STATEMENTS_KEPT) };
}

/** Read one blackout's new stories. Off without a key, and run after alerts so it can't delay one. */
export async function refreshStatements(now: Date): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) return;
  const list = (await readDoc<Blackout[]>(PATHS.blackouts, { fresh: true }))?.value ?? [];
  const due = statementsDue(list, now.getTime());
  if (!due) return;
  const stories = unreadStories(due).slice(0, MAX_ARTICLES);
  await writeDoc(PATHS.blackouts, list.map((b) => (b.id === due.id ? withRead(b, stories.map((s) => s.url)) : b)));
  const articles = await readArticles(stories);
  const reading = articles.length ? await extractStatements(statementClient(), due.label, eastern(due.startedAt), articles, now.toISOString()) : null;
  if (!reading?.statements.length) return;
  // That took a while, so this goes onto the list as it is now. If a poll got in first, it's skipped.
  const latest = await readDoc<Blackout[]>(PATHS.blackouts, { fresh: true });
  if (latest) await swapDoc(PATHS.blackouts, latest.value.map((b) => (b.id === due.id ? withStatements(b, reading.statements) : b)), latest.etag);
}

/** Oldest records go first, with far more room for large ones, and anything open stays. */
export function trimBlackouts(list: Blackout[]): Blackout[] {
  let small = 0;
  let large = 0;
  return list.filter((b) => !b.resolvedAt || (b.peakCustomers >= LARGE_CUSTOMERS ? ++large <= LARGE_BLACKOUTS_KEPT : ++small <= SMALL_BLACKOUTS_KEPT));
}

/** Bring the list up to date and run whatever checks are due. Writes nothing. */
export async function updateBlackouts(prev: Blackout[], engine: EngineState, snapshot: Snapshot, peoplePerCustomer: number, now: Date, news = NO_NEWS): Promise<Blackout[]> {
  const synced = syncBlackouts(prev, engine, snapshot, peoplePerCustomer, now.toISOString()).map((b) => withNews(b, news, now.getTime()));
  const due = synced.filter((b) => needsCheck(b, now.getTime()));
  if (!due.length) return synced;

  const utilityDue = due.filter((b) => !b.resolvedAt && (!b.utilityCheckedAt || now.getTime() - Date.parse(b.utilityCheckedAt) >= UTILITY_CHECK_MS));
  const readThrough = Math.min(...due.map((b) => Date.parse(b.checkReads?.['storm warnings'] ?? b.checkFrom ?? b.startedAt)));
  const [world, stated] = await Promise.all([
    gatherWorld([...new Set(due.flatMap((b) => b.states))], [...new Set(due.flatMap((b) => [...(causeArea(b).stations ?? [])]))], operatorsToRead(due), now, readThrough),
    Promise.all(utilityDue.map(async (b) => [b.id, await readStatedCauses(b)] as const)),
  ]);
  const statedById = new Map(stated);
  return synced.map((b) => (due.includes(b) ? applyChecks(b, world, statedById.get(b.id), now) : b));
}

/** One poll of blackout upkeep. */
export async function refreshBlackouts(engine: EngineState, snapshot: Snapshot, peoplePerCustomer: number, now: Date): Promise<Blackout[]> {
  const stored = await readDoc<Blackout[]>(PATHS.blackouts, { fresh: true });
  const news = await within(refreshNews(now), 'news', NEWS_DEADLINE_MS);
  const next = await updateBlackouts(stored?.value ?? [], engine, snapshot, peoplePerCustomer, now, news ?? NO_NEWS);
  await writeDoc(PATHS.blackouts, trimBlackouts(next));
  return next;
}

/** Whether storm warnings couldn't be read on a poll that needed them. */
export const stormCheckFailed = (list: Blackout[], at: string) => list.some((b) => b.checkedAt === at && b.checkReads?.['storm warnings'] !== at);

/** What to say about the cause in a notification. */
export function causeLine(b: Blackout): string | undefined {
  const strong = b.evidence.find((e) => e.strong);
  if (strong) return `Likely cause: ${strong.label}.`;
  if (!b.checked.length) return undefined;
  return `Cause unknown so far: no ${orList(b.checked)} found.`;
}

function notice(kind: AlertKind, b: Blackout, detail: string, at: string): AlertEvent {
  return { id: `${b.id}:${kind}`, kind, key: b.key, scope: b.scope, label: b.label, at, people: b.people, peakPeople: b.peakPeople, customers: b.peakCustomers, openedAt: b.openedAt, detail, link: '/#alerts', areas: [b.label] };
}

/** The report worth an alert, if there is one. Anyone can publish one headline, so a lone unknown site doesn't count. */
function deliberateReport(b: Blackout): TimelineEntry | undefined {
  const reports = (b.timeline ?? []).filter((e) => e.deliberate);
  const official = reports.find((e) => e.official);
  // An agency saying so is news even after a report has already gone out.
  if (b.deliberateNoticeAt) return b.deliberateOfficialAt ? undefined : official;
  const outlets = new Set(reports.map((e) => outletOf(e.source)));
  return official ?? reports.find((e) => isTrustedOutlet(e.source)) ?? (outlets.size >= 2 ? reports[0] : undefined);
}

function deliberateDetail(b: Blackout, report: TimelineEntry): string {
  const headline = report.title.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, HEADLINE_CHARS);
  const outlets = new Set((b.timeline ?? []).filter((e) => e.deliberate).map((e) => outletOf(e.source))).size;
  return `${report.source} reports: "${headline}" ${outlets > 1 ? `${outlets} outlets are saying so, but it` : 'This is one report and it'} is not confirmed. The cause status is unchanged.`;
}

function unexplainedDetail(b: Blackout, level: number): string {
  const utilities = b.utilities.length ? ` Utilities: ${b.utilities.map((u) => u.name).join(', ')}.` : '';
  const context = b.evidence.filter((e) => !e.strong).map((e) => e.label);
  const noted = context.length ? ` Also noted, but not enough to explain it: ${context.join('; ')}.` : '';
  const blind = b.blindSince ? ` Part of the data for this area stopped at ${eastern(b.blindSince)} ET, which can happen when the power is out, so the count may be low.` : '';
  const steady = !b.blindSince && readingSteady(b.reading, level) ? ` The count has not moved since ${eastern(b.reading.at)} ET, so this may be a false reading.` : '';
  const found = b.checked.length ? `No ${orList(b.checked)} found.` : '';
  const unread = b.checked.includes('storm warnings') ? '' : ' Storm warnings could not be read, so a storm is not ruled out.';
  const started = b.checkFrom ? `Jumped at ${eastern(b.checkFrom)} ET, after an earlier outage here` : `Started ${eastern(b.startedAt)} ET`;
  const jump = (b.jumpCustomers ?? 0) >= level ? ` About ${num(b.jumpCustomers!)} customers went out within 30 minutes.` : '';
  return `${started}, now about ${num(b.people)} people.${jump} ${found}${unread}${noted}${utilities}${blind}${steady} Nothing ordinary explains it yet, which does not mean an attack.`.replace('  ', ' ');
}

/**
 * Find blackouts that have just become worth the high-priority alert, whose alert
 * should be withdrawn because a cause turned up, or that ended after one. Each fires
 * once per blackout.
 */
export function takeNotices(list: Blackout[], settings: Settings, at: string): { list: Blackout[]; events: AlertEvent[] } {
  const events: AlertEvent[] = [];
  const next = list.map((b) => {
    const bar = alertBar(b, settings.unexplainedCustomers);
    const stillOut = b.people / settings.peoplePerCustomer >= settings.unexplainedCustomers * STILL_OUT_SHARE;
    // A feed dying right after a jump is what a real blackout can look like, so it doesn't wait for the count.
    const held = !b.blindSince && heldBack(b.reading, bar, Date.parse(at));
    if (bar > 0 && !b.unexplainedNoticeAt && !b.resolvedAt && b.cause === 'unknown' && stillOut && !held) {
      events.push(notice('unexplained', b, unexplainedDetail(b, bar), at));
      return { ...b, unexplainedNoticeAt: at };
    }
    if (b.unexplainedNoticeAt && !b.explainedNoticeAt && b.cause === 'explained') {
      const strong = b.evidence.find((e) => e.strong);
      const why = strong?.kind === 'operator' ? ' That says who cut the power, not why.' : '';
      events.push(notice('explained', b, `Likely cause: ${strong?.label ?? 'an ordinary cause'}.${why} This replaces the earlier unexplained alert.`, at));
      return { ...b, explainedNoticeAt: at };
    }
    // Ordinary outages aren't sent, so the end of one is only news after an alert that still stands.
    const alerted = (b.unexplainedNoticeAt && !b.explainedNoticeAt) || b.deliberateNoticeAt;
    if (alerted && b.resolvedAt && !b.restoredNoticeAt) {
      const detail = b.blindSince ? `Part of the data for this area stopped at ${eastern(b.blindSince)} ET and never came back, so it isn't known whether the power is back.` : '';
      events.push({ ...notice('resolved', b, detail, at), ...(b.blindSince && { blind: true }) });
      return { ...b, restoredNoticeAt: at };
    }
    const report = deliberateReport(b);
    if (report) {
      const second = Boolean(b.deliberateNoticeAt);
      const event = notice('deliberate', b, deliberateDetail(b, report), at);
      events.push(second ? { ...event, id: `${event.id}:official` } : event);
      return { ...b, deliberateNoticeAt: b.deliberateNoticeAt ?? at, deliberateOfficialAt: report.official ? at : undefined };
    }
    // A smaller sudden jump, for the owner alone. One at the alert level is the alert's to send or hold, and a
    // slow climb is what a storm looks like.
    const level = settings.unexplainedCustomers;
    const watch = level > 0 && bar === 0 && settings.watchCustomers > 0 && (b.jumpCustomers ?? 0) >= settings.watchCustomers ? settings.watchCustomers : 0;
    const watchOut = b.people / settings.peoplePerCustomer >= settings.watchCustomers * STILL_OUT_SHARE;
    if (watch > 0 && !b.watchNoticeAt && !b.unexplainedNoticeAt && !b.resolvedAt && b.cause === 'unknown' && watchOut && (b.blindSince || !heldBack(b.reading, watch, Date.parse(at)))) {
      events.push({ ...notice('watch', b, `${unexplainedDetail(b, watch)} It's under the alert level of ${num(level)} customers, so this went only to you.`, at), link: b.link || '/alerts' });
      return { ...b, watchNoticeAt: at };
    }
    return b;
  });
  return { list: next, events };
}

export function withCause(event: AlertEvent, blackouts: Blackout[]): AlertEvent {
  if (event.kind !== 'opened' && event.kind !== 'escalated') return event;
  const b = blackouts.find((x) => x.id === `${event.key}:${event.openedAt}`);
  return b ? { ...event, cause: causeLine(b) } : event;
}
