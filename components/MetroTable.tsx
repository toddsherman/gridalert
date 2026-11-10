'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { compact, num } from '@/lib/format';
import { Sparkline } from './Sparkline';

export interface MetroRow {
  cbsa: string;
  name: string;
  population: number;
  people: number;
  customers: number;
  coverage: number;
  trend: number[];
}

export function MetroTable({ rows }: { rows: MetroRow[] }) {
  const [query, setQuery] = useState('');
  const [onlyOut, setOnlyOut] = useState(false);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => (!q || r.name.toLowerCase().includes(q)) && (!onlyOut || r.customers > 0));
  }, [rows, query, onlyOut]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-4">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search metros or states"
          aria-label="Search metros or states"
          className="card w-full max-w-xs px-3 py-2.5 text-sm"
        />
        <label className="flex min-h-11 items-center gap-2 text-sm text-ink-2">
          <input type="checkbox" checked={onlyOut} onChange={(e) => setOnlyOut(e.target.checked)} />
          Only metros with outages
        </label>
        <span className="tabular text-sm text-ink-2">{shown.length} shown</span>
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="text-left text-xs text-ink-2">
              <th className="px-4 py-2 font-medium">Metro</th>
              <th className="px-4 py-2 text-right font-medium">People out (est.)</th>
              <th className="px-4 py-2 text-right font-medium">Customers out</th>
              <th className="px-4 py-2 text-right font-medium">Population</th>
              <th className="px-4 py-2 text-right font-medium">Feed coverage</th>
              <th className="px-4 py-2 font-medium">Recent trend</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.cbsa} className="border-t border-line">
                <td className="px-4 py-2">
                  <Link href={`/metros/${r.cbsa}`} className="hover:underline">
                    {r.name}
                  </Link>
                </td>
                <td className="tabular px-4 py-2 text-right font-medium">{num(r.people)}</td>
                <td className="tabular px-4 py-2 text-right text-ink-2">{num(r.customers)}</td>
                <td className="tabular px-4 py-2 text-right text-ink-2">{compact(r.population)}</td>
                <td className="tabular px-4 py-2 text-right text-ink-2">{Math.round(r.coverage * 100)}%</td>
                <td className="px-4 py-2">
                  <Sparkline values={r.trend} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
