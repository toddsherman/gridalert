// Run one full poll locally against the real Blob store.
// usage: node scripts/run-once.ts
export {};

process.loadEnvFile('.env.local');
const { runOnce } = await import('../lib/run.ts');
const { PATHS, readDoc } = await import('../lib/store.ts');

const result = await runOnce();
console.log(result);

const stored = await readDoc<any>(PATHS.latest, { fresh: true });
const s = stored?.value;
if (s) {
  console.log(`total out ${s.customersOut}, ok ${s.sourcesOk}, stale ${s.sourcesStale}, frozen ${s.sourcesFrozen}, down ${s.sourcesDown}, took ${s.durationMs}ms`);
  console.log(`monitored ${s.customersMonitored} of ${s.customersTotal} (${Math.round((s.customersMonitored / s.customersTotal) * 100)}%)`);
  console.log('top metros:', s.metros.slice(0, 8).map((m: any) => `${m.name.split(',')[0].split('-')[0]} ${m.customersOut}`).join(' | '));
  console.log('top utilities:', s.utilities.slice(0, 8).map((u: any) => `${u.name} ${u.customersOut}`).join(' | '));
  const down = s.utilities.filter((u: any) => u.health !== 'ok');
  if (down.length) console.log('not ok:', down.slice(0, 15).map((u: any) => `${u.id}: ${u.error}`).join('\n  '));
  console.log('unmatched areas:', s.unmatchedAreas.length, s.unmatchedAreas.slice(0, 12).map((a: any) => `${a.source}:${a.state ?? '?'}:${a.name}(${a.customersOut})`).join(', '));
  console.log('bytes', JSON.stringify(s).length);
}
