'use server';

import { revalidatePath, revalidateTag } from 'next/cache';
import { deliver, siteUrl } from '@/lib/alerts/notify';
import { isAdmin, signIn, signOut } from '@/lib/auth';
import { readSettings } from '@/lib/run';
import { safeUrl } from '@/lib/sources/http';
import { PATHS, writeDoc } from '@/lib/store';
import { DEFAULT_SETTINGS, type Settings } from '@/lib/types';

export type FormState = { ok?: string; error?: string };

async function requireAdmin() {
  if (!(await isAdmin())) throw new Error('Not signed in');
}

export async function loginAction(_: FormState, form: FormData): Promise<FormState> {
  const ok = await signIn(String(form.get('token') ?? ''));
  if (!ok) return { error: 'That token is not correct.' };
  revalidatePath('/settings');
  return {};
}

export async function logoutAction() {
  await signOut();
  revalidatePath('/settings');
}

const clamp = (v: FormDataEntryValue | null, min: number, max: number, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

export async function saveSettingsAction(_: FormState, form: FormData): Promise<FormState> {
  await requireAdmin();
  const webhookUrl = String(form.get('webhookUrl') ?? '').trim();
  if (webhookUrl && !(webhookUrl.startsWith('https://') && safeUrl(webhookUrl))) return { error: 'The webhook URL must be a public https:// address.' };
  const states = String(form.get('states') ?? '').toUpperCase().split(/[\s,]+/).filter((s) => /^[A-Z]{2}$/.test(s));

  // Strict, because saving over settings that failed to load would wipe them.
  const current = await readSettings();
  const next: Settings = {
    ...current,
    thresholdPeople: clamp(form.get('thresholdPeople'), 500, 10_000_000, DEFAULT_SETTINGS.thresholdPeople),
    peoplePerCustomer: clamp(form.get('peoplePerCustomer'), 1, 5, DEFAULT_SETTINGS.peoplePerCustomer),
    confirmPolls: Math.round(clamp(form.get('confirmPolls'), 1, 12, DEFAULT_SETTINGS.confirmPolls)),
    clearPolls: Math.round(clamp(form.get('clearPolls'), 1, 48, DEFAULT_SETTINGS.clearPolls)),
    escalateFactor: clamp(form.get('escalateFactor'), 1.25, 10, DEFAULT_SETTINGS.escalateFactor),
    // A blank value would read as 0, which would silently turn this alert off.
    unexplainedCustomers: form.get('unexplainedCustomers') ? Math.round(clamp(form.get('unexplainedCustomers'), 0, 10_000_000, DEFAULT_SETTINGS.unexplainedCustomers)) : current.unexplainedCustomers,
    watchCustomers: form.get('watchCustomers') ? Math.round(clamp(form.get('watchCustomers'), 0, 10_000_000, DEFAULT_SETTINGS.watchCustomers)) : current.watchCustomers,
    simultaneousAreas: form.get('simultaneousAreas') ? Math.round(clamp(form.get('simultaneousAreas'), 0, 20, DEFAULT_SETTINGS.simultaneousAreas)) : current.simultaneousAreas,
    simultaneousCustomers: form.get('simultaneousCustomers') ? Math.round(clamp(form.get('simultaneousCustomers'), 1_000, 10_000_000, DEFAULT_SETTINGS.simultaneousCustomers)) : current.simultaneousCustomers,
    states,
    webhookUrl: webhookUrl || undefined,
    emailTo: String(form.get('emailTo') ?? '').trim() || undefined,
  };
  await writeDoc(PATHS.settings, next);
  revalidateTag('settings', 'max');
  revalidatePath('/', 'layout');
  return { ok: 'Saved. The next poll uses these settings.' };
}

export async function testAlertAction(): Promise<FormState> {
  await requireAdmin();
  try {
    const settings = await readSettings();
    // Only the owner's channels: browser subscribers are the public.
    const { channels, errors } = await deliver(
      { title: 'GridAlert test', body: 'This is a test alert. Delivery is working.', url: `${siteUrl()}/alerts` },
      settings,
    );
    return { ok: `Sent via ${channels.join(', ')}.${errors.length ? ` Failed: ${errors.join('; ')}` : ''}` };
  } catch (err) {
    return { error: (err as Error).message };
  }
}
