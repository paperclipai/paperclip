import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getLoadedBundleId,
  parseBundleIdFromHtml,
  startAppUpdateWatcher,
} from "./app-update-check";

describe("parseBundleIdFromHtml", () => {
  it("extracts the hashed entry bundle from index.html", () => {
    const html = `<!doctype html><html><head>
      <script type="module" crossorigin src="/assets/index-B85r4qUa.js"></script>
      <link rel="stylesheet" href="/assets/index-abc123.css"></head><body></body></html>`;
    expect(parseBundleIdFromHtml(html)).toBe("index-B85r4qUa.js");
  });

  it("returns null when no entry bundle is present", () => {
    expect(parseBundleIdFromHtml("<html><head></head><body></body></html>")).toBeNull();
  });
});

describe("getLoadedBundleId", () => {
  it("reads the bundle filename from a script tag", () => {
    const doc = {
      querySelectorAll: () => [
        { getAttribute: () => "/assets/vendor-x.js" },
        { getAttribute: () => "https://host/assets/index-CB24WRl4.js" },
      ],
    } as unknown as Document;
    expect(getLoadedBundleId(doc)).toBe("index-CB24WRl4.js");
  });
});

describe("startAppUpdateWatcher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires once when the deployed bundle differs, then latches", async () => {
    const onUpdate = vi.fn();
    let deployed = "index-AAA.js";
    const stop = startAppUpdateWatcher({
      currentBundleId: "index-AAA.js",
      onUpdateAvailable: onUpdate,
      intervalMs: 1000,
      getDeployedBundleId: () => Promise.resolve(deployed),
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(onUpdate).not.toHaveBeenCalled(); // same bundle

    deployed = "index-BBB.js";
    await vi.advanceTimersByTimeAsync(1000);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith("index-BBB.js");

    // latched — does not fire again on subsequent polls
    await vi.advanceTimersByTimeAsync(5000);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    stop();
  });

  it("does nothing when the current bundle id is unknown", () => {
    const onUpdate = vi.fn();
    const stop = startAppUpdateWatcher({
      currentBundleId: null,
      onUpdateAvailable: onUpdate,
      intervalMs: 1000,
      getDeployedBundleId: () => Promise.resolve("index-BBB.js"),
    });
    vi.advanceTimersByTime(5000);
    expect(onUpdate).not.toHaveBeenCalled();
    stop();
  });

  it("stop() halts polling", async () => {
    const onUpdate = vi.fn();
    const getter = vi.fn(() => Promise.resolve("index-AAA.js"));
    const stop = startAppUpdateWatcher({
      currentBundleId: "index-AAA.js",
      onUpdateAvailable: onUpdate,
      intervalMs: 1000,
      getDeployedBundleId: getter,
    });
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(getter).not.toHaveBeenCalled();
  });
});
