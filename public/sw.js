// The site lives under /gridalert, which a plain script file can't import from lib/site.ts.
const BASE = '/gridalert';

self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : { title: 'GridAlert', body: '', url: `${BASE}/` };
  const actions = data.search ? [{ action: 'search', title: 'Search X' }] : [];
  event.waitUntil(self.registration.showNotification(data.title, { body: data.body, icon: `${BASE}/app-icon/192`, data: { url: data.url, search: data.search }, tag: data.title, requireInteraction: Boolean(data.urgent), actions }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { url, search } = event.notification.data ?? {};
  event.waitUntil(clients.openWindow((event.action === 'search' && search) || url || `${BASE}/`));
});
