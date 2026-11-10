// Merge regional source files into data/sources.json and report coverage.
// usage: node scripts/merge-sources.ts
import fs from 'node:fs';
import path from 'node:path';
import { RUNNABLE_METHODS } from '../lib/sources/types.ts';

const dir = 'data/sources';
const utilities: any[] = JSON.parse(fs.readFileSync('data/utilities.json', 'utf8'));
const metros: any[] = JSON.parse(fs.readFileSync('data/metros.json', 'utf8'));
const byEia = new Map(utilities.map((u) => [u.eiaId, u]));

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_') && !f.includes('.verify'));
const merged = new Map<string, any>();
for (const f of files) {
  for (const e of JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) {
    if (merged.has(e.id)) console.log(`duplicate id ${e.id} in ${f}, keeping the first`);
    else merged.set(e.id, e);
  }
}

const entries = [...merged.values()];
const runnable = RUNNABLE_METHODS;
const live = new Set(entries.filter((e) => runnable.has(e.method)).flatMap((e) => e.eiaIds));
const reporters: number[] = JSON.parse(fs.readFileSync('data/odin-reporters.json', 'utf8'));
const odin = new Set([...entries.filter((e) => e.method === 'odin-only').flatMap((e) => e.eiaIds), ...reporters]);

const owners = new Map<number, string[]>();
for (const e of entries) {
  if (!runnable.has(e.method)) continue;
  for (const id of e.eiaIds) owners.set(id, [...(owners.get(id) ?? []), e.id]);
}
const shared = [...owners].filter(([, ids]) => ids.length > 1);
if (shared.length) console.log('EIA ids on several live feeds:', shared.slice(0, 20).map(([id, ids]) => `${byEia.get(id)?.name ?? id}=${ids.join('+')}`).join('; '));

// Two entries on one feed would count every outage twice, even with different EIA ids.
const fingerprint = (e: any) => JSON.stringify(e.method === 'kubra' ? [e.config.instanceId, e.config.viewId] : [e.config?.url, e.config?.baseUrl, e.config?.layerUrl, e.config?.where, e.config?.body, e.config?.excludeAreas]);
const byFeed = new Map<string, string[]>();
for (const e of entries) {
  if (runnable.has(e.method)) byFeed.set(fingerprint(e), [...(byFeed.get(fingerprint(e)) ?? []), e.id]);
}
const sameFeed = [...byFeed.values()].filter((ids) => ids.length > 1);
if (sameFeed.length) console.log('SAME FEED ON SEVERAL ENTRIES:', sameFeed.map((ids) => ids.join(' + ')).join('; '));

fs.writeFileSync('data/sources.json', JSON.stringify(entries, null, 1));

const counts: Record<string, number> = {};
for (const e of entries) counts[e.method] = (counts[e.method] ?? 0) + 1;
const total = utilities.reduce((s, u) => s + u.customers, 0);
const sum = (set: Set<number>) => utilities.filter((u) => set.has(u.eiaId)).reduce((s, u) => s + u.customers, 0);
console.log(`${entries.length} entries from ${files.length} files`, counts);
console.log(`direct feeds: ${((sum(live) / total) * 100).toFixed(1)}% of customers; with ODIN-only: ${((sum(new Set([...live, ...odin])) / total) * 100).toFixed(1)}%`);

let full = 0;
const weak: string[] = [];
for (const m of metros) {
  const us = m.utilities.map((id: number) => byEia.get(id)).filter(Boolean);
  const weight = (u: any) => Math.min(u.customers, m.population * 0.45);
  const all = us.reduce((s: number, u: any) => s + weight(u), 0);
  const got = us.filter((u: any) => live.has(u.eiaId) || odin.has(u.eiaId)).reduce((s: number, u: any) => s + weight(u), 0);
  // A metro with no EIA utility is covered only by a feed that names it.
  const share = all ? got / all : entries.some((e) => e.metros?.includes(m.cbsa) && runnable.has(e.method)) ? 1 : 0;
  if (share >= 0.8) full++;
  else weak.push(`${m.name} ${Math.round(share * 100)}%`);
}
console.log(`metros with 80%+ coverage: ${full}/${metros.length}`);
console.log('weakest:', weak.slice(0, 30).join(' | '));
const missing = utilities.filter((u) => !live.has(u.eiaId) && !odin.has(u.eiaId) && u.customers >= 100_000);
console.log(`utilities >= 100k with no feed (${missing.length}):`, missing.map((u) => u.name).slice(0, 40).join('; '));

// Publish the full list: every metro's utilities and how each one is monitored.
const entryByEia = new Map<number, any>();
for (const e of entries) for (const id of e.eiaIds) if (!entryByEia.has(id) || runnable.has(e.method)) entryByEia.set(id, e);

const csv = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const lines = ['metro,metro_population,utility,eia_id,ownership,customers,method,detail,map_url'];
for (const m of metros) {
  for (const id of m.utilities) {
    const u = byEia.get(id);
    if (!u) continue;
    const e = entryByEia.get(id);
    lines.push([m.name, m.population, u.name, id, u.ownership, u.customers, e?.method ?? 'not researched', e?.granularity ?? '', e?.mapUrl ?? ''].map(csv).join(','));
  }
}
fs.mkdirSync('docs', { recursive: true });
fs.writeFileSync('docs/coverage.csv', lines.join('\n') + '\n');

const rows = utilities.filter((u) => u.customers >= 25_000 && !live.has(u.eiaId) && !odin.has(u.eiaId));
const reason = (u: any) => String(entryByEia.get(u.eiaId)?.notes ?? 'Not researched yet; under the target size.').replace(/\|/g, '/').slice(0, 170);
const report = [
  '# Coverage',
  '',
  'Generated by `scripts/merge-sources.ts`. `coverage.csv` lists every metro and utility.',
  '',
  `- ${metros.length} metros of 250,000+ people, ${utilities.length} utilities, ${total.toLocaleString('en-US')} customers`,
  `- Direct feeds: ${live.size} utilities, ${((sum(live) / total) * 100).toFixed(1)}% of customers`,
  `- With ODIN-only utilities: ${((sum(new Set([...live, ...odin])) / total) * 100).toFixed(1)}% of customers`,
  `- Metros with 80%+ coverage: ${full} of ${metros.length}`,
  '',
  '## Utilities of 25,000+ customers with no feed',
  '',
  '| Utility | Customers | Why |',
  '|---|---:|---|',
  ...rows.map((u) => `| ${u.name} | ${u.customers.toLocaleString('en-US')} | ${reason(u)} |`),
  '',
];
fs.writeFileSync('docs/COVERAGE.md', report.join('\n'));
