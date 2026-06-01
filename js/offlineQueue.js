// offlineQueue.js - Offline Write Queue + Sync Engine for Acadex
//
// When the user writes data offline:
//   - Operation is stored locally (localStorage)
//   - UI is updated optimistically by the caller
//   - When online, the sync engine replays operations in order
//
// Queue item shape:
// {
//   id        : string,       unique identifier
//   type      : 'CREATE'|'UPDATE'|'DELETE'|'SET',
//   collection: string,       Firestore collection path
//   docId     : string|null,  document ID (null for CREATE)
//   payload   : object,       data to write
//   timestamp : number,       Date.now() when queued
//   retries   : number,       number of sync attempts
//   status    : 'pending'|'processing'|'failed'
// }
//
// All user-facing errors now show clear, friendly messages without technical jargon.

import { db } from './firebase-config.js';
import {
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  addDoc,
  collection,
} from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import * as cache from './cache.js';
import { toast } from './error-handler.js';

// ── Config ───────────────────────────────────────────────────────────────────
const QUEUE_STORAGE_KEY = 'acadex_offline_queue_v1';
const MAX_RETRIES       = 5;
const SYNC_INTERVAL_MS  = 30_000;   // 30 s periodic sync
const BASE_BACKOFF_MS   = 1_000;    // 1 s → doubles each retry

// ── In-memory queue ──────────────────────────────────────────────────────────
let _queue = [];
let _syncTimer     = null;
let _isSyncing     = false;

// ── BroadcastChannel (notify other tabs of queue changes) ────────────────────
let _channel = null;
try {
  _channel = new BroadcastChannel('acadex_queue_sync');
  _channel.onmessage = (ev) => {
    const { type } = ev.data || {};
    if (type === 'QUEUE_CHANGED') _loadFromStorage();
  };
} catch (_) {}

function _broadcast() {
  try { _channel?.postMessage({ type: 'QUEUE_CHANGED' }); } catch (_) {}
}

// ── Unique ID generator ───────────────────────────────────────────────────────
function _uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Persistence ──────────────────────────────────────────────────────────────
function _saveToStorage() {
  try {
    localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(_queue));
  } catch (e) {
    console.warn('[OfflineQueue] Failed to persist queue:', e.message);
    toast.warning('Unable to save offline changes. Your browser storage may be full.');
  }
}

