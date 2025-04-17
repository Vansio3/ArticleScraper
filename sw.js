// sw.js - Basic Caching Service Worker

const CACHE_NAME = 'article-extractor-cache-v1'; // Change version if you update assets
const urlsToCache = [
  '/ArticleScraper/', // Cache the main page (relative to origin)
  '/ArticleScraper/index.html', // Explicitly cache index.html
  '/ArticleScraper/readability.js', // Cache local JS file
  // Add paths to your icons if desired (relative to origin)
  '/ArticleScraper/icons/android-chrome-192x192.png',
  '/ArticleScraper/icons/android-chrome-512x512.png',
  '/ArticleScraper/icons/favicon-32x32.png',
  '/ArticleScraper/icons/favicon-16x16.png',
  '/ArticleScraper/icons/apple-touch-icon.png',
  // Note: Caching CDN resources (like Pico.css) requires more complex strategies
  //       to handle updates and potential CORS issues. We'll skip it for this basic setup.
];

// Install event: cache core assets
self.addEventListener('install', (event) => {
  console.log('[Service Worker] Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[Service Worker] Opened cache:', CACHE_NAME);
        return cache.addAll(urlsToCache);
      })
      .then(() => {
        console.log('[Service Worker] Core assets cached successfully.');
        return self.skipWaiting(); // Activate worker immediately
      })
      .catch(error => {
         console.error('[Service Worker] Failed to cache core assets:', error);
      })
  );
});

// Activate event: clean up old caches if necessary
self.addEventListener('activate', (event) => {
  console.log('[Service Worker] Activating...');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('[Service Worker] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
        console.log('[Service Worker] Claiming clients...');
        return self.clients.claim(); // Take control of open pages immediately
    })
  );
});

// Fetch event: serve cached assets first, then network (Cache-first strategy)
self.addEventListener('fetch', (event) => {
  // Only handle GET requests
  if (event.request.method !== 'GET') {
    return;
  }

  event.respondWith(
    caches.match(event.request)
      .then((response) => {
        // Cache hit - return response
        if (response) {
          // console.log('[Service Worker] Serving from cache:', event.request.url);
          return response;
        }

        // Not in cache - fetch from network
        // console.log('[Service Worker] Fetching from network:', event.request.url);
        return fetch(event.request).then(
          (networkResponse) => {
            // Check if we received a valid response
            if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
              // Don't cache non-basic responses (like from CORS proxies)
              return networkResponse;
            }

            // IMPORTANT: Clone the response. A response is a stream
            // and because we want the browser to consume the response
            // as well as the cache consuming the response, we need
            // to clone it so we have two streams.
            const responseToCache = networkResponse.clone();

            caches.open(CACHE_NAME)
              .then((cache) => {
                // console.log('[Service Worker] Caching new resource:', event.request.url);
                cache.put(event.request, responseToCache);
              });

            return networkResponse;
          }
        ).catch(error => {
            console.error('[Service Worker] Fetch failed:', error);
            // Optional: Return a custom offline page here if desired
            // return caches.match('/offline.html');
        });
      })
    );
});