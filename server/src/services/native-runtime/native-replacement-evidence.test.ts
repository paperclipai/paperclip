import { describe, expect, it } from "vitest";
import {
  decideNativeReplacement,
  type NativeReplacementEvidence,
} from "./native-replacement-evidence.js";
const safe: NativeReplacementEvidence = {
  failedSession: true,
  failureMeaningKnown: true,
  predecessorFenced: true,
  providerStopped: true,
  workspacePreserved: true,
  historyComplete: true,
  effectInventoryComplete: true,
  attempts: 1,
  invocations: [],
  apiReceipts: {},
  uncertainProviderActions: [],
};
describe("evidence-based replacement", () => {
  it("allows a fenced read-only continuation within the shared incident budget", () =>
    expect(decideNativeReplacement(safe)).toEqual({
      allowed: true,
      remainingAttempts: 2,
    }));
  it.each([
    [{ failureMeaningKnown: false }, "provider_failure_meaning_unverified"],
    [{ attempts: 3 }, "execution_recovery_budget_exhausted"],
    [{ predecessorFenced: false }, "provider_ownership_unverified"],
    [{ providerStopped: false }, "provider_ownership_unverified"],
    [{ workspacePreserved: false }, "continuation_evidence_incomplete"],
    [
      { effectInventoryComplete: false },
      "provider_effect_inventory_unavailable",
    ],
    [{ historyComplete: false }, "continuation_evidence_incomplete"],
    [
      { apiReceipts: { write: { state: "pending" } } },
      "uncertain_control_plane_action",
    ],
    [
      { uncertainProviderActions: ["shell:send-email"] },
      "uncertain_provider_action",
    ],
  ] as const)("rejects %j with a specific next action", (change, cause) =>
    expect(
      decideNativeReplacement({
        ...safe,
        ...change,
        uncertainProviderActions:
          "uncertainProviderActions" in change
            ? [...change.uncertainProviderActions]
            : [],
      }),
    ).toMatchObject({ allowed: false, cause, nextAction: expect.any(String) }),
  );
  it("names the uncertain write instead of granting a generic retry", () => {
    expect(
      decideNativeReplacement({
        ...safe,
        invocations: [
          {
            id: "email-1",
            toolName: "send_email",
            riskLevel: "write",
            status: "running",
            completedAt: null,
            resultHash: null,
          },
        ],
      }),
    ).toMatchObject({
      allowed: false,
      cause: "uncertain_external_action",
      nextAction: expect.stringContaining("email-1"),
    });
  });
});
