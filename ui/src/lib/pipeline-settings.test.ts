import { describe, expect, it } from "vitest";
import { pipelineStageConfigSchema } from "@paperclipai/shared";

describe("pipeline settings stage config", () => {
  it("accepts disable and approval settings stored in stage config", () => {
    const parsed = pipelineStageConfigSchema.safeParse({
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
      approver: {
        kind: "agent",
        id: "agent-1",
      },
      whatHappensHere: "Triage every incoming item before work starts.",
    });

    expect(parsed.success).toBe(true);
  });

  it("requires a concrete approver when approval targets a specific person or agent", () => {
    const parsed = pipelineStageConfigSchema.safeParse({
      variables: [],
      requireApproval: true,
      approver: {
        kind: "user",
      },
    });

    expect(parsed.success).toBe(false);
  });
});
