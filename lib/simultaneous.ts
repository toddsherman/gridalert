import { heldBack, readingSteady, RECHECK_AFTER_CLOSE_MS, SIMULTANEOUS_WINDOW_MS } from './causes/rules.ts';
import { eastern, orList, shortMetro } from './format.ts';
import { sources } from './registry.ts';
import type { AlertEvent, AlertKind, Blackout, Settings, SimultaneousOutage } from './types.ts';

const MAX_KEPT = 200;
const NAMED_AREAS = 4;
/** Time-of-start is only known to one poll, so never claim anything tighter. */
const POLL_MINUTES = 5;

/** A big enough jump inside an open blackout is a fresh start, and is its own size. */
const surged = (b: Blackout, settings: Settings) => (b.surgeCustomers ?? 0) >= settings.simultaneousCustomers;
const startOf = (b: Blackout, settings: Settings) => Date.parse(surged(b, settings) ? b.surgeAt! : b.startedAt);

/**
 * A blackout can count only if nothing ordinary is around it at all. A Wind Advisory
 * isn't enough to explain an outage, but a windy front can start several at once.
 */
function counts(b: Blackout, settings: Settings): boolean {
  return b.cause === 'unknown' && b.peakCustomers >= settings.simultaneousCustomers && !b.evidence.some((e) => e.kind === 'weather' || e.kind === 'space-weather');
}

const leadUtility = (b: Blackout) => b.utilities[0]?.id ?? b.key;

/** One blackout per area and per lead utility, so one operator's trouble counts once. */
export function unrelated(list: Blackout[]): Blackout[] {
  const seen = new Set<string>();
  return list
    .slice()
    .sort((a, b) => b.peakCustomers - a.peakCustomers)
    .filter((b) => {
      const ids = [b.key, leadUtility(b)];
      if (ids.some((id) => seen.has(id))) return false;
      ids.forEach((id) => seen.add(id));
      return true;
    });
}

/** The one shared service a set of feeds could all fail through, if there is one. */
function sharedPlatform(members: Blackout[]): string | undefined {
  const platforms = new Set(
    members.map((b) => {
      const lead = leadUtility(b);
      if (lead.startsWith('odin-')) return 'ODIN';
      return sources.find((s) => s.id === lead)?.method === 'kubra' ? 'Kubra' : lead;
    }),
  );
  const [only] = platforms;
  return platforms.size === 1 && (only === 'ODIN' || only === 'Kubra') ? only : undefined;
}

export function areaNames(members: Blackout[]): string {
  const names = members.map((b) => shortMetro(b.label));
  if (names.length <= NAMED_AREAS) return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names.join('');
  return `${names.slice(0, NAMED_AREAS).join(', ')} and ${names.length - NAMED_AREAS} more`;
}

function event(kind: AlertKind, id: string, startedAt: string, members: Blackout[], detail: string, at: string): AlertEvent {
  return {
    id: `${id}:${kind}`,
    kind,
    key: id,
    scope: 'metro',
    label: areaNames(members),
    at,
    people: members.reduce((sum, b) => sum + b.people, 0),
    peakPeople: members.reduce((sum, b) => sum + b.peakPeople, 0),
    customers: members.reduce((sum, b) => sum + b.peakCustomers, 0),
    openedAt: startedAt,
    detail,
    link: '/#alerts',
    areas: members.map((b) => b.label),
  };
}

function announcement(members: Blackout[], settings: Settings): string {
  const starts = members.map((b) => startOf(b, settings));
  const minutes = Math.max(POLL_MINUTES, Math.round((Math.max(...starts) - Math.min(...starts)) / 60_000));
  const first = new Date(Math.min(...starts)).toISOString();
  const shared = sharedPlatform(members);
  const steady = members.filter((b) => readingSteady(b.reading, settings.simultaneousCustomers));
  const lines = [
    `${members.length} unrelated areas started within ${minutes} minutes, the first at ${eastern(first)} ET.`,
    `No ${orList(members[0].checked)} found in any of them.`,
    `Utilities: ${members.flatMap((b) => b.utilities.slice(0, 1).map((u) => u.name)).join(', ')}.`,
    shared ? `All of these reach us through ${shared}, so a fault there is possible.` : '',
    steady.length ? `The count in ${areaNames(steady)} has not moved, so that may be a false reading.` : '',
    'Nothing ordinary explains this yet, which does not mean an attack.',
  ];
  return lines.filter(Boolean).join(' ');
}

