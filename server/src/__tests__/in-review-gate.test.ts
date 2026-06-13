import { describe, expect, it } from "vitest";
import { shouldBlockUnreviewableInReview } from "../services/in-review-gate.js";

describe("shouldBlockUnreviewableInReview", () => {
  const base = {
    fromStatus: "in_progress",
    toStatus: "in_review" as string | undefined,
    isAgentActor: true,
    verdict: { verdict: "warn" } as { verdict: string } | null,
  };

  it("allows an agent moving to in_review on a warn verdict (unlabeled fallback — gate is lenient)", () => {
    expect(shouldBlockUnreviewableInReview(base)).toBe(false);
  });

  it("blocks an agent moving to in_review on a block verdict", () => {
    expect(
      shouldBlockUnreviewableInReview({ ...base, verdict: { verdict: "block" } }),
    ).toBe(true);
  });

  it("allows in_review on a pass verdict", () => {
    expect(
      shouldBlockUnreviewableInReview({ ...base, verdict: { verdict: "pass" } }),
    ).toBe(false);
  });

  it("fails open when gate evaluation produced no verdict", () => {
    expect(shouldBlockUnreviewableInReview({ ...base, verdict: null })).toBe(false);
  });

  it("does nothing for non-in_review transitions", () => {
    expect(shouldBlockUnreviewableInReview({ ...base, toStatus: "done" })).toBe(false);
    expect(shouldBlockUnreviewableInReview({ ...base, toStatus: undefined })).toBe(false);
  });

  it("does nothing for a no-op in_review -> in_review patch", () => {
    expect(
      shouldBlockUnreviewableInReview({ ...base, fromStatus: "in_review" }),
    ).toBe(false);
  });

  it("never blocks a human actor", () => {
    expect(shouldBlockUnreviewableInReview({ ...base, isAgentActor: false })).toBe(false);
  });
});
