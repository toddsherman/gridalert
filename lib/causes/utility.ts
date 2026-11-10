import { num } from '../format.ts';
import type { Blackout, Evidence, UtilityCause } from '../types.ts';
import { LARGE_CUSTOMERS } from './rules.ts';

export type CauseCategory = 'pending' | 'planned' | 'weather' | 'tree' | 'equipment' | 'third-party' | 'wildlife' | 'other';

const PATTERNS: Array<[CauseCategory, RegExp]> = [
  // Crew activity and "we don't know yet" both say nothing about the cause. Kubra's -NDA- is no data,
  // and [object Object] is what a reader once stored for it.
  ['pending', /pending|investigat|not yet|unknown|undetermined|unspecified|unplanned|analyz|patrol|assess|being determined|current outage|\bnda\b|no data|\[object object\]|^\s*$/i],
  ['planned', /planned|scheduled|maintenance|construction|psps|safety shut/i],
  ['weather', /weather|storm|wind|lightning|snow|\bice\b|flood|hurricane|tornado/i],
  ['tree', /tree|vegetation|limb|branch|palm/i],
  ['wildlife', /animal|bird|squirrel|snake|raccoon/i],
  ['third-party', /vehicle|traffic|\bcar\b|accident|third|thrd|\bdig|contractor|balloon|fire/i],
  ['equipment', /equip|fail|transformer|txfmr|line|pole|wire|fuse|cable|repair/i],
];

export function classifyCause(text: string): CauseCategory {
  return PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? 'other';
}

/** Named causes shown on a blackout. */
const CAUSES_SHOWN = 3;

/** Whether a label names a cause, as opposed to saying one isn't known yet. */
export const namesACause = (text: string) => classifyCause(text) !== 'pending';

/** Fold what utilities say now into what they've said, so a cause stays known once its outage is fixed. */
export function withKnownCauses(known: UtilityCause[] = [], stated: UtilityCause[]): UtilityCause[] {
  // A label kept before it was known to say nothing goes too.
  const most = new Map(known.filter((c) => namesACause(c.cause)).map((c) => [c.cause, c.customers]));
  for (const c of stated) if (namesACause(c.cause)) most.set(c.cause, Math.max(most.get(c.cause) ?? 0, c.customers));
  return [...most].map(([cause, customers]) => ({ cause, customers })).sort((a, b) => b.customers - a.customers);
}

const outsideCauses = (b: Pick<Blackout, 'evidence'>) => b.evidence.filter((e) => e.strong && e.kind !== 'utility');

/**
 * How much of a blackout has a known cause. Something outside like a storm accounts for the whole
 * area. A utility's word accounts only for the customers it names, out of the most ever out.
 */
export function shareExplained(b: Pick<Blackout, 'evidence' | 'knownCauses' | 'peakCustomers'>): number {
  if (outsideCauses(b).length) return 1;
  const named = (b.knownCauses ?? []).reduce((sum, c) => sum + c.customers, 0);
  return b.peakCustomers ? Math.min(1, named / b.peakCustomers) : 0;
}

/** Whether a blackout belongs on the feed: still going, and not accounted for. */
export const onTheFeed = (b: Pick<Blackout, 'resolvedAt' | 'cause'>) => !b.resolvedAt && b.cause !== 'explained';

/** What is known to explain a blackout, and nothing about what it isn't. */
export function causesKnown(b: Pick<Blackout, 'evidence' | 'knownCauses'>): string[] {
  const stated = (b.knownCauses ?? []).slice(0, CAUSES_SHOWN).map((c) => `${c.cause} (${num(c.customers)})`);
  return [...outsideCauses(b).map((e) => e.label), ...stated];
}

/** A utility's map needs to cover this share of the blackout to speak for it. */
const MIN_SEEN_SHARE = 0.3;
/** One named cause needs this share of the customers seen. */
const MIN_CAUSE_SHARE = 0.5;
/**
 * Causes an operator could plausibly never see through. On a large blackout these
 * are auto-filled map labels, not findings, so they stay as context.
 */
const LOCAL_ONLY: ReadonlySet<CauseCategory> = new Set(['equipment', 'third-party', 'wildlife', 'tree']);

/**
 * Decide whether what utilities' maps list amounts to an explanation. On a large blackout a
 * map's word alone never settles it, since an explanation is final and one bad reading of one
 * feed would otherwise end the checks for good. Weather or a planned cut needs weatherAgrees.
 */
export function utilityEvidence(causes: UtilityCause[], blackoutCustomers: number, at: string, weatherAgrees = false): Evidence | null {
  const seen = causes.reduce((sum, c) => sum + c.customers, 0);
  if (!seen || seen < blackoutCustomers * MIN_SEEN_SHARE) return null;

  const byCategory = new Map<CauseCategory, UtilityCause[]>();
  for (const c of causes) {
    const category = classifyCause(c.cause);
    if (category === 'pending' || category === 'other') continue;
    byCategory.set(category, [...(byCategory.get(category) ?? []), c]);
  }
  const ranked = [...byCategory.entries()].map(([category, rows]) => ({ category, rows, customers: rows.reduce((sum, c) => sum + c.customers, 0) })).sort((a, b) => b.customers - a.customers);
  const top = ranked[0];
  if (!top || top.customers / seen < MIN_CAUSE_SHARE) return null;

  const label = top.rows.reduce((a, b) => (b.customers > a.customers ? b : a)).cause;
  return {
    id: `utility:${top.category}`,
    kind: 'utility',
    strong: blackoutCustomers < LARGE_CUSTOMERS || (weatherAgrees && !LOCAL_ONLY.has(top.category)),
    label: `Utility map says ${label} for ${Math.round((top.customers / seen) * 100)}% of listed customers`,
    source: 'Utility outage map',
    at,
  };
}
