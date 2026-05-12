import { describe, it, expect } from "vitest";
import { buildExpressionContext } from "../expression-engine.js";
import type { StageStatus } from "../types.js";

describe("expression-engine", () => {
  describe("buildExpressionContext", () => {
    it("builds context from stage records", () => {
      const stages = [
        { stageId: "validate", status: "completed" as StageStatus, output: { status: "pass" }, retryCount: 1 },
      ];
      const ctx = buildExpressionContext(stages, "feature", 1, "issue-1", "company-1");
      expect(ctx.stages.validate.output).toEqual({ status: "pass" });
      expect(ctx.stages.validate.retry_count).toBe(1);
      expect(ctx.pipeline.name).toBe("feature");
    });

    it("adds hyphen-normalized keys for stages with hyphens in their IDs", () => {
      const stages = [
        { stageId: "spec-review", status: "completed" as StageStatus, output: { status: "approved" }, retryCount: 0 },
      ];
      const ctx = buildExpressionContext(stages, "feature", 1, "issue-1", "company-1");
      expect(ctx.stages["spec-review"]).toBeDefined();
      expect(ctx.stages["spec_review"]).toBeDefined();
      expect(ctx.stages["spec_review"].output).toEqual({ status: "approved" });
    });
  });
});
