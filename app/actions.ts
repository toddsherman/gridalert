'use server';

import type webpush from 'web-push';
import { z } from 'zod';
import { siteUrl } from '@/lib/alerts/notify';
import { addSubscriber, isPushEndpoint, removeSubscriber, sendTest, sendToOne } from '@/lib/alerts/push';

export type SignUpResult = { ok: true } | { error: string };

const Subscription = z.object({
  endpoint: z.string().url().max(2048).refine(isPushEndpoint),
  expirationTime: z.number().nullish(),
  keys: z.object({ p256dh: z.string().max(256), auth: z.string().max(256) }),
});

/** Anyone can sign up. The welcome goes only to the browser that asked, so it shows the alerts will arrive. */
export async function signUpAction(subscription: webpush.PushSubscription): Promise<SignUpResult> {
  const parsed = Subscription.safeParse(subscription);
  if (!parsed.success) return { error: "This browser's alert details weren't accepted." };
  const sub = parsed.data as webpush.PushSubscription;
  if (!(await addSubscriber(sub))) return { error: 'Sign-ups are full for now.' };
  await sendToOne(sub, { title: 'GridAlert alerts are on', body: "You'll get an alert here when a large blackout has no explanation.", url: siteUrl() }).catch((err) => console.error('welcome failed:', err));
  return { ok: true };
}

export type TestResult = { ok: true } | { error: string; gone?: true };

/** Send this browser, and only this browser, a test that looks and behaves like a real alert. */
export async function testAction(subscription: webpush.PushSubscription): Promise<TestResult> {
  const parsed = Subscription.safeParse(subscription);
  if (!parsed.success) return { error: "This browser's alert details weren't accepted." };
  try {
    const sent = await sendTest(parsed.data as webpush.PushSubscription, { title: 'GridAlert test: nothing is out', body: 'This is the test you asked for. A real alert arrives the same way and stays on screen until you dismiss it.', url: siteUrl(), urgent: true });
    if (sent === 'gone') return { error: "This device's sign-up had stopped working, so alerts are now off here. Turn them on again.", gone: true };
    if (sent === 'full') return { error: 'Sign-ups are full for now.' };
    return { ok: true };
  } catch (err) {
    console.error('test alert failed:', err);
    return { error: "The test couldn't be sent. Try again in a minute." };
  }
}

export async function leaveAction(endpoint: string): Promise<void> {
  if (typeof endpoint === 'string' && isPushEndpoint(endpoint)) await removeSubscriber(endpoint);
}
