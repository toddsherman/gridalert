import type { AlertEvent, AlertKind, AlertScope, EngineState, OpenAlert, Settings } from '../types.ts';
import { advanceTrail, EMPTY_TRAIL, estimateOnset } from './trail.ts';

/** One alertable area this poll: a metro, or a multi-metro utility with no county data. */
export interface Candidate {
  key: string;
  scope: AlertScope;
  label: string;
  people: number;
  customers: number;
  detail: string;
  link: string;
  states: string[];
  /**
   * False when part of this area's feeds failed, so a falling number can't be
   * trusted. An alert isn't resolved on incomplete data, though one that gets none for
   * 12 hours is closed as unknown.
   */
  complete: boolean;
}

/** An alert can't close on incomplete data, so this stops a dead feed holding one open for good. */
const BLIND_CLOSE_MS = 12 * 3_600_000;

export interface EvaluateResult {
  state: EngineState;
  events: AlertEvent[];
}

function eligible(c: Candidate, s: Settings): boolean {
  if (s.states.length && !c.states.some((st) => s.states.includes(st))) return false;
  if (c.scope === 'metro' && s.mutedMetros.includes(c.key.replace('metro:', ''))) return false;
  return true;
}

/**
 * Advance the alert state machine by one poll. Pure: all I/O is in the caller.
 *
 * open:      over threshold for confirmPolls polls, or immediately at immediateFactor x threshold
 * escalate:  grew past escalateFactor x the last notified level
 * resolve:   under clearRatio x threshold for clearPolls polls, on complete data
 */
export function evaluate(prev: EngineState, candidates: Candidate[], settings: Settings, now: Date): EvaluateResult {
  const at = now.toISOString();
  const events: AlertEvent[] = [];
  const open: Record<string, OpenAlert> = {};
  const pending: Record<string, number> = {};
  const clearLevel = settings.thresholdPeople * settings.clearRatio;
  const trail = advanceTrail(prev.trail ?? EMPTY_TRAIL, candidates, now.getTime(), settings.thresholdPeople);

  const event = (kind: AlertKind, a: OpenAlert, c: Candidate): AlertEvent => ({
    id: `${a.key}:${a.openedAt}:${kind}:${at}`,
    kind,
    key: a.key,
    scope: a.scope,
    label: a.label,
    at,
    people: c.people,
    peakPeople: a.peakPeople,
    customers: c.customers,
    openedAt: a.openedAt,
    detail: c.detail,
    link: c.link,
  });

  const closedBlind = (a: OpenAlert): AlertEvent => ({
    id: `${a.key}:${a.openedAt}:resolved:${at}`,
    kind: 'resolved',
    key: a.key,
    scope: a.scope,
    label: a.label,
    at,
    people: a.people,
    peakPeople: a.peakPeople,
    customers: 0,
    openedAt: a.openedAt,
    detail: `GridAlert has had no complete reading for this area for 12 hours, so it can't say whether the power is back. Closed so a new outage can alert. It peaked near ${a.peakPeople.toLocaleString('en-US')} people.`,
    link: a.scope === 'metro' ? `/metros/${a.key.replace('metro:', '')}` : '/coverage',
    blind: true,
  });

  const seen = new Set<string>();
  for (const c of candidates) {
    seen.add(c.key);
    const existing = prev.open[c.key];

    if (existing) {
      // A failed feed lowers a count without anyone being restored, so only complete data can bring it down.
      const a: OpenAlert = { ...existing, label: c.label, lastSeenAt: at, people: c.complete ? c.people : Math.max(c.people, existing.people), peakPeople: Math.max(existing.peakPeople, c.people), blindSince: c.complete ? undefined : (existing.blindSince ?? at) };
      if (a.blindSince && c.people < clearLevel && now.getTime() - Date.parse(a.blindSince) >= BLIND_CLOSE_MS) {
        events.push(closedBlind(a));
        continue;
      }
      if (c.people < clearLevel && c.complete) {
        a.belowPolls = existing.belowPolls + 1;
      } else if (c.people >= clearLevel) {
        a.belowPolls = 0;
      }
      if (a.belowPolls >= settings.clearPolls) {
        events.push(event('resolved', a, c));
        continue;
      }
      if (c.people >= a.notifiedPeople * settings.escalateFactor) {
        a.notifiedPeople = c.people;
        events.push(event('escalated', a, c));
      }
      open[c.key] = a;
      continue;
    }

    if (!eligible(c, settings) || c.people < settings.thresholdPeople) continue;

    const streak = (prev.pending[c.key] ?? 0) + 1;
    const immediate = c.people >= settings.thresholdPeople * settings.immediateFactor;
    if (streak < settings.confirmPolls && !immediate) {
      pending[c.key] = streak;
      continue;
    }
    const a: OpenAlert = {
      key: c.key,
      scope: c.scope,
      label: c.label,
      openedAt: at,
      startedAt: new Date(estimateOnset(trail, c.key)).toISOString(),
      lastSeenAt: at,
      people: c.people,
      peakPeople: c.people,
      notifiedPeople: c.people,
      belowPolls: 0,
    };
    open[c.key] = a;
    events.push(event('opened', a, c));
  }

  // An open alert with no candidate this poll has no data, not an all-clear.
  for (const [key, a] of Object.entries(prev.open)) {
    if (seen.has(key)) continue;
    if (now.getTime() - Date.parse(a.lastSeenAt) >= BLIND_CLOSE_MS) events.push(closedBlind(a));
    else open[key] = a;
  }

  return { state: { open, pending, trail }, events };
}
