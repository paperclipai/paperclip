import { describe, it, expect } from "vitest";
import { evaluateCondition, buildExpressionContext, buildEdgeExpressionContext } from "../expression-engine.js";
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

  describe("buildEdgeExpressionContext", () => {
    it("adds output field from source stage to context", () => {
      const stages = [
        { stageId: "spec-review", status: "completed" as StageStatus, output: { status: "approved" }, retryCount: 0 },
        { stageId: "decompose", status: "pending" as StageStatus, output: null, retryCount: 0 },
      ];
      const ctx = buildEdgeExpressionContext("spec-review", stages, "feature", 1, "issue-1", "company-1");
      expect(ctx.output).toEqual({ status: "approved" });
    });

    it("returns null output when source stage not found", () => {
      const stages = [
        { stageId: "decompose", status: "pending" as StageStatus, output: null, retryCount: 0 },
      ];
      const ctx = buildEdgeExpressionContext("nonexistent", stages, "feature", 1, "issue-1", "company-1");
      expect(ctx.output).toBeNull();
    });

    it("resolves source stage with hyphenated ID using normalized key", () => {
      const stages = [
        { stageId: "spec-review", status: "completed" as StageStatus, output: { score: 0.95 }, retryCount: 0 },
      ];
      const ctx = buildEdgeExpressionContext("spec-review", stages, "feature", 1, "issue-1", "company-1");
      expect(ctx.output).toEqual({ score: 0.95 });
    });

    it("preserves full context alongside output field", () => {
      const stages = [
        { stageId: "validate", status: "completed" as StageStatus, output: { pass: true }, retryCount: 2 },
      ];
      const ctx = buildEdgeExpressionContext("validate", stages, "my-pipeline", 3, "issue-xyz", "co-1");
      expect(ctx.pipeline.name).toBe("my-pipeline");
      expect(ctx.env.company_id).toBe("co-1");
      expect(ctx.stages.validate.retry_count).toBe(2);
    });
  });
});
