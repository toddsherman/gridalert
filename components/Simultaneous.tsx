import Link from 'next/link';
import { num } from '@/lib/format';
import { outageDetail } from '@/lib/simultaneous';
import type { Blackout, SimultaneousOutage } from '@/lib/types';
import { AlertGlyph } from './Status';

interface Props {
  outages: SimultaneousOutage[];
  blackouts: Blackout[];
}

export function SimultaneousBanner({ outages, blackouts }: Props) {
  const active = outages.filter((o) => !o.standDownAt && blackouts.some((b) => o.members.includes(b.id) && !b.resolvedAt));
  return active.map((o) => {
    const d = outageDetail(o, blackouts);
    return (
      <Link key={o.id} href="/#alerts" className="card flex gap-3 p-4 text-sm hover:bg-line">
        <AlertGlyph />
        <span>
          <span className="font-medium">Simultaneous blackouts: {d.areas}.</span>{' '}
          <span className="text-ink-2">
            {d.count} unrelated areas, {num(d.customers)} customers at peak, started {d.started} ET. No ordinary cause found.
          </span>
        </span>
      </Link>
    );
  });
}
