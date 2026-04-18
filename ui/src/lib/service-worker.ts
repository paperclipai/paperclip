type WindowLike = {
  addEventListener: (event: "load", listener: () => void, options?: AddEventListenerOptions) => void;
};

type ServiceWorkerRegistrationLike = {
  unregister: () => Promise<boolean> | boolean;
};

type ServiceWorkerContainerLike = {
  register: (scriptUrl: string) => Promise<unknown>;
  getRegistrations?: () => Promise<readonly ServiceWorkerRegistrationLike[]>;
};

type NavigatorLike = {
  serviceWorker?: ServiceWorkerContainerLike;
};

type CacheStorageLike = {
  keys: () => Promise<readonly string[]>;
  delete: (cacheName: string) => Promise<boolean> | boolean;
};

type BootServiceWorkerOptions = {
  isProduction: boolean;
  windowObject?: WindowLike;
  navigatorObject?: NavigatorLike;
  cacheStorage?: CacheStorageLike;
  onError?: (error: unknown) => void;
};

type CleanupDevServiceWorkerOptions = {
  navigatorObject?: NavigatorLike;
  cacheStorage?: CacheStorageLike;
};

const APP_CACHE_PREFIXES = ["paperclip-", "orchestrero-"];

function isAppCacheName(cacheName: string) {
  return APP_CACHE_PREFIXES.some((prefix) => cacheName.startsWith(prefix));
}

export async function cleanupDevServiceWorkers({
  navigatorObject = typeof navigator !== "undefined" ? (navigator as unknown as NavigatorLike) : undefined,
  cacheStorage = typeof caches !== "undefined" ? (caches as unknown as CacheStorageLike) : undefined,
}: CleanupDevServiceWorkerOptions) {
  const registrations = navigatorObject?.serviceWorker?.getRegistrations
    ? await navigatorObject.serviceWorker.getRegistrations()
    : [];
  let registrationsRemoved = 0;

  for (const registration of registrations) {
    const removed = await registration.unregister();
    if (removed) registrationsRemoved += 1;
  }

  const cacheNames = cacheStorage ? await cacheStorage.keys() : [];
  const cacheNamesDeleted = cacheNames.filter(isAppCacheName);
  await Promise.all(cacheNamesDeleted.map((cacheName) => cacheStorage?.delete(cacheName)));

  return {
    registrationsRemoved,
    cacheNamesDeleted,
  };
}

export async function bootServiceWorker({
  isProduction,
  windowObject = typeof window !== "undefined" ? window : undefined,
  navigatorObject = typeof navigator !== "undefined" ? (navigator as unknown as NavigatorLike) : undefined,
  cacheStorage = typeof caches !== "undefined" ? (caches as unknown as CacheStorageLike) : undefined,
  onError = (error) => console.warn("Service worker bootstrap failed", error),
}: BootServiceWorkerOptions) {
  const serviceWorker = navigatorObject?.serviceWorker;

  if (isProduction) {
    if (!serviceWorker || !windowObject) return;
    windowObject.addEventListener("load", () => {
      void serviceWorker.register("/sw.js").catch(onError);
    }, { once: true });
    return;
  }

  try {
    await cleanupDevServiceWorkers({ navigatorObject, cacheStorage });
  } catch (error) {
    onError(error);
  }
}
