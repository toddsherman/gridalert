// Read EAGLE-I, the federal record of outages by county every 15 minutes, and replay it
// through the real alert engine. See docs/DATA.md.
import fs from 'node:fs';
import readline from 'node:readline';
import geo from '../../data/geo.json' with { type: 'json' };
import { evaluate } from '../../lib/alerts/engine.ts';
import { biggestJump, latestRise } from '../../lib/alerts/trail.ts';
import { JUMP_WINDOW_MS, SIMULTANEOUS_WINDOW_MS, SURGE_CUSTOMERS } from '../../lib/causes/rules.ts';
import { metroByCbsa, metros } from '../../lib/registry.ts';
import { DEFAULT_SETTINGS, EMPTY_ENGINE, type EngineState } from '../../lib/types.ts';

export const STEP = 15 * 60_000;
/** Polls are 15 minutes here, so one confirms an alert and two clear it. */
export const settings = { ...DEFAULT_SETTINGS, confirmPolls: 1, clearPolls: 2 };
const metroOf = geo.metroOf as Record<string, string>;

export const SINGLE_LEVELS = [50_000, 75_000, 100_000, 150_000, 250_000, 500_000];

export interface Replayed {
  key: string;
  label: string;
  startedAt: number;
  endedAt: number;
  peakAt: number;
  /** When each single-area level was first reached. */
  crossedAt: Record<number, number>;
  peakCustomers: number;
  peakPeople: number;
  /** The most customers lost within 30 minutes. */
  jumpCustomers?: number;
  counties: string[];
}

export async function loadYear(year: number) {
  const start = Date.UTC(year, 0, 1);
  const steps = (Date.UTC(year + 1, 0, 1) - start) / STEP;
  const counties = new Map<string, Uint32Array>();
  const national = new Float64Array(steps);
  let lastText = '';
  let lastBin = 0;
  const lines = readline.createInterface({ input: fs.createReadStream(`datasets/eaglei/eaglei_outages_${year}.csv`), crlfDelay: Infinity });
  // Yearly files differ: 2024 adds a column and sorts by county rather than by time.
  let timeColumn = -1;
  let outColumn = -1;
  for await (const line of lines) {
    const cols = line.split(',');
    if (timeColumn < 0) {
      timeColumn = cols.indexOf('run_start_time');
      outColumn = cols.indexOf('customers_out');
      if (timeColumn < 0 || outColumn < 0) throw new Error(`unexpected columns in ${year}: ${line}`);
      continue;
    }
    const stamp = cols[timeColumn];
    if (stamp !== lastText) {
      lastText = stamp;
      lastBin = Math.round((Date.parse(`${stamp.replace(' ', 'T')}Z`) - start) / STEP);
    }
    if (lastBin < 0 || lastBin >= steps) continue;
    const out = Number(cols[outColumn]) || 0;
    national[lastBin] += out;
    const fips = cols[0];
    if (!metroOf[fips]) continue;
    let series = counties.get(fips);
    if (!series) counties.set(fips, (series = new Uint32Array(steps)));
    // A few runs land in the same 15 minutes.
    if (out > series[lastBin]) series[lastBin] = out;
  }
  // Reading the wrong column gives a clean-looking empty year, so refuse to carry on.
  const peak = Math.max(...national);
  if (peak < 100_000) throw new Error(`${year} looks unread: national peak is only ${peak}`);
  console.error(`${year}: national peak ${Math.round(peak).toLocaleString('en-US')} customers at ${new Date(start + national.indexOf(peak) * STEP).toISOString().slice(0, 16)}`);
  return { start, steps, counties, national };
}

/** Steps where the whole national feed dipped, which is collection failing, not power returning. */
function collectionGaps(national: Float64Array): Set<number> {
  const gaps = new Set<number>();
  for (let t = 4; t < national.length - 4; t++) {
    const around = [...national.slice(t - 4, t), ...national.slice(t + 1, t + 5)].sort((a, b) => a - b);
    if (national[t] < around[4] * 0.7) gaps.add(t);
  }
  return gaps;
}

let repairs = 0;

/**
 * Bridge dropouts in one area's feed. Production holds a failed feed's last value, but
 * here a dropout reads as zero, and its return would look like an outage starting.
 */
function repair(series: Float64Array, gaps: Set<number>): Float64Array {
  const v = series.slice();
  for (let t = 1; t < v.length; t++) if (gaps.has(t)) v[t] = v[t - 1];
  for (let t = 1; t < v.length; t++) {
    if (v[t - 1] < 2_000 || v[t] > v[t - 1] * 0.3) continue;
    for (let end = t + 1; end <= Math.min(t + 8, v.length - 1); end++) {
      if (v[end] >= v[t - 1] * 0.7) {
        repairs++;
        v.fill(v[t - 1], t, end);
        break;
      }
    }
  }
  // One-sample spikes don't survive the confirmation polls production uses.
  const out = v.slice();
  for (let t = 1; t < v.length - 1; t++) out[t] = [v[t - 1], v[t], v[t + 1]].sort((a, b) => a - b)[1];
  return out;
}

