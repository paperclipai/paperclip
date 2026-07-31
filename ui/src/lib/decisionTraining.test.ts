import { describe, expect, it } from "vitest";
import { decisionTrainingHref } from "./decisionTraining";

describe("decisionTrainingHref", () => {
  it("keeps the training library under decisions", () => {
    expect(decisionTrainingHref()).toBe("/decisions/training");
  });

  it("keeps training records under decisions", () => {
    expect(decisionTrainingHref("example-1")).toBe("/decisions/training/example-1");
  });
});
