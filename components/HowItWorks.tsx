import Link from 'next/link';
import { LARGE_CUSTOMERS } from '@/lib/causes/rules';
import { num } from '@/lib/format';
import { metros, sources } from '@/lib/registry';
import type { Settings, Snapshot } from '@/lib/types';
import { SystemDiagram } from './SystemDiagram';

const MORE = [
  ['/alerts', 'Alert history', 'every outage tracked, and what was sent'],
  ['/map', 'Map', 'where the power is out right now'],
  ['/metros', 'Metros', 'each metro area, with its utilities and recent history'],
  ['/coverage', 'Coverage', 'every feed, its status, and the outside services checked each hour'],
  ['/settings', 'Settings', 'alert levels and the owner’s channels'],
] as const;

type Source = [name: string, what: string, href?: string];

const CAUSES: Source[] = [
  ['National Weather Service', 'storm, wind, ice and flood warnings', 'https://www.weather.gov'],
  ['Storm Prediction Center', 'reports of tornadoes, hail and damaging wind', 'https://www.spc.noaa.gov'],
  ['Aviation Weather Center', 'gusts measured at airports, which count when they reach 45 mph during a Wind Advisory', 'https://aviationweather.gov'],
  ['National Interagency Fire Center', 'wildfires burning now', 'https://www.nifc.gov'],
  ['US Geological Survey', 'earthquakes', 'https://earthquake.usgs.gov'],
  ['Grid operators', 'orders to cut power from California ISO, ISO New England, MISO, New York ISO, PJM and Southwest Power Pool, which say who cut it but not why'],
  ['Utility maps', 'the cause a utility lists, for its own customers only'],
  ['NOAA Space Weather', 'severe geomagnetic storms, noted but never enough on their own', 'https://www.swpc.noaa.gov'],
];

const CONTEXT: Source[] = [
  ['GDELT Project', 'news about outages, indexed every 15 minutes', 'https://www.gdeltproject.org'],
  ['CISA', 'the federal cybersecurity agency’s news and alerts', 'https://www.cisa.gov'],
  ['Claude', 'reads the stories after an alert to record who said what. Every quote shown was found in the article it links to, which shows the article said it, not that it’s true'],
  ['X and Threads', 'links for you to search. GridAlert doesn’t read either'],
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-serif text-lg font-semibold text-ink">{title}</h3>
      <div className="explanation-copy flex flex-col gap-2 text-[15px] text-ink-2">{children}</div>
    </section>
  );
}

function Term({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="inline font-sans text-sm font-semibold text-ink">{name}: </dt>
      <dd className="inline">{children}</dd>
    </div>
  );
}

function SourceList({ title, note, items }: { title: string; note: string; items: Source[] }) {
  return (
    <div className="card flex flex-col gap-3 p-4">
      <div>
        <h4 className="font-sans text-[11px] font-semibold uppercase tracking-[0.14em] text-accent-ink">{title}</h4>
        <p className="mt-0.5 text-xs text-muted">{note}</p>
      </div>
      <dl className="explanation-copy flex flex-col gap-2 text-[15px] text-ink-2">
        {items.map(([name, what, href]) => (
          <Term key={name} name={name}>
            {href ? (
              <>
                {what}.{' '}
                <a href={href} target="_blank" rel="noreferrer" className="text-xs text-muted underline">
                  Site
                </a>
              </>
            ) : (
              `${what}.`
            )}
          </Term>
        ))}
      </dl>
    </div>
  );
}

