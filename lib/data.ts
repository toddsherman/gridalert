import { unstable_cache } from 'next/cache';
import type { HealthDoc } from './health.ts';
import { watched } from './registry.ts';
import { getSettings, type History } from './run.ts';
import { PATHS, readDoc } from './store.ts';
import type { AlertEvent, Blackout, EngineState, OpenAlert, SimultaneousOutage, Snapshot } from './types.ts';

// The collector expires this tag after every poll (see the cron route), which
// is what keeps a page from showing old data to the first visitor after a quiet
// spell. REVALIDATE is only the fallback if that ever fails.
export const STATE_TAG = 'state';
const REVALIDATE = 60;

async function readOrNull<T>(path: string): Promise<T | null> {
  try {
    return (await readDoc<T>(path, { fresh: true }))?.value ?? null;
  } catch (err) {
    console.error(`read ${path} failed:`, err);
    return null;
  }
}

export const getSnapshot = unstable_cache(() => readOrNull<Snapshot>(PATHS.latest), ['snapshot'], { revalidate: REVALIDATE, tags: [STATE_TAG] });

export const getHistory = unstable_cache(() => readOrNull<History>(PATHS.history), ['history'], { revalidate: REVALIDATE * 5, tags: [STATE_TAG] });

// Records for an area no longer watched stay stored but aren't shown.
export const getAlertLog = unstable_cache(async () => ((await readOrNull<AlertEvent[]>(PATHS.alerts)) ?? []).filter((e) => watched(e.key)), ['alerts'], { revalidate: REVALIDATE, tags: [STATE_TAG] });

export const getBlackouts = unstable_cache(async () => ((await readOrNull<Blackout[]>(PATHS.blackouts)) ?? []).filter((b) => watched(b.key)), ['blackouts'], { revalidate: REVALIDATE, tags: [STATE_TAG] });

export const getSimultaneous = unstable_cache(async () => (await readOrNull<SimultaneousOutage[]>(PATHS.simultaneous)) ?? [], ['simultaneous'], { revalidate: REVALIDATE, tags: [STATE_TAG] });

export const getHealth = unstable_cache(() => readOrNull<HealthDoc>(PATHS.health), ['health'], { revalidate: REVALIDATE * 5, tags: [STATE_TAG] });

export const getOpenAlerts = unstable_cache(
  async (): Promise<OpenAlert[]> => {
    const state = await readOrNull<{ engine: EngineState }>(PATHS.engine);
    return Object.values(state?.engine.open ?? {})
      .filter((a) => watched(a.key))
      .sort((a, b) => b.people - a.people);
  },
  ['open-alerts'],
  { revalidate: REVALIDATE, tags: [STATE_TAG] },
);

export const getCachedSettings = unstable_cache(() => getSettings(true), ['settings'], { revalidate: REVALIDATE, tags: ['settings'] });
