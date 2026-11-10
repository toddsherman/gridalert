// Replay the blackouts EAGLE-I recorded through the production code to measure what
// waiting for a count to move costs and saves, against the labels in
// data/unexplained-alerts.json.
//
// usage: node scripts/backtest-feed-quality.ts
// Needs datasets/eaglei/. Run scripts/backtest-eaglei.ts first for the simultaneous groups.
import fs from 'node:fs';
import labels from '../data/unexplained-alerts.json' with { type: 'json' };
import { syncBlackouts, takeNotices } from '../lib/blackouts.ts';
import { alertBar, heldBack } from '../lib/causes/rules.ts';
import { shortMetro } from '../lib/format.ts';
import { metroByCbsa } from '../lib/registry.ts';
import { type Blackout, DEFAULT_SETTINGS, EMPTY_ENGINE, type Settings, type Snapshot } from '../lib/types.ts';
import { loadYear, type Replayed, replay, STEP } from './lib/eaglei.ts';
import { CACHE } from './lib/warnings.ts';

const SETTLE_STEPS = 1;
/** Four days, since a blackout can start small and jump much later. */
const LONGEST_STEPS = 384;
const FALSE_GROUPS = new Set(['no-record', 'distorted']);
const settings: Settings = DEFAULT_SETTINGS;
type Year = Awaited<ReturnType<typeof loadYear>>;

const labelOf = (r: Replayed) => labels.find((a) => a.area === r.label && Math.abs(Date.parse(a.startedAt) - r.startedAt) < 3 * 3_600_000);

function snapshotAt(data: Year, r: Replayed, t: number) {
  const cbsa = r.key.slice(6);
  const counties = metroByCbsa.get(cbsa)!.counties.map((c) => ({ fips: c.fips, name: c.fips, customersOut: data.counties.get(c.fips)?.[t] ?? 0 })).filter((c) => c.customersOut > 0).sort((a, b) => b.customersOut - a.customersOut);
  const customersOut = counties.reduce((sum, c) => sum + c.customersOut, 0);
  const metro = { cbsa, name: r.label, states: [], population: 0, customersOut, estimatedPeople: customersOut * settings.peoplePerCustomer, utilities: [], counties: counties.slice(0, 12), coverage: 1, gaps: [] };
  return { snapshot: { metros: [metro], utilities: [] } as unknown as Snapshot, customersOut };
}

/** Each poll of one blackout through the production code, until `visit` has its answer. */
function walk<T>(data: Year, r: Replayed, visit: (list: Blackout[], step: number, at: string, customers: number) => { list?: Blackout[]; done?: T }): T | null {
  const first = Math.round((r.startedAt - data.start) / STEP);
  const iso = new Date(r.startedAt).toISOString();
  const a = { key: r.key, scope: 'metro' as const, label: r.label, openedAt: iso, startedAt: iso, lastSeenAt: iso, people: 0, peakPeople: 0, notifiedPeople: 0, belowPolls: 0 };
  let list: Blackout[] = [];
  for (let step = 0; step < LONGEST_STEPS; step++) {
    const t = first + step;
    if (t >= data.steps || data.start + t * STEP > r.endedAt) return null;
    const at = new Date(data.start + t * STEP).toISOString();
    const { snapshot, customersOut } = snapshotAt(data, r, t);
    a.people = customersOut * settings.peoplePerCustomer;
    a.peakPeople = Math.max(a.peakPeople, a.people);
    list = syncBlackouts(list, { ...EMPTY_ENGINE, open: { [r.key]: a } }, snapshot, settings.peoplePerCustomer, at);
    const seen = visit(list, step, at, customersOut);
    if (seen.done !== undefined) return seen.done;
    list = seen.list ?? list;
  }
  return null;
}

/** When the high-priority alert would go out. */
function firing(data: Year, r: Replayed, hold: boolean) {
  return walk(data, r, (list, step, at) => {
    const judged = list.map((b) => ({ ...b, jumpCustomers: r.jumpCustomers, cause: step >= SETTLE_STEPS ? ('unknown' as const) : ('checking' as const), checked: ['storm warnings' as const], reading: hold ? b.reading : undefined }));
    const { list: next, events } = takeNotices(judged, settings, at);
    if (events.length) return { done: { step, warned: /false reading/.test(events[0].detail) } };
    return { list: list.map((b, i) => ({ ...b, unexplainedNoticeAt: next[i].unexplainedNoticeAt })) };
  });
}

/** Minutes a count keeps an area out of a simultaneous group, or null if it goes first. */
function simultaneousWait(data: Year, r: Replayed) {
  let reached = -1;
  return walk(data, r, (list, step, at, customers) => {
    if (customers < settings.simultaneousCustomers) return {};
    if (reached < 0) reached = step;
    return !heldBack(list[0].reading, settings.simultaneousCustomers, Date.parse(at)) ? { done: (step - reached) * 15 } : {};
  });
}

