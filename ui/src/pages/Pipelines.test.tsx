import { describe, expect, it } from "vitest";
import { queryKeys } from "../lib/queryKeys";
import {
  getPipelineStageColumnTone,
  pipelineStageAutomationSettingsHref,
} from "../lib/pipeline-stage-presentation";
import {
  buildWorkflowBoardRecords,
  buildWorkflowStressSteps,
  composeWorkflowBoardModel,
  filterWorkflowBoardSteps,
  groupCasesByBuiltFor,
  normalizePipelineConversationComments,
  pipelineBoardGroupByStorageKey,
  readStoredPipelineBoardGroupBy,
  readPipelineStageAutomationAssigneeAgentId,
  WORKFLOW_STRESS_STEP_COUNT,
  reviewWorkflowDraft,
  workflowBoardPanForStep,
  workflowBoardSearchForView,
  workflowBoardViewFromSearch,
  writeStoredPipelineBoardGroupBy,
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
    descendantActiveWorkCount: input.descendantActiveWorkCount ?? 0,
    lastActivityAt: null,
    connections: input.connections ?? { upstreamPipelineIds: [], downstreamPipelineIds: [] },
    createdAt: "2026-07-07T00:00:00.000Z",
    updatedAt: "2026-07-07T00:00:00.000Z",
  };
}

describe("buildWorkflowBoardRecords", () => {
  it("ships the approved Customer Journey sample path with TBD unknowns", () => {
    const model = buildWorkflowBoardRecords([]);
    const customerNames = model.steps.filter((step) => step.view === "customer").map((step) => step.shortName);

    expect(customerNames).toEqual(expect.arrayContaining([
      "Website",
      "Social Media",
      "Cold Outreach",
      "Direct Requests",
      "Newsletter",
      "Past Client Follow-Up",
      "Qualify",
      "Proposal",
      "Production Kickoff",
    ]));
    expect(model.steps.find((step) => step.shortName === "Website")?.ownerName).toBe("_TBD_");
    expect(model.edges.map((edge) => edge.kind)).toEqual(expect.arrayContaining(["trigger", "handoff", "approval", "support", "file", "governance"]));
  });

  it("keeps Business Operations separate from the conversion stages", () => {
    const model = buildWorkflowBoardRecords([
      pipeline({ id: "sales", name: "Sales proposal workflow", connections: { downstreamPipelineIds: ["production"] } }),
      pipeline({ id: "production", name: "Production delivery workflow" }),
      pipeline({ id: "ops", name: "Business reporting workflow" }),
    ]);

    expect(model.steps.find((step) => step.id === "pipeline-sales")?.view).toBe("customer");
    expect(model.steps.find((step) => step.id === "pipeline-production")?.view).toBe("customer");
    expect(model.steps.find((step) => step.id === "pipeline-ops")?.view).toBe("operations");
    expect(model.edges).toContainEqual(expect.objectContaining({
      fromId: "pipeline-sales",
      toId: "pipeline-production",
      kind: "handoff",
      source: "real",
    }));
  });
});

describe("workflow board route view state", () => {
  it("reads verification view aliases from the query string", () => {
    expect(workflowBoardViewFromSearch("?view=customer-journey")).toBe("customer");
    expect(workflowBoardViewFromSearch("?view=business-operations")).toBe("operations");
    expect(workflowBoardViewFromSearch("?view=operations")).toBe("operations");
    expect(workflowBoardViewFromSearch("")).toBe("customer");
  });

  it("writes shareable workflow view query strings without dropping other params", () => {
    expect(workflowBoardSearchForView("?mode=compact", "customer")).toBe("?mode=compact&view=customer-journey");
    expect(workflowBoardSearchForView("?view=customer-journey", "operations")).toBe("?view=business-operations");
  });
});

