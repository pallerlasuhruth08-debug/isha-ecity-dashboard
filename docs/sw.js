/* Isha E-City Nurturing — service worker
   - precaches the app shell so the app opens instantly, even offline
   - caches Supabase REST GETs so the last-seen data shows with no signal
   - never caches writes (POST/PATCH/DELETE) — those always go to the network
   Bump CACHE on each deploy to invalidate old assets. */
const CACHE = 'ecity-v55';
const SHELL = ['./', './index.html', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return; // writes always hit the network
  let url;
  try { url = new URL(req.url); } catch { return; }

  // Supabase data reads → network-first, fall back to last cached copy (offline reads)
  if (url.hostname.endsWith('supabase.co') && url.pathname.startsWith('/rest')) {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res && res.status === 200) { const c = await caches.open(CACHE); c.put(req, res.clone()); }
        return res;
      } catch (err) {
        const cached = await caches.match(req);
        if (cached) return cached;
        throw err;
      }
    })());
    return;
  }

  // page navigations → network-first, fall back to cached shell so the app still opens offline
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try { return await fetch(req); }
      catch { return (await caches.match('./index.html')) || (await caches.match('./')) || Response.error(); }
    })());
    return;
  }

  // everything else (our JS/CSS/img + CDN libs) → stale-while-revalidate
  e.respondWith((async () => {
    const cached = await caches.match(req);
    const net = fetch(req).then((res) => {
      if (res && res.status === 200) caches.open(CACHE).then((c) => c.put(req, res.clone()));
      return res;
    }).catch(() => null);
    return cached || (await net) || Response.error();
  })());
});
