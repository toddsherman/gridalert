import { NextResponse } from 'next/server';
import { getOpenAlerts, getSnapshot } from '@/lib/data';

export const revalidate = 60;

/** Public JSON summary of current conditions. */
export async function GET() {
  const [snapshot, open] = await Promise.all([getSnapshot(), getOpenAlerts()]);
  if (!snapshot) return NextResponse.json({ error: 'no data yet' }, { status: 503 });
  return NextResponse.json({
    generatedAt: snapshot.generatedAt,
    customersOut: snapshot.customersOut,
    estimatedPeople: snapshot.estimatedPeople,
    sources: { ok: snapshot.sourcesOk, stale: snapshot.sourcesStale, frozen: snapshot.sourcesFrozen, down: snapshot.sourcesDown },
    alerts: open,
    metros: snapshot.metros
      .filter((m) => m.customersOut > 0)
      .map((m) => ({ cbsa: m.cbsa, name: m.name, customersOut: m.customersOut, estimatedPeople: m.estimatedPeople })),
    utilities: snapshot.utilities
      .filter((u) => u.customersOut > 0)
      .map((u) => ({ id: u.id, name: u.name, customersOut: u.customersOut, customersServed: u.customersServed, health: u.health })),
  });
}
