import { describe, expect, it } from "vitest";
import { knowledgeGraphTestUtils } from "../src/ui/app.js";

const node = (
  id: string,
  kind: "company" | "space" | "project" | "issue" | "agent" | "document" | "wiki_page",
  status: string | null,
  metadata: Record<string, unknown> = {},
) => ({
  id,
  kind,
  label: id,
  sublabel: null,
  status,
  group: null,
  href: null,
  weight: 1,
  updatedAt: null,
  metadata,
});

const graphData = {
  status: "ok" as const,
  checkedAt: "2026-07-10T00:00:00.000Z",
  wikiId: "wiki-1",
  space: {
    id: "space-1",
    slug: "default",
    displayName: "Company wiki",
    bindingKind: "company",
    projectId: null,
  },
  scope: { kind: "company" as const, projectId: null, projectName: null },
  nodes: [
    node("company:1", "company", null),
    node("space:1", "space", "active"),
    node("project:1", "project", "in_progress", { projectId: "1" }),
    node("issue:active", "issue", "in_review", { projectId: "1" }),
    node("issue:done", "issue", "done", { projectId: "1" }),
    node("agent:active", "agent", "running"),
    node("agent:former", "agent", "terminated"),
    node("document:1", "document", null, { projectId: "1" }),
    node("wiki:1", "wiki_page", null),
  ],
  edges: [
    { id: "edge:active", from: "project:1", to: "issue:active", kind: "project_issue" as const, label: null, weight: 1, metadata: {} },
    { id: "edge:done", from: "project:1", to: "issue:done", kind: "project_issue" as const, label: null, weight: 1, metadata: {} },
    { id: "edge:doc", from: "issue:active", to: "document:1", kind: "documents" as const, label: null, weight: 1, metadata: {} },
  ],
  stats: {
    nodes: 9,
    edges: 3,
    wikiPages: 1,
    issues: 2,
    projects: 1,
    agents: 2,
    documents: 1,
    workProducts: 0,
    references: 0,
  },
  warnings: [],
};

describe("knowledge graph layout", () => {
  it("keeps history and document-heavy data out of the default active view", () => {
    const layout = knowledgeGraphTestUtils.buildKnowledgeGraphLayout(graphData, {
      enabledKinds: new Set(["project", "issue", "wiki_page", "agent", "source"]),
      query: "",
      selectedNodeId: null,
      showHistory: false,
    });

    expect(layout.nodes.map((entry) => entry.id)).toEqual(expect.arrayContaining([
      "company:1",
      "space:1",
      "project:1",
      "issue:active",
      "agent:active",
      "wiki:1",
    ]));
    expect(layout.nodes.map((entry) => entry.id)).not.toEqual(expect.arrayContaining([
      "issue:done",
      "agent:former",
      "document:1",
    ]));
    expect(layout.edges.map((edge) => edge.id)).toEqual(["edge:active"]);
  });

  it("shows historical and document nodes only when the operator opts in", () => {
    const layout = knowledgeGraphTestUtils.buildKnowledgeGraphLayout(graphData, {
      enabledKinds: new Set(["project", "issue", "wiki_page", "agent", "document"]),
      query: "",
      selectedNodeId: null,
      showHistory: true,
    });

    expect(layout.nodes.map((entry) => entry.id)).toEqual(expect.arrayContaining([
      "issue:done",
      "agent:former",
      "document:1",
    ]));
    expect(layout.edges.every((edge) => graphData.edges.some((sourceEdge) => sourceEdge.id === edge.id))).toBe(true);
  });

  it("fits visible nodes inside the graph viewport with stable padding", () => {
    const layout = knowledgeGraphTestUtils.buildKnowledgeGraphLayout(graphData, {
      enabledKinds: new Set(["project", "issue", "wiki_page", "agent"]),
      query: "",
      selectedNodeId: null,
      showHistory: false,
    });
    const viewport = knowledgeGraphTestUtils.fitKnowledgeGraphViewport(layout.nodes);
    const transformed = layout.nodes.flatMap((entry) => [
      { x: (entry.x - entry.radius) * viewport.scale + viewport.x, y: (entry.y - entry.radius) * viewport.scale + viewport.y },
      { x: (entry.x + entry.radius) * viewport.scale + viewport.x, y: (entry.y + entry.radius) * viewport.scale + viewport.y },
    ]);

    expect(Math.min(...transformed.map((point) => point.x))).toBeGreaterThanOrEqual(7.9);
    expect(Math.max(...transformed.map((point) => point.x))).toBeLessThanOrEqual(92.1);
    expect(Math.min(...transformed.map((point) => point.y))).toBeGreaterThanOrEqual(7.9);
    expect(Math.max(...transformed.map((point) => point.y))).toBeLessThanOrEqual(92.1);
  });
});
