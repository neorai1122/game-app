const CACHE = 'mabat-v3';
const SHELL = ['./', './index.html', './app.css?v=3', './app.js?v=3', './manifest.json', './icons/icon-192.png', './icons/icon-512.png'];
const CDN = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com', 'https://cdn.jsdelivr.net', 'https://storage.googleapis.com'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const req = e.request; if (req.method !== 'GET') return;
  const put = (res) => { if (res && (res.ok || res.type === 'opaque')) { const c = res.clone(); caches.open(CACHE).then((x) => x.put(req, c)); } return res; };
  if (req.url.startsWith(self.location.origin)) {
    // קבצי האפליקציה: קודם מהרשת כדי לקבל עדכונים מיד, ומהמטמון כשאין רשת
    e.respondWith(fetch(req).then(put).catch(() => caches.match(req)));
  } else if (CDN.some((o) => req.url.startsWith(o))) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then(put)));
  }
});
