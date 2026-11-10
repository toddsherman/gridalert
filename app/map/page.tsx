import type { Metadata } from 'next';
import Link from 'next/link';
import { SimultaneousBanner } from '@/components/Simultaneous';
import { AlertGlyph } from '@/components/Status';
import { TrendChart } from '@/components/TrendChart';
import { UsMap } from '@/components/UsMap';
import { getBlackouts, getCachedSettings, getHistory, getOpenAlerts, getSimultaneous, getSnapshot } from '@/lib/data';
import { compact, num, primaryState, spanLabel } from '@/lib/format';

export const revalidate = 60;
export const metadata: Metadata = { title: 'Map | GridAlert' };

export default async function MapPage() {
  const [snapshot, open, history, settings, blackouts, outages] = await Promise.all([getSnapshot(), getOpenAlerts(), getHistory(), getCachedSettings(), getBlackouts(), getSimultaneous()]);

  if (!snapshot) {
    return (
      <div className="card p-10 text-center">
        <h1 className="text-lg font-semibold">Waiting for the first poll</h1>
        <p className="mt-2 text-sm text-ink-2">Outage data appears here within five minutes of deployment.</p>
      </div>
    );
  }

  const affected = snapshot.metros.filter((m) => m.customersOut > 0);
  const monitoredPct = Math.round((snapshot.customersMonitored / snapshot.customersTotal) * 100);
  const t = history?.t ?? [];
  const totalPeople = (history?.total ?? []).map((c) => c * settings.peoplePerCustomer);

  return (
    <div className="flex flex-col gap-6">
      <SimultaneousBanner outages={outages} blackouts={blackouts} />

      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-ink-2">Estimated people without power</p>
          <h1 className="text-5xl font-semibold tracking-tight">{num(snapshot.estimatedPeople)}</h1>
          <p className="mt-1 text-sm text-ink-2">
            {num(snapshot.customersOut)} customers out, across {affected.length} of {snapshot.metros.length} major metros
          </p>
        </div>
        <dl className="flex flex-wrap gap-8 text-sm">
          <div>
            <dt className="text-ink-2">Open alerts</dt>
            <dd className="text-xl font-semibold">{open.length}</dd>
          </div>
          <div>
            <dt className="text-ink-2">No known cause</dt>
            <dd className="text-xl font-semibold">
              <Link href="/" className="hover:underline">
                {blackouts.filter((b) => b.cause === 'unknown' && !b.resolvedAt).length}
              </Link>
            </dd>
          </div>
          <div>
            <dt className="text-ink-2">Alert level</dt>
            <dd className="text-xl font-semibold">{compact(settings.thresholdPeople)}</dd>
          </div>
          <div>
            <dt className="text-ink-2">Customers monitored</dt>
            <dd className="text-xl font-semibold">{monitoredPct}%</dd>
          </div>
        </dl>
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section className="card p-4">
          <UsMap counties={snapshot.counties} metros={affected} peoplePerCustomer={settings.peoplePerCustomer} />
        </section>

        <div className="flex flex-col gap-6">
          <section className="card p-4">
            <h2 className="text-sm font-semibold">Open alerts</h2>
            {open.length === 0 ? (
              <p className="mt-2 text-sm text-ink-2">No metro is above {num(settings.thresholdPeople)} people right now.</p>
            ) : (
              <ul className="mt-3 flex flex-col gap-3">
                {open.slice(0, 6).map((a) => (
                  <li key={a.key} className="flex gap-2">
                    <AlertGlyph />
                    <Link href={a.scope === 'metro' ? `/metros/${a.key.replace('metro:', '')}` : '/coverage'} className="text-sm hover:underline">
                      <span className="font-medium">{a.label}</span>
                      <span className="tabular block text-ink-2">About {num(a.people)} people</span>
                    </Link>
                  </li>
                ))}
                {open.length > 6 && (
                  <li className="text-sm">
                    <Link href="/alerts" className="text-ink-2 hover:underline">
                      {open.length - 6} more
                    </Link>
                  </li>
                )}
              </ul>
            )}
          </section>

          <section className="card p-4">
            <h2 className="text-sm font-semibold">Most affected metros</h2>
            <table className="mt-2 w-full text-sm">
              <thead className="sr-only">
                <tr>
                  <th>Metro</th>
                  <th>Estimated people out</th>
                </tr>
              </thead>
              <tbody>
                {affected.slice(0, 7).map((m) => (
                  <tr key={m.cbsa} className="border-t border-line first:border-0">
                    <td className="py-1.5 pr-2">
                      <Link href={`/metros/${m.cbsa}`} className="hover:underline">
                        {m.name.split(',')[0].split('-').slice(0, 2).join('-')}
                        <span className="text-muted">, {primaryState(m.name)}</span>
                      </Link>
                    </td>
                    <td className="tabular py-1.5 text-right font-medium">{num(m.estimatedPeople)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Link href="/metros" className="mt-2 block text-xs text-ink-2 hover:underline">
              All {snapshot.metros.length} metros
            </Link>
          </section>
        </div>
      </div>

      <section className="card p-4">
        <h2 className="text-sm font-semibold">National trend: {spanLabel(t).toLowerCase()}</h2>
        <div className="mt-3">
          <TrendChart t={t} people={totalPeople} label="Estimated people without power nationally over time" />
        </div>
      </section>

      <p className="text-xs text-ink-2">
        People are estimated from utility customer counts at {settings.peoplePerCustomer} people per customer. {snapshot.sourcesOk} feeds live
        {snapshot.sourcesFrozen > 0 ? `, ${snapshot.sourcesFrozen} frozen` : ''}
        {snapshot.sourcesDown > 0 ? `, ${snapshot.sourcesDown} down` : ''}.{' '}
        <Link href="/coverage" className="underline">
          See what is monitored
        </Link>
        .
      </p>
    </div>
  );
}
