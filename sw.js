// UBEN Link service worker: shows push notifications, opens the app when tapped, and keeps static files for speed.

const CACHE = 'uben-static-v2'; // bump this when the cache rules change; old caches are removed on activate
const STATIC_HOSTS = ['cdn.tailwindcss.com', 'cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => {
  event.waitUntil(Promise.all([
    self.clients.claim(),
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k.startsWith('uben-static-') && k !== CACHE).map(k => caches.delete(k))
    )),
  ]));
});

// ---- Notifications ----
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

// ---- Caching ----
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  if (url.hostname.endsWith('supabase.co')) return; // live data is never cached
  const sameOrigin = url.origin === self.location.origin;

  // The page itself: network first so updates arrive, saved copy when offline
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).then(res => {
      caches.open(CACHE).then(c => c.put(req, res.clone()));
      return res;
    }).catch(() => caches.match(req).then(r => r || caches.match('./') || caches.match('index.html'))));
    return;
  }

  // The app's own scripts and styles: network first, so a fix is never hidden behind an old copy
  if (sameOrigin && /\.(js|css|json)$/i.test(url.pathname) && url.pathname !== '/sw.js') {
    event.respondWith(fetch(req).then(res => {
      if (res && res.ok) caches.open(CACHE).then(c => c.put(req, res.clone()));
      return res;
    }).catch(() => caches.match(req)));
    return;
  }

  // Libraries, fonts and images: show the saved copy at once, refresh it quietly
  const isStatic = STATIC_HOSTS.includes(url.hostname) || (sameOrigin && /\.(png|jpe?g|svg|webp|ico|woff2?)$/i.test(url.pathname));
  if (!isStatic) return;
  event.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(req);
    const fresh = fetch(req).then(res => {
      if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone());
      return res;
    }).catch(() => hit);
    return hit || fresh;
  }));
});
