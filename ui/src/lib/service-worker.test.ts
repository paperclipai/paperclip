import { describe, expect, it, vi } from "vitest";
import { bootServiceWorker, cleanupDevServiceWorkers } from "./service-worker";

describe("bootServiceWorker", () => {
  it("registers the service worker on window load in production", async () => {
    const register = vi.fn().mockResolvedValue(undefined);
    const captured: { loadListener?: () => void } = {};
    const addEventListener = vi.fn((event: string, listener: () => void) => {
      if (event === "load") captured.loadListener = listener;
    });

    await bootServiceWorker({
      isProduction: true,
      windowObject: { addEventListener },
      navigatorObject: {
        serviceWorker: {
          register,
        },
      },
    });

    expect(register).not.toHaveBeenCalled();
    expect(addEventListener).toHaveBeenCalledWith("load", expect.any(Function), { once: true });

    const loadListener = captured.loadListener;
    expect(loadListener).toBeTypeOf("function");
    if (typeof loadListener !== "function") throw new Error("Expected load listener");
    loadListener();
    await Promise.resolve();

    expect(register).toHaveBeenCalledWith("/sw.js");
  });

  it("cleans up stale app service workers immediately in development", async () => {
    const unregister = vi.fn().mockResolvedValue(true);
    const getRegistrations = vi.fn().mockResolvedValue([{ unregister }]);
    const deleteCache = vi.fn().mockResolvedValue(true);

    await bootServiceWorker({
      isProduction: false,
      navigatorObject: {
        serviceWorker: {
          register: vi.fn(),
          getRegistrations,
        },
      },
      cacheStorage: {
        keys: vi.fn().mockResolvedValue(["paperclip-v2", "unrelated-cache"]),
        delete: deleteCache,
      },
    });

    expect(getRegistrations).toHaveBeenCalledTimes(1);
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(deleteCache).toHaveBeenCalledWith("paperclip-v2");
    expect(deleteCache).not.toHaveBeenCalledWith("unrelated-cache");
  });
});

describe("cleanupDevServiceWorkers", () => {
  it("ignores browsers without app registrations or caches", async () => {
    await expect(
      cleanupDevServiceWorkers({
        navigatorObject: {
          serviceWorker: {
            register: vi.fn(),
            getRegistrations: vi.fn().mockResolvedValue([]),
          },
        },
        cacheStorage: {
          keys: vi.fn().mockResolvedValue(["third-party-cache"]),
          delete: vi.fn(),
        },
      }),
    ).resolves.toEqual({
      cacheNamesDeleted: [],
      registrationsRemoved: 0,
    });
  });
});