describe("workflow board verification affordances", () => {
  it("builds a stable 100-step cluster for stress verification", () => {
    const customerSteps = buildWorkflowStressSteps("customer");
    const operationsSteps = buildWorkflowStressSteps("operations");

    expect(customerSteps).toHaveLength(WORKFLOW_STRESS_STEP_COUNT);
    expect(operationsSteps).toHaveLength(WORKFLOW_STRESS_STEP_COUNT);
    expect(customerSteps.every((step) => step.view === "customer")).toBe(true);
    expect(operationsSteps.every((step) => step.view === "operations")).toBe(true);
    expect(new Set(customerSteps.map((step) => step.stage))).toEqual(new Set(["demand", "sales", "production"]));
    expect(new Set(operationsSteps.map((step) => step.stage))).toEqual(
      new Set(["support", "tools", "governance", "reporting", "manual", "agent"]),
    );
  });

  it("filters the board search independently of the global command palette", () => {
    const model = buildWorkflowBoardRecords([
      pipeline({ id: "ops", name: "Business reporting workflow" }),
    ]);

    expect(filterWorkflowBoardSteps(model.steps, "qualify").map((step) => step.shortName)).toContain("Qualify");
    expect(filterWorkflowBoardSteps(model.steps, "reporting").map((step) => step.shortName)).toEqual(
      expect.arrayContaining(["Operating Report", "Business reporting workflow"]),
    );
  });

  it("recenters the selected step from the same calculation used by search focus", () => {
    const pan = workflowBoardPanForStep({ x: 570, y: 190 }, 0.78);
    expect(pan.x).toBeCloseTo(-84.6);
    expect(pan.y).toBeCloseTo(71.8);
    expect(workflowBoardPanForStep({ x: 100, y: 200 }, 1, { x: 500, y: 300 })).toEqual({ x: 400, y: 100 });
  });
});

describe("workflow draft/live review model", () => {
  it("applies layout positions without creating a semantic draft", () => {
    const base = buildWorkflowBoardRecords([]);
    const model = composeWorkflowBoardModel(
      base,
      { steps: [], edges: [] },
      { steps: [], edges: [] },
      { positions: { "seed-website": { x: 321, y: 654 } }, panByView: { customer: undefined, operations: undefined }, zoomByView: { customer: undefined, operations: undefined } },
    );

    expect(model.hasDraft).toBe(false);
    expect(model.steps.find((step) => step.id === "seed-website")).toMatchObject({ x: 321, y: 654 });
  });

  it("treats persisted coordinate-only draft steps as auto-saved layout", () => {
    const base = buildWorkflowBoardRecords([]);
    const movedStep = { ...base.steps.find((step) => step.id === "seed-website")!, x: 222, y: 333, source: "local" as const };
    const model = composeWorkflowBoardModel(
      base,
      { steps: [], edges: [] },
      { steps: [movedStep], edges: [] },
      { positions: {}, panByView: { customer: undefined, operations: undefined }, zoomByView: { customer: undefined, operations: undefined } },
    );

    expect(model.hasDraft).toBe(false);
    expect(model.steps.find((step) => step.id === "seed-website")).toMatchObject({ x: 222, y: 333 });
  });

  it("keeps semantic edits as a draft overlay until promotion", () => {
    const base = buildWorkflowBoardRecords([]);
    const draftStep = { ...base.steps.find((step) => step.id === "seed-qualify")!, ownerName: "Sales Agent", source: "local" as const };
    const model = composeWorkflowBoardModel(
      base,
      { steps: [], edges: [] },
      { steps: [draftStep], edges: [] },
      { positions: {}, panByView: { customer: undefined, operations: undefined }, zoomByView: { customer: undefined, operations: undefined } },
    );

    expect(model.hasDraft).toBe(true);
    expect(model.steps.find((step) => step.id === "seed-qualify")?.ownerName).toBe("Sales Agent");
    expect(base.steps.find((step) => step.id === "seed-qualify")?.ownerName).toBe("_TBD_");
  });

  it("blocks promotion when review finds a broken edge or unapproved tool", () => {
    const base = buildWorkflowBoardRecords([]);
    const review = reviewWorkflowDraft(
      [
        ...base.steps,
        { ...base.steps[0]!, id: "tool-step", shortName: "Tool Step", knowledgeSources: "tool:unknown-root" },
      ],
      [...base.edges, { id: "broken", fromId: "seed-website", toId: "missing-step", kind: "handoff", label: "broken handoff", source: "local" }],
    );

    expect(review.ok).toBe(false);
    expect(review.issues).toEqual(expect.arrayContaining([
      expect.stringContaining("missing-step"),
      expect.stringContaining("tool:unknown-root"),
    ]));
  });

  it("allows clean promotion candidates with resolved trigger and approval gates", () => {
    const base = buildWorkflowBoardRecords([]);
    const review = reviewWorkflowDraft(base.steps, base.edges);

    expect(review).toEqual({ ok: true, issues: [] });
  });
});

