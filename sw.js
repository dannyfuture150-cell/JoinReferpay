// Lets ReferPay be installed like an app. It never stores account data: only the page itself is kept, so it can open without signal.
const CACHE = 'referpay-shell-v1';
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/icon-192.png'])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  // Only the page itself. Anything under /api or /admin always goes straight to the server and is never saved.
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api') || url.pathname.startsWith('/admin')) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put('/', copy)); return res; })
      .catch(() => caches.match('/')));
  }
});
