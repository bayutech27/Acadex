// sw.js – self-destructing service worker
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Delete all caches
      const keys = await caches.keys();
      await Promise.all(keys.map(key => caches.delete(key)));
      // Unregister itself
      await self.registration.unregister();
    })()
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Do not handle any requests – just pass through to network
  event.respondWith(fetch(event.request));
});