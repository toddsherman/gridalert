import Link from 'next/link';
import { easternDay, num, shortMetro } from '@/lib/format';
import type { TrackRecord as Summary } from '@/lib/record';
import { AlertGlyph } from './Status';

/** What GridAlert has tracked so far, and what it made of the outages that came near the alert level. */
export function TrackRecord({ record, level }: { record: Summary; level: number }) {
  if (!record.tracked || !record.since) return null;
  const tiles: Array<[string, string]> = [
    [num(record.tracked), 'outages tracked'],
    [num(record.reached), 'reached the alert level'],
    [num(record.explained), 'of those explained'],
    [num(record.alerts), 'alerts sent'],
  ];

  return (
    <section id="record" className="flex scroll-mt-16 flex-col gap-3">
      <div>
        <h2 className="font-serif text-xl font-semibold tracking-tight">Track record</h2>
        <p className="explanation-copy mt-1 text-[15px] text-ink-2">
          Since {easternDay(record.since)}. Most outages are small and never come near an alert.{record.rows.length > 0 && ` The ones that reached half the alert level of ${num(level)} customers are listed, with what was found.`}
        </p>
      </div>
      <dl className="card grid grid-cols-2 divide-line overflow-hidden sm:grid-cols-4 sm:divide-x">
        {tiles.map(([value, label]) => (
          <div key={label} className="flex flex-col gap-0.5 px-4 py-3">
            <dt className="order-2 text-[10px] uppercase tracking-[0.12em] text-muted">{label}</dt>
            <dd className="tabular font-mono text-xl text-ink">{value}</dd>
          </div>
        ))}
      </dl>
      {record.rows.length > 0 && (
        <ul className="card divide-y divide-line">
          {record.rows.map((r) => (
            <li key={r.id} className="flex flex-col gap-1 px-4 py-3 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                <span className="flex items-center gap-2 font-medium">
                  {r.alerted && <AlertGlyph />}
                  <Link href={r.link} className="hover:underline">
                    {shortMetro(r.label)}
                  </Link>
                </span>
                <span className="tabular text-xs text-muted">
                  {easternDay(r.startedAt)} · {num(r.customers)} customers
                </span>
              </div>
              <p className="explanation-copy text-[15px] text-ink-2">{r.outcome}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
