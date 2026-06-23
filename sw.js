/**
 * InspectOA Service Worker v4
 * - Cache-first pour les assets statiques
 * - Background sync pour les relevés en attente
 * - Mise à jour silencieuse avec notification à l'app
 */

const CACHE    = 'inspectoa-v4';
const CDN_JPDF = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';

const STATIC = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

// ── Installation ───────────────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(async cache => {
      // Assets locaux — obligatoires
      await cache.addAll(STATIC);
      // jsPDF CDN — optionnel (peut échouer hors ligne au premier chargement)
      try { await cache.add(CDN_JPDF); } catch (_) {}
    }).then(() => self.skipWaiting())
  );
});

// ── Activation ────────────────────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);

  // Assets locaux + CDN jsPDF → stale-while-revalidate
  const isLocal = STATIC.some(p => url.pathname === p || url.pathname === p.replace(/\/$/, ''));
  const isCDN   = url.hostname === 'cdnjs.cloudflare.com';

  if (isLocal || isCDN) {
    e.respondWith(staleWhileRevalidate(e.request));
    return;
  }

  // Requêtes API → network only (pas de cache des données métier)
  if (url.pathname.startsWith('/api/')) return;

  // Tout le reste → network with cache fallback
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});

async function staleWhileRevalidate(req) {
  const cache  = await caches.open(CACHE);
  const cached = await cache.match(req);

  const networkFetch = fetch(req).then(res => {
    if (res && res.status === 200) {
      cache.put(req, res.clone());
    }
    return res;
  }).catch(() => null);

  return cached || await networkFetch;
}

// ── Background Sync ───────────────────────────────────────────────────────
self.addEventListener('sync', e => {
  if (e.tag === 'sync-releves') {
    e.waitUntil(notifyClients('sync-requested'));
  }
});

// ── Push notifications ────────────────────────────────────────────────────
self.addEventListener('push', e => {
  const data = e.data?.json() || {};
  e.waitUntil(
    self.registration.showNotification(data.title || 'InspectOA', {
      body:  data.body || 'Mise à jour disponible',
      icon:  '/icon-192.png',
      badge: '/icon-192.png',
      tag:   'inspectoa',
      data:  data,
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow('/'));
});

// ── Messages depuis l'app ─────────────────────────────────────────────────
self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
  if (e.data === 'ping') e.ports[0]?.postMessage('pong');
});

async function notifyClients(msg) {
  const all = await self.clients.matchAll({ type: 'window' });
  all.forEach(c => c.postMessage(msg));
}
