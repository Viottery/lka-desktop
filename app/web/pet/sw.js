/* Offline shell for the hosted entry: the cloud may be down while nodes are up.
   Only static assets are cached. API responses, credentials and grants never are. */
'use strict';
var CACHE = 'lka-shell-20261024-cluster';
var SHELL = ['./connect.html', './connect.css?v=20261024-cluster', './connect.js?v=20261024-cluster', './assets/ursus-student-emblem.png', './manifest.webmanifest'];

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE).then(function (cache) { return cache.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (key) { return key.indexOf('lka-shell-') === 0 && key !== CACHE; }).map(function (key) { return caches.delete(key); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (event) {
  var request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  var scope = new URL('./', self.location.href).pathname;
  if (url.pathname.indexOf(scope) !== 0) return;
  // Network first so updates land immediately; the cache only covers outages.
  event.respondWith(fetch(request).then(function (response) {
    if (response.ok && SHELL.some(function (path) { return new URL(path, self.location.href).pathname === url.pathname; })) {
      var copy = response.clone();
      caches.open(CACHE).then(function (cache) { cache.put(request, copy); });
    }
    return response;
  }).catch(function () {
    return caches.match(request, { ignoreSearch: url.pathname.endsWith('connect.html') }).then(function (cached) {
      return cached || (request.mode === 'navigate' ? caches.match('./connect.html') : Response.error());
    });
  }));
});
