import { gunzipSync } from 'node:zlib';
import { getBytes, getJson, getPath, MAX_RESPONSE_BYTES, toCount } from './http.ts';
import type { AreaReading, CoopReportConfig, PmtilesConfig, Reading } from './types.ts';

const strip = (html: string) => html.replace(/<[^<>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** The first <dt>'s text. Plain searches, since a page full of unclosed tags would stall a lazy pattern. */
function heading(block: string): string {
  const open = block.search(/<dt>/i);
  const close = block.search(/<\/dt>/i);
  return open >= 0 && close > open ? block.slice(open + 4, close) : '';
}

/**
 * Parse a statewide co-op association's report: one <dl> per co-op, listing
 * affected counties as <li>Yancey (NC): 2</li>. Co-ops with their own direct feed
 * are excluded so they aren't counted twice.
 */
export function parseCoopReport(html: string, exclude: string[] = []): Reading {
  const skip = exclude.map((name) => name.toLowerCase());
  const areas: AreaReading[] = [];
  let customersOut = 0;
  for (const block of html.split(/<dl\b/i).slice(1)) {
    const name = strip(heading(block)).toLowerCase();
    if (skip.some((s) => name.includes(s))) continue;
    for (const part of block.split(/<\/li>/i).slice(0, -1)) {
      const open = part.search(/<li>/i);
      const row = open < 0 ? null : strip(part.slice(open + 4)).match(/^(.+?)\s*\(([A-Z]{2})\)\s*:\s*([\d,]+)/);
      if (!row) continue;
      const out = toCount(row[3]);
      customersOut += out;
      areas.push({ state: row[2], name: row[1], kind: 'county', customersOut: out });
    }
  }
  return { customersOut, areas };
}

export async function readCoopReport(cfg: CoopReportConfig): Promise<Reading> {
  const doc = await getJson<{ DetailsByCoopAlpha?: string }>(cfg.url, {
    body: 'view=details',
    headers: { 'x-requested-with': 'XMLHttpRequest', 'content-type': 'application/x-www-form-urlencoded' },
  });
  if (typeof doc?.DetailsByCoopAlpha !== 'string') throw new Error('co-op report has no DetailsByCoopAlpha');
  return parseCoopReport(doc.DetailsByCoopAlpha, cfg.exclude);
}

/** Read JSON metadata from a PMTiles v3 archive's header. Tile data isn't decoded. */
export function parsePmtilesMetadata(archive: Buffer): unknown {
  if (archive.subarray(0, 7).toString('ascii') !== 'PMTiles') throw new Error('not a PMTiles archive');
  const offset = Number(archive.readBigUInt64LE(24));
  const length = Number(archive.readBigUInt64LE(32));
  const compression = archive[97];
  const slice = archive.subarray(offset, offset + length);
  return JSON.parse((compression === 2 ? gunzipSync(slice, { maxOutputLength: MAX_RESPONSE_BYTES }) : slice).toString('utf8'));
}

export async function readPmtiles(cfg: PmtilesConfig): Promise<Reading> {
  const meta = parsePmtilesMetadata(await getBytes(cfg.url));
  const total = getPath(meta, cfg.totalPath);
  if (total === undefined) throw new Error(`totalPath "${cfg.totalPath}" missing`);
  return { customersOut: toCount(total), incidents: cfg.incidentsPath ? toCount(getPath(meta, cfg.incidentsPath)) : undefined };
}
