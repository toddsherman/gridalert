/**
 * Checks the live site after a deploy: node scripts/smoke.ts [url]
 * These are the things that have broken the page or the alert sign-up before without failing a test.
 */
import { BASE_PATH, PUBLIC_URL } from '../lib/site.ts';

const base = (process.argv[2] ?? PUBLIC_URL).replace(/\/$/, '');
const failures: string[] = [];
const check = (ok: unknown, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

const page = await fetch(base);
const html = await page.text();
check(page.status === 200, `the page loads (${page.status})`);
check(html.includes('role="switch"'), 'the alert switch is on the page');
check(html.includes('Get notified of large unexplained blackouts'), 'the headline is on the page');

// The worker has to be allowed the page's own path as its scope, or signing up waits forever.
const worker = await fetch(`${base}/sw.js`);
check(worker.status === 200, `the service worker loads (${worker.status})`);
check(worker.headers.get('service-worker-allowed') === BASE_PATH, `the service worker may control ${BASE_PATH}`);

const manifest = await fetch(`${base}/manifest.webmanifest`).then((r) => r.json()).catch(() => null);
check(manifest?.scope === BASE_PATH && manifest?.start_url === BASE_PATH, 'the Home Screen app opens the page itself');
const icon = manifest?.icons?.[0]?.src ? await fetch(new URL(manifest.icons[0].src, base)) : null;
check(icon?.status === 200, 'the app icon loads');

const health = await fetch(`${base}/api/health`).then((r) => r.json()).catch(() => null);
check(health && health.ageSeconds !== null && health.ageSeconds < 900, `polling is current (${health?.ageSeconds}s old)`);
if (health?.impaired?.length) console.log(`note: the health check reports ${health.impaired.join(', ')}`);

if (failures.length) {
  console.error(`\n${failures.length} check${failures.length === 1 ? '' : 's'} failed.`);
  process.exit(1);
}
