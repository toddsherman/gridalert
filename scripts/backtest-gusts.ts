// Would a measured wind gust be a safe way to explain a blackout? Tests a grid of rules
// against what really caused the unexplained alerts, against DOE's reports, and against
// random places and hours, where a match is pure coincidence.
//
// usage: node scripts/backtest-gusts.ts
// Needs the warning cache from backtest-eaglei.ts and backtest-causes.ts. Airport
// readings come from Iowa State's archive and are cached in .cache/backtest.
import fs from 'node:fs';
import { assess } from '../lib/causes/assess.ts';
import type { StormReport, WeatherAlert } from '../lib/causes/feeds.ts';
import windStations from '../data/wind-stations.json' with { type: 'json' };
import { metros } from '../lib/registry.ts';
import { isWeather, parseArea, type Report, reportStart } from './lib/doe.ts';
import { ASOS, COLUMNS, type Gust, loadStations, parseGusts, readingsFor, windyDays } from './lib/stations.ts';
import { CACHE, cached, DAY, HOUR, IEM, loadZones, parseWarnings, stormReportsFor } from './lib/warnings.ts';

/** A report reaches the public feed a few minutes after it is taken. */
const REPORT_LAG = 10 * 60_000;
const AFTER = 2 * HOUR;
const CONTROLS = 40_000;
const FIRST = Date.UTC(2024, 0, 1);
const LAST = Date.UTC(2026, 0, 1);

const MPH = [40, 45, 50, 55, 58];

interface Rule {
  mph: number;
  stations: number;
  advisory: boolean;
  beforeHours: number;
  field: 'mph' | 'gust';
  /** Stations in the affected counties, or anywhere in the metro. */
  scope: 'county' | 'metro';
}

interface Sample {
  gusts: Gust[];
  metroGusts: Gust[];
  start: number;
  advisory: boolean;
}

const between = (list: Gust[], from: number, to: number) => list.filter((g) => g.at >= from && g.at <= to);

function matches(rule: Rule, sample: Sample, until: number): boolean {
  if (rule.advisory && !sample.advisory) return false;
  const from = sample.start - rule.beforeHours * HOUR;
  const list = rule.scope === 'metro' ? sample.metroGusts : sample.gusts;
  return new Set(between(list, from, until).filter((g) => g[rule.field] >= rule.mph).map((g) => g.sid)).size >= rule.stations;
}

const zones = await loadZones();
fs.mkdirSync(CACHE, { recursive: true });
const stations = await loadStations();
console.error(`${[...stations.values()].flat().length} stations in ${stations.size} counties`);

// Two years of readings for every station in a metro.
const metroFips = new Set(metros.flatMap((m) => m.counties.map((c) => c.fips)));
const sids = [...new Set([...metroFips].flatMap((f) => stations.get(f) ?? []))];
console.error(`${sids.length} metro stations`);
const bySid = new Map<string, Gust[]>();
for (const [i, sid] of sids.entries()) {
  if (i % 50 === 0) console.error(`readings ${i} of ${sids.length}`);
  bySid.set(sid, await readingsFor(sid));
}
const countyGusts = new Map([...metroFips].map((f) => [f, (stations.get(f) ?? []).flatMap((sid) => bySid.get(sid) ?? [])]));
const gustsIn = (fips: Iterable<string>, from: number, to: number) => [...fips].flatMap((f) => between(countyGusts.get(f) ?? [], from, to));

// Warnings, as the replay loaded them.
const warningsByCounty = new Map<string, WeatherAlert[]>();
const reportsByCounty = new Map<string, StormReport[]>();
const seen = new Set<string>();
const pad = (n: number) => String(n).padStart(2, '0');
for (let day = FIRST - 6 * DAY; day < LAST; day += DAY) {
  const d = new Date(day);
  const n = new Date(day + DAY);
  const part = (x: Date, i: 1 | 2) => `year${i}=${x.getUTCFullYear()}&month${i}=${x.getUTCMonth() + 1}&day${i}=${x.getUTCDate()}&hour${i}=0&minute${i}=0`;
  const name = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const csv = await cached(`${CACHE}/iem-day-${name}.csv`, `${IEM}?${part(d, 1)}&${part(n, 2)}&accept=csv`);
  for (const alert of parseWarnings(csv, zones)) {
    if (seen.has(alert.id)) continue;
    seen.add(alert.id);
    for (const fips of alert.fips) warningsByCounty.set(fips, [...(warningsByCounty.get(fips) ?? []), alert]);
  }
  for (const report of await stormReportsFor(day + 12 * HOUR)) {
    if (report.fips) reportsByCounty.set(report.fips, [...(reportsByCounty.get(report.fips) ?? []), report]);
  }
}
console.error('weather loaded');

