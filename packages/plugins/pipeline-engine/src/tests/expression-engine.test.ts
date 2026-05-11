import { describe, it, expect } from "vitest";
import { evaluateCondition, buildExpressionContext } from "../expression-engine.js";
import type { ExpressionContext, StageStatus } from "../types.js";

describe("expression-engine", () => {
  const baseContext: ExpressionContext = {
    stages: {
      "spec-review": { output: { status: "approved", completeness_score: 0.9 }, status: "completed", retry_count: 0 },
      validate: { output: { status: "pass" }, status: "completed", retry_count: 0 },
    },
    pipeline: { name: "feature", version: 1, parent_issue_id: "issue-1" },
    env: { company_id: "company-1" },
  };

  it("evaluates simple equality", async () => {
    const result = await evaluateCondition('stages."spec-review".output.status = \'approved\'', baseContext);
    expect(result).toBe(true);
  });

  it("evaluates false condition", async () => {
    const result = await evaluateCondition('stages."spec-review".output.status = \'rejected\'', baseContext);
    expect(result).toBe(false);
  });

  it("evaluates nested field access", async () => {
    const result = await evaluateCondition('stages.validate.output.status = \'pass\'', baseContext);
    expect(result).toBe(true);
  });

  it("returns false for missing stage", async () => {
    const result = await evaluateCondition('stages.nonexistent.output.status = \'pass\'', baseContext);
    expect(result).toBe(false);
  });

  it("throws on invalid expression syntax", async () => {
    await expect(evaluateCondition("invalid %%% syntax", baseContext)).rejects.toThrow();
  });

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
  });
});
