'use client';

import { useEffect, useRef, useState } from 'react';

/** One shared tooltip for every element carrying data-tip="Title|Detail". */
export function TooltipLayer() {
  const [tip, setTip] = useState<{ title: string; detail: string; x: number; y: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const show = (el: Element, x: number, y: number) => {
      const [title, detail] = (el.getAttribute('data-tip') ?? '').split('|');
      setTip({ title, detail, x, y });
    };
    const move = (e: PointerEvent) => {
      const el = (e.target as Element | null)?.closest?.('[data-tip]');
      if (el) show(el, e.clientX, e.clientY);
      else setTip(null);
    };
    const focus = (e: FocusEvent) => {
      const el = (e.target as Element | null)?.closest?.('[data-tip]');
      if (!el) return;
      const r = el.getBoundingClientRect();
      show(el, r.left + r.width / 2, r.top);
    };
    const blur = () => setTip(null);
    document.addEventListener('pointermove', move);
    document.addEventListener('focusin', focus);
    document.addEventListener('focusout', blur);
    return () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('focusout', blur);
    };
  }, []);

  if (!tip) return null;
  const left = Math.min(tip.x + 14, (typeof window === 'undefined' ? 1200 : window.innerWidth) - 260);
  return (
    <div ref={box} role="status" style={{ left, top: Math.max(8, tip.y - 58) }} className="card pointer-events-none fixed z-50 w-max max-w-[248px] px-3 py-2 text-xs">
      <div className="font-semibold text-ink">{tip.title}</div>
      {tip.detail && <div className="tabular text-ink-2">{tip.detail}</div>}
    </div>
  );
}
