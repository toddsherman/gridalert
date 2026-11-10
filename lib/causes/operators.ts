import operatorsJson from '../../data/operators.json' with { type: 'json' };
import { expectShape, FetchError, getJson, getText } from '../sources/http.ts';

/** Who publishes notices GridAlert can read, by EIA balancing authority code. ERCOT's status sits behind an API that refuses server requests. */
export const OPERATOR_NAMES: Record<string, string> = {
  CISO: 'California ISO',
  ISNE: 'ISO New England',
  MISO: 'MISO',
  NYIS: 'New York ISO',
  PJM: 'PJM',
  SWPP: 'Southwest Power Pool',
};

const MISO_URL = 'https://www.misoenergy.org/api/topicnotifications/GetGroupedNotifications?topic=RealTime&take=100';
const MISO_SITE = 'https://www.misoenergy.org';
const PJM_URL = 'https://emergencyprocedures.pjm.com/ep/pages/dashboard.jsf';
const SPP_URL = 'https://www.spp.org/markets-operations/current-grid-conditions/';
const CAISO_URL = 'https://wwwmobile.caiso.com/TodaysOutlookApi/api/EmergencyNotices/v2/ActiveEvents';
const CAISO_PAGE = 'https://www.caiso.com/emergency-notifications';
const ISONE_PAGE = 'https://www.iso-ne.com/markets-operations/system-forecast-status/current-system-status/power-system-status-year';
const NYISO_FILES = 'https://mis.nyiso.com/public/csv/RealTimeEvents';
const NYISO_PAGE = 'https://mis.nyiso.com/public/P-35list.htm';

const EASTERN = 'America/New_York';
const PACIFIC = 'America/Los_Angeles';
const HOUR = 3_600_000;
/** A notice with no end time is taken to last this long. */
const DEFAULT_SPAN_MS = 6 * HOUR;

export interface OperatorNotice {
  operator: string;
  title: string;
  /** cut: the operator says it ordered power off. emergency: the grid is short, and it says so. */
  level: 'cut' | 'emergency';
  start: number;
  end: number;
  /** States it covers. Empty means everywhere the operator runs. */
  states: string[];
  url: string;
}

const CUT = /load shed|shed (?:firm )?load|load dump action|rotating (?:outages|blackouts)|\bOP-?7\b/i;
const EMERGENCY = /energy emergency|\bEEA[ -]?[123]\b|max(?:imum)? gen(?:eration)? (?:event|emergency)|capacity emergency|transmission (?:system )?emergency|major emergency|local load relief|\bOP-?4\b/i;
const CLOSED = /terminat|cancel|minimum gen/i;

/** What a notice's title amounts to. Advisories and warnings are too routine to say anything. */
export function levelOf(title: string): OperatorNotice['level'] | null {
  if (CLOSED.test(title)) return null;
  return CUT.test(title) ? 'cut' : EMERGENCY.test(title) ? 'emergency' : null;
}

const plain = (html: string) => html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^<>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/[ \t]+/g, ' ').trim();

/** A local wall-clock time, "2026-11-01T14:00:00", as an instant. */
function localTime(text: string, timeZone: string): number {
  const guess = Date.parse(`${text}Z`);
  const shown = new Date(guess).toLocaleString('sv-SE', { timeZone }).replace(' ', 'T');
  return guess + (guess - Date.parse(`${shown}Z`));
}

/** Michigan is in both: its upper peninsula is North, and the lower, with Detroit, is Central. */
const MISO_STATES: Record<string, string[]> = {
  North: ['IA', 'MI', 'MN', 'MT', 'ND', 'SD', 'WI'],
  Central: ['IL', 'IN', 'KY', 'MI', 'MO'],
  South: ['AR', 'LA', 'MS', 'TX'],
};

/** MISO runs on Eastern Standard Time all year, and labels its feed's times as UTC by mistake. */
const misoTime = (date: string, time: string) => Date.parse(`${date.slice(6)}-${date.slice(0, 2)}-${date.slice(3, 5)}T${time}:00-05:00`);

interface MisoNotification {
  subject?: string;
  body?: string;
  publishDateUnformatted?: string;
  permanentLinkUrl?: string;
}

/** A link into MISO's site. The path comes from its feed, so it can't be allowed to lead elsewhere. */
function misoLink(path = ''): string {
  try {
    const url = new URL(path, MISO_SITE);
    return url.origin === MISO_SITE ? url.href : MISO_SITE;
  } catch {
    return MISO_SITE;
  }
}

