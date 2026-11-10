export interface Settings {
  /** Estimated people out, per metro, that opens an alert. */
  thresholdPeople: number;
  /** Multiplier from utility customers (meters) to people. */
  peoplePerCustomer: number;
  /** Consecutive polls over threshold before alerting, to absorb feed glitches. */
  confirmPolls: number;
  /** Polls under the clear level before an alert resolves. */
  clearPolls: number;
  /** Fraction of the threshold an alert must fall below to resolve. */
  clearRatio: number;
  /** Re-notify when an open alert grows by this factor past its last notice. */
  escalateFactor: number;
  /** Skip confirmPolls when an alert opens at this multiple of the threshold. */
  immediateFactor: number;
  /** Customers lost within 30 minutes, with no known cause, that sends the high-priority alert. 0 turns it off. */
  unexplainedCustomers: number;
  /** Unrelated areas starting together that count as simultaneous. 0 turns it off. */
  simultaneousAreas: number;
  /** Customers each of those areas must reach. */
  simultaneousCustomers: number;
  /** Limit alerts to these states. Empty means everywhere. */
  states: string[];
  /** Metros (CBSA codes) that never alert. */
  mutedMetros: string[];
  webhookUrl?: string;
  emailTo?: string;
}

export const DEFAULT_SETTINGS: Settings = {
  thresholdPeople: 10_000,
  peoplePerCustomer: 2.5,
  confirmPolls: 2,
  clearPolls: 6,
  clearRatio: 0.5,
  escalateFactor: 2,
  immediateFactor: 5,
  unexplainedCustomers: 50_000,
  simultaneousAreas: 3,
  simultaneousCustomers: 10_000,
  states: [],
  mutedMetros: [],
};

/** stale: failed, showing its last value. frozen: answers, but has stopped updating. */
export type SourceHealth = 'ok' | 'stale' | 'frozen' | 'down';

export interface UtilityStatus {
  id: string;
  name: string;
  eiaIds: number[];
  method: string;
  mapUrl?: string;
  granularity: string;
  health: SourceHealth;
  /** Which feed produced the number shown. */
  via: 'direct' | 'odin' | 'none';
  customersOut: number;
  customersServed?: number;
  incidents?: number;
  mode?: string;
  /** Share of this reading attributed to known counties. */
  attributedOut: number;
  lastOkAt?: string;
  /** When a frozen feed last updated. */
  frozenSince?: string;
  /** When a working feed's count last fell to exactly 0. */
  zeroSince?: string;
  /** Polls in a row ODIN has shown outages this feed says it doesn't have. */
  odinAhead?: number;
  /** People are out but the county report failed, so the split is last poll's. */
  areasMissing?: boolean;
  error?: string;
  latencyMs?: number;
}

export interface MetroCounty {
  fips: string;
  name: string;
  customersOut: number;
}

export interface MetroUtility {
  id: string;
  name: string;
  customersOut: number;
}

export interface MetroStatus {
  cbsa: string;
  name: string;
  states: string[];
  population: number;
  customersOut: number;
  estimatedPeople: number;
  utilities: MetroUtility[];
  counties: MetroCounty[];
  /** Serving utilities with a live feed / total serving utilities (by customers). */
  coverage: number;
  /** Serving utilities with no live feed, largest first. */
  gaps: string[];
}

export interface StuckFeed {
  id: string;
  name: string;
  method: string;
  /** When it last updated. */
  since: string;
}

export interface Snapshot {
  generatedAt: string;
  durationMs: number;
  customersOut: number;
  estimatedPeople: number;
  sourcesOk: number;
  sourcesStale: number;
  sourcesFrozen: number;
  sourcesDown: number;
  /** Large feeds that have stopped updating, which can hide a real blackout when several do so together. */
  stuckFeeds: StuckFeed[];
  /** ODIN couldn't be read this poll. */
  odinDown?: boolean;
  /** What is stopping a high-priority alert from reaching anyone, as of the last poll. */
  impaired?: string[];
  /** Customers served by utilities with a working feed. */
  customersMonitored: number;
  customersTotal: number;
  metros: MetroStatus[];
  utilities: UtilityStatus[];
  /** Customers out by county FIPS, for the national map. */
  counties: Record<string, number>;
  /** Area names that could not be matched to a county, for diagnostics. */
  unmatchedAreas: Array<{ source: string; name: string; state?: string; customersOut: number }>;
}

export type AlertScope = 'metro' | 'utility';

export interface OpenAlert {
  key: string;
  scope: AlertScope;
  label: string;
  openedAt: string;
  /** First poll of the rise that led to this alert. */
  startedAt?: string;
  lastSeenAt: string;
  people: number;
  peakPeople: number;
  /** People count in the most recent notification. */
  notifiedPeople: number;
  belowPolls: number;
  /** When part of this area's data went missing, while it stays missing. */
  blindSince?: string;
}

/** Recent people-out readings, used to date when an outage began. */
export interface Trail {
  /** Poll times, oldest first. */
  t: number[];
  /** Readings per alert key, aligned to the end of t. */
  people: Record<string, number[]>;
}

export interface EngineState {
  /** Consecutive polls over threshold for keys without an open alert. */
  pending: Record<string, number>;
  open: Record<string, OpenAlert>;
  trail?: Trail;
}

export const EMPTY_ENGINE: EngineState = { pending: {}, open: {} };

export type AlertKind = 'opened' | 'escalated' | 'resolved' | 'unexplained' | 'explained' | 'deliberate' | 'simultaneous' | 'simultaneous-explained';

