// Run the blackout checks against the live state without writing anything.
// usage: node scripts/check-causes.ts
export {};

process.loadEnvFile('.env.local');
const { causeLine, takeNotices, updateBlackouts } = await import('../lib/blackouts.ts');
const { PATHS, readDoc } = await import('../lib/store.ts');
const { DEFAULT_SETTINGS } = await import('../lib/types.ts');

const engine = (await readDoc<any>(PATHS.engine, { fresh: true }))?.value?.engine;
const snapshot = (await readDoc<any>(PATHS.latest, { fresh: true }))?.value;
if (!engine || !snapshot) throw new Error('no state yet');

const prev = (await readDoc<any>(PATHS.blackouts, { fresh: true }))?.value ?? [];
const started = Date.now();
const list = await updateBlackouts(prev, engine, snapshot, DEFAULT_SETTINGS.peoplePerCustomer, new Date());
console.log(`${list.length} blackouts, ${Object.keys(engine.open).length} open alerts, checks took ${Date.now() - started} ms\n`);

const settings = { ...DEFAULT_SETTINGS, ...(await readDoc<any>(PATHS.settings, { fresh: true }))?.value };
const { events } = takeNotices(list, settings, new Date().toISOString());
console.log(`high-priority notices due now: ${events.length ? events.map((e: any) => `${e.kind} ${e.label}`).join('; ') : 'none'}\n`);

for (const b of list.filter((x: any) => !x.resolvedAt)) {
  console.log(`${b.label}  [${b.cause}]  started ${b.startedAt}  peak ${b.peakPeople} people, ${b.peakCustomers} customers`);
  console.log(`  counties: ${b.counties.length}  utilities: ${b.utilities.map((u: any) => u.id).join(', ')}`);
  console.log(`  checked: ${b.checked.join(', ')}`);
  for (const e of b.evidence) console.log(`  ${e.strong ? 'STRONG' : 'context'}: ${e.label} (${e.source}, ${e.at})`);
  if (b.utilityCauses.length) console.log(`  utility maps: ${b.utilityCauses.map((c: any) => `${c.cause || '(blank)'} ${c.customers}`).join(' | ')}`);
  console.log(`  alert line: ${causeLine(b)}\n`);
}
