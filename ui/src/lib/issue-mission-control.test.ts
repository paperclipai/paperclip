import { describe, expect, it } from "vitest";
import { issueMissionControlMetadataSchema } from "@paperclipai/shared";

describe("issueMissionControlMetadataSchema", () => {
  it("accepts a mission-control workflow state", () => {
    const parsed = issueMissionControlMetadataSchema.parse({
      workflowState: {
        kind: "waiting_on_human",
        enteredAt: "2026-04-18T10:00:00.000Z",
      },
    });

    expect(parsed.workflowState).toMatchObject({
      kind: "waiting_on_human",
    });
    expect(parsed.workflowState?.enteredAt).toBeInstanceOf(Date);
  });

  it("requires resumed workflow states to declare what resumed", () => {
    const result = issueMissionControlMetadataSchema.safeParse({
      workflowState: {
        kind: "resumed",
        enteredAt: "2026-04-18T10:00:00.000Z",
      },
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected validation failure");
    expect(result.error.issues[0]?.message).toContain("resumedFrom");
  });

  it("rejects resumedFrom on non-resumed workflow states", () => {
    const result = issueMissionControlMetadataSchema.safeParse({
      workflowState: {
        kind: "handed_off",
        enteredAt: "2026-04-18T10:00:00.000Z",
        resumedFrom: "waiting_on_human",
      },
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected validation failure");
    expect(result.error.issues[0]?.message).toContain("resumed");
  });
});
