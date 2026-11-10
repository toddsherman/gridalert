import { BlobPreconditionFailedError } from '@vercel/blob';
import { evaluate } from './alerts/engine.ts';
import { checkIn, deliver, FEEDS_KEY, formatEvent } from './alerts/notify.ts';
import { sendToSubscribers } from './alerts/push.ts';
import { refreshBlackouts, refreshStatements, stormCheckFailed, takeNotices, trimBlackouts, withCause } from './blackouts.ts';
import { eastern, num } from './format.ts';
import { collect, type LastGoodMap } from './collector.ts';
import { type HealthDoc, hugeFeedsOut, ISSUE_POLLS, platformReadings, platformWrong } from './health.ts';
import { customersOf, sources, watched } from './registry.ts';
import { refreshReports } from './reports.ts';
import { findSimultaneous } from './simultaneous.ts';
import { PATHS, readDoc, swapDoc, writeDoc } from './store.ts';
import { type AlertEvent, type Blackout, DEFAULT_SETTINGS, EMPTY_ENGINE, type EngineState, type Settings, type SimultaneousOutage, type Snapshot } from './types.ts';

const HISTORY_POINTS = 14 * 96; // 14 days at 15-minute spacing
const HISTORY_STEP_MS = 15 * 60_000;
const ALERT_LOG_LIMIT = 1_000;
/** Attempts before an ordinary notification is dropped (about 30 minutes). */
const MAX_DELIVERY_ATTEMPTS = 6;
/** A high-priority alert is worth sending late, up to a point. */
const URGENT_KEEP_MS = 24 * 3_600_000;
/** An urgent alert this old still waiting means delivery is broken. */
const DELIVERY_LATE_MS = 15 * 60_000;
/** Monitoring-gap notice: fire when under this share of customers has a live feed. */
const MIN_MONITORED_SHARE = 0.6;
/**
 * How often to push back the dead-man's switch. ntfy limits requests, so not every poll. Just
 * under 15 minutes, since polls land a fraction of a second either side of their schedule.
 */
const CHECK_IN_MS = 14 * 60_000;
/** Longer than this since a check-in means ntfy will have sent its warning. Matches HEARTBEAT_DELAY. */
const STOPPED_AFTER_MS = 40 * 60_000;
/** Feeds stopping together that raise the alert, and the number that keeps it open. */
const STUCK_FEEDS_OPEN = 3;
const STUCK_FEEDS_CLEAR = 2;
/** Long enough for a run that dies to free the next one, and short of the 5 minutes between polls. */
const LEASE_MS = 280_000;
/** A function dies at 300 seconds, so sending stops here and leaves time to save what's left. */
const DELIVERY_BUDGET_MS = 240_000;
/** Reading stories takes about a minute, which has to fit in what's left. */
const STATEMENT_CUTOFF_MS = 200_000;
/** The hourly check has missed a couple of runs. */
const PROBE_LATE_MS = 3 * 3_600_000;

/** Monitoring problems counted across polls. */
const UPKEEP = 'upkeep';
const STORM_CHECK = 'storm-check';
const ODIN = 'odin';
const PROBES = 'probes';
const HUGE_FEED = 'huge-feed';
const platformIssue = (method: string) => `platform:${method}`;

const URGENT_KINDS: ReadonlySet<string> = new Set(['unexplained', 'simultaneous', 'deliberate', 'reported']);

interface OutboxItem {
  event: AlertEvent;
  attempts: number;
  /** Browser subscribers it reached, set once it went to them so a retry can't send it twice. */
  shared?: number;
  /** The owner's channels that took it, so a retry for browsers doesn't send it there again. */
  channels?: string[];
  sentAt?: string;
}

/** What the public signed up for: blackout alerts and their follow-ups, never notices about GridAlert itself. */
const PUBLIC_KINDS: ReadonlySet<AlertEvent['kind']> = new Set(['unexplained', 'deliberate', 'simultaneous', 'explained', 'simultaneous-explained', 'resolved']);
const isPublic = (e: AlertEvent) => !e.key.startsWith('system:') && PUBLIC_KINDS.has(e.kind);

