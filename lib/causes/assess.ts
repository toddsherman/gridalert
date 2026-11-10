import { countyName } from '../geo.ts';
import { metros } from '../registry.ts';
import type { CauseCheck, Evidence } from '../types.ts';
import type { World } from './feeds.ts';
import { distanceKm } from './news.ts';
import { OPERATOR_NAMES } from './operators.ts';
import { EXPLAINING_EVENTS, FIRE_MAX_AGE_MS, quakeReachKm, SEVERE_KP, SPACE_AFTER_MS, SPACE_BEFORE_MS, WEATHER_AFTER_MS, WEATHER_BEFORE_MS, WIND_GUST_MPH } from './rules.ts';

/** Where and when a blackout happened, as the checks see it. */
export interface CauseArea {
  fips: ReadonlySet<string>;
  /** [lon, lat] of each affected county. */
  points: Array<[number, number]>;
  /** Weather stations in the metro. A gust anywhere in it says the wind was real. */
  stations?: ReadonlySet<string>;
  /** Grid operators serving the area, and its states, for matching their notices. */
  operators?: ReadonlySet<string>;
  states?: ReadonlySet<string>;
  start: number;
  /**
   * When the count last set a new high. A storm can arrive hours after a small first
   * rise, so causes are looked for across the whole climb.
   */
  end?: number;
}

const countyLabels = new Map(metros.flatMap((m) => m.counties.map((c) => [c.fips, `${c.name}, ${c.state}`] as const)));
const countyLabel = (fips: string) => countyLabels.get(fips) ?? countyName(fips);

const untilOf = (area: CauseArea) => area.end ?? area.start;
const inWindow = (at: number, area: CauseArea) => at >= area.start - WEATHER_BEFORE_MS && at <= untilOf(area) + WEATHER_AFTER_MS;
const inForce = (alert: { start: number; end: number }, area: CauseArea) => alert.start <= untilOf(area) + WEATHER_AFTER_MS && alert.end >= area.start - WEATHER_BEFORE_MS;

function weatherEvidence(world: World, area: CauseArea): Evidence[] {
  // One line per product: twenty warnings for one storm say the same thing.
  const seen = new Map<string, Evidence>();
  for (const alert of world.weather ?? []) {
    if (seen.has(alert.event)) continue;
    if (!inForce(alert, area)) continue;
    const county = alert.fips.find((f) => area.fips.has(f));
    if (!county) continue;
    seen.set(alert.event, {
      id: `weather:${alert.event}`,
      kind: 'weather',
      strong: EXPLAINING_EVENTS.has(alert.event),
      label: `${alert.event}, ${countyLabel(county)}`,
      source: 'National Weather Service',
      at: new Date(alert.start).toISOString(),
    });
  }
  return [...seen.values()];
}

function reportEvidence(world: World, area: CauseArea): Evidence[] {
  const seen = new Map<string, Evidence>();
  for (const report of world.reports ?? []) {
    if (seen.has(report.kind) || !report.fips || !area.fips.has(report.fips) || !inWindow(report.at, area)) continue;
    seen.set(report.kind, {
      id: `storm-report:${report.kind}`,
      kind: 'storm-report',
      strong: true,
      label: `${report.kind === 'tornado' ? 'Tornado' : 'Damaging wind'} reported near ${report.place}`,
      source: 'NOAA Storm Prediction Center',
      at: new Date(report.at).toISOString(),
    });
  }
  return [...seen.values()];
}

/** A Wind Advisory alone matches too often by chance, so it takes a measured gust to count. */
function gustEvidence(world: World, area: CauseArea): Evidence[] {
  const gusts = (world.gusts ?? []).filter((g) => area.stations?.has(g.station) && g.mph >= WIND_GUST_MPH && inWindow(g.at, area));
  if (!gusts.length) return [];
  const peak = gusts.reduce((a, b) => (b.mph > a.mph ? b : a));
  const advisory = (world.weather ?? []).some((a) => a.event === 'Wind Advisory' && inForce(a, area) && a.fips.some((f) => area.fips.has(f)));
  return [{
    id: 'wind-gust',
    kind: 'wind-gust',
    strong: advisory,
    label: `Measured gust of ${Math.round(peak.mph)} mph at ${peak.station}${advisory ? ' during a Wind Advisory' : ', with no Wind Advisory'}`,
    source: 'NOAA Aviation Weather Center',
    at: new Date(peak.at).toISOString(),
  }];
}

