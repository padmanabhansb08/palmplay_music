/* PalmPlay service worker — offline app shell (streaming stays network-only) */
const CACHE_NAME = 'palmplay-shell-v3';

const PRECACHE = [
    './home.html',
    './explore.html',
    './style.css',
    './palmplay-ux.css',
    './lib/routes.js',
    './lib/pwa.js',
    './manifest.webmanifest',
    './assets/gallery/p1.png',
    './app.js',
    './palmplay-ux.js',
    './lib/palmplay-sync.js',
    './lib/palmplay-auth.js',
    './lib/curated-trending.js',
    './env-config.js',
    './catalog-config.js',
    './supabase-config.js'
];

function isAudioOrApi(url) {
    if (url.pathname.includes('/api/')) return true;
    if (url.hostname.includes('saavn') || url.hostname.includes('sumit')) return true;
    if (url.pathname.includes('/stream')) return true;
    if (url.searchParams.has('app_name') && url.pathname.includes('/v1/')) return true;
    return false;
}

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)).catch((err) => {
            console.warn('PalmPlay SW precache partial fail', err);
        })
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
            )
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;

    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) return;
    if (isAudioOrApi(url)) return;
    if (event.request.destination === 'audio' || event.request.destination === 'video') return;

    event.respondWith(
        caches.match(event.request).then((cached) => {
            const networkFetch = fetch(event.request)
                .then((response) => {
                    if (response && response.status === 200 && response.type === 'basic') {
                        const copy = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
                    }
                    return response;
                })
                .catch(() => cached);

            return cached || networkFetch;
        })
    );
});
