// Bump CACHE when shipped assets change so old caches are deleted on activate.
const CACHE = "fairshare-v69";
const ASSETS = [
  "./",
  "./index.html",
  "./fairshare.css",
  "./manifest.json",
  "./js/money.js",
  "./js/groupnames.js",
  "./js/sync.js",
  "./js/ui.js",
  "./js/receipts.js",
  "./js/firebase.js",
  "./js/vendor/qrcode.js",
  "./icons/favicon-32.png",
  "./icons/apple-touch-icon.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-192.png",
  "./icons/icon-maskable-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))
  )));
  self.clients.claim();
});

function isHtml(request, url) {
  return request.mode === "navigate" || url.pathname.endsWith("/") || url.pathname.endsWith(".html");
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Firebase Auth handlers must always use the network, never the app cache.
  if (url.pathname.startsWith("/__/auth/") || url.pathname.startsWith("/__/firebase/")) return;
  const freshFirst = isHtml(request, url) || url.pathname.endsWith(".js") || url.pathname.endsWith(".css");
  event.respondWith(freshFirst ? networkFirst(request) : cacheFirst(request));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  const url = new URL(request.url);
  const html = request.mode === "navigate" || url.pathname.endsWith("/") || url.pathname.endsWith(".html");
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) {
      cache.put(request, fresh.clone());
      if (html) cache.put("./index.html", fresh.clone());
    }
    return fresh;
  } catch {
    return (await cache.match(request)) || (await cache.match("./index.html")) || Response.error();
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const fresh = await fetch(request);
  if (fresh && fresh.ok) cache.put(request, fresh.clone());
  return fresh;
}
