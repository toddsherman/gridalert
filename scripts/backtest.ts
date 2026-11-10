// Replay archived polls through the alert engine to see how noisy a setting would
// be, before changing it in production.
// usage: node scripts/backtest.ts [threshold ...]     e.g. 10000 25000 50000 100000
export {};

process.loadEnvFile('.env.local');
const { get, list } = await import('@vercel/blob');
const { evaluate } = await import('../lib/alerts/engine.ts');
const { metros } = await import('../lib/registry.ts');
const { DEFAULT_SETTINGS, EMPTY_ENGINE } = await import('../lib/types.ts');

const thresholds = process.argv.slice(2).map(Number);
if (!thresholds.length) thresholds.push(10_000, 25_000, 50_000, 100_000);

const names: string[] = [];
let cursor: string | undefined;
do {
  const page = await list({ prefix: 'archive/', cursor, limit: 1000 });
  names.push(...page.blobs.map((b) => b.pathname));
  cursor = page.cursor;
} while (cursor);
names.sort();

const samples: Array<{ t: string; metros: Record<string, number> }> = [];
for (const name of names) {
  const res = await get(name, { access: 'private' });
  if (res?.statusCode === 200) samples.push(JSON.parse(await new Response(res.stream).text()));
}
if (samples.length < 2) throw new Error('not enough archived polls yet');

const days = (Date.parse(samples.at(-1)!.t) - Date.parse(samples[0].t)) / 86_400_000;
const label = new Map(metros.map((m) => [m.cbsa, m.name.split(',')[0].split('-')[0]]));
console.log(`${samples.length} polls over ${days.toFixed(1)} days\n`);
console.log('people threshold   alerts   per day   notifications   busiest metros');

for (const thresholdPeople of thresholds) {
  const settings = { ...DEFAULT_SETTINGS, thresholdPeople };
  let state = EMPTY_ENGINE;
  let opened = 0;
  let notified = 0;
  const byMetro: Record<string, number> = {};
  for (const sample of samples) {
    const candidates = metros.map((m) => {
      const customers = sample.metros[m.cbsa] ?? 0;
      return { key: `metro:${m.cbsa}`, scope: 'metro' as const, label: m.name, customers, people: Math.round(customers * settings.peoplePerCustomer), detail: '', link: '', states: [], complete: true };
    });
    const result = evaluate(state, candidates, settings, new Date(sample.t));
    state = result.state;
    notified += result.events.length;
    for (const event of result.events) {
      if (event.kind !== 'opened') continue;
      opened++;
      const cbsa = event.key.replace('metro:', '');
      byMetro[cbsa] = (byMetro[cbsa] ?? 0) + 1;
    }
  }
  const busiest = Object.entries(byMetro).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([c, n]) => `${label.get(c)} ${n}`).join(', ');
  console.log(`${String(thresholdPeople).padStart(16)} ${String(opened).padStart(8)} ${(opened / days).toFixed(1).padStart(9)} ${String(notified).padStart(15)}   ${busiest}`);
}
