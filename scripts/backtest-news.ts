// Read GDELT's 15-minute files around each alert in data/unexplained-alerts.json and two
// real attacks on the grid, and score the news matching in lib/causes/news.ts.
//
// usage: node scripts/backtest-news.ts
// Only outage-tagged stories are kept, in .cache/backtest. Reads about 10 GB on a first run.
import fs from 'node:fs';
import centroidsJson from '../data/county-centroids.json' with { type: 'json' };
import labels from '../data/unexplained-alerts.json' with { type: 'json' };
import { gkgUrl, isAbout, isTrustedOutlet, type NewsArea, type NewsItem, outletOf, parseGkg, soundsDeliberate, unzipSingle } from '../lib/causes/news.ts';
import { metros } from '../lib/registry.ts';
import { CACHE } from './lib/warnings.ts';

const FILE_MS = 900_000;
const HOUR = 3_600_000;
const BEFORE_MS = HOUR;
const AFTER_MS = 12 * HOUR;
const ATTACK_AFTER_MS = 30 * HOUR;
const CONCURRENCY = 6;
/** Fewer files than this with any US outage story means GDELT itself has a gap. */
const MIN_FILES = 4;
const STORIES = `${CACHE}/news-stories.jsonl`;
const FILES = `${CACHE}/news-files.json`;
const FALSE_GROUP = 'no-record';
const HOURS = [1, 2, 3, 6, 12];

const centroids = centroidsJson as unknown as Record<string, [number, number]>;

const ATTACKS = [
  { name: 'Moore County, NC', start: Date.parse('2022-12-04T00:00:00Z'), area: { names: ['Moore County', 'Pinehurst', 'Southern Pines', 'Carthage'], utilities: ['Duke Energy'], states: new Set(['NC']), points: [centroids['37125']] } },
  { name: 'Tacoma, WA', start: Date.parse('2022-12-25T13:30:00Z'), area: { names: ['Tacoma', 'Pierce County'], utilities: ['Tacoma Power', 'Puget Sound Energy'], states: new Set(['WA']), points: [centroids['53053']] } },
];

const span = (start: number, after: number) => {
  const first = Math.floor((start - BEFORE_MS) / FILE_MS) * FILE_MS;
  return Array.from({ length: Math.ceil((BEFORE_MS + after) / FILE_MS) + 1 }, (_, i) => first + i * FILE_MS);
};

async function readAll(stamps: number[]) {
  const done = new Set<number>(fs.existsSync(FILES) ? JSON.parse(fs.readFileSync(FILES, 'utf8')) : []);
  const todo = stamps.filter((t) => !done.has(t));
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < todo.length) {
      const t = todo[next++];
      const res = await fetch(gkgUrl(t), { signal: AbortSignal.timeout(60_000) }).catch(() => null);
      if (res?.ok) {
        const items = parseGkg(unzipSingle(Buffer.from(await res.arrayBuffer())));
        if (items.length) fs.appendFileSync(STORIES, `${items.map((i) => JSON.stringify(i)).join('\n')}\n`);
      }
      if (res) done.add(t);
      if (next % 200 === 0) console.error(`${next} of ${todo.length} files`);
    }
  }));
  fs.writeFileSync(FILES, JSON.stringify([...done]));
}

await readAll([...new Set([...labels.flatMap((a) => span(Date.parse(a.startedAt), AFTER_MS)), ...ATTACKS.flatMap((a) => span(a.start, ATTACK_AFTER_MS))])]);

