import { describe, expect, it } from "vitest";
import { classifyTechnicalReviewOutcome } from "../services/technical-review-outcome.js";

describe("classifyTechnicalReviewOutcome", () => {
  it("detects English approved phrases", () => {
    expect(classifyTechnicalReviewOutcome("Ready for human review.")).toBe("approved");
    expect(classifyTechnicalReviewOutcome("Approved for human review after CI.")).toBe("approved");
    expect(classifyTechnicalReviewOutcome("No blocking findings.")).toBe("approved");
    expect(classifyTechnicalReviewOutcome("This is a non-blocking review.")).toBe("approved");
    expect(classifyTechnicalReviewOutcome("OK to proceed to human review.")).toBe("approved");
    expect(classifyTechnicalReviewOutcome("LGTM for human review.")).toBe("approved");
    expect(classifyTechnicalReviewOutcome("Ship to human review.")).toBe("approved");
  });

  it("still detects Portuguese approved phrases", () => {
    expect(classifyTechnicalReviewOutcome("Pode seguir para revisao humana.")).toBe("approved");
    expect(classifyTechnicalReviewOutcome("Pronto para revisao humana.")).toBe("approved");
    expect(classifyTechnicalReviewOutcome("Aprovado para revisao humana.")).toBe("approved");
  });

  it("classifies blocking findings section", () => {
    expect(
      classifyTechnicalReviewOutcome("### Blocking findings\n\nNone."),
    ).toBe("approved");
    expect(
      classifyTechnicalReviewOutcome("### Findings bloqueantes\n\nNenhum."),
    ).toBe("approved");
    expect(
      classifyTechnicalReviewOutcome("### Blocking findings\n\nRace condition in cache."),
    ).toBe("blocking");
  });

  it("returns null for vague praise", () => {
    expect(classifyTechnicalReviewOutcome("Looks good!")).toBe(null);
    expect(classifyTechnicalReviewOutcome("LGTM")).toBe(null);
  });
});
