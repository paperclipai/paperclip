import { describe, expect, it, vi } from "vitest";
import {
  PROVIDER_NETWORK_UNREACHABLE_RECHECK_MS,
  PROVIDER_REACHABILITY_CACHE_MS,
  createProviderHostReachabilityProbe,
  isHostNetworkUnreachableFailure,
  isProbeHostRelevantToAdapter,
  lookupWithTimeout,
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
    // Definite assignment, not `| null`: the Promise executor runs synchronously,
    // so `release` is set before `probe()` returns. Typing it nullable makes
    // TypeScript narrow it to `null` at the call below (TS2349), since it cannot
    // see that the callback already ran.
    let release!: (value: boolean) => void;
    const resolveHost = vi.fn(
      () => new Promise<boolean>((resolve) => {
        release = resolve;
      }),
    );
    const probe = createProviderHostReachabilityProbe({ resolveHost });
    const first = probe();
    const second = probe();
    expect(resolveHost).toHaveBeenCalledTimes(1);
    release(false);
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


describe("lookupWithTimeout", () => {
  // These drive the REAL race (timer vs getaddrinfo callback), not a mocked
  // `resolveHost` one layer up. getaddrinfo cannot be cancelled, so the
  // behaviour that matters is what happens to a lookup that outlives its
  // deadline. `rules/runtime-dependency-boundaries.mdc` requires this.
  it("reports unreachable when the lookup outlives the deadline", async () => {
    vi.useFakeTimers();
    try {
      const pending = lookupWithTimeout("example.invalid", 3_000, () => {
        /* never calls back: a resolver that hangs */
      });
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(pending).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a late callback from a lookup that already timed out", async () => {
    vi.useFakeTimers();
    let late: ((error: unknown) => void) | null = null;
    try {
      const pending = lookupWithTimeout("example.invalid", 3_000, (_host, cb) => {
        late = cb;
      });
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(pending).resolves.toBe(false);
      // The hung lookup finally answers, and answers SUCCESS. The latch must
      // swallow it: a second settle would otherwise resolve an already-settled
      // promise and, worse, report reachable for a probe that timed out.
      expect(() => late?.(null)).not.toThrow();
      await expect(pending).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the deadline timer when the lookup answers first", async () => {
    vi.useFakeTimers();
    try {
      const pending = lookupWithTimeout("example.test", 3_000, (_host, cb) =>
        cb(null),
      );
      await expect(pending).resolves.toBe(true);
      // Nothing is left armed, so the timer cannot hold the event loop open.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports unreachable when the lookup fails", async () => {
    await expect(
      lookupWithTimeout("example.invalid", 3_000, (_host, cb) =>
        cb(new Error("ENOTFOUND")),
      ),
    ).resolves.toBe(false);
  });

  it("recovers on a fresh probe once the cache has expired", async () => {
    let reachable = false;
    let at = 0;
    const probe = createProviderHostReachabilityProbe({
      now: () => at,
      resolveHost: async () => reachable,
    });
    expect(await probe()).toBe(false);
    // Still inside the cache window: the stale "down" stands, no new lookup.
    reachable = true;
    at += PROVIDER_REACHABILITY_CACHE_MS - 1;
    expect(await probe()).toBe(false);
    // The hold's recheck interval is longer than the cache on purpose, so the
    // pass that acts on it always takes a fresh probe rather than re-reading
    // the "down" that caused the hold.
    expect(PROVIDER_NETWORK_UNREACHABLE_RECHECK_MS).toBeGreaterThan(
      PROVIDER_REACHABILITY_CACHE_MS,
    );
    at += PROVIDER_NETWORK_UNREACHABLE_RECHECK_MS;
    expect(await probe()).toBe(true);
  });
});

describe("isProbeHostRelevantToAdapter", () => {
  const noOverride = {} as NodeJS.ProcessEnv;

  it("answers for claude_local, which the default probe host serves", () => {
    expect(isProbeHostRelevantToAdapter("claude_local", noOverride)).toBe(true);
  });

  it.each(["codex_local", "gemini_local", "grok_local", "opencode_local"])(
    "does not answer for %s on the default host",
    (adapterType) => {
      // Its ENOTFOUND came from its OWN endpoint. api.anthropic.com resolving
      // or not is no evidence either way, so the gate must not hold its retry.
      expect(isProbeHostRelevantToAdapter(adapterType, noOverride)).toBe(false);
    },
  );

  it.each([null, undefined, "", 7])("does not answer for %p", (adapterType) => {
    expect(isProbeHostRelevantToAdapter(adapterType, noOverride)).toBe(false);
  });

  it("answers for every adapter once an operator names the probe host", () => {
    const env = { PAPERCLIP_PROVIDER_PROBE_HOST: "api.openai.com" } as NodeJS.ProcessEnv;
    expect(isProbeHostRelevantToAdapter("codex_local", env)).toBe(true);
    expect(resolveProviderReachabilityProbeHost(env)).toBe("api.openai.com");
  });

  it("ignores a blank override", () => {
    const env = { PAPERCLIP_PROVIDER_PROBE_HOST: "   " } as NodeJS.ProcessEnv;
    expect(isProbeHostRelevantToAdapter("codex_local", env)).toBe(false);
  });
});
