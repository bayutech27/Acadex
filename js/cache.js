// cache.js - Memory + Local Persistence Layer for Acadex
// Responsibilities: in-memory cache, localStorage persistence, TTL expiration,
// tag-based invalidation, offline fallback, multi-tab sync via BroadcastChannel.

const CACHE_STORAGE_KEY = 'acadex_cache_v1';
const DEFAULT_TTL       = 5 * 60 * 1000;   // 5 minutes
const PERSIST_DEBOUNCE  = 300;              // ms – avoid hammering localStorage

// ── In-memory store ──────────────────────────────────────────────────────────
const _mem = new Map();

// ── Debounced persist handle ─────────────────────────────────────────────────
let _persistTimer = null;

// ── BroadcastChannel for cross-tab sync ─────────────────────────────────────
let _channel = null;
try {
  _channel = new BroadcastChannel('acadex_cache_sync');
  _channel.onmessage = (ev) => {
    const { type, key, entry } = ev.data || {};
    if      (type === 'SET'   && key && entry) { _mem.set(key, entry); }
    else if (type === 'DEL'   && key)          { _mem.delete(key); }
    else if (type === 'CLEAR')                  { _mem.clear(); }
    else if (type === 'TAG'   && key)          { _evictByTag(key, false); }
  };
} catch (_) { /* BroadcastChannel unavailable (some private-mode browsers) */ }

function _broadcast(msg) {
  try { _channel?.postMessage(msg); } catch (_) {}
}

// ── Internal helpers ─────────────────────────────────────────────────────────
function _isExpired(entry) {
  if (!entry) return true;
  if (entry.expiresAt === Infinity) return false;
  return Date.now() > entry.expiresAt;
}

function _schedulePersist() {
  clearTimeout(_persistTimer);
  _persistTimer = setTimeout(_writeToStorage, PERSIST_DEBOUNCE);
}

function _writeToStorage() {
  try {
    const out = {};
    for (const [k, v] of _mem.entries()) {
      if (!_isExpired(v)) out[k] = v;
    }
    localStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify(out));
  } catch (e) {
    console.warn('[Cache] localStorage write failed:', e.message);
  }
}

function _evictByTag(tag, broadcast = true) {
  for (const [k, entry] of _mem.entries()) {
    if (entry.tags?.includes(tag)) _mem.delete(k);
  }
  _schedulePersist();
  if (broadcast) _broadcast({ type: 'TAG', key: tag });
}

// ── Restore from localStorage on module load ─────────────────────────────────
(function _restore() {
  try {
    const raw = localStorage.getItem(CACHE_STORAGE_KEY);
    if (!raw) return;
    const stored = JSON.parse(raw);
    let count = 0;
    for (const [k, v] of Object.entries(stored)) {
      if (!_isExpired(v)) { _mem.set(k, v); count++; }
    }
    if (count) console.log(`[Cache] Restored ${count} entries from localStorage`);
  } catch (e) {
    console.warn('[Cache] Failed to restore cache:', e.message);
  }
})();

// ── Periodic cleanup ─────────────────────────────────────────────────────────
setInterval(() => {
  let removed = 0;
  for (const [k, v] of _mem.entries()) {
    if (_isExpired(v)) { _mem.delete(k); removed++; }
  }
  if (removed) _schedulePersist();
}, 10 * 60 * 1000);   // every 10 min


// ════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ════════════════════════════════════════════════════════════════════════════

/**
 * Get a cached value.
 * Returns null if missing or expired.
 * @param {string} key
 * @returns {*|null}
 */
export function get(key) {
  const entry = _mem.get(key);
  if (!entry) return null;
  if (_isExpired(entry)) { _mem.delete(key); return null; }
  return entry.value;
}

/**
 * Store a value in the cache.
 * @param {string}   key
 * @param {*}        value
 * @param {Object}   opts  { ttl?: number (ms, default 5 min), tags?: string[] }
 */
export function set(key, value, opts = {}) {
  const ttl = (opts.ttl !== undefined) ? opts.ttl : DEFAULT_TTL;
  const tags = Array.isArray(opts.tags) ? opts.tags : [];
  const entry = {
    value,
    tags,
    createdAt : Date.now(),
    expiresAt : (ttl === Infinity) ? Infinity : Date.now() + ttl,
  };
  _mem.set(key, entry);
  _schedulePersist();
  _broadcast({ type: 'SET', key, entry });
}

/**
 * Check whether a valid (non-expired) entry exists.
 * @param {string} key
 * @returns {boolean}
 */
export function has(key) {
  return get(key) !== null;
}

/**
 * Remove a specific key.
 * @param {string} key
 */
export function del(key) {
  _mem.delete(key);
  _schedulePersist();
  _broadcast({ type: 'DEL', key });
}

/**
 * Clear the entire cache (memory + storage).
 */
export function clear() {
  _mem.clear();
  try { localStorage.removeItem(CACHE_STORAGE_KEY); } catch (_) {}
  _broadcast({ type: 'CLEAR' });
}

/**
 * Invalidate all entries carrying a specific tag.
 * @param {string} tag
 */
export function invalidateByTag(tag) {
  _evictByTag(tag, true);
}

/**
 * Return cached value, or call fetchFn to get fresh data and cache it.
 * @param {string}   key
 * @param {Function} fetchFn  async () => value
 * @param {Object}   opts     cache options (ttl, tags)
 * @returns {Promise<*>}
 */
export async function getFreshOrCached(key, fetchFn, opts = {}) {
  const cached = get(key);
  if (cached !== null) return cached;
  const fresh = await fetchFn();
  if (fresh !== null && fresh !== undefined) set(key, fresh, opts);
  return fresh;
}

/**
 * Manually evict expired entries and re-persist.
 * @returns {number} number of entries removed
 */
export function cleanup() {
  let removed = 0;
  for (const [k, v] of _mem.entries()) {
    if (_isExpired(v)) { _mem.delete(k); removed++; }
  }
  if (removed) _writeToStorage();
  return removed;
}

/**
 * Return a snapshot of current cache stats (useful for debugging).
 */
export function stats() {
  let valid = 0, expired = 0;
  for (const [, v] of _mem.entries()) {
    _isExpired(v) ? expired++ : valid++;
  }
  return { total: _mem.size, valid, expired };
}

export default { get, set, has, del, clear, invalidateByTag, getFreshOrCached, cleanup, stats };