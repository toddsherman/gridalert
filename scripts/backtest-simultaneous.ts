// Replay archived polls to see how often unrelated metros start together by chance.
// usage: node scripts/backtest-simultaneous.ts
export {};

process.loadEnvFile('.env.local');
const { get, list } = await import('@vercel/blob');
const { evaluate } = await import('../lib/alerts/engine.ts');
const { SIMULTANEOUS_WINDOW_MS } = await import('../lib/causes/rules.ts');
const { metros } = await import('../lib/registry.ts');
const { DEFAULT_SETTINGS, EMPTY_ENGINE } = await import('../lib/types.ts');

const names: string[] = [];
let cursor: string | undefined;
do {
  const page = await list({ prefix: 'archive/', cursor, limit: 1000 });
  names.push(...page.blobs.map((b) => b.pathname));
  cursor = page.cursor;
} while (cursor);
names.sort();

const samples: any[] = [];
for (let i = 0; i < names.length; i += 20) {
  const batch = await Promise.all(names.slice(i, i + 20).map(async (name) => {
    const res = await get(name, { access: 'private' });
    return res?.statusCode === 200 ? JSON.parse(await new Response(res.stream).text()) : null;
  }));
  samples.push(...batch.filter(Boolean));
}

let state: any = EMPTY_ENGINE;
const opened: any[] = [];
for (const sample of samples) {
  const candidates = metros.map((m) => {
    const customers = sample.metros[m.cbsa] ?? 0;
    return { key: `metro:${m.cbsa}`, scope: 'metro' as const, label: m.name, customers, people: Math.round(customers * DEFAULT_SETTINGS.peoplePerCustomer), detail: '', link: '', states: [], complete: true };
  });
  const result = evaluate(state, candidates, DEFAULT_SETTINGS, new Date(sample.t));
  state = result.state;
  for (const e of result.events) if (e.kind === 'opened') opened.push({ key: e.key, openedAt: e.openedAt, startedAt: Date.parse(result.state.open[e.key].startedAt!) });
}

for (const a of opened) {
  const until = Date.parse(a.openedAt) + 6 * 3_600_000;
  a.peak = Math.max(...samples.filter((s) => s.t >= a.openedAt && Date.parse(s.t) < until).map((s) => s.metros[a.key.slice(6)] ?? 0));
}

const hours = (Date.parse(samples.at(-1).t) - Date.parse(samples[0].t)) / 3_600_000;
console.log(`${samples.length} polls over ${hours.toFixed(1)} hours, ${opened.length} metro alerts`);
console.log('customers per area   alerts   pairs   triples');
for (const level of [4_000, 5_000, 7_500, 10_000, 15_000, 25_000]) {
  const big = opened.filter((a) => a.peak >= level).sort((a, b) => a.startedAt - b.startedAt);
  const within = (i: number) => new Set(big.filter((a) => a.startedAt >= big[i].startedAt && a.startedAt - big[i].startedAt <= SIMULTANEOUS_WINDOW_MS).map((a) => a.key)).size;
  const sizes = big.map((_, i) => within(i));
  console.log(`${String(level).padStart(18)} ${String(big.length).padStart(8)} ${String(sizes.filter((n) => n >= 2).length).padStart(7)} ${String(sizes.filter((n) => n >= 3).length).padStart(9)}`);
}
