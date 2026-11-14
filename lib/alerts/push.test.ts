import assert from 'node:assert/strict';
import { before, beforeEach, describe, it, mock } from 'node:test';

class PreconditionFailed extends Error {}

let doc: { value: unknown; etag: string } | null;
let version: number;
/** Endpoints and the status their push service answers with. */
let answers: Record<string, number>;
let payloads: string[];
/** Runs once, just after the next read, to play another request landing in between. */
let meanwhile: (() => void) | null;

// The module mock captures these functions, so tests steer them through the variables above.
const store = {
  readDoc: async () => {
    const seen = doc ? structuredClone(doc) : null;
    const other = meanwhile;
    meanwhile = null;
    other?.();
    return seen;
  },
  swapDoc: async (_path: string, value: unknown, etag: string | null) => {
    if ((doc?.etag ?? null) !== etag) throw new PreconditionFailed();
    doc = { value: structuredClone(value), etag: String(++version) };
    return doc.etag;
  },
  PATHS: { push: 'push' },
};

let push: typeof import('./push.ts');

before(async () => {
  mock.module('@vercel/blob', { namedExports: { BlobPreconditionFailedError: PreconditionFailed } });
  mock.module('../store.ts', { namedExports: store });
  mock.module('web-push', {
    defaultExport: {
      setVapidDetails: () => {},
      sendNotification: async (sub: { endpoint: string }, text: string) => {
        payloads.push(text);
        const status = answers[sub.endpoint] ?? 201;
        if (status >= 300) throw Object.assign(new Error(`HTTP ${status}`), { statusCode: status });
        return { statusCode: status };
      },
    },
  });
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = 'public';
  process.env.VAPID_PRIVATE_KEY = 'private';
  push = await import('./push.ts');
});

beforeEach(() => {
  doc = null;
  version = 0;
  answers = {};
  payloads = [];
  meanwhile = null;
});

const sub = (n: number) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, keys: { p256dh: 'p', auth: 'a' } });
const endpoints = () => (doc?.value as Array<{ endpoint: string }>).map((s) => s.endpoint);
const message = { title: 'Unexplained blackout: Houston, TX', body: 'x', url: 'https://gridalert.test/#alerts' };

describe('who can sign up', () => {
  it('takes only the push services browsers really use', () => {
    for (const ok of ['https://fcm.googleapis.com/fcm/send/abc', 'https://web.push.apple.com/QG', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://wns2-par02p.notify.windows.com/w/?token=x']) assert.ok(push.isPushEndpoint(ok), ok);
    for (const bad of ['http://fcm.googleapis.com/fcm/send/abc', 'https://evil.example/fcm.googleapis.com', 'https://fcm.googleapis.com.evil.example/x', 'https://169.254.169.254/', 'not a url']) assert.ok(!push.isPushEndpoint(bad), bad);
  });

  it('keeps one entry per browser', async () => {
    await push.addSubscriber(sub(1));
    await push.addSubscriber(sub(1));
    await push.addSubscriber(sub(2));
    assert.deepEqual(endpoints(), [sub(1).endpoint, sub(2).endpoint]);
  });

  it('starts over instead of losing a sign-up that landed at the same moment', async () => {
    await push.addSubscriber(sub(1));
    meanwhile = () => {
      doc = { value: [...(doc!.value as unknown[]), sub(2)], etag: String(++version) };
    };
    await push.addSubscriber(sub(3));
    assert.deepEqual(endpoints(), [sub(1).endpoint, sub(2).endpoint, sub(3).endpoint]);
  });

  it('refuses sign-ups once the list is full', async () => {
    doc = { value: Array.from({ length: push.MAX_SUBSCRIBERS }, (_, i) => sub(i)), etag: '0' };
    assert.equal(await push.addSubscriber(sub(-1)), false);
    assert.equal((doc.value as unknown[]).length, push.MAX_SUBSCRIBERS);
  });
});

describe('a test the reader asks for', () => {
  const message = { title: 'GridAlert test', body: 'x', url: 'https://example.com' };

  it('goes to that browser alone', async () => {
    await push.addSubscriber(sub(1));
    await push.addSubscriber(sub(2));
    assert.equal(await push.sendTest(sub(2), message), 'sent');
    assert.equal(payloads.length, 1);
    assert.equal((doc!.value as unknown[]).length, 2);
  });

  it('signs a browser up again if it had fallen off the list', async () => {
    assert.equal(await push.sendTest(sub(1), message), 'sent');
    assert.deepEqual(doc!.value, [sub(1)]);
  });

  it('drops a browser whose push service says it is gone, and says so', async () => {
    await push.addSubscriber(sub(1));
    answers[sub(1).endpoint] = 410;
    assert.equal(await push.sendTest(sub(1), message), 'gone');
    assert.deepEqual(doc!.value, []);
  });

  it('keeps the browser and reports a failure that might pass', async () => {
    await push.addSubscriber(sub(1));
    answers[sub(1).endpoint] = 503;
    await assert.rejects(push.sendTest(sub(1), message), /HTTP 503/);
    assert.deepEqual(doc!.value, [sub(1)]);
  });
});

describe('sending an alert', () => {
  it('counts who it reached and drops browsers that are gone for good', async () => {
    doc = { value: [sub(1), sub(2), sub(3)], etag: '0' };
    answers = { [sub(2).endpoint]: 410 };
    assert.equal(await push.sendToSubscribers(message), 2);
    assert.deepEqual(endpoints(), [sub(1).endpoint, sub(3).endpoint]);
  });

  it('throws only when every one failed for a reason that might pass', async () => {
    doc = { value: [sub(1), sub(2)], etag: '0' };
    answers = { [sub(1).endpoint]: 503, [sub(2).endpoint]: 503 };
    await assert.rejects(push.sendToSubscribers(message), /all 2 browser deliveries failed/);
    answers = { [sub(1).endpoint]: 404, [sub(2).endpoint]: 404 };
    assert.equal(await push.sendToSubscribers(message), 0);
  });

  it('reaches nobody, without error, when nobody has signed up', async () => {
    assert.equal(await push.sendToSubscribers(message), 0);
  });

  it('shortens a long body to fit in a push message', async () => {
    doc = { value: [sub(1)], etag: '0' };
    await push.sendToSubscribers({ ...message, body: 'word '.repeat(500) });
    assert.ok(JSON.parse(payloads[0]).body.length <= 600);
  });
});
