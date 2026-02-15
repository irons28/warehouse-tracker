const CACHE = "wt-cache-v2";
const ASSETS = ["/", "/index.html", "/styles.css", "/app.js"];
const NETWORK_FIRST_PATHS = new Set(["/", "/index.html", "/styles.css", "/app.js"]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.map((k) => (k === CACHE ? null : caches.delete(k))))
      )
      .then(() => self.clients.claim())
  );
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await fetch(req, { cache: "no-store" });
    if (fresh && fresh.ok) {
      cache.put(req, fresh.clone());
    }
    return fresh;
  } catch {
    const cached = await cache.match(req);
    if (cached) return cached;
    throw new Error("Network and cache both unavailable");
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  const fresh = await fetch(req);
  if (fresh && fresh.ok) {
    cache.put(req, fresh.clone());
  }
  return fresh;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // API should always prefer live data
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }

  // For app shell and critical assets, always try network first.
  const isNavigation = req.mode === "navigate";
  const isCriticalAsset = NETWORK_FIRST_PATHS.has(url.pathname);
  if (isNavigation || isCriticalAsset) {
    event.respondWith(networkFirst(req));
    return;
  }

  // Other static assets can be cache-first.
  event.respondWith(cacheFirst(req));
});
