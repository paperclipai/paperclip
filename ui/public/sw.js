const CACHE_NAME = "paperclip-v3";
const PRECACHE_URLS = ["/", "/index.html"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.pathname.startsWith("/api")) {
    return;
  }
  if (url.origin !== self.location.origin) {
    return;
  }

  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
      }
      return response;
    } catch {
      if (request.mode === "navigate") {
        const shell = await caches.match("/index.html") || await caches.match("/");
        if (shell) return shell;
        return new Response(
          "<!doctype html><meta charset=utf-8><title>Offline</title><h1>Offline</h1>",
          { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      }
      const cached = await caches.match(request);
      if (cached) return cached;
      return new Response("", { status: 504, statusText: "SW offline fallback" });
    }
  })());
});
