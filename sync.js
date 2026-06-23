/**
 * InspectOA — Module de synchronisation
 * Gère l'envoi différé des relevés et photos vers le back-end
 * Fonctionne en mode offline-first : enqueue local, sync quand réseau disponible
 */

import { getPendingSyncItems, markSyncDone, enqueueSync } from './db.js';

// URL de base de l'API — à remplacer par votre back-end réel
// En développement : 'http://localhost:3000/api'
// En production   : 'https://votre-api.com/api'
const API_BASE = window.INSPECTOA_API_BASE || null; // null = mode hors ligne pur

// ── Enregistrement en file d'attente ──────────────────────────────────────

export async function queueReleve(releve) {
  await enqueueSync({ type: 'releve', payload: releve });
}

export async function queuePhoto(photo) {
  // On n'enqueue que les métadonnées + id — la photo base64 est déjà en IndexedDB
  const { data: _omit, ...meta } = photo; // Exclure le base64 brut de la queue (trop lourd)
  await enqueueSync({ type: 'photo', payload: { ...meta, hasData: true } });
}

// ── Tentative de synchronisation ──────────────────────────────────────────

export async function trySyncAll(db, onProgress = () => {}) {
  if (!API_BASE) {
    return { synced: 0, failed: 0, offline: true };
  }

  if (!navigator.onLine) {
    return { synced: 0, failed: 0, offline: true };
  }

  const items = await getPendingSyncItems();
  if (!items.length) return { synced: 0, failed: 0, offline: false };

  let synced = 0, failed = 0;

  for (const item of items) {
    try {
      onProgress(item.type, synced, items.length);
      await sendItem(item, db);
      await markSyncDone(item.id);
      synced++;
    } catch (e) {
      console.warn('Sync failed for item', item.id, e);
      failed++;
    }
  }

  return { synced, failed, offline: false };
}

async function sendItem(item, db) {
  const headers = {
    'Content-Type': 'application/json',
    'X-InspectOA-Version': '4',
  };

  // Ajouter le token d'auth si disponible
  const token = localStorage.getItem('oa_token');
  if (token) headers['Authorization'] = 'Bearer ' + token;

  if (item.type === 'releve') {
    const res = await fetch(`${API_BASE}/releves`, {
      method:  'POST',
      headers,
      body:    JSON.stringify(item.payload),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
  }

  if (item.type === 'photo') {
    // Récupère le base64 depuis IndexedDB pour l'envoi
    const photo = await db.getPhoto(item.payload.id);
    if (!photo) return; // Photo supprimée localement, skip

    const res = await fetch(`${API_BASE}/photos`, {
      method:  'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body:    JSON.stringify(photo),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
  }
}

// ── Authentification ──────────────────────────────────────────────────────

export async function login(email, password) {
  if (!API_BASE) throw new Error('API non configurée');
  const res = await fetch(`${API_BASE}/auth/login`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error('Identifiants incorrects');
  const { token, user } = await res.json();
  localStorage.setItem('oa_token', token);
  localStorage.setItem('oa_user', JSON.stringify(user));
  return user;
}

export function getLocalUser() {
  try { return JSON.parse(localStorage.getItem('oa_user')); } catch { return null; }
}

export function logout() {
  localStorage.removeItem('oa_token');
  localStorage.removeItem('oa_user');
}

// ── Listener réseau ───────────────────────────────────────────────────────

export function watchNetwork(onOnline, onOffline) {
  window.addEventListener('online',  onOnline);
  window.addEventListener('offline', onOffline);
  return () => {
    window.removeEventListener('online',  onOnline);
    window.removeEventListener('offline', onOffline);
  };
}