const seen = new Set<string>();
const stories: NewsItem[] = fs.readFileSync(STORIES, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((s: NewsItem) => !seen.has(s.url) && seen.add(s.url));
stories.sort((a, b) => a.at - b.at);
const between = (from: number, to: number) => stories.filter((s) => s.at >= from && s.at <= to);

const areaOf = (metro: (typeof metros)[number], counties?: string[]): NewsArea => {
  const list = counties?.length ? metro.counties.filter((c) => counties.includes(c.fips)) : metro.counties;
  const cities = metro.name.split(',')[0].split(/--|[-/]/).map((s) => s.trim()).filter((s) => s.length > 3);
  return { names: [...cities, ...list.map((c) => c.name)], utilities: [], states: new Set(metro.counties.map((c) => c.state)), points: list.flatMap((c) => (centroids[c.fips] ? [centroids[c.fips]] : [])) };
};

const scored = labels.map((a) => {
  const start = Date.parse(a.startedAt);
  const window = between(start, start + AFTER_MS);
  const hits = window.filter((s) => isAbout(s, areaOf(metros.find((m) => m.name === a.area)!, a.counties)));
  return { ...a, files: new Set(window.map((s) => s.at)).size, stories: hits.length, first: hits[0] ? (hits[0].at - start) / HOUR : null, deliberate: hits.filter((s) => soundsDeliberate(s.title)) };
});
const covered = scored.filter((a) => a.files >= MIN_FILES);
console.log(`${scored.length - covered.length} alerts fall in a GDELT gap: ${scored.filter((a) => a.files < MIN_FILES).map((a) => a.n).join(', ')}`);

console.log('\ngroup        alerts  with news', HOURS.map((h) => `<=${h}h`.padStart(5)).join(''));
for (const group of ['weather', 'equipment', 'deliberate', 'unknown', 'distorted', FALSE_GROUP]) {
  const list = covered.filter((a) => a.group === group);
  console.log(group.padEnd(12), String(list.length).padStart(6), String(list.filter((a) => a.stories).length).padStart(10), HOURS.map((h) => String(list.filter((a) => a.first !== null && a.first <= h).length).padStart(5)).join(''));
}
const real = covered.filter((a) => a.group !== FALSE_GROUP);
const firsts = real.flatMap((a) => (a.first === null ? [] : [a.first])).sort((a, b) => a - b);
console.log(`Real alerts with news: ${firsts.length} of ${real.length}, first story at a median of ${firsts[firsts.length >> 1].toFixed(1)} hours`);
console.log(`Real alerts with none: ${real.filter((a) => !a.stories).map((a) => `${a.n} ${a.area.split(',')[0]}`).join('; ')}`);
console.log(`Deliberate wording on the alerts, none of which was an attack: ${scored.filter((a) => a.deliberate.length).length}`);

let windows = 0;
let quiet = 0;
const chance = new Set<string>();
for (const a of covered) {
  const start = Date.parse(a.startedAt);
  const window = between(start, start + AFTER_MS);
  for (const metro of metros) {
    if (metro.name === a.area) continue;
    windows++;
    const hits = window.filter((s) => isAbout(s, areaOf(metro)));
    if (!hits.length) quiet++;
    for (const s of hits) if (soundsDeliberate(s.title)) chance.add(`${metro.name.split(',')[0]}: ${s.title}`);
  }
}
console.log(`\nChance: ${windows} metro windows of 12 hours, ${windows - quiet} with any outage story, ${chance.size} with deliberate wording`);
for (const line of chance) console.log(`  ${line.slice(0, 110)}`);
console.log(`Deliberate wording anywhere: ${stories.filter((s) => soundsDeliberate(s.title)).length} of ${stories.length} stories`);

console.log('\nReal attacks');
for (const { name, start, area } of ATTACKS) {
  const hits = between(start - BEFORE_MS, start + ATTACK_AFTER_MS).filter((s) => isAbout(s, area));
  const flagged = hits.filter((s) => soundsDeliberate(s.title));
  const hours = (s?: NewsItem) => (s ? `+${((s.at - start) / HOUR).toFixed(1)}h` : 'never');
  console.log(`${name}: ${hits.length} stories, first ${hours(hits[0])}. Flagged ${flagged.length}, first ${hours(flagged[0])}: ${flagged[0]?.title.slice(0, 80)}`);
  // The alert takes an outlet with editors, or two outlets with different headlines.
  const outlets = new Set<string>();
  const titles = new Set<string>();
  const alert = flagged.find((s) => {
    if (titles.has(s.title.toLowerCase())) return false;
    titles.add(s.title.toLowerCase());
    outlets.add(outletOf(s.source));
    return isTrustedOutlet(s.source) || outlets.size >= 2;
  });
  console.log(`  Alert would send ${hours(alert)}${alert ? ` from ${alert.source}` : ''}. Outlets flagging: ${[...new Set(flagged.map((s) => outletOf(s.source)))].slice(0, 8).join(', ')}`);
}