export function replay(year: number, data: Awaited<ReturnType<typeof loadYear>>): { records: Replayed[]; surges: Replayed[] } {
  const gaps = collectionGaps(data.national);
  const series = new Map<string, Float64Array>();
  for (const m of metros) {
    const total = new Float64Array(data.steps);
    for (const c of m.counties) {
      const s = data.counties.get(c.fips);
      if (s) for (let t = 0; t < data.steps; t++) total[t] += s[t];
    }
    series.set(m.cbsa, repair(total, gaps));
  }
  console.error(`${year}: ${gaps.size} collection gaps, ${repairs} area dropouts bridged`);

  const records: Array<Replayed & { peakStep: number; cbsa: string }> = [];
  const open = new Map<string, Replayed & { peakStep: number; cbsa: string }>();
  /** Jumps inside open alerts, replayed as starts of their own. */
  const surges: Array<Replayed & { peakStep: number; cbsa: string }> = [];
  let state: EngineState = EMPTY_ENGINE;
  for (let t = 0; t < data.steps; t++) {
    const candidates = metros.map((m) => {
      const customers = series.get(m.cbsa)![t];
      return { key: `metro:${m.cbsa}`, scope: 'metro' as const, label: m.name, customers, people: Math.round(customers * settings.peoplePerCustomer), detail: '', link: '', states: [], complete: true };
    });
    const result = evaluate(state, candidates, settings, new Date(data.start + t * STEP));
    state = result.state;
    for (const e of result.events) {
      if (e.kind === 'opened') {
        const cbsa = e.key.slice(6);
        open.set(e.key, { key: e.key, cbsa, label: e.label, startedAt: Date.parse(state.open[e.key].startedAt!), endedAt: Infinity, peakAt: data.start + t * STEP, crossedAt: {}, peakCustomers: 0, peakPeople: 0, counties: [], peakStep: t });
      }
      if (e.kind === 'resolved') {
        const r = open.get(e.key);
        if (r) {
          r.endedAt = data.start + t * STEP;
          records.push(r);
        }
        open.delete(e.key);
      }
    }
    for (const r of open.values()) {
      const customers = series.get(r.cbsa)![t];
      const jump = state.trail ? biggestJump(state.trail, r.key, r.startedAt, JUMP_WINDOW_MS) / settings.peoplePerCustomer : 0;
      r.jumpCustomers = Math.max(r.jumpCustomers ?? 0, jump);
      if (customers > r.peakCustomers) {
        r.peakCustomers = customers;
        r.peakPeople = Math.round(customers * settings.peoplePerCustomer);
        r.peakStep = t;
        r.peakAt = data.start + t * STEP;
      }
      for (const level of SINGLE_LEVELS) if (customers >= level && r.crossedAt[level] === undefined) r.crossedAt[level] = data.start + t * STEP;

      const rise = state.trail && latestRise(state.trail, r.key);
      const size = rise ? Math.round(rise.people / settings.peoplePerCustomer) : 0;
      if (!rise || size < SURGE_CUSTOMERS || rise.at - r.startedAt <= SIMULTANEOUS_WINDOW_MS) continue;
      const same = surges.findLast((s) => s.key === r.key && s.startedAt === rise.at);
      if (same) {
        same.peakCustomers = Math.max(same.peakCustomers, size);
        same.peakPeople = Math.round(same.peakCustomers * settings.peoplePerCustomer);
        same.peakAt = data.start + t * STEP;
        same.peakStep = t;
      } else {
        surges.push({ ...r, startedAt: rise.at, endedAt: Infinity, peakAt: data.start + t * STEP, crossedAt: {}, peakCustomers: size, peakPeople: Math.round(size * settings.peoplePerCustomer), peakStep: t });
      }
    }
  }
  records.push(...open.values());

  for (const r of records) {
    const list = metroByCbsa.get(r.cbsa)!.counties.map((c) => ({ fips: c.fips, out: data.counties.get(c.fips)?.[r.peakStep] ?? 0 }));
    const total = list.reduce((sum, c) => sum + c.out, 0);
    r.counties = list.filter((c) => total > 0 && c.out >= total * 0.1).map((c) => c.fips);
    if (!r.counties.length) r.counties = list.map((c) => c.fips);
  }
  console.error(`${year}: ${surges.length} surges inside open alerts`);
  for (const s of surges) s.counties = records.find((r) => r.key === s.key)?.counties ?? [];
  return { records, surges };
}
