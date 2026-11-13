import { describe, expect, it, vi } from "vitest";
import {
  createProviderHostReachabilityProbe,
  isHostNetworkUnreachableFailure,
  resolveProviderReachabilityProbeHost,
} from "./provider-network-reachability.js";

// The exact string every measured outage produced. Kept verbatim, including the
// CLI's own punctuation, because the classifier is anchored on it.
const MEASURED_ENOTFOUND_ERROR =
  "Claude run failed: subtype=success: API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)";
const MEASURED_ECONNREFUSED_ERROR =
  "Claude run failed: subtype=success: API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)";

describe("isHostNetworkUnreachableFailure", () => {
  it("classifies the measured ENOTFOUND failure", () => {
    expect(
      isHostNetworkUnreachableFailure({ error: MEASURED_ENOTFOUND_ERROR }),
    ).toBe(true);
  });

  it.each(["EAI_AGAIN", "ENODATA", "ENETDOWN", "ENETUNREACH"])(
    "classifies %s as host network unreachable",
    (code) => {
      expect(
        isHostNetworkUnreachableFailure({ error: `getaddrinfo ${code} api.example.test` }),
      ).toBe(true);
    },
  );

  it("does NOT classify ECONNREFUSED, which a DNS probe cannot confirm", () => {
    expect(
      isHostNetworkUnreachableFailure({ error: MEASURED_ECONNREFUSED_ERROR }),
    ).toBe(false);
  });

  it("reads the adapter's errorMessage as well as error", () => {
    expect(
      isHostNetworkUnreachableFailure({
        error: null,
        resultJson: { errorMessage: MEASURED_ENOTFOUND_ERROR },
      }),
    ).toBe(true);
  });

  it("does NOT read agent-authored output, so an agent cannot classify its own run", () => {
    expect(
      isHostNetworkUnreachableFailure({
        error: "Reached maximum number of turns",
        resultJson: {
          result: "I investigated the ENOTFOUND report and found nothing.",
          message: "ENOTFOUND appears in the logs.",
        },
      }),
    ).toBe(false);
  });

  it("does not match a code embedded in a longer word", () => {
    expect(
      isHostNetworkUnreachableFailure({ error: "NOTENOTFOUNDISH failure" }),
    ).toBe(false);
  });

  it("ignores unrelated failures", () => {
    for (const error of [
      "Claude run failed: subtype=error_max_turns: Reached maximum number of turns",
      "You've hit your 5-hour limit",
      "failed to start command",
      null,
      undefined,
      "",
    ]) {
      expect(isHostNetworkUnreachableFailure({ error })).toBe(false);
    }
  });

  it("tolerates a non-object resultJson", () => {
    expect(
      isHostNetworkUnreachableFailure({ error: null, resultJson: "ENOTFOUND" }),
    ).toBe(false);
    expect(
      isHostNetworkUnreachableFailure({ error: null, resultJson: ["ENOTFOUND"] }),
    ).toBe(false);
  });
});

describe("resolveProviderReachabilityProbeHost", () => {
  it("defaults to the host network-park-sweep.sh probes", () => {
    expect(resolveProviderReachabilityProbeHost({})).toBe("api.anthropic.com");
  });

  it("honours the sweep's own variable so the two cannot disagree", () => {
    expect(
      resolveProviderReachabilityProbeHost({
        NETWORK_PARK_SWEEP_PROBE_HOST: "api.sweep.test",
      }),
    ).toBe("api.sweep.test");
  });

  it("prefers the paperclip-scoped override", () => {
    expect(
      resolveProviderReachabilityProbeHost({
        PAPERCLIP_PROVIDER_PROBE_HOST: "api.override.test",
        NETWORK_PARK_SWEEP_PROBE_HOST: "api.sweep.test",
      }),
    ).toBe("api.override.test");
  });

  it("falls back when the override is blank", () => {
    expect(
      resolveProviderReachabilityProbeHost({ PAPERCLIP_PROVIDER_PROBE_HOST: "   " }),
    ).toBe("api.anthropic.com");
  });
});

describe("createProviderHostReachabilityProbe", () => {
  it("reports reachable when the host resolves", async () => {
    const resolveHost = vi.fn(async () => true);
    const probe = createProviderHostReachabilityProbe({ resolveHost });
    await expect(probe()).resolves.toBe(true);
  });

  it("reports unreachable when the host does not resolve", async () => {
    const resolveHost = vi.fn(async () => false);
    const probe = createProviderHostReachabilityProbe({ resolveHost });
    await expect(probe()).resolves.toBe(false);
  });

  it("probes the configured host with the configured timeout", async () => {
    const resolveHost = vi.fn(async () => true);
    const probe = createProviderHostReachabilityProbe({
      host: "api.example.test",
      timeoutMs: 1234,
      resolveHost,
    });
    await probe();
    expect(resolveHost).toHaveBeenCalledWith("api.example.test", 1234);
  });

  it("caches a result for cacheMs, so one pass costs one query", async () => {
    let clock = 0;
    const resolveHost = vi.fn(async () => false);
    const probe = createProviderHostReachabilityProbe({
      resolveHost,
      cacheMs: 15_000,
      now: () => clock,
    });
    await expect(probe()).resolves.toBe(false);
    clock = 14_999;
    await expect(probe()).resolves.toBe(false);
    expect(resolveHost).toHaveBeenCalledTimes(1);
  });

  it("re-probes once the cache expires, so recovery is noticed", async () => {
    let clock = 0;
    let reachable = false;
    const resolveHost = vi.fn(async () => reachable);
    const probe = createProviderHostReachabilityProbe({
      resolveHost,
      cacheMs: 15_000,
      now: () => clock,
    });
    await expect(probe()).resolves.toBe(false);
    clock = 15_000;
    reachable = true;
    await expect(probe()).resolves.toBe(true);
    expect(resolveHost).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight probe between concurrent callers", async () => {
    let release: ((value: boolean) => void) | null = null;
    const resolveHost = vi.fn(
      () => new Promise<boolean>((resolve) => {
        release = resolve;
      }),
    );
    const probe = createProviderHostReachabilityProbe({ resolveHost });
    const first = probe();
    const second = probe();
    expect(resolveHost).toHaveBeenCalledTimes(1);
    release?.(false);
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
  });

  it("FAILS OPEN when the probe itself throws", async () => {
    const resolveHost = vi.fn(async () => {
      throw new Error("probe exploded");
    });
    const probe = createProviderHostReachabilityProbe({ resolveHost });
    await expect(probe()).resolves.toBe(true);
  });

  it("FAILS OPEN when the probe throws synchronously", async () => {
    const resolveHost = vi.fn(() => {
      throw new Error("probe exploded before returning a promise");
    });
    const probe = createProviderHostReachabilityProbe({ resolveHost });
    await expect(probe()).resolves.toBe(true);
  });

  it("resolves a real hostname through the default getaddrinfo path", async () => {
    const probe = createProviderHostReachabilityProbe({ host: "localhost" });
    await expect(probe()).resolves.toBe(true);
  });

  it("reports a hostname that cannot resolve as unreachable", async () => {
    const probe = createProviderHostReachabilityProbe({
      host: "paperclip-lac6885-does-not-exist.invalid",
    });
    await expect(probe()).resolves.toBe(false);
  });
});
