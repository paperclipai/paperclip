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
    URL, Response, fetch, caches: { keys: async () => ["paperclip-old", "paperclip-current"], open: async () => ({ put, delete: remove }), match },
  });
  const request = (cache: RequestCache = "default") => {
    const respondWith = vi.fn();
    handlers.get("fetch")!({ request: new Request("https://example.test/extension/history", { cache }), respondWith, waitUntil: vi.fn() });
    return respondWith;
  };
  return { request, fetch, put, match, remove };
}

describe("service worker privacy boundaries", () => {
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
    await w.request().mock.calls[0]![0];
    expect(w.put).toHaveBeenCalledOnce();
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
});
