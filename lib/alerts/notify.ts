import { xSearch } from '../format.ts';
import { BASE_PATH, PUBLIC_URL } from '../site.ts';
import type { AlertEvent, Settings } from '../types.ts';

export interface Message {
  title: string;
  body: string;
  url: string;
  /** Asks channels that support it to make this stand out from routine alerts. */
  urgent?: boolean;
  /** Latest posts on X about it, for the reader to check by hand. */
  search?: string;
}

/** The site's address, base path included. Production links go to todd.sh, not the Vercel host behind it. */
export function siteUrl(): string {
  if (process.env.VERCEL_ENV === 'production') return PUBLIC_URL;
  const host = process.env.VERCEL_URL;
  return host ? `https://${host}${BASE_PATH}` : `http://localhost:3000${BASE_PATH}`;
}

/** The alert key for several large feeds stopping at once. */
export const FEEDS_KEY = 'system:feeds';

export function formatEvent(e: AlertEvent): Message {
  const people = e.people.toLocaleString('en-US');
  const customers = e.customers.toLocaleString('en-US');
  const url = `${siteUrl()}${e.link}`;
  const context = [e.cause, e.detail].filter(Boolean).join(' ');
  // News takes hours to cover a blackout, so the alerts that matter link to what people are posting.
  const search = e.areas?.length ? xSearch(e.areas) : undefined;
  // Monitoring notices have no people to count.
  if (e.key === FEEDS_KEY) {
    return e.kind === 'resolved' ? { title: 'Feeds updating again', body: e.detail, url } : { title: 'Large feeds stopped updating', body: e.detail, url, urgent: true };
  }
  if (e.key.startsWith('system:')) {
    return { title: `${e.label} ${e.kind === 'resolved' ? 'recovered' : 'degraded'}`, body: e.detail, url, ...(e.urgent && e.kind !== 'resolved' && { urgent: true }) };
  }
  switch (e.kind) {
    case 'opened':
      return { title: `Power outage: ${e.label}`, body: `About ${people} people affected (${customers} customers). ${context}`.trim(), url };
    case 'escalated':
      return { title: `Growing outage: ${e.label}`, body: `Now about ${people} people affected (${customers} customers). ${context}`.trim(), url };
    case 'unexplained':
      return { title: `Unexplained blackout: ${e.label}`, body: `Peaked near ${e.peakPeople.toLocaleString('en-US')} people (${customers} customers). ${e.detail}`, url, urgent: true, search };
    case 'explained':
      return { title: `Blackout explained: ${e.label}`, body: e.detail, url };
    case 'deliberate':
      return { title: `Reported as deliberate: ${e.label}`, body: e.detail, url, urgent: true, search };
    case 'simultaneous':
      return { title: `Simultaneous blackouts: ${e.label}`, body: `About ${e.peakPeople.toLocaleString('en-US')} people (${customers} customers) at peak. ${e.detail}`, url, urgent: true, search };
    case 'simultaneous-explained':
      return { title: `Simultaneous alert stood down: ${e.label}`, body: e.detail, url };
    case 'resolved':
      if (e.blind) return { title: `Closed with no reading: ${e.label}`, body: e.detail, url };
      return {
        title: `Mostly restored: ${e.label}`,
        body: `Down to about ${people} people. Peaked near ${e.peakPeople.toLocaleString('en-US')}, opened ${new Date(e.openedAt).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'short', timeStyle: 'short' })} ET.`,
        url,
      };
  }
}

