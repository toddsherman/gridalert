import { get, put } from '@vercel/blob';

const OPTIONS = { access: 'private', contentType: 'application/json', addRandomSuffix: false } as const;
/** No single storage call may use up the time an alert needs. */
const READ_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 20_000;
const READ_RETRY_MS = 500;

// The SDK's default of 10 retries can outlast a whole poll, and the timeouts here are what bound it.
process.env.VERCEL_BLOB_RETRIES ??= '2';

export interface Stored<T> {
  value: T;
  etag: string;
}

/** Read a JSON document. Fresh reads bypass the Blob cache; use them for state. */
export async function readDoc<T>(pathname: string, opts: { fresh?: boolean } = {}): Promise<Stored<T> | null> {
  try {
    return await readOnce<T>(pathname, opts);
  } catch {
    // One blip shouldn't cost a whole poll.
    await new Promise((resolve) => setTimeout(resolve, READ_RETRY_MS));
    return readOnce<T>(pathname, opts);
  }
}

async function readOnce<T>(pathname: string, opts: { fresh?: boolean }): Promise<Stored<T> | null> {
  const res = await get(pathname, { access: 'private', useCache: !opts.fresh, abortSignal: AbortSignal.timeout(READ_TIMEOUT_MS) });
  if (!res || res.statusCode !== 200) return null;
  const text = await new Response(res.stream).text();
  // Compressed responses carry a weak ETag ("W/..."), which never matches on a
  // conditional write, so keep only the validator itself.
  return { value: JSON.parse(text) as T, etag: res.blob.etag.replace(/^W\//, '') };
}

export async function writeDoc(pathname: string, value: unknown): Promise<void> {
  await put(pathname, JSON.stringify(value), { ...OPTIONS, allowOverwrite: true, abortSignal: AbortSignal.timeout(WRITE_TIMEOUT_MS) });
}

/**
 * Compare-and-swap write. Throws BlobPreconditionFailedError if the document
 * changed since it was read, which is how overlapping cron runs are stopped from
 * both sending the same alerts. With no etag the document must not exist yet.
 */
export async function swapDoc(pathname: string, value: unknown, etag: string | null): Promise<string> {
  const abortSignal = AbortSignal.timeout(WRITE_TIMEOUT_MS);
  const res = await put(pathname, JSON.stringify(value), etag ? { ...OPTIONS, allowOverwrite: true, ifMatch: etag, abortSignal } : { ...OPTIONS, allowOverwrite: false, abortSignal });
  return res.etag;
}

export const PATHS = {
  latest: 'state/latest.json',
  engine: 'state/engine.json',
  history: 'state/history.json',
  alerts: 'state/alerts.json',
  blackouts: 'state/blackouts.json',
  simultaneous: 'state/simultaneous.json',
  news: 'state/news.json',
  health: 'state/health.json',
  settings: 'state/settings.json',
  push: 'state/push-subscriptions.json',
  reports: 'state/reports.json',
  sample: (at: Date) => `archive/${at.toISOString().slice(0, 10)}/${at.toISOString().slice(11, 16).replace(':', '')}.json`,
} as const;
