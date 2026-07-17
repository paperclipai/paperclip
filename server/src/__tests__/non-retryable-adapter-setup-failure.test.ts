import { describe, expect, it } from "vitest";
import { isNonRetryableAdapterSetupFailure } from "../services/heartbeat.js";

describe("isNonRetryableAdapterSetupFailure (pause instead of retry-storming)", () => {
  it("matches the k8s-lease adapter-registry failure (the process-agent storm)", () => {
    const err = new Error(
      'Failed to acquire lease for environment "Kubernetes Sandbox" (sandbox): Adapter "process" is not in the configured adapter registry',
    );
    expect(isNonRetryableAdapterSetupFailure(err)).toBe(true);
  });

  it("matches a plain string message too", () => {
    expect(isNonRetryableAdapterSetupFailure('Adapter "foo" is not in the configured adapter registry')).toBe(true);
  });

  it("does NOT match transient/other setup failures (those should keep retrying)", () => {
    expect(isNonRetryableAdapterSetupFailure(new Error("spawn ENOENT"))).toBe(false);
    expect(isNonRetryableAdapterSetupFailure(new Error("connection reset by peer"))).toBe(false);
    expect(isNonRetryableAdapterSetupFailure(new Error("Unknown setup failure"))).toBe(false);
    expect(isNonRetryableAdapterSetupFailure(null)).toBe(false);
    expect(isNonRetryableAdapterSetupFailure(undefined)).toBe(false);
  });
});
