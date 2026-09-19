// The build id is stamped into this file at production build time (see
// stampServiceWorkerBuildId in vite.config.ts), so a deploy that changes only
// the app bundle still changes sw.js byte-for-byte. That is what makes the
// browser install a new worker, which — via skipWaiting + controllerchange —
// reloads parked tabs onto the fresh bundle. Left as the literal placeholder in
// dev, where HMR (not the worker) drives refreshes.
const BUILD_ID = "__PAPERCLIP_BUILD_ID__";
const CACHE_NAME = `paperclip-${BUILD_ID}`;
const privateRequests = new Set();
const privateCacheControl = /(?:^|,)\s*(?:no-store|private)(?:\s*(?:,|=)|\s*$)/i;

async function evictRequest(request) {
  await Promise.all((await caches.keys()).map(async (key) => {
    const cache = await caches.open(key);
    await cache.delete(request, { ignoreVary: true });
  }));
}

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Explicitly private requests must bypass BOTH cache writes and offline
  // fallback, including extension endpoints outside the host /api namespace.
  if (request.method !== "GET" || url.pathname.startsWith("/api")) {
    return;
  }
  if (request.cache === "no-store") {
    privateRequests.add(request.url);
    event.waitUntil(evictRequest(request).catch(() => {}));
    return;
  }

  // Network-first for everything — cache is only an offline fallback
  event.respondWith(
    fetch(request)
      .then(async (response) => {
        const cacheControl = response.headers.get("cache-control") ?? "";
        if (privateCacheControl.test(cacheControl)) {
          // Revoke earlier cacheable responses too. Keep an in-memory denylist
          // if storage is unavailable so offline fallback still fails closed.
          privateRequests.add(request.url);
          await evictRequest(request).catch(() => {});
        } else if (response.ok && url.origin === self.location.origin && !privateRequests.has(request.url)) {
          const clone = response.clone();
          await caches.open(CACHE_NAME).then(async (cache) => {
            await cache.put(request, clone);
            // A concurrent response may have revoked this URL during put().
            if (privateRequests.has(request.url)) await cache.delete(request, { ignoreVary: true });
          }).catch(() => {});
        }
        return response;
      })
      .catch(async () => {
        if (privateRequests.has(request.url)) return Response.error();
        // caches.match() resolves undefined on a miss (and the promise itself
        // is always truthy, so `||` can never supply a fallback). respondWith
        // must always receive a real Response — resolving undefined breaks
        // the navigation with "Failed to convert value to 'Response'" instead
        // of showing anything.
        if (request.mode === "navigate") {
          if (privateRequests.has(new URL("/", self.location.origin).href)) return new Response("Offline", { status: 503 });
          return (await caches.match("/")) ?? new Response("Offline", { status: 503 });
        }
        return (await caches.match(request)) ?? Response.error();
      })
  );
});
