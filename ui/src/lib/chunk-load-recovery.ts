const RELOAD_AT_KEY = "paperclip:chunk-load-reload-at";
const RELOAD_GUARD_MS = 5 * 60 * 1000;
export const RELOAD_ABANDONED_MS = 10_000;

const CHUNK_LOAD_ERROR_PATTERNS = [
  /^Unable to preload CSS for /,
  /^Failed to fetch dynamically imported module/,
  /^error loading dynamically imported module/,
  /^Importing a module script failed/,
];

export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return CHUNK_LOAD_ERROR_PATTERNS.some((pattern) => pattern.test(error.message));
}

type ReloadStorage = Pick<Storage, "getItem" | "setItem">;

type ChunkLoadRecoveryOptions = {
  storage?: () => ReloadStorage | null;
  reload?: () => void;
  now?: () => number;
};

function browserSessionStorage(): ReloadStorage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function createChunkLoadRecovery(options: ChunkLoadRecoveryOptions = {}) {
  const readStorage = options.storage ?? browserSessionStorage;
  const reload = options.reload ?? (() => window.location.reload());
  const now = options.now ?? Date.now;
  let reloading = false;
  const abandonedListeners = new Set<() => void>();

  function abandonReload() {
    reloading = false;
    const listeners = [...abandonedListeners];
    abandonedListeners.clear();
    for (const listener of listeners) listener();
  }

  function reloadForChunkLoadError(error: unknown): boolean {
    if (!isChunkLoadError(error)) return false;
    if (reloading) return true;
    const storage = readStorage();
    if (!storage) return false;
    const at = now();
    try {
      const lastReloadAt = Number(storage.getItem(RELOAD_AT_KEY));
      if (Number.isFinite(lastReloadAt) && lastReloadAt > 0 && at - lastReloadAt < RELOAD_GUARD_MS) {
        return false;
      }
      storage.setItem(RELOAD_AT_KEY, String(at));
    } catch {
      return false;
    }
    reloading = true;
    reload();
    globalThis.setTimeout(abandonReload, RELOAD_ABANDONED_MS);
    return true;
  }

  function onChunkLoadReloadAbandoned(listener: () => void): () => void {
    if (!reloading) {
      listener();
      return () => {};
    }
    abandonedListeners.add(listener);
    return () => {
      abandonedListeners.delete(listener);
    };
  }

  function startChunkLoadRecovery(target: Pick<Window, "addEventListener" | "removeEventListener"> = window) {
    const onPreloadError = (event: Event) => {
      reloadForChunkLoadError((event as Event & { payload?: unknown }).payload);
    };
    target.addEventListener("vite:preloadError", onPreloadError);
    return () => target.removeEventListener("vite:preloadError", onPreloadError);
  }

  return { reloadForChunkLoadError, onChunkLoadReloadAbandoned, startChunkLoadRecovery };
}

const browserRecovery = createChunkLoadRecovery();

export const reloadForChunkLoadError = browserRecovery.reloadForChunkLoadError;
export const onChunkLoadReloadAbandoned = browserRecovery.onChunkLoadReloadAbandoned;
export const startChunkLoadRecovery = browserRecovery.startChunkLoadRecovery;
