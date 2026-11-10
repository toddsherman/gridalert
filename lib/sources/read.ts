import { readCoopReport, readPmtiles } from './coop.ts';
import { readArcgis, readArcgisCauses, readJson, readJsonCauses, readRegex } from './generic.ts';
import { readKubra, readKubraCauses, readKubraLegacy } from './kubra.ts';
import type { PlacedCause, Reading, SourceSpec } from './types.ts';

export function readSource(source: SourceSpec): Promise<Reading> {
  switch (source.method) {
    case 'kubra':
      return readKubra(source.config);
    case 'kubra-legacy':
      return readKubraLegacy(source.config);
    case 'arcgis':
      return readArcgis(source.config);
    case 'json':
      return readJson(source.config);
    case 'regex':
      return readRegex(source.config);
    case 'coop-report':
      return readCoopReport(source.config);
    case 'pmtiles':
      return readPmtiles(source.config);
  }
}

/**
 * What a feed says caused its current outages, or nothing if it doesn't say. Kubra's come from the
 * map tiles around these points. The rest cover the whole feed, with the area on each row.
 */
export async function readCauses(source: SourceSpec, points: Array<[number, number]>): Promise<PlacedCause[]> {
  if (source.method === 'kubra') return readKubraCauses(source.config, points);
  if (source.method === 'arcgis' && source.config.causeField) return readArcgisCauses(source.config);
  if (source.method === 'json' && source.config.causeField) return readJsonCauses(source.config);
  return [];
}

/** Room for EIA's customer counts running a year or two behind. */
const REGISTERED_MARGIN = 1.25;

/**
 * Reject readings that can't be real so a bad feed can't trigger an alert. A feed's own
 * customer count can be wrong along with the rest of it, so the registry has the last word.
 */
export function validateReading(reading: Reading, registered = 0): string | null {
  if (!Number.isFinite(reading.customersOut) || reading.customersOut < 0) return `invalid customersOut: ${reading.customersOut}`;
  const served = reading.customersServed;
  if (served && reading.customersOut > served * 1.1) return `customersOut ${reading.customersOut} exceeds served ${served}`;
  if (registered && reading.customersOut > registered * REGISTERED_MARGIN) return `customersOut ${reading.customersOut} exceeds registered ${registered}`;
  return null;
}
