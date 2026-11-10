import type { Trail } from '../types.ts';

/** Six hours at five-minute polls. */
const TRAIL_POLLS = 72;
/** Share of the alert threshold below which an area's readings aren't worth keeping. */
const FLOOR_SHARE = 0.1;
/** The rise begins where the count first clears this share of its climb. */
const RISE_SHARE = 0.1;

/** A reading counts as still climbing if it's at least this far under the next one. */
const CLIMB_STEP = 0.98;

export const EMPTY_TRAIL: Trail = { t: [], people: {} };

export function advanceTrail(prev: Trail, readings: Array<{ key: string; people: number; complete?: boolean }>, at: number, thresholdPeople: number): Trail {
  const t = [...prev.t, at].slice(-TRAIL_POLLS);
  const floor = thresholdPeople * FLOOR_SHARE;
  const people: Trail['people'] = {};
  for (const { key, people: value, complete } of readings) {
    const past = prev.people[key] ?? [];
    // A failed feed lowers a count without anyone being restored, and its return would read as a jump.
    const held = complete === false ? Math.max(value, past.at(-1) ?? 0) : value;
    const series = [...past, held].slice(-TRAIL_POLLS);
    if (series.some((v) => v >= floor)) people[key] = series;
  }
  return { t, people };
}

/**
 * The climb ending at the latest reading: when it left the level it had been sitting
 * at, and how far it has risen. Unlike estimateOnset this finds a new jump on top of an
 * outage already under way.
 */
export function latestRise(trail: Trail, key: string): { at: number; people: number } | null {
  const series = trail.people[key];
  if (!series || series.length < 2) return null;
  let i = series.length - 1;
  while (i > 0 && series[i - 1] < series[i] * CLIMB_STEP) i--;
  if (i === series.length - 1) return null;
  return { at: trail.t[trail.t.length - series.length + i + 1], people: series.at(-1)! - series[i] };
}

/**
 * The most the count has risen within any stretch of windowMs since a time. A series shorter
 * than the trail was below the keep level before it began, so that counts as a rise from nothing.
 */
export function biggestJump(trail: Trail, key: string, since: number, windowMs: number): number {
  const series = trail.people[key];
  if (!series) return 0;
  const offset = trail.t.length - series.length;
  const quietUntil = trail.t[offset - 1];
  let best = 0;
  series.forEach((value, i) => {
    const at = trail.t[offset + i];
    if (at < since) return;
    if (offset > 0 && at - quietUntil <= windowMs) best = Math.max(best, value);
    for (let j = i - 1; j >= 0 && at - trail.t[offset + j] <= windowMs; j--) best = Math.max(best, value - series[j]);
  });
  return best;
}

/**
 * Time of the first poll in the climb to the current reading. An area's normal
 * background stays below the rise level, so a metro that always has a few
 * thousand people out still dates to its jump. If the count was already high when
 * the trail begins, this is the earliest time on record.
 */
export function estimateOnset(trail: Trail, key: string): number {
  const series = trail.people[key];
  const last = trail.t.at(-1)!;
  if (!series?.length) return last;
  // A series shorter than the trail was below the keep level before it began.
  const base = series.length < trail.t.length ? 0 : Math.min(...series);
  const level = base + (series.at(-1)! - base) * RISE_SHARE;
  let i = series.length - 1;
  while (i > 0 && series[i - 1] >= level) i--;
  return trail.t[trail.t.length - series.length + i];
}
