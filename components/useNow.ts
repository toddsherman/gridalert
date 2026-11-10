'use client';

import { useSyncExternalStore } from 'react';

const TICK_MS = 30_000;

function subscribe(onTick: () => void) {
  const id = setInterval(onTick, TICK_MS);
  return () => clearInterval(id);
}

// Rounded so the value is stable between ticks. The server has no clock reading
// that would match the viewer's, so it renders without one.
const getNow = () => Math.floor(Date.now() / TICK_MS) * TICK_MS;
const getServerNow = () => null;

/** The viewer's clock, kept current, because pages are cached and "34 minutes ago" isn't. */
export const useNow = () => useSyncExternalStore(subscribe, getNow, getServerNow);
