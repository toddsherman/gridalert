import type { CauseStatus, SourceHealth } from '@/lib/types';

const HEALTH: Record<SourceHealth, { label: string; dot: string }> = {
  ok: { label: 'Live', dot: 'bg-good' },
  stale: { label: 'Stale', dot: 'bg-warn' },
  frozen: { label: 'Frozen', dot: 'bg-warn' },
  down: { label: 'Down', dot: 'bg-critical' },
};

export function HealthBadge({ health }: { health: SourceHealth }) {
  const h = HEALTH[health];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-ink-2">
      <span className={`inline-block h-2 w-2 rounded-full ${h.dot}`} aria-hidden />
      {h.label}
    </span>
  );
}

const CAUSE: Record<CauseStatus, { label: string; dot: string }> = {
  checking: { label: 'Checking', dot: 'bg-warn' },
  unknown: { label: 'Cause unknown', dot: 'bg-critical' },
  explained: { label: 'Explained', dot: 'bg-muted' },
};

export function CauseBadge({ status }: { status: CauseStatus }) {
  const c = CAUSE[status];
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm font-medium">
      <span className={`inline-block h-2 w-2 rounded-full ${c.dot}`} aria-hidden />
      {c.label}
    </span>
  );
}

export function AlertGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="shrink-0">
      <path d="M8 1.5 15 14H1L8 1.5Z" fill="var(--critical)" />
      <rect x="7.25" y="6" width="1.5" height="4.5" rx="0.75" fill="var(--surface)" />
      <circle cx="8" cy="12" r="0.9" fill="var(--surface)" />
    </svg>
  );
}
