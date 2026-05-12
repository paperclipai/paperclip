import { describe, it, expect } from "vitest";
import {
  getIncomingEdges,
  getOutgoingEdges,
  getForwardEdges,
  getErrorEdges,
  buildAdjacencyFromEdges,
  getRootStageIds,
} from "../edge-utils.js";
import type { EdgeDefinition } from "../types.js";

const edges: EdgeDefinition[] = [
  { id: "e1", from: "start", to: "middle" },
  { id: "e2", from: "middle", to: "end" },
  { id: "e3", from: "middle", to: "error-handler", type: "error" },
  { id: "e4", from: "end", to: "finish", type: "default" },
];

describe("edge-utils", () => {
  describe("getIncomingEdges", () => {
    it("returns edges pointing to the given stage, excluding error edges", () => {
      const incoming = getIncomingEdges("middle", edges);
      expect(incoming).toHaveLength(1);
      expect(incoming[0].id).toBe("e1");
    });

    it("excludes error edges even if they point to the stage", () => {
      const incoming = getIncomingEdges("error-handler", edges);
      expect(incoming).toHaveLength(0);
    });

    it("returns empty array for a stage with no incoming edges", () => {
      const incoming = getIncomingEdges("start", edges);
      expect(incoming).toHaveLength(0);
    });
  });

  describe("getOutgoingEdges", () => {
    it("returns all edges from the given stage including error edges", () => {
      const outgoing = getOutgoingEdges("middle", edges);
      expect(outgoing).toHaveLength(2);
      expect(outgoing.map((e) => e.id).sort()).toEqual(["e2", "e3"]);
    });

    it("returns empty array for a stage with no outgoing edges", () => {
      const outgoing = getOutgoingEdges("finish", edges);
      expect(outgoing).toHaveLength(0);
    });
  });

  describe("getForwardEdges", () => {
    it("excludes edges with type='error'", () => {
      const forward = getForwardEdges(edges);
      expect(forward.every((e) => e.type !== "error")).toBe(true);
      expect(forward).toHaveLength(3);
    });

    it("includes edges with no type (default forward)", () => {
      const forward = getForwardEdges(edges);
      expect(forward.find((e) => e.id === "e1")).toBeTruthy();
    });
  });

  describe("getErrorEdges", () => {
    it("returns only error-type edges", () => {
      const errorEdges = getErrorEdges(edges);
      expect(errorEdges).toHaveLength(1);
      expect(errorEdges[0].id).toBe("e3");
    });

    it("returns empty when no error edges exist", () => {
      const noError: EdgeDefinition[] = [{ id: "x", from: "a", to: "b" }];
      expect(getErrorEdges(noError)).toHaveLength(0);
    });
  });

  describe("buildAdjacencyFromEdges", () => {
    it("builds a map of from -> [to] using forward edges only", () => {
      const adj = buildAdjacencyFromEdges(edges);
      expect(adj.get("start")).toEqual(["middle"]);
      expect(adj.get("middle")).toEqual(["end"]);
      expect(adj.get("end")).toEqual(["finish"]);
      // error edge should be excluded
      expect(adj.get("middle")).not.toContain("error-handler");
    });

    it("returns empty map for empty edges", () => {
      const adj = buildAdjacencyFromEdges([]);
      expect(adj.size).toBe(0);
    });
  });

  describe("getRootStageIds", () => {
    it("returns stages with no incoming forward edges", () => {
      const stageIds = ["start", "middle", "end", "finish", "error-handler"];
      const roots = getRootStageIds(stageIds, edges);
      expect(roots).toContain("start");
      expect(roots).not.toContain("middle");
      expect(roots).not.toContain("end");
      expect(roots).not.toContain("finish");
    });

    it("includes error-handler since it only receives error edges (not forward)", () => {
      const stageIds = ["start", "middle", "error-handler"];
      const roots = getRootStageIds(stageIds, edges);
      expect(roots).toContain("error-handler");
    });

    it("returns all stages when there are no edges", () => {
      const stageIds = ["a", "b", "c"];
      const roots = getRootStageIds(stageIds, []);
      expect(roots).toEqual(["a", "b", "c"]);
    });
  });
});
