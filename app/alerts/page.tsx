import type { Metadata } from 'next';
import Link from 'next/link';
import { AlertGlyph } from '@/components/Status';
import { getAlertLog, getCachedSettings, getOpenAlerts } from '@/lib/data';
import { eastern, num } from '@/lib/format';

export const revalidate = 60;
export const metadata: Metadata = { title: 'Alerts | GridAlert' };

const KIND = { opened: 'Opened', escalated: 'Grew', resolved: 'Resolved', unexplained: 'Unexplained', explained: 'Explained',
  deliberate: 'Reported deliberate', simultaneous: 'Simultaneous', 'simultaneous-explained': 'Stood down' } as const;

export default async function AlertsPage() {
  const [open, log, settings] = await Promise.all([getOpenAlerts(), getAlertLog(), getCachedSettings()]);
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-serif text-2xl font-semibold tracking-tight">Alerts</h1>
        <p className="explanation-copy mt-2 text-base text-ink-2">Outages of {num(settings.thresholdPeople)} or more estimated people in one metro are listed here but not sent. Only high-priority alerts and their follow-ups are. Times are Eastern.</p>
      </div>

      <section>
        <h2 className="text-sm font-semibold">Open now</h2>
        {open.length === 0 ? (
          <p className="mt-2 text-sm text-ink-2">No open alerts.</p>
        ) : (
          <ul className="mt-3 grid gap-3 sm:grid-cols-2">
            {open.map((a) => (
              <li key={a.key} className="card flex gap-3 p-4">
                <AlertGlyph />
                <div className="text-sm">
                  <Link href={a.scope === 'metro' ? `/metros/${a.key.replace('metro:', '')}` : '/coverage'} className="font-medium hover:underline">
                    {a.label}
                  </Link>
                  <p className="tabular text-ink-2">About {num(a.people)} people now, peak {num(a.peakPeople)}</p>
                  <p className="text-xs text-muted">Since {eastern(a.openedAt)}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-sm font-semibold">History</h2>
        {log.length === 0 ? (
          <p className="mt-2 text-sm text-ink-2">No alerts yet.</p>
        ) : (
          <div className="card mt-3 overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="text-left text-xs text-ink-2">
                  <th className="px-4 py-2 font-medium">When</th>
                  <th className="px-4 py-2 font-medium">Event</th>
                  <th className="px-4 py-2 font-medium">Area</th>
                  <th className="px-4 py-2 text-right font-medium">People</th>
                  <th className="px-4 py-2 font-medium">Sent</th>
                </tr>
              </thead>
              <tbody>
                {log.slice(0, 200).map((e) => (
                  <tr key={e.id} className="border-t border-line">
                    <td className="tabular whitespace-nowrap px-4 py-2 text-ink-2">{eastern(e.at)}</td>
                    <td className="px-4 py-2">{KIND[e.kind]}</td>
                    <td className="px-4 py-2">{e.label}</td>
                    <td className="tabular px-4 py-2 text-right">{e.key.startsWith('system:') ? e.detail : num(e.people)}</td>
                    <td className="px-4 py-2 text-ink-2">{e.dropped ? 'Could not be sent' : e.siteOnly ? 'Site only' : (e.channels?.join(', ') ?? '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
