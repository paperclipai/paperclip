import { describe, expect, it } from "vitest";
import {
  computePipelineHealth,
  groupWarningsByStage,
  isPipelineTerminalStageKind,
  type PipelineHealthFailedAutomationInput,
  type PipelineHealthInput,
  type PipelineHealthStageInput,
  type PipelineHealthWarning,
} from "./pipeline-health.js";

function stage(overrides: Partial<PipelineHealthStageInput> = {}): PipelineHealthStageInput {
  return {
    id: "stage-1",
    key: "work",
    name: "Do the work",
    kind: "work",
    config: null,
    instructionsBody: "",
    ...overrides,
  };
}

function baseInput(overrides: Partial<PipelineHealthInput> = {}): PipelineHealthInput {
  return {
    pipelineId: "pipe-1",
    stages: [],
    agentsById: {},
    pipelinesById: {},
    ...overrides,
  };
}

function codes(warnings: PipelineHealthWarning[]): string[] {
  return warnings.map((w) => w.code);
}

describe("isPipelineTerminalStageKind", () => {
  it("treats done and cancelled as terminal", () => {
    expect(isPipelineTerminalStageKind("done")).toBe(true);
    expect(isPipelineTerminalStageKind("cancelled")).toBe(true);
  });

  it("treats other kinds and empty input as non-terminal", () => {
    expect(isPipelineTerminalStageKind("work")).toBe(false);
    expect(isPipelineTerminalStageKind("review")).toBe(false);
    expect(isPipelineTerminalStageKind(null)).toBe(false);
    expect(isPipelineTerminalStageKind(undefined)).toBe(false);
  });
});

