const USER_AGENT = 'GridAlert/1.0 (public outage monitor; polite polling every 5 minutes)';
const TIMEOUT_MS = 15_000;
/** The largest real response is 0.6 MB, so this only ever stops a broken or hostile feed. */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export class FetchError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/** The document came back but isn't what its parser knows, which would otherwise read as "nothing found". */
export class ShapeError extends Error {}

export function expectShape(ok: unknown, source: string): asserts ok {
  if (!ok) throw new ShapeError(`${source} has changed shape`);
}

/** Read a whole body, stopping at the limit. fetch has already unzipped it, so this counts the real size. */
export async function readBody(res: Response, limit = MAX_RESPONSE_BYTES): Promise<Buffer> {
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new FetchError(`Response passed ${limit} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function request(url: string, init: { headers?: Record<string, string>; body?: string; timeoutMs?: number } = {}) {
  const res = await fetch(url, {
    method: init.body ? 'POST' : 'GET',
    body: init.body,
    headers: { 'user-agent': USER_AGENT, accept: 'application/json, text/plain, */*', ...init.headers },
    signal: AbortSignal.timeout(init.timeoutMs ?? TIMEOUT_MS),
    redirect: 'follow',
    cache: 'no-store',
  });
  if (!res.ok) throw new FetchError(`HTTP ${res.status} from ${new URL(url).host}`, res.status);
  return res;
}

// TextDecoder drops the BOM some feeds prepend.
const decoded = (body: Buffer) => new TextDecoder().decode(body);

export async function getJson<T = any>(url: string, init?: { headers?: Record<string, string>; body?: string }): Promise<T> {
  const text = decoded(await readBody(await request(url, init)));
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new FetchError(`Non-JSON response from ${new URL(url).host}: ${text.slice(0, 80)}`);
  }
}

export async function getText(url: string, init?: { headers?: Record<string, string>; timeoutMs?: number }): Promise<string> {
  return decoded(await readBody(await request(url, init)));
}

export async function getBytes(url: string, init?: { headers?: Record<string, string> }): Promise<Buffer> {
  return readBody(await request(url, init));
}

export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}

/**
 * Coerce the many ways feeds publish a count: 12, "1,204", {val: 12}, "<5".
 * A masked "<5" counts as its bound so small outages aren't dropped to zero. Text with no
 * digits ("N/A") means nothing out. Anything else with digits in it ("2026-11-01", "12.5%",
 * "1.2K") isn't a count this can read, and guessing would invent a number.
 */
export function toCount(value: unknown): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ShapeError(`Unreadable count: ${value}`);
    return Math.max(0, Math.round(value));
  }
  if (value == null) return 0;
  if (typeof value === 'object') return toCount((value as { val?: unknown }).val);
  const text = String(value).trim();
  if (!/\d/.test(text)) return 0;
  const match = text.match(/^<?\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?$/);
  if (!match) throw new ShapeError(`Unreadable count: ${text.slice(0, 24)}`);
  return Math.round(Number(`${match[1].replaceAll(',', '')}${match[2] ?? ''}`));
}

/** A count that has to be there. A field that vanishes must not read as nobody out. */
export function requireCount(value: unknown, name: string): number {
  const inner = value !== null && typeof value === 'object' ? (value as { val?: unknown }).val : value;
  if (inner == null) throw new ShapeError(`${name} is missing`);
  return toCount(inner);
}

export function getPath(obj: unknown, path: string | undefined): any {
  if (!path) return obj;
  return path.split('.').reduce<any>((cur, key) => (cur == null ? undefined : cur[key]), obj);
}

const INTERNAL_NAME = /\.(?:local|localhost|internal|intranet|lan|home|corp)$/;

/**
 * The URL if it's safe to fetch or link to, for addresses that come from the outside world.
 * Only public web addresses pass: no other schemes, IP literals or internal names.
 */
export function safeUrl(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null;
  // The URL parser has already turned hex and decimal forms into dotted ones.
  const host = url.hostname.toLowerCase();
  if (!host.includes('.') || host.startsWith('[') || /^[\d.]+$/.test(host) || INTERNAL_NAME.test(host)) return null;
  return url.href;
}
