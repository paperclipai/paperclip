import { afterEach, describe, expect, it, vi } from "vitest";
import { createChunkLoadRecovery, isChunkLoadError, RELOAD_ABANDONED_MS } from "./chunk-load-recovery";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

const cssPreloadError = new Error(
  "Unable to preload CSS for https://paperclip.example/assets/issue-detail-CIbQo9zW.css",
);

function preloadErrorEvent(payload: unknown) {
  return Object.assign(new Event("vite:preloadError", { cancelable: true }), { payload });
}

describe("isChunkLoadError", () => {
  it("matches Vite CSS preload and browser dynamic import failures", () => {
    expect(isChunkLoadError(cssPreloadError)).toBe(true);
    expect(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: https://paperclip.example/assets/a.js"))).toBe(true);
    expect(isChunkLoadError(new TypeError("error loading dynamically imported module: https://paperclip.example/assets/a.js"))).toBe(true);
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true);
  });

  it("ignores ordinary render errors and non-errors", () => {
    expect(isChunkLoadError(new Error("Maximum update depth exceeded"))).toBe(false);
    expect(isChunkLoadError(new Error("Request failed: Unable to preload CSS for x"))).toBe(false);
    expect(isChunkLoadError("Unable to preload CSS for x")).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});

describe("reloadForChunkLoadError", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reloads once and treats later failures in the same document as that reload", () => {
    const reload = vi.fn();
    const { reloadForChunkLoadError } = createChunkLoadRecovery({ storage: () => memoryStorage(), reload });

    expect(reloadForChunkLoadError(cssPreloadError)).toBe(true);
    expect(reloadForChunkLoadError(cssPreloadError)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("defers to the error UI when the fresh page fails again", () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    let now = 1_000_000;
    createChunkLoadRecovery({ storage: () => storage, reload, now: () => now }).reloadForChunkLoadError(cssPreloadError);

    now += 10_000;
    const freshPage = createChunkLoadRecovery({ storage: () => storage, reload, now: () => now });
    expect(freshPage.reloadForChunkLoadError(cssPreloadError)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("notifies waiting callers and stops claiming the failure when the reload is cancelled", () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const reload = vi.fn();
    const { reloadForChunkLoadError, onChunkLoadReloadAbandoned } = createChunkLoadRecovery({
      storage: () => storage,
      reload,
    });
    expect(reloadForChunkLoadError(cssPreloadError)).toBe(true);
    const abandoned = vi.fn();
    const stopped = vi.fn();
    onChunkLoadReloadAbandoned(abandoned);
    onChunkLoadReloadAbandoned(stopped)();

    vi.advanceTimersByTime(RELOAD_ABANDONED_MS - 1);
    expect(abandoned).not.toHaveBeenCalled();
    expect(reloadForChunkLoadError(cssPreloadError)).toBe(true);

    vi.advanceTimersByTime(1);
    expect(abandoned).toHaveBeenCalledTimes(1);
    expect(stopped).not.toHaveBeenCalled();
    expect(reloadForChunkLoadError(cssPreloadError)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);

    const late = vi.fn();
    onChunkLoadReloadAbandoned(late);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("recovers again after the guard window, such as after a later deploy", () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    let now = 1_000_000;
    createChunkLoadRecovery({ storage: () => storage, reload, now: () => now }).reloadForChunkLoadError(cssPreloadError);

    now += 5 * 60 * 1000;
    const laterPage = createChunkLoadRecovery({ storage: () => storage, reload, now: () => now });
    expect(laterPage.reloadForChunkLoadError(cssPreloadError)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("ignores an unreadable stored marker", () => {
    const reload = vi.fn();
    const storage = memoryStorage({ "paperclip:chunk-load-reload-at": "not-a-time" });
    const { reloadForChunkLoadError } = createChunkLoadRecovery({ storage: () => storage, reload, now: () => 1_000 });
    expect(reloadForChunkLoadError(cssPreloadError)).toBe(true);
  });

  it("never reloads for other errors", () => {
    const reload = vi.fn();
    const { reloadForChunkLoadError } = createChunkLoadRecovery({ storage: () => memoryStorage(), reload });
    expect(reloadForChunkLoadError(new Error("boom"))).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("never reloads without a working loop guard", () => {
    const reload = vi.fn();
    expect(createChunkLoadRecovery({ storage: () => null, reload }).reloadForChunkLoadError(cssPreloadError)).toBe(false);
    const throwing = {
      getItem: () => { throw new Error("SecurityError"); },
      setItem: () => { throw new Error("SecurityError"); },
    };
    expect(createChunkLoadRecovery({ storage: () => throwing, reload }).reloadForChunkLoadError(cssPreloadError)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("startChunkLoadRecovery", () => {
  it("reloads for a Vite preload failure without cancelling the rejection", () => {
    const target = new EventTarget();
    const reload = vi.fn();
    const { startChunkLoadRecovery } = createChunkLoadRecovery({ storage: () => memoryStorage(), reload });
    const stop = startChunkLoadRecovery(target as unknown as Window);

    const event = preloadErrorEvent(cssPreloadError);
    target.dispatchEvent(event);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);

    stop();
    target.dispatchEvent(preloadErrorEvent(cssPreloadError));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("ignores preload events without a chunk load error", () => {
    const target = new EventTarget();
    const reload = vi.fn();
    const { startChunkLoadRecovery } = createChunkLoadRecovery({ storage: () => memoryStorage(), reload });
    startChunkLoadRecovery(target as unknown as Window);
    target.dispatchEvent(preloadErrorEvent(undefined));
    target.dispatchEvent(preloadErrorEvent(new Error("boom")));
    expect(reload).not.toHaveBeenCalled();
  });
});
