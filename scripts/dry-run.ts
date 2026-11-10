// Poll every feed and report data quality, without writing state or sending alerts.
// usage: node scripts/dry-run.ts
export {};

const { collect } = await import('../lib/collector.ts');
const { utilityByEia } = await import('../lib/registry.ts');
const { DEFAULT_SETTINGS } = await import('../lib/types.ts');

const { snapshot: s } = await collect({}, DEFAULT_SETTINGS, new Date());
console.log(`out ${s.customersOut}; ok ${s.sourcesOk}, down ${s.sourcesDown}; ${s.durationMs}ms; ${Math.round((s.customersMonitored / s.customersTotal) * 100)}% monitored; snapshot ${JSON.stringify(s).length} bytes`);

const down = s.utilities.filter((u) => u.health !== 'ok');
if (down.length) console.log('\nFAILING\n' + down.map((u) => `  ${u.id}: ${u.error}`).join('\n'));

// A feed with county data should place most of its customers.
const placed = s.utilities.filter((u) => u.customersOut >= 25 && !u.id.startsWith('odin-')).map((u) => ({ ...u, share: u.attributedOut / u.customersOut }));
const weak = placed.filter((u) => u.share < 0.8 && u.granularity !== 'utility' && u.granularity !== 'incident');
if (weak.length) console.log('\nCOUNTY GRAIN BUT POORLY PLACED\n' + weak.map((u) => `  ${u.id} (${u.granularity}): ${u.attributedOut}/${u.customersOut}`).join('\n'));
const over = placed.filter((u) => u.share > 1.25);
if (over.length) console.log('\nAREAS SUM WELL ABOVE TOTAL\n' + over.map((u) => `  ${u.id}: ${u.attributedOut}/${u.customersOut}`).join('\n'));

const served = s.utilities.filter((u) => u.customersServed && u.customersOut / u.customersServed > 0.1);
if (served.length) console.log('\nOVER 10% OUT, CHECK\n' + served.map((u) => `  ${u.id}: ${u.customersOut}/${u.customersServed}`).join('\n'));

// Feeds publish their own customer count, so EIA's is an independent check on
// whether a config points at the right scope.
const scope = s.utilities.flatMap((u) => {
  const eia = u.eiaIds.reduce((sum, id) => sum + (utilityByEia.get(id)?.customers ?? 0), 0);
  if (!eia || !u.customersServed || u.id.startsWith('odin-') || u.method === 'odin') return [];
  const ratio = u.customersServed / eia;
  return ratio < 0.7 || ratio > 1.3 ? [`  ${u.id}: feed says ${u.customersServed}, EIA says ${eia} (${ratio.toFixed(2)}x)`] : [];
});
if (scope.length) console.log('\nCUSTOMER COUNT DISAGREES WITH EIA\n' + scope.join('\n'));

if (s.unmatchedAreas.length) console.log('\nUNMATCHED AREAS\n' + s.unmatchedAreas.map((a) => `  ${a.source}: ${a.state ?? '?'} ${a.name} (${a.customersOut})`).join('\n'));

console.log('\nTOP UTILITIES\n' + s.utilities.slice(0, 14).map((u) => `  ${String(u.customersOut).padStart(7)} ${u.name} [${u.method}]`).join('\n'));
console.log('\nTOP METROS\n' + s.metros.slice(0, 10).map((m) => `  ${String(m.customersOut).padStart(7)} ${m.name}`).join('\n'));
