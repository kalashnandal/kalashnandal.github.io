/* ═══════════════════════════════════════════════════════════════════════════
   Never Again — service worker
   ---------------------------------------------------------------------------
   Three jobs:
     1. Precache the app shell so the app opens offline and is installable.
     2. Serve same-origin assets cache-first, navigations network-first.
     3. Handle taps on proximity-warning notifications (focus the app and tell
        it which place to open).

   Bump CACHE_VERSION whenever you ship changed assets — the old cache is
   deleted on activate.
   ═══════════════════════════════════════════════════════════════════════════ */

const CACHE_VERSION = 'never-again-v1';

/* Relative URLs so this works from a GitHub Pages subdirectory
   (e.g. https://user.github.io/never-again/) without any rewriting. */
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];


/* ── Install: precache the shell ─────────────────────────────────────────── */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    // addAll is all-or-nothing; add individually so one 404 can't break install.
    await Promise.all(APP_SHELL.map(async (url) => {
      try { await cache.add(new Request(url, { cache: 'reload' })); }
      catch (err) { console.warn('[SW] could not precache', url, err); }
    }));
    self.skipWaiting();
  })());
});


/* ── Activate: drop old caches, take over open pages ─────────────────────── */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE_VERSION).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});


/* ── Fetch ───────────────────────────────────────────────────────────────── */
self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  /* Never touch cross-origin traffic. The Google Maps/Places APIs are
     versioned, auth'd and change constantly — caching them breaks the map and
     would serve stale tiles. Let the network handle them. */
  if (url.origin !== self.location.origin) return;

  /* Navigations: network-first so a deployed update is picked up immediately,
     falling back to the cached shell when offline. */
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        const cache = await caches.open(CACHE_VERSION);
        cache.put('./index.html', fresh.clone());
        return fresh;
      } catch {
        const cached = await caches.match('./index.html', { ignoreSearch: true });
        return cached || new Response('Offline', { status: 503, statusText: 'Offline' });
      }
    })());
    return;
  }

  /* Static assets: cache-first, then refresh the entry in the background
     (stale-while-revalidate) so the next load gets the newer file. */
  event.respondWith((async () => {
    const cached = await caches.match(request);

    const network = fetch(request).then((response) => {
      if (response && response.ok && response.type === 'basic') {
        caches.open(CACHE_VERSION).then((cache) => cache.put(request, response.clone()));
      }
      return response;
    }).catch(() => null);

    return cached || (await network) || new Response('', { status: 504 });
  })());
});


/* ── Notification tap ────────────────────────────────────────────────────── */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const placeId = event.notification.data && event.notification.data.placeId;
  const scope = new URL(self.registration.scope);
  const target = placeId
    ? `${scope.pathname}?place=${encodeURIComponent(placeId)}`
    : scope.pathname;

  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

    // Already open somewhere? Focus it and ask app.js to open the place card.
    for (const client of clientList) {
      if (new URL(client.url).pathname.startsWith(scope.pathname)) {
        client.postMessage({ type: 'open-place', placeId });
        if ('focus' in client) return client.focus();
      }
    }

    // Cold start — the ?place= param is picked up by app.js on boot.
    if (self.clients.openWindow) return self.clients.openWindow(target);
  })());
});


/* Lets the page trigger an immediate update (postMessage {type:'skip-waiting'}). */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'skip-waiting') self.skipWaiting();
});