interface RunState {
  engine: EngineState;
  lastGood: LastGoodMap;
  outbox: OutboxItem[];
  degraded: boolean;
  feedsStuck?: boolean;
  checkedInAt?: number;
  /** Check-ins in a row that ntfy has refused, which means alerts to the owner are likely refused too. */
  checkInFails?: number;
  runs: number;
  /** The last settings read, because guessing at them would send alerts nowhere. */
  settings?: Settings;
  /** Polls in a row each problem has lasted. */
  issues?: Record<string, number>;
  historyAt?: number;
  /** Another run started before this time is still going. */
  leaseUntil?: number;
}

const EMPTY_RUN: RunState = { engine: EMPTY_ENGINE, lastGood: {}, outbox: [], degraded: false, runs: 0 };

export interface History {
  t: number[];
  total: number[];
  metros: Record<string, number[]>;
  utilities: Record<string, number[]>;
}

/** Settings as stored. A failed read throws, for anything that acts on them. */
export async function readSettings(): Promise<Settings> {
  const stored = await readDoc<Partial<Settings>>(PATHS.settings, { fresh: true });
  return { ...DEFAULT_SETTINGS, ...stored?.value };
}

/** Settings for showing on a page, where a failed read shouldn't take it down. */
export async function getSettings(fresh = false): Promise<Settings> {
  const stored = await readDoc<Partial<Settings>>(PATHS.settings, { fresh }).catch(() => null);
  return { ...DEFAULT_SETTINGS, ...stored?.value };
}

function appendSeries(series: Record<string, number[]>, id: string, value: number, length: number) {
  const list = series[id] ?? new Array(Math.max(0, length - 1)).fill(0);
  list.push(value);
  series[id] = list.slice(-HISTORY_POINTS);
}

async function updateHistory(snapshot: Snapshot, now: Date) {
  const stored = await readDoc<History>(PATHS.history, { fresh: true });
  const h: History = stored?.value ?? { t: [], total: [], metros: {}, utilities: {} };

  h.t = [...h.t, now.getTime()].slice(-HISTORY_POINTS);
  h.total = [...h.total, snapshot.customersOut].slice(-HISTORY_POINTS);
  const length = h.t.length;
  const seenMetros = new Set<string>();
  for (const m of snapshot.metros) {
    appendSeries(h.metros, m.cbsa, m.customersOut, length);
    seenMetros.add(m.cbsa);
  }
  const seenUtilities = new Set<string>();
  for (const u of snapshot.utilities) {
    appendSeries(h.utilities, u.id, u.customersOut, length);
    seenUtilities.add(u.id);
  }
  // ODIN-sourced rows come and go, so keep their series aligned at zero.
  for (const id of Object.keys(h.utilities)) {
    if (!seenUtilities.has(id)) appendSeries(h.utilities, id, 0, length);
  }
  for (const id of Object.keys(h.metros)) {
    if (!seenMetros.has(id)) appendSeries(h.metros, id, 0, length);
  }
  await writeDoc(PATHS.history, h);
}

/** A compact record of each poll, kept indefinitely so thresholds can be backtested. */
async function archiveSample(snapshot: Snapshot, now: Date) {
  const sparse = (rows: Array<[string, number]>) => Object.fromEntries(rows.filter(([, n]) => n > 0));
  await writeDoc(PATHS.sample(now), {
    t: snapshot.generatedAt,
    total: snapshot.customersOut,
    metros: sparse(snapshot.metros.map((m) => [m.cbsa, m.customersOut])),
    utilities: sparse(snapshot.utilities.map((u) => [u.id, u.customersOut])),
  });
}

