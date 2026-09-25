// @vitest-environment node
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

function worker() {
  const handlers = new Map<string, (event: unknown) => void>();
  const put = vi.fn();
  const match = vi.fn();
  const remove = vi.fn().mockResolvedValue(true);
  const fetch = vi.fn().mockResolvedValue(new Response("public asset"));
  vm.runInNewContext(readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8"), {
    self: { location: { origin: "https://example.test" }, addEventListener: (type: string, fn: (event: unknown) => void) => handlers.set(type, fn) },
    URL, Response, fetch, caches: { keys: async () => ["paperclip-old", "paperclip-current"], open: async () => ({ put, delete: remove, match }), match },
  });
  const request = (cache: RequestCache = "default", pathname = "/extension/history") => {
    const respondWith = vi.fn();
    handlers.get("fetch")!({ request: new Request(`https://example.test${pathname}`, { cache }), respondWith, waitUntil: vi.fn() });
    return respondWith;
  };
  return { request, fetch, put, match, remove };
}

describe("service worker privacy boundaries", () => {
  it.each([
    "/@fs/tmp/runner/vite-cache/deps/@assistant-ui_react.js?v=fixture",
    "/@vite/client", "/@id/__x00__virtual:module", "/src/main.tsx", "/node_modules/.vite/deps/react.js",
  ])("leaves conditional Vite module request %s to the browser", pathname => {
    const w = worker();
    w.fetch.mockResolvedValue(new Response(null, { status: 304 }));
    expect(w.request("default", pathname)).not.toHaveBeenCalled();
    expect(w.fetch).not.toHaveBeenCalled();
    expect(w.put).not.toHaveBeenCalled();
    expect(w.match).not.toHaveBeenCalled();
  });
  it("bypasses both caching and offline fallback for a no-store request outside /api", () => {
    const w = worker();
    expect(w.request("no-store")).not.toHaveBeenCalled();
    expect(w.fetch).not.toHaveBeenCalled();
    expect(w.match).not.toHaveBeenCalled();
    expect(w.put).not.toHaveBeenCalled();
  });
  it.each(["no-store", "max-age=0, no-store", "private", 'private="Set-Cookie"', "PRIVATE, max-age=60"])("never caches a response marked %s", async directive => {
    const w = worker();
    w.fetch.mockResolvedValue(new Response("personal content", { headers: { "cache-control": directive } }));
    const response = await w.request().mock.calls[0]![0];
    expect(await response.text()).toBe("personal content");
    expect(w.put).not.toHaveBeenCalled();
  });
  it("keeps public asset offline caching", async () => {
    const w = worker();
    await w.request("default", "/assets/index-AbCd1234.js").mock.calls[0]![0];
    expect(w.put).toHaveBeenCalledOnce();
    w.fetch.mockRejectedValue(new Error("offline"));
    w.match.mockResolvedValue(new Response("cached build asset"));
    expect(await (await w.request("default", "/assets/index-AbCd1234.js").mock.calls[0]![0]).text()).toBe("cached build asset");
  });
  it.each(["private", "no-store"])("evicts stale entries when a response becomes %s and blocks offline reuse", async directive => {
    const w = worker();
    w.match.mockResolvedValue(new Response("stale personal content"));
    w.fetch.mockResolvedValue(new Response("fresh", { headers: { "cache-control": directive } }));
    await w.request().mock.calls[0]![0];
    expect(w.remove).toHaveBeenCalledTimes(2);
    expect(w.remove).toHaveBeenCalledWith(expect.any(Request), { ignoreVary: true });
    w.fetch.mockRejectedValue(new Error("offline"));
    const offline = await w.request().mock.calls[0]![0];
    expect(offline.type).toBe("error"); expect(w.match).not.toHaveBeenCalled();
  });
  it("does not serve stale data when cache eviction itself fails", async () => {
    const w = worker(); w.remove.mockRejectedValue(new Error("cache unavailable"));
    w.fetch.mockResolvedValue(new Response("fresh", { headers: { "cache-control": "private" } }));
    expect(await (await w.request().mock.calls[0]![0]).text()).toBe("fresh");
    w.fetch.mockRejectedValue(new Error("offline"));
    expect((await w.request().mock.calls[0]![0]).type).toBe("error");
    expect(w.match).not.toHaveBeenCalled();
  });

  it.each(["/extension/history", "/extensions/support/messages", "/", "/assets/avatar.png", "/assets/index-AbCd1234.js?user=1"])("never caches or falls back to uncertain resource %s after a worker restart", async pathname => {
    const previous = worker();
    previous.remove.mockRejectedValue(new Error("storage unavailable"));
    previous.fetch.mockResolvedValue(new Response("personal content", { headers: { "cache-control": "private" } }));
    await previous.request("default", pathname).mock.calls[0]![0];
    const restarted = worker();
    restarted.match.mockResolvedValue(new Response("stale personal content"));
    await restarted.request("default", pathname).mock.calls[0]![0];
    expect(restarted.put).not.toHaveBeenCalled();
    restarted.fetch.mockRejectedValue(new Error("offline"));
    expect((await restarted.request("default", pathname).mock.calls[0]![0]).type).toBe("error");
    expect(restarted.match).not.toHaveBeenCalled();
  });

  it("rejects a cached asset explicitly marked private even after restart", async () => {
    const w = worker();
    w.match.mockResolvedValue(new Response("personal content", { headers: { "cache-control": "private" } }));
    w.fetch.mockRejectedValue(new Error("offline"));
    expect((await w.request("default", "/assets/index-AbCd1234.js").mock.calls[0]![0]).type).toBe("error");
  });
});
