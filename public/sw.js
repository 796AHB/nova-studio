/* Nova Studio service worker — offline app shell + cached CDN libraries.
   API calls (provider hosts and /proxy/*) are never cached. Bump VERSION on each release. */
const VERSION = 'nova-v3.2.2';
const SHELL = [
  './', './index.html', './manifest.webmanifest', './css/app.css',
  './js/app.js', './js/config.js', './js/store.js', './js/usage.js', './js/util.js', './js/files.js', './js/connectors.js',
  './js/logs.js', './js/vault.js', './js/i18n.js', './js/canvas.js', './js/projects.js', './js/gallery.js', './js/kb.js', './js/voice.js', './js/compare.js',
  './js/account.js', './js/sync.js', './js/tasks.js', './js/updates.js', './js/schedule.js', './js/runs.js', './sandbox.html',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/favicon-32.png',
];
const CDN = 'https://cdnjs.cloudflare.com/';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });

async function staleWhileRevalidate(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
  const net = fetch(req).then(res => { if (res.ok || res.type === 'opaque') cache.put(req, res.clone()); return res; }).catch(() => null);
  return hit || (await net) || new Response('Offline', { status: 503 });
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  if (sameOrigin && (url.pathname.includes('/proxy/') || url.pathname.endsWith('/relay') || url.pathname.endsWith('/healthz') || url.pathname.includes('/api/') || url.pathname.includes('/s/'))) return; // Nova server APIs: network only
  if (req.mode === 'navigate' && sameOrigin && req.destination !== 'iframe') {                          // pages: network first, offline fallback
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put('./index.html', copy)); }
      return res;
    }).catch(async () => (await caches.match('./index.html')) || (await caches.match('./')) || new Response('Offline', { status: 503 })));
    return;
  }
  if (sameOrigin || url.href.startsWith(CDN)) e.respondWith(staleWhileRevalidate(req));
  // everything else (AI provider APIs, generated media URLs) goes straight to the network
});

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Nova Studio', { body: d.body || '', icon: './icons/icon-192.png', badge: './icons/icon-192.png', tag: d.tag, data: { url: d.url || './' } }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const c = list.find(w => 'focus' in w);
    if (c) { c.navigate?.(url); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
