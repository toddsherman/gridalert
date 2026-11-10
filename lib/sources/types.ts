/** One geographic slice of a utility's outage data, as published by the feed. */
export interface AreaReading {
  /** Two-letter state, when the feed or source config provides one. */
  state?: string;
  /** Area name exactly as published ("Hanover", "Hanover County", "22101"). */
  name: string;
  kind: 'county' | 'zip' | 'city' | 'region' | 'other';
  customersOut: number;
  customersServed?: number;
}

/** Enough of an area to find its county. */
export type AreaPlace = Pick<AreaReading, 'name' | 'state' | 'kind'>;

/** A cause as a feed lists it, with where, if the feed says. */
export interface PlacedCause {
  cause: string;
  customers: number;
  place?: AreaPlace;
}

/** A normalized point-in-time reading from one source. */
export interface Reading {
  customersOut: number;
  customersServed?: number;
  incidents?: number;
  areas?: AreaReading[];
  /** Timestamp the feed reports for its own data, if any. */
  asOf?: string;
  /** Feed-reported operating mode (Kubra: BLUESKY / STORM). */
  mode?: string;
  /** People are out, but the county report failed or came back empty. */
  areasMissing?: boolean;
}

export interface KubraConfig {
  instanceId: string;
  viewId: string;
  /** Index into summaryFileData.totals. Defaults to 0. */
  totalIndex?: number;
  /** Sum every entry in totals instead of reading one. */
  sumTotals?: boolean;
}

export interface KubraLegacyConfig {
  /** Directory holding metadata.json, ending in interval_generation_data. */
  baseUrl: string;
  /** File under the timestamped directory with a county tree, if any. */
  reportFile?: string;
  /** Several reports that together cover the territory, without overlap. */
  reportFiles?: string[];
  /** Depth of the county level, for reports with no key fields. */
  reportDepth?: number;
  state?: string;
}

export interface ArcgisConfig {
  /** Layer URL ending in /MapServer/<n> or /FeatureServer/<n>. */
  layerUrl: string;
  outField: string;
  where?: string;
  servedField?: string;
  areaField?: string;
  areaKind?: AreaReading['kind'];
  state?: string;
  /** Field naming each outage's cause, read only during a blackout. */
  causeField?: string;
}

export interface CoopReportConfig {
  /** A state co-op association's /outages/details endpoint. */
  url: string;
  /** Names of co-ops that have their own direct feed. */
  exclude?: string[];
}

export interface PmtilesConfig {
  url: string;
  /** Dotted path into the archive's JSON metadata. */
  totalPath: string;
  incidentsPath?: string;
}

export interface JsonConfig {
  url: string;
  headers?: Record<string, string>;
  /** POST body, when the endpoint needs one. */
  body?: string;
  /** Public endpoint handing any visitor an anonymous bearer token for url. */
  tokenUrl?: string;
  /** First fetch this URL and substitute indexPath's value for {index} in url. */
  indexUrl?: string;
  indexPath?: string;
  /** Dotted path to a total. Used when the feed publishes one directly. */
  totalPath?: string;
  servedPath?: string;
  incidentsPath?: string;
  asOfPath?: string;
  /** Dotted path to an array of incidents or areas. Empty string = root array. */
  listPath?: string;
  outField?: string;
  servedField?: string;
  areaField?: string;
  areaKind?: AreaReading['kind'];
  state?: string;
  /** Dotted path to each row's own state, for one feed spanning several states. */
  stateField?: string;
  /** DataCapable keeps a row's state in additionalProperties under this name. */
  stateProperty?: string;
  /** Skip list rows whose areaField matches, e.g. a "Total" row. */
  excludeAreas?: string[];
  /** Dotted path to each list row's cause, read only during a blackout. */
  causeField?: string;
}

export interface RegexConfig {
  url: string;
  headers?: Record<string, string>;
  /** Regex with one capture group holding the customers-out number. */
  pattern: string;
  servedPattern?: string;
  /** Add up every match, for XML or HTML with one element per outage. */
  sumAll?: boolean;
}

export type SourceSpec =
  | { method: 'kubra'; config: KubraConfig }
  | { method: 'kubra-legacy'; config: KubraLegacyConfig }
  | { method: 'arcgis'; config: ArcgisConfig }
  | { method: 'json'; config: JsonConfig }
  | { method: 'regex'; config: RegexConfig }
  | { method: 'coop-report'; config: CoopReportConfig }
  | { method: 'pmtiles'; config: PmtilesConfig };

export type Method = SourceSpec['method'];

/** Methods with a working adapter. Everything else in the registry is a known gap. */
export const RUNNABLE_METHODS: ReadonlySet<string> = new Set<Method>(['kubra', 'kubra-legacy', 'arcgis', 'json', 'regex', 'coop-report', 'pmtiles']);

/** A utility (or group of EIA utilities) monitored through one feed. */
export type Source = SourceSpec & {
  id: string;
  name: string;
  /** EIA-861 utility numbers this feed covers. */
  eiaIds: number[];
  mapUrl: string;
  granularity: 'utility' | 'county' | 'zip' | 'city' | 'incident' | 'region';
  /** CBSA codes this feed serves, for utilities missing from EIA. */
  metros?: string[];
  /** Metros it reaches a corner of that EIA's territory data leaves out. */
  alsoMetros?: string[];
  /** Customers served, for utilities missing from EIA. */
  customers?: number;
  notes?: string;
};

/** Entries with no usable direct feed, kept so coverage gaps stay visible. */
export interface UnmonitoredSource {
  id: string;
  name: string;
  eiaIds: number[];
  mapUrl?: string;
  method: 'odin-only' | 'none' | 'custom';
  granularity?: string;
  notes: string;
  custom?: unknown;
}
