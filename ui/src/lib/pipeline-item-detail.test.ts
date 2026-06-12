import { describe, expect, it } from "vitest";
import type { PipelineCase, PipelineCaseEvent, PipelineStage } from "../api/pipelines";
import {
  changedNoticeFromEvents,
  displayPipelineItemFields,
  formatPipelineItemEvent,
  getPendingTransitionBannerState,
  humanizePipelineItemStatus,
  INTERNAL_FIELD_KEYS,
  itemHasChangedNotice,
  normalizePipelineChildRows,
} from "./pipeline-item-detail";

const stages: PipelineStage[] = [
  { id: "stage-intake", pipelineId: "pipeline-1", key: "intake", name: "Intake", kind: "working", position: 100 },
  { id: "stage-review", pipelineId: "pipeline-1", key: "review", name: "Review", kind: "review", position: 200 },
  { id: "stage-done", pipelineId: "pipeline-1", key: "done", name: "Done", kind: "done", position: 900 },
];

function item(overrides: Partial<PipelineCase>): PipelineCase {
  return {
    id: "item-1",
    pipelineId: "pipeline-1",
    stageId: "stage-intake",
    title: "Draft launch post",
    fields: {},
    ...overrides,
  };
}

function event(type: string, payload: Record<string, unknown> = {}, overrides: Partial<PipelineCaseEvent> = {}): PipelineCaseEvent {
  return {
    id: `${type}-event`,
    companyId: "company-1",
    caseId: "item-1",
    type,
    actorType: "system",
    payload,
    createdAt: "2026-06-10T12:00:00.000Z",
    updatedAt: "2026-06-10T12:00:00.000Z",
    ...overrides,
  };
}