function _loadFromStorage() {
  try {
    const raw = localStorage.getItem(QUEUE_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    _queue = Array.isArray(parsed) ? parsed.filter(op => op.status !== 'failed') : [];
  } catch (e) {
    _queue = [];
    console.warn('[OfflineQueue] Failed to load queue:', e.message);
    toast.warning('Unable to load saved offline operations. Data may be lost.');
  }
}

// ── Restore queue on module load ─────────────────────────────────────────────
_loadFromStorage();
const _pendingCount = _queue.filter(op => op.status === 'pending').length;
if (_pendingCount) console.log(`[OfflineQueue] Loaded ${_pendingCount} pending operations`);

// ── Backoff calculation ───────────────────────────────────────────────────────
function _backoffMs(retries) {
  return Math.min(BASE_BACKOFF_MS * Math.pow(2, retries), 30_000);
}

// ── Execute a single Firestore operation ─────────────────────────────────────
async function _execute(op) {
  const colRef = collection(db, op.collection);
  switch (op.type) {
    case 'CREATE': {
      const newRef = await addDoc(colRef, { ...op.payload, _queueId: op.id });
      return { docId: newRef.id };
    }
    case 'SET': {
      if (!op.docId) throw new Error(`SET requires docId (op ${op.id})`);
      await setDoc(doc(db, op.collection, op.docId), op.payload, { merge: op.merge !== false });
      return { docId: op.docId };
    }
    case 'UPDATE': {
      if (!op.docId) throw new Error(`UPDATE requires docId (op ${op.id})`);
      await updateDoc(doc(db, op.collection, op.docId), op.payload);
      return { docId: op.docId };
    }
    case 'DELETE': {
      if (!op.docId) throw new Error(`DELETE requires docId (op ${op.id})`);
      await deleteDoc(doc(db, op.collection, op.docId));
      return { docId: op.docId };
    }
    default:
      throw new Error(`Unknown operation type: ${op.type}`);
  }
}

// ── Sync a single operation ───────────────────────────────────────────────────
async function _syncOp(op) {
  op.status = 'processing';
  _saveToStorage();
  try {
    const result = await _execute(op);
    // Success — remove from queue
    _queue = _queue.filter(q => q.id !== op.id);
    _saveToStorage();
    _broadcast();
    // Invalidate related cache entries
    cache.invalidateByTag(op.collection);
    if (op.docId) cache.del(`${op.collection}:${op.docId}`);
    if (result.docId && result.docId !== op.docId) {
      cache.del(`${op.collection}:${result.docId}`);
    }
    console.log(`[OfflineQueue] Synced op ${op.id} (${op.type} ${op.collection}/${op.docId || '*'})`);
    return true;
  } catch (err) {
    op.retries = (op.retries || 0) + 1;
    if (op.retries >= MAX_RETRIES) {
      op.status = 'failed';
      op.failedAt = Date.now();
      op.lastError = err.message;
      console.error(`[OfflineQueue] Op ${op.id} permanently failed after ${MAX_RETRIES} retries:`, err.message);
      toast.warning(`Unable to sync "${op.collection}" changes. Please check your internet connection and permissions.`);
    } else {
      op.status = 'pending';
      op.nextRetryAt = Date.now() + _backoffMs(op.retries);
      console.warn(`[OfflineQueue] Op ${op.id} retry ${op.retries}/${MAX_RETRIES} in ${_backoffMs(op.retries)}ms`);
    }
    _saveToStorage();
    _broadcast();
    return false;
  }
}

// ── Main sync loop ────────────────────────────────────────────────────────────
async function _runSync() {
  if (_isSyncing || !navigator.onLine) return;
  _loadFromStorage();   // reload in case another tab modified it

  const pending = _queue.filter(
    op => op.status === 'pending' && (!op.nextRetryAt || Date.now() >= op.nextRetryAt)
  );
  if (!pending.length) return;

  _isSyncing = true;
  console.log(`[OfflineQueue] Syncing ${pending.length} pending operation(s)…`);
  let synced = 0;
  for (const op of pending) {
    if (!navigator.onLine) break;   // stop if we went offline mid-sync
    const ok = await _syncOp(op);
    if (ok) synced++;
  }
  _isSyncing = false;
  if (synced) console.log(`[OfflineQueue] Sync complete — ${synced}/${pending.length} operations applied`);
}

// ── Periodic sync ─────────────────────────────────────────────────────────────
function _startPeriodicSync() {
  if (_syncTimer) return;
  _syncTimer = setInterval(_runSync, SYNC_INTERVAL_MS);
}

function _stopPeriodicSync() {
  clearInterval(_syncTimer);
  _syncTimer = null;
}

// ── Network event listeners ──────────────────────────────────────────────────
window.addEventListener('online',  () => {
  console.log('[OfflineQueue] Network online — triggering sync');
  _runSync();
});
window.addEventListener('offline', () => console.log('[OfflineQueue] Network offline'));

// Start periodic sync immediately
_startPeriodicSync();

// ── Initial sync attempt on load ─────────────────────────────────────────────
if (navigator.onLine) setTimeout(_runSync, 2_000);


// ════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ════════════════════════════════════════════════════════════════════════════

/**
 * Add an operation to the offline queue.
 * @param {Object} opSpec  { type, collection, docId?, payload, merge? }
 * @returns {string}  the generated operation ID
 */
export function enqueue(opSpec) {
  const op = {
    id         : _uid(),
    type       : opSpec.type,               // 'CREATE'|'SET'|'UPDATE'|'DELETE'
    collection : opSpec.collection,
    docId      : opSpec.docId  || null,
    payload    : opSpec.payload || {},
    merge      : opSpec.merge  !== false,   // default true for SET
    timestamp  : Date.now(),
    retries    : 0,
    status     : 'pending',
    nextRetryAt: null,
  };
  _queue.push(op);
  _saveToStorage();
  _broadcast();
  console.log(`[OfflineQueue] Queued op ${op.id} (${op.type} ${op.collection}/${op.docId || 'new'})`);
  return op.id;
}

/**
 * Manually trigger a sync attempt.
 * Returns a promise that resolves when the sync pass completes.
 */
export async function sync() {
  return _runSync();
}

/**
 * Return all operations currently in the queue.
 * @returns {Object[]}
 */
export function getQueue() {
  _loadFromStorage();
  return [..._queue];
}

/**
 * Return only pending operations.
 * @returns {Object[]}
 */
export function getPending() {
  return _queue.filter(op => op.status === 'pending');
}

/**
 * Return permanently failed operations.
 * @returns {Object[]}
 */
export function getFailed() {
  return _queue.filter(op => op.status === 'failed');
}

/**
 * Clear all failed operations from the queue.
 */
export function clearFailed() {
  _queue = _queue.filter(op => op.status !== 'failed');
  _saveToStorage();
  _broadcast();
}

/**
 * Retry a specific failed operation by ID.
 * @param {string} opId
 */
export function retryOp(opId) {
  const op = _queue.find(o => o.id === opId);
  if (op && op.status === 'failed') {
    op.status  = 'pending';
    op.retries = 0;
    op.nextRetryAt = null;
    _saveToStorage();
    if (navigator.onLine) _runSync();
  }
}

/**
 * Number of pending (unsynced) operations.
 * @returns {number}
 */
export function pendingCount() {
  return _queue.filter(op => op.status === 'pending').length;
}

export default { enqueue, sync, getQueue, getPending, getFailed, clearFailed, retryOp, pendingCount };