/** Add this poll's events to the log, and record what became of anything sent. */
async function updateAlertLog(events: AlertEvent[], outcomes: Map<string, Partial<AlertEvent>>) {
  if (!events.length && !outcomes.size) return;
  const stored = await readDoc<AlertEvent[]>(PATHS.alerts, { fresh: true });
  const list = [...events.slice().reverse(), ...(stored?.value ?? [])].slice(0, ALERT_LOG_LIMIT);
  await writeDoc(PATHS.alerts, list.map((e) => ({ ...e, ...outcomes.get(e.id) })));
}

function degradedEvent(kind: 'opened' | 'resolved', share: number, snapshot: Snapshot, at: string): AlertEvent {
  const pct = Math.round(share * 100);
  return {
    id: `system:coverage:${kind}:${at}`,
    kind,
    key: 'system:coverage',
    scope: 'utility',
    label: 'GridAlert monitoring',
    at,
    people: 0,
    peakPeople: 0,
    customers: 0,
    openedAt: at,
    detail: kind === 'opened' ? `Only ${pct}% of customers have a live feed; ${snapshot.sourcesDown} feeds are down, so outages may be missed.` : `Coverage is back to ${pct}%.`,
    link: '/coverage',
  };
}

function systemEvent(key: string, kind: 'opened' | 'resolved', label: string, detail: string, at: string): AlertEvent {
  return { id: `${key}:${kind}:${at}`, kind, key, scope: 'utility', label, at, people: 0, peakPeople: 0, customers: 0, openedAt: at, detail, link: '/coverage' };
}

function stuckDetail(snapshot: Snapshot): string {
  const stuck = snapshot.stuckFeeds;
  const first = stuck.map((f) => f.since).sort()[0];
  const kubra = stuck.every((f) => f.method === 'kubra');
  const shared = kubra ? ' All of them reach GridAlert through Kubra, so a fault there is possible.' : '';
  return `${stuck.length} large feeds have stopped updating, the first at ${eastern(first)} ET: ${stuck.slice(0, 6).map((f) => f.name).join(', ')}.${shared} Their numbers can't be trusted, so a real blackout there could be hidden.`;
}

/** Count another poll of a problem, and say when it has lasted long enough or has cleared. */
function trackIssue(issues: Record<string, number>, name: string, failing: boolean, after = ISSUE_POLLS): 'opened' | 'resolved' | null {
  const was = issues[name] ?? 0;
  if (failing) issues[name] = was + 1;
  else delete issues[name];
  if (failing && was + 1 === after) return 'opened';
  return !failing && was >= after ? 'resolved' : null;
}

/** Work out which high-priority notices are due, without recording them yet. */
async function dueNotices(blackouts: Blackout[], settings: Settings, at: string) {
  const taken = takeNotices(blackouts, settings, at);
  const stored = await readDoc<SimultaneousOutage[]>(PATHS.simultaneous, { fresh: true });
  const previous = stored?.value ?? [];
  const found = findSimultaneous(previous, taken.list, settings, at);
  const changed = JSON.stringify(found.list) !== JSON.stringify(previous);
  return { events: [...taken.events, ...found.events], blackouts: taken.list, simultaneous: found.list, changed };
}

const isUrgent = (e: AlertEvent) => URGENT_KINDS.has(e.kind) || Boolean(e.urgent);

const keepTrying = (item: OutboxItem, now: number) => (isUrgent(item.event) ? now - Date.parse(item.event.at) < URGENT_KEEP_MS : item.attempts < MAX_DELIVERY_ATTEMPTS);

