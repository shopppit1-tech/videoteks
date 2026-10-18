const CACHE = 'videoteks-shell-v50';
const BASE_URL = new URL('./', self.location.href);
const HOME_URL = new URL('index.html', BASE_URL).href;
const SHELL_FILES = [
  '',
  'index.html',
  'privacy.html',
  'terms.html',
  'delete-account.html',
  'login.js',
  'login.js?v=restore-popup-1',
  'pwa-install.js',
  'firebase-client.js',
  'firebase-client.js?v=restore-popup-1',
  'page-navigation.js',
  'studio.html',
  'studio.js',
  'download-utils.js',
  'images/hero-studio-phone.webp',
  'app.html',
  'app.js',
  'audio.html',
  'audio.js',
  'voice.html',
  'voice.js',
  'youtube.html',
  'youtube.js',
  'youtube.js?v=seo-video-content-1',
  'youtube-handoff.js',
  'history.html',
  'history.js',
  'auth-shell.css',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png'
].map((path) => new URL(path, BASE_URL).href);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // Keep query parameters for app behavior, but use the cached HTML shell by pathname.
  const cacheKey = event.request.mode === 'navigate'
    ? (() => {
        const page = new URL(event.request.url);
        page.search = '';
        page.hash = '';
        return page.href;
      })()
    : event.request;

  const update = fetch(event.request).then(async (response) => {
    if (response.ok && response.type === 'basic') {
      const cache = await caches.open(CACHE);
      await cache.put(cacheKey, response.clone());
    }
    return response;
  });

  // Return the cached page/assets immediately and refresh the cache in the background.
  event.waitUntil(update.then(() => undefined).catch(() => undefined));
  event.respondWith(
    caches.match(cacheKey).then((cached) => cached || update.catch(() => caches.match(HOME_URL)))
  );
});
