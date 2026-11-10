// Record every utility seen reporting to ODIN, which only lists active outages.
// usage: node scripts/update-odin-reporters.ts [names.txt]
import fs from 'node:fs';

process.loadEnvFile('.env.local');
const { get, list } = await import('@vercel/blob');
const { readOdin } = await import('../lib/sources/odin.ts');

const seen = new Set<number>(fs.existsSync('data/odin-reporters.json') ? JSON.parse(fs.readFileSync('data/odin-reporters.json', 'utf8')) : []);
for (const row of await readOdin()) if (row.eiaId != null) seen.add(row.eiaId);

const extra = process.argv[2];
if (extra) {
  for (const line of fs.readFileSync(extra, 'utf8').split('\n')) {
    const id = line.split('\t')[0];
    if (/^\d+$/.test(id)) seen.add(Number(id));
  }
}

let cursor: string | undefined;
const names: string[] = [];
do {
  const page = await list({ prefix: 'archive/', cursor, limit: 1000 });
  names.push(...page.blobs.map((b) => b.pathname));
  cursor = page.cursor;
} while (cursor);
for (const name of names) {
  const res = await get(name, { access: 'private' });
  if (res?.statusCode !== 200) continue;
  const sample = JSON.parse(await new Response(res.stream).text());
  for (const key of Object.keys(sample.utilities)) {
    const match = key.match(/^odin-(\d+)$/);
    if (match) seen.add(Number(match[1]));
  }
}

// Holding-company and merged ids aren't utilities in the registry.
const utilities: Array<{ eiaId: number }> = JSON.parse(fs.readFileSync('data/utilities.json', 'utf8'));
const known = new Set(utilities.map((u) => u.eiaId));
const ids = [...seen].filter((id) => known.has(id)).sort((a, b) => a - b);
fs.writeFileSync('data/odin-reporters.json', JSON.stringify(ids));
console.log(`${ids.length} ODIN reporters in the registry, from ${names.length} polls`);
