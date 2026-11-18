// UBEN Link service worker: shows push notifications and opens the app when tapped.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (_) { d = { body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(d.title || 'UBEN Link', {
    body: d.body || 'You have a new notification.',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: d.tag || 'uben-link',
    data: { url: d.url || './#/notifications' },
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || './#/notifications', self.registration.scope).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.startsWith(self.registration.scope) && 'focus' in c) {
        await c.focus();
        if ('navigate' in c) try { await c.navigate(url); } catch (_) {}
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
