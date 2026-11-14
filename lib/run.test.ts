import assert from 'node:assert/strict';
import { before, beforeEach, describe, it, mock } from 'node:test';
import type { World } from './causes/feeds.ts';
import { DEFAULT_SETTINGS } from './types.ts';

// Everything real except storage, feeds and the network: this drives whole polls
// through the engine, blackout upkeep and notification path.

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 10, 1, 18);
const CBSA = '26420';
const HARRIS = '48201';

class PreconditionFailed extends Error {}

const blobs = new Map<string, { value: string; etag: number }>();
let version = 0;
const FLOOR = { fips: HARRIS, name: 'Harris' };
let outages: Record<string, { name: string; county: { fips: string; name: string }; customers: number }>;
let world: World;
let sent: Array<{ title: string; priority?: string; body: string; actions?: string }>;
/** What went to browser subscribers, the public. */
let pushed: string[];
let pushDown = false;
let webhookDown = false;
let heartbeatDown = false;
let collectFails = false;
let checkIns: Array<Record<string, string>>;
let stuckFeeds: Array<{ id: string; name: string; method: string; since: string }>;
let odinDown: boolean;

const quiet = (): World => ({ weather: [], reports: [], fires: [], quakes: [], kp: [], gusts: [] });

/** Paths that fail. The store's functions are captured at import, so a test can't just replace them. */
let failReads: Set<string>;
let failWrites: Set<string>;

const store = {
  readDoc: async (path: string) => {
    if (failReads.has(path)) throw new Error('blob read failed');
    const hit = blobs.get(path);
    return hit ? { value: JSON.parse(hit.value), etag: String(hit.etag) } : null;
  },
  writeDoc: async (path: string, value: unknown) => {
    if (failWrites.has(path)) throw new Error('blob write failed');
    blobs.set(path, { value: JSON.stringify(value), etag: ++version });
  },
  swapDoc: async (path: string, value: unknown, etag: string | null) => {
    const hit = blobs.get(path);
    if (hit ? String(hit.etag) !== etag : etag !== null) throw new PreconditionFailed();
    blobs.set(path, { value: JSON.stringify(value), etag: ++version });
    return String(version);
  },
  PATHS: { latest: 'latest', engine: 'engine', history: 'history', alerts: 'alerts', blackouts: 'blackouts', simultaneous: 'simultaneous', news: 'news', health: 'health', settings: 'settings', push: 'push', sample: (at: Date) => `archive/${at.toISOString()}` },
};

function collect(_prev: unknown, settings: typeof DEFAULT_SETTINGS, now: Date) {
  if (collectFails) throw new Error('feeds unreachable');
  const metros = Object.entries(outages).map(([cbsa, o]) => ({
    cbsa, name: o.name, states: ['TX'], population: 7_000_000, customersOut: o.customers, estimatedPeople: Math.round(o.customers * settings.peoplePerCustomer),
    utilities: [{ id: `not-a-feed-${cbsa}`, name: `${o.name.split(',')[0]} Utility`, customersOut: o.customers }], counties: [{ ...o.county, customersOut: o.customers }], coverage: 1, gaps: [],
  }));
  const total = metros.reduce((sum, m) => sum + m.customersOut, 0);
  return {
    snapshot: { generatedAt: now.toISOString(), customersOut: total, estimatedPeople: total, customersTotal: 100, customersMonitored: 100, sourcesOk: 1, sourcesStale: 0, sourcesDown: 0, stuckFeeds, odinDown, metros, utilities: [], counties: {}, unmatchedAreas: [], durationMs: 1 },
    candidates: metros.map((m) => ({ key: `metro:${m.cbsa}`, scope: 'metro', label: m.name, people: m.estimatedPeople, customers: m.customersOut, detail: '', link: `/metros/${m.cbsa}`, states: ['TX'], complete: true })),
    lastGood: {},
  };
}

const setOut = (customers: number) => {
  outages[CBSA].customers = customers;
};

let runOnce: (now: Date) => Promise<unknown>;

before(async () => {
  mock.module('@vercel/blob', { namedExports: { BlobPreconditionFailedError: PreconditionFailed, get: () => null, put: () => null } });
  mock.module('./store.ts', { namedExports: store });
  mock.module('./collector.ts', { namedExports: { collect } });
  mock.module('./causes/feeds.ts', { namedExports: { gatherWorld: async () => world, within: <T>(work: Promise<T>) => work } });
  mock.module('./alerts/push.ts', {
    namedExports: {
      sendToSubscribers: async (m: { title: string }) => {
        if (pushDown) throw new Error('push service down');
        pushed.push(m.title);
        return 3;
      },
    },
  });
  ({ runOnce } = await import('./run.ts'));
  globalThis.fetch = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
    // GDELT has nothing new unless a test put stories in the log itself.
    if (String(url).includes('gdeltproject')) return new Response('');
    if (String(url).endsWith('/gridalert-heartbeat')) {
      if (heartbeatDown) return new Response('down', { status: 503 });
      checkIns.push(init.headers);
      return new Response('{}');
    }
    if (webhookDown) return new Response('down', { status: 503 });
    sent.push({ title: init.headers.title, priority: init.headers.priority, body: init.body, actions: init.headers.actions });
    return new Response('{}');
  }) as unknown as typeof fetch;
});