/** Adapt to whichever service the webhook points at. */
export function webhookRequest(target: string, m: Message): { body: string; headers: Record<string, string> } {
  const host = new URL(target).hostname;
  const line = `${m.title}\n${m.body}\n${m.url}${m.search ? `\nSearch X: ${m.search}` : ''}`;
  // Alert text includes headlines from anywhere, which mustn't be able to ping a whole channel.
  if (host === 'discord.com' || host === 'discordapp.com') {
    return { body: JSON.stringify({ content: line, allowed_mentions: { parse: [] } }), headers: { 'content-type': 'application/json' } };
  }
  if (host === 'hooks.slack.com') {
    return { body: JSON.stringify({ text: line.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') }), headers: { 'content-type': 'application/json' } };
  }
  if (isNtfy(target)) {
    // ntfy takes titles in a header, which must be ASCII.
    // The search is a button, which an encoded URL can't break: it has no commas or semicolons.
    const headers = { title: m.title.normalize('NFKD').replace(/[^\x20-\x7e]/g, ''), tags: m.urgent ? 'rotating_light' : 'zap', click: m.url, ...(m.search && { actions: `view, Search X, ${m.search}` }) };
    return { body: `${m.body}\n${m.url}`, headers: { ...headers, ...(m.urgent && { priority: 'high' }), ...ntfyAuth() } };
  }
  return { body: JSON.stringify(m), headers: { 'content-type': 'application/json' } };
}

/** How long after the last check-in ntfy sends the warning itself. Longer than a few missed polls. */
const HEARTBEAT_DELAY = '40m';
const HEARTBEAT_SEQUENCE = 'gridalert-heartbeat';

const isNtfy = (target: string) => {
  const host = new URL(target).host;
  return host === 'ntfy.sh' || host.startsWith('ntfy.');
};

/**
 * Without an account, ntfy counts its limits by the sender's address, which Vercel shares among
 * its customers, so someone else's traffic can get GridAlert refused. A token from a free ntfy
 * account, set as NTFY_TOKEN, has it counted on its own.
 */
const ntfyAuth = (): Record<string, string> => (process.env.NTFY_TOKEN ? { authorization: `Bearer ${process.env.NTFY_TOKEN}` } : {});

/**
 * A dead-man's switch. Each call replaces a message scheduled on ntfy's own servers, so if
 * GridAlert or Vercel stops, ntfy delivers the warning without anything here running.
 * Resolves false if the webhook isn't ntfy, which has no such feature.
 */
export async function checkIn(settings: Settings): Promise<boolean> {
  if (!settings.webhookUrl || !isNtfy(settings.webhookUrl)) return false;
  const res = await fetch(`${settings.webhookUrl.replace(/\/$/, '')}/${HEARTBEAT_SEQUENCE}`, {
    method: 'POST',
    body: `GridAlert hasn't finished a poll in over 40 minutes, so blackouts may be going unreported. Check ${siteUrl()}/api/health`,
    headers: { in: HEARTBEAT_DELAY, title: 'GridAlert has stopped', priority: 'high', tags: 'rotating_light', ...ntfyAuth() },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`heartbeat HTTP ${res.status}`);
  return true;
}

async function sendWebhook(target: string, m: Message): Promise<void> {
  const { body, headers } = webhookRequest(target, m);
  const res = await fetch(target, { method: 'POST', body, headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
}

async function sendEmail(to: string, m: Message): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: process.env.ALERT_EMAIL_FROM ?? 'GridAlert <onboarding@resend.dev>',
      to,
      subject: m.title,
      text: `${m.body}\n\n${m.url}${m.search ? `\n\nSearch X: ${m.search}` : ''}`,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`email HTTP ${res.status}`);
}

/**
 * Deliver one message on the site owner's channels. Rejects unless one of them took it.
 * Browser subscribers are the public, and get blackout alerts separately (lib/alerts/push.ts).
 */
export async function deliver(m: Message, settings: Settings): Promise<{ channels: string[]; errors: string[] }> {
  const jobs: Array<[string, Promise<boolean | void>]> = [];
  if (settings.webhookUrl) jobs.push(['webhook', sendWebhook(settings.webhookUrl, m)]);
  if (settings.emailTo && process.env.RESEND_API_KEY) jobs.push(['email', sendEmail(settings.emailTo, m)]);

  const results = await Promise.allSettled(jobs.map(([, p]) => p));
  const channels: string[] = [];
  const errors: string[] = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected') errors.push(`${jobs[i][0]}: ${(r.reason as Error).message}`);
    else if (r.value !== false) channels.push(jobs[i][0]);
  });
  if (!channels.length) throw new Error(errors.join('; ') || 'no alert channel is set up');
  return { channels, errors };
}
