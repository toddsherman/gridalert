// Create blackout records for alerts that fired before the list existed, dating
// each from the archived polls and checking it against what was on record then.
// usage: node scripts/backfill-blackouts.ts [--write]
export {};

process.loadEnvFile('.env.local');
const { get, list } = await import('@vercel/blob');
const { estimateOnset } = await import('../lib/alerts/trail.ts');
const { applyChecks, trimBlackouts } = await import('../lib/blackouts.ts');
const { convectiveDayStart, gatherWorld, parseStormReports, parseWeatherAlerts } = await import('../lib/causes/feeds.ts');
const { resolveCounty } = await import('../lib/geo.ts');
const { metroByCbsa, sources, utilityByEia } = await import('../lib/registry.ts');
const { getJson, getText } = await import('../lib/sources/http.ts');
const { PATHS, readDoc, writeDoc } = await import('../lib/store.ts');
const { DEFAULT_SETTINGS } = await import('../lib/types.ts');

const write = process.argv.includes('--write');
const HOUR = 3_600_000;
const TRAIL_MS = 6 * HOUR;
const now = new Date();

const log: any[] = (await readDoc<any[]>(PATHS.alerts, { fresh: true }))?.value ?? [];
const existing: any[] = (await readDoc<any[]>(PATHS.blackouts, { fresh: true }))?.value ?? [];
const open = (await readDoc<any>(PATHS.engine, { fresh: true }))?.value?.engine?.open ?? {};
const have = new Set(existing.map((b) => b.id));
const openIds = new Set(Object.values<any>(open).map((a) => `${a.key}:${a.openedAt}`));

const events = log.filter((e) => !e.key.startsWith('system:'));
const opened = events.filter((e) => e.kind === 'opened' && !have.has(`${e.key}:${e.openedAt}`) && !openIds.has(`${e.key}:${e.openedAt}`));
console.log(`${events.length} events, ${opened.length} alerts to backfill`);
if (!opened.length) process.exit(0);

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
console.log(`${samples.length} archived polls`);

function statesFor(key: string): string[] {
  if (key.startsWith('metro:')) return [...new Set(metroByCbsa.get(key.slice(6))?.counties.map((c) => c.state) ?? [])];
  const ids = sources.find((s) => s.id === key.slice(8))?.eiaIds ?? [];
  return [...new Set(ids.flatMap((id) => utilityByEia.get(id)?.states ?? []))];
}

function customersAt(sample: any, key: string): number {
  return key.startsWith('metro:') ? (sample.metros[key.slice(6)] ?? 0) : (sample.utilities[key.slice(8)] ?? 0);
}

/** Notices name the hardest-hit counties, which is the best record left of where it was. */
function countiesFrom(detail: string, states: string[]): string[] {
  const named = detail.match(/Hardest hit: (.*)$/)?.[1] ?? '';
  return named.split(', ').flatMap((part) => {
    const fips = resolveCounty(part.replace(/\s[\d,]+\.?$/, ''), states);
    return fips ? [fips] : [];
  });
}

const records: any[] = opened.map((e) => {
  const id = `${e.key}:${e.openedAt}`;
  const mine = events.filter((x) => `${x.key}:${x.openedAt}` === id);
  const resolved = mine.find((x) => x.kind === 'resolved');
  const openedAt = Date.parse(e.openedAt);
  const lastAt = resolved ? Date.parse(resolved.at) : now.getTime();
  const before = samples.filter((s) => Date.parse(s.t) > openedAt - TRAIL_MS && Date.parse(s.t) <= openedAt);
  const during = samples.filter((s) => Date.parse(s.t) >= openedAt && Date.parse(s.t) <= lastAt);
  const scale = DEFAULT_SETTINGS.peoplePerCustomer;
  const trail = { t: before.map((s) => Date.parse(s.t)), people: { [e.key]: before.map((s) => customersAt(s, e.key) * scale) } };
  const states = statesFor(e.key);
  return {
    id,
    key: e.key,
    scope: e.scope,
    label: e.label,
    link: e.link,
    states,
    startedAt: new Date(before.length ? estimateOnset(trail, e.key) : openedAt).toISOString(),
    openedAt: e.openedAt,
    resolvedAt: resolved?.at ?? now.toISOString(),
    people: (resolved ?? e).people,
    peakPeople: Math.max(...mine.map((x) => x.peakPeople), e.people),
    peakCustomers: Math.max(e.customers, ...during.map((s) => customersAt(s, e.key))),
    utilities: [],
    counties: countiesFrom(e.detail ?? '', states),
    cause: 'checking',
    evidence: [],
    checked: [],
    utilityCauses: [],
  };
});

const states = [...new Set(records.flatMap((b) => b.states))] as string[];
const earliest = Math.min(...records.map((b) => Date.parse(b.startedAt)));

const weather: any[] = [];
let next: string | undefined = `https://api.weather.gov/alerts?status=actual&area=${states.join(',')}&start=${new Date(earliest - 6 * HOUR).toISOString()}&end=${now.toISOString()}`;
for (let page = 0; next && page < 30; page++) {
  const doc: any = await getJson(next, { headers: { accept: 'application/geo+json' } });
  weather.push(...parseWeatherAlerts(doc));
  next = doc?.pagination?.next;
}

const reports: any[] = [];
const today = convectiveDayStart(now);
for (let day = convectiveDayStart(new Date(earliest)); day <= today; day += 24 * HOUR) {
  const d = new Date(day).toISOString();
  const stamp = `${d.slice(2, 4)}${d.slice(5, 7)}${d.slice(8, 10)}`;
  const csv = await getText(`https://www.spc.noaa.gov/climo/reports/${stamp}_rpts_filtered.csv`).catch(() => null);
  if (csv) reports.push(...parseStormReports(csv, day));
}

const world = { ...(await gatherWorld(states, [], [], now)), weather, reports };
console.log(`${weather.length} warnings, ${reports.length} storm reports`);

const done = records.map((b) => applyChecks(b, world, undefined, now));
for (const b of done) {
  console.log(`${b.startedAt.slice(5, 16)} ${String(b.peakPeople).padStart(7)} ${b.cause.padEnd(9)} ${b.label.slice(0, 44).padEnd(44)} ${b.evidence.find((e: any) => e.strong)?.label ?? ''}`);
}
const counts = done.reduce((acc: Record<string, number>, b) => ({ ...acc, [b.cause]: (acc[b.cause] ?? 0) + 1 }), {});
console.log(counts);

if (write) {
  const merged = [...existing, ...done].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  await writeDoc(PATHS.blackouts, trimBlackouts(merged));
  console.log(`wrote ${merged.length} records`);
}