beforeEach(async () => {
  blobs.clear();
  failReads = new Set();
  failWrites = new Set();
  sent = [];
  pushed = [];
  pushDown = false;
  world = quiet();
  webhookDown = false;
  heartbeatDown = false;
  collectFails = false;
  checkIns = [];
  stuckFeeds = [];
  odinDown = false;
  outages = {
    [CBSA]: { name: 'Houston, TX', county: FLOOR, customers: 0 },
    '33100': { name: 'Miami, FL', county: { fips: '12086', name: 'Miami-Dade' }, customers: 0 },
    '12060': { name: 'Atlanta, GA', county: { fips: '13121', name: 'Fulton' }, customers: 0 },
  };
  await store.writeDoc(store.PATHS.settings, { webhookUrl: 'https://ntfy.sh/test-topic' });
  // This month's drill has been and gone, so it stays out of every other test.
  await store.writeDoc(store.PATHS.engine, { drilled: '2026-11' });
});

const poll = (minute: number) => runOnce(new Date(T0 + minute * MINUTE));
/** A live count ticks as outages come and go. */
const moving = (minute: number) => {
  for (const o of Object.values(outages)) if (o.customers) o.customers += 100;
  return poll(minute);
};
const titles = () => sent.map((m) => m.title.split(':')[0]);
const engineDoc = () => JSON.parse(blobs.get(store.PATHS.engine)!.value);
const blackout = async () => (await store.readDoc(store.PATHS.blackouts))?.value[0];
const alertLog = async () => (await store.readDoc(store.PATHS.alerts))?.value ?? [];
/** A large outage with no cause, which sends the high-priority alert at minute 15. */
const unexplained = async () => {
  await poll(0);
  setOut(60_000);
  await poll(5);
  await moving(10);
  await poll(15);
};

describe('a large blackout with no known cause', () => {
  it('lists it on the site at once without sending it, then sends one unexplained alert after ten minutes', async () => {
    await poll(0);
    setOut(60_000);
    await poll(5);
    assert.deepEqual(titles(), [], 'ordinary outages are not sent');
    const [opened] = await alertLog();
    assert.equal(opened.kind, 'opened');
    assert.equal(opened.siteOnly, true);
    assert.match(opened.cause, /Cause unknown so far: no storm warnings/);

    await moving(10);
    assert.equal(sent.length, 0, 'too early: it has only just started');

    await poll(15);
    assert.deepEqual(titles(), ['Unexplained blackout']);
    assert.equal(sent[0].priority, 'high');
    assert.match(sent[0].body, /Peaked near 150,250 people \(60,100 customers\)/);
    assert.match(sent[0].body, /Houston Utility/);
    assert.match(sent[0].actions ?? '', /^view, Search X, https:\/\/x\.com\/search\?q=Houston%20/);

    await poll(20);
    await poll(25);
    assert.equal(sent.length, 1, 'must not repeat');
    assert.equal((await blackout()).cause, 'unknown');
    assert.ok((await alertLog()).some((e: { kind: string }) => e.kind === 'unexplained'));
  });

  it('stands the alert down when a cause turns up later', async () => {
    await unexplained();
    world = { ...quiet(), reports: [{ kind: 'wind', at: T0 + 5 * MINUTE, fips: HARRIS, place: 'Katy, TX' }] };
    await poll(20);
    assert.deepEqual(titles(), ['Unexplained blackout', 'Blackout explained']);
    assert.match(sent[1].body, /Damaging wind reported near Katy, TX/);
    assert.equal(sent[1].priority, undefined);
    await poll(25);
    assert.equal(sent.length, 2);
    assert.equal((await blackout()).cause, 'explained');
  });

  it('says once, at normal priority, when the power comes back', async () => {
    await unexplained();
    setOut(100);
    for (let minute = 20; minute <= 60; minute += 5) await poll(minute);
    assert.deepEqual(titles(), ['Unexplained blackout', 'Mostly restored']);
    assert.equal(sent[1].priority, undefined);
    assert.match(sent[1].body, /Down to about 250 people\. Peaked near 150,250/);
    assert.ok((await blackout()).resolvedAt);
  });

  it('says nothing when it ends after the alert was withdrawn', async () => {
    await unexplained();
    world = { ...quiet(), reports: [{ kind: 'wind', at: T0 + 5 * MINUTE, fips: HARRIS, place: 'Katy, TX' }] };
    await poll(20);
    setOut(100);
    for (let minute = 25; minute <= 65; minute += 5) await poll(minute);
    assert.deepEqual(titles(), ['Unexplained blackout', 'Blackout explained']);
  });

  it('stays quiet when a small outage becomes large because of a storm hours later', async () => {
    await poll(0);
    setOut(5_000);
    for (const minute of [5, 10, 15, 20, 25]) await poll(minute);
    world = { ...quiet(), weather: [{ id: 'w', event: 'Severe Thunderstorm Warning', start: T0 + 300 * MINUTE, end: T0 + 360 * MINUTE, fips: [HARRIS] }] };
    setOut(100_000);
    for (const minute of [305, 310, 315, 320]) await poll(minute);
    assert.ok(!titles().includes('Unexplained blackout'));
    assert.equal((await blackout()).cause, 'explained');
  });

  it('keeps retrying if delivery fails, and sends it once when it recovers', async () => {
    await poll(0);
    setOut(60_000);
    await poll(5);
    await moving(10);
    webhookDown = true;
    await poll(15);
    await poll(20);
    assert.equal(sent.length, 0);
    webhookDown = false;
    await poll(25);
    await poll(30);
    assert.deepEqual(titles(), ['Unexplained blackout']);
  });
});

