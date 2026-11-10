// Replay EAGLE-I, the federal record of outages by county every 15 minutes, through
// the real alert engine and cause checks to measure how often each high-priority
// alert would really have fired.
//
// usage: node scripts/backtest-eaglei.ts 2024 2025
// Needs datasets/eaglei/eaglei_outages_<year>.csv. See docs/DATA.md.
import fs from 'node:fs';
import { assess, type CauseArea } from '../lib/causes/assess.ts';
import type { StormReport, WeatherAlert } from '../lib/causes/feeds.ts';
import { alertBar } from '../lib/causes/rules.ts';
import { metros } from '../lib/registry.ts';
import { findSimultaneous } from '../lib/simultaneous.ts';
import type { Blackout, Evidence } from '../lib/types.ts';
import { loadYear, type Replayed, replay, settings, SINGLE_LEVELS, STEP } from './lib/eaglei.ts';
import { CACHE, cached, DAY, IEM, loadZones, parseWarnings, stormReportsFor } from './lib/warnings.ts';

const SETTLE = 10 * 60_000;

const years = process.argv.slice(2).map(Number);
const zones = await loadZones();

const warningsByCounty = new Map<string, WeatherAlert[]>();
const reportsByCounty = new Map<string, StormReport[]>();
const seen = new Set<string>();
const pad = (n: number) => String(n).padStart(2, '0');

async function loadWeather(from: number, to: number) {
  for (let day = from; day <= to; day += DAY) {
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
    for (const report of await stormReportsFor(day + 12 * 3_600_000)) {
      if (report.fips) reportsByCounty.set(report.fips, [...(reportsByCounty.get(report.fips) ?? []), report]);
    }
    if (d.getUTCDate() === 1) console.error(`weather loaded through ${name}`);
  }
}


function blackoutFrom(r: Replayed, evidence: Evidence[]): Blackout {
  const iso = new Date(r.startedAt).toISOString();
  return {
    id: `${r.key}:${iso}`, key: r.key, scope: 'metro', label: r.label, link: '', states: [], startedAt: iso, openedAt: iso, people: r.peakPeople, peakPeople: r.peakPeople, peakCustomers: r.peakCustomers,
    utilities: [], counties: r.counties, cause: evidence.some((e) => e.strong) ? 'explained' : 'unknown', evidence, checked: ['storm warnings'], utilityCauses: [],
  };
}

