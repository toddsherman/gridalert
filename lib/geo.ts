import geo from '../data/geo.json' with { type: 'json' };

const index = geo.index as Record<string, string>;
const metroOf = geo.metroOf as Record<string, string>;
const names = geo.names as Record<string, string>;

export function normalizeCounty(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\bsaint\b/g, 'st')
    .replace(/\bsainte\b/g, 'ste')
    .replace(/\bst\./g, 'st')
    .replace(/\bste\./g, 'ste')
    .replace(/\be\.\s*/g, 'east ')
    .replace(/\bw\.\s*/g, 'west ')
    .replace(/\bn\.\s*/g, 'north ')
    .replace(/\bs\.\s*/g, 'south ')
    .replace(/\b(county|parish|borough|census area|municipality|city and borough|planning region|co\.)\b/g, '')
    .replace(/[^a-z]/g, '');
}

/** Names in use that the county list spells differently. */
const ALIASES: Record<string, string> = { 'DC|washington': '11001', 'LA|vermillion': '22113' };
/** SPC cuts county names at this length, which leaves "District of Colum". */
const SPC_NAME_CHARS = 17;

/** An index key for a name, reading "City of Suffolk" as Virginia's "Suffolk City". */
const keyOf = (name: string) => normalizeCounty(name.replace(/^\s*city of\s+(.+)$/i, '$1 city'));

/**
 * Resolve a published county name to FIPS, trying each state when the feed has
 * none. A name found in two of a utility's states is ambiguous, so it only
 * resolves if exactly one match is in the utility's known territory.
 */
export function resolveCounty(name: string, states: string[], territory?: ReadonlySet<string>): string | undefined {
  const key = keyOf(name);
  if (!key) return undefined;
  const hits = new Set<string>();
  for (const state of states) {
    const fips = index[`${state}|${key}`] ?? ALIASES[`${state}|${key}`];
    if (fips) hits.add(fips);
  }
  if (hits.size <= 1) return [...hits][0];
  const inTerritory = [...hits].filter((fips) => territory?.has(fips));
  return inTerritory.length === 1 ? inTerritory[0] : undefined;
}

/** Whether a name is a county in any of these states, even one that can't be told apart. */
export const isCountyName = (name: string, states: string[]) => states.some((state) => index[`${state}|${keyOf(name)}`]);

/** Resolve a county in an SPC storm report, allowing for names it has cut short. */
export function resolveReportCounty(name: string, state: string): string | undefined {
  const found = resolveCounty(name, [state]);
  if (found || name.trim().length < SPC_NAME_CHARS) return found;
  const prefix = `${state}|${normalizeCounty(name.replace(/^\s*city of\s+/i, ''))}`;
  const hits = new Set(Object.entries(index).filter(([key]) => key.startsWith(prefix)).map(([, fips]) => fips));
  return hits.size === 1 ? [...hits][0] : undefined;
}

/**
 * Connecticut's planning regions replaced its counties in 2022, but NWS, SPC and NIFC still use
 * the old codes, as do the town and ZIP tables feeds resolve through. Metros list the new ones, so
 * a blackout with no county detail needs these to match a storm. Each is the old counties it overlaps.
 */
const CT_OLD_COUNTIES: Record<string, string[]> = {
  '09110': ['09003', '09013'],
  '09120': ['09001'],
  '09130': ['09007', '09011'],
  '09140': ['09001', '09005', '09009'],
  '09150': ['09013', '09015'],
  '09160': ['09003', '09005'],
  '09170': ['09009'],
  '09180': ['09011', '09015'],
  '09190': ['09001', '09005'],
};

/** A county and any older code that storm and fire feeds may know it by. */
export const withOldCodes = (fips: string): string[] => [fips, ...(CT_OLD_COUNTIES[fips] ?? [])];

export function metroForCounty(fips: string): string | undefined {
  return metroOf[fips];
}

export function countyName(fips: string): string {
  return names[fips] ?? fips;
}