describe('a sudden outage under the alert level', () => {
  it('tells the owner once at normal priority, and never the public', async () => {
    await poll(0);
    setOut(41_000);
    await poll(5);
    await moving(10);
    await poll(15);
    assert.deepEqual(titles(), ['Watch, under the alert level']);
    assert.notEqual(sent[0].priority, 'high');
    assert.match(sent[0].body, /under the alert level of 50,000 customers, so this went only to you/);
    assert.deepEqual(pushed, []);

    await moving(20);
    await poll(25);
    assert.equal(sent.length, 1, 'must not repeat');
    assert.ok((await blackout()).watchNoticeAt);
    assert.equal((await blackout()).unexplainedNoticeAt, undefined);
    assert.ok((await alertLog()).some((e: { kind: string; channels?: string[] }) => e.kind === 'watch' && e.channels?.length));
  });

  it('says nothing for one that a storm explains', async () => {
    world = { ...quiet(), weather: [{ id: 'w', event: 'Severe Thunderstorm Warning', start: T0, end: T0 + 60 * MINUTE, fips: [HARRIS] }] };
    await poll(0);
    setOut(41_000);
    await poll(5);
    await moving(10);
    await poll(15);
    assert.deepEqual(titles(), []);
  });
});

describe('the dead-man\'s switch', () => {
  it('checks in on the first poll, then every 15 minutes', async () => {
    for (const minute of [0, 5, 10, 15, 20, 25, 30]) await poll(minute);
    assert.equal(checkIns.length, 3);
    assert.equal(checkIns[0].in, '40m');
    assert.equal(checkIns[0].title, 'GridAlert has stopped');
    assert.equal(checkIns[0].priority, 'high');
  });

  it('counts a poll landing a moment early, as cron often does', async () => {
    await poll(0);
    await runOnce(new Date(T0 + 15 * MINUTE - 250));
    assert.equal(checkIns.length, 2);
  });

  it('does not check in if a poll dies, so the warning still goes out', async () => {
    await poll(0);
    collectFails = true;
    await assert.rejects(poll(15));
    await assert.rejects(poll(30));
    assert.equal(checkIns.length, 1);
  });

  it('says when polling comes back after the warning has gone out', async () => {
    await poll(0);
    await poll(60);
    await poll(75);
    assert.deepEqual(titles(), ['GridAlert monitoring recovered']);
    assert.match(sent[0].body, /running again after 60 minutes/);
  });

  it('stays quiet after an ordinary gap', async () => {
    await poll(0);
    await poll(35);
    assert.deepEqual(titles(), []);
  });

  it('never lets a failed check-in stop an alert, and tries again next poll', async () => {
    heartbeatDown = true;
    await unexplained();
    assert.deepEqual(titles(), ['Unexplained blackout']);
    heartbeatDown = false;
    await poll(20);
    assert.equal(checkIns.length, 1);
  });
});

describe('ODIN stopping', () => {
  it('is logged for the site but not sent, since it happens most days', async () => {
    odinDown = true;
    for (const minute of [0, 5, 10, 15]) await poll(minute);
    assert.deepEqual(titles(), []);
    const log = (await store.readDoc(store.PATHS.alerts))!.value as Array<{ key: string; siteOnly?: boolean }>;
    assert.deepEqual(log.filter((e) => e.key === 'system:odin').map((e) => e.siteOnly), [true]);
  });
});

