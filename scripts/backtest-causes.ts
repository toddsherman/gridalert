// Test the storm check against DOE's record of large outages. For every report in
// data/doe417.json, replay the warnings in force at the time (from Iowa State's
// archive) through the same code production uses, and compare with DOE's cause.
//
//   DOE said weather, check found nothing -> a storm we would wrongly call unknown
//   DOE said not weather, check matched   -> a real mystery we would wrongly explain
//
// usage: node scripts/backtest-causes.ts
// Downloads are cached in .cache/backtest, so reruns are quick.
import fs from 'node:fs';
import geo from '../data/geo.json' with { type: 'json' };
import { assess, type CauseArea } from '../lib/causes/assess.ts';
import type { StormReport, WeatherAlert, World } from '../lib/causes/feeds.ts';
import { CONTEXT_EVENTS, EXPLAINING_EVENTS, SIMULTANEOUS_WINDOW_MS, WEATHER_AFTER_MS, WEATHER_BEFORE_MS } from '../lib/causes/rules.ts';
import { metros } from '../lib/registry.ts';
import { isWeather, parseArea, type Report, reportStart } from './lib/doe.ts';
import { CACHE, cached, DAY, HOUR, IEM, loadZones, parseWarnings, stormReportsFor, type Zones } from './lib/warnings.ts';

const CONTROLS = 250;

const index = geo.index as Record<string, string>;
const stateCounties = new Map<string, string[]>();
for (const [key, fips] of Object.entries(index)) {
  const st = key.split('|')[0];
  stateCounties.set(st, [...(stateCounties.get(st) ?? []), fips]);
}

const urlPart = (d: Date, n: 1 | 2) => `year${n}=${d.getUTCFullYear()}&month${n}=${d.getUTCMonth() + 1}&day${n}=${d.getUTCDate()}&hour${n}=0&minute${n}=0`;

async function warningsBetween(state: string, date: string, fromDays: number, toDays: number, tag: string, zones: Zones): Promise<WeatherAlert[]> {
  const day = Date.parse(`${date}T00:00:00Z`);
  const url = `${IEM}?${urlPart(new Date(day + fromDays * DAY), 1)}&${urlPart(new Date(day + toDays * DAY), 2)}&accept=csv&location_group=states&states=${state}`;
  return parseWarnings(await cached(`${CACHE}/${state}-${date}${tag}.csv`, url), zones);
}

/** Winter storm warnings can be issued days ahead, and the archive filters on issue time. */
const warningsFor = (state: string, date: string, zones: Zones) => warningsBetween(state, date, -1, 2, '', zones);
const earlierWarningsFor = (state: string, date: string, zones: Zones) => warningsBetween(state, date, -5, -1, '-early', zones);

async function stormReportsAround(date: string): Promise<StormReport[]> {
  const day = Date.parse(`${date}T12:00:00Z`);
  return [...(await stormReportsFor(day - DAY)), ...(await stormReportsFor(day))];
}

const zones = await loadZones();
const reports: Report[] = JSON.parse(fs.readFileSync('data/doe417.json', 'utf8'));

interface Row {
  report: Report;
  weather: boolean;
  precise: boolean;
  strong: boolean;
  context: boolean;
  /** Hours from the start to the nearest explaining warning, zero if one was in force. */
  gap: number;
  /** Minutes from the start until the first matching warning existed. Negative if before. */
  knownAfter: number | null;
  start: number;
  events: string[];
}

