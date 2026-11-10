import type { Metadata } from 'next';
import { MetroTable, type MetroRow } from '@/components/MetroTable';
import { getHistory, getSnapshot } from '@/lib/data';
import { peaks } from '@/lib/format';

export const revalidate = 60;
export const metadata: Metadata = { title: 'Metros | GridAlert' };

export default async function MetrosPage() {
  const [snapshot, history] = await Promise.all([getSnapshot(), getHistory()]);
  const rows: MetroRow[] = (snapshot?.metros ?? []).map((m) => ({
    cbsa: m.cbsa,
    name: m.name,
    population: m.population,
    people: m.estimatedPeople,
    customers: m.customersOut,
    coverage: m.coverage,
    trend: peaks(history?.metros[m.cbsa]?.slice(-672) ?? [], 42),
  }));
  return (
    <div>
      <h1 className="font-serif text-2xl font-semibold tracking-tight">Metros</h1>
      <p className="explanation-copy mt-2 text-base text-ink-2">Every US metro area of 250,000 people or more.</p>
      <div className="mt-5">
        <MetroTable rows={rows} />
      </div>
    </div>
  );
}
