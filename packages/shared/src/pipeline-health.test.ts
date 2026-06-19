import { describe, expect, it } from "vitest";
import {
  buildPipelineMentionHref,
  computePipelineHealth,
  groupWarningsByStage,
  type PipelineHealthInput,
  type PipelineHealthStageInput,
} from "./index.js";

const AGENTS = {
  active: { id: "agent-active", name: "Casey", status: "active" },
  paused: { id: "agent-paused", name: "Robin", status: "paused" },
};

function baseInput(stages: PipelineHealthStageInput[], overrides: Partial<PipelineHealthInput> = {}): PipelineHealthInput {
  return {
    pipelineId: "pipeline-1",
    stages,
    agentsById: { [AGENTS.active.id]: AGENTS.active, [AGENTS.paused.id]: AGENTS.paused },
    pipelinesById: {
      "pipeline-1": { id: "pipeline-1", name: "Content", stages: [{ key: "drafting", name: "Drafting" }] },
      "pipeline-2": {
        id: "pipeline-2",
        name: "Content Production",
        stages: [{ key: "assets", name: "Assets" }],
      },
    },
    ...overrides,
  };
}

function stage(partial: Partial<PipelineHealthStageInput>): PipelineHealthStageInput {
  return {
    id: "stage-1",
    key: "intake",
    name: "Intake",
    kind: "working",
    config: {},
    instructionsBody: "",
    ...partial,
  };
}

