'use client';

import { useEffect, useId, useState } from 'react';
import { leaveAction, signUpAction } from '@/app/actions';
import { BASE_PATH } from '@/lib/site';

function keyBytes(base64: string): Uint8Array<ArrayBuffer> {
  const normalized = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

type Status = 'loading' | 'install' | 'unsupported' | 'blocked' | 'off' | 'on';

// iPads report themselves as Macs, so a touch screen gives them away.
const onIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const onHomeScreen = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

/**
 * The page is /gridalert, with no slash, so the worker's scope is that too. An earlier version
 * used /gridalert/, which left the page out and made `serviceWorker.ready` wait forever.
 */
const SCOPE = BASE_PATH;
/** Past this, something is stuck, and saying so beats a button that never changes. */
const SIGN_UP_MS = 20_000;

/** This page's own registration, once its worker is running. */
async function registration(): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.register(`${BASE_PATH}/sw.js`, { scope: SCOPE });
  const worker = reg.installing ?? reg.waiting;
  if (!reg.active && worker) {
    await new Promise<void>((resolve) => {
      // A worker that fails to install goes redundant, and subscribing then says why.
      worker.addEventListener('statechange', () => {
        if (worker.state === 'activated' || worker.state === 'redundant') resolve();
      });
    });
  }
  return reg;
}

/** Drop the worker from that earlier scope, along with anything signed up through it. */
async function dropOldWorker(): Promise<void> {
  const old = `${location.origin}${BASE_PATH}/`;
  for (const reg of await navigator.serviceWorker.getRegistrations()) {
    if (reg.scope !== old) continue;
    const sub = await reg.pushManager.getSubscription();
    if (sub) await leaveAction(sub.endpoint).catch(() => {});
    await reg.unregister();
  }
}

function inTime<T>(work: Promise<T>): Promise<T> {
  return Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Turning on took too long. Check your connection and try again.')), SIGN_UP_MS))]);
}

function Bolt() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="h-[18px] w-[18px] fill-current">
      <path d="M13 2 3 14h8l-1 8 10-12h-8l1-8z" />
    </svg>
  );
}

export function SignUp({ vapidKey }: { vapidKey?: string }) {
  const [status, setStatus] = useState<Status>('loading');
  // Where the switch is heading while it turns on or off.
  const [busy, setBusy] = useState<'on' | 'off' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const switchId = useId();
  const noteId = useId();

  useEffect(() => {
    (async () => {
      // iPhone lets a site send alerts only once it's on the Home Screen.
      if (onIOS() && !onHomeScreen()) return setStatus('install');
      if (!vapidKey || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return setStatus('unsupported');
      await dropOldWorker().catch(() => {});
      if (Notification.permission === 'denied') return setStatus('blocked');
      const reg = await inTime(registration());
      setStatus((await reg.pushManager.getSubscription()) ? 'on' : 'off');
    })().catch(() => setStatus('unsupported'));
  }, [vapidKey]);

  const turnOn = async () => {
    setBusy('on');
    setError(null);
    try {
      // Safari asks only during a tap, so this comes before anything else is awaited.
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setStatus(permission === 'denied' ? 'blocked' : 'off');
        return;
      }
      const { sub, result } = await inTime(
        (async () => {
          const reg = await registration();
          const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(vapidKey!) }));
          return { sub, result: await signUpAction(JSON.parse(JSON.stringify(sub))) };
        })(),
      );
      if ('error' in result) {
        await sub.unsubscribe();
        setError(result.error);
        return;
      }
      setStatus('on');
    } catch (err) {
      if (Notification.permission === 'denied') setStatus('blocked');
      else setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const turnOff = async () => {
    setBusy('off');
    setError(null);
    try {
      const sub = await (await inTime(registration())).pushManager.getSubscription();
      if (sub) {
        await leaveAction(sub.endpoint);
        await sub.unsubscribe();
      }
      setStatus('off');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const usable = status === 'on' || status === 'off';
  const checked = busy ? busy === 'on' : status === 'on';

  // Laid out like a row in iPhone Settings: a rounded group with the switch on the right, and a note beneath it.
  return (
    <section aria-label="Alerts" className="flex flex-col gap-2">
      <div className="flex min-h-14 items-center gap-3 rounded-[10px] bg-cell py-1.5 pl-4 pr-2.5 shadow-[0_0_0_1px_var(--line)]">
        <span className="grid h-[29px] w-[29px] shrink-0 place-items-center rounded-[7px] bg-accent text-on-accent" aria-hidden>
          <Bolt />
        </span>
        <label htmlFor={switchId} className={`flex-1 text-[17px] leading-snug ${usable ? 'cursor-pointer' : 'text-muted'}`}>
          Blackout alerts
        </label>
        <button
          id={switchId}
          type="button"
          role="switch"
          aria-checked={checked}
          aria-describedby={noteId}
          aria-busy={busy !== null}
          disabled={!usable || busy !== null}
          onClick={status === 'on' ? turnOff : turnOn}
          className="switch"
        >
          <span className="switch-track">
            <span className="switch-knob" />
          </span>
        </button>
      </div>
      <div id={noteId} aria-live="polite" className="flex flex-col gap-1.5 px-4 text-[13px] leading-snug text-muted">
        {busy === 'on' && <p>Turning on…</p>}
        {busy === 'off' && <p>Turning off…</p>}
        {!busy && status === 'loading' && <p>Checking this device…</p>}
        {!busy && status === 'off' && <p>No account or phone number. You can turn it off any time.</p>}
        {!busy && status === 'on' && <p>Alerts are on for this device. You can turn them off any time.</p>}
        {status === 'install' && (
          <>
            <p>On iPhone and iPad, alerts work once GridAlert is on your Home Screen.</p>
            <ol className="list-decimal pl-5">
              <li>In Safari, tap the Share button.</li>
              <li>Tap Add to Home Screen, then Add.</li>
              <li>Open GridAlert from your Home Screen and turn on Blackout alerts.</li>
            </ol>
          </>
        )}
        {status === 'unsupported' && <p>This browser can&apos;t receive alerts. Chrome, Edge, Firefox and Safari can, and on iPhone GridAlert has to be on your Home Screen first.</p>}
        {status === 'blocked' && <p>Notifications are turned off for GridAlert. Allow them in your browser or phone settings, then reload this page.</p>}
        {error && (
          <p role="alert" className="text-critical">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