/** What the storm checks find for an area, using what was public by a moment. */
function evidenceAt(fips: string[], start: number, moment: number, withReports: boolean) {
  const alerts = [...new Map(fips.flatMap((f) => warningsByCounty.get(f) ?? []).filter((a) => a.start <= moment && a.end >= start - DAY).map((a) => [a.id, a])).values()];
  const reports = withReports ? fips.flatMap((f) => reportsByCounty.get(f) ?? []).filter((r) => r.at >= start - DAY && r.at <= moment + DAY) : [];
  return assess({ fips: new Set(fips), points: [], start, end: moment }, { weather: alerts, reports, fires: [], quakes: [], kp: [], gusts: [] }).evidence;
}

const hasAdvisory = (evidence: ReturnType<typeof evidenceAt>) => evidence.some((e) => e.label.startsWith('Wind Advisory'));

// The labelled alerts.
interface Label {
  n: number;
  group: string;
  startedAt: string;
  firedAt: string;
  peakAt: string;
  area: string;
  counties: string[];
}
const labels: Label[] = JSON.parse(fs.readFileSync('data/unexplained-alerts.json', 'utf8'));
const truth = labels.map((a) => {
  const start = Date.parse(a.startedAt);
  const fired = Date.parse(`${a.firedAt}Z`);
  const peak = Date.parse(a.peakAt);
  const last = Math.max(fired, peak) + AFTER;
  const metro = metros.find((m) => m.name === a.area)!.counties.map((c) => c.fips);
  return {
    ...a,
    fired,
    last,
    atFire: { gusts: gustsIn(a.counties, start - 3 * HOUR, fired - REPORT_LAG), metroGusts: gustsIn(metro, start - 3 * HOUR, fired - REPORT_LAG), start, advisory: hasAdvisory(evidenceAt(a.counties, start, fired, false)) },
    later: { gusts: gustsIn(a.counties, start - 3 * HOUR, last), metroGusts: gustsIn(metro, start - 3 * HOUR, last), start, advisory: hasAdvisory(evidenceAt(a.counties, start, peak, true)) },
    stationCount: a.counties.flatMap((f) => stations.get(f) ?? []).length,
  };
});
const weather = truth.filter((t) => t.group === 'weather');
const other = truth.filter((t) => t.group !== 'weather');

// Control: random places and hours. A match here is coincidence.
let seed = 20261101;
const random = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const control = Array.from({ length: CONTROLS }, () => {
  const metro = metros[Math.floor(random() * metros.length)];
  const fips = metro.counties.slice().sort((a, b) => b.population - a.population).slice(0, 3).map((c) => c.fips);
  const start = FIRST + Math.floor((random() * (LAST - FIRST)) / HOUR) * HOUR;
  const evidence = evidenceAt(fips, start, start, true);
  const metroGusts = gustsIn(metro.counties.map((c) => c.fips), start - 3 * HOUR, start + AFTER);
  return { metro: metro.name, fips, sample: { gusts: gustsIn(fips, start - 3 * HOUR, start + AFTER), metroGusts, start, advisory: hasAdvisory(evidence) }, strong: evidence.some((e) => e.strong), hasStation: fips.some((f) => stations.has(f)) };
});
console.error('control sampled');

