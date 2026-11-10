import { createHash } from 'node:crypto';
import type { Candidate } from './alerts/engine.ts';
import { countyName, metroForCounty } from './geo.ts';
import { metrosFor, placer, statesFor } from './places.ts';
import { customersOf, directEiaIds, metroByCbsa, metros, odinEiaIds, odinReporters, sources, unmonitored, utilities, utilityByEia, utilityWeightInMetro } from './registry.ts';
import { pool } from './sources/http.ts';
import { type OdinRow, readOdin } from './sources/odin.ts';
import { readSource, validateReading } from './sources/read.ts';
import type { Reading, Source } from './sources/types.ts';
import type { MetroCounty, MetroStatus, MetroUtility, Settings, Snapshot, SourceHealth, StuckFeed, UtilityStatus } from './types.ts';

const CONCURRENCY = 24;
/** How long a failed feed may keep showing its last value before counting as down. */
const STALE_MS = 30 * 60_000;
const UNMATCHED_LIMIT = 60;
/**
 * An area counts as fully observed while feeds for under this share of its
 * customers are failing. Without it, one small co-op's dead feed would stop a
 * big metro's alert from ever resolving.
 */
const MAX_BLIND_SHARE = 0.1;
/** A clock that stops this long means a frozen feed. Live ones ran up to 25 minutes behind. */
const FROZEN_CLOCK_MS = 2 * 3_600_000;
/** With no clock to go on, an unchanged reading is weak evidence, so this is twice the longest seen. */
const FROZEN_READING_MS = 12 * 3_600_000;
/** Below this, one long repair can keep a feed's reading the same for a day. */
const FROZEN_READING_MIN_OUT = 100;
/**
 * Several large feeds stopping together is far stronger than one doing so, so this is much
 * sooner than FROZEN_CLOCK_MS. Live clocks ran up to 25 minutes behind.
 */
const STUCK_MS = 45 * 60_000;
const STUCK_MIN_CUSTOMERS = 100_000;
/** Every feed reads in about 6 seconds, so this only stops a hang from using up the alerts' time. */
const COLLECT_BUDGET_MS = 90_000;
/** Below this share placed, a feed's county detail is missing more than it shows. */
const MIN_PLACED_SHARE = 0.5;
/** ODIN showing this many out at a utility whose own feed says 0 suggests the feed is wrong. */
const ODIN_AHEAD_MIN_OUT = 100;

/** The last successful reading per source, carried between runs. */
export interface LastGood {
  at: string;
  customersOut: number;
  customersServed?: number;
  incidents?: number;
  mode?: string;
  /** Customers out by county FIPS, only where non-zero. */
  counties: Record<string, number>;
  /** The feed's own clock, if it has one, and when that last changed. */
  clock?: string;
  clockAt?: string;
  /** A digest of the reading, and when that last changed. */
  digest?: string;
  digestAt?: string;
  /** When the count last fell to 0, while it stays there. */
  zeroSince?: string;
  /** Polls in a row ODIN has shown outages this feed says it doesn't have. */
  odinAhead?: number;
}

export type LastGoodMap = Record<string, LastGood>;

interface Polled {
  source: Source;
  reading?: Reading;
  error?: string;
  latencyMs: number;
}

async function pollSource(source: Source, deadline: Promise<never>): Promise<Polled> {
  const started = Date.now();
  try {
    const reading = await Promise.race([readSource(source), deadline]);
    const invalid = validateReading(reading, customersOf(source));
    if (invalid) throw new Error(invalid);
    return { source, reading, latencyMs: Date.now() - started };
  } catch (err) {
    return { source, error: (err as Error).message.slice(0, 200), latencyMs: Date.now() - started };
  }
}

/** Carry forward when a feed's clock and its reading last changed. */
export function trackChanges(reading: Reading, prior: LastGood | undefined, at: string): Pick<LastGood, 'clock' | 'clockAt' | 'digest' | 'digestAt'> {
  const digest = createHash('sha1').update(JSON.stringify([reading.customersOut, reading.incidents, reading.areas?.map((a) => [a.name, a.customersOut])])).digest('base64url').slice(0, 12);
  return {
    clock: reading.asOf,
    clockAt: reading.asOf ? (prior?.clock === reading.asOf ? prior.clockAt : at) : undefined,
    digest,
    digestAt: prior?.digest === digest ? prior.digestAt : at,
  };
}

