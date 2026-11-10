'use server';

import type webpush from 'web-push';
import { z } from 'zod';
import { siteUrl } from '@/lib/alerts/notify';
import { addSubscriber, isPushEndpoint, removeSubscriber, sendToOne } from '@/lib/alerts/push';

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

export async function leaveAction(endpoint: string): Promise<void> {
  if (typeof endpoint === 'string' && isPushEndpoint(endpoint)) await removeSubscriber(endpoint);
}
