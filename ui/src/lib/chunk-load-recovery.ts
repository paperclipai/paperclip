const RELOAD_AT_KEY = "paperclip:chunk-load-reload-at";
const RELOAD_GUARD_MS = 5 * 60 * 1000;
export const RELOAD_ABANDONED_MS = 10_000;
// During a deploy, old and new servers can both answer for a few seconds, so a
// freshly reloaded page can still miss a chunk. Each retry in the guard window
// waits longer for the rollout to settle; after the last one the error shows.
export const RELOAD_DELAYS_MS = [0, 2_000, 5_000];

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

type ReloadMarker = { windowStartedAt: number; attempts: number };

function isPositiveTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function readReloadMarker(raw: string | null): ReloadMarker | null {
  if (!raw) return null;
  // Tabs loaded before retries existed stored the bare reload time.
  const legacyAt = Number(raw);
  if (isPositiveTime(legacyAt)) return { windowStartedAt: legacyAt, attempts: 1 };
  try {
    const parsed = JSON.parse(raw) as Partial<ReloadMarker> | null;
    if (!parsed || !isPositiveTime(parsed.windowStartedAt)) return null;
    const attempts = Number.isInteger(parsed.attempts) && parsed.attempts! > 0 ? parsed.attempts! : 1;
    return { windowStartedAt: parsed.windowStartedAt, attempts };
  } catch {
    return null;
  }
}

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
  // A reload that never left this document (cancelled, blocked or stalled)
  // is not retried from the same document.
  let reloadAbandoned = false;
  const abandonedListeners = new Set<() => void>();

  function abandonReload() {
    reloading = false;
    reloadAbandoned = true;
    const listeners = [...abandonedListeners];
    abandonedListeners.clear();
    for (const listener of listeners) listener();
  }

  function reloadForChunkLoadError(error: unknown): boolean {
    if (!isChunkLoadError(error)) return false;
    if (reloading) return true;
    if (reloadAbandoned) return false;
    const storage = readStorage();
    if (!storage) return false;
    const at = now();
    let delayMs: number;
    try {
      const previous = readReloadMarker(storage.getItem(RELOAD_AT_KEY));
      const inWindow = previous !== null && at - previous.windowStartedAt < RELOAD_GUARD_MS;
      const attempt = inWindow ? previous.attempts : 0;
      if (attempt >= RELOAD_DELAYS_MS.length) return false;
      delayMs = RELOAD_DELAYS_MS[attempt]!;
      const marker: ReloadMarker = { windowStartedAt: inWindow ? previous.windowStartedAt : at, attempts: attempt + 1 };
      storage.setItem(RELOAD_AT_KEY, JSON.stringify(marker));
    } catch {
      return false;
    }
    reloading = true;
    if (delayMs > 0) globalThis.setTimeout(reload, delayMs);
    else reload();
    globalThis.setTimeout(abandonReload, delayMs + RELOAD_ABANDONED_MS);
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
