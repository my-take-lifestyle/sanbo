// Service Worker — オフラインキャッシュ（cache-first）
// バージョンを上げると旧キャッシュは activate 時に削除される
const CACHE = 'sanbo-v5';

const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  './sample-data.json',
  './css/style.css',
  './docs/guide.html',
  './js/app.js',
  './js/state.js',
  './js/ulid.js',
  './js/derive.js',
  './js/api.js',
  './js/ui.js',
  './js/prompts.js',
  './js/parse.js',
  './js/feed.js',
  './js/backup.js',
  './js/views/dashboard.js',
  './js/views/portfolio.js',
  './js/views/themes.js',
  './js/views/intel.js',
  './js/views/journal.js',
  './js/views/models.js',
  './js/views/settings.js',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // CDN が落ちていてもインストール自体は成功させる
      Promise.allSettled(ASSETS.map((a) => cache.add(a)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 価格・為替 API・自動収集フィードはキャッシュしない（常にネットワーク。失敗はアプリ側でフォールバック）
  if (url.hostname.includes('frankfurter') || url.hostname.includes('finnhub')) return;
  if (url.origin === location.origin && url.pathname.endsWith('/data/feed.json')) return;

  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req)
        .then((res) => {
          if (res.ok && (url.origin === location.origin || url.hostname === 'cdn.jsdelivr.net')) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => {
          if (req.mode === 'navigate') return caches.match('./index.html');
          return Response.error();
        });
    })
  );
});
