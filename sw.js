const CACHE = 'notype-v1';
const SHELL = [
  './',
  './index.html?v=1',
  './styles.css?v=1',
  './app.js?v=1',
  './manifest.json?v=1',
  './icon.png?v=1',
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
      .catch(() => caches.match(req).then(hit => hit || caches.match('./index.html?v=1')))
  );
});
