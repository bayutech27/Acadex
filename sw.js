// sw.js - Acadex Service Worker for Offline Navigation
const CACHE_NAME = 'acadex-v1';  // Increment this version when you deploy updates

// List of static assets to cache for offline use
const urlsToCache = [
  '/',
  '/index.html',
  '/admin/admin-dashboard.html',
  '/admin/students.html',
  '/admin/teachers.html',
  '/admin/setup.html',
  '/admin/results.html',
  '/admin/teacher-attendance.html',
  '/teacher/teacher-dashboard.html',
  '/teacher/attendance.html',
  '/teacher/scores.html',
  '/teacher/class.html',
  '/student/student-portal.html',
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
  // Add favicon if any
  // '/favicon.ico',
];

// Install event – cache static assets
self.addEventListener('install', event => {
  console.log('[SW] Install event');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW] Caching static assets');
        return cache.addAll(urlsToCache);
      })
      .catch(err => console.error('[SW] Cache addAll failed', err))
  );
  // Force waiting service worker to become active immediately
  self.skipWaiting();
});

// Activate event – clean up old caches
self.addEventListener('activate', event => {
  console.log('[SW] Activate event');
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
  // Take control of all clients immediately
  return self.clients.claim();
});

// Fetch event – network‑first for HTML pages (to get updates), cache‑first for static assets
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);

  // Skip cross-origin requests (like Firebase)
  if (url.origin !== location.origin) return;

  // For HTML pages (including navigation requests), try network first, fallback to cache
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          // Cache the latest version for offline fallback
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(request, responseClone);
          });
          return response;
        })
        .catch(() => {
          return caches.match(request)
            .then(cached => cached || caches.match('/index.html'));
        })
    );
    return;
  }

  // For static assets (CSS, JS, images), use cache‑first, then network
  event.respondWith(
    caches.match(request)
      .then(cachedResponse => {
        if (cachedResponse) {
          return cachedResponse;
        }
        // Not in cache – fetch from network and cache for next time
        return fetch(request).then(response => {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(request, responseClone);
          });
          return response;
        });
      })
      .catch(() => {
        // If offline and nothing in cache, return a basic offline page
        if (request.mode === 'navigate') {
          return caches.match('/index.html');
        }
        return new Response('Offline – resource not cached', { status: 404 });
      })
  );
});