describe("pipeline item detail helpers", () => {
  it("shows and hides the pending transition banner from item state", () => {
    expect(getPendingTransitionBannerState(item({
      pendingSuggestion: {
        id: "suggestion-1",
        toStageKey: "review",
        rationale: "Ready for review",
        createdAt: "2026-06-10T12:00:00.000Z",
      },
    }), stages)).toMatchObject({
      visible: true,
      suggestionId: "suggestion-1",
      stageName: "Review",
    });

    expect(getPendingTransitionBannerState(item({ fields: { suggestionResolution: "dismiss" } }), stages)).toEqual({
      visible: false,
      reason: "resolved",
    });
    expect(getPendingTransitionBannerState(item({ fields: {} }), stages)).toEqual({
      visible: false,
      reason: "no_next_stage",
    });
    expect(getPendingTransitionBannerState(item({ fields: { nextSuggestedStageId: "stage-done" } }), stages)).toMatchObject({
      visible: true,
      stageName: "Done",
    });
    expect(getPendingTransitionBannerState(item({ fields: { nextSuggestedStageId: "missing-stage" } }), stages)).toMatchObject({
      visible: true,
      stageName: "the next stage",
    });
  });

  it("detects changed items until acknowledged", () => {
    expect(itemHasChangedNotice(item({ fields: { changeAcknowledgedAt: "2026-06-10T12:00:00.000Z", upstreamDrift: true } }))).toBeNull();
    expect(itemHasChangedNotice({ ...item({ fields: {} }), thisChanged: true })).toMatchObject({ title: "This changed" });
    expect(itemHasChangedNotice(item({ fields: { upstreamChanged: true } }))).toMatchObject({ title: "This changed" });
    expect(itemHasChangedNotice(item({ fields: { upstreamDrift: true } }))).toMatchObject({ title: "This changed" });
    expect(itemHasChangedNotice(item({ fields: {} }))).toBeNull();
    expect(changedNoticeFromEvents([
      event("upstream_drift", {}, { createdAt: "2026-06-10T12:00:00.000Z" }),
    ])).toMatchObject({ title: "This changed" });
    expect(changedNoticeFromEvents([
      event("upstream_drift", {}, { createdAt: "2026-06-10T12:00:00.000Z" }),
      event("drift_acknowledged", {}, { createdAt: "2026-06-10T12:01:00.000Z" }),
    ])).toBeNull();
  });

  it("formats every supported activity kind as prose", () => {
    const cases: Array<[PipelineCaseEvent, string]> = [
      [event("case.ingested"), "Item added."],
      [event("case.updated"), "Item details updated."],
      [event("case.transitioned", { reason: "Start content intake", transitionClass: "manual" }, {
        fromStageId: "stage-intake",
        toStageId: "stage-review",
        actorType: "agent",
        actorAgent: { id: "agent-1", name: "Dotta" },
      }), "Moved from Intake to Review — Dotta: 'Start content intake'."],
      [event("case.transitioned", { reason: "children_terminal", transitionClass: "auto" }, {
        toStageId: "stage-done",
        actorType: "system",
      }), "Moved to Done — automatic (all child items done)."],
      [event("case.transitioned", { reason: "children_terminal", transitionClass: "manual" }, {
        toStageId: "stage-done",
        actorType: "system",
      }), "Moved to Done — automatic (all child items done)."],
      [event("case.suggested", { suggestion: { toStageKey: "review" } }), "Suggested moving to Review."],
      [event("case.suggestion_resolved", { decision: "accept" }), "Suggestion approved."],
      [event("case.suggestion_resolved", { decision: "dismiss" }), "Suggestion dismissed."],
      [event("case.reviewed", { decision: "request_changes" }), "Review requested changes."],
      [event("case.reviewed", { decision: "drop" }), "Review removed this item."],
      [event("case.reviewed", { decision: "approve" }), "Review approved this item."],
      [event("upstream_drift", { upstreamCaseKey: "BLOG-12" }), "Upstream change detected from BLOG-12."],
      [event("upstream_drift"), "Upstream change detected."],
      [event("drift_acknowledged"), "Upstream change acknowledged."],
      [event("automation_executed", {}, {
        automation: {
          routine: { id: "routine-1", title: "Draft announcement" },
          issue: { id: "issue-1", identifier: "PAP-42", title: "Draft the announcement", status: "todo" },
          routineRunId: "run-1",
        },
      }), "Automation completed — ran Draft announcement -> PAP-42."],
      [event("automation_failed", { error: "automation_not_configured" }), "Automation needs attention — automation not configured."],
      [event("case.unknown_kind"), "Activity recorded."],
    ];

    for (const [input, expected] of cases) {
      expect(formatPipelineItemEvent(input, stages)).toBe(expected);
    }
  });

  it("humanizes status values", () => {
    expect(humanizePipelineItemStatus(null)).toBe("Open");
    expect(humanizePipelineItemStatus("open")).toBe("Open");
    expect(humanizePipelineItemStatus("done")).toBe("Done");
    expect(humanizePipelineItemStatus("cancelled")).toBe("Removed");
    expect(humanizePipelineItemStatus("in_review")).toBe("In review");
    expect(humanizePipelineItemStatus("in_progress")).toBe("In progress");
    expect(humanizePipelineItemStatus("needs_qa")).toBe("Needs qa");
  });

  it("filters internal fields and formats display values", () => {
    const fields = {
      audience: ["Founders", "Operators"],
      owner: { label: "Launch team" },
      backupOwner: { name: "Growth" },
      source: { title: "Launch brief" },
      metadata: { nested: true },
      title: "Announcement",
      nextSuggestedStageId: "review",
      suggestionResolution: "accept",
      upstreamDrift: true,
      changeAcknowledgedAt: "2026-06-10T12:00:00.000Z",
      thisChanged: true,
    };

    const displayed = displayPipelineItemFields(fields);
    expect(displayed).toEqual([
      { key: "audience", label: "Audience", value: "Founders, Operators" },
      { key: "owner", label: "Owner", value: "Launch team" },
      { key: "backupOwner", label: "Backup Owner", value: "Growth" },
      { key: "source", label: "Source", value: "Launch brief" },
      { key: "metadata", label: "Metadata", value: "Added details" },
      { key: "title", label: "Title", value: "Announcement" },
    ]);
    for (const key of INTERNAL_FIELD_KEYS) {
      expect(displayed.some((field) => field.key === key)).toBe(false);
    }
  });

  it("normalizes rollup-tree children responses into direct child rows", () => {
    const rows = normalizePipelineChildRows({
      case: {
        id: "release-1",
        title: "Release v0.42",
        pipeline: { id: "release-pipeline", key: "release", name: "Release" },
        stage: { id: "release-producing", key: "producing", name: "Producing", kind: "working" },
        childGroups: [
          {
            pipeline: { id: "feature-pipeline", key: "feature", name: "Feature" },
            cases: [
              {
                id: "feature-1",
                caseKey: "v0.42-pipelines-ui",
                title: "Feature: Pipelines UI",
                terminalKind: "done",
                pipeline: { id: "feature-pipeline", key: "feature", name: "Feature" },
                stage: { id: "feature-covered", key: "covered", name: "Covered", kind: "done" },
                rollup: { total: 6, done: 3, dropped: 3, inMotion: 0 },
                childGroups: [],
              },
            ],
          },
        ],
      },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].case).toMatchObject({
      id: "feature-1",
      pipelineId: "feature-pipeline",
      stageId: "feature-covered",
      title: "Feature: Pipelines UI",
      terminalKind: "done",
      childCount: 6,
    });
    expect(rows[0].stage).toMatchObject({
      id: "feature-covered",
      pipelineId: "feature-pipeline",
      key: "covered",
      name: "Covered",
      kind: "done",
    });
  });
});
