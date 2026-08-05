import { describe, expect, it } from "vitest";
import { queryKeys } from "../lib/queryKeys";
import {
  buildPipelineBoardPresentation,
  derivePipelineItemDetailActions,
  deriveStagePresentationRole,
  getPipelineBoardStateChip,
  getPipelineStageColumnTone,
  pipelineStageAutomationSettingsHref,
  type PipelineDetailActionInputs,
} from "../lib/pipeline-stage-presentation";
import {
  groupCasesByBuiltFor,
  normalizePipelineConversationComments,
  pipelineBoardStateChipClass,
  pipelineBoardGroupByStorageKey,
  readStoredPipelineBoardGroupBy,
  readPipelineStageAutomationAssigneeAgentId,
  writeStoredPipelineBoardGroupBy,
} from "./Pipelines";

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

  it("collapses action stages into downstream visible lanes on the default board", () => {
    const stages = [
      { id: "intake", pipelineId: "pipeline-1", key: "intake", name: "Intake", kind: "working", position: 100, config: {} },
      { id: "run", pipelineId: "pipeline-1", key: "run", name: "Run automation", kind: "working", position: 200, config: { onEnter: { type: "run_routine" } } },
      { id: "review", pipelineId: "pipeline-1", key: "review", name: "Review", kind: "review", position: 300, config: {} },
      { id: "done", pipelineId: "pipeline-1", key: "done", name: "Done", kind: "done", position: 900, config: {} },
    ];

    expect(deriveStagePresentationRole(stages[1])).toBe("action");

    const board = buildPipelineBoardPresentation({
      orderedStages: stages,
      cases: [
        { id: "case-run", stageId: "run", pipelineId: "pipeline-1", title: "Running action" },
        { id: "case-done", stageId: "done", pipelineId: "pipeline-1", title: "Finished", terminalKind: "done" },
      ],
      transitions: [{ fromStageId: "run", toStageId: "review" }],
      configuredView: false,
      unassignedStage: { id: "__unassigned", pipelineId: "pipeline-1", key: "__unassigned", name: "Unassigned", kind: "working", position: 999, config: {} },
    });

    expect(board.columns.map((stage) => stage.id)).toEqual(["intake", "review"]);
    expect(board.byStage.get("review")?.map((caseItem) => caseItem.id)).toEqual(["case-run"]);
    expect(board.terminalRails.find((rail) => rail.key === "done")?.cases.map((caseItem) => caseItem.id)).toEqual(["case-done"]);
  });

  it("keeps every configured stage visible in configured-stage view", () => {
    const stages = [
      { id: "intake", pipelineId: "pipeline-1", key: "intake", name: "Intake", kind: "working", position: 100, config: {} },
      { id: "run", pipelineId: "pipeline-1", key: "run", name: "Run automation", kind: "working", position: 200, config: { breakdown: { targetPipelineId: "child" } } },
      { id: "done", pipelineId: "pipeline-1", key: "done", name: "Done", kind: "done", position: 900, config: {} },
    ];

    const board = buildPipelineBoardPresentation({
      orderedStages: stages,
      cases: [{ id: "case-run", stageId: "run", pipelineId: "pipeline-1", title: "Running action" }],
      transitions: [],
      configuredView: true,
      unassignedStage: { id: "__unassigned", pipelineId: "pipeline-1", key: "__unassigned", name: "Unassigned", kind: "working", position: 999, config: {} },
    });

    expect(board.columns.map((stage) => stage.id)).toEqual(["intake", "run", "done"]);
    expect(board.byStage.get("run")?.map((caseItem) => caseItem.id)).toEqual(["case-run"]);
  });

  it("derives the approved single state chip priority", () => {
    expect(getPipelineBoardStateChip({
      caseItem: { id: "done", stageId: "done", terminalKind: "done" },
      stage: { kind: "done", config: {} },
    })).toMatchObject({ key: "done", label: "Done" });
    expect(getPipelineBoardStateChip({
      caseItem: { id: "running", stageId: "work", activeWork: { issueId: "issue-1" } },
      stage: { kind: "working", config: {} },
    })).toMatchObject({ key: "running", label: "Running" });
    expect(getPipelineBoardStateChip({
      caseItem: { id: "outputs", stageId: "work", outputSummary: { outputCount: 2, latestOutputAt: "2026-06-30T00:00:00.000Z" } },
      stage: { kind: "working", config: {} },
    })).toMatchObject({ key: "output_ready", label: "Output ready" });
    expect(getPipelineBoardStateChip({
      caseItem: { id: "children", stageId: "work", childCount: 3, terminalChildCount: 1 },
      stage: { kind: "working", config: { requireChildrenTerminal: true } },
    })).toMatchObject({ key: "waiting_on_children", label: "Waiting on 2 of 3 children" });
    expect(getPipelineBoardStateChip({
      caseItem: { id: "attention", stageId: "work", fields: { openBlockers: 1 } },
      stage: { kind: "working", config: {} },
    })).toMatchObject({ key: "attention", label: "Needs attention", tone: "attention" });
    expect(pipelineBoardStateChipClass("attention")).toBe("pipeline-state-chip--attention");
  });

  it("enables the detail action strip per stage, terminal, active-work, and preflight state", () => {
    const base: PipelineDetailActionInputs = {
      hasStageAutomation: true,
      rerunPending: false,
      rerunBlockedByPermission: false,
      stageKind: "working",
      hasActiveWork: false,
      previousRetryAllowed: true,
      retryPending: false,
      canCancel: true,
      cancelPending: false,
    };

    // Healthy working stage: overflow Run + Redo plus inline Edit + Cancel are enabled.
    const healthy = derivePipelineItemDetailActions(base);
    expect(healthy.run.disabled).toBe(false);
    expect(healthy.redo.disabled).toBe(false);
    expect(healthy.edit.disabled).toBe(false);
    expect(healthy.cancel.disabled).toBe(false);

    // Active work blocks Run; no previous retry plan blocks Redo.
    const busy = derivePipelineItemDetailActions({ ...base, hasActiveWork: true, previousRetryAllowed: false });
    expect(busy.run.disabled).toBe(true);
    expect(busy.redo.disabled).toBe(true);

    // Permission preflight failure disables Run and surfaces the reason.
    const blocked = derivePipelineItemDetailActions({ ...base, rerunBlockedByPermission: true });
    expect(blocked.run.disabled).toBe(true);
    expect(blocked.run.reason).toContain("Permission");

    // Review stage still disables Run in the strip; the Review panel owns decisions.
    const review = derivePipelineItemDetailActions({
      ...base,
      hasStageAutomation: false,
      stageKind: "review",
    });
    expect(review.run.disabled).toBe(true);

    // No cancellable stage disables Cancel.
    expect(derivePipelineItemDetailActions({ ...base, canCancel: false }).cancel.disabled).toBe(true);
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