export function HowItWorks({ snapshot, settings }: { snapshot: Snapshot | null; settings: Settings }) {
  const coverage = snapshot ? Math.round((snapshot.customersMonitored / snapshot.customersTotal) * 100) : null;
  const outages: Source[] = [
    ['Utility outage maps', `the ${num(sources.length)} maps utilities publish for their customers, mostly through Kubra and ArcGIS, read every five minutes`],
    ['DOE’s ODIN feed', 'outages utilities report to the Department of Energy, filling in where there’s no map to read'],
    ['Census and EIA records', `which utility serves which counties, so each outage lands in the right one of the ${metros.length} metro areas`],
  ];

  return (
    <section id="how" className="flex scroll-mt-16 flex-col gap-6">
      <h2 className="font-serif text-2xl font-semibold tracking-tight">How it works</h2>

      <Section title="Where GridAlert looks">
        <p>
          GridAlert reads public outage data for the {metros.length} metro areas of 250,000 or more people in the 50 states and Washington, DC, covering {coverage === null ? 'most' : `${coverage}%`} of their customers. When an outage jumps, it checks everything that could explain it in the same counties at the same time. Some large utilities publish no usable data, so coverage isn&apos;t complete, and territories aren&apos;t included: Puerto Rico&apos;s grid fails on its own so often that its outages would drown out the rest.
        </p>
      </Section>

      <SystemDiagram feeds={sources.length} metros={metros.length} />

      <div className="grid gap-3 md:grid-cols-3">
        <SourceList title="Outages" note="What’s out, and where" items={outages} />
        <SourceList title="Causes" note="Checked in the same counties at the same time" items={CAUSES} />
        <SourceList title="Context" note="Shown with an alert, never changes the cause" items={CONTEXT} />
      </div>

      <p className="explanation-copy text-[15px] text-ink-2">On an outage of {num(LARGE_CUSTOMERS)} or more customers, a utility&apos;s map can&apos;t settle the cause alone. Labels are often filled in automatically, so an equipment label never does, and a weather or planned label needs a weather source to agree.</p>

      <div className="grid gap-6 md:grid-cols-2">
        <Section title="When it sends an alert">
          <dl className="flex flex-col gap-2">
            <Term name="Unexplained blackout">{num(settings.unexplainedCustomers)} or more customers go out within 30 minutes with nothing ordinary found, or {num(settings.unexplainedCustomers * 3)} or more at any speed. Speed matters most: storms build over hours, while failures and deliberate acts hit at once.</Term>
            <Term name="Simultaneous blackouts">{settings.simultaneousAreas} or more unrelated areas of {num(settings.simultaneousCustomers)} or more customers starting within 30 minutes, with nothing ordinary found in any of them.</Term>
            <Term name="Reported as deliberate">a headline points to a deliberate act, and a major outlet, two separate outlets or a federal agency reports it. It&apos;s marked unconfirmed and doesn&apos;t change the cause.</Term>
          </dl>
          <p>The first two wait up to an hour for the count to move, because a count stuck on one number is often a bad reading. A follow-up says when a cause turns up or the power comes back. Smaller outages, about a dozen a day, are tracked but never sent.</p>
        </Section>

        <Section title="Reading an alert">
          <dl className="flex flex-col gap-2">
            <Term name="Customers affected">the most out at once. A customer is one utility account, roughly one electric meter, and usually one household.</Term>
            <Term name="% explained">how much of the outage has a known cause. A storm, wildfire, earthquake or grid operator order in the area accounts for all of it. A utility only accounts for the customers it names a cause for, so an outage can be partly explained.</Term>
            <Term name="Causes">only what explains the outage. Unknown means nothing has been found yet.</Term>
            <Term name="X and Threads logos">open the latest posts about a power cut in that area. News takes hours to cover a blackout, so this is often the fastest way to learn more.</Term>
          </dl>
        </Section>

        <Section title="Checking itself">
          <p>A broken source shouldn&apos;t look like a quiet day. Every outside service is read hourly, feeds that stop updating are flagged, and alerts are held and retried if they can&apos;t be sent. If GridAlert itself stops, a separate service warns its owner.</p>
        </Section>

        <Section title="Your alerts">
          <p>Signing up stores only what your browser needs to receive alerts: no name, email or phone number. Alerts come straight from GridAlert through your browser&apos;s own notification service. Turning alerts off, or removing GridAlert from your Home Screen, stops them.</p>
        </Section>
      </div>

      <Section title="More detail">
        <ul className="flex flex-col gap-1">
          {MORE.map(([href, label, about]) => (
            <li key={href}>
              <Link href={href} className="font-medium text-ink underline">
                {label}
              </Link>
              : {about}
            </li>
          ))}
        </ul>
      </Section>
    </section>
  );
}