export function parseMiso(groups: Array<{ notifications?: MisoNotification[] }>): OperatorNotice[] {
  return groups.flatMap((g) => g.notifications ?? []).flatMap((n): OperatorNotice[] => {
    const title = plain(String(n.subject ?? '')).replace(/^(?:New Declaration|Updated|Re):\s*/i, '');
    const body = plain(String(n.body ?? ''));
    // EEA 3 means cuts are imminent or under way, so it takes the notice itself to say which.
    const level = /\bEEA[ -]?3\b/i.test(title) && CUT.test(body) ? 'cut' : levelOf(title);
    if (!level) return [];
    const times = [...body.matchAll(/(\d\d\/\d\d\/\d{4}) (\d\d:\d\d) EST/g)].map((m) => misoTime(m[1], m[2]));
    const published = Date.parse(String(n.publishDateUnformatted).replace(/\+00:00$/, '-05:00'));
    const start = times[0] ?? published;
    const regions = body.match(/Affected Region\(s\):\s*([^\n]*?)(?: - |\n|$)/)?.[1] ?? '';
    const states = Object.entries(MISO_STATES).flatMap(([name, list]) => (regions.includes(name) ? list : []));
    return [{ operator: 'MISO', title, level, start, end: times[1] ?? start + DEFAULT_SPAN_MS, states, url: misoLink(n.permanentLinkUrl) }];
  });
}

/** From PJM's regions page. Anything not listed can't be placed, so it can't explain a blackout. */
const PJM_STATES: Record<string, string> = {
  AECO: 'NJ', AEP: 'IN KY MI OH TN VA WV', AMPT: 'OH', BGE: 'MD', COMED: 'IL', CPP: 'OH', DAY: 'OH', DEOK: 'KY OH', DOM: 'NC VA', DPL: 'DE MD VA', DUQ: 'PA', EKPC: 'KY',
  'FE-AP': 'MD PA VA WV', 'FE-ATSI': 'OH PA', 'FE-JC': 'NJ', 'FE-ME': 'PA', 'FE-PN': 'PA', MIDATL: 'DC DE MD NJ PA VA', OVEC: 'IN KY OH', PECO: 'PA', PEPCO: 'DC MD', PPL: 'PA', PSEG: 'NJ',
  RECO: 'NJ', SMECO: 'MD', SOUTHERN: 'NC VA', SRE: 'NJ', UGI: 'PA', WESTERN: 'IL IN KY MD MI OH PA TN VA WV', WVPAT: 'IN',
};
const PJM_WHOLE = 'PJM-RTO';
const UNPLACED = '??';

const pjmTime = (text: string | undefined) => {
  const m = text?.match(/(\d\d)\.(\d\d)\.(\d{4}) (\d\d:\d\d)/);
  return m ? localTime(`${m[3]}-${m[1]}-${m[2]}T${m[4]}:00`, EASTERN) : undefined;
};

export function parsePjm(html: string, now: number): OperatorNotice[] {
  const table = html.match(/id="frmTable:tblPostings_data"[^>]*>(.*?)<\/tbody>/s)?.[1] ?? '';
  return [...table.matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)].flatMap((row): OperatorNotice[] => {
    // History, message id, priority, type, start, regions, message, end.
    const cells = [...row[1].matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map((c) => plain(c[1]));
    const title = cells[3] ?? '';
    const level = levelOf(title);
    if (!level) return [];
    const start = pjmTime(cells[4]) ?? now;
    const names = (cells[5] ?? '').split(/[,\s]+/).filter(Boolean);
    const states = names.includes(PJM_WHOLE) || !names.length ? [] : names.flatMap((name) => PJM_STATES[name]?.split(' ') ?? [UNPLACED]);
    return [{ operator: 'PJM', title, level, start, end: pjmTime(cells[7]) ?? start + DEFAULT_SPAN_MS, states, url: PJM_URL }];
  });
}

const SPP_HEADING = /<h3>(East|West) BAA:([^<]*)<\/h3>/g;

/**
 * SPP's headline status for each of its two areas. It has no times, so it counts from now. Every
 * SPP utility in data/operators.json is in East, so a notice about West can't speak for them.
 */
export function parseSpp(html: string, now: number): OperatorNotice[] {
  return [...html.matchAll(SPP_HEADING)].flatMap((m): OperatorNotice[] => {
    const title = `${m[1]} BAA: ${plain(m[2].replace(/\u00a0/g, ' '))}`;
    const level = levelOf(title);
    return level ? [{ operator: 'SWPP', title, level, start: now, end: now, states: m[1] === 'West' ? [UNPLACED] : [], url: SPP_URL }] : [];
  });
}

const ISONE_STATES: Record<string, string> = { CT: 'CT', MAINE: 'ME', ME: 'ME', NEMA: 'MA', NH: 'NH', RI: 'RI', SEMA: 'MA', VT: 'VT', WCMA: 'MA' };
const ISONE_WHOLE = 'NEW ENGLAND';

const isoneTime = (text: string) => {
  const m = text.match(/(\d\d)\/(\d\d)\/(\d{4})\s+(\d{1,2}):(\d\d):(\d\d) ([AP])M/);
  if (!m) return undefined;
  const hour = (Number(m[4]) % 12) + (m[7] === 'P' ? 12 : 0);
  return localTime(`${m[3]}-${m[1]}-${m[2]}T${String(hour).padStart(2, '0')}:${m[5]}:${m[6]}`, EASTERN);
};

