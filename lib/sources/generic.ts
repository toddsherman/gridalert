import { expectShape, getJson, getPath, getText, requireCount, toCount } from './http.ts';
import type { AreaReading, ArcgisConfig, JsonConfig, PlacedCause, Reading, RegexConfig } from './types.ts';

async function arcgisRows(cfg: ArcgisConfig, stats: object[], groupBy?: string): Promise<any[]> {
  const params = new URLSearchParams({
    where: cfg.where ?? '1=1',
    outStatistics: JSON.stringify(stats),
    returnGeometry: 'false',
    f: 'json',
  });
  if (groupBy) params.set('groupByFieldsForStatistics', groupBy);

  const doc = await getJson(`${cfg.layerUrl.replace(/\/$/, '')}/query?${params}`);
  if (doc?.error) throw new Error(`ArcGIS error: ${doc.error.message ?? JSON.stringify(doc.error).slice(0, 120)}`);
  expectShape(Array.isArray(doc?.features), 'ArcGIS layer');
  return doc.features.map((f: any) => f.attributes ?? {});
}

/** Sum a field across a feature layer, grouped by area when one is configured. */
export async function readArcgis(cfg: ArcgisConfig): Promise<Reading> {
  const stats = [{ statisticType: 'sum', onStatisticField: cfg.outField, outStatisticFieldName: 'out_sum' }];
  if (cfg.servedField) stats.push({ statisticType: 'sum', onStatisticField: cfg.servedField, outStatisticFieldName: 'served_sum' });
  stats.push({ statisticType: 'count', onStatisticField: cfg.outField, outStatisticFieldName: 'n' });

  const rows = await arcgisRows(cfg, stats, cfg.areaField);
  const customersOut = rows.reduce((sum, r) => sum + toCount(r.out_sum), 0);
  const served = rows.reduce((sum, r) => sum + toCount(r.served_sum), 0);
  const incidents = rows.reduce((sum, r) => sum + toCount(r.n), 0);

  const areas: AreaReading[] | undefined = cfg.areaField
    ? rows
        .filter((r) => r[cfg.areaField!] != null)
        .map((r) => ({
          state: cfg.state,
          name: String(r[cfg.areaField!]),
          kind: cfg.areaKind ?? 'county',
          customersOut: toCount(r.out_sum),
          customersServed: toCount(r.served_sum) || undefined,
        }))
    : undefined;

  return { customersOut, customersServed: served || undefined, incidents, areas };
}

/** Customers out per stated cause and area, grouped by the layer itself. */
export async function readArcgisCauses(cfg: ArcgisConfig): Promise<PlacedCause[]> {
  const stats = [{ statisticType: 'sum', onStatisticField: cfg.outField, outStatisticFieldName: 'out_sum' }];
  const rows = await arcgisRows(cfg, stats, [cfg.causeField, cfg.areaField].filter(Boolean).join(','));
  return rows
    .map((r): PlacedCause => ({
      cause: String(r[cfg.causeField!] ?? '').trim(),
      customers: toCount(r.out_sum),
      ...(cfg.areaField && r[cfg.areaField] != null && { place: { name: String(r[cfg.areaField]), state: cfg.state, kind: cfg.areaKind ?? 'county' } }),
    }))
    .filter((c) => c.customers > 0);
}

function rowState(row: any, cfg: JsonConfig): string | undefined {
  let value: unknown;
  if (cfg.stateField) value = getPath(row, cfg.stateField);
  if (cfg.stateProperty) {
    const props: any[] = Array.isArray(row?.additionalProperties) ? row.additionalProperties : [];
    value = props.find((p) => p?.property === cfg.stateProperty)?.value;
  }
  const code = (Array.isArray(value) ? value[0] : value)?.toString().trim().toUpperCase().match(/^[A-Z]{2}\b/)?.[0];
  return code ?? cfg.state;
}

async function fetchJsonDoc(cfg: JsonConfig): Promise<any> {
  let url = cfg.url;
  if (cfg.indexUrl) {
    const index = getPath(await getJson(cfg.indexUrl), cfg.indexPath);
    if (index == null) throw new Error(`index path ${cfg.indexPath} missing`);
    url = url.replace('{index}', String(index));
  }
  const headers = { ...cfg.headers };
  if (cfg.tokenUrl) {
    const token = (await getText(cfg.tokenUrl)).trim().replace(/^"|"$/g, '');
    headers.authorization = `Bearer ${token}`;
  }
  return getJson(url, { headers, body: cfg.body });
}