describe("computePipelineHealth", () => {
  it("reports ok for an empty pipeline", () => {
    const report = computePipelineHealth(baseInput());
    expect(report).toEqual({ pipelineId: "pipe-1", warnings: [], ok: true });
  });

  it("reports no warnings for a healthy assigned stage with instructions", () => {
    const report = computePipelineHealth(baseInput({
      stages: [stage({ config: { assigneeAgentId: "agent-1" }, instructionsBody: "Do the thing." })],
      agentsById: { "agent-1": { id: "agent-1", name: "Ada", status: "active" } },
    }));
    expect(report.warnings).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("warns when the assignee agent no longer exists", () => {
    const report = computePipelineHealth(baseInput({
      stages: [stage({ config: { assigneeAgentId: "ghost" }, instructionsBody: "Do it." })],
    }));
    expect(codes(report.warnings)).toEqual(["paused_agent"]);
    expect(report.warnings[0]?.message).toContain("no longer here");
    expect(report.ok).toBe(false);
  });

  it("warns with the agent's name when the assignee is paused", () => {
    const report = computePipelineHealth(baseInput({
      stages: [stage({ config: { assigneeAgentId: "agent-1" }, instructionsBody: "Do it." })],
      agentsById: { "agent-1": { id: "agent-1", name: "Ada", status: "paused" } },
    }));
    expect(codes(report.warnings)).toEqual(["paused_agent"]);
    expect(report.warnings[0]?.message).toContain("Ada is paused");
  });

  it("warns when an assignee has no instructions to run", () => {
    const report = computePipelineHealth(baseInput({
      stages: [stage({ config: { assigneeAgentId: "agent-1" }, instructionsBody: "   " })],
      agentsById: { "agent-1": { id: "agent-1", name: "Ada", status: "active" } },
    }));
    expect(codes(report.warnings)).toEqual(["automation_no_instructions"]);
  });

  it("warns when instructions exist but no agent is assigned", () => {
    const report = computePipelineHealth(baseInput({
      stages: [stage({ instructionsBody: "Do this by hand?" })],
    }));
    expect(codes(report.warnings)).toEqual(["automation_no_agent"]);
  });

  it("warns loudly when a stage has no automation at all", () => {
    const report = computePipelineHealth(baseInput({ stages: [stage()] }));
    expect(codes(report.warnings)).toEqual(["stage_no_automation"]);
  });

  it("does not flag review or terminal stages for missing automation", () => {
    const report = computePipelineHealth(baseInput({
      stages: [
        stage({ id: "s-review", key: "review", kind: "review", config: { approver: { kind: "any_human" } } }),
        stage({ id: "s-done", key: "done", kind: "done" }),
        stage({ id: "s-cancelled", key: "cancelled", kind: "cancelled" }),
      ],
    }));
    expect(report.warnings).toEqual([]);
  });

  it("warns when a review stage names an agent approver that is missing or paused", () => {
    const missing = computePipelineHealth(baseInput({
      stages: [stage({ kind: "review", config: { approver: { kind: "agent" } } })],
    }));
    expect(codes(missing.warnings)).toEqual(["review_no_approver"]);

    const paused = computePipelineHealth(baseInput({
      stages: [stage({ kind: "review", config: { approver: { kind: "agent", id: "agent-1" } } })],
      agentsById: { "agent-1": { id: "agent-1", name: "Ada", status: "paused" } },
    }));
    expect(codes(paused.warnings)).toEqual(["review_no_approver"]);
    expect(paused.warnings[0]?.message).toContain("Ada is the approver");
  });

  it("warns when a user approver is required but not picked", () => {
    const report = computePipelineHealth(baseInput({
      stages: [stage({ kind: "review", config: { approver: { kind: "user" } } })],
    }));
    expect(codes(report.warnings)).toEqual(["review_no_approver"]);
  });

  it("flags instructions that mention deleted pipelines or stages", () => {
    const input = baseInput({
      stages: [
        stage({
          id: "s-1",
          instructionsBody: [
            "Hand off to [Gone](pipeline://deleted-pipe) when done.",
            "Or to [Later](pipeline://pipe-2?stage=missing-stage).",
          ].join("\n"),
          config: { assigneeAgentId: "agent-1" },
        }),
      ],
      agentsById: { "agent-1": { id: "agent-1", name: "Ada", status: "active" } },
      pipelinesById: {
        "pipe-2": { id: "pipe-2", name: "Follow-up", stages: [{ key: "intake", name: "Intake" }] },
      },
    });
    const report = computePipelineHealth(input);
    expect(codes(report.warnings)).toEqual(["missing_pipeline_reference", "missing_stage_reference"]);
    expect(report.warnings[1]?.message).toContain('"Follow-up"');
  });

  it("accepts instructions that mention existing pipelines and stages", () => {
    const report = computePipelineHealth(baseInput({
      stages: [stage({
        instructionsBody: "Hand off to [Follow-up](pipeline://pipe-2?stage=intake).",
        config: { assigneeAgentId: "agent-1" },
      })],
      agentsById: { "agent-1": { id: "agent-1", name: "Ada", status: "active" } },
      pipelinesById: {
        "pipe-2": { id: "pipe-2", name: "Follow-up", stages: [{ key: "intake", name: "Intake" }] },
      },
    }));
    expect(report.warnings).toEqual([]);
  });

  it("warns when a breakdown destination is missing", () => {
    const report = computePipelineHealth(baseInput({
      stages: [stage({
        config: { breakdown: { targetPipelineId: "gone", targetStageKey: "intake" } },
      })],
    }));
    expect(codes(report.warnings)).toEqual(["breakdown_target_missing"]);
  });

  it("accepts a fully configured breakdown into an entry-safe destination", () => {
    const report = computePipelineHealth(baseInput({
      stages: [stage({
        config: {
          breakdown: {
            targetPipelineId: "pipe-2",
            targetStageKey: "intake",
            waitForPieces: true,
            whenFinishedMoveTo: "done",
          },
        },
      })],
      pipelinesById: {
        "pipe-2": {
          id: "pipe-2",
          name: "Pieces",
          stages: [{ key: "intake", name: "Intake", kind: "work" }, { key: "done", name: "Done", kind: "done" }],
        },
      },
    }));
    expect(report.warnings).toEqual([]);
  });

  it("warns when a breakdown does not wait for its pieces", () => {
    const report = computePipelineHealth(baseInput({
      stages: [stage({
        config: {
          breakdown: {
            targetPipelineId: "pipe-2",
            targetStageKey: "intake",
            waitForPieces: false,
            pieceNoun: "chapter",
          },
        },
      })],
      pipelinesById: {
        "pipe-2": { id: "pipe-2", name: "Pieces", stages: [{ key: "intake", name: "Intake", kind: "work" }] },
      },
    }));
    expect(codes(report.warnings)).toEqual(["breakdown_no_wait"]);
    expect(report.warnings[0]?.message).toContain("chapters");
  });

  it("warns when the breakdown destination is not the entry stage", () => {
    const report = computePipelineHealth(baseInput({
      stages: [stage({
        config: {
          breakdown: {
            targetPipelineId: "pipe-2",
            targetStageKey: "later",
            waitForPieces: true,
            whenFinishedMoveTo: "done",
          },
        },
      })],
      pipelinesById: {
        "pipe-2": {
          id: "pipe-2",
          name: "Pieces",
          stages: [{ key: "intake", name: "Intake", kind: "work" }, { key: "later", name: "Later", kind: "work" }],
        },
      },
    }));
    expect(codes(report.warnings)).toEqual(["breakdown_target_not_entry_safe"]);
  });

  it("reports failed automations with a link to the affected item", () => {
    const report = computePipelineHealth(baseInput({
      failedAutomations: [{
        stageId: "s-1",
        stageKey: "work",
        stageName: "Do the work",
        caseId: "case-9",
        caseTitle: "Broken thing",
      }],
    }));
    expect(codes(report.warnings)).toEqual(["automation_failed"]);
    expect(report.warnings[0]?.message).toContain('"Broken thing"');
    expect(report.warnings[0]?.href).toBe("/pipelines/pipe-1/items/case-9");
    expect(report.warnings[0]?.hrefLabel).toBe("Open item");
    expect(report.ok).toBe(false);
  });
});

describe("groupWarningsByStage", () => {
  it("groups warnings by stage id, preserving order within each group", () => {
    const anchorA = { stageId: "a", stageKey: "a", stageName: "A" };
    const anchorB = { stageId: "b", stageKey: "b", stageName: "B" };
    const warnings: PipelineHealthWarning[] = [
      { ...anchorA, code: "stage_no_automation", message: "1" },
      { ...anchorB, code: "paused_agent", message: "2" },
      { ...anchorA, code: "automation_failed", message: "3" },
    ];
    const grouped = groupWarningsByStage(warnings);
    expect(Object.keys(grouped)).toEqual(["a", "b"]);
    expect(grouped.a?.map((w) => w.message)).toEqual(["1", "3"]);
    expect(grouped.b?.map((w) => w.message)).toEqual(["2"]);
  });

  it("returns an empty record for no warnings", () => {
    expect(groupWarningsByStage([])).toEqual({});
  });
});

describe("computePipelineHealth", () => {
  const baseInput: PipelineHealthInput = {
    pipelineId: "pipeline-1",
    stages: [],
    agentsById: {},
    pipelinesById: {},
  };

  it("emits one warning per failed automation item and stage", () => {
    const failure: PipelineHealthFailedAutomationInput = {
      stageId: "stage-1",
      stageKey: "build",
      stageName: "Build",
      caseId: "case-1",
      caseTitle: "Case 1",
      error: "Routine timed out",
    };

    const report = computePipelineHealth({
      ...baseInput,
      failedAutomations: [failure],
    });

    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toMatchObject({
      code: "automation_failed",
      stageId: "stage-1",
      stageKey: "build",
      stageName: "Build",
      href: "/pipelines/pipeline-1/items/case-1",
      hrefLabel: "Open item",
      message: `Automation failed on "Case 1". Open the item to inspect the log and retry it.`,
    });
  });

  it("deduplicates duplicate failed automation rows for the same stage and case", () => {
    const failure: PipelineHealthFailedAutomationInput = {
      stageId: "stage-1",
      stageKey: "build",
      stageName: "Build",
      caseId: "case-1",
      caseTitle: "Case 1",
      error: "Routine timed out",
    };
    const duplicateFailure: PipelineHealthFailedAutomationInput = {
      stageId: "stage-1",
      stageKey: "build",
      stageName: "Build",
      caseId: "case-1",
      caseTitle: "Case 1",
      error: "Routine timed out",
    };

    const report = computePipelineHealth({
      ...baseInput,
      failedAutomations: [failure, duplicateFailure],
    });

    const automationWarnings = report.warnings.filter((warning) => warning.code === "automation_failed");

    expect(automationWarnings).toHaveLength(1);
  });

  it("keeps separate warnings for different case IDs in the same stage", () => {
    const firstFailure: PipelineHealthFailedAutomationInput = {
      stageId: "stage-1",
      stageKey: "build",
      stageName: "Build",
      caseId: "case-1",
      caseTitle: "Case 1",
      error: "Routine timed out",
    };
    const secondFailure: PipelineHealthFailedAutomationInput = {
      stageId: "stage-1",
      stageKey: "build",
      stageName: "Build",
      caseId: "case-2",
      caseTitle: "Case 2",
      error: "Routine timed out",
    };

    const report = computePipelineHealth({
      ...baseInput,
      failedAutomations: [firstFailure, secondFailure],
    });

    const automationWarnings = report.warnings.filter((warning) => warning.code === "automation_failed");

    expect(automationWarnings).toHaveLength(2);
    expect(automationWarnings.map((warning) => warning.href)).toEqual([
      "/pipelines/pipeline-1/items/case-1",
      "/pipelines/pipeline-1/items/case-2",
    ]);
  });

  it("keeps separate warnings for the same case ID in different stages", () => {
    const firstFailure: PipelineHealthFailedAutomationInput = {
      stageId: "stage-1",
      stageKey: "build",
      stageName: "Build",
      caseId: "case-1",
      caseTitle: "Case 1",
      error: "Routine timed out",
    };
    const secondFailure: PipelineHealthFailedAutomationInput = {
      stageId: "stage-2",
      stageKey: "verify",
      stageName: "Verify",
      caseId: "case-1",
      caseTitle: "Case 1",
      error: "Routine timed out",
    };

    const report = computePipelineHealth({
      ...baseInput,
      failedAutomations: [firstFailure, secondFailure],
    });

    const automationWarnings = report.warnings.filter((warning) => warning.code === "automation_failed");

    expect(automationWarnings).toHaveLength(2);
    expect(automationWarnings.map((warning) => warning.stageId)).toEqual(["stage-1", "stage-2"]);
  });

  it("keeps separate warnings when stage and case IDs would collide with colon-delimited keys", () => {
    const firstFailure: PipelineHealthFailedAutomationInput = {
      stageId: "stage:one",
      stageKey: "build",
      stageName: "Build",
      caseId: "case",
      caseTitle: "Case 1",
      error: "Routine timed out",
    };
    const secondFailure: PipelineHealthFailedAutomationInput = {
      stageId: "stage",
      stageKey: "verify",
      stageName: "Verify",
      caseId: "one:case",
      caseTitle: "Case 2",
      error: "Routine timed out",
    };

    const report = computePipelineHealth({
      ...baseInput,
      failedAutomations: [firstFailure, secondFailure],
    });

    const automationWarnings = report.warnings.filter((warning) => warning.code === "automation_failed");

    expect(automationWarnings).toHaveLength(2);
    expect(automationWarnings.map((warning) => warning.href)).toEqual([
      "/pipelines/pipeline-1/items/case",
      "/pipelines/pipeline-1/items/one:case",
    ]);
  });
});
