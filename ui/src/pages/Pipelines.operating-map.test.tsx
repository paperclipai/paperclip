import { describe, expect, it } from "vitest";
import {
  buildPipelineOperatingMapModel,
  classifyPipelineOperatingArea,
} from "./Pipelines";
import type { PipelineListItem } from "../api/pipelines";

function pipeline(input: Partial<PipelineListItem> & Pick<PipelineListItem, "id" | "name">): PipelineListItem {
  return {
    id: input.id,
    companyId: "company-1",
    key: input.key ?? input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    name: input.name,
    description: input.description ?? null,
    projectId: null,
    enforceTransitions: false,
    archivedAt: null,
    stageCount: 0,
    stages: [],
    openCaseCount: input.openCaseCount ?? 0,
    attentionCount: input.attentionCount ?? 0,
    inMotionCount: input.inMotionCount ?? 0,
    descendantActiveWorkCount: 0,
    lastActivityAt: null,
    connections: input.connections ?? { upstreamPipelineIds: [], downstreamPipelineIds: [] },
    createdAt: "2026-07-07T00:00:00.000Z",
    updatedAt: "2026-07-07T00:00:00.000Z",
  };
}

describe("pipeline operating map model", () => {
  it("assigns each workflow to one operating area and preserves unclassified workflows", () => {
    const demand = pipeline({ id: "demand", name: "Demand generation content engine" });
    const sales = pipeline({ id: "sales", name: "Sales proposal review" });
    const production = pipeline({ id: "production", name: "Production delivery board" });
    const ops = pipeline({ id: "ops", name: "Weekly Business Review" });
    const unknown = pipeline({ id: "unknown", name: "Inbox cleanup" });

    expect(classifyPipelineOperatingArea(demand)).toBe("demand_generation");
    expect(classifyPipelineOperatingArea(sales)).toBe("sales");
    expect(classifyPipelineOperatingArea(production)).toBe("production");
    expect(classifyPipelineOperatingArea(ops)).toBe("business_operations");
    expect(classifyPipelineOperatingArea(unknown)).toBe("unclassified");

    const model = buildPipelineOperatingMapModel([demand, sales, production, ops, unknown]);
    expect(model.areas.flatMap((area) => area.nodes).map((node) => node.pipeline.id).sort()).toEqual([
      "demand",
      "ops",
      "production",
      "sales",
      "unknown",
    ]);
    expect(model.areas.find((area) => area.area === "unclassified")?.nodes.map((node) => node.pipeline.id)).toEqual([
      "unknown",
    ]);
  });

  it("builds explainable value-stream and support edges from generated connection metadata", () => {
    const demand = pipeline({
      id: "demand",
      name: "Lead generation workflow",
      connections: { downstreamPipelineIds: ["sales"] },
    });
    const sales = pipeline({
      id: "sales",
      name: "Sales opportunity workflow",
      connections: { upstreamPipelineIds: ["demand"], downstreamPipelineIds: ["production"] },
    });
    const production = pipeline({ id: "production", name: "Production delivery workflow" });
    const ops = pipeline({
      id: "ops",
      name: "Business operations QA",
      connections: { downstreamPipelineIds: ["production"], relationship: "support" },
    });

    const model = buildPipelineOperatingMapModel([demand, sales, production, ops]);

    expect(model.edges.map((edge) => [edge.fromId, edge.toId, edge.kind])).toEqual([
      ["demand", "sales", "output"],
      ["ops", "production", "support"],
      ["sales", "production", "output"],
    ]);
    expect(model.edges.every((edge) => edge.explanation.length > 0)).toBe(true);
  });

  it("clusters a 100-workflow dataset instead of rendering every card", () => {
    const workflows = Array.from({ length: 100 }, (_, index) =>
      pipeline({
        id: `workflow-${index}`,
        name: `Demand generation campaign ${index}`,
      }),
    );

    const model = buildPipelineOperatingMapModel(workflows);
    const demandArea = model.areas.find((area) => area.area === "demand_generation")!;

    expect(demandArea.nodes).toHaveLength(100);
    expect(demandArea.visibleNodes).toHaveLength(9);
    expect(demandArea.clusteredCount).toBe(91);
  });
});
