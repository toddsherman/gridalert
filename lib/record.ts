import { alertBar, LARGE_CUSTOMERS } from './causes/rules.ts';
import { num, plural } from './format.ts';
import type { Blackout, Settings, SimultaneousOutage } from './types.ts';

/**
 * The track record shown on the page: what GridAlert has tracked, which outages came near the
 * alert level, and what it made of each. It's read straight from the stored blackout records,
 * so it can't claim anything those don't hold, and a miss shows up here like anything else.
 */

/** An outage is listed once it's this share of the alert level, so the near misses show too. */
const LISTED_SHARE = 0.5;
const ROWS = 6;

export interface RecordRow {
  id: string;
  label: string;
  link: string;
  startedAt: string;
  /** The most customers out at once. */
  customers: number;
  /** One or two sentences on how it measured against the alert level and what was found. */
  outcome: string;
  /** A high-priority alert went out for it. */
  alerted: boolean;
}

export interface TrackRecord {
  /** When the oldest record kept began. */
  since?: string;
  tracked: number;
  /** Outages that reached the level for a high-priority alert. */
  reached: number;
  /** Of those, how many had an ordinary cause found. */
  explained: number;
  /** High-priority alerts sent, simultaneous ones included. */
  alerts: number;
  rows: RecordRow[];
}

/** "35 minutes", or hours once that reads better. */
export function spanOf(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes < 90 ? plural(minutes, 'minute') : plural(Math.round(minutes / 60), 'hour');
}

const since = (b: Blackout, at: string) => spanOf(Date.parse(at) - Date.parse(b.checkFrom ?? b.startedAt));

/** When the cause was found. Records from before this was stored stopped being checked at that moment. */
const explainedAt = (b: Blackout) => (b.cause === 'explained' ? (b.explainedAt ?? b.checkedAt) : undefined);

export function outcomeOf(b: Blackout, level: number): string {
  const bar = alertBar(b, level);
  const size = bar === 0 ? 'Under the alert level.' : (b.jumpCustomers ?? 0) >= level ? `Reached the alert level: ${num(b.jumpCustomers!)} customers went out within 30 minutes.` : `Reached the alert level: over ${num(bar)} customers out.`;
  const found = explainedAt(b);
  const cause = b.evidence.find((e) => e.strong)?.label ?? 'an ordinary cause';
  const explained = found ? `Explained ${since(b, found)} in: ${cause}.` : b.cause === 'checking' ? 'Still being checked.' : 'No cause was found.';
  if (b.unexplainedNoticeAt) {
    const sent = `An alert went out ${since(b, b.unexplainedNoticeAt)} in.`;
    return b.explainedNoticeAt ? `${size} ${sent} It was stood down ${spanOf(Date.parse(b.explainedNoticeAt) - Date.parse(b.unexplainedNoticeAt))} later: ${cause}.` : `${size} ${sent} ${explained}`;
  }
  if (b.deliberateNoticeAt) return `${size} ${explained} An alert went out because it was reported as deliberate, unconfirmed.`;
  return `${size} ${explained} No alert was sent.`;
}

/** Blackouts newest first, as they're stored. */
export function trackRecord(blackouts: Blackout[], outages: SimultaneousOutage[], settings: Pick<Settings, 'unexplainedCustomers'>): TrackRecord {
  const level = settings.unexplainedCustomers;
  const floor = (level > 0 ? level : LARGE_CUSTOMERS) * LISTED_SHARE;
  const reached = blackouts.filter((b) => alertBar(b, level) > 0);
  const alerted = (b: Blackout) => Boolean(b.unexplainedNoticeAt ?? b.deliberateNoticeAt);
  const listed = blackouts.filter((b) => alerted(b) || alertBar(b, level) > 0 || Math.max(b.peakCustomers, b.jumpCustomers ?? 0) >= floor);
  return {
    since: blackouts.map((b) => b.startedAt).sort()[0],
    tracked: blackouts.length,
    reached: reached.length,
    explained: reached.filter((b) => b.cause === 'explained').length,
    alerts: blackouts.filter(alerted).length + outages.length,
    rows: listed.slice(0, ROWS).map((b) => ({ id: b.id, label: b.label, link: b.link, startedAt: b.startedAt, customers: b.peakCustomers, outcome: outcomeOf(b, level), alerted: alerted(b) })),
  };
}
