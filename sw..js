// sw.js - Acadex Service Worker with 5-minute expiration
const CACHE_NAME = 'acadex-v2';   // bumped to force a fresh install
const EXPIRATION_MS = 5 * 60 * 1000;  // 5 minutes

const urlsToCache = [
  '/',
  '/index.html',
  '/admin/admin-dashboard.html',
  '/admin/students.html',
  '/admin/teachers.html',
  '/admin/setup.html',
  '/admin/results.html',
  '/admin/teacher-attendance.html',
  '/admin/school-finance.html',
  '/teacher/teacher-dashboard.html',
  '/teacher/attendance.html',
  '/teacher/scores.html',
  '/teacher/class.html',
  '/student/student-portal.html',
  '/parent/parent-portal.html',
  '/cbt/html/cbt.html',
  '/cbt/html/test.html',
  '/cbt/html/cbt-admin.html',
  '/css/styles.css',
  '/js/firebase-config.js',
  '/js/service.js',
  '/js/cache.js',
  '/js/offlineQueue.js',
  '/js/academic-calendar.js',
  '/js/calendar-sync.js',
  '/js/admin.js',
  '/js/error-handler.js',
  '/js/menu.js',
  'js/parent-portal.js',
  'js/finance.js',
  '/js/notification-service.js',
  '/js/plan.js',
  '/js/reportCardRenderer.js',
  '/js/students.js',
  '/js/subjects.js',
  '/js/classes.js',
  '/js/teachers.js',
  '/js/teacher-dashboard.js',
  '/js/teacher-clock.js',
  '/js/teacher-attendance.js',
  '/js/scores.js',
  '/js/results.js',
  '/js/app.js',
  '/js/auth.js',
  '/student/student-portal.js',
  '/cbt/js/cbt.js',
  '/cbt/js/test.js',
  '/cbt/js/cbt-admin.js',
];

// ---------- INSTALL ----------
self.addEventListener('install', event => {
  console.log('[SW] Install');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW] Caching static assets');
        return cache.addAll(urlsToCache);
      })
      .catch(err => console.error('[SW] Cache addAll failed', err))
  );
  self.skipWaiting();
});

// ---------- ACTIVATE ----------
self.addEventListener('activate', event => {
  console.log('[SW] Activate');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.filter(name => name !== CACHE_NAME)
          .map(name => {
            console.log('[SW] Deleting old cache', name);
            return caches.delete(name);
          })
      );
    })
  );
  return self.clients.claim();
});

// ---------- FETCH ----------
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);

  // Skip cross-origin requests (like Firebase)
  if (url.origin !== location.origin) return;

  // --- HTML pages (navigations) – always network first, bypass HTTP cache ---
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request, { cache: 'no-cache' })
        .then(response => {
          // Cache the latest version for offline fallback
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
          return response;
        })
        .catch(() => {
          // Offline: try cached copy
          return caches.match(request)
            .then(cached => cached || caches.match('/index.html'));
        })
    );
    return;
  }

  // --- Static assets (CSS, JS, images, etc.) – cache with 5‑minute expiration ---
  event.respondWith(
    caches.match(request).then(cachedResponse => {
      if (cachedResponse) {
        // Check expiration using the Date header of the cached response
        const dateHeader = cachedResponse.headers.get('date');
        if (dateHeader) {
          const cachedDate = new Date(dateHeader).getTime();
          if (Date.now() - cachedDate < EXPIRATION_MS) {
            // Still fresh – serve from cache
            return cachedResponse;
          }
        }
        // Expired (or no date) – fall through to network
      }

      // Not in cache, or expired → try network
      return fetch(request).then(networkResponse => {
        // Cache the fresh response for future use
        const clone = networkResponse.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        return networkResponse;
      }).catch(() => {
        // Network failed – serve the expired cached version if available
        return cachedResponse || new Response('Offline', { status: 503 });
      });
    })
  );
});