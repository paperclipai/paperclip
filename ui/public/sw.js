// The build id is stamped into this file at production build time (see
// stampServiceWorkerBuildId in vite.config.ts), so a deploy that changes only
// the app bundle still changes sw.js byte-for-byte. That is what makes the
// browser install a new worker, which — via skipWaiting + controllerchange —
// reloads parked tabs onto the fresh bundle. Left as the literal placeholder in
// dev, where HMR (not the worker) drives refreshes.
const BUILD_ID = "__PAPERCLIP_BUILD_ID__";
const CACHE_NAME = `paperclip-${BUILD_ID}`;

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

  // Skip non-GET requests and API calls
  if (request.method !== "GET" || url.pathname.startsWith("/api")) {
    return;
  }

  // Network-first for everything — cache is only an offline fallback
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && url.origin === self.location.origin) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      .catch(async () => {
        // caches.match() resolves undefined on a miss (and the promise itself
        // is always truthy, so `||` can never supply a fallback). respondWith
        // must always receive a real Response — resolving undefined breaks
        // the navigation with "Failed to convert value to 'Response'" instead
        // of showing anything.
        if (request.mode === "navigate") {
          return (await caches.match("/")) ?? new Response("Offline", { status: 503 });
        }
        return (await caches.match(request)) ?? Response.error();
      })
  );
});
