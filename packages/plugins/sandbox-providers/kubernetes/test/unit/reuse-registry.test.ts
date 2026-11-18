import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginLeaseExec,
  evictLongestIdleLease,
  forgetLease,
  isTracked,
  reapIdleLeases,
  resetReuseRegistry,
  startIdleReaper,
  trackReusableLease,
} from "../../src/reuse-registry.js";

function makeClients() {
  return {
    custom: { deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}) },
    core: {
      deleteNamespacedSecret: vi.fn().mockResolvedValue({}),
      deleteNamespacedPod: vi.fn().mockResolvedValue({}),
    },
  };
}

function track(clients: ReturnType<typeof makeClients>, name: string, now: number, namespace = "paperclip-acme") {
  return trackReusableLease(
    {
      namespace,
      name,
      secretName: `${name}-env`,
      podName: `${name}-pod`,
      backend: "sandbox-cr",
      clients: clients as never,
      idleTtlMs: 300_000,
    },
    now,
  );
}

beforeEach(() => resetReuseRegistry());

describe("reapIdleLeases", () => {
  it("destroys a lease idle past its TTL and forgets it", async () => {
    const clients = makeClients();
    track(clients, "pc-a", 0);
    expect(await reapIdleLeases(299_000)).toEqual([]);
    expect(await reapIdleLeases(300_000)).toEqual(["pc-a"]);
    expect(clients.custom.deleteNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({ name: "pc-a", namespace: "paperclip-acme" }),
    );
    expect(isTracked("paperclip-acme", "pc-a")).toBe(false);
  });

  it("never reaps a lease with an exec in flight, and restarts the clock when it ends", async () => {
    const clients = makeClients();
    track(clients, "pc-a", 0);
    let t = 10_000;
    const end = beginLeaseExec("paperclip-acme", "pc-a", () => t);
    expect(await reapIdleLeases(1_000_000)).toEqual([]);
    t = 1_000_000;
    end();
    expect(await reapIdleLeases(1_000_000 + 299_000)).toEqual([]);
    expect(await reapIdleLeases(1_000_000 + 300_000)).toEqual(["pc-a"]);
  });

  it("keeps reaping the rest and reports errors when one destroy fails", async () => {
    const clients = makeClients();
    clients.custom.deleteNamespacedCustomObject
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({});
    track(clients, "pc-a", 0);
    track(clients, "pc-b", 0);
    const onError = vi.fn();
    expect(await reapIdleLeases(300_000, onError)).toEqual(["pc-b"]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("ignores leases that were forgotten (released by the server)", async () => {
    const clients = makeClients();
    track(clients, "pc-a", 0);
    forgetLease("paperclip-acme", "pc-a");
    expect(await reapIdleLeases(10_000_000)).toEqual([]);
    expect(clients.custom.deleteNamespacedCustomObject).not.toHaveBeenCalled();
  });
});

describe("failed destroys and bookkeeping", () => {
  it("keeps a lease tracked when its destroy fails so the next sweep retries it", async () => {
    const clients = makeClients();
    clients.custom.deleteNamespacedCustomObject.mockRejectedValueOnce(new Error("apiserver down"));
    track(clients, "pc-a", 0);
    const onError = vi.fn();
    expect(await reapIdleLeases(300_000, onError)).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(isTracked("paperclip-acme", "pc-a")).toBe(true);
    expect(await reapIdleLeases(300_001, onError)).toEqual(["pc-a"]);
    expect(isTracked("paperclip-acme", "pc-a")).toBe(false);
  });

  it("never overwrites a known pod name with an unknown one on re-track", async () => {
    const clients = makeClients();
    track(clients, "pc-a", 0);
    trackReusableLease(
      {
        namespace: "paperclip-acme",
        name: "pc-a",
        secretName: "pc-a-env",
        podName: null,
        backend: "sandbox-cr",
        clients: clients as never,
        idleTtlMs: 300_000,
      },
      10,
    );
    await reapIdleLeases(1_000_000);
    expect(clients.core.deleteNamespacedPod).toHaveBeenCalledWith(
      expect.objectContaining({ name: "pc-a-pod" }),
    );
  });

  it("starts a single reaper timer no matter how many times setup runs", () => {
    vi.useFakeTimers();
    try {
      const stop1 = startIdleReaper(1_000, () => {});
      const stop2 = startIdleReaper(1_000, () => {});
      expect(vi.getTimerCount()).toBe(1);
      stop2(); // a later caller cannot stop the shared timer
      expect(vi.getTimerCount()).toBe(1);
      stop1();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("evictLongestIdleLease", () => {
  it("evicts the longest-idle lease in the namespace, but never a recently active or foreign one", async () => {
    const clients = makeClients();
    track(clients, "pc-old", 0);
    track(clients, "pc-newer", 20_000);
    track(clients, "pc-other-company", 0, "paperclip-other");
    expect(await evictLongestIdleLease("paperclip-acme", 40_000)).toBe(true);
    expect(isTracked("paperclip-acme", "pc-old")).toBe(false);
    expect(isTracked("paperclip-acme", "pc-newer")).toBe(true);
    expect(isTracked("paperclip-other", "pc-other-company")).toBe(true);
  });

  it("refuses to evict a lease that was active in the last 30 s or has an exec in flight", async () => {
    const clients = makeClients();
    track(clients, "pc-fresh", 100_000);
    track(clients, "pc-busy", 0);
    beginLeaseExec("paperclip-acme", "pc-busy", () => 0);
    expect(await evictLongestIdleLease("paperclip-acme", 110_000)).toBe(false);
    expect(clients.custom.deleteNamespacedCustomObject).not.toHaveBeenCalled();
  });
});
