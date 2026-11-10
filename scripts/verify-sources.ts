// Run every entry in a source file through the production adapters.
// usage: node scripts/verify-sources.ts data/sources/<file>.json [--only id1,id2]
import fs from 'node:fs';
import { readSource, validateReading } from '../lib/sources/read.ts';
import { RUNNABLE_METHODS, type Source } from '../lib/sources/types.ts';

const file = process.argv[2];
const onlyArg = process.argv.indexOf('--only');
const only = onlyArg > 0 ? new Set(process.argv[onlyArg + 1].split(',')) : null;

const entries: any[] = JSON.parse(fs.readFileSync(file, 'utf8'));
const seen = new Set<string>();

let ok = 0;
let failed = 0;
let skipped = 0;
for (const e of entries) {
  if (only && !only.has(e.id)) continue;
  for (const field of ['id', 'name', 'eiaIds', 'method']) {
    if (e[field] === undefined) console.log(`SCHEMA  ${e.id ?? '?'}: missing ${field}`);
  }
  if (seen.has(e.id)) console.log(`SCHEMA  duplicate id ${e.id}`);
  seen.add(e.id);
  if (!RUNNABLE_METHODS.has(e.method)) {
    skipped++;
    console.log(`skip    ${String(e.id).padEnd(26)} ${e.method}: ${String(e.notes ?? '').slice(0, 70)}`);
    continue;
  }
  const started = Date.now();
  try {
    const reading = await readSource(e as Source);
    const invalid = validateReading(reading);
    if (invalid) throw new Error(invalid);
    const areas = reading.areas ?? [];
    const areaSum = areas.reduce((s, a) => s + a.customersOut, 0);
    const kinds = [...new Set(areas.map((a) => a.kind))].join('/');
    ok++;
    console.log(
      `ok      ${String(e.id).padEnd(26)} out=${String(reading.customersOut).padStart(7)} served=${String(reading.customersServed ?? '-').padStart(8)} ` +
        `areas=${areas.length}${kinds ? `(${kinds})` : ''}${areas.length ? ` areaSum=${areaSum}` : ''} ${Date.now() - started}ms ${reading.mode ?? ''}`,
    );
  } catch (err) {
    failed++;
    console.log(`FAIL    ${String(e.id).padEnd(26)} ${(err as Error).message.slice(0, 110)}`);
  }
}
console.log(`\n${ok} ok, ${failed} failed, ${skipped} not runnable`);
process.exitCode = failed ? 1 : 0;
