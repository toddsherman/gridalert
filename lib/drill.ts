import { evaluate, type Candidate } from './alerts/engine.ts';
import { DRILL_KEY } from './alerts/notify.ts';
import { applyChecks, needsCheck, syncBlackouts, takeNotices } from './blackouts.ts';
import type { World } from './causes/feeds.ts';
import { num } from './format.ts';
import { type AlertEvent, type Blackout, EMPTY_ENGINE, type Settings, type Snapshot } from './types.ts';

/**
 * A monthly drill. No real high-priority alert may go out for months, so nothing else shows that
 * one still would. This puts a made-up blackout through the real rules (the engine, the blackout
 * record, the cause checks, the notice), and then sends what happened to the owner through the
 * real outbox at the priority a real alert has. It never touches stored state, the site's
 * numbers or browser subscribers. The feeds and the cause sources aren't part of it: the polls
 * and the hourly checks watch those.
 */

/** The first poll after this hour on the 1st runs the drill: noon or 1pm Eastern. */
const DRILL_HOUR_UTC = 17;
const POLL_MS = 5 * 60_000;
/** A real alert is due about 10 minutes in, so a drill that takes this many polls has failed. */
const MAX_POLLS = 8;
/** Houston, as the place the rules are run against. Nothing about it is read. */
const CBSA = '26420';
const COUNTY = { fips: '48201', name: 'Harris' };
const KEY = `metro:${CBSA}`;

/** Every source read, and nothing found. */
const QUIET: World = { weather: [], reports: [], gusts: [], fires: [], quakes: [], kp: [] };

export interface DrillResult {
  ok: boolean;
  /** Customers in the made-up blackout. */
  customers: number;
  /** Simulated minutes from the blackout starting to the alert. */
  minutes?: number;
  reason?: string;
}

/** The month a drill belongs to, or undefined before this month's is due. */
export function drillMonth(now: Date): string | undefined {
  const due = now.getUTCDate() > 1 || now.getUTCHours() >= DRILL_HOUR_UTC;
  return due ? now.toISOString().slice(0, 7) : undefined;
}

function pollOf(customers: number, settings: Settings, at: string): { snapshot: Snapshot; candidates: Candidate[] } {
  const people = Math.round(customers * settings.peoplePerCustomer);
  const metros = customers ? [{ cbsa: CBSA, name: 'Drill', states: ['TX'], population: 7_000_000, customersOut: customers, estimatedPeople: people, utilities: [{ id: 'drill', name: 'Drill utility', customersOut: customers }], counties: [{ ...COUNTY, customersOut: customers }], coverage: 1, gaps: [] }] : [];
  const snapshot: Snapshot = { generatedAt: at, durationMs: 0, customersOut: customers, estimatedPeople: people, sourcesOk: 1, sourcesStale: 0, sourcesFrozen: 0, sourcesDown: 0, stuckFeeds: [], customersMonitored: 1, customersTotal: 1, metros, utilities: [], counties: {}, unmatchedAreas: [] };
  const candidates: Candidate[] = [{ key: KEY, scope: 'metro', label: 'Drill', people, customers, detail: '', link: `/metros/${CBSA}`, states: ['TX'], complete: true }];
  return { snapshot, candidates };
}

/** Run a made-up blackout through the rules, poll by poll, and say whether the alert came. Reads and writes nothing. */
export function rehearse(live: Settings, now: Date): DrillResult {
  // Where alerts are limited to is the owner's choice, and isn't what's being tested.
  const settings: Settings = { ...live, states: [], mutedMetros: [] };
  const level = settings.unexplainedCustomers;
  const customers = Math.round(level * 1.6);
  if (level <= 0) return { ok: false, customers, reason: 'high-priority alerts are turned off in the settings' };

  let engine = EMPTY_ENGINE;
  let blackouts: Blackout[] = [];
  const start = now.getTime();
  // Two quiet polls, then the lights go out. The count ticks, as a live one does.
  for (let poll = -2; poll < MAX_POLLS; poll++) {
    const time = new Date(start + poll * POLL_MS);
    const at = time.toISOString();
    const { snapshot, candidates } = pollOf(poll < 0 ? 0 : customers + poll * 137, settings, at);
    engine = evaluate(engine, candidates, settings, time).state;
    blackouts = syncBlackouts(blackouts, engine, snapshot, settings.peoplePerCustomer, at).map((b) => (needsCheck(b, time.getTime()) ? applyChecks(b, QUIET, [], time) : b));
    const taken = takeNotices(blackouts, settings, at);
    blackouts = taken.list;
    if (taken.events.some((e) => e.kind === 'unexplained' && e.key === KEY)) return { ok: true, customers, minutes: (poll * POLL_MS) / 60_000 };
  }
  const b = blackouts[0];
  const reason = b ? `after ${(MAX_POLLS * POLL_MS) / 60_000} minutes its cause was still "${b.cause}" and no alert was raised` : 'the outage never opened as a blackout';
  return { ok: false, customers, reason };
}

/** What the owner is sent. Marked as a drill in its title, and never public. A pass is 'resolved' and a failure 'opened'. */
export function drillEvent(result: DrillResult, at: string): AlertEvent {
  const size = `A made-up blackout of ${num(result.customers)} customers with no ordinary cause was put through the alert rules`;
  const detail = result.ok
    ? `This is the monthly test. Nothing is out. ${size}, and they raised the high-priority alert ${result.minutes} minutes in, as they should. This message came the way a real alert would, so if you're reading it, delivery works too.`
    : `This is the monthly test, and it failed. Nothing is out. ${size}, and they did not raise the high-priority alert: ${result.reason}. A real blackout might not alert either.`;
  return { id: `${DRILL_KEY}:${at}`, kind: result.ok ? 'resolved' : 'opened', key: DRILL_KEY, scope: 'utility', label: 'GridAlert drill', at, people: 0, peakPeople: 0, customers: 0, openedAt: at, detail, link: '/alerts', urgent: true };
}

/** The drill, which can't be allowed to break a poll. */
export function runDrill(settings: Settings, now: Date): AlertEvent {
  let result: DrillResult;
  try {
    result = rehearse(settings, now);
  } catch (err) {
    result = { ok: false, customers: Math.round(settings.unexplainedCustomers * 1.6), reason: `the rules threw an error (${(err as Error).message})` };
  }
  return drillEvent(result, now.toISOString());
}
