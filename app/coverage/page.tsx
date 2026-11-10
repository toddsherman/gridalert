import type { Metadata } from 'next';
import { CoverageTable, type CoverageRow } from '@/components/CoverageTable';
import { getHealth, getSnapshot } from '@/lib/data';
import { eastern, num } from '@/lib/format';
import { type CheckHealth, feedNotes } from '@/lib/health';
import { unmonitored, utilityByEia } from '@/lib/registry';

export const revalidate = 60;
export const metadata: Metadata = { title: 'Coverage | GridAlert' };

const METHOD_LABEL: Record<string, string> = {
  kubra: 'Kubra Storm Center',
  'kubra-legacy': 'Kubra (legacy)',
  arcgis: 'ArcGIS service',
  json: 'Utility JSON feed',
  regex: 'Page parse',
  odin: 'DOE ODIN',
  'coop-report': 'Co-op association report',
  pmtiles: 'Map tile metadata',
};

const customersOf = (ids: number[]) => ids.reduce((s, id) => s + (utilityByEia.get(id)?.customers ?? 0), 0);

/** Public wording for why a utility has no feed. Internal notes stay in the data files. */
function gapReason(notes: string): string {
  if (notes.startsWith('embedded-key')) return 'Its outage data requires an access key.';
  if (notes.startsWith('blocked')) return 'The utility blocks automated access.';
  if (notes.startsWith('terms')) return 'The utility does not permit third-party use.';
  return 'No usable public feed found yet.';
}

/** Public wording only: raw errors can quote whatever a feed sent. */
function checkState(c: CheckHealth): string {
  if (c.failsInARow === 0) return 'Readable';
  if (c.shape) return 'Changed format, needs a fix';
  return c.lastOkAt ? `Not readable since ${eastern(c.lastOkAt)} ET` : 'Not readable yet';
}

export default async function CoveragePage() {
  const [snapshot, health] = await Promise.all([getSnapshot(), getHealth()]);
  const checks = Object.entries(health?.checks ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const failing = checks.filter(([, c]) => c.failsInARow > 0);
  const notes = snapshot ? feedNotes(snapshot, Date.parse(snapshot.generatedAt)) : [];
  const live: CoverageRow[] = (snapshot?.utilities ?? []).map((u) => ({
    id: u.id,
    name: u.name,
    customers: customersOf(u.eiaIds) || (u.customersServed ?? 0),
    method: METHOD_LABEL[u.method] ?? u.method,
    granularity: u.granularity,
    health: u.health,
    out: u.customersOut,
    mapUrl: u.mapUrl,
    reason: u.health === 'ok' ? undefined : u.frozenSince ? `Answers, but has not updated since ${eastern(u.frozenSince)} ET.` : 'Feed is not responding.',
  }));
  const liveEia = new Set((snapshot?.utilities ?? []).flatMap((u) => u.eiaIds));
  const gaps: CoverageRow[] = unmonitored
    .filter((u) => !u.eiaIds.some((id) => liveEia.has(id)))
    .map((u) => ({
      id: u.id,
      name: u.name,
      customers: customersOf(u.eiaIds),
      method: u.method === 'odin-only' ? 'DOE ODIN' : 'No feed',
      granularity: u.granularity ?? '',
      health: u.method === 'odin-only' ? 'ok' : 'none',
      out: 0,
      mapUrl: u.mapUrl,
      reason: u.method === 'odin-only' ? undefined : gapReason(u.notes),
    }));
  const rows = [...live, ...gaps].sort((a, b) => b.customers - a.customers);

  const pct = snapshot ? Math.round((snapshot.customersMonitored / snapshot.customersTotal) * 100) : 0;

  const methods = new Map<string, number>();
  for (const r of rows) methods.set(r.method, (methods.get(r.method) ?? 0) + 1);
  return (
    <div>
      <h1 className="font-serif text-2xl font-semibold tracking-tight">Coverage</h1>
      <p className="explanation-copy mt-2 text-base text-ink-2">
        {num(snapshot?.customersMonitored ?? 0)} of {num(snapshot?.customersTotal ?? 0)} customers in major metros ({pct}%) are on a live feed.
      </p>
      <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm">
        {[...methods.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([method, count]) => (
            <div key={method} className="flex gap-1.5">
              <dt className="text-ink-2">{method}</dt>
              <dd className="tabular font-medium">{count}</dd>
            </div>
          ))}
      </dl>
      {snapshot?.impaired?.length ? (
        <p role="alert" className="mt-4 text-sm font-medium">
          High-priority alerts may not get through right now: {snapshot.impaired.join(', ')}.
        </p>
      ) : null}
      {notes.length > 0 && (
        <section className="mt-5">
          <h2 className="text-sm font-semibold">Feeds to look at</h2>
          <ul className="mt-1 text-sm text-ink-2">
            {notes.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      )}
      <div className="mt-5">
        <CoverageTable rows={rows} />
      </div>
      {checks.length > 0 && (
        <section className="mt-6">
          <h2 className="text-sm font-semibold">Outside services</h2>
          <p className="explanation-copy mt-2 text-base text-ink-2">
            Read every hour whether or not anything is wrong, last at {eastern(health!.probedAt)} ET. {failing.length ? `${failing.length} of ${checks.length} can't be read.` : `All ${checks.length} can be read.`}
          </p>
          <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            {checks.map(([name, c]) => (
              <div key={name} className="flex justify-between gap-3 border-t border-line py-1">
                <dt>{name}</dt>
                <dd className={c.failsInARow ? 'font-medium' : 'text-ink-2'}>{checkState(c)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </div>
  );
}
