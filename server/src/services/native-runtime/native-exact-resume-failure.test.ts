import { describe, expect, it } from "vitest";
import { boundOriginalMessage, describeRefusedExactResume, failureClassificationText, interruptedExactResumeCause } from "./native-exact-resume-failure.js";

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

  it("returns the whole original message so it can be masked before any cut", () => {
    const cause = interruptedExactResumeCause({ ...claimed, recoveryHistory: [{ ...interruption, stderrTail: "x".repeat(4_096) }] });
    expect(cause?.originalMessage).toHaveLength(4_096);
    expect(boundOriginalMessage(cause!.originalMessage)).toHaveLength(1_500);
    const message = describeRefusedExactResume(cause!, "Plugin Runner retained session is not authorized");
    expect(message.length).toBeLessThanOrEqual(2_000);
    expect(message).toContain(`native_session_interrupted: ${"x".repeat(1_500)}; exact checkpoint`);
  });
});

describe("describeRefusedExactResume", () => {
  it("names the original failure before the refusal", () => {
    expect(describeRefusedExactResume(interruptedExactResumeCause(claimed)!, "Plugin Runner retained session is not authorized"))
      .toBe("native_session_interrupted: PRP command turn.start failed: classification=session_resume_required; "
        + "exact checkpoint resume refused: Plugin Runner retained session is not authorized");
  });

  it("keeps the refusal readable when both messages are long", () => {
    const cause = interruptedExactResumeCause({ ...claimed, recoveryHistory: [{ ...interruption, stderrTail: "o".repeat(4_096) }] })!;
    const refusal = `Plugin Runner retained session is not authorized: ${"r".repeat(600)}`;
    const message = describeRefusedExactResume(cause, refusal);
    expect(message).toHaveLength(2_000);
    expect(message.startsWith("native_session_interrupted: ooo")).toBe(true);
    expect(message.endsWith(`; exact checkpoint resume refused: ${refusal.slice(0, 480)}`)).toBe(true);
  });

  it("keeps a short refusal whole after a maximal original message", () => {
    const cause = interruptedExactResumeCause({ ...claimed, recoveryHistory: [{ ...interruption, stderrTail: "o".repeat(4_096) }] })!;
    const message = describeRefusedExactResume(cause, "Plugin Runner retained session is not authorized");
    expect(message.length).toBeLessThanOrEqual(2_000);
    expect(message.endsWith("; exact checkpoint resume refused: Plugin Runner retained session is not authorized")).toBe(true);
  });

  it("keeps the original failure code when no message was persisted", () => {
    expect(describeRefusedExactResume({ originalFailureCode: "native_session_interrupted", originalMessage: "", interruptedAttempt: 1 }, "refused"))
      .toBe("native_session_interrupted; exact checkpoint resume refused: refused");
  });
});

describe("failureClassificationText", () => {
  it("classifies a refused exact resume from its refusal, not the chained error", () => {
    expect(failureClassificationText({
      error: "native_session_interrupted: spawn agent ENOENT; exact checkpoint resume refused: retained session is not authorized",
      resultJson: { nativeExactResumeRefusal: { refusal: "retained session is not authorized" } },
    })).toBe("retained session is not authorized");
  });

  it.each([
    ["no result", { error: "spawn agent ENOENT", resultJson: null }],
    ["a result without a refusal", { error: "spawn agent ENOENT", resultJson: { errorMessage: "other" } }],
    ["a malformed refusal", { error: "spawn agent ENOENT", resultJson: { nativeExactResumeRefusal: { refusal: 7 } } }],
  ])("uses the run error for %s", (_name, run) => {
    expect(failureClassificationText(run)).toBe("spawn agent ENOENT");
  });
});
