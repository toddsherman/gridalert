// Test whether EIA-930 hourly demand can confirm a blackout. It can't, so the site doesn't
// use it (docs/CAUSE_CHECKS.md). Kept so the result can be rerun rather than rediscovered.
//
// usage: node scripts/backtest-demand.ts
// Reads about 290 MB of EIA's six-month files with no key. Only hourly demand is kept, in .cache/backtest.
import fs from 'node:fs';
import labels from '../data/unexplained-alerts.json' with { type: 'json' };
import { CACHE } from './lib/warnings.ts';

const BASE = 'https://www.eia.gov/electricity/gridmonitor/sixMonthFiles';
const PERIODS = ['2024_Jan_Jun', '2024_Jul_Dec', '2025_Jan_Jun', '2025_Jul_Dec'];
const SERIES = `${CACHE}/eia930.json`;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FROM = Date.UTC(2024, 0, 15);
const TO = Date.UTC(2026, 0, 1);
const YEARS = 2;
const CONTROL_HOURS = 3_000;
const BASELINE_DAYS = 14;
const MIN_DAYS = 7;
const MIN_MW = 800;
const KW_PER_CUSTOMER = 1.5;
const NOT_LOAD = /^(GRID|SEPA|HGMA|DEAA|WWA|YAD|GWA|AVRN|SIKE)$|^PNM\/|\/VEA$/;
const REAL_GROUPS = ['weather', 'equipment', 'deliberate', 'unknown'];

/** The most local demand series for each alert's area. Anchorage has none. */
const SERIES_FOR: Record<string, string> = {
  Philadelphia: 'PJM/PE', Detroit: 'MISO/0027', 'New York': 'NYIS/ZONJ', Atlanta: 'SOCO', Seattle: 'PSEI', Charlotte: 'DUK', Chicago: 'MISO/0006', Asheville: 'CPLW', 'San Diego': 'CISO/SDGE',
  Pittsburgh: 'PJM/DUQ', Bakersfield: 'CISO/SCE', Memphis: 'TVA', 'Cape Coral': 'FPL', Denver: 'PSCO', Miami: 'FPL', 'New Orleans': 'MISO/8910', Clarksville: 'TVA', Chattanooga: 'TVA',
  Stockton: 'CISO/PGAE', Providence: 'ISNE/4005', Riverside: 'CISO/SCE', Omaha: 'SWPP/OPPD', 'Los Angeles': 'LDWP', Portland: 'PGE', Salem: 'PGE', 'San Francisco': 'CISO/PGAE',
};

const LARGE_EVENTS = [
  ['Hurricane Beryl, Houston', 'ERCO/COAS', '2024-07-08T09:00:00Z', 2_260_000],
  ['Hurricane Milton, Florida', 'FPL', '2024-10-09T22:00:00Z', 2_000_000],
  ['Hurricane Helene, Georgia', 'SOCO', '2024-09-27T06:00:00Z', 1_000_000],
  ['Hurricane Helene, Carolinas', 'DUK', '2024-09-27T10:00:00Z', 1_200_000],
  ['Derecho, Houston', 'ERCO/COAS', '2024-05-16T23:00:00Z', 900_000],
  ['Los Angeles windstorm', 'CISO/SCE', '2025-01-08T03:00:00Z', 400_000],
] as const;

type Series = Record<string, Record<string, number | null>>;

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cell = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) {
      out.push(cell);
      cell = '';
    } else cell += ch;
  }
  out.push(cell);
  return out;
}

