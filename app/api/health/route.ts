import { NextResponse } from 'next/server';
import { PATHS, readDoc } from '@/lib/store';
import type { Snapshot } from '@/lib/types';

export const dynamic = 'force-dynamic';

const MAX_AGE_MS = 15 * 60_000;

/**
 * For an external uptime monitor: 503 means polling has stopped, or something stands between a
 * blackout and a high-priority alert. Reads storage directly, because a page's cached copy could
 * hide a real stoppage or invent one. Each answer is shared for 30 seconds, so anyone can
 * call this without each call costing a storage read.
 */
export async function GET() {
  const snapshot = (await readDoc<Snapshot>(PATHS.latest, { fresh: true }).catch(() => null))?.value;
  const ageMs = snapshot ? Date.now() - new Date(snapshot.generatedAt).getTime() : null;
  const impaired = snapshot?.impaired ?? [];
  const healthy = ageMs !== null && ageMs < MAX_AGE_MS && !impaired.length;
  return NextResponse.json(
    { healthy, generatedAt: snapshot?.generatedAt ?? null, ageSeconds: ageMs === null ? null : Math.round(ageMs / 1000), sourcesOk: snapshot?.sourcesOk, sourcesDown: snapshot?.sourcesDown, impaired },
    { status: healthy ? 200 : 503, headers: { 'cache-control': 'public, s-maxage=30, must-revalidate' } },
  );
}