describe('ntfy refusing check-ins', () => {
  const impaired = async (): Promise<string[]> => (await store.readDoc(store.PATHS.latest))!.value.impaired ?? [];

  it('shows on the health check once it has lasted three polls, and clears when ntfy answers', async () => {
    await poll(0);
    heartbeatDown = true;
    for (const minute of [15, 20, 25]) await poll(minute);
    assert.deepEqual(await impaired(), []);
    await poll(30);
    assert.deepEqual(await impaired(), ["the owner's alert channel"]);
    heartbeatDown = false;
    await poll(35);
    await poll(40);
    assert.deepEqual(await impaired(), []);
  });

  it('says afterwards that the warning ntfy sent was false, not that polling stopped', async () => {
    await poll(0);
    heartbeatDown = true;
    for (let minute = 15; minute <= 60; minute += 5) await poll(minute);
    heartbeatDown = false;
    await poll(65);
    assert.deepEqual(titles(), ['GridAlert monitoring recovered']);
    assert.match(sent[0].body, /ntfy refused GridAlert's check-ins for 65 minutes/);
    assert.match(sent[0].body, /Polling never stopped/);
  });
});

describe('large feeds stopping together', () => {
  const feed = (id: string, method = 'kubra') => ({ id, name: `${id} Power`, method, since: new Date(T0).toISOString() });

  it('stays quiet for two', async () => {
    stuckFeeds = [feed('a'), feed('b')];
    await poll(0);
    assert.deepEqual(titles(), []);
  });

  it('sends one high-priority alert for three, then one all-clear', async () => {
    stuckFeeds = [feed('a'), feed('b'), feed('c')];
    await poll(0);
    await poll(5);
    assert.equal(titles().length, 1);
    assert.equal(sent[0].title, 'Large feeds stopped updating');
    assert.equal(sent[0].priority, 'high');
    assert.match(sent[0].body, /3 large feeds have stopped updating/);
    assert.match(sent[0].body, /a Power, b Power, c Power/);
    assert.match(sent[0].body, /through Kubra/);
    stuckFeeds = [feed('a'), feed('b')];
    await poll(10);
    assert.equal(sent.length, 1, 'two left is not yet recovered, so it does not flap');
    stuckFeeds = [feed('a')];
    await poll(15);
    assert.equal(sent[1].title, 'Feeds updating again');
  });

  it('does not blame a shared vendor when the feeds have none', async () => {
    stuckFeeds = [feed('a'), feed('b', 'arcgis'), feed('c', 'json')];
    await poll(0);
    assert.doesNotMatch(sent[0].body, /Kubra/);
  });
});

describe('news about a blackout', () => {
  const near = { name: 'Houston', state: 'TX', lat: 29.76, lon: -95.37 };
  const story = (title: string, minute: number, source = 'khou.com') => ({ at: T0 + minute * MINUTE, source, url: `https://${source}/${minute}`, title, places: [near] });

  it('builds a timeline without touching the cause status', async () => {
    await poll(0);
    await store.writeDoc(store.PATHS.news, { through: 0, items: [story('Thousands lose power in Houston', 30)] });
    setOut(60_000);
    await poll(5);
    await moving(10);
    await poll(15);
    await poll(20);
    const b = await blackout();
    assert.equal(b.timeline.length, 1);
    assert.equal(b.cause, 'unknown');
    assert.ok(!titles().includes('Reported as deliberate'));
  });

  it('does not alert on one headline from one unknown site', async () => {
    await poll(0);
    await store.writeDoc(store.PATHS.news, { through: 0, items: [story('Hackers blamed for Houston blackout', 30, 'made-up-news.example')] });
    setOut(30_000);
    for (const minute of [5, 10, 15, 20]) await moving(minute);
    assert.ok(!titles().includes('Reported as deliberate'));
    assert.equal((await blackout()).timeline[0].deliberate, true, 'it still shows on the page');
  });

  it('sends a report of a deliberate cause once, at high priority, and leaves the status alone', async () => {
    await poll(0);
    await store.writeDoc(store.PATHS.news, { through: 0, items: [story("'Intentional vandalism' leaves thousands without power in Houston", 30), story('Houston outage called sabotage by police', 31, 'click2houston.com')] });
    setOut(30_000);
    for (const minute of [5, 10, 15, 20]) await moving(minute);
    const notices = sent.filter((m) => m.title.startsWith('Reported as deliberate'));
    assert.equal(notices.length, 1);
    assert.equal(notices[0].priority, 'high');
    assert.match(notices[0].body, /khou\.com reports: "'Intentional vandalism' leaves thousands without power in Houston"/);
    assert.match(notices[0].body, /2 outlets are saying so/);
    assert.match(notices[0].body, /not confirmed/);
    assert.equal((await blackout()).cause, 'unknown');
  });

  it('takes one report from an outlet with editors, and keeps links out of the alert', async () => {
    await poll(0);
    await store.writeDoc(store.PATHS.news, { through: 0, items: [story(`Houston outage was sabotage, officials say https://evil.example/x ${'word '.repeat(80)}`, 30, 'apnews.com')] });
    setOut(30_000);
    for (const minute of [5, 10, 15, 20]) await moving(minute);
    const notice = sent.find((m) => m.title.startsWith('Reported as deliberate'));
    assert.doesNotMatch(notice!.body, /evil\.example/);
    assert.ok(notice!.body.length < 400);
  });
});

describe('getting alerts out', () => {
  it('falls back to the last settings if they cannot be read, rather than losing the webhook', async () => {
    await poll(0);
    failReads.add(store.PATHS.settings);
    setOut(60_000);
    await poll(5);
    await moving(10);
    await poll(15);
    assert.deepEqual(titles(), ['Unexplained blackout']);
  });

  it('stops rather than guess if settings have never been read', async () => {
    failReads.add(store.PATHS.settings);
    await assert.rejects(poll(0));
  });

  it('keeps an alert with no channel to send it on, instead of counting it as sent', async () => {
    await store.writeDoc(store.PATHS.settings, {});
    await unexplained();
    assert.equal(engineDoc().outbox.length, 1);
    await store.writeDoc(store.PATHS.settings, { webhookUrl: 'https://ntfy.sh/test-topic' });
    await poll(20);
    assert.deepEqual(titles(), ['Unexplained blackout']);
    assert.equal(engineDoc().outbox.length, 0);
  });

  it('keeps a high-priority alert through a long outage at the channel, but not an ordinary one', async () => {
    await unexplained();
    webhookDown = true;
    await store.writeDoc(store.PATHS.news, { through: 0, items: [] });
    const undelivered = (await store.readDoc(store.PATHS.engine))!;
    sent = [];
    // Put one of each in the queue, then let delivery fail for hours.
    const event = (kind: string, id: string) => ({ event: { id, kind, key: `metro:${id}`, scope: 'metro', label: id, at: new Date(T0 + 20 * MINUTE).toISOString(), people: 1, peakPeople: 1, customers: 1, openedAt: new Date(T0).toISOString(), detail: '', link: '/' }, attempts: 0 });
    await store.writeDoc(store.PATHS.engine, { ...undelivered.value, outbox: [event('opened', 'ordinary'), event('unexplained', 'urgent')] });
    for (let minute = 20; minute <= 80; minute += 5) await poll(minute);
    const left = engineDoc().outbox.map((i: { event: { key: string } }) => i.event.key);
    assert.deepEqual(left.sort(), ['metro:urgent', 'system:dropped']);
    webhookDown = false;
    await poll(85);
    assert.ok(titles().includes('Unexplained blackout'));
    assert.ok(titles().includes('GridAlert delivery degraded'));
    assert.equal(engineDoc().outbox.length, 0);
  });

  it('sends what is waiting before it reads the feeds, so a broken poll cannot hold it back', async () => {
    webhookDown = true;
    await unexplained();
    assert.equal(sent.length, 0);
    webhookDown = false;
    collectFails = true;
    await assert.rejects(poll(20));
    assert.deepEqual(titles(), ['Unexplained blackout']);
  });

  it('still alerts if the page data cannot be saved', async () => {
    failWrites.add(store.PATHS.latest);
    await unexplained();
    failWrites.clear();
    assert.deepEqual(titles(), ['Unexplained blackout']);
  });

  it('sends subscribers the blackout alert and its follow-up, and nothing about GridAlert itself', async () => {
    await unexplained();
    setOut(100);
    for (let minute = 20; minute <= 60; minute += 5) await poll(minute);
    stuckFeeds = ['a', 'b', 'c'].map((id) => ({ id, name: `${id} Power`, method: 'kubra', since: new Date(T0).toISOString() }));
    await poll(65);
    await poll(70);
    assert.deepEqual(pushed, ['Unexplained blackout: Houston, TX', 'Mostly restored: Houston, TX']);
    assert.ok(titles().includes('Large feeds stopped updating'), 'the owner still hears about it');
  });

  it('never sends subscribers an alert twice while the owner channel is down', async () => {
    webhookDown = true;
    await unexplained();
    await poll(20);
    await poll(25);
    webhookDown = false;
    await poll(30);
    assert.deepEqual(pushed, ['Unexplained blackout: Houston, TX']);
    assert.deepEqual(titles(), ['Unexplained blackout']);
  });

  it('retries subscribers alone when only they failed', async () => {
    pushDown = true;
    await unexplained();
    await poll(20);
    pushDown = false;
    await poll(25);
    await poll(30);
    assert.deepEqual(pushed, ['Unexplained blackout: Houston, TX']);
    assert.deepEqual(titles(), ['Unexplained blackout'], 'the owner got it once, at the start');
  });

  it('records in the log where each alert went, and which were never sent', async () => {
    await unexplained();
    const log = await alertLog();
    const alert = log.find((e: { kind: string }) => e.kind === 'unexplained');
    assert.deepEqual(alert.channels, ['webhook', 'browser (3)']);
    assert.ok(alert.sentAt);
    const opened = log.find((e: { kind: string }) => e.kind === 'opened');
    assert.equal(opened.siteOnly, true);
    assert.equal(opened.sentAt, undefined);
  });

  it('does not run twice at once, and a dead run does not block the next', async () => {
    await poll(0);
    await store.writeDoc(store.PATHS.engine, { ...engineDoc(), leaseUntil: T0 + 8 * MINUTE });
    assert.equal(((await poll(5)) as { skipped?: string }).skipped, 'another run is still going');
    assert.equal(((await poll(10)) as { skipped?: string }).skipped, undefined);
    assert.equal(engineDoc().leaseUntil, undefined);
  });
});

describe('when part of the chain breaks', () => {
  const urgent = () => sent.filter((m) => m.priority === 'high').map((m) => m.title);

  it('alerts anyway after 30 minutes if storm warnings cannot be read, and says so', async () => {
    world = { ...quiet(), weather: null };
    await poll(0);
    setOut(60_000);
    for (let minute = 5; minute <= 40; minute += 5) await moving(minute);
    assert.ok(titles().includes('Unexplained blackout'));
    const notice = sent.find((m) => m.title.startsWith('Unexplained'))!;
    assert.match(notice.body, /Storm warnings could not be read, so a storm is not ruled out/);
    assert.ok(urgent().includes('Storm warning check degraded'));
    world = quiet();
    await moving(45);
    assert.ok(titles().includes('Storm warning check recovered'));
  });

  it('stands the alert down if a storm turns up once warnings can be read again', async () => {
    world = { ...quiet(), weather: null };
    await poll(0);
    setOut(60_000);
    for (let minute = 5; minute <= 40; minute += 5) await moving(minute);
    world = { ...quiet(), weather: [{ id: 'w', event: 'Severe Thunderstorm Warning', start: T0, end: T0 + 60 * MINUTE, fips: [HARRIS] }] };
    await moving(45);
    assert.ok(titles().includes('Blackout explained'));
  });

  it('raises the alarm if blackout checks keep failing, and says when they recover', async () => {
    failWrites.add(store.PATHS.blackouts);
    await poll(0);
    setOut(60_000);
    await poll(5);
    assert.deepEqual(urgent(), []);
    await poll(10);
    assert.deepEqual(urgent(), ['Blackout checks degraded']);
    failWrites.clear();
    await poll(20);
    assert.ok(titles().includes('Blackout checks recovered'));
  });

  it('reports /api/health data for what stands in the way of a high-priority alert', async () => {
    failWrites.add(store.PATHS.blackouts);
    await poll(0);
    setOut(60_000);
    for (const minute of [5, 10, 15, 20]) await poll(minute);
    failWrites.clear();
    assert.deepEqual((await store.readDoc(store.PATHS.latest))!.value.impaired, ['blackout checks']);
  });

  it('says when the hourly check has stopped running', async () => {
    await store.writeDoc(store.PATHS.health, { probedAt: new Date(T0 - 4 * 60 * MINUTE).toISOString(), checks: {} });
    await poll(0);
    assert.ok(titles().includes('Hourly checks degraded'));
  });
});

describe('how fast it came', () => {
  it('leaves a slow climb to the site, as a storm would be', async () => {
    await poll(0);
    let out = 0;
    for (let minute = 5; minute <= 180; minute += 5) {
      out += 2_000;
      setOut(out);
      await moving(minute);
    }
    assert.ok(out >= 70_000);
    assert.ok((await alertLog()).some((e: { kind: string }) => e.kind === 'opened'));
    assert.deepEqual(titles(), []);
    assert.equal((await blackout()).cause, 'unknown');
  });

  it('alerts on that same climb if it reaches three times the level', async () => {
    await poll(0);
    let out = 0;
    for (let minute = 5; minute <= 390; minute += 5) {
      out += 4_000;
      setOut(out);
      await moving(minute);
    }
    assert.ok(out >= 150_000);
    assert.ok(titles().includes('Unexplained blackout'));
  });

  it('alerts on a jump on top of an outage already under way', async () => {
    await poll(0);
    setOut(8_000);
    for (const minute of [5, 10, 15, 20, 25, 30, 35, 40, 45]) await moving(minute);
    assert.ok(!titles().includes('Unexplained blackout'));
    setOut(70_000);
    await poll(50);
    await moving(55);
    assert.ok(titles().includes('Unexplained blackout'));
  });
});

describe('a count that does not move', () => {
  const quietUntil = async (from: number, to: number) => {
    for (let minute = from; minute <= to; minute += 5) await poll(minute);
  };

  it('holds the high-priority alert for an hour, then sends it with a warning', async () => {
    await poll(0);
    setOut(60_000);
    await quietUntil(5, 60);
    assert.deepEqual(titles(), []);
    await poll(65);
    assert.deepEqual(titles(), ['Unexplained blackout']);
    assert.match(sent[0].body, /has not moved since .* so this may be a false reading/);
  });

  it('sends it as soon as the count moves', async () => {
    await poll(0);
    setOut(60_000);
    await quietUntil(5, 25);
    assert.deepEqual(titles(), []);
    await moving(30);
    assert.deepEqual(titles(), ['Unexplained blackout']);
    assert.doesNotMatch(sent[0].body, /false reading/);
  });

  it('never sends anything for a false reading that vanishes within the hour', async () => {
    await poll(0);
    setOut(60_000);
    await quietUntil(5, 40);
    setOut(40);
    await quietUntil(45, 90);
    assert.deepEqual(titles(), []);
    assert.ok((await blackout()).resolvedAt);
  });

  it('does not take a flipping feed for a moving count', async () => {
    await poll(0);
    for (const [minute, customers] of [[5, 60_000], [10, 0], [15, 60_000], [20, 0], [25, 60_000], [30, 60_000]]) {
      setOut(customers);
      await poll(minute);
    }
    assert.ok(!titles().includes('Unexplained blackout'));
  });

  it('keeps a stuck area out of a simultaneous alert until it moves', async () => {
    await poll(0);
    outages[CBSA].customers = 15_000;
    outages['33100'].customers = 15_000;
    outages['12060'].customers = 15_000;
    await quietUntil(5, 25);
    assert.ok(!titles().includes('Simultaneous blackouts'));
    await moving(30);
    await moving(35);
    assert.equal(sent.filter((m) => m.title.startsWith('Simultaneous blackouts')).length, 1);
  });
});

describe('several areas starting together', () => {
  const start = (minute: number, cbsa: string, customers: number) => {
    outages[cbsa].customers = customers;
    return poll(minute);
  };

  it('sends one high-priority alert for three spread-out areas none of which is large alone', async () => {
    await poll(0);
    await start(5, CBSA, 15_000);
    await start(10, '33100', 15_000);
    await start(15, '12060', 15_000);
    assert.ok(!titles().includes('Simultaneous blackouts'), 'the last area has not settled yet');
    for (const minute of [20, 25, 30, 35]) await moving(minute);

    const notices = sent.filter((m) => m.title.startsWith('Simultaneous blackouts'));
    assert.equal(notices.length, 1, 'exactly one');
    assert.equal(notices[0].title, 'Simultaneous blackouts: Houston, Miami and Atlanta');
    assert.equal(notices[0].priority, 'high');
    assert.match(notices[0].body, /3 unrelated areas started within \d+ minutes/);
    assert.match(decodeURIComponent(notices[0].actions ?? ''), /q=\(Houston OR Miami OR Atlanta\) \(outage/);
    assert.ok(!titles().includes('Unexplained blackout'), 'each area is under the single-area level');
    assert.equal((await store.readDoc(store.PATHS.simultaneous))?.value.length, 1);
  });

  it('catches an attack on an area that already had an ordinary alert open', async () => {
    await poll(0);
    await start(5, '12060', 6_000);
    for (const minute of [10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65]) await poll(minute);
    await start(70, CBSA, 15_000);
    await start(75, '33100', 15_000);
    await start(80, '12060', 21_000);
    for (const minute of [85, 90, 95]) await moving(minute);
    const notices = sent.filter((m) => m.title.startsWith('Simultaneous blackouts'));
    assert.equal(notices.length, 1);
    assert.match(notices[0].title, /Atlanta/);
  });

  it('stands down when a cause turns up for one area', async () => {
    await poll(0);
    await start(5, CBSA, 15_000);
    await start(10, '33100', 15_000);
    await start(15, '12060', 15_000);
    for (const minute of [20, 25, 30]) await moving(minute);
    world = { ...quiet(), reports: [{ kind: 'wind', at: T0 + 5 * MINUTE, fips: HARRIS, place: 'Katy, TX' }] };
    await poll(35);
    await poll(40);
    assert.equal(sent.filter((m) => m.title.startsWith('Simultaneous alert stood down')).length, 1);
    assert.match(sent.at(-1)!.body, /Damaging wind reported near Katy, TX/);
    assert.equal(sent.at(-1)!.priority, undefined);
  });

  it('says once when every area has come back, and not before', async () => {
    await poll(0);
    await start(5, CBSA, 15_000);
    await start(10, '33100', 15_000);
    await start(15, '12060', 15_000);
    for (const minute of [20, 25, 30, 35]) await moving(minute);
    outages[CBSA].customers = 100;
    outages['33100'].customers = 100;
    for (let minute = 40; minute <= 75; minute += 5) await poll(minute);
    assert.ok(!titles().includes('Mostly restored'), 'Atlanta is still out');
    outages['12060'].customers = 100;
    for (let minute = 80; minute <= 120; minute += 5) await poll(minute);
    const restored = sent.filter((m) => m.title.startsWith('Mostly restored'));
    assert.deepEqual(restored.map((m) => m.title), ['Mostly restored: Houston, Miami and Atlanta']);
    assert.equal(restored[0].priority, undefined);
    assert.equal(restored[0].actions, undefined, 'a follow-up has no search');
  });

  it('stays quiet when a storm warning covers one of the areas', async () => {
    world = { ...quiet(), weather: [{ id: 'w', event: 'Wind Advisory', start: T0, end: T0 + 60 * MINUTE, fips: ['12086'] }] };
    await poll(0);
    await start(5, CBSA, 15_000);
    await start(10, '33100', 15_000);
    await start(15, '12060', 15_000);
    for (const minute of [20, 25, 30]) await moving(minute);
    assert.ok(!titles().includes('Simultaneous blackouts'));
  });

  it('stays quiet for areas that start hours apart', async () => {
    await poll(0);
    await start(5, CBSA, 15_000);
    await start(60, '33100', 15_000);
    await start(120, '12060', 15_000);
    for (const minute of [125, 130, 135]) await moving(minute);
    assert.ok(!titles().includes('Simultaneous blackouts'));
  });
});

describe('blackouts that should stay quiet', () => {
  it('does not fire when a storm warning explains it from the start', async () => {
    world = { ...quiet(), weather: [{ id: 'w', event: 'Severe Thunderstorm Warning', start: T0, end: T0 + 60 * MINUTE, fips: [HARRIS] }] };
    await poll(0);
    setOut(60_000);
    for (const minute of [5, 10, 15, 20]) await poll(minute);
    assert.deepEqual(titles(), []);
    assert.equal((await blackout()).cause, 'explained');
  });

  it('does not fire for one bad reading from a feed', async () => {
    await poll(0);
    setOut(60_000);
    await poll(5);
    setOut(100);
    for (const minute of [10, 15, 20, 25]) await poll(minute);
    assert.ok(!titles().includes('Unexplained blackout'));
  });

  it('does not fire below the level', async () => {
    await poll(0);
    setOut(30_000);
    for (const minute of [5, 10, 15, 20, 25]) await poll(minute);
    assert.ok(!titles().includes('Unexplained blackout'));
    assert.equal((await blackout()).cause, 'unknown');
  });

  it('waits for the weather check while it might still come back', async () => {
    world = { ...quiet(), weather: null };
    await poll(0);
    setOut(60_000);
    for (const minute of [5, 10, 15, 20, 25, 30]) await poll(minute);
    assert.ok(!titles().includes('Unexplained blackout'));
    assert.equal((await blackout()).cause, 'checking');
  });

  it('still lists the outage if blackout upkeep breaks', async () => {
    failWrites.add(store.PATHS.blackouts);
    await poll(0);
    setOut(60_000);
    await poll(5);
    failWrites.clear();
    assert.equal((await alertLog())[0].kind, 'opened');
  });
});

describe('the monthly drill', () => {
  const DECEMBER = (Date.UTC(2026, 11, 1, 17) - T0) / MINUTE;

  it('goes to the owner once, at high priority, and never to the public', async () => {
    await poll(DECEMBER - 5);
    assert.equal(sent.length, 0);
    await poll(DECEMBER);
    await poll(DECEMBER + 5);
    assert.deepEqual(sent.map((m) => m.title), ['Drill passed: this is a test, nothing is out']);
    assert.equal(sent[0].priority, 'high');
    assert.deepEqual(pushed, []);
    assert.equal(engineDoc().drilled, '2026-12');
    assert.equal((await alertLog())[0].key, 'system:drill');
  });

  it('is sent late when it could not be delivered', async () => {
    webhookDown = true;
    await poll(DECEMBER);
    assert.equal(sent.length, 0);
    webhookDown = false;
    await poll(DECEMBER + 5);
    assert.equal(sent.length, 1);
    assert.match(sent[0].title, /^Drill passed/);
  });

  it('leaves no blackout behind on the site', async () => {
    await poll(DECEMBER);
    assert.deepEqual((await store.readDoc(store.PATHS.blackouts))?.value ?? [], []);
    assert.deepEqual(engineDoc().engine.open, {});
  });
});
