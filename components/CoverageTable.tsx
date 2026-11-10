'use client';

import { useMemo, useState } from 'react';
import { num } from '@/lib/format';
import type { SourceHealth } from '@/lib/types';
import { HealthBadge } from './Status';

export interface CoverageRow {
  id: string;
  name: string;
  customers: number;
  method: string;
  granularity: string;
  health: SourceHealth | 'none';
  out: number;
  mapUrl?: string;
  /** Why this utility has no working feed, in public wording. */
  reason?: string;
}

const FILTERS = [
  ['all', 'All'],
  ['ok', 'Live'],
  ['problem', 'Not updating'],
  ['none', 'No feed'],
] as const;

export function CoverageTable({ rows }: { rows: CoverageRow[] }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>('all');

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (q && !r.name.toLowerCase().includes(q)) return false;
      if (filter === 'problem') return r.health === 'stale' || r.health === 'frozen' || r.health === 'down';
      return filter === 'all' || r.health === filter;
    });
  }, [rows, query, filter]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search utilities" aria-label="Search utilities" className="card w-full max-w-xs px-3 py-2.5 text-sm" />
        <div className="flex gap-1" role="group" aria-label="Filter by feed status">
          {FILTERS.map(([id, label]) => (
            <button key={id} onClick={() => setFilter(id)} aria-pressed={filter === id} className={`rounded-md px-3 py-2 text-sm ${filter === id ? 'bg-ink text-surface' : 'text-ink-2 hover:bg-line'}`}>
              {label}
            </button>
          ))}
        </div>
        <span className="tabular text-sm text-ink-2">{shown.length} shown</span>
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="text-left text-xs text-ink-2">
              <th className="px-4 py-2 font-medium">Utility</th>
              <th className="px-4 py-2 text-right font-medium">Customers</th>
              <th className="px-4 py-2 text-right font-medium">Out now</th>
              <th className="px-4 py-2 font-medium">Source</th>
              <th className="px-4 py-2 font-medium">Detail</th>
              <th className="px-4 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} className="border-t border-line align-top">
                <td className="px-4 py-2">
                  {r.mapUrl ? (
                    <a href={r.mapUrl} target="_blank" rel="noreferrer" className="hover:underline">
                      {r.name}
                    </a>
                  ) : (
                    r.name
                  )}
                  {r.reason && <div className="mt-0.5 max-w-sm text-xs text-muted">{r.reason}</div>}
                </td>
                <td className="tabular px-4 py-2 text-right text-ink-2">{r.customers ? num(r.customers) : ''}</td>
                <td className="tabular px-4 py-2 text-right">{num(r.out)}</td>
                <td className="px-4 py-2 text-ink-2">{r.method}</td>
                <td className="px-4 py-2 capitalize text-ink-2">{r.granularity}</td>
                <td className="px-4 py-2">{r.health === 'none' ? <span className="text-xs text-muted">No feed</span> : <HealthBadge health={r.health} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
