import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const digest = (value: string) => createHash('sha256').update(`gridalert:${value}`).digest();

const signature = (expires: string, token: string) => createHmac('sha256', digest(token)).update(`session:${expires}`).digest('base64url');

/** Hashing first gives equal lengths, so a malformed value is a plain mismatch. */
export const same = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

/** A session value good until a time, which the server checks rather than trusting the cookie's own age. */
export const makeSession = (token: string, expires: number) => `${expires}.${signature(String(expires), token)}`;

export function validSession(value: string | undefined, token: string, now: number): boolean {
  const [expires, mac, ...rest] = (value ?? '').split('.');
  if (!expires || !mac || rest.length) return false;
  return same(mac, signature(expires, token)) && Number(expires) > now;
}
