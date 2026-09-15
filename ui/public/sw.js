const CACHE_NAME = "paperclip-v3";
const RESPONDER_SHELL = ["/", "/responder"];

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
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
          return caches.match(request)
            .then((cached) => cached ?? caches.match("/"))
            .then((cached) => cached ?? new Response("Offline", { status: 503 }));
        }
        return caches.match(request).then((r) => r ?? new Response("", { status: 503 }));
      })
  );
});

// ── Web Push: show notification when a new incident is dispatched ─────────────

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "New Incident", body: event.data.text() };
  }

  const title = payload.title ?? "New Incident Dispatched";
  const options = {
    body: payload.body ?? "Tap to view incident details",
    icon: "/android-chrome-192x192.png",
    badge: "/favicon-32x32.png",
    tag: payload.incidentId ?? "incident",
    renotify: true,
    requireInteraction: true,
    data: { url: payload.url ?? "/responder" },
    actions: [
      { action: "acknowledge", title: "Acknowledge" },
      { action: "dismiss", title: "Dismiss" },
    ],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const targetUrl = event.notification.data?.url ?? "/responder";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          client.postMessage({ type: "notification.click", url: targetUrl, action: event.action });
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
