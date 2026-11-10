import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { type AlertEvent, DEFAULT_SETTINGS } from '../types.ts';
import { checkIn, deliver, FEEDS_KEY, formatEvent, webhookRequest } from './notify.ts';

const event = (over: Partial<AlertEvent> = {}): AlertEvent => ({
  id: 'x',
  kind: 'opened',
  key: 'metro:12580',
  scope: 'metro',
  label: 'Baltimore-Columbia-Towson, MD',
  at: '2026-11-01T05:00:00.000Z',
  people: 62_000,
  peakPeople: 62_000,
  customers: 24_800,
  openedAt: '2026-11-01T04:00:00.000Z',
  detail: 'BGE 24,800. Hardest hit: Baltimore 12,000',
  link: '/metros/12580',
  ...over,
});

it('words each stage of an outage', () => {
  assert.match(formatEvent(event()).title, /^Power outage: Baltimore/);
  assert.match(formatEvent(event()).body, /About 62,000 people affected \(24,800 customers\)\. BGE/);
  assert.match(formatEvent(event({ kind: 'escalated' })).title, /^Growing outage/);
  const resolved = formatEvent(event({ kind: 'resolved', people: 900, peakPeople: 80_000 }));
  assert.match(resolved.title, /^Mostly restored/);
  assert.match(resolved.body, /Peaked near 80,000/);
});

it('makes the unexplained alert unmistakable', () => {
  const m = formatEvent(event({ kind: 'unexplained', peakPeople: 150_000, customers: 60_000, detail: 'No storm warnings found.', link: '/blackouts' }));
  assert.match(m.title, /^Unexplained blackout: Baltimore/);
  assert.match(m.body, /Peaked near 150,000 people \(60,000 customers\)\. No storm warnings found\./);
  assert.equal(m.urgent, true);
});

it('links the high-priority alerts, and only those, to a search of posts on X', () => {
  const areas = ['Baltimore-Columbia-Towson, MD'];
  for (const kind of ['unexplained', 'deliberate', 'simultaneous'] as const) assert.match(formatEvent(event({ kind, areas })).search ?? '', /^https:\/\/x\.com\/search\?q=Baltimore/);
  for (const kind of ['opened', 'explained', 'resolved', 'simultaneous-explained'] as const) assert.equal(formatEvent(event({ kind, areas })).search, undefined);
  assert.equal(formatEvent(event({ kind: 'unexplained' })).search, undefined);
});

it('puts the search on an ntfy button and in the text elsewhere', () => {
  const m = { title: 'T', body: 'B', url: 'https://x.test/a', urgent: true, search: 'https://x.com/search?q=Baltimore%20outage&f=live' };
  assert.equal(webhookRequest('https://ntfy.sh/topic', m).headers.actions, `view, Search X, ${m.search}`);
  assert.doesNotMatch(webhookRequest('https://ntfy.sh/topic', m).body, /x\.com/);
  assert.equal(webhookRequest('https://ntfy.sh/topic', { ...m, search: undefined }).headers.actions, undefined);
  assert.match(JSON.parse(webhookRequest('https://discord.com/api/webhooks/a', m).body).content, /\nSearch X: https:\/\/x\.com\/search\?q=Baltimore%20outage&f=live$/);
});

it('gives the alert that replaces it no urgency', () => {
  const m = formatEvent(event({ kind: 'explained', detail: 'Likely cause: Tornado Warning.' }));
  assert.match(m.title, /^Blackout explained: Baltimore/);
  assert.equal(m.body, 'Likely cause: Tornado Warning.');
  assert.equal(m.urgent, undefined);
});

it('raises priority on ntfy only for urgent messages', () => {
  const base = { title: 'T', body: 'B', url: 'https://x.test/a' };
  const urgent = webhookRequest('https://ntfy.sh/topic', { ...base, urgent: true });
  assert.equal(urgent.headers.priority, 'high');
  assert.equal(urgent.headers.tags, 'rotating_light');
  const routine = webhookRequest('https://ntfy.sh/topic', base);
  assert.equal(routine.headers.priority, undefined);
  assert.equal(routine.headers.tags, 'zap');
});

it('words monitoring notices as monitoring, never as an outage', () => {
  const notice = event({ key: 'system:coverage', label: 'GridAlert monitoring', people: 0, peakPeople: 0, customers: 0, detail: 'Only 40% of customers have a live feed.', link: '/coverage' });
  const down = formatEvent(notice);
  assert.equal(down.title, 'GridAlert monitoring degraded');
  assert.equal(down.body, 'Only 40% of customers have a live feed.');
  assert.doesNotMatch(down.body, /people/);
  assert.equal(formatEvent({ ...notice, kind: 'resolved' }).title, 'GridAlert monitoring recovered');
});