/** When a feed that still answers stopped updating, or nothing if it hasn't. */
export function frozenSince(good: LastGood, now: number): string | undefined {
  const olderThan = (at: string | undefined, limit: number) => !!at && now - Date.parse(at) >= limit;
  if (olderThan(good.clockAt, FROZEN_CLOCK_MS)) return good.clockAt;
  if (good.customersOut >= FROZEN_READING_MIN_OUT && olderThan(good.digestAt, FROZEN_READING_MS)) return good.digestAt;
  return undefined;
}

/** When a large feed stopped updating, or nothing if it's fine or too small to count. */
export function stuckSince(good: LastGood | undefined, answered: boolean, customers: number, now: number): string | undefined {
  if (!good || customers < STUCK_MIN_CUSTOMERS) return undefined;
  const last = answered ? good.clockAt : good.at;
  return last && now - Date.parse(last) >= STUCK_MS ? last : undefined;
}

function resolveAreas(source: Source, reading: Reading, unmatched: Snapshot['unmatchedAreas']): Record<string, number> {
  const counties: Record<string, number> = {};
  const place = placer(source);
  const served = new Set([...metrosFor(source), ...(source.alsoMetros ?? [])]);
  for (const area of reading.areas ?? []) {
    if (area.customersOut <= 0) continue;
    const fips = place(area);
    // A feed can only speak for its own territory, so one bad feed can't invent a blackout elsewhere.
    const metro = fips && metroForCounty(fips);
    if (fips && (!metro || served.has(metro))) {
      counties[fips] = (counties[fips] ?? 0) + area.customersOut;
    } else if (unmatched.length < UNMATCHED_LIMIT) {
      unmatched.push({ source: source.id, name: area.name, state: area.state, customersOut: area.customersOut });
    }
  }
  return counties;
}

/** Spread a total across last poll's counties, for when this poll's county report failed. */
function resplit(counties: Record<string, number> = {}, total: number): Record<string, number> {
  const sum = Object.values(counties).reduce((s, n) => s + n, 0);
  return sum ? Object.fromEntries(Object.entries(counties).map(([fips, n]) => [fips, Math.round((n / sum) * total)])) : {};
}

export interface CollectResult {
  snapshot: Snapshot;
  candidates: Candidate[];
  lastGood: LastGoodMap;
}

