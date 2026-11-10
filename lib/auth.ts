import { cookies } from 'next/headers';
import { makeSession, same, validSession } from './session.ts';
import { BASE_PATH } from './site.ts';

const COOKIE = 'gridalert_admin';
const MAX_AGE = 60 * 60 * 24 * 90;

export async function isAdmin(): Promise<boolean> {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return false;
  const jar = await cookies();
  return validSession(jar.get(COOKIE)?.value, token, Date.now());
}

export async function signIn(attempt: string): Promise<boolean> {
  const token = process.env.ADMIN_TOKEN;
  if (!token || !same(attempt, token)) return false;
  const jar = await cookies();
  jar.set(COOKIE, makeSession(token, Date.now() + MAX_AGE * 1000), { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: MAX_AGE, path: BASE_PATH });
  return true;
}

export async function signOut(): Promise<void> {
  (await cookies()).delete({ name: COOKIE, path: BASE_PATH });
}
