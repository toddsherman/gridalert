'use client';

import { timeAgo } from '@/lib/format';
import { useNow } from './useNow';

const STALE_MS = 15 * 60_000;

/** Shows data age, and says so plainly if polling has stopped. */
export function LiveStamp({ generatedAt }: { generatedAt: string | null }) {
  const now = useNow();

  if (!generatedAt) return <span className="text-xs text-ink-2">Waiting for first poll</span>;
  const stale = now !== null && now - new Date(generatedAt).getTime() > STALE_MS;
  return (
    <span className="flex items-center gap-2 text-xs text-ink-2" title={new Date(generatedAt).toISOString()}>
      <span className={`inline-block h-2 w-2 rounded-full ${stale ? 'bg-critical' : 'pulse bg-good'}`} aria-hidden />
      {stale ? 'Data is stale: ' : 'Live, updated '}
      {now === null ? 'recently' : timeAgo(generatedAt, now)}
    </span>
  );
}
