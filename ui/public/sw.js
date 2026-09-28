// The build id is stamped into this file at production build time (see
// stampServiceWorkerBuildId in vite.config.ts), so a deploy that changes only
// the app bundle still changes sw.js byte-for-byte. That is what makes the
// browser install a new worker, which — via skipWaiting + controllerchange —
// reloads parked tabs onto the fresh bundle. Left as the literal placeholder in
// dev, where HMR (not the worker) drives refreshes.
const BUILD_ID = "__PAPERCLIP_BUILD_ID__";
// Separate this allowlisted cache from older workers that cached arbitrary URLs.
const CACHE_NAME = `paperclip-public-assets-${BUILD_ID}`;
const privateRequests = new Set();
const privateCacheControl = /(?:^|,)\s*(?:no-store|private)(?:\s*(?:,|=)|\s*$)/i;

// Static recovery only: never cache or embed authenticated page content here.
function offlineNavigationResponse() {
  return new Response(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><title>Paperclip is offline</title></head>
<body><main><h1>Paperclip is offline</h1>
<p>Check your connection, then reload this page to try again.</p>
<button type="button" onclick="window.location.reload()">Reload page</button>
</main></body></html>`, {
    status: 503,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

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
  // Vite owns development module revalidation and HMR. Passing that graph
  // through an offline worker can forward bodyless 304 responses on reload.
  // Only a stamped production build has an offline-cache contract.
  if (BUILD_ID.startsWith("__")) return;
  const { request } = event;
  const url = new URL(request.url);
  // Only immutable Vite build assets have a public offline-cache contract.
  // Never infer that application/extension responses are public from absent
  // headers, or from an in-memory classification lost when this worker restarts.
  const publicAsset = url.origin === self.location.origin && !url.search &&
    /^\/assets\/[^/]+-[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9.]+$/.test(url.pathname);

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

  // Network-first; only public build assets can use an offline fallback.
  event.respondWith(
    fetch(request)
      .then(async (response) => {
        const cacheControl = response.headers.get("cache-control") ?? "";
        if (privateCacheControl.test(cacheControl)) {
          // Revoke earlier cacheable responses too. Keep an in-memory denylist
          // if storage is unavailable so offline fallback still fails closed.
          privateRequests.add(request.url);
          await evictRequest(request).catch(() => {});
        } else if (response.ok && publicAsset && !privateRequests.has(request.url)) {
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
        if (!publicAsset) return request.mode === "navigate" ? offlineNavigationResponse() : Response.error();
        // Restrict lookup to this policy's cache; old arbitrary-response caches
        // must not become fallback candidates if activation cleanup fails.
        try {
          const cached = await (await caches.open(CACHE_NAME)).match(request);
          if (cached && !privateCacheControl.test(cached.headers.get("cache-control") ?? "")) return cached;
        } catch { /* Unavailable cache storage is an offline miss. */ }
        return Response.error();
      })
  );
});
