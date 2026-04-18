import { describe, expect, it } from "vitest";
import { createIssueInputSchema } from "../routes/issue-input-schema.js";

const FAKE_UUID = "00000000-0000-0000-0000-000000000001";

describe("createIssueInputSchema — issue #3458 regression", () => {
  it("passes assigneeAgentId through unchanged when correctly named", () => {
    const result = createIssueInputSchema.parse({
      title: "Test issue",
      assigneeAgentId: FAKE_UUID,
    });
    expect(result.assigneeAgentId).toBe(FAKE_UUID);
  });

  it("aliases assigneeId to assigneeAgentId (common LLM mistake)", () => {
    const result = createIssueInputSchema.parse({
      title: "Test issue",
      assigneeId: FAKE_UUID,
    });
    expect(result.assigneeAgentId).toBe(FAKE_UUID);
  });

  it("does not override explicit assigneeAgentId when assigneeId is also present", () => {
    const OTHER_UUID = "00000000-0000-0000-0000-000000000002";
    const result = createIssueInputSchema.parse({
      title: "Test issue",
      assigneeAgentId: FAKE_UUID,
      assigneeId: OTHER_UUID,
    });
    expect(result.assigneeAgentId).toBe(FAKE_UUID);
  });

  it("leaves assigneeAgentId as undefined when neither field is provided", () => {
    const result = createIssueInputSchema.parse({ title: "Test issue" });
    expect(result.assigneeAgentId).toBeUndefined();
  });
});
