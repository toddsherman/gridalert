import { revalidatePath, revalidateTag } from 'next/cache';
import { NextResponse } from 'next/server';
import { STATE_TAG } from '@/lib/data';
import { runOnce } from '@/lib/run';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  // Fails closed: without a configured secret this route never runs.
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const result = await runOnce();
  if (!result.skipped) {
    // New data is in storage, so stale pages must never be served from here on.
    revalidateTag(STATE_TAG, { expire: 0 });
    revalidatePath('/', 'layout');
  }
  return NextResponse.json(result);
}