interface Row { n?: number; group: string; year: number; area: string; at: string; peak: number; sent: 'as-before' | 'later' | 'limit' | 'never'; delay: number }
const rows: Row[] = [];
const areas: Array<{ label: string; at: number; wait: number | null }> = [];

for (const year of [2024, 2025]) {
  const data = await loadYear(year);
  const { records } = replay(year, data);
  for (const r of records) {
    if (r.peakCustomers >= settings.simultaneousCustomers) areas.push({ label: r.label, at: r.startedAt, wait: simultaneousWait(data, r) });
    if (!alertBar(r, settings.unexplainedCustomers)) continue;
    const before = firing(data, r, false);
    if (!before) continue;
    const after = firing(data, r, true);
    const label = labelOf(r);
    const delay = after ? (after.step - before.step) * 15 : 0;
    rows.push({ n: label?.n, group: label?.group ?? 'explained', year, area: shortMetro(r.label), at: new Date(r.startedAt).toISOString().slice(0, 16), peak: Math.round(r.peakCustomers), sent: !after ? 'never' : after.warned ? 'limit' : delay ? 'later' : 'as-before', delay });
  }
}

const count = (list: Row[], sent: Row['sent'], test: (r: Row) => boolean = () => true) => list.filter((r) => r.sent === sent && test(r)).length;
console.log('\nHigh-priority alert, one 15-minute sample being one feed refresh here');
console.log('group        alerts  at once  +15   +30-60  at limit, warned  never');
for (const group of ['no-record', 'distorted', 'unknown', 'equipment', 'deliberate', 'weather', 'explained']) {
  const list = rows.filter((r) => r.group === group);
  console.log(`${group.padEnd(12)} ${String(list.length).padStart(6)} ${String(count(list, 'as-before')).padStart(8)} ${String(count(list, 'later', (r) => r.delay === 15)).padStart(4)} ${String(count(list, 'later', (r) => r.delay > 15)).padStart(8)} ${String(count(list, 'limit')).padStart(17)} ${String(count(list, 'never')).padStart(6)}`);
}
for (const year of [2024, 2025]) {
  const labelled = rows.filter((r) => r.n && r.year === year);
  const bad = labelled.filter((r) => FALSE_GROUPS.has(r.group));
  const real = labelled.filter((r) => !FALSE_GROUPS.has(r.group));
  console.log(`${year}: ${bad.length} false or distorted: ${count(bad, 'never')} never sent, ${count(bad, 'limit')} warned. ${real.length} others: ${count(real, 'never')} never sent, ${count(real, 'limit')} warned, ${real.filter((r) => r.delay > 15).length} over 15 minutes late`);
}
console.log('\nLabelled alerts changed by more than a sample:');
for (const r of rows.filter((x) => x.n).sort((a, b) => a.n! - b.n!)) if (r.sent === 'never' || r.sent === 'limit' || r.delay > 15) console.log(`${String(r.n).padStart(3)} ${r.group.padEnd(10)} ${r.at} ${r.area.padEnd(24)} ${String(r.peak).padStart(7)} ${r.sent} ${r.delay ? `+${r.delay}` : ''}`);
console.log('\nOther real blackouts changed by more than a sample:');
for (const r of rows.filter((x) => !x.n && (x.sent === 'never' || x.sent === 'limit' || x.delay > 15))) console.log(`    ${r.at} ${r.area.padEnd(24)} ${String(r.peak).padStart(7)} ${r.sent} ${r.delay ? `+${r.delay}` : ''}`);

const waits = areas.map((a) => a.wait);
const within = (limit: number) => waits.filter((w) => w !== null && w <= limit).length;
console.log(`\nAreas reaching ${settings.simultaneousCustomers.toLocaleString('en-US')} customers: ${areas.length}. Free to count within 15 minutes ${within(15)}, 30 ${within(30)}, 60 ${within(60)}, gone first ${waits.filter((w) => w === null).length}`);
const results = JSON.parse(fs.readFileSync(`${CACHE}/eaglei-results.json`, 'utf8'));
console.log('Simultaneous alerts in the replay, and what the wait does to each area:');
for (const year of [2024, 2025]) {
  const groups = results[year].grid.find((g: any) => g.simultaneousCustomers === settings.simultaneousCustomers && g.simultaneousAreas === settings.simultaneousAreas).events;
  for (const g of groups) {
    const start = Date.parse(g.at);
    const members = areas.filter((m) => g.label.includes(shortMetro(m.label)) && Math.abs(m.at - start) <= 45 * 60_000);
    console.log(`  ${g.at.slice(0, 16)} ${g.label}: ${members.map((m) => `${shortMetro(m.label)} ${m.wait === null ? 'gone first' : `+${m.wait}`}`).join(', ')}`);
  }
}
