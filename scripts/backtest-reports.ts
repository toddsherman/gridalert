// Score the news backstop in lib/reports.ts against the alerts in data/unexplained-alerts.json,
// as if every metro were unseen. Uses the stories scripts/backtest-news.ts already cached, so
// run that first. Downloads nothing.
//
// usage: node scripts/backtest-reports.ts
import fs from 'node:fs';
import labels from '../data/unexplained-alerts.json' with { type: 'json' };
import type { NewsItem } from '../lib/causes/news.ts';
import { metros } from '../lib/registry.ts';
import { largeReports } from '../lib/reports.ts';
import { CACHE } from './lib/warnings.ts';

const HOUR = 3_600_000;
const STEP_MS = HOUR / 4;
const AFTER_MS = 12 * HOUR;

const seen = new Set<string>();
const stories: NewsItem[] = fs.readFileSync(`${CACHE}/news-stories.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((s: NewsItem) => !seen.has(s.url) && seen.add(s.url));
stories.sort((a, b) => a.at - b.at);

/** Hours after the start at which the backstop would have counted a report, and the stories behind it. */
function firstCount(metro: (typeof metros)[number], start: number) {
  const inWindow = stories.filter((s) => s.at >= start && s.at <= start + AFTER_MS);
  for (let t = start; t <= start + AFTER_MS; t += STEP_MS) {
    const found = largeReports(metro, inWindow.filter((s) => s.at <= t), t);
    if (found.length) return { hours: (t - start) / HOUR, found };
  }
  return null;
}

console.log('Real alerts, had their metro been unseen');
const real = labels.filter((a) => a.group !== 'no-record');
const caught: number[] = [];
for (const a of real) {
  const hit = firstCount(metros.find((m) => m.name === a.area)!, Date.parse(a.startedAt));
  if (hit) caught.push(hit.hours);
  console.log(`  ${String(a.n).padStart(2)} ${a.group.padEnd(10)} ${a.area.split(',')[0].slice(0, 28).padEnd(28)} ${String(a.peakCustomers).padStart(7)}  ${hit ? `+${hit.hours.toFixed(1)}h  ${hit.found[0].title.slice(0, 70)}` : 'not caught'}`);
}
caught.sort((a, b) => a - b);
console.log(`Caught ${caught.length} of ${real.length}${caught.length ? `, at a median of ${caught[caught.length >> 1].toFixed(1)} hours` : ''}`);

let windows = 0;
const chance: string[] = [];
for (const a of labels) {
  for (const metro of metros) {
    if (metro.name === a.area) continue;
    windows++;
    const hit = firstCount(metro, Date.parse(a.startedAt));
    if (hit) chance.push(`${metro.name.split(',')[0]}: ${hit.found[0].title.slice(0, 90)}`);
  }
}
console.log(`\nChance: ${windows} windows of 12 hours in other metros, ${chance.length} would have counted (${((chance.length / windows) * 100).toFixed(2)}%), before any cause check`);
for (const line of chance.slice(0, 40)) console.log(`  ${line}`);