// DOE reports that name a county, read one report at a time so all seven years aren't needed.
const reports: Report[] = JSON.parse(fs.readFileSync('data/doe417.json', 'utf8'));
const prior: Array<{ report: Report; strong: boolean; events: string[] }> = JSON.parse(fs.readFileSync(`${CACHE}/results.json`, 'utf8'));
const doe = [];
for (const [i, report] of reports.entries()) {
  const { states, fips } = parseArea(report.area);
  if (!fips.length) continue;
  const near = [...new Set(fips.flatMap((f) => stations.get(f) ?? []))].slice(0, 40);
  const known = prior.find((p) => p.report.date === report.date && p.report.area === report.area);
  if (!known) continue;
  const start = reportStart(report, states[0]);
  let gusts: Gust[] = [];
  if (near.length) {
    const from = new Date(start - DAY);
    const to = new Date(start + 2 * DAY);
    const range = `year1=${from.getUTCFullYear()}&month1=${from.getUTCMonth() + 1}&day1=${from.getUTCDate()}&year2=${to.getUTCFullYear()}&month2=${to.getUTCMonth() + 1}&day2=${to.getUTCDate()}`;
    const url = `${ASOS}?${near.map((s) => `station=${s}`).join('&')}&${COLUMNS}&${range}`;
    gusts = between(parseGusts(await cached(`${CACHE}/asos-doe-${i}.csv`, url)), start - 3 * HOUR, start + AFTER);
  }
  doe.push({ report, weather: isWeather(report.type), strong: known.strong, stationCount: near.length, sample: { gusts, metroGusts: gusts, start, advisory: known.events.includes('Wind Advisory') } });
}
const tested = doe.filter((d) => d.stationCount);
console.error(`DOE: ${doe.length} county reports, ${tested.length} with a station`);

const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : '-');
const margin = (n: number, d: number) => `±${((1.96 * Math.sqrt((n / d) * (1 - n / d) / d)) * 100).toFixed(1)}`;

const doeWeather = tested.filter((d) => d.weather);
const doeOther = tested.filter((d) => !d.weather);
const strongControl = control.filter((c) => c.strong).length;
console.log(`\nStations: ${sids.length} in ${[...metroFips].filter((f) => stations.has(f)).length} of ${metroFips.size} metro counties`);
console.log(`Labelled alerts with a station in an affected county: ${truth.filter((t) => t.stationCount).length} of ${truth.length}`);
console.log(`Control: ${CONTROLS} random metros and hours, ${control.filter((c) => c.hasStation).length} with a station. Storm checks alone match ${pct(strongControl, CONTROLS)}`);
console.log(`DOE county reports with a station: ${doeWeather.length} weather, ${doeOther.length} not. Storm checks match ${pct(doeWeather.filter((d) => d.strong).length, doeWeather.length)} and ${pct(doeOther.filter((d) => d.strong).length, doeOther.length)}\n`);

console.log('scope   field   mph  stn  adv  look   storms@fire  storms later  others@fire  others later  added by chance      DOE storms  DOE others');
const results = [];
for (const scope of ['county', 'metro'] as const) {
for (const field of ['mph', 'gust'] as const) {
  for (const beforeHours of [3, 1]) {
    for (const advisory of [false, true]) {
      for (const stationsNeeded of [1, 2]) {
        for (const mph of MPH) {
          const rule: Rule = { mph, stations: stationsNeeded, advisory, beforeHours, field, scope };
          const stormsAtFire = weather.filter((t) => matches(rule, t.atFire, t.fired - REPORT_LAG));
          const stormsLater = weather.filter((t) => matches(rule, t.later, t.last));
          const othersAtFire = other.filter((t) => matches(rule, t.atFire, t.fired - REPORT_LAG));
          const othersLater = other.filter((t) => matches(rule, t.later, t.last));
          const added = control.filter((c) => !c.strong && matches(rule, c.sample, c.sample.start + AFTER)).length;
          const doeStorms = doeWeather.filter((d) => matches(rule, d.sample, d.sample.start + AFTER));
          const doeAdded = doeStorms.filter((d) => !d.strong).length;
          const doeWrong = doeOther.filter((d) => matches(rule, d.sample, d.sample.start + AFTER));
          console.log(`${scope.padEnd(7)} ${field.padEnd(6)} ${String(mph).padStart(4)} ${String(stationsNeeded).padStart(4)}  ${advisory ? 'yes' : ' no'}  ${String(beforeHours).padStart(2)} h  ${`${stormsAtFire.length}/${weather.length}`.padStart(11)} ${`${stormsLater.length}/${weather.length}`.padStart(13)} ${`${othersAtFire.length}/${other.length}`.padStart(12)} ${`${othersLater.length}/${other.length}`.padStart(13)}  ${`${pct(added, CONTROLS)} ${margin(added, CONTROLS)}`.padStart(16)} ${`+${doeAdded}`.padStart(11)} ${`${doeWrong.length}/${doeOther.length}`.padStart(11)}`);
          results.push({ ...rule, stormsAtFire: stormsAtFire.map((t) => t.n), stormsLater: stormsLater.map((t) => t.n), othersAtFire: othersAtFire.map((t) => t.n), othersLater: othersLater.map((t) => t.n), added, doeAdded, doeWrong: doeWrong.map((d) => `${d.report.date} ${d.report.area.slice(0, 40)} ${d.report.type.slice(0, 30)}`) });
        }
      }
    }
  }
}
}