const toNumber = (text = '') => {
  const n = Number(text.replace(/[",]/g, ''));
  return text !== '' && Number.isFinite(n) ? n : null;
};

async function loadSeries(): Promise<Series> {
  if (fs.existsSync(SERIES)) return JSON.parse(fs.readFileSync(SERIES, 'utf8'));
  const series: Series = {};
  for (const period of PERIODS) {
    for (const kind of ['BALANCE', 'SUBREGION']) {
      const lines = (await (await fetch(`${BASE}/EIA930_${kind}_${period}.csv`)).text()).split(/\r?\n/);
      const head = splitCsv(lines[0]);
      const [ba, sub, utc] = [head.indexOf('Balancing Authority'), head.indexOf('Sub-Region'), head.indexOf('UTC Time at End of Hour')];
      const demand = head.includes('Demand (MW) (Adjusted)') ? head.indexOf('Demand (MW) (Adjusted)') : head.indexOf('Demand (MW)');
      for (const line of lines.slice(1)) {
        const c = splitCsv(line);
        const t = Date.parse(`${c[utc]} UTC`);
        if (!Number.isNaN(t)) (series[kind === 'BALANCE' ? c[ba] : `${c[ba]}/${c[sub]}`] ??= {})[t] = toNumber(c[demand]);
      }
    }
  }
  fs.writeFileSync(SERIES, JSON.stringify(series));
  return series;
}

const series = await loadSeries();
const demand = (s: string, t: number) => series[s]?.[t] ?? null;
const median = (values: number[]) => values.slice().sort((a, b) => a - b)[values.length >> 1];

/** The change from the hour before t to t + ahead, against the usual change at these clock hours. */
function surprise(s: string, t: number, ahead = 0): { mw: number; expected: number } | null {
  const before = demand(s, t - HOUR);
  const now = demand(s, t + ahead);
  if (before === null || now === null) return null;
  const usual: number[] = [];
  for (let k = 1; k <= BASELINE_DAYS; k++) {
    const a = demand(s, t + ahead - k * DAY);
    const b = demand(s, t - HOUR - k * DAY);
    if (a !== null && b !== null) usual.push(a - b);
  }
  if (usual.length < MIN_DAYS) return null;
  const expected = before + median(usual);
  return { mw: now - expected, expected };
}

/** How far below normal the hour after a start ran, in units of that series' usual noise. */
function score(s: string, start: number) {
  const t0 = Math.floor(start / HOUR) * HOUR;
  const steps: number[] = [];
  for (let i = 2; i <= BASELINE_DAYS * 24; i++) {
    const v = surprise(s, t0 - i * HOUR);
    if (v) steps.push(Math.abs(v.mw));
  }
  const worst = Math.min(...[0, 1, 2, 3].flatMap((i) => surprise(s, t0 + i * HOUR)?.mw ?? []));
  return steps.length > 100 && Number.isFinite(worst) ? worst / (median(steps) * 1.4826) : null;
}

const scored = labels.flatMap((a) => {
  const s = Object.entries(SERIES_FOR).find(([name]) => a.area.startsWith(name))?.[1];
  const z = s ? score(s, Date.parse(a.startedAt)) : null;
  return s && z !== null ? [{ ...a, s, z, expectedMw: (a.peakCustomers * KW_PER_CUSTOMER) / 1000 }] : [];
});
const real = scored.filter((a) => REAL_GROUPS.includes(a.group));

let seed = 1234;
const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const used = [...new Set(scored.map((a) => a.s))];
const control = Array.from({ length: CONTROL_HOURS }, () => score(used[Math.floor(random() * used.length)], FROM + DAY * 20 + Math.floor((random() * (TO - FROM - DAY * 40)) / HOUR) * HOUR)).filter((z) => z !== null);

console.log('Alert scale: a drop at least this many times the usual noise, within 3 hours of the start');
for (const limit of [-2, -3, -4, -5]) {
  const share = (list: number[]) => `${list.filter((z) => z <= limit).length} of ${list.length}`;
  console.log(`${String(limit).padStart(3)}: real ${share(real.map((a) => a.z))}, false ${share(scored.filter((a) => a.group === 'no-record').map((a) => a.z))}, random hours ${((control.filter((z) => z <= limit).length / control.length) * 100).toFixed(1)}%`);
}

interface Fall { s: string; t: number; pct: number }
const falls: Fall[] = [];
for (const s of Object.keys(series).filter((name) => !NOT_LOAD.test(name) && median(Object.values(series[name]).flatMap((v) => v ?? [])) >= MIN_MW)) {
  for (let t = FROM; t < TO; t += HOUR) {
    const path = [0, 1, 2].map((i) => surprise(s, t, i * HOUR));
    if (path.some((p) => !p)) continue;
    const pct = Math.min(...path.map((p) => (-p!.mw / p!.expected) * 100));
    if (pct < 3) continue;
    const last = falls.at(-1);
    if (last?.s === s && t - last.t <= 12 * HOUR) last.pct = Math.max(last.pct, pct);
    else falls.push({ s, t, pct });
  }
}
console.log('\nSustained three-hour falls across all large series, a year');
for (const limit of [5, 10, 15, 20, 30]) console.log(`${String(limit).padStart(3)}%: ${falls.filter((f) => f.pct >= limit).length / YEARS}`);

console.log('\nReal very large blackouts');
for (const [name, s, iso, customers] of LARGE_EVENTS) {
  const near = falls.filter((f) => f.s === s && Math.abs(f.t - Date.parse(iso)) <= 18 * HOUR).sort((a, b) => b.pct - a.pct)[0];
  console.log(`${name.padEnd(30)} ${String(customers).padStart(9)} customers  ${near ? `${near.pct.toFixed(0)}%` : 'under 3%'}`);
}
