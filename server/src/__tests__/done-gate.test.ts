import { describe, expect, it } from "vitest";
import { shouldBlockNarratedDone } from "../services/done-gate.js";

describe("shouldBlockNarratedDone", () => {
  const base = {
    fromStatus: "in_progress",
    toStatus: "done" as string | undefined,
    existingExecutionRunId: null as string | null,
    lastEvidenceVerdict: null as unknown,
    isAgentActor: true,
  };

  it("blocks an agent marking done with no execution run and no pr-link evidence", () => {
    expect(shouldBlockNarratedDone({ ...base, fromStatus: "todo" })).toBe(true);
  });

  it("allows done when an execution run exists (real checkout)", () => {
    expect(
      shouldBlockNarratedDone({ ...base, existingExecutionRunId: "run-123" }),
    ).toBe(false);
  });

  it("allows done when prior evidence verdict found a pr-link", () => {
    expect(
      shouldBlockNarratedDone({
        ...base,
        fromStatus: "in_review",
        lastEvidenceVerdict: { verdict: "pass", evidenceFound: ["checklist:done-when", "pr-link"] },
      }),
    ).toBe(false);
  });

  it("does nothing for non-done transitions", () => {
    expect(shouldBlockNarratedDone({ ...base, toStatus: "in_review" })).toBe(false);
    expect(shouldBlockNarratedDone({ ...base, toStatus: undefined })).toBe(false);
  });

  it("never blocks a human actor closing an issue", () => {
    expect(shouldBlockNarratedDone({ ...base, fromStatus: "todo", isAgentActor: false })).toBe(false);
  });

  it("does not block a no-op done->done re-set", () => {
    expect(shouldBlockNarratedDone({ ...base, fromStatus: "done" })).toBe(false);
  });

  it("tolerates a malformed evidence verdict without throwing", () => {
    expect(
      shouldBlockNarratedDone({ ...base, fromStatus: "todo", lastEvidenceVerdict: "garbage" }),
    ).toBe(true);
    expect(
      shouldBlockNarratedDone({ ...base, fromStatus: "todo", lastEvidenceVerdict: { evidenceFound: "not-an-array" } }),
    ).toBe(true);
  });
});