function fireEvidence(world: World, area: CauseArea): Evidence[] {
  return (world.fires ?? [])
    .filter((f) => area.fips.has(f.fips) && f.discoveredAt <= untilOf(area) + WEATHER_AFTER_MS && area.start - f.discoveredAt <= FIRE_MAX_AGE_MS)
    .sort((a, b) => b.acres - a.acres)
    .slice(0, 1)
    .map((f) => ({
      id: `wildfire:${f.name}`,
      kind: 'wildfire',
      strong: true,
      label: `${f.name} wildfire, ${Math.round(f.acres).toLocaleString('en-US')} acres, ${countyLabel(f.fips)}`,
      source: 'National Interagency Fire Center',
      at: new Date(f.discoveredAt).toISOString(),
    }));
}

function quakeEvidence(world: World, area: CauseArea): Evidence[] {
  return (world.quakes ?? [])
    .filter((q) => inWindow(q.at, area) && area.points.some((p) => distanceKm(p, [q.lon, q.lat]) <= quakeReachKm(q.magnitude)))
    .sort((a, b) => b.magnitude - a.magnitude)
    .slice(0, 1)
    .map((q) => ({
      id: `earthquake:${q.id}`,
      kind: 'earthquake',
      strong: true,
      label: `Magnitude ${q.magnitude.toFixed(1)} earthquake, ${q.place}`,
      source: 'US Geological Survey',
      at: new Date(q.at).toISOString(),
      url: q.url,
    }));
}

function spaceEvidence(world: World, area: CauseArea): Evidence[] {
  const hits = (world.kp ?? []).filter((r) => r.kp >= SEVERE_KP && r.at >= area.start - SPACE_BEFORE_MS && r.at <= untilOf(area) + SPACE_AFTER_MS);
  if (!hits.length) return [];
  const worst = hits.reduce((a, b) => (b.kp > a.kp ? b : a));
  return [{ id: 'space-weather', kind: 'space-weather', strong: false, label: `Severe geomagnetic storm, Kp ${worst.kp.toFixed(0)}`, source: 'NOAA Space Weather Prediction Center', at: new Date(worst.at).toISOString() }];
}

/** Only a stated order to cut power settles a cause. An emergency says the grid was short, not that anyone cut this area. */
function operatorEvidence(world: World, area: CauseArea): Evidence[] {
  const seen = new Map<string, Evidence>();
  for (const operator of area.operators ?? []) {
    for (const notice of world.notices?.[operator] ?? []) {
      const here = !notice.states.length || notice.states.some((s) => area.states?.has(s));
      const id = `operator:${operator}:${notice.title}`;
      if (!here || seen.has(id) || !inForce(notice, area)) continue;
      const cut = notice.level === 'cut';
      seen.set(id, {
        id,
        kind: 'operator',
        strong: cut,
        label: `${OPERATOR_NAMES[operator]} ${cut ? 'ordered power cuts' : 'grid emergency'}: ${notice.title}`,
        source: OPERATOR_NAMES[operator],
        at: new Date(notice.start).toISOString(),
        url: notice.url,
      });
    }
  }
  return [...seen.values()];
}

/** Compare one area against everything the checks found. Pure, so it can be backtested. */
export function assess(area: CauseArea, world: World): { evidence: Evidence[]; checked: CauseCheck[] } {
  const checked: CauseCheck[] = [];
  if (world.weather) checked.push('storm warnings');
  if (world.reports) checked.push('storm reports');
  if (world.gusts && area.stations?.size) checked.push('gusts during a Wind Advisory');
  if (world.fires) checked.push('wildfires');
  if (world.quakes) checked.push('earthquakes');
  if (world.kp) checked.push('space weather');
  if (area.operators?.size && [...area.operators].every((o) => world.notices?.[o])) checked.push('grid operator notices');
  return {
    evidence: [...weatherEvidence(world, area), ...reportEvidence(world, area), ...gustEvidence(world, area), ...fireEvidence(world, area), ...quakeEvidence(world, area), ...spaceEvidence(world, area), ...operatorEvidence(world, area)],
    checked,
  };
}