export async function collect(previous: LastGoodMap, settings: Settings, now: Date): Promise<CollectResult> {
  const started = Date.now();
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Ran out of time this poll')), COLLECT_BUDGET_MS);
  });
  deadline.catch(() => {});
  const [polled, odin] = await Promise.all([
    pool(sources, CONCURRENCY, (source) => pollSource(source, deadline)),
    Promise.race([readOdin(now.getTime()), deadline]).catch((err: Error) => {
      console.error('ODIN failed:', err.message);
      return null;
    }),
  ]);
  clearTimeout(timer!);

  const unmatchedAreas: Snapshot['unmatchedAreas'] = [];
  const lastGood: LastGoodMap = {};
  const utilityRows: UtilityStatus[] = [];
  /** cbsa -> utility row id -> customers attributed to that metro */
  const metroUtility = new Map<string, Map<string, number>>();
  const metroCounty = new Map<string, Map<string, number>>();
  const nationalCounties: Record<string, number> = {};
  const liveEia = new Set<number>();

  const attribute = (rowId: string, fips: string, customers: number) => {
    nationalCounties[fips] = (nationalCounties[fips] ?? 0) + customers;
    const cbsa = metroForCounty(fips);
    if (!cbsa) return;
    if (!metroUtility.has(cbsa)) metroUtility.set(cbsa, new Map());
    if (!metroCounty.has(cbsa)) metroCounty.set(cbsa, new Map());
    const u = metroUtility.get(cbsa)!;
    u.set(rowId, (u.get(rowId) ?? 0) + customers);
    const c = metroCounty.get(cbsa)!;
    c.set(fips, (c.get(fips) ?? 0) + customers);
  };

  const odinByEia = new Map<number, OdinRow[]>();
  for (const row of odin ?? []) {
    if (row.eiaId == null) continue;
    if (!odinByEia.has(row.eiaId)) odinByEia.set(row.eiaId, []);
    odinByEia.get(row.eiaId)!.push(row);
  }

  const candidates: Candidate[] = [];
  const multiMetroUtility: Array<{ row: UtilityStatus; source: Source; unattributed: number }> = [];
  const stuckFeeds: StuckFeed[] = [];

  for (const p of polled) {
    const { source } = p;
    let health: SourceHealth = 'down';
    let via: UtilityStatus['via'] = 'none';
    let good: LastGood | undefined;
    let frozenAt: string | undefined;

    if (p.reading) {
      via = 'direct';
      const prior = previous[source.id];
      const zero = p.reading.customersOut === 0;
      const odinOut = source.eiaIds.flatMap((id) => odinByEia.get(id) ?? []).reduce((s, r) => s + r.customersOut, 0);
      good = {
        at: now.toISOString(),
        customersOut: p.reading.customersOut,
        customersServed: p.reading.customersServed,
        incidents: p.reading.incidents,
        mode: p.reading.mode,
        counties: p.reading.areasMissing ? resplit(prior?.counties, p.reading.customersOut) : resolveAreas(source, p.reading, unmatchedAreas),
        ...trackChanges(p.reading, prior, now.toISOString()),
        zeroSince: zero ? (prior?.zeroSince ?? now.toISOString()) : undefined,
        odinAhead: zero && odinOut >= ODIN_AHEAD_MIN_OUT ? (prior?.odinAhead ?? 0) + 1 : 0,
      };
      lastGood[source.id] = good;
      frozenAt = frozenSince(good, now.getTime());
      health = frozenAt ? 'frozen' : 'ok';
    } else {
      const prior = previous[source.id];
      if (prior) {
        lastGood[source.id] = prior;
        if (now.getTime() - new Date(prior.at).getTime() <= STALE_MS) {
          health = 'stale';
          via = 'direct';
          good = prior;
        }
      }
    }

    // A dead direct feed can still be covered by ODIN for the same utility.
    const odinRows = !good ? source.eiaIds.flatMap((id) => odinByEia.get(id) ?? []) : [];
    if (odinRows.length) {
      via = 'odin';
      health = 'stale';
      const counties: Record<string, number> = {};
      for (const r of odinRows) counties[r.fips] = (counties[r.fips] ?? 0) + r.customersOut;
      good = { at: now.toISOString(), customersOut: odinRows.reduce((s, r) => s + r.customersOut, 0), counties };
    }

    if (health === 'ok' || health === 'stale') source.eiaIds.forEach((id) => liveEia.add(id));

    const since = stuckSince(lastGood[source.id], Boolean(p.reading), customersOf(source), now.getTime());
    if (since) stuckFeeds.push({ id: source.id, name: source.name, method: source.method, since });

    const counties = good?.counties ?? {};
    const attributedOut = Object.values(counties).reduce((s, n) => s + n, 0);
    for (const [fips, n] of Object.entries(counties)) attribute(source.id, fips, n);

    const row: UtilityStatus = {
      id: source.id,
      name: source.name,
      eiaIds: source.eiaIds,
      method: source.method,
      mapUrl: source.mapUrl,
      granularity: source.granularity,
      health,
      via,
      customersOut: good?.customersOut ?? 0,
      customersServed: good?.customersServed ?? p.reading?.customersServed,
      incidents: good?.incidents,
      mode: good?.mode,
      attributedOut,
      lastOkAt: lastGood[source.id]?.at,
      frozenSince: frozenAt,
      zeroSince: good?.zeroSince,
      odinAhead: good?.odinAhead,
      areasMissing: p.reading?.areasMissing,
      error: p.error,
      latencyMs: p.latencyMs,
    };
    utilityRows.push(row);

    const areas = metrosFor(source);
    if (areas.length === 1) {
      // One metro: whatever the feed couldn't place by county still belongs there,
      // which covers local names like "Orlando Northwest" and utility-wide totals.
      const unplaced = row.customersOut - attributedOut;
      if (unplaced > 0) {
        const cbsa = areas[0];
        if (!metroUtility.has(cbsa)) metroUtility.set(cbsa, new Map());
        const u = metroUtility.get(cbsa)!;
        u.set(source.id, (u.get(source.id) ?? 0) + unplaced);
      }
    } else if (areas.length > 1) {
      // Always emitted, even at zero, so an open utility alert can resolve. What can't be placed
      // still needs to raise an alert somewhere, unless it's only that the county report failed.
      const placed = row.customersOut ? attributedOut / row.customersOut : 1;
      multiMetroUtility.push({ row, source, unattributed: placed < MIN_PLACED_SHARE && !row.areasMissing ? row.customersOut - attributedOut : 0 });
    }
  }

  // ODIN-only utilities and any ODIN utility without a direct feed.
  if (odin) {
    const grouped = new Map<string, OdinRow[]>();
    for (const r of odin) {
      if (r.eiaId != null && directEiaIds.has(r.eiaId)) continue;
      const key = r.eiaId != null ? String(r.eiaId) : r.utilityName;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(r);
    }
    for (const [key, rows] of grouped) {
      const eiaId = rows[0].eiaId;
      const registry = eiaId != null ? utilityByEia.get(eiaId) : undefined;
      const id = `odin-${key}`;
      let total = 0;
      for (const r of rows) {
        total += r.customersOut;
        attribute(id, r.fips, r.customersOut);
      }
      if (eiaId != null) liveEia.add(eiaId);
      utilityRows.push({
        id,
        name: registry?.name ?? rows[0].utilityName,
        eiaIds: eiaId != null ? [eiaId] : [],
        method: 'odin',
        granularity: 'county',
        health: 'ok',
        via: 'odin',
        customersOut: total,
        customersServed: registry?.customers,
        attributedOut: total,
      });
    }
    // ODIN lists only utilities with outages, so a quiet reporter is healthy, not missing.
    odinReporters.forEach((id) => liveEia.add(id));
    for (const u of unmonitored) {
      if (u.method === 'odin-only') u.eiaIds.forEach((id) => liveEia.add(id));
    }
  }

  const rowById = new Map(utilityRows.map((r) => [r.id, r]));
  const metroRows: MetroStatus[] = metros.map((m) => {
    const perUtility = metroUtility.get(m.cbsa) ?? new Map<string, number>();
    const perCounty = metroCounty.get(m.cbsa) ?? new Map<string, number>();
    const customersOut = [...perUtility.values()].reduce((s, n) => s + n, 0);

    const utilityList: MetroUtility[] = [...perUtility.entries()]
      .map(([id, n]) => ({ id, name: rowById.get(id)?.name ?? id, customersOut: n }))
      .sort((a, b) => b.customersOut - a.customersOut);
    const countyList: MetroCounty[] = [...perCounty.entries()]
      .map(([fips, n]) => ({ fips, name: countyName(fips), customersOut: n }))
      .sort((a, b) => b.customersOut - a.customersOut)
      .slice(0, 12);

    let weightLive = 0;
    let weightAll = 0;
    const gaps: Array<{ name: string; w: number }> = [];
    for (const eia of m.utilities) {
      const u = utilityByEia.get(eia);
      if (!u) continue;
      const w = utilityWeightInMetro(u, m);
      weightAll += w;
      if (liveEia.has(eia)) weightLive += w;
      else if (u.customers >= 25_000) gaps.push({ name: u.name, w });
    }

    return {
      cbsa: m.cbsa,
      name: m.name,
      states: [...new Set(m.counties.map((c) => c.state))],
      population: m.population,
      customersOut,
      estimatedPeople: Math.round(customersOut * settings.peoplePerCustomer),
      utilities: utilityList,
      counties: countyList,
      // A metro with no EIA utility is covered only by a feed that names it.
      coverage: weightAll ? weightLive / weightAll : sources.some((s) => s.metros?.includes(m.cbsa)) ? 1 : 0,
      gaps: gaps.sort((a, b) => b.w - a.w).slice(0, 6).map((g) => g.name),
    };
  });

  for (const m of metroRows) {
    const registry = metroByCbsa.get(m.cbsa)!;
    let blind = 0;
    let total = 0;
    for (const s of sources) {
      const ids = s.eiaIds.filter((id) => registry.utilities.includes(id));
      if (!ids.length && !s.metros?.includes(m.cbsa)) continue;
      const weight = ids.length ? Math.max(...ids.map((id) => utilityWeightInMetro(utilityByEia.get(id)!, registry))) : customersOf(s);
      total += weight;
      const row = rowById.get(s.id);
      if (row?.health !== 'ok' || row.areasMissing) blind += weight;
    }
    for (const id of registry.utilities) {
      const u = utilityByEia.get(id);
      if (!u || directEiaIds.has(id) || !odinEiaIds.has(id)) continue;
      const weight = utilityWeightInMetro(u, registry);
      total += weight;
      if (!odin) blind += weight;
    }
    candidates.push({
      key: `metro:${m.cbsa}`,
      scope: 'metro',
      label: m.name,
      people: m.estimatedPeople,
      customers: m.customersOut,
      detail: describeMetro(m),
      link: `/metros/${m.cbsa}`,
      states: m.states,
      complete: total === 0 || blind / total < MAX_BLIND_SHARE,
    });
  }

  for (const { row, source, unattributed } of multiMetroUtility) {
    candidates.push({
      key: `utility:${source.id}`,
      scope: 'utility',
      label: source.name,
      people: Math.round(unattributed * settings.peoplePerCustomer),
      customers: unattributed,
      detail: `Utility-wide total; this feed has no county detail. Serves ${metrosFor(source)
        .slice(0, 4)
        .map((c) => metroByCbsa.get(c)?.name ?? c)
        .join('; ')}.`,
      link: '/coverage',
      states: statesFor(source),
      complete: row.health === 'ok' && !row.areasMissing,
    });
  }

  const customersOut = utilityRows.reduce((s, r) => s + r.customersOut, 0);
  const customersTotal = utilities.reduce((s, u) => s + u.customers, 0);
  const customersMonitored = utilities.filter((u) => liveEia.has(u.eiaId)).reduce((s, u) => s + u.customers, 0);

  const snapshot: Snapshot = {
    generatedAt: now.toISOString(),
    durationMs: Date.now() - started,
    customersOut,
    estimatedPeople: Math.round(customersOut * settings.peoplePerCustomer),
    sourcesOk: utilityRows.filter((r) => r.health === 'ok').length,
    sourcesStale: utilityRows.filter((r) => r.health === 'stale').length,
    sourcesFrozen: utilityRows.filter((r) => r.health === 'frozen').length,
    sourcesDown: utilityRows.filter((r) => r.health === 'down').length,
    stuckFeeds,
    odinDown: !odin,
    customersMonitored,
    customersTotal,
    metros: metroRows.sort((a, b) => b.customersOut - a.customersOut || b.population - a.population),
    utilities: utilityRows.sort((a, b) => b.customersOut - a.customersOut),
    counties: nationalCounties,
    unmatchedAreas,
  };

  return { snapshot, candidates, lastGood };
}

function describeMetro(m: MetroStatus): string {
  const parts: string[] = [];
  if (m.utilities.length) {
    parts.push(m.utilities.slice(0, 3).map((u) => `${u.name} ${u.customersOut.toLocaleString('en-US')}`).join(', '));
  }
  const hit = m.counties.slice(0, 3).filter((c) => c.customersOut > 0);
  if (hit.length) {
    parts.push(`Hardest hit: ${hit.map((c) => `${c.name} ${c.customersOut.toLocaleString('en-US')}`).join(', ')}`);
  }
  return parts.join('. ');
}
