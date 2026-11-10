import { revalidateTag } from 'next/cache';
import { NextResponse } from 'next/server';
import { STATE_TAG } from '@/lib/data';
import { runProbes } from '@/lib/probes';

export const maxDuration = 120;
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  // Fails closed: without a configured secret this route never runs.
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { probedAt, checks } = await runProbes();
  revalidateTag(STATE_TAG, { expire: 0 });
  const failing = Object.entries(checks).filter(([, c]) => c.failsInARow > 0).map(([name]) => name);
  return NextResponse.json({ probedAt, checks: Object.keys(checks).length, failing });
}
