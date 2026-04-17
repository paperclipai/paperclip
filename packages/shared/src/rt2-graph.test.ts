import { describe, expect, it } from "vitest";
import {
  LIVE_EVENT_TYPES,
  RT2_GRAPH_CONFIDENCES,
  RT2_GRAPH_EDGE_TYPES,
  RT2_GRAPH_NODE_TYPES,
  listRt2ProjectGraphSchema,
} from "./index.js";
import { listRt2ProjectGraphSchema as validatorsListRt2ProjectGraphSchema } from "./validators/index.js";

describe("RT2 graph shared contracts", () => {
  it("locks the approved node, edge, and confidence values", () => {
    expect(RT2_GRAPH_NODE_TYPES).toEqual(["project", "task", "todo", "daily_wiki_page"]);
    expect(RT2_GRAPH_EDGE_TYPES).toEqual(["project_task", "task_todo", "daily_wiki_task", "task_dependency"]);
    expect(RT2_GRAPH_CONFIDENCES).toEqual(["EXTRACTED", "INFERRED", "AMBIGUOUS"]);
  });

  it("requires a projectId uuid to query a project graph", () => {
    expect(listRt2ProjectGraphSchema.safeParse({ projectId: "not-a-uuid" }).success).toBe(false);
    expect(listRt2ProjectGraphSchema.safeParse({ projectId: "31a9f28a-0fe3-4f0e-ae07-9cf62ad6e9c8" }).success).toBe(true);
  });

  it("registers the RT2 graph live event", () => {
    expect(LIVE_EVENT_TYPES).toContain("rt2.graph.updated");
  });

  it("re-exports the project graph validator from the direct barrel", () => {
    expect(validatorsListRt2ProjectGraphSchema).toBe(listRt2ProjectGraphSchema);
  });
});
