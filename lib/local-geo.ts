import data from '../data/local-geo.json' with { type: 'json' };
import { metroForCounty } from './geo.ts';

const towns = data.towns as unknown as Record<string, string | string[]>;
const zips = data.zips as Record<string, string>;

const SUFFIX = /\s+(charter township|charter twp|township|twp|town|city|village|borough|boro|cdp|municipality|plantation|gore|grant|location|metropolitan government|consolidated government|unified government)\.?$/;

/** Must stay in step with norm() in scripts/build_local_geo.py. */
export function normalizeTown(name: string): string {
  let s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .trim()
    .replace(/^(town|city|village|borough|boro|township|twp) of\s+/, '');
  for (let i = 0; i < 2; i++) s = s.replace(SUFFIX, '').trim();
  return s
    .replace(/\bsaint\b/g, 'st')
    .replace(/\bmt\b\.?/g, 'mount')
    .replace(/\bft\b\.?/g, 'fort')
    .replace(/\bst\./g, 'st')
    .replace(/[^a-z]/g, '');
}

/**
 * Resolve a town or city to a county. Names repeat within a state (Pennsylvania
 * has dozens of Washington Townships), so a repeated name resolves only if the
 * utility's territory narrows it down, or every candidate is in the same metro.
 */
export function resolveTown(name: string, states: string[], territory?: ReadonlySet<string>): string | undefined {
  const key = normalizeTown(name);
  if (!key) return undefined;
  const hits = new Set<string>();
  for (const state of states) {
    const found = towns[`${state}|${key}`];
    if (typeof found === 'string') hits.add(found);
    else found?.forEach((fips) => hits.add(fips));
  }
  if (hits.size <= 1) return [...hits][0];
  const inTerritory = territory ? [...hits].filter((fips) => territory.has(fips)) : [];
  const pool = inTerritory.length ? inTerritory : [...hits];
  if (pool.length === 1) return pool[0];
  const metros = new Set(pool.map((fips) => metroForCounty(fips)));
  return metros.size === 1 && !metros.has(undefined) ? pool[0] : undefined;
}

export function resolveZip(zip: string): string | undefined {
  return zips[zip.trim().slice(0, 5)];
}
