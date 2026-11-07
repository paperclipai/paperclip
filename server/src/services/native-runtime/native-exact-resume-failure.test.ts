import { describe, expect, it } from "vitest";
import { describeRefusedExactResume, interruptedExactResumeCause } from "./native-exact-resume-failure.js";

const interruption = {
  at: "2099-01-01T00:00:00.000Z",
  disposition: "retryable_failure",
  reason: "native_session_interrupted",
  providerAttempt: 1,
  stderrTail: "PRP command turn.start failed: classification=session_resume_required",
  providerSessionEstablished: true,
  checkpointExists: true,
};
const claimed = { phase: "observed", attempt: 1, resultId: null, recoveryHistory: [interruption] };

describe("interruptedExactResumeCause", () => {
  it("returns the interrupted attempt that a pending exact-checkpoint resume claim was resuming", () => {
    expect(interruptedExactResumeCause(claimed)).toEqual({
      originalFailureCode: "native_session_interrupted",
      originalMessage: "PRP command turn.start failed: classification=session_resume_required",
      interruptedAttempt: 1,
    });
  });

  it("uses only the latest recovery history entry", () => {
    const earlier = { ...interruption, reason: "provider_transport_failed", providerAttempt: 1, stderrTail: "older" };
    expect(interruptedExactResumeCause({ ...claimed, attempt: 2,
      recoveryHistory: [earlier, { ...interruption, providerAttempt: 2 }] })?.originalMessage).toBe(interruption.stderrTail);
  });

  it.each([
    ["no coordinator", null],
    ["a first attempt without recovery history", { ...claimed, attempt: 0, recoveryHistory: [] }],
    ["an executor-claimed later attempt", { ...claimed, attempt: 2 }],
    ["a coordinator that is not a pending claim", { ...claimed, phase: "retryable_failure" }],
    ["an accepted result", { ...claimed, resultId: "result" }],
    ["a bootstrap retry without a checkpoint", { ...claimed, recoveryHistory: [{ ...interruption, checkpointExists: false, providerSessionEstablished: false }] }],
    ["an exhausted terminal entry", { ...claimed, recoveryHistory: [{ ...interruption, disposition: "terminal_failure" }] }],
    ["malformed history", { ...claimed, recoveryHistory: { reason: "native_session_interrupted" } }],
  ])("returns null for %s", (_name, coordinator) => {
    expect(interruptedExactResumeCause(coordinator)).toBeNull();
  });

  it("bounds the original message so the chained failure fits the failure detail", () => {
    const cause = interruptedExactResumeCause({ ...claimed, recoveryHistory: [{ ...interruption, stderrTail: "x".repeat(4_096) }] });
    expect(cause?.originalMessage).toHaveLength(1_500);
    expect(describeRefusedExactResume(cause!, "Plugin Runner retained session is not authorized").length).toBeLessThanOrEqual(2_000);
  });
});

describe("describeRefusedExactResume", () => {
  it("names the original failure before the refusal", () => {
    expect(describeRefusedExactResume(interruptedExactResumeCause(claimed)!, "Plugin Runner retained session is not authorized"))
      .toBe("native_session_interrupted: PRP command turn.start failed: classification=session_resume_required; "
        + "exact checkpoint resume refused: Plugin Runner retained session is not authorized");
  });

  it("keeps the original failure code when no message was persisted", () => {
    expect(describeRefusedExactResume({ originalFailureCode: "native_session_interrupted", originalMessage: "", interruptedAttempt: 1 }, "refused"))
      .toBe("native_session_interrupted; exact checkpoint resume refused: refused");
  });
});
