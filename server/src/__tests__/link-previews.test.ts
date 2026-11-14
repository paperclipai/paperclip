import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLinkPreviewService, type LinkPreviewProvider } from "../services/link-previews.js";

const scope = { companyId: "company-a", userId: "alice" };
const url = "https://github.com/acme/web/pull/42";
const unavailable = { preview: null, maxAgeMs: 60_000 };
const provider = (resolve = vi.fn(async () => unavailable)): LinkPreviewProvider => ({ key: "github", resolve });
afterEach(() => vi.useRealTimers());

describe("demand-driven link preview cache", () => {
  it("does no work until requested and coalesces equivalent URLs", async () => {
    const resolve = vi.fn(async () => unavailable);
    const service = createLinkPreviewService([provider(resolve)]);
    expect(resolve).not.toHaveBeenCalled();
    await Promise.all([
      service.get(scope, url), service.get(scope, "https://www.github.com/ACME/Web/pull/42/files?x=1#review"),
      service.get(scope, url),
    ]);
    expect(resolve).toHaveBeenCalledTimes(1);
    await service.get(scope, url);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
  it("separates viewers, companies, and resources", async () => {
    const resolve = vi.fn(async () => unavailable);
    const service = createLinkPreviewService([provider(resolve)]);
    await service.get(scope, url);
    await service.get({ ...scope, userId: "bob" }, url);
    await service.get({ ...scope, companyId: "company-b" }, url);
    await service.get(scope, `${url}1`);
    expect(resolve).toHaveBeenCalledTimes(4);
  });
  it("caches failures, then refreshes only on a new request after expiry", async () => {
    let now = 0;
    const resolve = vi.fn(async () => { throw new Error("no access"); });
    const service = createLinkPreviewService([provider(resolve)], { now: () => now });
    expect(await service.get(scope, url)).toEqual(unavailable);
    now = 30_000;
    expect((await service.get(scope, url)).maxAgeMs).toBe(30_000);
    now = 61_000;
    expect(resolve).toHaveBeenCalledTimes(1);
    await service.get(scope, url);
    expect(resolve).toHaveBeenCalledTimes(2);
  });
  it("bounds cached resources and does not resolve unsupported hosts", async () => {
    const resolve = vi.fn(async () => unavailable);
    const service = createLinkPreviewService([provider(resolve)], { maxEntries: 2 });
    await service.get(scope, "https://localhost/private");
    expect(resolve).not.toHaveBeenCalled();
    for (const suffix of ["", "1", "2", ""]) await service.get(scope, url + suffix);
    expect(resolve).toHaveBeenCalledTimes(4);
  });
  it("holds timed-out underlying work inside the concurrency limit", async () => {
    vi.useFakeTimers();
    let finish!: (value: typeof unavailable) => void;
    const resolve = vi.fn(() => new Promise<typeof unavailable>(done => { finish = done; }));
    const service = createLinkPreviewService([provider(resolve)], { timeoutMs: 20, maxConcurrent: 1 });
    const first = service.get(scope, url);
    await vi.advanceTimersByTimeAsync(21);
    expect(await first).toEqual(unavailable);
    await service.get(scope, url + "1");
    expect(resolve).toHaveBeenCalledTimes(1);
    finish(unavailable);
    await vi.advanceTimersByTimeAsync(1);
    const next = service.get(scope, url + "1");
    await vi.advanceTimersByTimeAsync(21);
    await next;
    expect(resolve).toHaveBeenCalledTimes(2);
    finish(unavailable);
  });
  it("refreshes an expired timeout while the earlier operation ignores cancellation", async () => {
    vi.useFakeTimers();
    let finish!: (value: typeof unavailable) => void;
    const resolve = vi.fn(async () => unavailable).mockImplementationOnce(
      () => new Promise<typeof unavailable>(done => { finish = done; }),
    );
    const service = createLinkPreviewService([provider(resolve)], { timeoutMs: 20, maxConcurrent: 2 });
    const first = service.get(scope, url);
    await vi.advanceTimersByTimeAsync(21);
    expect(await first).toEqual(unavailable);
    await service.get(scope, url);
    expect(resolve).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_001);
    await service.get(scope, url);
    expect(resolve).toHaveBeenCalledTimes(2);
    finish(unavailable);
  });
  it("aborts a real stalled HTTP read while an unrelated lookup remains responsive", async () => {
    const server = createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write("{"); });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as { port: number };
    let aborted = false;
    const service = createLinkPreviewService([{ key: "github", resolve: async (target, _scope, signal) => {
      if (target.canonicalUrl.endsWith("/421")) return unavailable;
      try {
        const response = await fetch(`http://127.0.0.1:${address.port}`, { signal });
        await response.json();
      } catch { aborted = signal.aborted; }
      return unavailable;
    } }], { timeoutMs: 100 });
    try {
      const slow = service.get(scope, url);
      expect(await service.get(scope, url + "1")).toEqual(unavailable);
      await slow;
      await vi.waitFor(() => expect(aborted).toBe(true));
    } finally {
      server.closeAllConnections();
      await new Promise<void>(done => server.close(() => done()));
    }
  });
});
