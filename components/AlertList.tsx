'use client';

import { num, startedAgo } from '@/lib/format';
import type { Statement, TimelineEntry } from '@/lib/types';
import { AlertGlyph } from './Status';
import { useNow } from './useNow';

export interface AlertArea {
  id: string;
  area: string;
  /** Latest posts on X about it, for checking by hand. */
  search: string;
  /** The same on Threads. */
  threads: string;
  startedAt: string;
  /** The exact time, for hovering and for before the viewer's clock is known. */
  started: string;
  customers: number;
  /** Share of the blackout with a known cause, or nothing while it's too early to say. */
  explained: number | null;
  /** Only what explains it. */
  causes: string[];
  timeline: TimelineEntry[];
  statements: Statement[];
}

export interface AlertCard {
  id: string;
  title: string;
  status: string;
  /** Still going, with nothing found to explain it. */
  live: boolean;
  sentAt: string;
  sent: string;
  areas: AlertArea[];
}

function percent(share: number | null): string {
  if (share === null) return 'checking';
  return share > 0 && share < 0.01 ? '<1%' : `${Math.round(share * 100)}%`;
}

// Logo shapes from Simple Icons.
const LOGOS = {
  X: 'M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z',
  Threads:
    'M12.186 24h-.007c-3.581-.024-6.334-1.205-8.184-3.509C2.35 18.44 1.5 15.586 1.472 12.01v-.017c.03-3.579.879-6.43 2.525-8.482C5.845 1.205 8.6.024 12.18 0h.014c2.746.02 5.043.725 6.826 2.098 1.677 1.29 2.858 3.13 3.509 5.467l-2.04.569c-1.104-3.96-3.898-5.984-8.304-6.015-2.91.022-5.11.936-6.54 2.717C4.307 6.504 3.616 8.914 3.589 12c.027 3.086.718 5.496 2.057 7.164 1.43 1.783 3.631 2.698 6.54 2.717 2.623-.02 4.358-.631 5.8-2.045 1.647-1.613 1.618-3.593 1.09-4.798-.31-.71-.873-1.3-1.634-1.75-.192 1.352-.622 2.446-1.284 3.272-.886 1.102-2.14 1.704-3.73 1.79-1.202.065-2.361-.218-3.259-.801-1.063-.689-1.685-1.74-1.752-2.964-.065-1.19.408-2.285 1.33-3.082.88-.76 2.119-1.207 3.583-1.291a13.853 13.853 0 0 1 3.02.142c-.126-.742-.375-1.332-.75-1.757-.513-.586-1.308-.883-2.359-.89h-.029c-.844 0-1.992.232-2.721 1.32L7.734 7.847c.98-1.454 2.568-2.256 4.478-2.256h.044c3.194.02 5.097 1.975 5.287 5.388.108.046.216.094.321.142 1.49.7 2.58 1.761 3.154 3.07.797 1.82.871 4.79-1.548 7.158-1.85 1.81-4.094 2.628-7.277 2.65Zm1.003-11.69c-.242 0-.487.007-.739.021-1.836.103-2.98.946-2.916 2.143.067 1.256 1.452 1.839 2.784 1.767 1.224-.065 2.818-.543 3.086-3.71a10.5 10.5 0 0 0-2.215-.221z',
};

function SearchLink({ site, href, area }: { site: keyof typeof LOGOS; href: string; area: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" title={`Search ${site}`} aria-label={`Search ${site} for posts about ${area}`} className="-my-2 flex h-11 w-11 items-center justify-center text-ink-2 hover:text-accent">
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4 fill-current">
        <path d={LOGOS[site]} />
      </svg>
    </a>
  );
}

function Said({ area }: { area: AlertArea }) {
  if (!area.timeline.length && !area.statements.length) return null;
  return (
    <details className="text-xs text-ink-2">
      <summary className="min-h-11 cursor-pointer py-3">What&apos;s being said ({area.statements.length + area.timeline.length})</summary>
      <ul className="mt-1 flex flex-col gap-1">
        {area.statements.map((s) => (
          <li key={`${s.speaker}:${s.quote}`}>
            <span className="font-medium text-ink">{s.speaker}</span> ({s.speakerType}), as reported by {s.source}, unconfirmed: {s.claim}{' '}
            <a href={s.url} target="_blank" rel="noreferrer" className="underline">
              &ldquo;{s.quote}&rdquo;
            </a>
          </li>
        ))}
        {area.timeline.map((e) => (
          <li key={e.url}>
            <span className="tabular text-muted">{e.at}</span> {e.official ? 'Official' : e.deliberate ? 'Unconfirmed' : 'News'}, {e.source}:{' '}
            <a href={e.url} target="_blank" rel="noreferrer" className="underline">
              {e.title}
            </a>
          </li>
        ))}
      </ul>
    </details>
  );
}

function Ago({ at, exact, now }: { at: string; exact: string; now: number | null }) {
  return (
    <time dateTime={at} title={`${exact} ET`}>
      {now === null ? `${exact} ET` : startedAgo(at, now).toLowerCase()}
    </time>
  );
}

export function AlertList({ cards }: { cards: AlertCard[] }) {
  const now = useNow();
  return (
    <ul className="flex flex-col gap-3">
      {cards.map((c) => (
        <li key={c.id} className={`card flex flex-col gap-3 p-4 ${c.live ? 'border-l-4 border-critical' : ''}`}>
          <div className="flex gap-3">
            {c.live && <AlertGlyph />}
            <div className="text-sm">
              <p className="font-medium">{c.title}</p>
              <p className="text-ink-2">{c.status}</p>
              <p className="text-xs text-muted">
                Alert sent <Ago at={c.sentAt} exact={c.sent} now={now} />
              </p>
            </div>
          </div>
          <ul className="flex flex-col divide-y divide-line">
            {c.areas.map((a) => (
              <li key={a.id} className="flex flex-col gap-1 py-2 text-sm first:pt-0 last:pb-0">
                <div className="flex items-start justify-between gap-3">
                  <span className="font-medium">{a.area}</span>
                  <span className="flex shrink-0 items-center gap-3" aria-label="Search posts">
                    <SearchLink site="X" href={a.search} area={a.area} />
                    <SearchLink site="Threads" href={a.threads} area={a.area} />
                  </span>
                </div>
                <p className="tabular text-xs text-ink-2">
                  Started <Ago at={a.startedAt} exact={a.started} now={now} />, {num(a.customers)} customers affected, {percent(a.explained)} explained
                </p>
                <p className="text-xs">
                  <span className="text-ink-2">Causes: </span>
                  {a.causes.length ? a.causes.join('; ') : 'Unknown'}
                </p>
                <Said area={a} />
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}