const rows: Row[] = [];
const skipped: string[] = [];
let done = 0;
for (const report of reports) {
  done++;
  if (done % 50 === 0) console.error(`${done} of ${reports.length}`);
  const { states, fips } = parseArea(report.area);
  if (!states.length) {
    skipped.push(report.area);
    continue;
  }
  const alerts = (await Promise.all(states.map((st) => warningsFor(st, report.date, zones)))).flat();
  const counties = fips.length ? fips : states.flatMap((st) => stateCounties.get(st) ?? []);
  const start = reportStart(report, states[0]);
  const area: CauseArea = { fips: new Set(counties), points: [], start };
  let world: World = { weather: alerts, reports: [], fires: [], quakes: [], kp: [], gusts: [] };
  let { evidence } = assess(area, world);
  // Extra downloads can only add matches, so they're only made where one is missing.
  if (!evidence.some((e) => e.strong)) {
    alerts.push(...(await Promise.all(states.map((st) => earlierWarningsFor(st, report.date, zones)))).flat());
    world = { ...world, weather: alerts, reports: await stormReportsAround(report.date) };
    ({ evidence } = assess(area, world));
  }

  let gap = Infinity;
  for (const a of alerts) {
    if (!EXPLAINING_EVENTS.has(a.event) || !a.fips.some((f) => area.fips.has(f))) continue;
    gap = Math.min(gap, start >= a.start && start <= a.end ? 0 : Math.min(Math.abs(start - a.start), Math.abs(start - a.end)) / HOUR);
  }
  const matching = alerts.filter((a) => EXPLAINING_EVENTS.has(a.event) && a.fips.some((f) => area.fips.has(f)) && a.start <= start + WEATHER_AFTER_MS && a.end >= start - WEATHER_BEFORE_MS);
  const knownAfter = matching.length ? Math.min(...matching.map((a) => (a.start - start) / 60_000)) : null;
  rows.push({
    report,
    start,
    knownAfter,
    weather: isWeather(report.type),
    precise: fips.length > 0,
    strong: evidence.some((e) => e.strong),
    context: evidence.some((e) => !e.strong),
    gap,
    events: evidence.map((e) => e.label.split(',')[0]),
  });
}

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '-');
const line = (label: string, list: Row[]) => {
  const strong = list.filter((r) => r.strong).length;
  const either = list.filter((r) => r.strong || r.context).length;
  console.log(`${label.padEnd(36)} ${String(list.length).padStart(5)}  matched ${pct(strong, list.length).padStart(4)}  with context ${pct(either, list.length).padStart(4)}`);
};

console.log(`\n${rows.length} reports tested, ${skipped.length} with no usable area\n`);
for (const [label, precise] of [['County named', true], ['State only', false]] as const) {
  console.log(label);
  line('  DOE said weather', rows.filter((r) => r.precise === precise && r.weather));
  line('  DOE said something else', rows.filter((r) => r.precise === precise && !r.weather));
}

console.log('\nWeather reports matched at wider windows (county named)');
const precise = rows.filter((r) => r.precise && r.weather);
for (const hours of [0, 1, 2, 3, 6, 12]) console.log(`  within ${String(hours).padStart(2)} h: ${pct(precise.filter((r) => r.gap <= hours).length, precise.length)}`);

console.log('\nNot-weather reports matched at wider windows (county named)');
const others = rows.filter((r) => r.precise && !r.weather);
for (const hours of [0, 1, 2, 3, 6, 12]) console.log(`  within ${String(hours).padStart(2)} h: ${pct(others.filter((r) => r.gap <= hours).length, others.length)}`);

// How long an alert must wait before "no warning found" means anything.
console.log('\nWeather reports with a warning already issued (county named)');
for (const minutes of [0, 5, 10, 15, 30, 60, 120]) console.log(`  ${String(minutes).padStart(3)} min after the start: ${pct(precise.filter((r) => r.knownAfter !== null && r.knownAfter <= minutes).length, precise.length)}`);

// Three or more large reports in different places starting within 30 minutes. At this
// size, how often does the simultaneous-outage signal come up with no storm behind it?
const simultaneous = (list: Row[]) => {
  const sorted = list.slice().sort((a, b) => a.start - b.start);
  let groups = 0;
  for (let i = 0; i < sorted.length; ) {
    const group = sorted.filter((r) => r.start >= sorted[i].start && r.start - sorted[i].start <= SIMULTANEOUS_WINDOW_MS);
    if (new Set(group.map((r) => r.report.area)).size >= 3) {
      groups++;
      i += group.length;
    } else i++;
  }
  return groups;
};
console.log(`\nThree or more reports within 30 minutes: ${simultaneous(rows)} in all, ${simultaneous(rows.filter((r) => !r.strong))} with no storm matched`);

