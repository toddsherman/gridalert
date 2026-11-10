'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { compact, num } from '@/lib/format';

const HEIGHT = 220;
const PAD = { top: 14, right: 12, bottom: 26, left: 44 };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function niceMax(v: number): number {
  const base = 10 ** Math.floor(Math.log10(Math.max(v, 1)));
  return [1, 2, 2.5, 5, 10].map((m) => m * base).find((m) => m >= v) ?? v;
}

const fullLabel = (t: number) => new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Local-time axis ticks: hours for a short window, days for a long one. */
function timeTicks(start: number, end: number, width: number): Array<{ at: number; label: string }> {
  const span = end - start;
  if (span > 2 * DAY) {
    const step = span <= 8 * DAY ? 1 : width < 500 ? 4 : width < 900 ? 2 : 1;
    const d = new Date(start);
    d.setHours(24, 0, 0, 0);
    const ticks = [];
    for (let at = d.getTime(), i = 0; at < end; at += DAY, i++) {
      if (i % step === 0) ticks.push({ at, label: new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) });
    }
    return ticks;
  }
  const hours = [1, 2, 3, 4, 6, 12].find((h) => (span / (h * HOUR)) * 70 < width) ?? 24;
  const d = new Date(start);
  d.setMinutes(0, 0, 0);
  const ticks = [];
  for (let at = d.getTime() + HOUR; at < end; at += HOUR) {
    if (new Date(at).getHours() % hours === 0) {
      ticks.push({ at, label: new Date(at).toLocaleTimeString('en-US', { hour: 'numeric' }) });
    }
  }
  return ticks;
}

export function TrendChart({ t, people, alertLevel, label }: { t: number[]; people: number[]; alertLevel?: number; label: string }) {
  const box = useRef<HTMLDivElement>(null);
  // Measured so type stays the same size at every width. Null until mounted:
  // time labels depend on the viewer's zone, which the server can't know.
  const [width, setWidth] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const W = width ?? 720;
  const { x, y, line, area, ticks, max } = useMemo(() => {
    const peak = Math.max(...people, 1);
    // Only stretch the axis to the alert level when the data gets near it.
    const max = niceMax(alertLevel && peak > alertLevel * 0.4 ? Math.max(peak, alertLevel) : peak);
    const plotW = W - PAD.left - PAD.right;
    const plotH = HEIGHT - PAD.top - PAD.bottom;
    const t0 = t[0];
    const span = Math.max(t[t.length - 1] - t0, 1);
    const x = (ms: number) => PAD.left + ((ms - t0) / span) * plotW;
    const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
    const pts = people.map((v, i) => `${x(t[i]).toFixed(1)},${y(v).toFixed(1)}`);
    const line = pts.join(' ');
    const area = `${x(t0)},${y(0)} ${line} ${x(t[t.length - 1])},${y(0)}`;
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
    return { x, y, line, area, ticks, max };
  }, [t, people, alertLevel, W]);

  if (t.length < 2) {
    return <p className="py-10 text-center text-sm text-ink-2">The trend appears after the first hour of polling.</p>;
  }

  const onMove = (e: React.PointerEvent) => {
    const rect = box.current!.getBoundingClientRect();
    const fraction = (e.clientX - rect.left - PAD.left) / (W - PAD.left - PAD.right);
    const ms = t[0] + fraction * (t[t.length - 1] - t[0]);
    let best = 0;
    t.forEach((v, i) => {
      if (Math.abs(v - ms) < Math.abs(t[best] - ms)) best = i;
    });
    setHover(best);
  };

  const showAlert = alertLevel !== undefined && alertLevel <= max;
  return (
    <div ref={box} className="relative">
      <svg width="100%" height={HEIGHT} viewBox={`0 0 ${W} ${HEIGHT}`} preserveAspectRatio="none" className="block touch-none" role="img" aria-label={label} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke={v === 0 ? 'var(--axis)' : 'var(--line)'} strokeWidth={1} />
            <text x={PAD.left - 8} y={y(v) + 4} textAnchor="end" fontSize={11} fill="var(--muted)" className="tabular">
              {compact(v)}
            </text>
          </g>
        ))}
        {width !== null &&
          timeTicks(t[0], t[t.length - 1], W).map(({ at, label: text }) => (
            <text key={at} x={x(at)} y={HEIGHT - 8} textAnchor="middle" fontSize={11} fill="var(--muted)">
              {text}
            </text>
          ))}
        <polygon points={area} fill="var(--series)" fillOpacity={0.12} />
        <polyline points={line} fill="none" stroke="var(--series)" strokeWidth={2} strokeLinejoin="round" />
        {showAlert && (
          <g>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(alertLevel)} y2={y(alertLevel)} stroke="var(--critical)" strokeWidth={1} />
            <text x={W - PAD.right} y={y(alertLevel) - 5} textAnchor="end" fontSize={11} fill="var(--ink-2)">
              Alert level {compact(alertLevel)}
            </text>
          </g>
        )}
        {hover !== null && (
          <g>
            <line x1={x(t[hover])} x2={x(t[hover])} y1={PAD.top} y2={y(0)} stroke="var(--axis)" strokeWidth={1} />
            <circle cx={x(t[hover])} cy={y(people[hover])} r={4} fill="var(--series)" stroke="var(--surface)" strokeWidth={2} />
          </g>
        )}
      </svg>
      {hover !== null && (
        <div className="card pointer-events-none absolute top-2 w-max px-3 py-2 text-xs" style={{ left: Math.max(8, Math.min(x(t[hover]) - 70, W - 170)) }}>
          <div className="text-ink-2">{fullLabel(t[hover])}</div>
          <div className="tabular font-semibold text-ink">About {num(people[hover])} people</div>
        </div>
      )}
    </div>
  );
}
