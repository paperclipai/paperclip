import { describe, expect, it } from "vitest";
import { isLauncherCapacityFailure } from "./launcher-capacity.js";

describe("persisted launcher capacity evidence", () => {
  const failure = { status: "failed", errorCode: "launcher_capacity_unavailable", exitCode: 5, signal: null,
    resultJson: { stdout: "", executionRecovery: { kind: "bootstrap", providerWorkStarted: false,
      launcher: { version: 1, outcome: "capacity_unavailable" } } },
    usageJson: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 } };
  it("recognizes only the explicit adapter evidence", () => expect(isLauncherCapacityFailure(failure)).toBe(true));
  it.each(["inputTokens", "outputTokens", "cachedInputTokens", "input_tokens", "output_tokens",
    "cached_input_tokens", "rawInputTokens", "rawOutputTokens", "rawCachedInputTokens", "costUsd"])
  ("rejects contradictory %s even when normalized usage is zero", (field) => {
    expect(isLauncherCapacityFailure({ ...failure, usageJson: { ...failure.usageJson, [field]: 1 } })).toBe(false);
  });
  it.each([
    { status: "cancelled" }, { status: "timed_out" }, { exitCode: 0 }, { signal: "SIGTERM" },
    { errorCode: "duplex_channel_lost" }, { resultJson: { ...failure.resultJson, stdout: "provider output" } },
    { resultJson: { ...failure.resultJson, errorFamily: "provider_quota" } },
    { resultJson: { stdout: "", executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } },
    { resultJson: { stdout: "", executionRecovery: { kind: "bootstrap", providerWorkStarted: true,
      launcher: { version: 1, outcome: "capacity_unavailable" } } } },
  ])("rejects conflicting or missing durable evidence %j", (change) => {
    expect(isLauncherCapacityFailure({ ...failure, ...change })).toBe(false);
  });
});
