// Test whether a blackout shows as a dip in its state's reachable networks, from IODA.
// See docs/CAUSE_CHECKS.md.
//
// usage: node scripts/backtest-internet.ts
// Takes about 15 minutes at a polite pace. Results are kept in .cache/backtest.
import fs from 'node:fs';
import labels from '../data/unexplained-alerts.json' with { type: 'json' };
import { CACHE } from './lib/warnings.ts';

const IODA = 'https://api.ioda.inetintel.cc.gatech.edu/v2';
const RESULTS = `${CACHE}/ioda-results.json`;
const HOUR_S = 3_600;
const BEFORE_S = 24 * HOUR_S;
const AFTER_S = 3 * HOUR_S;
/** Ten-minute samples: three hours of baseline, and the hour after a start. */
const BASELINE_SAMPLES = 18;
const AFTER_SAMPLES = 7;
const CONTROL_HOURS = 300;
const PAUSE_MS = 500;
const CLEAR_DIP = 4;
const LARGE_FOR_STATE = 9;
const FROM = Date.UTC(2024, 0, 10);
const TO = Date.UTC(2025, 11, 25);
const REAL_GROUPS = ['weather', 'equipment', 'deliberate', 'unknown'];
const STATES: Record<string, string> = { PA: 'Pennsylvania', MI: 'Michigan', NY: 'New York', GA: 'Georgia', WA: 'Washington', NC: 'North Carolina', AK: 'Alaska', IN: 'Indiana', CA: 'California', FL: 'Florida', CO: 'Colorado', LA: 'Louisiana', TN: 'Tennessee', RI: 'Rhode Island', NE: 'Nebraska', OR: 'Oregon' };

const pause = () => new Promise((r) => setTimeout(r, PAUSE_MS));
const median = (values: number[]) => values.slice().sort((a, b) => a - b)[values.length >> 1];

async function get(path: string) {
  const res = await fetch(`${IODA}${path}`, { signal: AbortSignal.timeout(30_000) });
  await pause();
  if (!res.ok) throw new Error(`IODA ${res.status}`);
  return res.json();
}

async function regionCode(name: string): Promise<string | undefined> {
  const { data } = await get(`/entities/query?entityType=region&search=${encodeURIComponent(name)}&limit=20`);
  return data.find((e: { name: string; attrs: { country_code: string } }) => e.name === name && e.attrs.country_code === 'US')?.code;
}

/** How far the hour after a start fell below the three hours before, in units of normal noise. */
async function dip(code: string, startMs: number) {
  const start = Math.floor(startMs / 1000);
  const { data } = await get(`/signals/raw/region/${code}?from=${start - BEFORE_S}&until=${start + AFTER_S}&datasource=ping-slash24`);
  const signal = data.flat().find((s: { datasource: string }) => s.datasource === 'ping-slash24');
  if (!signal?.values?.length) return null;
  const values: Array<number | null> = signal.values;
  const known = (list: Array<number | null>) => list.filter((v): v is number => v !== null);
  const at = Math.round((start - signal.from) / signal.step);
  const before = known(values.slice(Math.max(0, at - BASELINE_SAMPLES), at));
  const after = known(values.slice(at, at + AFTER_SAMPLES));
  const residuals = values.slice(BASELINE_SAMPLES, at).flatMap((v, i) => {
    const past = known(values.slice(i, i + BASELINE_SAMPLES));
    return v !== null && past.length ? [Math.abs(v - median(past))] : [];
  });
  if (!before.length || !after.length || !residuals.length) return null;
  return { blocks: median(before), z: (median(before) - Math.min(...after)) / (median(residuals) * 1.4826) };
}

async function run() {
  const codes = Object.fromEntries(await Promise.all(Object.entries(STATES).map(async ([abbr, name]) => [abbr, await regionCode(name)])));
  const stateOf = (area: string) => (area.startsWith('Chicago') ? 'IN' : area.startsWith('Portland') ? 'OR' : area.split(', ').at(-1)!.split('-')[0]);
  const alerts = [];
  for (const a of labels) {
    const code = codes[stateOf(a.area)];
    const found = code ? await dip(code, Date.parse(a.startedAt)) : null;
    if (found) alerts.push({ n: a.n, group: a.group, area: a.area, customers: a.peakCustomers, ...found });
  }
  let seed = 4242;
  const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const used = Object.values(codes).filter((c): c is string => Boolean(c));
  const control = [];
  for (let i = 0; i < CONTROL_HOURS; i++) {
    const found = await dip(used[i % used.length], FROM + Math.floor(random() * (TO - FROM)));
    if (found) control.push(found);
  }
  return { alerts, control };
}

const { alerts, control } = fs.existsSync(RESULTS) ? JSON.parse(fs.readFileSync(RESULTS, 'utf8')) : await run();
fs.writeFileSync(RESULTS, JSON.stringify({ alerts, control }));

const clear = (list: Array<{ z: number }>) => `${list.filter((r) => r.z >= CLEAR_DIP).length} of ${list.length}`;
console.log(`A clear dip, ${CLEAR_DIP}+ times normal noise, within an hour of the start`);
console.log(`Real alerts: ${clear(alerts.filter((a: { group: string }) => REAL_GROUPS.includes(a.group)))}`);
console.log(`Suspected false readings: ${clear(alerts.filter((a: { group: string }) => a.group === 'no-record'))}`);
console.log(`Random quiet hours: ${clear(control)}`);
console.log(`\nBlackouts of ${LARGE_FOR_STATE}+ customers per reachable network block in the state`);
for (const a of alerts.filter((x: { customers: number; blocks: number }) => x.customers / x.blocks >= LARGE_FOR_STATE)) console.log(`  ${a.area.split(',')[0].padEnd(24)} ${a.group.padEnd(10)} ${(a.customers / a.blocks).toFixed(0).padStart(3)} per block, dip ${a.z.toFixed(1)}`);
