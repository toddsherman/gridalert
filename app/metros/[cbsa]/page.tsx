import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { HealthBadge } from '@/components/Status';
import { TrendChart } from '@/components/TrendChart';
import { getCachedSettings, getHistory, getOpenAlerts, getSnapshot } from '@/lib/data';
import { compact, num, plural, spanLabel } from '@/lib/format';
import { metroByCbsa, utilityByEia } from '@/lib/registry';

export const revalidate = 60;

export function generateStaticParams() {
  return [];
}

export async function generateMetadata({ params }: PageProps<'/metros/[cbsa]'>): Promise<Metadata> {
  const { cbsa } = await params;
  return { title: `${metroByCbsa.get(cbsa)?.name ?? 'Metro'} | GridAlert` };
}

export default async function MetroPage({ params }: PageProps<'/metros/[cbsa]'>) {
  const { cbsa } = await params;
  const registry = metroByCbsa.get(cbsa);
  if (!registry) notFound();

  const [snapshot, history, settings, open] = await Promise.all([getSnapshot(), getHistory(), getCachedSettings(), getOpenAlerts()]);
  const metro = snapshot?.metros.find((m) => m.cbsa === cbsa);
  if (!snapshot || !metro) notFound();

  const alert = open.find((a) => a.key === `metro:${cbsa}`);
  const series = history?.metros[cbsa] ?? [];
  const t = (history?.t ?? []).slice(-series.length);
  const people = series.map((c) => Math.round(c * settings.peoplePerCustomer));
  const countyMax = Math.max(...metro.counties.map((c) => c.customersOut), 1);

  // Every utility EIA says serves this metro, joined to its live feed status.
  const serving = registry.utilities.flatMap((eia) => {
    const u = utilityByEia.get(eia);
    if (!u) return [];
    const feed = snapshot.utilities.find((row) => row.eiaIds.includes(eia));
    return [{ eia, name: u.name, customers: u.customers, feed, outHere: metro.utilities.find((x) => x.id === feed?.id)?.customersOut ?? 0 }];
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/metros" className="text-xs text-ink-2 hover:underline">
          All metros
        </Link>
        <h1 className="font-serif text-2xl font-semibold tracking-tight">{metro.name}</h1>
        <p className="text-sm text-ink-2">
          {compact(metro.population)} people, {registry.counties.length} {registry.counties.length === 1 ? 'county' : 'counties'}
        </p>
      </div>

      <section className="flex flex-wrap items-end gap-x-10 gap-y-3">
        <div>
          <p className="text-sm text-ink-2">Estimated people without power</p>
          <p className="text-5xl font-semibold tracking-tight">{num(metro.estimatedPeople)}</p>
          <p className="mt-1 text-sm text-ink-2">{plural(metro.customersOut, 'customer')} out</p>
        </div>
        <p className="text-sm text-ink-2">
          {alert ? `Alert open since ${new Date(alert.openedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}, peak about ${num(alert.peakPeople)} people` : `Below the ${num(settings.thresholdPeople)}-person alert level`}
        </p>
      </section>

      <section className="card p-4">
        <h2 className="text-sm font-semibold">Estimated people out: {spanLabel(t).toLowerCase()}</h2>
        <div className="mt-3">
          <TrendChart t={t} people={people} alertLevel={settings.thresholdPeople} label={`Estimated people without power in ${metro.name} over time`} />
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card p-4">
          <h2 className="text-sm font-semibold">Counties</h2>
          {metro.counties.length === 0 ? (
            <p className="mt-2 text-sm text-ink-2">No county-level outages reported.</p>
          ) : (
            <ul className="mt-3 flex flex-col gap-2">
              {metro.counties.map((c) => (
                <li key={c.fips} className="text-sm">
                  <div className="flex justify-between">
                    <span>{c.name}</span>
                    <span className="tabular text-ink-2">{plural(c.customersOut, 'customer')}</span>
                  </div>
                  <div className="mt-1 h-1 rounded-full bg-line">
                    <div className="h-1 rounded-full bg-series" style={{ width: `${(c.customersOut / countyMax) * 100}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card p-4">
          <h2 className="text-sm font-semibold">Utilities serving this metro</h2>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-ink-2">
                  <th className="py-1 pr-3 font-medium">Utility</th>
                  <th className="py-1 pr-3 text-right font-medium">Out here</th>
                  <th className="py-1 font-medium">Feed</th>
                </tr>
              </thead>
              <tbody>
                {serving.slice(0, 14).map((u) => (
                  <tr key={u.eia} className="border-t border-line">
                    <td className="py-1.5 pr-3">
                      {u.feed?.mapUrl ? (
                        <a href={u.feed.mapUrl} target="_blank" rel="noreferrer" className="hover:underline">
                          {u.name}
                        </a>
                      ) : (
                        u.name
                      )}
                    </td>
                    <td className="tabular py-1.5 pr-3 text-right">{num(u.outHere)}</td>
                    <td className="py-1.5">{u.feed ? <HealthBadge health={u.feed.health} /> : <span className="text-xs text-muted">No feed</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {serving.length > 14 && <p className="mt-2 text-xs text-ink-2">Plus {serving.length - 14} smaller utilities.</p>}
          <p className="mt-2 text-xs text-ink-2">{Math.round(metro.coverage * 100)}% of this metro is covered by a live feed.</p>
        </section>
      </div>
    </div>
  );
}
