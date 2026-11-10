import metrosJson from '../data/metros.json' with { type: 'json' };
import odinReportersJson from '../data/odin-reporters.json' with { type: 'json' };
import sourcesJson from '../data/sources.json' with { type: 'json' };
import territoriesJson from '../data/territories.json' with { type: 'json' };
import utilitiesJson from '../data/utilities.json' with { type: 'json' };
import { RUNNABLE_METHODS, type Source, type UnmonitoredSource } from './sources/types.ts';

export interface RegistryCounty {
  fips: string;
  name: string;
  state: string;
  population: number;
}

export interface RegistryMetro {
  cbsa: string;
  name: string;
  population: number;
  counties: RegistryCounty[];
  utilities: number[];
}

export interface RegistryUtility {
  eiaId: number;
  name: string;
  ownership: string;
  states: string[];
  customers: number;
  metroCounties: string[];
  metros: string[];
}

export const metros = metrosJson as RegistryMetro[];
export const utilities = utilitiesJson as RegistryUtility[];
export const utilityByEia = new Map(utilities.map((u) => [u.eiaId, u]));
export const metroByCbsa = new Map(metros.map((m) => [m.cbsa, m]));

type AnySource = Source | UnmonitoredSource;
const all = sourcesJson as unknown as AnySource[];

export const sources = all.filter((s): s is Source => RUNNABLE_METHODS.has(s.method));
export const unmonitored = all.filter((s): s is UnmonitoredSource => !RUNNABLE_METHODS.has(s.method));

const sourceIds = new Set(sources.map((s) => s.id));

/** Whether an alert's area is still watched. San Juan was dropped, and its records go out of sight with it. */
export function watched(key: string): boolean {
  if (key.startsWith('metro:')) return metroByCbsa.has(key.slice('metro:'.length));
  if (key.startsWith('utility:')) return sourceIds.has(key.slice('utility:'.length));
  return true;
}

/** EIA ids that a direct feed claims, so ODIN readings for them can be ignored. */
export const directEiaIds = new Set(sources.flatMap((s) => s.eiaIds));

/** Utilities seen reporting to ODIN. It lists only active outages, so a quiet reporter still counts. */
export const odinReporters = odinReportersJson as number[];

/** Utilities only ODIN reports on, which it lists only while they have outages. */
export const odinEiaIds = new Set([...odinReporters, ...unmonitored.filter((u) => u.method === 'odin-only').flatMap((u) => u.eiaIds)]);

const territories = territoriesJson as Record<string, string[]>;

/**
 * Every county a utility serves, metro or not, which is what tells two same-named counties apart.
 * EIA's list has gaps, so this settles a name but can't rule a county out.
 */
export const countiesOf = (eiaId: number): string[] => [...(territories[eiaId] ?? []), ...(utilityByEia.get(eiaId)?.metroCounties ?? [])];

/** Customers a feed serves, from EIA unless the feed's own entry has to say. */
export function customersOf(source: { eiaIds: number[]; customers?: number }): number {
  return source.customers ?? source.eiaIds.reduce((sum, id) => sum + (utilityByEia.get(id)?.customers ?? 0), 0);
}

/** Customers each metro could plausibly hold of a utility, for coverage weighting. */
const CUSTOMERS_PER_PERSON = 0.45;

export function utilityWeightInMetro(u: RegistryUtility, m: RegistryMetro): number {
  return Math.min(u.customers, m.population * CUSTOMERS_PER_PERSON);
}
