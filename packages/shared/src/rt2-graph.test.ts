import { describe, expect, it } from "vitest";
import {
  LIVE_EVENT_TYPES,
  RT2_CORPUS_GRAPH_EDGE_TYPES,
  RT2_CORPUS_GRAPH_NODE_TYPES,
  RT2_CORPUS_GRAPH_SOURCE_TYPES,
  RT2_GRAPH_CONFIDENCES,
  RT2_GRAPH_EDGE_TYPES,
  RT2_GRAPH_NODE_TYPES,
  getRt2CorpusGraphShortestPathSchema,
  ingestRt2CorpusGraphSchema,
  listRt2ProjectGraphSchema,
} from "./index.js";
import {
  ingestRt2CorpusGraphSchema as validatorsIngestRt2CorpusGraphSchema,
  listRt2ProjectGraphSchema as validatorsListRt2ProjectGraphSchema,
} from "./validators/index.js";

describe("RT2 graph shared contracts", () => {
  it("locks the approved node, edge, and confidence values", () => {
    expect(RT2_GRAPH_NODE_TYPES).toEqual(["project", "task", "todo", "daily_wiki_page", "deliverable", "actor", "event"]);
    expect(RT2_GRAPH_EDGE_TYPES).toEqual([
      "project_task",
      "task_todo",
      "daily_wiki_task",
      "task_dependency",
      "task_deliverable",
      "project_deliverable",
      "project_daily_wiki_page",
      "project_event",
      "actor_event",
      "event_entity",
    ]);
    expect(RT2_GRAPH_CONFIDENCES).toEqual(["EXTRACTED", "INFERRED", "AMBIGUOUS"]);
  });

  it("locks the approved corpus graph values", () => {
    expect(RT2_CORPUS_GRAPH_SOURCE_TYPES).toEqual(["repo_file", "doc_file", "wiki_page", "external_reference"]);
    expect(RT2_CORPUS_GRAPH_NODE_TYPES).toEqual(["source_file", "heading", "symbol", "term"]);
    expect(RT2_CORPUS_GRAPH_EDGE_TYPES).toEqual(["contains", "imports", "references", "mentions", "shared_concept"]);
  });

  it("requires a projectId uuid to query a project graph", () => {
    expect(listRt2ProjectGraphSchema.safeParse({ projectId: "not-a-uuid" }).success).toBe(false);
    expect(listRt2ProjectGraphSchema.safeParse({ projectId: "31a9f28a-0fe3-4f0e-ae07-9cf62ad6e9c8" }).success).toBe(true);
  });

  it("validates corpus graph ingest and query defaults", () => {
    const ingest = ingestRt2CorpusGraphSchema.safeParse({
      sources: [{
        sourceKey: "doc/graph.md",
        sourceType: "doc_file",
        content: "# Graphify\n\nJarvis uses corpus graph memory.",
        sourceLocation: { path: "doc/graph.md" },
      }],
    });
    expect(ingest.success).toBe(true);
    if (ingest.success) {
      expect(ingest.data.rebuildReport).toBe(true);
    }

    const pathQuery = getRt2CorpusGraphShortestPathSchema.parse({
      fromNodeKey: "source:doc/a.md",
      toNodeKey: "source:doc/b.md",
    });
    expect(pathQuery.maxDepth).toBe(12);
  });

  it("registers the RT2 graph live event", () => {
    expect(LIVE_EVENT_TYPES).toContain("rt2.graph.updated");
  });

  it("re-exports the project graph validator from the direct barrel", () => {
    expect(validatorsListRt2ProjectGraphSchema).toBe(listRt2ProjectGraphSchema);
    expect(validatorsIngestRt2CorpusGraphSchema).toBe(ingestRt2CorpusGraphSchema);
  });
});
