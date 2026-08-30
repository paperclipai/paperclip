import { describe, expect, it } from "vitest";
import { queryKeys } from "../lib/queryKeys";
import {
  getPipelineStageColumnTone,
  pipelineStageAutomationSettingsHref,
} from "../lib/pipeline-stage-presentation";
import {
  groupCasesByBuiltFor,
  normalizePipelineConversationComments,
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
