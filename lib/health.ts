import { customersOf, sources } from './registry.ts';
import type { Snapshot, UtilityStatus } from './types.ts';
import { eastern, num } from './format.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Feeds big enough that one reading 0 or failing is worth a line in the digest. */
const LARGE_FEED = 250_000;
/** Polls in a row a problem has to last before it counts. */
export const ISSUE_POLLS = 3;
/** On a calm day the most seen was 33% of a platform's large feeds at 0, so this is well past that. */
const PLATFORM_ZERO_OPEN = 0.6;
const PLATFORM_ZERO_CLEAR = 0.4;
const PLATFORM_MIN_FEEDS = 4;
const FEED_OUT_MS = 6 * HOUR;
const ODIN_AHEAD_POLLS = 3;
/** How long a feed of this size can read 0 before that's strange. Upper bounds from EAGLE-I 2025. */
const ZERO_LIMITS: Array<[customers: number, ms: number]> = [
  [1_000_000, DAY],
  [LARGE_FEED, 3 * DAY],
  [100_000, 7 * DAY],
];

/** What the hourly check found for one outside service. */
export interface CheckHealth {
  lastOkAt?: string;
  lastFailAt?: string;
  failsInARow: number;
  lastError?: string;
  /** The last failure was a document that changed, not a site that was down. */
  shape?: boolean;
  /** Rows in the last good read. */
  rows?: number;
  noticedAt?: string;
}

export interface HealthDoc {
  probedAt: string;
  checks: Record<string, CheckHealth>;
  /** The lines of the last digest sent, so an unchanged one stays silent. */
  digest?: string[];
  digestAt?: string;
  watchingAt?: string;
}

const served = new Map(sources.map((s) => [s.id, customersOf(s)]));
const customersFor = (u: UtilityStatus) => served.get(u.id) ?? 0;

export interface PlatformReading {
  method: string;
  feeds: number;
  zero: number;
}

/** How many of each platform's large feeds read exactly 0 or aren't working. */
export function platformReadings(snapshot: Pick<Snapshot, 'utilities'>): PlatformReading[] {
  const byMethod = new Map<string, UtilityStatus[]>();
  for (const u of snapshot.utilities) {
    if (u.method !== 'odin' && customersFor(u) >= LARGE_FEED) byMethod.set(u.method, [...(byMethod.get(u.method) ?? []), u]);
  }
  return [...byMethod].filter(([, feeds]) => feeds.length >= PLATFORM_MIN_FEEDS).map(([method, feeds]) => ({ method, feeds: feeds.length, zero: feeds.filter((u) => u.customersOut === 0 || u.health !== 'ok').length }));
}

export const platformWrong = (p: PlatformReading, alreadyOpen: boolean) => p.zero / p.feeds >= (alreadyOpen ? PLATFORM_ZERO_CLEAR : PLATFORM_ZERO_OPEN);

function zeroTooLong(u: UtilityStatus, now: number): boolean {
  if (!u.zeroSince) return false;
  const limit = ZERO_LIMITS.find(([customers]) => customersFor(u) >= customers);
  return !!limit && now - Date.parse(u.zeroSince) >= limit[1];
}

/** One line for each feed that a person should look at, for the daily digest. */
export function feedNotes(snapshot: Pick<Snapshot, 'utilities'>, now: number): string[] {
  return snapshot.utilities.flatMap((u): string[] => {
    const size = `${u.name} (${num(customersFor(u))} customers)`;
    const large = customersFor(u) >= LARGE_FEED;
    const stopped = u.frozenSince ?? (u.health === 'down' ? u.lastOkAt : undefined);
    if (large && stopped && now - Date.parse(stopped) >= FEED_OUT_MS) return [`${size} has been out since ${eastern(stopped)} ET.`];
    if ((u.odinAhead ?? 0) >= ODIN_AHEAD_POLLS) return [`${size} reads 0 while ODIN shows outages there.`];
    if (zeroTooLong(u, now)) return [`${size} has read exactly 0 since ${eastern(u.zeroSince!)} ET.`];
    return [];
  });
}