export function parseIsoNe(html: string, now: number, url: string): OperatorNotice[] {
  return [...html.matchAll(/<tr>\s*<td>([^<]*)<\/td>\s*<td[^>]*>([^<]*)(?:<span.*?<\/span>)?\s*<\/td>\s*<td>(.*?)<\/td>\s*<td>(.*?)<\/td>/gs)].flatMap((m): OperatorNotice[] => {
    const title = plain(m[2]);
    const level = levelOf(title);
    const start = isoneTime(m[3]);
    if (!level || start === undefined) return [];
    const area = plain(m[1]);
    return [{ operator: 'ISNE', title, level, start, end: isoneTime(m[4]) ?? now, states: area === ISONE_WHOLE ? [] : [ISONE_STATES[area] ?? UNPLACED], url }];
  });
}

export function parseNyiso(csv: string): OperatorNotice[] {
  return csv.split('\n').flatMap((line): OperatorNotice[] => {
    const m = line.match(/^"?(\d\d)\/(\d\d)\/(\d{4}) (\d\d:\d\d:\d\d)"?,"?(.*?)"?\s*$/);
    const level = m && levelOf(m[5]);
    if (!m || !level) return [];
    const at = localTime(`${m[3]}-${m[1]}-${m[2]}T${m[4]}`, EASTERN);
    return [{ operator: 'NYIS', title: m[5], level, start: at, end: at + DEFAULT_SPAN_MS, states: [], url: NYISO_PAGE }];
  });
}

/** California posts nothing while the grid is normal, so an event's fields are read loosely. */
export function parseCaiso(doc: { CurrentEvents?: Array<Record<string, unknown>> }, now: number): OperatorNotice[] {
  return (doc?.CurrentEvents ?? []).flatMap((event): OperatorNotice[] => {
    const values = Object.values(event).filter((v): v is string => typeof v === 'string');
    const title = values.find((v) => levelOf(v)) ?? '';
    const level = levelOf(title);
    if (!level) return [];
    const times = values.filter((v) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(v)).map((v) => localTime(v, PACIFIC));
    return [{ operator: 'CISO', title: title.slice(0, 120), level, start: times.length ? Math.min(...times) : now, end: times.length > 1 ? Math.max(...times) : now, states: [], url: CAISO_PAGE }];
  });
}

const easternDay = (at: number) => new Date(at).toLocaleDateString('sv-SE', { timeZone: EASTERN }).replaceAll('-', '');

/** A month's older days move into an archive, so a missing file just means none to read. */
const nyisoDay = (day: string) => getText(`${NYISO_FILES}/${day}RealTimeEvents.csv`).catch((err) => {
  if (err instanceof FetchError && err.status === 404) return '';
  throw err;
});

/**
 * Read one operator's notices. Most days a page has none, so each has to show it's still
 * the page these parsers know, or a redesign would read as nothing to report.
 */
export async function readNotices(operator: string, now: Date): Promise<OperatorNotice[]> {
  const at = now.getTime();
  switch (operator) {
    case 'MISO': {
      const doc = await getJson(MISO_URL);
      expectShape(Array.isArray(doc) && doc.some((g) => g?.notifications?.some((n: MisoNotification) => n?.subject)), 'MISO notices');
      return parseMiso(doc);
    }
    case 'PJM': {
      const html = await getText(PJM_URL);
      expectShape(html.includes('frmTable:tblPostings_data'), 'PJM dashboard');
      return parsePjm(html, at);
    }
    case 'SWPP': {
      const html = await getText(SPP_URL);
      expectShape([...html.matchAll(SPP_HEADING)].length === 2, 'SPP conditions page');
      return parseSpp(html, at);
    }
    case 'CISO': {
      const doc = await getJson(CAISO_URL);
      expectShape(Array.isArray(doc?.CurrentEvents) && typeof doc.CurrentEventsCount === 'number', 'CAISO events');
      return parseCaiso(doc, at);
    }
    case 'ISNE': {
      const url = `${ISONE_PAGE}?year=${now.getUTCFullYear()}`;
      const html = await getText(url);
      expectShape(html.includes('PowerSystemConditions-Table'), 'ISO-NE status page');
      return parseIsoNe(html, at, url);
    }
    case 'NYIS': {
      // Today's file may not exist yet just after midnight, but one of the two always should.
      const files = (await Promise.all([at - 24 * HOUR, at].map((t) => nyisoDay(easternDay(t))))).filter(Boolean);
      expectShape(files.length && files.every((f) => f.startsWith('Timestamp,Message')), 'NYISO events');
      return files.flatMap(parseNyiso);
    }
    default:
      return [];
  }
}

const utilityOperators = operatorsJson as Record<string, Record<string, string[]>>;

/** Which operators run a utility's grid in a state. Most of the South and West have none. */
export const operatorsFor = (eiaId: number, state: string): string[] => utilityOperators[eiaId]?.[state] ?? [];
