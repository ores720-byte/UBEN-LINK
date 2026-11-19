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

// ---- Speed: keep static files on the phone so the app opens fast ----
const CACHE = 'uben-static-v1';
const STATIC_HOSTS = ['cdn.tailwindcss.com', 'cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('uben-static-') && k !== CACHE).map(k => caches.delete(k))))));

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  if (url.hostname.endsWith('supabase.co')) return; // live data is never cached
  const sameOrigin = url.origin === self.location.origin;

  // The page itself: always try the network first so updates arrive, fall back to the saved copy offline
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res; })
      .catch(() => caches.match(req).then(r => r || caches.match('./') || caches.match('index.html'))));
    return;
  }
  // Libraries, fonts and images: show the saved copy at once, refresh it quietly
  const isStatic = STATIC_HOSTS.includes(url.hostname) || (sameOrigin && /\.(png|jpe?g|svg|webp|ico|css|js|json|woff2?)$/i.test(url.pathname) && url.pathname !== '/sw.js');
  if (!isStatic) return;
  event.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(req);
    const fresh = fetch(req).then(res => { if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone()); return res; }).catch(() => hit);
    return hit || fresh;
  }));
});
