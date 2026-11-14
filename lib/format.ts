export const num = (n: number) => Math.round(n).toLocaleString('en-US');

export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

/** Upper bound of each map class, in estimated people. The fourth edge is the default alert level. */
export const HEAT_BINS = [500, 2_500, 10_000, 50_000, Infinity];

export function heatClass(people: number): number {
  if (people <= 0) return 0;
  return HEAT_BINS.findIndex((edge) => people < edge) + 1;
}

export function timeAgo(iso: string, now = Date.now()): string {
  const minutes = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hr ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** Reduce a series to at most `points` buckets, keeping each bucket's peak so spikes survive. */
export function peaks(values: number[], points: number): number[] {
  if (values.length <= points) return values;
  const size = values.length / points;
  return Array.from({ length: points }, (_, i) => {
    const slice = values.slice(Math.floor(i * size), Math.floor((i + 1) * size));
    return Math.max(...slice);
  });
}

export function shortMetro(name: string): string {
  return name.split(',')[0].split('-')[0];
}

const OUTAGE_WORDS = ['outage', 'blackout', '"power out"', '"no power"', '"lost power"', '"without power"'];
/** Past this, a query risks being too long for X. */
const SEARCH_AREAS = 8;

const mainCity = (area: string) => shortMetro(area).split('/')[0].trim();

/**
 * Latest posts on X about a power cut in these areas. GridAlert doesn't read X, so this is for
 * a person to check by hand.
 */
export function xSearch(areas: string[]): string {
  const places = new Set(areas.slice(0, SEARCH_AREAS).map(mainCity).map((city) => (city.includes(' ') ? `"${city}"` : city)));
  const group = (terms: string[]) => (terms.length > 1 ? `(${terms.join(' OR ')})` : terms.join(''));
  const q = `${group([...places])} ${group(OUTAGE_WORDS)}`;
  return `https://x.com/search?q=${encodeURIComponent(q)}&f=live`;
}

/** Recent posts on Threads about a power cut in an area, for a person to check. Threads has no OR, so it's one phrase. */
export function threadsSearch(area: string): string {
  return `https://www.threads.com/search?q=${encodeURIComponent(`${mainCity(area)} power outage`)}&serp_type=default&filter=recent`;
}

export const plural = (n: number, word: string) => `${num(n)} ${word}${Math.round(n) === 1 ? '' : 's'}`;

/** The day alone, in Eastern time. */
export const easternDay = (iso: string) => new Date(iso).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' });

export const eastern = (iso: string) => new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** How long ago, in words: "34 minutes ago", "3 hours ago". */
export function startedAgo(iso: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${plural(minutes, 'minute')} ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${plural(hours, 'hour')} ago` : `${plural(Math.floor(hours / 24), 'day')} ago`;
}

/** "a, b or c" */
export function orList(items: string[]): string {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`;
}

/** The metro's lead state: Census lists it first in the name ("Memphis, TN-MS-AR"). */
export const primaryState = (name: string) => name.split(', ')[1]?.split('-')[0] ?? '';

/** Describe how much history a chart really holds, rather than its maximum window. */
export function spanLabel(t: number[]): string {
  if (t.length < 2) return 'Trend';
  const hours = (t[t.length - 1] - t[0]) / 3_600_000;
  if (hours < 36) return `Last ${Math.max(1, Math.round(hours))} ${Math.round(hours) === 1 ? 'hour' : 'hours'}`;
  return `Last ${Math.round(hours / 24)} days`;
}
