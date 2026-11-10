import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { NewsItem } from './causes/news.ts';
import { metroByCbsa } from './registry.ts';
import { findReports, largeReports, reportedSize, type ReportsDoc } from './reports.ts';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 10, 6);
const HOUSTON = '26420';
const houston = metroByCbsa.get(HOUSTON)!;
const story = (title: string, source = 'khou.com', hoursAgo = 1, state = 'TX'): NewsItem => ({ at: NOW - hoursAgo * HOUR, source, url: `https://${source}/${encodeURIComponent(title)}`, title, places: [{ name: 'Houston', state, lat: 29.76, lon: -95.37 }] });
const BIG = 'More than 120,000 without power in Houston after sudden outage';

describe('reportedSize', () => {
  it('reads counts written as digits, with K, or in words', () => {
    assert.equal(reportedSize('More than 120,000 without power in Houston'), 120_000);
    assert.equal(reportedSize('Outage leaves 85K customers in the dark'), 85_000);
    assert.equal(reportedSize('1.2 million lose power across Harris County'), 1_200_000);
    assert.equal(reportedSize('Tens of thousands without power in Houston'), 20_000);
    assert.equal(reportedSize('Massive blackout hits downtown Houston'), 20_000);
  });

  it('ignores years, small counts and headlines that give no size', () => {
    assert.equal(reportedSize('Houston power outage: what we know'), 0);
    assert.equal(reportedSize('Remembering the 2021 Houston blackout'), 0);
    assert.equal(reportedSize('Crash knocks out power to 1,200 homes'), 1_200);
    assert.equal(reportedSize('Thousands without power in Houston'), 0);
  });
});

describe('largeReports', () => {
  const found = (...items: NewsItem[]) => largeReports(houston, items, NOW).length;

  it('keeps a recent story that names the metro and gives a large count', () => {
    assert.equal(found(story(BIG)), 1);
  });

  it('drops small outages, old stories, and stories about somewhere else', () => {
    assert.equal(found(story('Crash knocks out power to 1,200 homes in Houston')), 0);
    assert.equal(found(story(BIG, 'khou.com', 7)), 0);
    assert.equal(found(story('More than 120,000 without power in Miami after sudden outage', 'wsvn.com', 1, 'FL')), 0);
  });

  it('needs the place in the headline, not just a story placed nearby', () => {
    assert.equal(found(story('More than 120,000 without power after sudden outage')), 0);
  });
});

describe('findReports', () => {
  const blind = [{ cbsa: HOUSTON, coverage: 0.12 }];
  const quiet = async () => ({ checked: ['storm warnings', 'wildfires'] });
  const run = (doc: ReportsDoc, items: NewsItem[], at = NOW, causes: Parameters<typeof findReports>[4] = quiet) => findReports(doc, blind, { through: at, items }, new Date(at), causes);
  const two = [story(BIG), story('Houston outage: 120,000 customers lose power at once', 'click2houston.com')];

  it('counts a single outlet, since waiting for a second halved what the replay caught', async () => {
    const { events } = await run({}, [story(BIG)]);
    assert.match(events[0].detail, /^khou\.com reports a large outage here/);
  });

  it('sends one notice when nothing ordinary explains it, however many stories follow', async () => {
    const first = await run({}, two);
    assert.equal(first.events.length, 1);
    const [event] = first.events;
    assert.equal(event.kind, 'reported');
    assert.match(event.detail, /2 outlets report a large outage here, where GridAlert can read only 12% of customers/);
    assert.match(event.detail, /from the news, not measured/);
    assert.match(event.detail, /No storm warnings or wildfires found\./);
    const again = await run(first.doc, [...two, story('Houston blackout: 150,000 still out', 'chron.com', 0)], NOW + HOUR);
    assert.deepEqual(again.events, []);
  });

  it('says nothing when a storm explains it, and does not ask again', async () => {
    let asked = 0;
    const storm = async () => (++asked, { strong: 'Severe Thunderstorm Warning, Harris County, TX', checked: ['storm warnings'] });
    const first = await run({}, two, NOW, storm);
    assert.deepEqual(first.events, []);
    assert.match(first.doc[HOUSTON].explainedBy!, /Thunderstorm/);
    await run(first.doc, two, NOW + HOUR / 4, storm);
    assert.equal(asked, 1);
  });

  it('waits half an hour for storm warnings it cannot read, then sends and says so', async () => {
    const unread = async () => ({ checked: ['wildfires'] });
    const first = await run({}, two, NOW, unread);
    assert.deepEqual(first.events, []);
    const later = await run(first.doc, two, NOW + HOUR / 2, unread);
    assert.match(later.events[0].detail, /Storm warnings couldn't be read, so a storm isn't ruled out\./);
  });

  it('starts afresh a day later', async () => {
    const first = await run({}, two);
    const next = await run(first.doc, [story(BIG, 'khou.com', 0), story(BIG + ' again', 'chron.com', 0)].map((s) => ({ ...s, at: NOW + 25 * HOUR })), NOW + 25 * HOUR);
    assert.equal(next.events.length, 1);
  });

  it('leaves metros that can be seen alone', async () => {
    assert.deepEqual((await findReports({}, [], { through: NOW, items: two }, new Date(NOW), quiet)).events, []);
  });
});
