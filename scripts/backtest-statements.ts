// Read the stories around each alert in data/unexplained-alerts.json and two real attacks
// with Claude, and score who it says said what. This spends money from ANTHROPIC_API_KEY.
//
// usage: node scripts/backtest-statements.ts [part of an event's name, to run just that one]
// Run scripts/backtest-news.ts first. Stops at MAX_SPEND. Article text is never saved.
import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import centroidsJson from '../data/county-centroids.json' with { type: 'json' };
import labels from '../data/unexplained-alerts.json' with { type: 'json' };
import { isAbout, type NewsArea, type NewsItem } from '../lib/causes/news.ts';
import { extractStatements, MAX_ARTICLES, readArticles } from '../lib/causes/statements.ts';
import { metros } from '../lib/registry.ts';
import type { Statement } from '../lib/types.ts';
import { CACHE } from './lib/warnings.ts';

process.loadEnvFile('.env.local');
// Claude Code sets this for itself, and it must not carry a project key anywhere else.
delete process.env.ANTHROPIC_BASE_URL;

const HOUR = 3_600_000;
const WINDOW_MS = 12 * HOUR;
const ATTACK_WINDOW_MS = 30 * HOUR;
const MAX_SPEND = 10;
const INPUT_PER_TOKEN = 4 / 1e6;
const OUTPUT_PER_TOKEN = 20 / 1e6;
const RESULTS = `${CACHE}/statement-results.json`;
const AUTHORITIES = new Set(['utility', 'grid operator', 'government', 'police or fire']);
/** The research labels, in the extractor's words. Anything else had no clear public cause. */
const TRUE_CAUSE: Record<string, string> = { wind: 'weather', winter: 'weather', tropical: 'weather', 'other-weather': 'weather', equipment: 'equipment', accident: 'accident', planned: 'planned' };

const centroids = centroidsJson as unknown as Record<string, [number, number]>;
const seen = new Set<string>();
const stories: NewsItem[] = fs.readFileSync(`${CACHE}/news-stories.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((s: NewsItem) => !seen.has(s.url) && seen.add(s.url));
stories.sort((a, b) => a.at - b.at);

const metroArea = (name: string, counties: string[]): NewsArea => {
  const metro = metros.find((m) => m.name === name)!;
  const list = metro.counties.filter((c) => counties.includes(c.fips));
  return { names: [...name.split(',')[0].split(/--|[-/]/).map((s) => s.trim()).filter((s) => s.length > 3), ...list.map((c) => c.name)], utilities: [], states: new Set(metro.counties.map((c) => c.state)), points: list.flatMap((c) => (centroids[c.fips] ? [centroids[c.fips]] : [])) };
};

const targets = [
  ...labels.map((a) => ({ name: `#${a.n} ${a.area.split(',')[0]}`, group: a.group, truth: TRUE_CAUSE[a.category], attack: false, start: Date.parse(a.startedAt), window: WINDOW_MS, area: metroArea(a.area, a.counties) })),
  { name: 'Moore County, NC', group: 'attack', truth: 'deliberate', attack: true, start: Date.parse('2022-12-04T00:00:00Z'), window: ATTACK_WINDOW_MS, area: { names: ['Moore County', 'Pinehurst', 'Southern Pines', 'Carthage'], utilities: ['Duke Energy'], states: new Set(['NC']), points: [centroids['37125']] } },
  { name: 'Tacoma, WA', group: 'attack', truth: 'deliberate', attack: true, start: Date.parse('2022-12-25T13:30:00Z'), window: ATTACK_WINDOW_MS, area: { names: ['Tacoma', 'Pierce County'], utilities: ['Tacoma Power', 'Puget Sound Energy'], states: new Set(['WA']), points: [centroids['53053']] } },
];

const only = process.argv[2];
const client = new Anthropic();
const at = new Date().toISOString();
let spent = 0;
const results: Array<{ name: string; group: string; truth?: string; attack: boolean; articles: number; statements: Statement[]; rejected: number; refused: boolean }> = [];

for (const t of targets.filter((x) => !only || x.name.includes(only))) {
  if (spent >= MAX_SPEND) {
    console.log(`Stopped at $${spent.toFixed(2)}, the limit for one run`);
    break;
  }
  const titles = new Set<string>();
  const found = stories.filter((s) => s.at >= t.start && s.at <= t.start + t.window && isAbout(s, t.area)).filter((s) => !titles.has(s.title.toLowerCase()) && titles.add(s.title.toLowerCase()));
  const articles = await readArticles(found.slice(0, MAX_ARTICLES * 2));
  if (!articles.length) {
    results.push({ name: t.name, group: t.group, truth: t.truth, attack: t.attack, articles: 0, statements: [], rejected: 0, refused: false });
    continue;
  }
  const reading = await extractStatements(client, t.name.replace(/^#\d+ /, ''), new Date(t.start).toISOString(), articles, at);
  spent += reading.inputTokens * INPUT_PER_TOKEN + reading.outputTokens * OUTPUT_PER_TOKEN;
  results.push({ name: t.name, group: t.group, truth: t.truth, attack: t.attack, articles: articles.length, statements: reading.statements, rejected: reading.rejected, refused: reading.refused });
  const named = reading.statements.filter((s) => AUTHORITIES.has(s.speakerType));
  console.log(`${t.name.padEnd(30)} ${t.group.padEnd(10)} truth ${String(t.truth).padEnd(10)} ${articles.length} articles, ${named.length} named, ${reading.rejected} rejected${reading.refused ? ', REFUSED' : ''}, $${spent.toFixed(2)}`);
  for (const s of named.slice(0, 3)) console.log(`    ${s.speaker} (${s.speakerType}) ${s.cause}: ${s.claim.slice(0, 90)}`);
}
fs.writeFileSync(RESULTS, JSON.stringify(results, null, 1));

const read = results.filter((r) => r.articles);
const authorities = (r: (typeof read)[number]) => r.statements.filter((s) => AUTHORITIES.has(s.speakerType) && s.cause !== 'unknown');
const known = read.filter((r) => r.truth);
console.log(`\nRead ${read.length} of ${results.length} events, $${spent.toFixed(2)}`);
console.log(`Known cause, stated by a named authority: right ${known.filter((r) => authorities(r).some((s) => s.cause === r.truth)).length}, wrong only ${known.filter((r) => authorities(r).length && !authorities(r).some((s) => s.cause === r.truth)).length}, none ${known.filter((r) => !authorities(r).length).length}, of ${known.length}`);
console.log(`Called deliberate by a named authority: ${read.filter((r) => !r.attack && authorities(r).some((s) => s.cause === 'deliberate')).map((r) => r.name).join(', ') || 'none'} (not attacks), ${read.filter((r) => r.attack && authorities(r).some((s) => s.cause === 'deliberate')).length} of 2 real attacks`);
console.log(`Quotes rejected ${read.reduce((sum, r) => sum + r.rejected, 0)}, refusals ${read.filter((r) => r.refused).length}`);