const results: any = {};
for (const year of years) {
  const data = await loadYear(year);
  const { records, surges } = replay(year, data);
  await loadWeather(Date.UTC(year, 0, 1) - 6 * DAY, Date.UTC(year + 1, 0, 1) - DAY);

  const atFire: Blackout[] = [];
  const final: Blackout[] = [];
  /** What the checks could have known at a given moment: warnings, but not yet storm reports. */
  const knownAt = (r: Replayed, moment: number) => {
    const area: CauseArea = { fips: new Set(r.counties), points: [], start: r.startedAt, end: moment };
    const alerts = [...new Map(r.counties.flatMap((f) => warningsByCounty.get(f) ?? []).filter((a) => a.start <= moment && a.end >= r.startedAt - DAY).map((a) => [a.id, a])).values()];
    return assess(area, { weather: alerts, reports: [], fires: [], quakes: [], kp: [], gusts: [] }).evidence;
  };
  const inTheEnd = (r: Replayed) => {
    const area: CauseArea = { fips: new Set(r.counties), points: [], start: r.startedAt, end: r.peakAt };
    const alerts = [...new Map(r.counties.flatMap((f) => warningsByCounty.get(f) ?? []).filter((a) => a.start <= r.peakAt + DAY && a.end >= r.startedAt - DAY).map((a) => [a.id, a])).values()];
    const reports = r.counties.flatMap((f) => reportsByCounty.get(f) ?? []).filter((x) => x.at >= r.startedAt - DAY && x.at <= r.peakAt + DAY);
    return assess(area, { weather: alerts, reports, fires: [], quakes: [], kp: [], gusts: [] }).evidence;
  };
  for (const r of [...records, ...surges]) {
    atFire.push(blackoutFrom(r, knownAt(r, r.startedAt + SETTLE)));
    final.push(blackoutFrom(r, inTheEnd(r)));
  }

  const days = (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / DAY;
  console.log(`\n=== ${year} ===`);
  console.log(`alerts at 10,000 people: ${records.length}, or ${(records.length / days).toFixed(1)} a day`);

  // The single-area alert fires when an area reaches the level, on what is known by then.
  console.log('\nSingle area: blackouts, then alerts sent, by level');
  console.log('customers   blackouts   warned   alerts   a month   stood down   left   wind advisory only');
  const single: any[] = [];
  for (const level of SINGLE_LEVELS) {
    const list = records.filter((r) => r.peakCustomers >= level);
    const fired = list.filter((r) => !knownAt(r, Math.max(r.startedAt + SETTLE, r.crossedAt[level] ?? r.peakAt)).some((e) => e.strong));
    const left = fired.filter((r) => !inTheEnd(r).some((e) => e.strong));
    const windOnly = left.filter((r) => inTheEnd(r).some((e) => e.label.startsWith('Wind Advisory')));
    console.log(`${String(level).padStart(9)} ${String(list.length).padStart(11)} ${String(list.length - fired.length).padStart(8)} ${String(fired.length).padStart(8)} ${(fired.length / 12).toFixed(1).padStart(9)} ${String(fired.length - left.length).padStart(12)} ${String(left.length).padStart(6)} ${String(windOnly.length).padStart(20)}`);
    single.push({ level, blackouts: list.length, fired: fired.length, left: left.length, windOnly: windOnly.length, unexplained: left.map((r) => ({ at: new Date(r.startedAt).toISOString(), peakAt: new Date(r.peakAt).toISOString(), area: r.label, customers: r.peakCustomers, noted: inTheEnd(r).map((e) => e.label) })) });
  }
  // Each area at its own level, as production runs it.
  const barOf = (r: Replayed) => alertBar(r, settings.unexplainedCustomers);
  const sent = records.filter((r) => barOf(r) > 0 && !knownAt(r, Math.max(r.startedAt + SETTLE, r.crossedAt[barOf(r)] ?? r.peakAt)).some((e) => e.strong));
  const sentLeft = sent.filter((r) => !inTheEnd(r).some((e) => e.strong));
  console.log(`\nAs configured: ${sent.length} alerts, ${(sent.length / 12).toFixed(1)} a month, ${sent.length - sentLeft.length} stood down, ${sentLeft.length} left`);

  const atLevel = single.find((s) => s.level === settings.unexplainedCustomers);
  const byMetro = new Map<string, number>();
  for (const u of atLevel.unexplained) byMetro.set(u.area, (byMetro.get(u.area) ?? 0) + 1);
  console.log(`\nMost often unexplained at ${settings.unexplainedCustomers.toLocaleString('en-US')}+: ${[...byMetro].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([m, n]) => `${m.split(',')[0].split('-')[0]} ${n}`).join(', ')}`);
  console.log('Largest never explained:');
  for (const u of atLevel.unexplained.slice().sort((a: any, b: any) => b.customers - a.customers).slice(0, 16)) console.log(`  ${u.at.slice(0, 16)} peak ${u.peakAt.slice(5, 16)} ${String(Math.round(u.customers)).padStart(8)}  ${u.area.slice(0, 40).padEnd(40)} [${u.noted.map((n: string) => n.split(',')[0]).join('; ')}]`);

  // Synthetic attacks at random moments in real history. What stops one being caught is
  // the weather that happened to be around, or an alert already open in that metro.
  let seed = 7_771 + year;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const weights = metros.map((m) => m.population);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const pick = () => {
    let r = random() * totalWeight;
    return metros.find((_, i) => (r -= weights[i]) <= 0) ?? metros[0];
  };
  const openAt = new Map<string, Replayed[]>();
  for (const r of records) openAt.set(r.key, [...(openAt.get(r.key) ?? []), r]);
  const TRIALS = 2_000;
  const hit = { strict: [0, 0, 0], strongOnly: [0, 0, 0] };
  let busy = 0;
  let areas = 0;
  let contextBlocked = 0;
  for (let trial = 0; trial < TRIALS; trial++) {
    const t = data.start + Math.floor(random() * data.steps) * STEP;
    const chosen = new Map<string, (typeof metros)[number]>();
    while (chosen.size < 5) {
      const m = pick();
      chosen.set(m.cbsa, m);
    }
    let strict = 0;
    let strongOnly = 0;
    let seen = 0;
    const tallies: Array<[number, number]> = [];
    for (const m of chosen.values()) {
      seen++;
      const counties = m.counties.slice().sort((a, b) => b.population - a.population).slice(0, 3).map((c) => c.fips);
      const area: CauseArea = { fips: new Set(counties), points: [], start: t, end: t + SETTLE };
      const alerts = [...new Map(counties.flatMap((f) => warningsByCounty.get(f) ?? []).filter((a) => a.start <= t + SETTLE && a.end >= t - DAY).map((a) => [a.id, a])).values()];
      const evidence = assess(area, { weather: alerts, reports: [], fires: [], quakes: [], kp: [], gusts: [] }).evidence;
      const isBusy = (openAt.get(`metro:${m.cbsa}`) ?? []).some((r) => r.startedAt < t - 30 * 60_000 && r.endedAt > t);
      // A jump inside an open alert now counts as a start, so being busy is no longer a miss.
      const clear = !evidence.some((e) => e.strong);
      if (seen <= 3) {
        areas++;
        if (isBusy) busy++;
        if (clear && evidence.length) contextBlocked++;
      }
      if (clear) strongOnly++;
      if (clear && !evidence.length) strict++;
      tallies.push([strict, strongOnly]);
    }
    for (const [i, hitAreas] of [3, 4, 5].entries()) {
      if (tallies[hitAreas - 1][0] >= 3) hit.strict[i]++;
      if (tallies[hitAreas - 1][1] >= 3) hit.strongOnly[i]++;
    }
  }
  const share = (n: number) => `${Math.round((n / TRIALS) * 100)}%`;
  console.log(`\nSynthetic attacks caught (${TRIALS} random moments, population-weighted metros)`);
  console.log('areas hit   any weather rules an area out   only strong evidence does');
  [3, 4, 5].forEach((n, i) => console.log(`${String(n).padStart(9)} ${share(hit.strict[i]).padStart(31)} ${share(hit.strongOnly[i]).padStart(27)}`));
  console.log(`Of each metro at a random moment: ${Math.round((busy / areas) * 100)}% already had an alert open, ${Math.round((contextBlocked / areas) * 100)}% had weather context only`);

  console.log('\nSimultaneous outage if only strong evidence rules an area out');
  console.log('customers per area   areas   alerts   stood down   left');
  const strongOnlyList = atFire.map((b) => ({ ...b, evidence: b.evidence.filter((e) => e.strong) }));
  const strongFinal = final.map((b) => ({ ...b, evidence: b.evidence.filter((e) => e.strong) }));
  for (const simultaneousCustomers of [7_500, 10_000, 15_000]) {
    for (const simultaneousAreas of [3, 4]) {
      const s = { ...settings, simultaneousCustomers, simultaneousAreas };
      const first = findSimultaneous([], strongOnlyList, s, new Date().toISOString());
      const later = findSimultaneous(first.list, strongFinal, s, new Date().toISOString());
      const down = later.events.filter((e) => e.kind === 'simultaneous-explained').length;
      console.log(`${String(simultaneousCustomers).padStart(18)} ${String(simultaneousAreas).padStart(7)} ${String(first.events.length).padStart(8)} ${String(down).padStart(12)} ${String(first.events.length - down).padStart(6)}`);
      if (simultaneousCustomers === settings.simultaneousCustomers && simultaneousAreas === settings.simultaneousAreas) for (const e of first.events) console.log(`    ${e.openedAt.slice(0, 16)} ${String(Math.round(e.customers)).padStart(8)} ${e.label}`);
    }
  }

  console.log('\nSimultaneous outage: groups that would alert, then how many survive stand-down');
  console.log('customers per area   areas   alerts   stood down   left');
  const grid: any[] = [];
  for (const simultaneousCustomers of [5_000, 7_500, 10_000, 15_000, 20_000, 25_000]) {
    for (const simultaneousAreas of [2, 3, 4]) {
      const s = { ...settings, simultaneousCustomers, simultaneousAreas };
      const first = findSimultaneous([], atFire, s, new Date().toISOString());
      const later = findSimultaneous(first.list, final, s, new Date().toISOString());
      const down = later.events.filter((e) => e.kind === 'simultaneous-explained').length;
      console.log(`${String(simultaneousCustomers).padStart(18)} ${String(simultaneousAreas).padStart(7)} ${String(first.events.length).padStart(8)} ${String(down).padStart(12)} ${String(first.events.length - down).padStart(6)}`);
      grid.push({ simultaneousCustomers, simultaneousAreas, alerts: first.events.length, down, events: first.events.map((e) => ({ at: e.openedAt, label: e.label, customers: e.customers })) });
    }
  }
  const chosen = grid.find((g) => g.simultaneousCustomers === settings.simultaneousCustomers && g.simultaneousAreas === settings.simultaneousAreas);
  console.log(`\nGroups at the current levels (${chosen.alerts}):`);
  for (const e of chosen.events) console.log(`  ${e.at.slice(0, 16)}  ${String(Math.round(e.customers)).padStart(8)}  ${e.label}`);

  results[year] = { records: records.length, grid, single };
}
fs.writeFileSync(`${CACHE}/eaglei-results.json`, JSON.stringify(results, null, 1));
