import assert from 'node:assert/strict';
import { it } from 'node:test';
import { startedAgo, threadsSearch, xSearch } from './format.ts';

const query = (url: string) => new URL(url).searchParams.get('q');

it('searches the latest posts on X for a power cut in the main city', () => {
  const url = xSearch(['Baltimore-Columbia-Towson, MD']);
  assert.match(url, /^https:\/\/x\.com\/search\?q=.+&f=live$/);
  assert.equal(query(url), 'Baltimore (outage OR blackout OR "power out" OR "no power" OR "lost power" OR "without power")');
});

it('quotes city names of more than one word and joins several areas', () => {
  assert.match(query(xSearch(['Houston-Pasadena-The Woodlands, TX', 'New York-Newark-Jersey City, NY-NJ', 'Louisville/Jefferson County, KY-IN']))!, /^\(Houston OR "New York" OR Louisville\) \(outage/);
});

it('searches recent posts on Threads with one phrase', () => {
  const url = threadsSearch('Louisville/Jefferson County, KY-IN');
  assert.match(url, /^https:\/\/www\.threads\.com\/search\?q=.+&filter=recent$/);
  assert.equal(query(url), 'Louisville power outage');
});

it('keeps the link free of the commas and semicolons ntfy splits buttons on', () => {
  assert.doesNotMatch(xSearch(['Nashville-Davidson--Murfreesboro--Franklin, TN', 'Miami-Fort Lauderdale-West Palm Beach, FL']), /[,;]/);
});

const NOW = Date.UTC(2026, 10, 2, 12);
const ago = (minutes: number) => startedAgo(new Date(NOW - minutes * 60_000).toISOString(), NOW);

it('says how long ago in plain words', () => {
  assert.equal(ago(0), 'Just now');
  assert.equal(ago(1), '1 minute ago');
  assert.equal(ago(34), '34 minutes ago');
  assert.equal(ago(59), '59 minutes ago');
  assert.equal(ago(60), '1 hour ago');
  assert.equal(ago(190), '3 hours ago');
  assert.equal(ago(24 * 60), '1 day ago');
  assert.equal(ago(50 * 60), '2 days ago');
});

it('copes with a clock a little behind the data', () => {
  assert.equal(ago(-2), 'Just now');
});
