import { describe, it, expect } from "vitest";
import { parsePipeline, validateDAG } from "../dag-parser.js";
import type { PipelineDefinition } from "../types.js";

const validYaml = `
name: feature
description: Full feature development
trigger:
  label: "pipeline:feature"
stages:
  - id: spec-review
    type: classifier
    agent_role: spec-reviewer
    output_schema: spec-review-output
  - id: decompose
    type: classifier
    agent_role: decomposer
    depends_on: [spec-review]
    condition: "stages.\\"spec-review\\".output.status = 'approved'"
    output_schema: decomposition-output
    checkpoint: true
  - id: implement
    type: worker
    agent_role: code-writer
    depends_on: [decompose]
    output_schema: implementation-output
`;

describe("dag-parser", () => {
  describe("parsePipeline", () => {
    it("parses valid YAML into PipelineDefinition", () => {
      const result = parsePipeline(validYaml);
      expect(result.name).toBe("feature");
      expect(result.trigger.label).toBe("pipeline:feature");
      expect(result.stages).toHaveLength(3);
      expect(result.stages[1].depends_on).toEqual(["spec-review"]);
    });

    it("throws on invalid YAML", () => {
      expect(() => parsePipeline(":::invalid")).toThrow();
    });

    it("throws on missing required fields", () => {
      expect(() => parsePipeline("name: test\nstages: []")).toThrow();
    });
  });

  describe("validateDAG", () => {
    it("returns valid for acyclic graph", () => {
      const pipeline = parsePipeline(validYaml);
      const result = validateDAG(pipeline);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("detects cycles", () => {
      const cyclic: PipelineDefinition = {
        name: "cyclic",
        description: "test",
        trigger: { label: "test" },
        stages: [
          { id: "a", type: "worker", depends_on: ["b"] },
          { id: "b", type: "worker", depends_on: ["a"] },
        ],
      };
      const result = validateDAG(cyclic);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("cycle");
    });

    it("detects invalid depends_on references", () => {
      const badRef: PipelineDefinition = {
        name: "bad-ref",
        description: "test",
        trigger: { label: "test" },
        stages: [
          { id: "a", type: "worker", depends_on: ["nonexistent"] },
        ],
      };
      const result = validateDAG(badRef);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("nonexistent");
    });

    it("detects duplicate stage IDs", () => {
      const dupes: PipelineDefinition = {
        name: "dupes",
        description: "test",
        trigger: { label: "test" },
        stages: [
          { id: "a", type: "worker" },
          { id: "a", type: "classifier" },
        ],
      };
      const result = validateDAG(dupes);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("duplicate");
    });
  });
});
