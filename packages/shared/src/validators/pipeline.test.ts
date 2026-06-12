import { describe, expect, it } from "vitest";
import { pipelineStageConfigSchema } from "./pipeline.js";

describe("pipeline stage variable schema", () => {
  it("validates select variables require options", () => {
    expect(
      pipelineStageConfigSchema.safeParse({
        variables: [{ key: "status", label: "Status", type: "select", options: ["open", "done"] }],
      }).success,
    ).toBe(true);

    expect(
      pipelineStageConfigSchema.safeParse({
        variables: [{ key: "status", label: "Status", type: "select", options: [] }],
      }).success,
    ).toBe(false);
  });

  it("enforces unique variable keys in stage config", () => {
    expect(
      pipelineStageConfigSchema.safeParse({
        variables: [
          { key: "repo", label: "Repo", type: "text" },
          { key: "repo", label: "Repo", type: "text" },
        ],
      }).success,
    ).toBe(false);
  });

  it("accepts disabled and approval settings stored in stage config", () => {
    expect(
      pipelineStageConfigSchema.safeParse({
        variables: [
          {
            key: "customer",
            label: "Customer",
            type: "text",
            options: [],
            required: true,
            showInAddForm: true,
          },
        ],
        disabled: true,
        disabledReason: "Pause intake while the team clears the queue.",
        requireApproval: true,
        approver: { kind: "agent", id: "agent-1" },
        whatHappensHere: "Triage every incoming item before work starts.",
      }).success,
    ).toBe(true);
  });

  it("requires an id when the approver is a specific user or agent", () => {
    expect(
      pipelineStageConfigSchema.safeParse({
        variables: [],
        requireApproval: true,
        approver: { kind: "user" },
      }).success,
    ).toBe(false);
  });

  it("accepts a run_routine onEnter action", () => {
    expect(
      pipelineStageConfigSchema.safeParse({
        variables: [],
        onEnter: {
          type: "run_routine",
          routineId: "11111111-1111-4111-8111-111111111111",
        },
      }).success,
    ).toBe(true);
  });

  it("rejects an onEnter run_routine action without a valid routine id", () => {
    expect(
      pipelineStageConfigSchema.safeParse({
        variables: [],
        onEnter: {
          type: "run_routine",
          routineId: "not-a-uuid",
        },
      }).success,
    ).toBe(false);
  });

  it("still accepts the legacy reviewerKind input", () => {
    expect(
      pipelineStageConfigSchema.safeParse({
        variables: [],
        reviewerKind: "human",
      }).success,
    ).toBe(true);
    expect(
      pipelineStageConfigSchema.safeParse({
        variables: [],
        reviewerKind: "robot",
      }).success,
    ).toBe(false);
  });
});
