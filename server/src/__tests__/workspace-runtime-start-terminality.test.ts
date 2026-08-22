import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  RUNTIME_SERVICE_READINESS_PROBE_TIMEOUT_MS,
  allocateRuntimeServicePort,
  claimRuntimeServiceBindPort,
  resetRuntimeServicePortReservationsForTests,
  waitForRuntimeServiceReadiness,
} from "../services/workspace-runtime.js";

/**
 * Regression fixture for the adverse report on PAP-17207: two exclusive isolated workspaces
 * asked for the same configured app/HMR pair at the same moment. One lane came up healthy,
 * the loser was reallocated onto a port owned by an unrelated listener, and its managed start
 * never reached a terminal state — leaving an active operation that rejected managed cleanup.
 *
 * The two mechanisms that produced the non-terminality are covered here:
 *   1. a readiness probe against a socket that accepts but never answers, and
 *   2. concurrent allocation handing the same port to two starts.
 */
describe("managed runtime start terminality", () => {
  afterEach(() => {
    resetRuntimeServicePortReservationsForTests();
  });

  const hangingService = {
    readiness: { type: "http", timeoutSec: 1, intervalMs: 50 },
  } as Record<string, unknown>;

  it("fails a readiness check whose probes never answer instead of hanging forever", async () => {
    let probes = 0;
    const abortedProbes: string[] = [];
    /** Accepts the request and only ever settles when the caller aborts, like a foreign listener. */
    const neverAnsweringFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      probes += 1;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          abortedProbes.push(String(init?.signal?.reason ?? "aborted"));
          reject(new Error("The operation was aborted due to timeout"));
        });
      });
    }) as unknown as typeof fetch;

    const startedAt = Date.now();
    await expect(
      waitForRuntimeServiceReadiness({
        service: hangingService,
        serviceName: "app",
        command: "pnpm dev",
        url: "http://127.0.0.1:45439/",
        readinessUrl: null,
        fetchImpl: neverAnsweringFetch,
      }),
    ).rejects.toThrow(/Readiness check failed for http:\/\/127\.0\.0\.1:45439\//);
    const elapsedMs = Date.now() - startedAt;

    expect(probes).toBeGreaterThan(0);
    expect(abortedProbes.length).toBeGreaterThan(0);
    // Terminal well inside the 1s readiness budget plus one probe budget.
    expect(elapsedMs).toBeLessThan(1_000 + RUNTIME_SERVICE_READINESS_PROBE_TIMEOUT_MS);
  });

  it("negative control: an unbounded probe loop never terminalizes the same start", async () => {
    // This is the shape of the code that shipped: `fetch` with no abort signal, so the
    // deadline at the top of the loop is never re-evaluated once a probe parks.
    const legacyWait = async () => {
      const deadline = Date.now() + 1_000;
      while (Date.now() < deadline) {
        await new Promise<never>(() => {});
        await delay(50);
      }
      throw new Error("Readiness check failed");
    };

    const settled = await Promise.race([
      legacyWait().then(() => "settled").catch(() => "settled"),
      delay(1_500).then(() => "still-hanging"),
    ]);
    expect(settled).toBe("still-hanging");
  });

  it("stops probing as soon as the readiness budget is spent", async () => {
    let probes = 0;
    const refusingFetch = (async () => {
      probes += 1;
      throw new Error("connect ECONNREFUSED 127.0.0.1:45439");
    }) as unknown as typeof fetch;

    await expect(
      waitForRuntimeServiceReadiness({
        service: { readiness: { type: "http", timeoutSec: 1, intervalMs: 200 } },
        url: "http://127.0.0.1:45439/",
        readinessUrl: null,
        fetchImpl: refusingFetch,
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
    // ~1s budget at a 200ms interval: a bounded handful of probes, never an unbounded spin.
    expect(probes).toBeGreaterThan(1);
    expect(probes).toBeLessThan(12);
  });

  it("hands two concurrent starts distinct ports even when the kernel repeats a candidate", async () => {
    // The kernel really does hand the same ephemeral port to two `listen(0)` probes once the
    // first probe socket has closed, which is exactly the reallocation collision in the report.
    const candidates = [49871, 49871, 49871, 49872];
    let index = 0;
    const probe = async () => candidates[Math.min(index++, candidates.length - 1)]!;
    const portOwnerLookup = async () => null;

    const [first, second] = await Promise.all([
      allocateRuntimeServicePort({ probe, portOwnerLookup }),
      allocateRuntimeServicePort({ probe, portOwnerLookup }),
    ]);

    expect(first).not.toBe(second);
    expect(new Set([first, second])).toEqual(new Set([49871, 49872]));
  });

  it("skips a candidate port that a live process already owns", async () => {
    const candidates = [49881, 49882];
    let index = 0;
    const probe = async () => candidates[Math.min(index++, candidates.length - 1)]!;
    const portOwnerLookup = async (port: number) => (port === 49881 ? 4242 : null);

    await expect(allocateRuntimeServicePort({ probe, portOwnerLookup })).resolves.toBe(49882);
    // The rejected candidate must not stay reserved, or later starts would leak allocations.
    await expect(
      allocateRuntimeServicePort({ probe: async () => 49881, portOwnerLookup: async () => null }),
    ).resolves.toBe(49881);
  });

  it("refuses a configured port a sibling start is already claiming", () => {
    // The reported collision was on a *configured* app/HMR pair, not an auto-allocated one:
    // both lanes read the pair as free because neither had bound or persisted a row yet.
    expect(claimRuntimeServiceBindPort(42003, null)).toBe(true);
    expect(claimRuntimeServiceBindPort(42003, null)).toBe(false);
    // The HMR companion is claimed independently, so a lane can lose on either port.
    expect(claimRuntimeServiceBindPort(42004, null)).toBe(true);
    expect(claimRuntimeServiceBindPort(42004, null)).toBe(false);
  });

  it("never lets a start be refused by its own allocation", async () => {
    // An auto-allocated port arrives already reserved by this start, and its identity port can
    // resolve to that same value. Treating that as a sibling's claim would fail the start on its
    // own reservation.
    const held = await allocateRuntimeServicePort({
      probe: async () => 49901,
      portOwnerLookup: async () => null,
    });
    expect(held).toBe(49901);
    expect(claimRuntimeServiceBindPort(49901, held)).toBe(true);
    // A different start still loses against that held reservation.
    expect(claimRuntimeServiceBindPort(49901, null)).toBe(false);
  });

  it("fails terminally rather than looping when no free port can be found", async () => {
    await expect(
      allocateRuntimeServicePort({ probe: async () => 49891, portOwnerLookup: async () => 99 }),
    ).rejects.toThrow(/Could not allocate a free loopback port/);
  });
});