// Where a coincidence is most likely, for the rules worth considering.
for (const scope of ['county', 'metro'] as const) {
  const rule: Rule = { mph: 45, stations: 1, advisory: true, beforeHours: 3, field: 'mph', scope };
  const hits = new Map<string, number>();
  const tries = new Map<string, number>();
  for (const c of control) {
    tries.set(c.metro, (tries.get(c.metro) ?? 0) + 1);
    if (!c.strong && matches(rule, c.sample, c.sample.start + AFTER)) hits.set(c.metro, (hits.get(c.metro) ?? 0) + 1);
  }
  const worst = [...hits].map(([m, n]) => [m, n / tries.get(m)!] as const).sort((a, b) => b[1] - a[1]).slice(0, 6);
  console.log(`\nMost coincidences, advisory and 45 mph, ${scope}: ${worst.map(([m, r]) => `${m.split(',')[0].split('-')[0]} ${(r * 100).toFixed(1)}%`).join(', ')}`);
}

// Which stations those coincidences lean on. A ridge or desert station can be windy while
// the city it sits in the same county as is not.
const blamed = new Map<string, number>();
for (const c of control) {
  if (c.strong || !c.sample.advisory) continue;
  for (const sid of new Set(c.sample.metroGusts.filter((g) => g.mph >= 45).map((g) => g.sid))) blamed.set(sid, (blamed.get(sid) ?? 0) + 1);
}
const windy = [...bySid].map(([sid, list]) => [sid, windyDays(list)] as const).sort((a, b) => b[1] - a[1]);
console.log(`\nStations with the most days of 45+ mph, 2024 and 2025: ${windy.slice(0, 25).map(([s, n]) => `${s} ${n}`).join(', ')}`);
const median = windy[Math.floor(windy.length / 2)][1];
console.log(`Median station: ${median} days`);
console.log(`Stations most often behind a coincidence: ${[...blamed].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([s, n]) => `${s} ${n}`).join(', ')}`);

const advisoryAlone = control.filter((c) => !c.strong && c.sample.advisory).length;
console.log(`Wind Advisory alone would add ${pct(advisoryAlone, CONTROLS)} ${margin(advisoryAlone, CONTROLS)}`);

// A limit picked from these results can flatter them, so pick the stations from one year
// and score the other.
const SPLIT = Date.UTC(2025, 0, 1);
for (const [label, pickFrom, scoreOn] of [['2024 picks, 2025 scores', (t: number) => t < SPLIT, (t: number) => t >= SPLIT], ['2025 picks, 2024 scores', (t: number) => t >= SPLIT, (t: number) => t < SPLIT]] as const) {
  const skip = new Set([...bySid].filter(([, list]) => new Set(list.filter((g) => g.mph >= 45 && pickFrom(g.at)).map((g) => Math.floor(g.at / DAY))).size > 20).map(([sid]) => sid));
  const rule: Rule = { mph: 45, stations: 1, advisory: true, beforeHours: 3, field: 'mph', scope: 'metro' };
  const trimmed = (s: Sample): Sample => ({ ...s, metroGusts: s.metroGusts.filter((g) => !skip.has(g.sid)) });
  const held = control.filter((c) => scoreOn(c.sample.start));
  const hits = held.filter((c) => !c.strong && matches(rule, trimmed(c.sample), c.sample.start + AFTER)).length;
  const all = held.filter((c) => !c.strong && matches(rule, c.sample, c.sample.start + AFTER)).length;
  const storms = weather.filter((t) => scoreOn(t.atFire.start) && t.later.advisory);
  const caught = storms.filter((t) => matches(rule, trimmed(t.later), t.last)).length;
  console.log(`${label}: ${skip.size} stations ignored, added ${pct(hits, held.length)} ${margin(hits, held.length)} against ${pct(all, held.length)} with none ignored, advisory storms ${caught} of ${storms.length}`);
}