/** Send what's waiting, most important first, stopping at the deadline with the rest saved for next poll. */
async function sendOutbox(items: OutboxItem[], blackouts: Blackout[], settings: Settings, now: Date, deadline: number) {
  const remaining: OutboxItem[] = [];
  const dropped: OutboxItem[] = [];
  const outcomes = new Map<string, Partial<AlertEvent>>();
  for (const queued of items.slice().sort((a, b) => Number(isUrgent(b.event)) - Number(isUrgent(a.event)))) {
    let item = queued;
    if (Date.now() >= deadline) {
      remaining.push(item);
      continue;
    }
    const message = formatEvent(withCause(item.event, blackouts));
    // The public and the owner are tried apart, so one failing never resends to the other.
    if (item.shared === undefined && isPublic(item.event)) {
      const shared = await sendToSubscribers(message).catch((err) => console.error('browser delivery failed:', item.event.key, (err as Error).message));
      if (shared !== undefined) item = { ...item, shared };
    }
    if (!item.channels) {
      try {
        item = { ...item, channels: (await deliver(message, settings)).channels, sentAt: now.toISOString() };
      } catch (err) {
        console.error('delivery failed:', item.event.key, (err as Error).message);
      }
    }
    if (item.channels) outcomes.set(item.event.id, { sentAt: item.sentAt, channels: item.shared ? [...item.channels, `browser (${item.shared})`] : item.channels });
    if (item.channels && (item.shared !== undefined || !isPublic(item.event))) continue;

    const tried = { ...item, attempts: item.attempts + 1 };
    if (keepTrying(tried, now.getTime())) remaining.push(tried);
    else {
      dropped.push(tried);
      if (!item.channels) outcomes.set(item.event.id, { dropped: true });
    }
  }
  return { remaining, dropped, outcomes };
}

/** Say when alerts have been given up on. A monitoring notice that can't be sent just goes. */
function droppedNotices(dropped: OutboxItem[], at: string): OutboxItem[] {
  const lost = dropped.filter((item) => !item.event.key.startsWith('system:')).map((item) => item.event.label);
  if (!lost.length) return [];
  // Reaching the owner but not subscribers still means the public missed it.
  const where = dropped.every((item) => item.event.key.startsWith('system:') || item.channels) ? 'sent to browser subscribers' : 'delivered';
  const event = systemEvent('system:dropped', 'opened', 'GridAlert delivery', `${lost.length} alert${lost.length === 1 ? '' : 's'} could not be ${where} and were dropped: ${lost.slice(0, 4).join('; ')}. See the Alerts page.`, at);
  return [{ event: { ...event, urgent: true }, attempts: 0 }];
}

/** What stands between a blackout and a high-priority alert reaching anyone. */
function impairments(state: RunState, now: number): string[] {
  const open = (name: string) => (state.issues?.[name] ?? 0) >= ISSUE_POLLS;
  const out: string[] = [];
  if (open(UPKEEP)) out.push('blackout checks');
  if (open(STORM_CHECK)) out.push('storm warning check');
  if (state.feedsStuck) out.push('large feeds stopped');
  for (const name of Object.keys(state.issues ?? {})) if (name.startsWith('platform:') && open(name)) out.push(`${name.replace('platform:', '')} feeds`);
  if (state.outbox.some((item) => isUrgent(item.event) && now - Date.parse(item.event.at) >= DELIVERY_LATE_MS)) out.push('alert delivery');
  if ((state.checkInFails ?? 0) >= ISSUE_POLLS) out.push("the owner's alert channel");
  return out;
}

export interface RunResult {
  skipped?: string;
  customersOut?: number;
  sourcesOk?: number;
  sourcesDown?: number;
  events?: number;
  delivered?: number;
  durationMs?: number;
}

