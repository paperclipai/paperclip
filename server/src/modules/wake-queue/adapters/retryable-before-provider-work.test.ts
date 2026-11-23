import { describe, expect, it } from "vitest";
import { isRetryableBeforeProviderWorkRunRow } from "./postgres.js";

const leaseLost = {
  status: "failed", errorCode: "controller_lease_lost", error: "Legacy controller lease lost",
  resultJson: { stopReason: "adapter_failed", executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
    cancellation: { reason: "Legacy controller lease lost (renewal_deadline)", source: "controller_lease", expected: false,
      initiator: { type: "system" }, recordedAt: "2026-11-11T19:40:24.457Z" },
    controllerLeaseLoss: { cause: "renewal_deadline", renewalCount: 25 } },
  contextSnapshot: { retryReason: "issue_continuation_needed", source: "issue.continuation_recovery" },
};

describe("isRetryableBeforeProviderWorkRunRow", () => {
  it.each([
    ["a continuation that lost its controller lease while preparing", leaseLost, true],
    ["a lost lease without the no-provider-work certificate", { ...leaseLost, resultJson: { stopReason: "adapter_failed" } }, false],
    ["a lost lease after provider work started", { ...leaseLost,
      resultJson: { ...leaseLost.resultJson, executionRecovery: { kind: "bootstrap", providerWorkStarted: true } } }, false],
    ["a non-retryable setup failure before provider work", { ...leaseLost, errorCode: "setup_failed" }, false],
    ["a succeeded run", { ...leaseLost, status: "succeeded", errorCode: null }, false],
  ])("classifies %s", (_label, row, expected) => {
    expect(isRetryableBeforeProviderWorkRunRow(row as never)).toBe(expected);
  });
});
