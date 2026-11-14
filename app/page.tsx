import type { Metadata } from 'next';
import { type AlertArea, type AlertCard, AlertList } from '@/components/AlertList';
import { HowItWorks } from '@/components/HowItWorks';
import { SignUp } from '@/components/SignUp';
import { TrackRecord } from '@/components/TrackRecord';
import { causesKnown, shareExplained } from '@/lib/causes/utility';
import { getBlackouts, getCachedSettings, getSimultaneous, getSnapshot } from '@/lib/data';
import { eastern, num, threadsSearch, xSearch } from '@/lib/format';
import { trackRecord } from '@/lib/record';
import { metros, sources } from '@/lib/registry';
import { PUBLIC_URL } from '@/lib/site';
import type { Blackout, SimultaneousOutage } from '@/lib/types';

export const revalidate = 60;

const thumbnail = {
  url: `${PUBLIC_URL}/project-previews/gridalert-palette-v1.webp`,
  width: 1600,
  height: 1000,
  alt: 'Transmission towers connect to a paper city, with a red ring marking a broken power line.',
};

export const metadata: Metadata = {
  alternates: { canonical: PUBLIC_URL },
  openGraph: {
    type: 'website',
    url: PUBLIC_URL,
    title: 'GridAlert',
    description: 'Get an alert when a large blackout in the 50 states has no explanation.',
    images: [thumbnail],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'GridAlert',
    description: 'Get an alert when a large blackout in the 50 states has no explanation.',
    images: [thumbnail],
  },
};

/** An alert stays on the page this long after it last changed, for anyone tapping it late. */
const RECENT_MS = 48 * 3_600_000;

function toArea(b: Blackout): AlertArea {
  return {
    id: b.id,
    area: b.label,
    search: xSearch([b.label]),
    threads: threadsSearch(b.label),
    startedAt: b.startedAt,
    started: eastern(b.startedAt),
    customers: b.peakCustomers,
    explained: b.cause === 'checking' ? null : shareExplained(b),
    causes: causesKnown(b),
    timeline: (b.timeline ?? []).map((e) => ({ ...e, at: eastern(e.at) })),
    statements: b.statements ?? [],
  };
}

const latest = (...times: Array<string | undefined>) => times.filter((t): t is string => Boolean(t)).sort().at(-1) ?? '';

function blackoutCard(b: Blackout, sentAt: string): AlertCard {
  const status = b.cause === 'explained' ? 'Stood down: a cause was found.' : b.resolvedAt ? 'Power is mostly back. No cause has been found.' : 'Ongoing. Nothing ordinary explains it yet.';
  return {
    id: b.id,
    title: b.deliberateNoticeAt ? `Reported as deliberate, unconfirmed: ${b.label}` : `Unexplained blackout: ${b.label}`,
    status,
    live: !b.resolvedAt && b.cause !== 'explained',
    sentAt,
    sent: eastern(sentAt),
    areas: [toArea(b)],
  };
}

function simultaneousCard(o: SimultaneousOutage, members: Blackout[]): AlertCard {
  const status = o.standDownAt ? 'Stood down: causes were found in enough of the areas.' : o.restoredAt ? 'Power is mostly back.' : 'Ongoing. Nothing ordinary explains any of them yet.';
  return {
    id: o.id,
    title: `Simultaneous blackouts in ${members.length} areas`,
    status,
    live: !o.standDownAt && !o.restoredAt,
    sentAt: o.noticeAt,
    sent: eastern(o.noticeAt),
    areas: members.map(toArea),
  };
}

/** Alerts that are still going or changed recently, newest first. */
function recentAlerts(blackouts: Blackout[], outages: SimultaneousOutage[], now: number): AlertCard[] {
  const recent = (...times: Array<string | undefined>) => now - Date.parse(latest(...times)) <= RECENT_MS;
  const cards: AlertCard[] = [];
  for (const b of blackouts) {
    const sentAt = b.unexplainedNoticeAt ?? b.deliberateNoticeAt;
    if (!sentAt) continue;
    if (!b.resolvedAt || recent(sentAt, b.deliberateNoticeAt, b.explainedNoticeAt, b.resolvedAt)) cards.push(blackoutCard(b, sentAt));
  }
  for (const o of outages) {
    const members = o.members.flatMap((id) => blackouts.find((b) => b.id === id) ?? []);
    if (!members.length) continue;
    if ((!o.standDownAt && !o.restoredAt) || recent(o.noticeAt, o.standDownAt, o.restoredAt)) cards.push(simultaneousCard(o, members));
  }
  return cards.sort((a, b) => b.sentAt.localeCompare(a.sentAt));
}

export default async function HomePage() {
  const [blackouts, outages, snapshot, settings] = await Promise.all([getBlackouts(), getSimultaneous(), getSnapshot(), getCachedSettings()]);
  // Cached pages are rebuilt each poll, so this is at most a few minutes old.
  // eslint-disable-next-line react-hooks/purity
  const cards = recentAlerts(blackouts, outages, Date.now());

  const coverage = snapshot ? Math.round((snapshot.customersMonitored / snapshot.customersTotal) * 100) : null;
  const readout: Array<[string, string]> = [
    [num(sources.length), 'utility maps'],
    [String(metros.length), 'metro areas'],
    [coverage === null ? '—' : `${coverage}%`, 'of their customers'],
    ['5 min', 'between readings'],
  ];

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-10">
      <section className="flex flex-col gap-5">
        <div className="max-w-2xl">
          <h1 className="font-serif text-3xl font-semibold leading-tight tracking-tight text-balance sm:text-4xl">Get notified of large unexplained blackouts</h1>
          <p className="explanation-copy mt-4 text-base text-ink-2 sm:text-lg">
            Cyberattacks appear to be ramping up.{' '}
            <a href="https://www.bbc.com/news/articles/cq1kd1nee80eo" target="_blank" rel="noreferrer" className="underline hover:text-accent">
              Refrigerators are one thing
            </a>
            , but the grid is another. GridAlert watches the most populated parts of the 50 states for large power outages that nothing ordinary explains, because a cyberattack on the grid would look like one at first. Judging by 2024 and 2025, expect about 8 or 9 alerts a year. Most turn out to be storms, failed equipment or bad readings, so an alert means look closer, not that there&apos;s been an attack.
          </p>
        </div>
        <div className="max-w-2xl">
          <SignUp vapidKey={process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY} />
        </div>
        {/* What's being watched, read like a control panel. */}
        <dl className="card grid grid-cols-2 divide-line overflow-hidden sm:grid-cols-4 sm:divide-x">
          {readout.map(([value, label]) => (
            <div key={label} className="flex flex-col gap-0.5 px-4 py-3">
              <dt className="order-2 text-[10px] uppercase tracking-[0.12em] text-muted">{label}</dt>
              <dd className="tabular font-mono text-xl text-ink">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* Most days there's nothing here, so the section only appears while an alert is recent. */}
      {cards.length > 0 && (
        <section id="alerts" className="flex scroll-mt-16 flex-col gap-3">
          <h2 className="font-serif text-xl font-semibold tracking-tight">Alerts</h2>
          <AlertList cards={cards} />
        </section>
      )}

      <TrackRecord record={trackRecord(blackouts, outages, settings)} level={settings.unexplainedCustomers} />

      <HowItWorks snapshot={snapshot} settings={settings} />
    </div>
  );
}
