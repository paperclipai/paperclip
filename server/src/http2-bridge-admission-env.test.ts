import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_LIVE_HTTP2_BRIDGE_SESSIONS,
  DEFAULT_MAX_PARALLEL_HTTP2_BRIDGE_REQUESTS,
} from "@paperclipai/adapter-utils/http2-bridge-admission";
import {
  resolveHttp2BridgeAdmissionCapsFromEnv,
  resolveMaxLiveHttp2BridgeSessionsFromEnv,
  resolveMaxParallelHttp2BridgeRequestsFromEnv,
} from "./http2-bridge-admission-env.js";

describe("resolveMaxParallelHttp2BridgeRequestsFromEnv", () => {
  it("an absent variable uses the default", () => {
    const onRejectedOverride = vi.fn();

    const resolved = resolveMaxParallelHttp2BridgeRequestsFromEnv(undefined, onRejectedOverride);

    expect(resolved).toBe(DEFAULT_MAX_PARALLEL_HTTP2_BRIDGE_REQUESTS);
    expect(onRejectedOverride).not.toHaveBeenCalled();
  });

  it("a blank or whitespace-only value is invalid and reports a rejection", () => {
    const onRejectedOverride = vi.fn();

    const resolved = resolveMaxParallelHttp2BridgeRequestsFromEnv("   ", onRejectedOverride);

    expect(resolved).toBe(DEFAULT_MAX_PARALLEL_HTTP2_BRIDGE_REQUESTS);
    expect(onRejectedOverride).toHaveBeenCalledTimes(1);
    // The reporter receives only the parsed number, never the raw string.
    const reportedValue = onRejectedOverride.mock.calls[0]?.[0];
    expect(typeof reportedValue).toBe("number");
  });

  it("a value above the hard range is invalid and reports a rejection", () => {
    const onRejectedOverride = vi.fn();

    const resolved = resolveMaxParallelHttp2BridgeRequestsFromEnv("65", onRejectedOverride);

    expect(resolved).toBe(DEFAULT_MAX_PARALLEL_HTTP2_BRIDGE_REQUESTS);
    expect(onRejectedOverride).toHaveBeenCalledTimes(1);
  });

  it("a valid positive integer inside the range passes through unchanged", () => {
    const onRejectedOverride = vi.fn();

    const resolved = resolveMaxParallelHttp2BridgeRequestsFromEnv("32", onRejectedOverride);

    expect(resolved).toBe(32);
    expect(onRejectedOverride).not.toHaveBeenCalled();
  });
});

describe("resolveMaxLiveHttp2BridgeSessionsFromEnv", () => {
  it("an absent variable uses the default", () => {
    const onRejectedOverride = vi.fn();

    const resolved = resolveMaxLiveHttp2BridgeSessionsFromEnv(undefined, onRejectedOverride);

    expect(resolved).toBe(DEFAULT_MAX_LIVE_HTTP2_BRIDGE_SESSIONS);
    expect(onRejectedOverride).not.toHaveBeenCalled();
  });

  it("a blank or whitespace-only value is invalid and reports a rejection", () => {
    const onRejectedOverride = vi.fn();

    const resolved = resolveMaxLiveHttp2BridgeSessionsFromEnv("", onRejectedOverride);

    expect(resolved).toBe(DEFAULT_MAX_LIVE_HTTP2_BRIDGE_SESSIONS);
    expect(onRejectedOverride).toHaveBeenCalledTimes(1);
  });

  it("a value above the hard range is invalid and reports a rejection", () => {
    const onRejectedOverride = vi.fn();

    const resolved = resolveMaxLiveHttp2BridgeSessionsFromEnv("65", onRejectedOverride);

    expect(resolved).toBe(DEFAULT_MAX_LIVE_HTTP2_BRIDGE_SESSIONS);
    expect(onRejectedOverride).toHaveBeenCalledTimes(1);
  });

  it("a valid positive integer inside the range passes through unchanged", () => {
    const onRejectedOverride = vi.fn();

    const resolved = resolveMaxLiveHttp2BridgeSessionsFromEnv("4", onRejectedOverride);

    expect(resolved).toBe(4);
    expect(onRejectedOverride).not.toHaveBeenCalled();
  });
});

describe("resolveHttp2BridgeAdmissionCapsFromEnv", () => {
  it("an absent pair uses both defaults", () => {
    const onRejectedOverride = vi.fn();
    const onRejectedPair = vi.fn();

    const resolved = resolveHttp2BridgeAdmissionCapsFromEnv(
      undefined,
      undefined,
      onRejectedOverride,
      onRejectedPair,
    );

    expect(resolved).toEqual({
      maxParallel: DEFAULT_MAX_PARALLEL_HTTP2_BRIDGE_REQUESTS,
      maxSessions: DEFAULT_MAX_LIVE_HTTP2_BRIDGE_SESSIONS,
    });
    expect(onRejectedOverride).not.toHaveBeenCalled();
    expect(onRejectedPair).not.toHaveBeenCalled();
  });

  it("a rejected per-field override calls the override reporter exactly once", () => {
    const onRejectedOverride = vi.fn();
    const onRejectedPair = vi.fn();

    const resolved = resolveHttp2BridgeAdmissionCapsFromEnv(
      "not-a-number",
      "4",
      onRejectedOverride,
      onRejectedPair,
    );

    expect(resolved).toEqual({
      maxParallel: DEFAULT_MAX_PARALLEL_HTTP2_BRIDGE_REQUESTS,
      maxSessions: 4,
    });
    // The pair resolver reruns each per-field check with no reporter bound, so
    // only the env helper's own per-field pass reports the rejection.
    expect(onRejectedOverride).toHaveBeenCalledTimes(1);
    expect(onRejectedPair).not.toHaveBeenCalled();
  });

  it("an over-budget environment pair of 64 and 64 resolves to both defaults and reports an error", () => {
    const onRejectedOverride = vi.fn();
    const onRejectedPair = vi.fn();

    const resolved = resolveHttp2BridgeAdmissionCapsFromEnv("64", "64", onRejectedOverride, onRejectedPair);

    expect(resolved).toEqual({
      maxParallel: DEFAULT_MAX_PARALLEL_HTTP2_BRIDGE_REQUESTS,
      maxSessions: DEFAULT_MAX_LIVE_HTTP2_BRIDGE_SESSIONS,
    });
    expect(onRejectedOverride).not.toHaveBeenCalled();
    expect(onRejectedPair).toHaveBeenCalledTimes(1);
    const rejection = onRejectedPair.mock.calls[0]?.[0];
    expect(rejection).toEqual({ maxParallel: 64, maxSessions: 64, totalBytes: expect.any(Number) });
  });
});
