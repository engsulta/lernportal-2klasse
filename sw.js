/* Service Worker – macht das Lernportal installierbar und offline-fähig.
   Strategie: „network-first" – online immer die frische Version, nur wenn
   offline wird die zuletzt gespeicherte Kopie genutzt. So gibt es keine
   veralteten Stände nach einem Update. Firestore & fremde Hosts werden nie
   angefasst (die Cloud-Sync braucht immer echtes Netz). */
const CACHE = "lernportal-v1";
const PRECACHE = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "shared/styles.css",
  "shared/config.js",
  "shared/cloud.js",
  "topics/uhrzeit/index.html",
  "topics/verben-nomen/index.html",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png"
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  // Nur eigene GET-Anfragen behandeln; Firestore/andere Hosts unberührt lassen
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then(r => r || caches.match("./")))
  );
});
