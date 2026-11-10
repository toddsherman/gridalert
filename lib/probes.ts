import { deliver, type Message, siteUrl } from './alerts/notify.ts';
import { readFires, readGusts, readKp, readQuakes, readStormReports, readWeatherAlerts } from './causes/feeds.ts';
import { type NewsLog, OFFICIAL_FEEDS, readOfficialFeed } from './causes/news.ts';
import { OPERATOR_NAMES, readNotices } from './causes/operators.ts';
import { STATEMENT_MODEL, statementClient } from './causes/statements.ts';
import { eastern } from './format.ts';
import { type CheckHealth, feedNotes, type HealthDoc } from './health.ts';
import { readSettings } from './run.ts';
import { ShapeError } from './sources/http.ts';
import { readOdin } from './sources/odin.ts';
import { PATHS, readDoc, writeDoc } from './store.ts';
import type { Snapshot } from './types.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PROBE_DEADLINE_MS = 30_000;
/** Probes that fail twice in a row are unlikely to be a passing blip. */
const SHAPE_NOTICE_PROBES = 2;
/** Most outside checks only matter during a blackout, so a few hours down can wait for the digest. */
const CHECK_OUT_MS = 6 * HOUR;
/** News files arrive every 15 minutes. */
const NEWS_STALE_MS = 3 * HOUR;
/** There are always outages in the news, so two days of none means the filter has stopped working. */
const NEWS_QUIET_MS = 48 * HOUR;
const DIGEST_HOUR_UTC = 12;
const WATCHING_MS = 7 * DAY - HOUR;
const DIGEST_LINES = 12;
const PROBE_STATES = ['CA', 'FL', 'NY', 'TX'];
const PROBE_STATIONS = ['KDFW', 'KJFK', 'KLAX', 'KORD'];

export type ProbeResult = { ok: true; rows: number } | { ok: false; error: string; shape: boolean };

type Probe = [name: string, read: () => Promise<number>];

/** The news log is written by the polls, so this shows whether they're keeping it up. */
async function readNewsLog(now: Date): Promise<number> {
  const log = (await readDoc<NewsLog>(PATHS.news, { fresh: true }))?.value;
  if (!log?.through || now.getTime() - log.through > NEWS_STALE_MS) throw new Error('The news log has stopped advancing');
  const newest = Math.max(0, ...log.items.filter((i) => !i.official).map((i) => i.at));
  if (now.getTime() - newest > NEWS_QUIET_MS) throw new ShapeError('No outage stories in 48 hours');
  return log.items.length;
}

function probes(now: Date): Probe[] {
  const list: Probe[] = [
    ['National Weather Service', async () => (await readWeatherAlerts(PROBE_STATES, now)).length],
    ['Storm Prediction Center', async () => (await readStormReports(now)).length],
    ['Aviation Weather Center', async () => (await readGusts(PROBE_STATIONS)).length],
    ['National Interagency Fire Center', async () => (await readFires()).length],
    ['US Geological Survey', async () => (await readQuakes()).length],
    ['NOAA Space Weather', async () => (await readKp(now)).length],
    ...Object.entries(OPERATOR_NAMES).map(([code, name]): Probe => [name, async () => (await readNotices(code, now)).length]),
    ...OFFICIAL_FEEDS.map((feed): Probe => [feed.name, async () => (await readOfficialFeed(feed)).length]),
    ['GDELT news', () => readNewsLog(now)],
    ['DOE ODIN', async () => (await readOdin(now.getTime())).length],
  ];
  // Looking up the model costs nothing, and shows the key still works before an alert needs it.
  if (process.env.ANTHROPIC_API_KEY) list.push(['Claude API', async () => (await statementClient().models.retrieve(STATEMENT_MODEL), 1)]);
  return list;
}

async function attempt(read: () => Promise<number>): Promise<ProbeResult> {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('No answer in time')), PROBE_DEADLINE_MS);
  });
  try {
    return { ok: true, rows: await Promise.race([read(), deadline]) };
  } catch (err) {
    return { ok: false, error: (err as Error).message.slice(0, 200), shape: err instanceof ShapeError };
  } finally {
    clearTimeout(timer!);
  }
}

export function nextCheck(prev: CheckHealth | undefined, result: ProbeResult, at: string): CheckHealth {
  if (result.ok) return { lastOkAt: at, lastFailAt: prev?.lastFailAt, failsInARow: 0, rows: result.rows };
  return { ...prev, lastFailAt: at, failsInARow: (prev?.failsInARow ?? 0) + 1, lastError: result.error, shape: result.shape };
}

/** Which checks have changed shape and which have just recovered from it, once each. */
export function shapeChanges(before: Record<string, CheckHealth>, after: Record<string, CheckHealth>): { broken: string[]; fixed: string[] } {
  const names = Object.keys(after);
  return {
    broken: names.filter((n) => after[n].shape && after[n].failsInARow >= SHAPE_NOTICE_PROBES && !after[n].noticedAt),
    fixed: names.filter((n) => before[n]?.noticedAt && after[n].failsInARow === 0),
  };
}

