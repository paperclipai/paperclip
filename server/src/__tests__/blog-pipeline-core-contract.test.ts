import { describe, expect, it } from "vitest";
import {
  runDraftPolishStep,
  runDraftReviewStep,
  runDraftStep,
  runFinalReviewStep,
  runResearchStep,
  runValidateStep,
} from "@paperclipai/blog-pipeline-core";

describe("blog pipeline core contract", () => {
  it("exports the required step runners", () => {
    expect(typeof runResearchStep).toBe("function");
    expect(typeof runDraftStep).toBe("function");
    expect(typeof runDraftReviewStep).toBe("function");
    expect(typeof runDraftPolishStep).toBe("function");
    expect(typeof runFinalReviewStep).toBe("function");
    expect(typeof runValidateStep).toBe("function");
  });
});
