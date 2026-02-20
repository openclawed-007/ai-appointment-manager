const STATIC_CACHE = 'intellischedule-static-v3';
const RUNTIME_CACHE = 'intellischedule-runtime-v2';

const APP_SHELL = [
  '/',
  '/index.html',
  '/booking.html',
  '/styles.css',
  '/app.js',
  '/booking.js',
  '/favicon.ico',
  '/favicon.svg',
  '/manifest.webmanifest',
  '/css/base.css',
  '/css/content.css',
  '/css/forms.css',
  '/css/header.css',
  '/css/menus.css',
  '/css/pages.css',
  '/css/responsive.css',
  '/css/sidebar.css',
  '/css/theme-light.css'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== STATIC_CACHE && key !== RUNTIME_CACHE)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(() =>
        new Response(JSON.stringify({ error: 'Offline' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(async () => {
          const pageFallback = url.pathname.startsWith('/book') ? '/booking.html' : '/index.html';
          return (await caches.match(request)) || (await caches.match(pageFallback)) || (await caches.match('/index.html'));
        })
    );
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy));
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (url.pathname === '/favicon.ico') {
          return (await caches.match('/favicon.ico')) || new Response('', { status: 204 });
        }
        return new Response('', { status: 503 });
      })
  );
});