function standDownDetail(left: Blackout[], explained: Blackout[], need: number): string {
  const reasons = explained.map((b) => `${shortMetro(b.label)}: ${b.evidence.find((e) => e.strong || e.kind === 'weather')?.label ?? 'no longer counts'}`);
  return `Fewer than ${need} areas remain unexplained (${left.length} left). ${reasons.join('. ')}. This replaces the earlier simultaneous blackout alert.`;
}

/**
 * Advance the list of simultaneous outages by one poll. Pure, so it can be replayed.
 *
 * A group forms when enough unrelated blackouts began within the window of the
 * earliest one, with at least one still under way. Later starters inside the window
 * join without a new notice. If explanations leave too few, it stands down once.
 */
export function findSimultaneous(prev: SimultaneousOutage[], blackouts: Blackout[], settings: Settings, at: string): { list: SimultaneousOutage[]; events: AlertEvent[] } {
  const need = settings.simultaneousAreas;
  const now = Date.parse(at);
  const byId = new Map(blackouts.map((b) => [b.id, b]));
  // A group that stood down keeps no claim on its blackouts, which could yet be part of something bigger.
  const stoodDown = new Set(prev.filter((o) => o.standDownAt).flatMap((o) => o.members));
  const claimed = new Set(prev.filter((o) => !o.standDownAt).flatMap((o) => o.members));
  const eligible = blackouts.filter((b) => !claimed.has(b.id) && counts(b, settings) && (b.blindSince || !heldBack(b.reading, settings.simultaneousCustomers, now)));
  const events: AlertEvent[] = [];

  const updated = prev.map((outage) => {
    if (outage.standDownAt || outage.closedAt) return outage;
    const start = Date.parse(outage.startedAt);
    const joiners = eligible.filter((b) => !claimed.has(b.id) && Math.abs(startOf(b, settings) - start) <= SIMULTANEOUS_WINDOW_MS);
    joiners.forEach((b) => claimed.add(b.id));
    const members = [...outage.members.flatMap((id) => byId.get(id) ?? []), ...joiners];
    // Nothing can change once its blackouts are past checking, and records leaving the list later isn't a stand-down.
    if (members.every((b) => b.resolvedAt && now - Date.parse(b.resolvedAt) >= RECHECK_AFTER_CLOSE_MS)) return { ...outage, closedAt: at };
    const left = unrelated(members.filter((b) => counts(b, settings)));
    const next = { ...outage, members: [...outage.members, ...joiners.map((b) => b.id)] };
    if (left.length >= need) {
      // Ordinary outages aren't sent, so this is the only word that it's over.
      if (next.restoredAt || !members.every((b) => b.resolvedAt)) return next;
      events.push(event('resolved', outage.id, outage.startedAt, members, '', at));
      return { ...next, restoredAt: at };
    }
    const explained = members.filter((b) => b.cause === 'explained' || !counts(b, settings));
    events.push(event('simultaneous-explained', outage.id, outage.startedAt, members, standDownDetail(left, explained, need), at));
    return { ...next, standDownAt: at };
  });

  const created: SimultaneousOutage[] = [];
  if (need >= 2) {
    const free = eligible.filter((b) => !claimed.has(b.id)).sort((a, b) => startOf(a, settings) - startOf(b, settings));
    for (const first of free) {
      if (claimed.has(first.id)) continue;
      const start = startOf(first, settings);
      const inWindow = free.filter((b) => !claimed.has(b.id) && startOf(b, settings) >= start && startOf(b, settings) - start <= SIMULTANEOUS_WINDOW_MS);
      const members = unrelated(inWindow);
      if (members.length < need || !members.some((b) => !b.resolvedAt)) continue;
      // It takes a new area for a group that stood down to come back.
      if (members.every((b) => stoodDown.has(b.id))) continue;
      const startedAt = new Date(start).toISOString();
      const id = prev.some((o) => o.id === `simultaneous:${startedAt}`) ? `simultaneous:${startedAt}:${at}` : `simultaneous:${startedAt}`;
      members.forEach((b) => claimed.add(b.id));
      created.push({ id, startedAt, members: members.map((b) => b.id), noticeAt: at });
      events.push(event('simultaneous', id, startedAt, members, announcement(members, settings), at));
    }
  }

  return { list: [...created, ...updated].slice(0, MAX_KEPT), events };
}

/** A group in full, for display. Members that have left the list are dropped. */
export function outageDetail(outage: SimultaneousOutage, blackouts: Blackout[]) {
  const members = outage.members.flatMap((id) => blackouts.find((b) => b.id === id) ?? []);
  return { ...outage, areas: areaNames(members), customers: members.reduce((sum, b) => sum + b.peakCustomers, 0), people: members.reduce((sum, b) => sum + b.peakPeople, 0), started: eastern(outage.startedAt), count: members.length };
}
