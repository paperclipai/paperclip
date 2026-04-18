import { describe, expect, it } from "vitest";
import { computeCloseGateViolation } from "../services/issues.ts";

describe("computeCloseGateViolation", () => {
  it("allows close when the toggle is off", () => {
    expect(
      computeCloseGateViolation({
        fromStatus: "in_progress",
        toStatus: "done",
        requireProofDocumentOnClose: false,
        attachedDocumentCount: 0,
      }),
    ).toBeNull();
  });

  it("allows close when not transitioning to done", () => {
    expect(
      computeCloseGateViolation({
        fromStatus: "in_progress",
        toStatus: "in_review",
        requireProofDocumentOnClose: true,
        attachedDocumentCount: 0,
      }),
    ).toBeNull();
  });

  it("allows close when toStatus is undefined (no status change)", () => {
    expect(
      computeCloseGateViolation({
        fromStatus: "in_progress",
        toStatus: undefined,
        requireProofDocumentOnClose: true,
        attachedDocumentCount: 0,
      }),
    ).toBeNull();
  });

  it("allows re-saving an already-done issue", () => {
    // When fromStatus is already done, no new close is happening.
    expect(
      computeCloseGateViolation({
        fromStatus: "done",
        toStatus: "done",
        requireProofDocumentOnClose: true,
        attachedDocumentCount: 0,
      }),
    ).toBeNull();
  });

  it("blocks close when toggle is on and no document is attached", () => {
    const violation = computeCloseGateViolation({
      fromStatus: "in_progress",
      toStatus: "done",
      requireProofDocumentOnClose: true,
      attachedDocumentCount: 0,
    });
    expect(violation).not.toBeNull();
    expect(violation).toContain("proof");
  });

  it("allows close when toggle is on and at least one document is attached", () => {
    expect(
      computeCloseGateViolation({
        fromStatus: "in_progress",
        toStatus: "done",
        requireProofDocumentOnClose: true,
        attachedDocumentCount: 1,
      }),
    ).toBeNull();
  });

  it("allows close from any non-done state when proof is attached", () => {
    for (const fromStatus of ["backlog", "todo", "in_progress", "in_review", "blocked"]) {
      expect(
        computeCloseGateViolation({
          fromStatus,
          toStatus: "done",
          requireProofDocumentOnClose: true,
          attachedDocumentCount: 1,
        }),
      ).toBeNull();
    }
  });

  it("blocks close from any non-done state when proof is absent", () => {
    for (const fromStatus of ["backlog", "todo", "in_progress", "in_review", "blocked"]) {
      expect(
        computeCloseGateViolation({
          fromStatus,
          toStatus: "done",
          requireProofDocumentOnClose: true,
          attachedDocumentCount: 0,
        }),
      ).not.toBeNull();
    }
  });
});