describe("computePipelineHealth", () => {
  it("returns ok with no warnings for a clean stage", () => {
    const report = computePipelineHealth(
      baseInput([stage({ config: { assigneeAgentId: AGENTS.active.id }, instructionsBody: "Do the thing." })]),
    );
    expect(report.ok).toBe(true);
    expect(report.warnings).toEqual([]);
  });

  it("warns when the assigned teammate is paused", () => {
    const report = computePipelineHealth(
      baseInput([stage({ config: { assigneeAgentId: AGENTS.paused.id }, instructionsBody: "Go." })]),
    );
    const codes = report.warnings.map((w) => w.code);
    expect(codes).toContain("paused_agent");
    expect(report.warnings[0]?.message).toBe(
      "Robin is paused, so this step won't run until they're back. Reassign it if you can't wait.",
    );
    expect(report.warnings[0]?.message).not.toMatch(/routine|dispatch|JWT|invokable/i);
  });

  it("warns when the assigned teammate no longer exists", () => {
    const report = computePipelineHealth(
      baseInput([stage({ config: { assigneeAgentId: "ghost" }, instructionsBody: "Go." })]),
    );
    const ghost = report.warnings.find((w) => w.code === "paused_agent");
    expect(ghost?.message).toBe(
      "Assigned to a teammate who's no longer here. Pick someone else to run this step.",
    );
  });

  it("warns when a teammate is assigned but there are no instructions", () => {
    const report = computePipelineHealth(
      baseInput([stage({ config: { assigneeAgentId: AGENTS.active.id }, instructionsBody: "" })]),
    );
    const warning = report.warnings.find((w) => w.code === "automation_no_instructions");
    expect(warning?.message).toBe(
      "Assigned to a teammate, but there are no instructions yet. Add instructions so this step doesn't stall.",
    );
  });

  it("warns loudly when a non-review stage has no automatic runner", () => {
    const report = computePipelineHealth(baseInput([stage({ kind: "working", config: {}, instructionsBody: "" })]));
    const warning = report.warnings.find((w) => w.code === "stage_no_automation");
    expect(warning?.message).toBe(
      "Nothing runs here automatically — items will sit until a person moves them. Add an agent to run this step, or make it a review step if a person should decide.",
    );
  });

  it("warns when instructions exist without an assigned agent", () => {
    const report = computePipelineHealth(baseInput([stage({ kind: "working", config: {}, instructionsBody: "Draft it." })]));
    const warning = report.warnings.find((w) => w.code === "automation_no_agent");
    expect(warning?.message).toBe(
      "This step has instructions, but no agent is assigned. Add an agent to run this step, or make it a review step if a person should decide.",
    );
  });

  it("does not warn about a missing agent when children-gate auto-advance moves the stage forward", () => {
    const report = computePipelineHealth(
      baseInput([
        stage({
          kind: "working",
          config: { requireChildrenTerminal: true, autoAdvanceOnChildrenTerminal: "covered" },
          instructionsBody: "Create the child feature cases and wait for them to finish.",
        }),
      ]),
    );
    expect(report.warnings.map((warning) => warning.code)).not.toContain("automation_no_agent");
    expect(report.warnings.map((warning) => warning.code)).not.toContain("stage_no_automation");
  });

  it("does not warn about missing automation when a stage auto-advances after children finish", () => {
    const report = computePipelineHealth(
      baseInput([
        stage({
          kind: "working",
          config: { requireChildrenTerminal: true, autoAdvanceOnChildrenTerminal: "covered" },
          instructionsBody: "",
        }),
      ]),
    );
    expect(report.warnings.map((warning) => warning.code)).not.toContain("stage_no_automation");
  });

  it("does not warn about missing automation on review stages", () => {
    const report = computePipelineHealth(baseInput([stage({ kind: "review", config: {}, instructionsBody: "" })]));
    expect(report.warnings.map((warning) => warning.code)).not.toContain("stage_no_automation");
  });

  it("does not warn about missing automation on terminal stages", () => {
    const report = computePipelineHealth(
      baseInput([
        stage({
          id: "done-stage",
          key: "covered",
          name: "Covered",
          kind: "done",
          config: {},
          instructionsBody: "No runner needed.",
        }),
        stage({
          id: "cancelled-stage",
          key: "cancelled",
          name: "Cancelled",
          kind: "cancelled",
          config: {},
          instructionsBody: "",
        }),
      ]),
    );
    expect(report.warnings.map((warning) => warning.code)).not.toContain("automation_no_agent");
    expect(report.warnings.map((warning) => warning.code)).not.toContain("stage_no_automation");
  });

  it("warns when a review stage has no approver set", () => {
    const report = computePipelineHealth(
      baseInput([
        stage({ kind: "review", config: { requireApproval: true, approver: { kind: "agent" } } }),
      ]),
    );
    const warning = report.warnings.find((w) => w.code === "review_no_approver");
    expect(warning?.message).toBe("No approver picked yet, so work will pile up here. Choose who approves.");
  });

  it("warns when the review approver agent is paused", () => {
    const report = computePipelineHealth(
      baseInput([
        stage({ kind: "review", config: { requireApproval: true, approver: { kind: "agent", id: AGENTS.paused.id } } }),
      ]),
    );
    const warning = report.warnings.find((w) => w.code === "review_no_approver");
    expect(warning?.message).toBe(
      "Robin is the approver and they're paused, so nothing can be approved until they're back.",
    );
  });

  it("does not warn for an any_human review stage", () => {
    const report = computePipelineHealth(
      baseInput([stage({ kind: "review", config: { requireApproval: true, approver: { kind: "any_human" } } })]),
    );
    expect(report.warnings).toEqual([]);
  });

  it("warns when instructions reference a missing pipeline", () => {
    const href = buildPipelineMentionHref("pipeline-gone");
    const report = computePipelineHealth(
      baseInput([stage({ instructionsBody: `Create cases in [Gone](${href}).` })]),
    );
    const warning = report.warnings.find((w) => w.code === "missing_pipeline_reference");
    expect(warning?.message).toBe(
      "These instructions hand off to a workflow that's been deleted. Point them at one that exists.",
    );
  });

  it("warns when instructions reference a missing stage of a real pipeline", () => {
    const href = buildPipelineMentionHref("pipeline-2", "no-such-stage");
    const report = computePipelineHealth(
      baseInput([stage({ instructionsBody: `Hand off to [Prod](${href}).` })]),
    );
    const warning = report.warnings.find((w) => w.code === "missing_stage_reference");
    expect(warning?.message).toBe(
      'These instructions hand off to a step that no longer exists in "Content Production". Point them at one that does.',
    );
  });

  it("does not warn for a valid pipeline + stage reference", () => {
    const href = buildPipelineMentionHref("pipeline-2", "assets");
    const report = computePipelineHealth(
      baseInput([stage({ config: { assigneeAgentId: AGENTS.active.id }, instructionsBody: `Hand off to [Prod](${href}).` })]),
    );
    expect(report.warnings).toEqual([]);
  });

  it("uses breakdown config for first-class target health instead of prose-scanning stage instructions", () => {
    const report = computePipelineHealth(
      baseInput([
        stage({
          config: {
            breakdown: {
              targetPipelineId: "pipeline-2",
              targetStageKey: "assets",
              pieceNoun: "asset",
              inheritFields: ["topic", "releaseTag", "featureAngle"],
              waitForPieces: true,
              whenFinishedMoveTo: "review",
            },
          },
          instructionsBody: `Ignore a stale prose link to ${buildPipelineMentionHref("missing-pipeline")}.`,
        }),
      ], {
        pipelinesById: {
          "pipeline-2": {
            id: "pipeline-2",
            name: "Content Production",
            stages: [{ key: "assets", name: "Assets", kind: "working", config: { variables: [{ name: "topic" }] } }],
          },
        },
      }),
    );
    expect(report.warnings.map((warning) => warning.code)).not.toContain("missing_pipeline_reference");
    expect(report.warnings).toEqual([]);
  });

  it("warns for missing or unsafe breakdown target configuration", () => {
    const report = computePipelineHealth(
      baseInput([
        stage({
          id: "missing",
          config: { breakdown: { targetPipelineId: "gone", targetStageKey: "intake" } },
        }),
        stage({
          id: "unsafe",
          config: {
            breakdown: {
              targetPipelineId: "pipeline-2",
              targetStageKey: "assets",
              pieceNoun: "asset",
              inheritFields: ["missing_field"],
            },
          },
        }),
      ], {
        pipelinesById: {
          "pipeline-2": {
            id: "pipeline-2",
            name: "Content Production",
            stages: [
              { key: "intake", name: "Intake", kind: "working", config: { variables: [] } },
              { key: "assets", name: "Assets", kind: "review", config: { variables: [{ name: "topic" }] } },
            ],
          },
        },
      }),
    );
    expect(report.warnings.map((warning) => warning.code)).toEqual([
      "breakdown_target_missing",
      "breakdown_no_wait",
      "breakdown_target_not_entry_safe",
    ]);
  });

  it("does not warn when a required automation variable has no default value", () => {
    const report = computePipelineHealth(
      baseInput([
        stage({
          config: {
            assigneeAgentId: AGENTS.active.id,
            variables: [
              { name: "release_notes", label: "Release notes", required: true, defaultValue: null },
              { name: "channel", label: "Channel", required: false },
            ],
          },
          instructionsBody: "Draft it.",
        }),
      ]),
    );
    expect(report.warnings.map((warning) => warning.code)).not.toContain("unset_required_variable");
  });

  it("adds linked warnings for failed automation on live items", () => {
    const report = computePipelineHealth(
      baseInput([
        stage({
          id: "stage-2",
          key: "drafting",
          name: "Drafting",
          kind: "working",
          config: { onEnter: { type: "run_routine", routineId: "routine-1" } },
        }),
      ], {
        failedAutomations: [
          {
            stageId: "stage-2",
            stageKey: "drafting",
            stageName: "Drafting",
            caseId: "case-1",
            caseTitle: "Launch post",
            error: "boom",
          },
        ],
      }),
    );
    const warning = report.warnings.find((w) => w.code === "automation_failed");
    expect(warning).toMatchObject({
      message: 'Automation failed on "Launch post". Open the item to inspect the log and retry it.',
      href: "/pipelines/pipeline-1/items/case-1",
      hrefLabel: "Open item",
    });
  });

  it("does not warn about required variables with the legacy { key } shape", () => {
    const report = computePipelineHealth(
      baseInput([
        stage({
          config: { onEnter: { type: "run_routine", routineId: "routine-1" }, variables: [{ key: "topic", required: true }] },
          instructionsBody: "Go.",
        }),
      ]),
    );
    expect(report.warnings.map((warning) => warning.code)).not.toContain("unset_required_variable");
  });

  it("does not warn about required variables on an entry stage with no instructions to run", () => {
    // Entry-stage variables are the intake form — they're filled per item at
    // ingest, so an empty default is the normal state.
    const report = computePipelineHealth(
      baseInput([
        stage({
          config: {
            variables: [{ name: "releaseName", label: "Release name", required: true }],
          },
        }),
      ]),
    );
    expect(report.warnings.map((warning) => warning.code)).not.toContain("unset_required_variable");
  });

  it("groups warnings by stage", () => {
    const report = computePipelineHealth(
      baseInput([
        stage({ id: "s1", config: { assigneeAgentId: AGENTS.paused.id }, instructionsBody: "Go." }),
        stage({ id: "s2", key: "review", kind: "review", config: { requireApproval: true, approver: { kind: "agent" } } }),
      ]),
    );
    const grouped = groupWarningsByStage(report.warnings);
    expect(Object.keys(grouped).sort()).toEqual(["s1", "s2"]);
  });
});
