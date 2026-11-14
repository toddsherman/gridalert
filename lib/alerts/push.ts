import { BlobPreconditionFailedError } from '@vercel/blob';
import webpush from 'web-push';
import { PATHS, readDoc, swapDoc } from '../store.ts';
import { type Message, siteUrl } from './notify.ts';

/** Browser subscriptions from the public sign-up. They get blackout alerts and nothing else. */
export type PushSubscriptions = webpush.PushSubscription[];

/** The push services browsers use. Anything else isn't a real subscription. */
const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|android\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/;
/** Bounds the stored list and how long one alert takes to send. */
export const MAX_SUBSCRIBERS = 10_000;
const CONCURRENCY = 50;
const PUSH_TIMEOUT_MS = 10_000;
/** A push message holds about 4 KB, and alert details quote headlines. */
const MAX_BODY = 600;
/** The service says the subscription is gone or was never valid, so it won't work later either. */
const DEAD = new Set([400, 403, 404, 410]);

export function isPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && PUSH_HOSTS.test(url.hostname);
  } catch {
    return false;
  }
}

/** Change the list, starting over if a sign-up or a send changed it first. */
async function updateSubscribers(change: (subs: PushSubscriptions) => PushSubscriptions): Promise<PushSubscriptions> {
  for (let attempt = 0; ; attempt++) {
    const stored = await readDoc<PushSubscriptions>(PATHS.push, { fresh: true });
    const next = change(stored?.value ?? []);
    try {
      await swapDoc(PATHS.push, next, stored?.etag ?? null);
      return next;
    } catch (err) {
      // With no etag, losing the race to create the list fails differently.
      const raced = err instanceof BlobPreconditionFailedError || !stored;
      if (!raced || attempt >= 4) throw err;
    }
  }
}

/** Resolves false once the list is full. */
export async function addSubscriber(sub: webpush.PushSubscription): Promise<boolean> {
  let full = false;
  await updateSubscribers((subs) => {
    const others = subs.filter((s) => s.endpoint !== sub.endpoint);
    full = others.length >= MAX_SUBSCRIBERS;
    return full ? subs : [...others, sub];
  });
  return !full;
}

export async function removeSubscriber(endpoint: string): Promise<void> {
  await updateSubscribers((subs) => subs.filter((s) => s.endpoint !== endpoint));
}

function payload(m: Message): string {
  const body = m.body.length > MAX_BODY ? `${m.body.slice(0, MAX_BODY - 1)}…` : m.body;
  return JSON.stringify({ ...m, body });
}

function vapid(): boolean {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return false;
  webpush.setVapidDetails(siteUrl().replace('http://', 'https://'), publicKey, privateKey);
  return true;
}

/** Send one message to one browser, as the welcome when it signs up. */
export async function sendToOne(sub: webpush.PushSubscription, m: Message): Promise<void> {
  if (!vapid()) throw new Error('browser alerts are not set up');
  await webpush.sendNotification(sub, payload(m), { timeout: PUSH_TIMEOUT_MS });
}

/**
 * A test the reader asked for, sent to their browser alone. It goes back on the list first, so a
 * device that had fallen off is signed up again by testing. 'gone' means its push service says
 * the subscription no longer works, which only signing up again can fix.
 */
export async function sendTest(sub: webpush.PushSubscription, m: Message): Promise<'sent' | 'gone' | 'full'> {
  if (!(await addSubscriber(sub))) return 'full';
  try {
    await sendToOne(sub, m);
    return 'sent';
  } catch (err) {
    if (!DEAD.has((err as { statusCode?: number }).statusCode ?? 0)) throw err;
    await removeSubscriber(sub.endpoint).catch((e) => console.error('removing a dead subscription failed:', e));
    return 'gone';
  }
}

/**
 * Send to everyone signed up and say how many it reached. Throws only when every one failed
 * for a reason that might pass, so the caller can try again without sending anyone it twice.
 */
export async function sendToSubscribers(m: Message): Promise<number> {
  if (!vapid()) return 0;
  const stored = await readDoc<PushSubscriptions>(PATHS.push, { fresh: true });
  const subs = stored?.value ?? [];
  const text = payload(m);
  let reached = 0;
  let failed = 0;
  const dead = new Set<string>();
  for (let i = 0; i < subs.length; i += CONCURRENCY) {
    const batch = subs.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map((s) => webpush.sendNotification(s, text, { timeout: PUSH_TIMEOUT_MS })));
    results.forEach((r, j) => {
      if (r.status === 'fulfilled') reached++;
      else if (DEAD.has(r.reason?.statusCode)) dead.add(batch[j].endpoint);
      else failed++;
    });
  }
  if (dead.size) await updateSubscribers((list) => list.filter((s) => !dead.has(s.endpoint))).catch((err) => console.error('pruning subscriptions failed:', err));
  if (!reached && failed) throw new Error(`all ${failed} browser deliveries failed`);
  return reached;
}