const unmatched = rows.filter((r) => r.weather && r.precise && !r.strong);
const contextCounts = new Map<string, number>();
for (const r of unmatched) for (const e of r.events) contextCounts.set(e, (contextCounts.get(e) ?? 0) + 1);
console.log(`\nContext products present on unmatched weather reports (${unmatched.length}):`);
console.log([...contextCounts].sort((a, b) => b[1] - a[1]).map(([e, n]) => `${e} ${n}`).join(', '));
console.log(`\nContext list has ${CONTEXT_EVENTS.size} products; nothing at all on ${unmatched.filter((r) => !r.events.length).length} of those reports.`);

console.log('\nWrongly explained (DOE said not weather, county named, check matched):');
for (const r of rows.filter((x) => !x.weather && x.precise && x.strong)) console.log(`  ${r.report.date} ${r.report.area.slice(0, 40).padEnd(40)} ${String(r.report.customers).padStart(8)}  ${r.report.type.slice(0, 40)}  [${r.events.join('; ')}]`);

console.log('\nSample of weather reports the check missed:');
for (const r of unmatched.slice(0, 25)) console.log(`  ${r.report.date} ${r.report.time} ${r.report.area.slice(0, 40).padEnd(40)} ${String(r.report.customers).padStart(8)}  nearest ${r.gap === Infinity ? 'none' : `${r.gap.toFixed(1)} h`}  [${r.events.join('; ')}]`);

// Control: random large-metro counties at random hours, which is what a blackout with
// nothing to do with weather would look like. A match here is pure coincidence, so
// this is how often the check would wrongly explain away a real mystery.
let seed = 20261101;
const random = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const firstDay = Date.UTC(2019, 0, 1);
const lastDay = Date.UTC(2025, 11, 31);
const controlEvents = new Map<string, number>();
let coincidental = 0;
let withWindAdvisory = 0;
for (let i = 0; i < CONTROLS; i++) {
  if (i % 50 === 0) console.error(`control ${i} of ${CONTROLS}`);
  const metro = metros[Math.floor(random() * metros.length)];
  const counties = metro.counties.slice().sort((a, b) => b.population - a.population).slice(0, 3);
  const start = firstDay + Math.floor((random() * (lastDay - firstDay)) / HOUR) * HOUR;
  const date = new Date(start).toISOString().slice(0, 10);
  const state = counties[0].state;
  const alerts = [...(await warningsFor(state, date, zones)), ...(await earlierWarningsFor(state, date, zones))];
  const area: CauseArea = { fips: new Set(counties.map((c) => c.fips)), points: [], start };
  const { evidence } = assess(area, { weather: alerts, reports: await stormReportsAround(date), fires: [], quakes: [], kp: [], gusts: [] });
  const strong = evidence.some((e) => e.strong);
  const wind = evidence.some((e) => e.label.startsWith('Wind Advisory'));
  if (strong) coincidental++;
  if (strong || wind) withWindAdvisory++;
  for (const e of evidence.filter((x) => x.strong)) {
    const name = e.label.split(',')[0].replace(/ reported near.*/, ' report');
    controlEvents.set(name, (controlEvents.get(name) ?? 0) + 1);
  }
}
console.log(`\nControl: ${CONTROLS} random county groups and hours`);
console.log(`  matched by chance: ${pct(coincidental, CONTROLS)}  (${coincidental})`);
console.log(`  if Wind Advisory counted: ${pct(withWindAdvisory, CONTROLS)}  (${withWindAdvisory})`);
console.log(`  by product: ${[...controlEvents].sort((a, b) => b[1] - a[1]).map(([e, n]) => `${e} ${n}`).join(', ')}`);

const windRecall = rows.filter((r) => r.precise && r.weather && (r.strong || r.events.includes('Wind Advisory'))).length;
console.log(`\nIf Wind Advisory counted, weather reports matched (county named): ${pct(windRecall, precise.length)}`);

fs.writeFileSync(`${CACHE}/results.json`, JSON.stringify(rows, null, 1));