describe("groupCasesByBuiltFor", () => {
  it("groups items by the parent case shown as Built for", () => {
    const groups = groupCasesByBuiltFor([
      {
        id: "child-1",
        pipelineId: "content-pipeline",
        stageId: "stage-1",
        title: "API how-to",
        parentCase: {
          case: {
            id: "parent-1",
            caseKey: "feature-checkboxes",
            title: "Checkbox confirmation interactions",
            pipelineId: "features-pipeline",
          },
          pipeline: { id: "features-pipeline", key: "features", name: "Example Features" },
        },
      },
      {
        id: "child-2",
        pipelineId: "content-pipeline",
        stageId: "stage-1",
        title: "Screencast",
        parentCase: {
          case: {
            id: "parent-1",
            caseKey: "feature-checkboxes",
            title: "Checkbox confirmation interactions",
            pipelineId: "features-pipeline",
          },
          pipeline: { id: "features-pipeline", key: "features", name: "Example Features" },
        },
      },
      {
        id: "standalone",
        pipelineId: "content-pipeline",
        stageId: "stage-1",
        title: "Launch blog post",
        parentCase: null,
      },
    ]);

    expect(groups).toEqual([
      {
        key: "parent-1",
        label: "Example Features: Checkbox confirmation interactions",
        href: "/pipelines/features-pipeline/items/parent-1",
        cases: [expect.objectContaining({ id: "child-1" }), expect.objectContaining({ id: "child-2" })],
      },
      {
        key: "__ungrouped",
        label: "No built-for item",
        href: null,
        cases: [expect.objectContaining({ id: "standalone" })],
      },
    ]);
  });
});

describe("pipeline board group preference", () => {
  it("stores the selected grouping per pipeline", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    writeStoredPipelineBoardGroupBy("pipeline-1", "builtFor", storage);
    writeStoredPipelineBoardGroupBy("pipeline-2", "none", storage);

    expect(pipelineBoardGroupByStorageKey("pipeline-1")).toBe("paperclip.pipelineBoard.groupBy.pipeline-1");
    expect(readStoredPipelineBoardGroupBy("pipeline-1", storage)).toBe("builtFor");
    expect(readStoredPipelineBoardGroupBy("pipeline-2", storage)).toBe("none");
    expect(readStoredPipelineBoardGroupBy("missing", storage)).toBe("none");
  });

  it("falls back to no grouping when storage is unavailable or contains stale values", () => {
    expect(readStoredPipelineBoardGroupBy("pipeline-1", null)).toBe("none");
    expect(readStoredPipelineBoardGroupBy("pipeline-1", { getItem: () => "stage" })).toBe("none");
    expect(readStoredPipelineBoardGroupBy("pipeline-1", { getItem: () => { throw new Error("blocked"); } })).toBe("none");
  });
});

describe("readPipelineStageAutomationAssigneeAgentId", () => {
  it("reads the agent assigned to saved stage automation", () => {
    expect(readPipelineStageAutomationAssigneeAgentId({
      config: {
        automation: {
          assigneeAgentId: " agent-1 ",
        },
      },
    })).toBe("agent-1");
  });

  it("keeps legacy top-level assignee configs visible", () => {
    expect(readPipelineStageAutomationAssigneeAgentId({
      config: {
        assigneeAgentId: "agent-legacy",
      },
    })).toBe("agent-legacy");
  });

  it("ignores stages without an agent automation assignee", () => {
    expect(readPipelineStageAutomationAssigneeAgentId({ config: null })).toBeNull();
    expect(readPipelineStageAutomationAssigneeAgentId({ config: { automation: { assigneeAgentId: " " } } })).toBeNull();
  });
});

describe("pipeline stage board presentation", () => {
  it("links automation chips to the stage automation settings section", () => {
    expect(pipelineStageAutomationSettingsHref("pipeline-1", "stage-1")).toBe(
      "/pipelines/pipeline-1/settings?stage=stage-1&section=instructions",
    );
  });

  it("uses type-aware column outlines and backgrounds", () => {
    expect(getPipelineStageColumnTone("working").outer).toContain("border-border");
    expect(getPipelineStageColumnTone("review").outer).toContain("violet");
    expect(getPipelineStageColumnTone("in_review").body).toContain("violet");
    expect(getPipelineStageColumnTone("done").outer).toContain("green");
    expect(getPipelineStageColumnTone("cancelled").outer).toContain("bg-muted/25");
    expect(getPipelineStageColumnTone("cancelled").outer).toContain("opacity-85");
  });
});

describe("pipeline conversation comments", () => {
  it("uses a finite comments key that does not collide with issue detail's infinite comments key", () => {
    expect(queryKeys.issues.commentsList("issue-1")).toEqual(["issues", "comments", "issue-1", "list"]);
    expect(queryKeys.issues.commentsList("issue-1")).not.toEqual(queryKeys.issues.comments("issue-1"));
    expect(queryKeys.issues.commentsList("issue-1").slice(0, 3)).toEqual(queryKeys.issues.comments("issue-1"));
  });

  it("ignores infinite-query comment cache data instead of mapping it as an array", () => {
    expect(
      normalizePipelineConversationComments({
        pages: [[{ id: "comment-1", body: "hello" }]],
        pageParams: [null],
      }),
    ).toEqual([]);
  });
});