for (const limit of [15, 25, 40, 60]) {
  const skip = new Set(windy.filter(([, n]) => n > limit).map(([s]) => s));
  const calm = (list: Gust[]) => list.filter((g) => !skip.has(g.sid));
  const trimmed = (s: Sample): Sample => ({ ...s, gusts: calm(s.gusts), metroGusts: calm(s.metroGusts) });
  const rule: Rule = { mph: 45, stations: 1, advisory: true, beforeHours: 3, field: 'mph', scope: 'metro' };
  const added = control.filter((c) => !c.strong && matches(rule, trimmed(c.sample), c.sample.start + AFTER));
  const la = control.filter((c) => c.metro.startsWith('Los Angeles'));
  const laHits = added.filter((c) => c.metro.startsWith('Los Angeles')).length;
  const atFire = weather.filter((t) => matches(rule, trimmed(t.atFire), t.fired - REPORT_LAG)).map((t) => t.n);
  const later = weather.filter((t) => matches(rule, trimmed(t.later), t.last)).map((t) => t.n);
  console.log(`Ignoring ${String(skip.size).padStart(3)} stations over ${limit} windy days: added ${pct(added.length, CONTROLS)}, Los Angeles ${pct(laHits, la.length)}, storms at fire ${atFire.length} [${atFire}], later ${later.length} [${later}]`);
}

// The same questions through the production code and station list, so the build can't
// quietly differ from what was tested.
const wind = windStations as Record<string, string[]>;
const liveGusts = (cbsa: string | undefined, from: number, to: number) => (wind[cbsa ?? ''] ?? []).flatMap((id) => between(bySid.get(id.replace(/^K(?=.{3}$)/, '')) ?? [], from, to).map((g) => ({ station: id, at: g.at, mph: g.mph })));
function liveCheck(fips: string[], cbsa: string | undefined, start: number, moment: number, gustsUntil: number, withReports: boolean) {
  const weather = [...new Map(fips.flatMap((f) => warningsByCounty.get(f) ?? []).filter((a) => a.start <= moment && a.end >= start - DAY).map((a) => [a.id, a])).values()];
  const reports = withReports ? fips.flatMap((f) => reportsByCounty.get(f) ?? []).filter((r) => r.at >= start - DAY && r.at <= moment + DAY) : [];
  const stationSet = new Set(wind[cbsa ?? ''] ?? []);
  return assess({ fips: new Set(fips), points: [], stations: stationSet, start, end: moment }, { weather, reports, fires: [], quakes: [], kp: [], gusts: liveGusts(cbsa, start - 3 * HOUR, gustsUntil) }).evidence;
}
const isGust = (e: { kind: string; strong: boolean }) => e.kind === 'wind-gust' && e.strong;
const cbsaOf = (name: string) => metros.find((m) => m.name === name)!.cbsa;
const liveStopped = truth.filter((t) => liveCheck(t.counties, cbsaOf(t.area), t.atFire.start, t.fired, t.fired - REPORT_LAG, false).some(isGust));
const liveLater = truth.filter((t) => liveCheck(t.counties, cbsaOf(t.area), t.atFire.start, Date.parse(t.peakAt), t.last, true).some(isGust));
const liveAdded = control.filter((c) => !c.strong && liveCheck(c.fips, cbsaOf(c.metro), c.sample.start, c.sample.start, c.sample.start + AFTER, true).some(isGust)).length;
console.log(`\nProduction code: stopped before sending [${liveStopped.map((t) => t.n)}], explained by the end [${liveLater.map((t) => t.n)}], non-weather matched ${liveLater.filter((t) => t.group !== 'weather').length}, added by chance ${pct(liveAdded, CONTROLS)} ${margin(liveAdded, CONTROLS)}`);

// The highest reading behind each alert, so the choice of level can be seen directly.
console.log('\nHighest reading in an affected county, by alert');
for (const t of truth) {
  const best = (list: Gust[]) => list.reduce<Gust | null>((a, b) => (!a || b.mph > a.mph ? b : a), null);
  const show = (g: Gust | null) => (g ? `${Math.round(g.mph)} ${g.sid}` : '-');
  console.log(`${String(t.n).padStart(2)} ${t.group.padEnd(10)} ${t.area.split(',')[0].split('-')[0].padEnd(14)} stations ${String(t.stationCount).padStart(2)}  advisory ${t.later.advisory ? 'yes' : ' no'}  county at fire ${show(best(t.atFire.gusts)).padEnd(8)} later ${show(best(t.later.gusts)).padEnd(8)} metro at fire ${show(best(t.atFire.metroGusts)).padEnd(8)} later ${show(best(t.later.metroGusts))}`);
}

fs.writeFileSync(`${CACHE}/gust-results.json`, JSON.stringify({ results, control: control.map((c) => ({ metro: c.metro, strong: c.strong })) }));