/** What a person should look at, one line each. Identical lines mean nothing has changed. */
export function digestLines(checks: Record<string, CheckHealth>, snapshot: Pick<Snapshot, 'utilities'> | null, now: number): string[] {
  const outside = Object.entries(checks).flatMap(([name, c]): string[] => {
    if (c.failsInARow === 0) return [];
    const since = c.lastOkAt ? Date.parse(c.lastOkAt) : 0;
    if (now - since < CHECK_OUT_MS) return [];
    return [c.lastOkAt ? `${name} hasn't been readable since ${eastern(c.lastOkAt)} ET.` : `${name} hasn't been readable yet.`];
  });
  return [...outside, ...(snapshot ? feedNotes(snapshot, now) : [])];
}

interface DigestState {
  digest?: string[];
  digestAt?: string;
  watchingAt?: string;
}

/** The one message due today, if any. Silent when nothing has changed, bar a weekly line to show it's alive. */
export function dueDigest(state: DigestState, lines: string[], feedsOk: number, checks: number, at: Date): { message?: Omit<Message, 'url'>; state: DigestState } {
  const iso = at.toISOString();
  const day = iso.slice(0, 10);
  if (at.getUTCHours() < DIGEST_HOUR_UTC || state.digestAt?.slice(0, 10) === day) return { state };
  const previous = state.digest ?? [];
  const next: DigestState = { ...state, digest: lines, digestAt: iso };
  const changed = JSON.stringify(lines) !== JSON.stringify(previous);
  const shown = lines.slice(0, DIGEST_LINES).join('\n') + (lines.length > DIGEST_LINES ? `\nAnd ${lines.length - DIGEST_LINES} more.` : '');
  if (changed && lines.length) return { message: { title: 'GridAlert daily check', body: shown }, state: next };
  if (changed) return { message: { title: 'GridAlert daily check', body: 'Everything in the last daily check has recovered.' }, state: next };
  if (at.getTime() - Date.parse(state.watchingAt ?? '1970-01-01') >= WATCHING_MS) {
    return { message: { title: 'GridAlert is still watching', body: `${feedsOk} feeds are live and ${checks} outside checks are readable.${lines.length ? ` ${lines.length} still need a look; see Coverage.` : ''}` }, state: { ...next, watchingAt: iso } };
  }
  return { state: next };
}

/**
 * Some checks only run when something is wrong, so a broken one would stay hidden until it
 * mattered. This reads every outside service, every hour, whether or not anything is wrong.
 */
export async function runProbes(now = new Date()): Promise<HealthDoc> {
  const at = now.toISOString();
  const stored = (await readDoc<HealthDoc>(PATHS.health, { fresh: true }).catch(() => null))?.value;
  const before = stored?.checks ?? {};
  const list = probes(now);
  const results = await Promise.all(list.map(([, read]) => attempt(read)));
  const checks: Record<string, CheckHealth> = Object.fromEntries(list.map(([name], i) => [name, nextCheck(before[name], results[i], at)]));

  const settings = await readSettings();
  const send = (m: Omit<Message, 'url'>) => deliver({ ...m, url: `${siteUrl()}/coverage` }, settings);

  const { broken, fixed } = shapeChanges(before, checks);
  if (broken.length) {
    const sent = await send({ title: 'A GridAlert check needs fixing', body: `${broken.join(', ')} changed format, so GridAlert can't read ${broken.length === 1 ? 'it' : 'them'}. Until that's fixed, the check can't run during a blackout.` }).then(() => true, (err) => console.error('delivery failed:', (err as Error).message));
    if (sent) for (const name of broken) checks[name].noticedAt = at;
  }
  if (fixed.length) await send({ title: 'GridAlert check fixed', body: `${fixed.join(', ')} can be read again.` }).catch((err) => console.error('delivery failed:', (err as Error).message));

  const snapshot = (await readDoc<Snapshot>(PATHS.latest, { fresh: true }).catch(() => null))?.value ?? null;
  const readable = Object.values(checks).filter((c) => c.failsInARow === 0).length;
  const due = dueDigest({ digest: stored?.digest, digestAt: stored?.digestAt, watchingAt: stored?.watchingAt }, digestLines(checks, snapshot, now.getTime()), snapshot?.sourcesOk ?? 0, readable, now);
  const digestSent = !due.message || (await send(due.message).then(() => true, (err) => console.error('delivery failed:', (err as Error).message)));

  const doc: HealthDoc = { probedAt: at, checks, ...(digestSent ? due.state : { digest: stored?.digest, digestAt: stored?.digestAt, watchingAt: stored?.watchingAt }) };
  await writeDoc(PATHS.health, doc);
  return doc;
}
