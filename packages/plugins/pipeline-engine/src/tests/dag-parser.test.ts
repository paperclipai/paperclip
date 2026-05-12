import { describe, it, expect } from "vitest";
import { parsePipeline, validateDAG } from "../dag-parser.js";
import type { PipelineDefinition } from "../types.js";

const validJson = JSON.stringify({
  name: "feature",
  description: "Full feature development",
  trigger: { label: "pipeline:feature" },
  stages: [
    { id: "spec-review", type: "stage", agent_role: "spec-reviewer", output_schema: "spec-review-output" },
    { id: "decompose", type: "stage", agent_role: "decomposer", output_schema: "decomposition-output" },
    { id: "implement", type: "stage", agent_role: "code-writer" },
  ],
  edges: [
    { id: "e1", from: "spec-review", to: "decompose", sourceHandle: "approved" },
    { id: "e2", from: "decompose", to: "implement" },
  ],
  positions: {
    "spec-review": { x: 0, y: 0 },
    decompose: { x: 200, y: 0 },
    implement: { x: 400, y: 0 },
  },
});

describe("dag-parser", () => {
  describe("parsePipeline", () => {
    it("parses valid JSON into PipelineDefinition", () => {
      const result = parsePipeline(validJson);
      expect(result.name).toBe("feature");
      expect(result.trigger.label).toBe("pipeline:feature");
      expect(result.stages).toHaveLength(3);
      expect(result.edges).toHaveLength(2);
      expect(result.edges[0].from).toBe("spec-review");
      expect(result.edges[0].to).toBe("decompose");
    });

    it("throws on invalid JSON", () => {
      expect(() => parsePipeline(":::invalid")).toThrow(/Invalid JSON/);
    });

    it("throws on missing name", () => {
      const json = JSON.stringify({ trigger: { label: "x" }, stages: [{ id: "a" }], edges: [] });
      expect(() => parsePipeline(json)).toThrow(/name/);
    });

    it("throws on missing trigger", () => {
      const json = JSON.stringify({ name: "test", stages: [{ id: "a" }], edges: [] });
      expect(() => parsePipeline(json)).toThrow(/trigger/);
    });

    it("throws on missing or empty stages", () => {
      const json = JSON.stringify({ name: "test", trigger: { label: "x" }, stages: [], edges: [] });
      expect(() => parsePipeline(json)).toThrow(/stage/);
    });

    it("throws on missing edges field", () => {
      const json = JSON.stringify({ name: "test", trigger: { label: "x" }, stages: [{ id: "a" }] });
      expect(() => parsePipeline(json)).toThrow(/edges/);
    });

    it("defaults positions to empty object when not provided", () => {
      const json = JSON.stringify({
        name: "test",
        trigger: { label: "x" },
        stages: [{ id: "a", type: "stage", agent_role: "r" }],
        edges: [],
      });
      const result = parsePipeline(json);
      expect(result.positions).toEqual({});
    });
  });

  describe("validateDAG", () => {
    it("returns valid for acyclic graph", () => {
      const pipeline = parsePipeline(validJson);
      const result = validateDAG(pipeline);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("detects cycles in forward edges", () => {
      const cyclic: PipelineDefinition = {
        name: "cyclic",
        description: "test",
        trigger: { label: "test" },
        stages: [
          { id: "a", type: "stage", agent_role: "x" },
          { id: "b", type: "stage", agent_role: "x" },
        ],
        edges: [
          { id: "e1", from: "a", to: "b" },
          { id: "e2", from: "b", to: "a" },
        ],
        positions: {},
      };
      const result = validateDAG(cyclic);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("cycle");
    });

    it("does not flag error edges as cycle contributors", () => {
      const withErrorEdge: PipelineDefinition = {
        name: "test",
        description: "",
        trigger: { label: "test" },
        stages: [
          { id: "a", type: "stage", agent_role: "x" },
          { id: "b", type: "stage", agent_role: "x" },
        ],
        edges: [
          { id: "e1", from: "a", to: "b" },
          { id: "e2", from: "b", to: "a", type: "error" }, // error edge going back — should not cause cycle error
        ],
        positions: {},
      };
      const result = validateDAG(withErrorEdge);
      expect(result.valid).toBe(true);
    });

    it("detects dangling edge source references", () => {
      const badRef: PipelineDefinition = {
        name: "bad-ref",
        description: "test",
        trigger: { label: "test" },
        stages: [{ id: "a", type: "stage", agent_role: "x" }],
        edges: [{ id: "e1", from: "nonexistent", to: "a" }],
        positions: {},
      };
      const result = validateDAG(badRef);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("nonexistent");
    });

    it("detects dangling edge target references", () => {
      const badRef: PipelineDefinition = {
        name: "bad-ref",
        description: "test",
        trigger: { label: "test" },
        stages: [{ id: "a", type: "stage", agent_role: "x" }],
        edges: [{ id: "e1", from: "a", to: "nonexistent" }],
        positions: {},
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
          { id: "a", type: "stage", agent_role: "x" },
          { id: "a", type: "stage", agent_role: "y" },
        ],
        edges: [],
        positions: {},
      };
      const result = validateDAG(dupes);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("duplicate");
    });

    it("detects duplicate edge IDs", () => {
      const dupeEdges: PipelineDefinition = {
        name: "dupe-edges",
        description: "test",
        trigger: { label: "test" },
        stages: [
          { id: "a", type: "stage", agent_role: "x" },
          { id: "b", type: "stage", agent_role: "x" },
        ],
        edges: [
          { id: "e1", from: "a", to: "b" },
          { id: "e1", from: "a", to: "b" },
        ],
        positions: {},
      };
      const result = validateDAG(dupeEdges);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("duplicate edge"))).toBe(true);
    });
  });
});
