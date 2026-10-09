import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { ApiUnavailableError } from "@/api/response";
import { createConnectivityStore, probeServerHealth, type ConnectivityStore, type ProbeResult } from "./connectivity";

const outage = new ApiError("Paperclip is restarting", 503, { error: "tenant_app_unavailable" });
const down: ProbeResult = { reachable: false, retryAfterMs: null };
const up: ProbeResult = { reachable: true };

describe("connectivity store", () => {
  let probe: ReturnType<typeof vi.fn<() => Promise<ProbeResult>>>;
  let store: ConnectivityStore;

  beforeEach(() => {
    vi.useFakeTimers();
    probe = vi.fn<() => Promise<ProbeResult>>().mockResolvedValue(down);
    store = createConnectivityStore({ probe, browserOnline: true });
  });

  afterEach(() => {
    store.dispose();
    vi.useRealTimers();
  });

  const flush = () => vi.advanceTimersByTimeAsync(0);

  it("starts online", () => {
    expect(store.getSnapshot()).toMatchObject({ status: "online", troubleSince: null, pendingWrites: 0 });
  });

  it("confirms a connectivity error with a probe before reconnecting", async () => {
    store.reportError(outage);
    expect(store.getSnapshot().status).toBe("online");
    expect(probe).toHaveBeenCalledTimes(1);
    await flush();
    expect(store.getSnapshot().status).toBe("reconnecting");
    expect(store.getSnapshot().troubleSince).not.toBeNull();
  });

  it("stays online when the probe finds the server healthy (one busy route)", async () => {
    probe.mockResolvedValue(up);
    const listener = vi.fn();
    store.subscribe(listener);
    store.reportError(new ApiUnavailableError(503));
    await flush();
    expect(store.getSnapshot().status).toBe("online");
    expect(listener).not.toHaveBeenCalled();
    // Repeated failures right after a clear probe do not re-probe.
    store.reportError(new ApiUnavailableError(503));
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("ignores errors that are not server-wide", () => {
    store.reportError(new ApiError("Too many requests", 429, null));
    store.reportError(new ApiError("Forbidden", 403, null));
    store.reportError(new ApiError("Plugin worker restarting", 503, { code: "WORKER_UNAVAILABLE", message: "x" }));
    store.reportError(new TypeError("Cannot read properties of undefined"));
    expect(probe).not.toHaveBeenCalled();
  });

  it("probes with backoff 1s, 2s, 5s, 10s, then every 15s", async () => {
    store.reportError(outage);
    await flush();
    const probeTimes: number[] = [];
    const start = Date.now();
    probe.mockImplementation(async () => {
      probeTimes.push(Date.now() - start);
      return down;
    });
    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 5_000 + 10_000 + 15_000 + 15_000);
    expect(probeTimes).toEqual([1_000, 3_000, 8_000, 18_000, 33_000, 48_000]);
  });

  it("honors a longer Retry-After", async () => {
    probe.mockResolvedValueOnce({ reachable: false, retryAfterMs: 7_000 });
    store.reportError(outage);
    await flush();
    await vi.advanceTimersByTimeAsync(6_999);
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("recovers on a successful probe and notifies recovery listeners once", async () => {
    const recovered = vi.fn();
    store.onRecover(recovered);
    store.reportError(outage);
    await flush();
    probe.mockResolvedValue(up);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.getSnapshot()).toMatchObject({ status: "online", troubleSince: null });
    expect(store.getSnapshot().recoveredAt).not.toBeNull();
    expect(recovered).toHaveBeenCalledTimes(1);
    // No more probes once online.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(recovered).toHaveBeenCalledTimes(1);
  });

  it("recovers when any request succeeds during an outage", async () => {
    const recovered = vi.fn();
    store.onRecover(recovered);
    store.reportError(outage);
    await flush();
    store.reportSuccess();
    expect(store.getSnapshot().status).toBe("online");
    expect(recovered).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("does not report recovery for a success while already online", () => {
    const recovered = vi.fn();
    store.onRecover(recovered);
    store.reportSuccess();
    expect(recovered).not.toHaveBeenCalled();
  });

  it("probes immediately on probeNow during an outage", async () => {
    store.reportError(outage);
    await flush();
    probe.mockResolvedValue(up);
    store.probeNow();
    await flush();
    expect(store.getSnapshot().status).toBe("online");
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("treats a closed socket as a suspicion and an open socket as success", async () => {
    store.reportSocketStatus("closed");
    expect(probe).toHaveBeenCalledTimes(1);
    await flush();
    expect(store.getSnapshot().status).toBe("reconnecting");
    store.reportSocketStatus("open");
    expect(store.getSnapshot().status).toBe("online");
  });

  it("goes offline with the browser and confirms the server when the network returns", async () => {
    store.setBrowserOnline(false);
    expect(store.getSnapshot().status).toBe("offline");
    store.reportError(outage);
    store.reportSuccess();
    expect(store.getSnapshot().status).toBe("offline");
    expect(probe).not.toHaveBeenCalled();

    probe.mockResolvedValue(up);
    store.setBrowserOnline(true);
    expect(store.getSnapshot().status).toBe("reconnecting");
    await flush();
    expect(store.getSnapshot().status).toBe("online");
  });

  it("keeps a starting server reconnecting until health reports ok", async () => {
    store.reportServerStarting();
    expect(store.getSnapshot().status).toBe("reconnecting");
    // Other routes answering does not mean the server is ready.
    store.reportSuccess();
    expect(store.getSnapshot().status).toBe("reconnecting");
    probe.mockResolvedValue(up);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.getSnapshot().status).toBe("online");
  });

  it("sums pending writes across sources", () => {
    store.setPendingWrites("composer", 2);
    store.setPendingWrites("autosave", 1);
    expect(store.getSnapshot().pendingWrites).toBe(3);
    store.setPendingWrites("composer", 0);
    expect(store.getSnapshot().pendingWrites).toBe(1);
  });

  it("returns a stable snapshot until something changes", async () => {
    const first = store.getSnapshot();
    store.reportSuccess();
    expect(store.getSnapshot()).toBe(first);
    store.reportError(outage);
    await flush();
    expect(store.getSnapshot()).not.toBe(first);
  });
});

describe("probeServerHealth", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each<[string, Response | Error, ProbeResult["reachable"]]>([
    ["ok health", Response.json({ status: "ok" }), true],
    ["a starting server", Response.json({ status: "starting" }), false],
    ["the gateway code", Response.json({ error: "tenant_app_unavailable" }, { status: 503 }), false],
    ["the gateway code with a 404", Response.json({ error: "tenant_app_unavailable" }, { status: 404 }), false],
    ["a proxy HTML page", new Response("<html>Bad gateway</html>", { status: 502 }), false],
    ["an HTML fallback with 200", new Response("<html></html>", { status: 200 }), false],
    ["a 401 (server is up)", Response.json({ error: "Unauthorized" }, { status: 401 }), true],
    ["a network failure", new TypeError("Failed to fetch"), false],
  ])("reports %s", async (_label, outcome, reachable) => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }));
    expect((await probeServerHealth()).reachable).toBe(reachable);
  });

  it("passes Retry-After through", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(
      { error: "tenant_app_unavailable" },
      { status: 503, headers: { "Retry-After": "4" } },
    )));
    expect(await probeServerHealth()).toEqual({ reachable: false, retryAfterMs: 4_000 });
  });
});
