import { num } from '@/lib/format';

const ICONS = {
  // A map pin over a grid square: where outages are seen.
  maps: 'M12 2a6 6 0 0 0-6 6c0 4.5 6 11 6 11s6-6.5 6-11a6 6 0 0 0-6-6Zm0 8.5A2.5 2.5 0 1 1 12 5.5a2.5 2.5 0 0 1 0 5Z',
  bolt: 'M13 2 3 14h8l-1 8 10-12h-8l1-8z',
  search: 'M10.5 3a7.5 7.5 0 1 0 4.6 13.4l4.2 4.2 1.4-1.4-4.2-4.2A7.5 7.5 0 0 0 10.5 3Zm0 2a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11Z',
  bell: 'M12 2a6 6 0 0 0-6 6v4l-2 3v1h16v-1l-2-3V8a6 6 0 0 0-6-6Zm-2.5 16a2.5 2.5 0 0 0 5 0h-5Z',
} as const;

function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="h-5 w-5 fill-accent-ink">
      <path d={ICONS[name]} />
    </svg>
  );
}

/** A length of line with current on it, across on wide screens and down on narrow ones. */
function Wire({ label }: { label: string }) {
  return (
    <li aria-hidden className="flex shrink-0 items-center gap-2 py-1 pl-6 lg:w-20 lg:flex-col lg:justify-center lg:gap-1 lg:p-0">
      <svg viewBox="0 0 16 40" className="h-9 w-4 lg:hidden">
        <path d="M8 0V40" className="stroke-wire" strokeWidth={2} />
        <path d="M8 0V40" pathLength={100} className="current" strokeWidth={3} fill="none" />
      </svg>
      <svg viewBox="0 0 64 16" className="hidden h-4 w-16 lg:block">
        <path d="M0 8H64" className="stroke-wire" strokeWidth={2} />
        <path d="M0 8H64" pathLength={100} className="current" strokeWidth={3} fill="none" />
      </svg>
      <span className="text-[11px] leading-tight text-muted lg:text-center">{label}</span>
    </li>
  );
}

function Stage({ n, icon, title, children, hot = false }: { n: number; icon: keyof typeof ICONS; title: string; children: React.ReactNode; hot?: boolean }) {
  return (
    <li className={`card flex flex-col gap-1.5 p-4 lg:flex-1 ${hot ? 'outline outline-1 outline-accent' : ''}`}>
      <div className="flex items-center justify-between">
        <Icon name={icon} />
        <span className="font-mono text-[11px] text-muted">0{n}</span>
      </div>
      <p className="text-sm font-semibold text-ink">{title}</p>
      <p className="explanation-copy text-sm text-ink-2">{children}</p>
    </li>
  );
}

/** How a reading becomes an alert, in four steps. */
export function SystemDiagram({ feeds, metros }: { feeds: number; metros: number }) {
  return (
    <figure className="flex flex-col gap-2">
      <ol className="flex flex-col lg:flex-row lg:items-stretch">
        <Stage n={1} icon="maps" title="Outage maps">
          {num(feeds)} utility maps and the Department of Energy&apos;s ODIN feed, read every five minutes.
        </Stage>
        <Wire label="customers out" />
        <Stage n={2} icon="bolt" title="GridAlert" hot>
          Places every outage in one of {metros} metro areas and watches for a sudden jump.
        </Stage>
        <Wire label="a jump" />
        <Stage n={3} icon="search" title="Cause checks">
          Weather, wildfires, earthquakes, grid operators and utility labels, in the same counties at the same time.
        </Stage>
        <Wire label="nothing found" />
        <Stage n={4} icon="bell" title="Alert">
          Sent to everyone signed up, with news and posts to read. A follow-up says when that changes.
        </Stage>
      </ol>
      <figcaption className="text-xs text-muted">If a cause turns up at step 3, no alert goes out, or one already sent is stood down.</figcaption>
    </figure>
  );
}
