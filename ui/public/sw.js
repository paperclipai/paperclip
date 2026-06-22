const CACHE_NAME = "paperclip-v2";

self.addEventListener("install", () => {
  self.skipWaiting();
});

// --- Web Push (TON-2312) ---------------------------------------------------

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Paperclip", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "Paperclip";
  const options = {
    body: data.body || "",
    icon: "/android-chrome-192x192.png",
    badge: "/favicon-32x32.png",
    // Coalesce repeat notifications for the same entity.
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
    data: { url: data.url || "/" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      // Focus an existing tab and navigate it, if one is open.
      for (const client of clientList) {
        if ("focus" in client) {
          client.focus();
          if ("navigate" in client && targetUrl !== "/") {
            client.navigate(targetUrl).catch(() => {});
          }
          return undefined;
        }
      }
      // Otherwise open a new window.
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
      return undefined;
    })
  );
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
      .catch(() => {
        if (request.mode === "navigate") {
          return caches.match("/") || new Response("Offline", { status: 503 });
        }
        return caches.match(request);
      })
  );
});