export interface AlertEvent {
  id: string;
  kind: AlertKind;
  key: string;
  scope: AlertScope;
  label: string;
  at: string;
  people: number;
  peakPeople: number;
  customers: number;
  openedAt: string;
  detail: string;
  link: string;
  /** One line on what is known about the cause, when checks have run. */
  cause?: string;
  /** A monitoring notice that stands in the way of a high-priority alert. */
  urgent?: boolean;
  /** Closed for want of data, rather than because the power came back. */
  blind?: boolean;
  /** Where it was sent, once it was. An event with neither hasn't reached anyone yet. */
  sentAt?: string;
  channels?: string[];
  /** Given up on after repeated failures. */
  dropped?: boolean;
  /** An ordinary outage alert, which is shown on the site and never sent. */
  siteOnly?: boolean;
  /** The areas it's about, by name, so a high-priority alert can link a search of posts there. */
  areas?: string[];
}

/**
 * checking:  too early to say, or a required check hasn't run
 * unknown:   checks ran and found no ordinary cause
 * explained: strong evidence of an ordinary cause
 */
export type CauseStatus = 'checking' | 'unknown' | 'explained';

export type CauseCheck = 'storm warnings' | 'storm reports' | 'gusts during a Wind Advisory' | 'wildfires' | 'earthquakes' | 'space weather' | 'grid operator notices';

export interface Evidence {
  id: string;
  kind: 'weather' | 'storm-report' | 'wind-gust' | 'wildfire' | 'earthquake' | 'space-weather' | 'operator' | 'utility';
  /** Strong evidence explains a blackout on its own. The rest is context. */
  strong: boolean;
  label: string;
  source: string;
  at: string;
  url?: string;
}

/** Unrelated blackouts that began together with nothing ordinary around any of them. */
export interface SimultaneousOutage {
  id: string;
  startedAt: string;
  /** Blackout ids. */
  members: string[];
  noticeAt: string;
  /** Set once explanations leave too few areas for this to stand. */
  standDownAt?: string;
  /** When every blackout in it had ended, and that went out. */
  restoredAt?: string;
  /** Set once its blackouts are past checking, so nothing about it can change. */
  closedAt?: string;
}

/** What a utility's own map says, summed over the customers it lists. */
export interface UtilityCause {
  cause: string;
  customers: number;
}

/** The last distinct reading of an area's count, which tells a stuck feed from a live one. */
export interface CountReading {
  at: string;
  /** Customers out in each part of the area: its counties, or utilities where a feed has no county detail. */
  parts: Record<string, number>;
  /** The area's total on the poll before this reading. */
  before: number;
}

/** One thing said about a blackout. Nothing here ever changes its cause status. */
export interface TimelineEntry {
  at: string;
  source: string;
  title: string;
  url: string;
  official?: boolean;
  /** The headline points at people rather than weather or wear. Unconfirmed by nature. */
  deliberate?: boolean;
}

/** Who said what about a cause, read from an article by Claude and checked against it. */
export interface Statement {
  at: string;
  source: string;
  url: string;
  speaker: string;
  speakerType: 'utility' | 'grid operator' | 'government' | 'police or fire' | 'reporter' | 'public';
  cause: 'weather' | 'equipment' | 'accident' | 'wildlife' | 'planned' | 'wildfire' | 'deliberate' | 'unknown' | 'other';
  claim: string;
  quote: string;
}

export interface Blackout {
  /** The most customers lost within 30 minutes. */
  jumpCustomers?: number;
  /** Causes utilities have named here, at the most customers each has reached. */
  knownCauses?: UtilityCause[];
  /** When each check last read its source. */
  checkReads?: Partial<Record<CauseCheck, string>>;
  /** Set when a new jump reopens an explained blackout: checks look from here on. */
  checkFrom?: string;
  /** When part of its data went missing, while it stays missing. */
  blindSince?: string;
  /** When an agency's own statement sent an alert. */
  deliberateOfficialAt?: string;
  id: string;
  key: string;
  scope: AlertScope;
  label: string;
  link: string;
  states: string[];
  startedAt: string;
  openedAt: string;
  resolvedAt?: string;
  people: number;
  peakPeople: number;
  peakCustomers: number;
  /** When the count last set a new high. */
  peakAt?: string;
  /** The latest sudden jump on top of the outage already under way, if any. */
  surgeAt?: string;
  surgeCustomers?: number;
  reading?: CountReading;
  timeline?: TimelineEntry[];
  statements?: Statement[];
  /** Articles already read for statements, and how many times Claude has been asked. */
  statementUrls?: string[];
  statementReads?: number;
  /** How far GDELT had been read for this blackout, so silence can be told from not looking. */
  newsThrough?: string;
  utilities: MetroUtility[];
  /** Affected county FIPS. Empty when the feeds give no county detail. */
  counties: string[];
  cause: CauseStatus;
  evidence: Evidence[];
  /** Checks that have run at least once, which is what "ruled out" can claim. */
  checked: CauseCheck[];
  utilityCauses: UtilityCause[];
  checkedAt?: string;
  utilityCheckedAt?: string;
  /** When the high-priority alert went out, so it only ever goes out once. */
  unexplainedNoticeAt?: string;
  /** When that alert was withdrawn because a cause turned up. */
  explainedNoticeAt?: string;
  /** When a report of a deliberate cause went out, so it only ever goes out once. */
  deliberateNoticeAt?: string;
  /** When the end of a blackout that sent a high-priority alert went out. */
  restoredNoticeAt?: string;
}
