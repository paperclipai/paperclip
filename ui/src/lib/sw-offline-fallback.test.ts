import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { embedServiceWorkerOfflineAnimation, embedServiceWorkerOfflineStyles } from "./vite-sw-build-id";

const uiRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

type FetchListener = (event: {
  request: { method: string; url: string; mode: string };
  respondWith: (response: Promise<Response | undefined> | Response) => void;
}) => void;

function loadServiceWorkerFetchListener(overrides: {
  fetch: () => Promise<Response>;
  cachesMatch: (key: unknown) => Promise<Response | undefined>;
}): FetchListener {
  const listeners = new Map<string, (event: unknown) => void>();
  const swSelf = {
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.set(type, listener);
    },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn() },
    location: { origin: "https://app.example.com" },
  };
  const caches = {
    match: overrides.cachesMatch,
    open: vi.fn(async () => ({ put: vi.fn() })),
    keys: vi.fn(async () => []),
    delete: vi.fn(async () => true),
  };
  // Offline fallback belongs to a stamped production build. Development
  // leaves Vite requests to the browser instead of intercepting them.
  const code = embedServiceWorkerOfflineAnimation(embedServiceWorkerOfflineStyles(
    readFileSync(resolve(uiRoot, "public/sw.js"), "utf8"),
    readFileSync(resolve(uiRoot, "src/index.css"), "utf8"),
  ), readFileSync(resolve(uiRoot, "src/assets/offline-character.webm")))
    .replace("__PAPERCLIP_BUILD_ID__", "fixture-production");
  new Function("self", "caches", "fetch", "Response", "URL", code)(
    swSelf,
    caches,
    overrides.fetch,
    Response,
    URL,
  );
  const listener = listeners.get("fetch");
  if (!listener) throw new Error("sw.js registered no fetch listener");
  return listener as FetchListener;
}

async function respondTo(
  listener: FetchListener,
  request: { method: string; url: string; mode: string },
): Promise<Response | undefined> {
  let captured: Promise<Response | undefined> | Response | undefined;
  listener({
    request,
    respondWith: (response) => {
      captured = response;
    },
  });
  return await captured;
}

async function loadOfflinePlayback({
  reducedMotion = false,
  play = async () => {},
}: { reducedMotion?: boolean; play?: () => Promise<void> } = {}) {
  const listener = loadServiceWorkerFetchListener({
    fetch: () => Promise.reject(new TypeError("network down")),
    cachesMatch: async () => undefined,
  });
  const response = await respondTo(listener, {
    method: "GET", url: "https://app.example.com/settings/instance", mode: "navigate",
  });
  const script = (await response!.text()).match(/<script>([\s\S]*?)<\/script>/)![1];
  const events = new Map<string, () => void>();
  const video = {
    src: "", pause: vi.fn(), play: vi.fn(play),
    hasAttribute: () => Boolean(video.src),
    addEventListener: (name: string, handler: () => void) => events.set(name, handler),
  };
  const classList = { add: vi.fn(), remove: vi.fn() };
  const motion = {
    matches: reducedMotion,
    addEventListener: (_name: string, handler: () => void) => events.set("motion", handler),
  };
  new Function("document", "window", script)(
    { querySelector: () => ({ classList, querySelector: () => video }) },
    { matchMedia: () => motion },
  );
  return { video, classList, motion, events };
}

describe("sw.js offline fallback", () => {
  it("keeps the still for reduced motion and starts playback when the preference changes", async () => {
    const { video, classList, motion, events } = await loadOfflinePlayback({ reducedMotion: true });
    expect(video.src).toBe("");
    expect(video.play).not.toHaveBeenCalled();
    motion.matches = false;
    events.get("motion")!();
    expect(video.src).toMatch(/^data:video\/webm;base64,/);
    expect(video.play).toHaveBeenCalledOnce();
    events.get("playing")!();
    expect(classList.add).toHaveBeenCalledWith("is-playing");
    motion.matches = true;
    events.get("motion")!();
    expect(video.pause).toHaveBeenCalledTimes(2);
    expect(classList.remove).toHaveBeenLastCalledWith("is-playing");
  });

  it("keeps the still when the browser rejects playback", async () => {
    const { video, classList } = await loadOfflinePlayback({
      play: async () => { throw new Error("autoplay blocked"); },
    });
    expect(video.play).toHaveBeenCalledOnce();
    expect(classList.add).not.toHaveBeenCalled();
    expect(classList.remove).toHaveBeenCalledExactlyOnceWith("is-playing");
  });

  it("restores the still when media fails after playback starts", async () => {
    const { classList, events } = await loadOfflinePlayback();
    events.get("playing")!();
    expect(classList.add).toHaveBeenCalledWith("is-playing");
    expect(classList.remove).not.toHaveBeenCalled();
    events.get("error")!();
    expect(classList.remove).toHaveBeenCalledExactlyOnceWith("is-playing");
  });

  it("serves an uncached retry page for a failed navigation with an empty cache", async () => {
    const listener = loadServiceWorkerFetchListener({
      fetch: () => Promise.reject(new TypeError("network down")),
      cachesMatch: async () => undefined,
    });

    const response = await respondTo(listener, {
      method: "GET",
      url: "https://app.example.com/settings/instance",
      mode: "navigate",
    });

    // respondWith must always receive a real Response; resolving undefined
    // fails the navigation with "Failed to convert value to 'Response'".
    expect(response).toBeInstanceOf(Response);
    expect(response!.status).toBe(503);
    expect(response!.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response!.headers.get("cache-control")).toBe("no-store");
    const body = await response!.text();
    expect(body).toContain("Paperclip is offline");
    expect(body).toContain("Reload page");
    expect(body).toContain("<style>");
    expect(body).toContain(".paperclip-offline");
    expect(body).toContain("<svg");
    expect(body).toContain("data:video/webm;base64,");
    expect(body).toContain("loop muted playsinline");
    expect(body).not.toMatch(/__PAPERCLIP_|<link|\bsrc=/);
    expect(body).not.toContain("<html>app shell</html>");
  });

  it("does not replay a legacy cached shell for a failed navigation", async () => {
    const shell = new Response("<html>app shell</html>", { status: 200 });
    const listener = loadServiceWorkerFetchListener({
      fetch: () => Promise.reject(new TypeError("network down")),
      cachesMatch: async (key) => (key === "/" ? shell : undefined),
    });

    const response = await respondTo(listener, {
      method: "GET",
      url: "https://app.example.com/settings/instance",
      mode: "navigate",
    });

    expect(response!.status).toBe(503);
    expect(response!.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response!.headers.get("cache-control")).toBe("no-store");
    const body = await response!.text();
    expect(body).toContain("Paperclip is offline");
    expect(body).toContain("Reload page");
    expect(body).not.toContain("<html>app shell</html>");
  });

  it("returns a network-error Response for a failed asset with no cache entry", async () => {
    const listener = loadServiceWorkerFetchListener({
      fetch: () => Promise.reject(new TypeError("network down")),
      cachesMatch: async () => undefined,
    });

    const response = await respondTo(listener, {
      method: "GET",
      url: "https://app.example.com/assets/index-abc.js",
      mode: "no-cors",
    });

    expect(response).toBeInstanceOf(Response);
    expect(response!.type).toBe("error");
  });
});