it('shapes webhook bodies for each service', () => {
  const m = { title: 'Power outage: Test', body: 'About 5,000 people', url: 'https://x.test/a' };
  assert.deepEqual(Object.keys(JSON.parse(webhookRequest('https://hooks.slack.com/services/a', m).body)), ['text']);
  assert.deepEqual(JSON.parse(webhookRequest('https://discord.com/api/webhooks/a', m).body).allowed_mentions, { parse: [] });
  const ntfy = webhookRequest('https://ntfy.sh/topic', m);
  assert.equal(ntfy.headers.title, 'Power outage: Test');
  assert.equal(ntfy.headers.click, m.url);
  assert.deepEqual(JSON.parse(webhookRequest('https://example.com/hook', m).body), m);
});

it('stops a headline in an alert from pinging a channel', () => {
  const m = { title: 'T', body: '<!channel> & <@U123>', url: 'https://x.test/a' };
  assert.match(JSON.parse(webhookRequest('https://hooks.slack.com/services/a', m).body).text, /&lt;!channel&gt; &amp; &lt;@U123&gt;/);
});

it('matches services by their exact host', () => {
  const m = { title: 'T', body: 'B', url: 'https://x.test/a' };
  assert.deepEqual(JSON.parse(webhookRequest('https://discord.com.example.org/hook', m).body), m);
  assert.deepEqual(JSON.parse(webhookRequest('https://notslack.com/hook', m).body), m);
});

it('says when an alert closed for want of data rather than calling it restored', () => {
  const m = formatEvent(event({ kind: 'resolved', blind: true, detail: 'No complete reading for 12 hours.' }));
  assert.match(m.title, /^Closed with no reading/);
  assert.doesNotMatch(m.title, /restored/);
});

it('raises monitoring notices that stand in the way of an alert', () => {
  const notice = event({ key: 'system:upkeep', label: 'Blackout checks', detail: 'x', urgent: true });
  assert.equal(formatEvent(notice).urgent, true);
  assert.equal(formatEvent(notice).title, 'Blackout checks degraded');
  assert.equal(formatEvent({ ...notice, kind: 'resolved' }).urgent, undefined);
});

it('keeps ntfy titles header-safe', () => {
  const { headers } = webhookRequest('https://ntfy.sh/topic', { title: 'Power outage: Cañon City’s grid', body: '', url: 'https://x.test' });
  assert.equal(headers.title, 'Power outage: Canon Citys grid');
});

describe('checkIn', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function capture() {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    globalThis.fetch = (async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, headers: init.headers });
      return new Response('{}');
    }) as unknown as typeof fetch;
    return calls;
  }

  it('replaces a scheduled warning on the ntfy topic', async () => {
    const calls = capture();
    assert.equal(await checkIn({ ...DEFAULT_SETTINGS, webhookUrl: 'https://ntfy.sh/my-topic' }), true);
    assert.equal(calls[0].url, 'https://ntfy.sh/my-topic/gridalert-heartbeat');
    assert.equal(calls[0].headers.in, '40m');
  });

  it('does nothing for a webhook that is not ntfy, or none at all', async () => {
    const calls = capture();
    assert.equal(await checkIn({ ...DEFAULT_SETTINGS, webhookUrl: 'https://hooks.slack.com/x' }), false);
    assert.equal(await checkIn(DEFAULT_SETTINGS), false);
    assert.equal(calls.length, 0);
  });
});

it('words the stuck-feeds alert as urgent, and its all-clear as routine', () => {
  const opened = formatEvent(event({ key: FEEDS_KEY, kind: 'opened', link: '/coverage' }));
  assert.equal(opened.title, 'Large feeds stopped updating');
  assert.equal(opened.urgent, true);
  const resolved = formatEvent(event({ key: FEEDS_KEY, kind: 'resolved', link: '/coverage' }));
  assert.equal(resolved.title, 'Feeds updating again');
  assert.equal(resolved.urgent, undefined);
});

describe('deliver', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const message = { title: 'T', body: 'B', url: 'https://x.test/a' };

  it('rejects when no channel is set up, which is not a delivery', async () => {
    await assert.rejects(deliver(message, DEFAULT_SETTINGS), /no alert channel is set up/);
  });

  it('rejects when the only channel fails', async () => {
    globalThis.fetch = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    await assert.rejects(deliver(message, { ...DEFAULT_SETTINGS, webhookUrl: 'https://ntfy.sh/t' }), /webhook HTTP 503/);
  });

  it('reports the channel that took it', async () => {
    globalThis.fetch = (async () => new Response('{}')) as unknown as typeof fetch;
    assert.deepEqual((await deliver(message, { ...DEFAULT_SETTINGS, webhookUrl: 'https://ntfy.sh/t' })).channels, ['webhook']);
  });
});
