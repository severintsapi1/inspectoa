/**
 * InspectOA — Couche de persistance IndexedDB
 * Remplace localStorage pour les photos (capacité illimitée)
 * et les relevés (robustesse transactionnelle)
 */

const DB_NAME    = 'InspectOA';
const DB_VERSION = 1;

let _db = null;

export async function openDB() {
  if (_db) return _db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = e => {
      const db = e.target.result;

      // Relevés d'inspection
      if (!db.objectStoreNames.contains('releves')) {
        const store = db.createObjectStore('releves', { keyPath: 'id' });
        store.createIndex('oaId',     'oaId',     { unique: false });
        store.createIndex('status',   'status',   { unique: false });
        store.createIndex('savedAt',  'savedAt',  { unique: false });
      }

      // Photos terrain (base64 + métadonnées GPS)
      if (!db.objectStoreNames.contains('photos')) {
        const store = db.createObjectStore('photos', { keyPath: 'id' });
        store.createIndex('oaId',    'oaId',    { unique: false });
        store.createIndex('releveId','releveId',{ unique: false });
        store.createIndex('ts',      'ts',      { unique: false });
      }

      // File de synchronisation (pour envoi différé au serveur)
      if (!db.objectStoreNames.contains('syncQueue')) {
        const store = db.createObjectStore('syncQueue', { keyPath: 'id', autoIncrement: true });
        store.createIndex('type',    'type',    { unique: false });
        store.createIndex('status',  'status',  { unique: false });
      }
    };

    req.onsuccess  = e => { _db = e.target.result; resolve(_db); };
    req.onerror    = e => reject(e.target.error);
  });
}

// ── Helpers génériques ─────────────────────────────────────────────────────

function tx(storeName, mode = 'readonly') {
  return _db.transaction(storeName, mode).objectStore(storeName);
}

function wrap(req) {
  return new Promise((res, rej) => {
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

function getAll(storeName, indexName, indexValue) {
  const store = tx(storeName);
  if (indexName && indexValue !== undefined) {
    return wrap(store.index(indexName).getAll(indexValue));
  }
  return wrap(store.getAll());
}

// ── Relevés ───────────────────────────────────────────────────────────────

export async function saveReleve(releve) {
  const store = tx('releves', 'readwrite');
  return wrap(store.put({ ...releve, updatedAt: new Date().toISOString() }));
}

export async function getReleve(id) {
  return wrap(tx('releves').get(id));
}

export async function getAllReleves() {
  const all = await getAll('releves');
  return all.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
}

export async function deleteReleve(id) {
  return wrap(tx('releves', 'readwrite').delete(id));
}

// ── Photos ────────────────────────────────────────────────────────────────

export async function savePhoto(photo) {
  const store = tx('photos', 'readwrite');
  return wrap(store.put({ ...photo, updatedAt: new Date().toISOString() }));
}

export async function getPhoto(id) {
  return wrap(tx('photos').get(id));
}

export async function getPhotosByOA(oaId) {
  const all = await getAll('photos', 'oaId', oaId);
  return all.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
}

export async function getAllPhotos() {
  const all = await getAll('photos');
  return all.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
}

export async function deletePhoto(id) {
  return wrap(tx('photos', 'readwrite').delete(id));
}

export async function countPhotos() {
  return wrap(tx('photos').count());
}

// ── File de sync ──────────────────────────────────────────────────────────

export async function enqueueSync(item) {
  const store = tx('syncQueue', 'readwrite');
  return wrap(store.put({ ...item, status: 'pending', enqueuedAt: new Date().toISOString() }));
}

export async function getPendingSyncItems() {
  return getAll('syncQueue', 'status', 'pending');
}

export async function markSyncDone(id) {
  const store = tx('syncQueue', 'readwrite');
  const item = await wrap(store.get(id));
  if (item) {
    item.status = 'done';
    item.sentAt = new Date().toISOString();
    return wrap(store.put(item));
  }
}

export async function clearDoneSync() {
  const store = tx('syncQueue', 'readwrite');
  const all = await wrap(store.getAll());
  return Promise.all(all.filter(i => i.status === 'done').map(i => wrap(store.delete(i.id))));
}

// ── Statistiques ──────────────────────────────────────────────────────────

export async function getStats() {
  const [releves, photos, syncItems] = await Promise.all([
    getAllReleves(),
    getAllPhotos(),
    getPendingSyncItems(),
  ]);
  return {
    totalReleves: releves.length,
    totalPhotos:  photos.length,
    pendingSync:  syncItems.length,
    urgents:      releves.filter(r => r.cotation === '3U').length,
    drafts:       releves.filter(r => r.status === 'draft').length,
  };
}
