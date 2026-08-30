const CACHE_NAME = "paperclip-v2";

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

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const href = event.notification.data && typeof event.notification.data.href === "string"
    ? event.notification.data.href
    : "/";
  const destination = new URL(href, self.location.origin);
  if (destination.origin !== self.location.origin) return;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
      const existingClient = clients.find((client) => new URL(client.url).origin === self.location.origin);
      if (existingClient) {
        if (existingClient.url !== destination.href && "navigate" in existingClient) {
          await existingClient.navigate(destination.href);
        }
        return existingClient.focus();
      }
      return self.clients.openWindow(destination.href);
    }),
  );
});