/** Read a JSON feed through a declarative field mapping. */
export async function readJson(cfg: JsonConfig): Promise<Reading> {
  const doc = await fetchJsonDoc(cfg);

  const reading: Reading = { customersOut: 0 };
  if (cfg.asOfPath) reading.asOf = String(getPath(doc, cfg.asOfPath) ?? '') || undefined;
  if (cfg.servedPath) reading.customersServed = toCount(getPath(doc, cfg.servedPath)) || undefined;
  if (cfg.incidentsPath) reading.incidents = toCount(getPath(doc, cfg.incidentsPath));

  if (cfg.listPath !== undefined) {
    const list = getPath(doc, cfg.listPath);
    if (!Array.isArray(list)) throw new Error(`listPath "${cfg.listPath}" is not an array`);
    const exclude = new Set((cfg.excludeAreas ?? []).map((s) => s.toLowerCase()));
    const rows = cfg.areaField
      ? list.filter((row) => !exclude.has(String(getPath(row, cfg.areaField) ?? '').toLowerCase()))
      : list;
    const out = (row: unknown) => (cfg.outField ? toCount(getPath(row, cfg.outField)) : 1);
    // Without this a renamed field reads as every row having nobody out.
    expectShape(!cfg.outField || !rows.length || rows.some((row) => getPath(row, cfg.outField) !== undefined), `outField "${cfg.outField}"`);
    reading.customersOut = rows.reduce((sum, row) => sum + out(row), 0);
    reading.incidents ??= cfg.areaField ? undefined : rows.length;
    if (cfg.servedField) {
      reading.customersServed = rows.reduce((sum, row) => sum + toCount(getPath(row, cfg.servedField)), 0) || undefined;
    }
    if (cfg.areaField) {
      // Unnamed rows still count toward the total but can't be placed.
      reading.areas = rows
        .filter((row) => getPath(row, cfg.areaField) != null)
        .map((row) => ({
          state: rowState(row, cfg),
          name: String(getPath(row, cfg.areaField)),
          kind: cfg.areaKind ?? 'county',
          customersOut: out(row),
          customersServed: cfg.servedField ? toCount(getPath(row, cfg.servedField)) || undefined : undefined,
        }));
    }
  }

  // A published total wins over a summed list, which may be truncated.
  if (cfg.totalPath) {
    reading.customersOut = requireCount(getPath(doc, cfg.totalPath), `totalPath "${cfg.totalPath}"`);
  }
  if (cfg.listPath === undefined && !cfg.totalPath) throw new Error('json source needs totalPath or listPath');
  return reading;
}

/** Customers out per stated cause and area, one entry for each of a feed's list rows. */
export async function readJsonCauses(cfg: JsonConfig): Promise<PlacedCause[]> {
  const list = getPath(await fetchJsonDoc(cfg), cfg.listPath);
  if (!Array.isArray(list)) throw new Error(`listPath "${cfg.listPath}" is not an array`);
  return list
    .map((row): PlacedCause => {
      const name = cfg.areaField ? getPath(row, cfg.areaField) : undefined;
      return {
        cause: String(getPath(row, cfg.causeField) ?? '').trim(),
        customers: cfg.outField ? toCount(getPath(row, cfg.outField)) : 1,
        ...(name != null && { place: { name: String(name), state: rowState(row, cfg), kind: cfg.areaKind ?? 'county' } }),
      };
    })
    .filter((c) => c.customers > 0);
}

/** Last resort for pages that only publish a number in markup. */
export async function readRegex(cfg: RegexConfig): Promise<Reading> {
  const text = await getText(cfg.url, { headers: cfg.headers });
  if (cfg.sumAll) {
    const rows = [...text.matchAll(new RegExp(cfg.pattern, 'gs'))];
    return { customersOut: rows.reduce((sum, m) => sum + toCount(m[1]), 0), incidents: rows.length };
  }
  const match = text.match(new RegExp(cfg.pattern, 's'));
  if (!match) throw new Error('pattern did not match');
  const served = cfg.servedPattern ? text.match(new RegExp(cfg.servedPattern, 's')) : null;
  return { customersOut: toCount(match[1]), customersServed: served ? toCount(served[1]) : undefined };
}