/** One poll: collect, evaluate, persist, notify. */
export async function runOnce(now = new Date()): Promise<RunResult> {
  const started = Date.now();
  const stored = await readDoc<RunState>(PATHS.engine, { fresh: true });
  const saved: RunState = { ...EMPTY_RUN, ...stored?.value };
  if ((saved.leaseUntil ?? 0) > now.getTime()) return { skipped: 'another run is still going' };

  const leaseUntil = now.getTime() + LEASE_MS;
  // Claim this run before anything is sent, so two runs can't both send what's waiting.
  let etag: string;
  try {
    etag = await swapDoc(PATHS.engine, { ...saved, leaseUntil }, stored?.etag ?? null);
  } catch (err) {
    if (err instanceof BlobPreconditionFailedError) return { skipped: 'another run updated state first' };
    throw err;
  }

  // Falling back to defaults here would quietly send every alert nowhere.
  const settings = await readSettings().catch((err) => {
    if (!saved.settings) throw err;
    console.error('settings read failed, using the last good ones:', err);
    return saved.settings;
  });

  const deliveryDeadline = started + DELIVERY_BUDGET_MS;
  const outcomes = new Map<string, Partial<AlertEvent>>();
  const deliveredFrom = (sent: Awaited<ReturnType<typeof sendOutbox>>) => {
    for (const [id, outcome] of sent.outcomes) outcomes.set(id, outcome);
    return [...sent.remaining, ...droppedNotices(sent.dropped, now.toISOString())];
  };

  // Anything left from an earlier poll goes first, so a slow or failing poll can't hold it back.
  let waiting = saved.outbox;
  if (waiting.length) {
    waiting = deliveredFrom(await sendOutbox(waiting, [], settings, now, deliveryDeadline));
    etag = await swapDoc(PATHS.engine, { ...saved, outbox: waiting, leaseUntil }, etag);
  }

  const { snapshot, candidates, lastGood } = await collect(saved.lastGood, settings, now);
  // About a dozen outages a day reach the alert level, which would bury the alerts that matter,
  // so these only go on the site. Only the notices below are sent.
  // An area that's no longer watched, like San Juan, would otherwise sit open until it timed out.
  const kept = { ...saved.engine, open: Object.fromEntries(Object.entries(saved.engine.open).filter(([key]) => watched(key))) };
  const { state: engine, events: ordinary } = evaluate(kept, candidates, settings, now);
  const events: AlertEvent[] = [];
  const at = now.toISOString();

  const share = snapshot.customersTotal ? snapshot.customersMonitored / snapshot.customersTotal : 0;
  const degraded = share < MIN_MONITORED_SHARE;
  if (degraded !== saved.degraded) {
    events.push(degradedEvent(degraded ? 'opened' : 'resolved', share, snapshot, at));
  }

  const count = snapshot.stuckFeeds.length;
  const feedsStuck = saved.feedsStuck ? count >= STUCK_FEEDS_CLEAR : count >= STUCK_FEEDS_OPEN;
  if (feedsStuck !== Boolean(saved.feedsStuck)) {
    events.push(systemEvent(FEEDS_KEY, feedsStuck ? 'opened' : 'resolved', 'GridAlert feeds', feedsStuck ? stuckDetail(snapshot) : 'The large feeds that stopped are updating again.', at));
  }

  const issues = { ...saved.issues };
  const odin = trackIssue(issues, ODIN, Boolean(snapshot.odinDown));
  // ODIN stops rebuilding its data for hours on most days, so this is logged for the site and
  // left to the daily digest. Sending it meant two notices a day that nobody could act on.
  const logOnly: AlertEvent[] = [];
  if (odin) logOnly.push(systemEvent(`system:${ODIN}`, odin, 'ODIN feed', odin === 'opened' ? "DOE's ODIN feed has stopped updating, so outages at utilities only it covers, Houston's among them, can't be seen." : 'ODIN is updating again.', at));
  const huge = hugeFeedsOut(snapshot, now.getTime());
  const hugeFeed = trackIssue(issues, HUGE_FEED, huge.length > 0, 1);
  if (hugeFeed) {
    const served = (id: string) => num(customersOf(sources.find((s) => s.id === id)!));
    const detail = hugeFeed === 'opened' ? `${huge.map((u) => `${u.name} (${served(u.id)} customers)`).join(' and ')} can't be read and ${huge.length === 1 ? 'has' : 'have'} been out for over an hour, so a blackout there would go unseen.` : 'The very large feeds that were out are being read again.';
    events.push(systemEvent(`system:${HUGE_FEED}`, hugeFeed, 'A very large feed', detail, at));
  }
  const platforms = platformReadings(snapshot);
  for (const p of platforms) {
    const name = platformIssue(p.method);
    const change = trackIssue(issues, name, platformWrong(p, (issues[name] ?? 0) >= ISSUE_POLLS));
    if (!change) continue;
    const detail = change === 'opened' ? `${p.zero} of ${p.feeds} large ${p.method} feeds read exactly 0 or aren't working, which a quiet day doesn't do. Real outages on them could be going unseen.` : `Large ${p.method} feeds are reading normally again.`;
    events.push({ ...systemEvent(`system:${name}`, change, `${p.method} feeds`, detail, at), urgent: true });
  }

  const historyDue = now.getTime() - (saved.historyAt ?? 0) >= HISTORY_STEP_MS - 60_000;
  const outbox: OutboxItem[] = [...waiting, ...events.map((event) => ({ event, attempts: 0 }))];
  const next: RunState = { engine, lastGood, outbox, degraded, feedsStuck, checkedInAt: saved.checkedInAt, checkInFails: saved.checkInFails, runs: saved.runs + 1, settings, issues, historyAt: historyDue ? now.getTime() : saved.historyAt, leaseUntil };
  snapshot.impaired = impairments(next, now.getTime());

  // Saved before anything is sent, so a crash from here on resends rather than loses.
  try {
    etag = await swapDoc(PATHS.engine, next, etag);
  } catch (err) {
    if (err instanceof BlobPreconditionFailedError) return { skipped: 'another run updated state first' };
    throw err;
  }

  await writeDoc(PATHS.latest, snapshot).catch((err) => console.error('latest write failed:', err));

  // A failure here stops the high-priority alerts, which is why it counts and is reported below.
  let upkeepFailed = false;
  const blackouts = await refreshBlackouts(engine, snapshot, settings.peoplePerCustomer, now).catch((err): Blackout[] => {
    console.error('blackout update failed:', err);
    upkeepFailed = true;
    return [];
  });

  // These depend on the checks just run, so they join the outbox now. The outbox is
  // saved before each blackout is marked as notified, so a crash resends, not loses.
  let queued: AlertEvent[] = [];
  let sending = outbox;
  try {
    const due = blackouts.length ? await dueNotices(blackouts, settings, at) : null;
    if (due?.events.length) {
      queued = due.events.filter((e) => !outbox.some((item) => item.event.id === e.id));
      const withNotices = [...outbox, ...queued.map((event) => ({ event, attempts: 0 }))];
      etag = await swapDoc(PATHS.engine, { ...next, outbox: withNotices }, etag);
      sending = withNotices;
      await writeDoc(PATHS.blackouts, trimBlackouts(due.blackouts));
    }
    if (due?.changed) await writeDoc(PATHS.simultaneous, due.simultaneous);
  } catch (err) {
    console.error('notice update failed:', err);
    upkeepFailed = true;
  }

  const checkInDue = !saved.checkedInAt || now.getTime() - saved.checkedInAt >= CHECK_IN_MS;
  const probedAt = checkInDue ? (await readDoc<HealthDoc>(PATHS.health, { fresh: true }).catch(() => null))?.value.probedAt : undefined;

  const raised: AlertEvent[] = [];
  const upkeep = trackIssue(issues, UPKEEP, upkeepFailed);
  if (upkeep) raised.push({ ...systemEvent(`system:${UPKEEP}`, upkeep, 'Blackout checks', upkeep === 'opened' ? "GridAlert's blackout checks have failed for 15 minutes, so high-priority alerts can't fire. Outages still show on the site." : 'Blackout checks are running again.', at), urgent: true });
  const storm = trackIssue(issues, STORM_CHECK, stormCheckFailed(blackouts, at));
  if (storm) raised.push({ ...systemEvent(`system:${STORM_CHECK}`, storm, 'Storm warning check', storm === 'opened' ? "The National Weather Service can't be read. A blackout will alert after 30 minutes with storms not ruled out." : 'Storm warnings are being read again.', at), urgent: true });
  if (probedAt) {
    const probes = trackIssue(issues, PROBES, now.getTime() - Date.parse(probedAt) > PROBE_LATE_MS, 1);
    if (probes) raised.push(systemEvent(`system:${PROBES}`, probes, 'Hourly checks', probes === 'opened' ? `GridAlert's hourly check of its outside services last ran at ${eastern(probedAt)} ET, so a broken one could go unnoticed.` : 'The hourly checks are running again.', at));
  }
  // Areas no feed could see this poll are watched through the news. It never holds up a real alert.
  const reported = await refreshReports(snapshot.metros, now).catch((err): AlertEvent[] => {
    console.error('news backstop failed:', (err as Error).message);
    return [];
  });
  raised.push(...reported);
  sending = [...sending, ...raised.map((event) => ({ event, attempts: 0 }))];

  const sent = await sendOutbox(sending, blackouts, settings, now, deliveryDeadline);
  const remaining = deliveredFrom(sent);
  const delivered = [...outcomes.values()].filter((o) => o.sentAt).length;

  const logged = [...ordinary.map((e) => ({ ...withCause(e, blackouts), siteOnly: true })), ...logOnly.map((e) => ({ ...e, siteOnly: true })), ...events, ...queued, ...raised];
  const sideWrites = await Promise.allSettled([historyDue ? updateHistory(snapshot, now) : null, archiveSample(snapshot, now), updateAlertLog(logged, outcomes)]);
  for (const r of sideWrites) if (r.status === 'rejected') console.error('side write failed:', r.reason);

  // Only a poll that got this far counts, so a run that dies partway leaves the switch armed.
  const checkedIn = checkInDue && (await checkIn(settings).catch((err) => console.error('check-in failed:', (err as Error).message)));
  // A refusal is counted, since it shows on the health check. A webhook that isn't ntfy has nothing to refuse.
  const checkInFails = !checkInDue ? saved.checkInFails : checkedIn === undefined ? (saved.checkInFails ?? 0) + 1 : 0;
  // A check-in after a long silence means ntfy has already sent its warning.
  const silentFor = saved.checkedInAt ? now.getTime() - saved.checkedInAt : 0;
  if (checkedIn && silentFor > STOPPED_AFTER_MS) {
    const minutes = Math.round(silentFor / 60_000);
    // If it was ntfy refusing the check-ins, its warning was wrong, and saying polling is "back" would repeat the mistake.
    const detail = saved.checkInFails ? `ntfy refused GridAlert's check-ins for ${minutes} minutes, so its "GridAlert has stopped" warning was false. Polling never stopped, but alerts sent to ntfy in that time may not have arrived.` : `Polling is running again after ${minutes} minutes.`;
    const back = systemEvent('system:heartbeat', 'resolved', 'GridAlert monitoring', detail, at);
    await deliver(formatEvent(back), settings).catch((err) => console.error('delivery failed:', back.key, (err as Error).message));
  }
  // If this loses a race the outbox survives, and a resend beats a lost alert.
  await swapDoc(PATHS.engine, { ...next, issues, outbox: remaining, checkedInAt: checkedIn ? now.getTime() : saved.checkedInAt, checkInFails, leaseUntil: undefined }, etag).catch((err) => console.error('outbox update failed:', err));

  if (Date.now() - started < STATEMENT_CUTOFF_MS) await refreshStatements(now).catch((err) => console.error('statement reading failed:', err));

  return {
    customersOut: snapshot.customersOut,
    sourcesOk: snapshot.sourcesOk,
    sourcesDown: snapshot.sourcesDown,
    events: logged.length,
    delivered,
    durationMs: Date.now() - started,
  };
}
