// sw.js - Service Worker
const CACHE_NAME = 'fuel-tracker-v2';
const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './manifest.json',
    './app.js',
    './vendor/tailwind.js',
    './vendor/chart.js',
    './vendor/xlsx.full.min.js',
    './vendor/fontawesome/css/all.min.css'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
            );
        })
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    event.respondWith(
        caches.match(event.request).then((cachedResponse) => {
            return cachedResponse || fetch(event.request);
        })
    );
});
