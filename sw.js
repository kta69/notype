const CACHE = 'notype-v2';
const SHELL = [
  './',
  './index.html?v=2',
  './styles.css?v=2',
  './app.js?v=2',
  './manifest.json?v=2',
  './icon.png?v=2',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // API へのリクエストは絶対にキャッシュしない
  if (url.origin !== location.origin) return;

  // ネット優先・失敗したらキャッシュ（更新がすぐ届く）
  e.respondWith(
    fetch(req)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || caches.match('./index.html?v=2')))
  );
});
