import { describe, expect, it } from "vitest";
import { wakeAgentSchema } from "./agent.js";

describe("wake agent schema", () => {
  it("keeps the task scope when the caller sends issueId at the top level", () => {
    const parsed = wakeAgentSchema.parse({
      source: "on_demand",
      issueId: "11111111-1111-4111-8111-111111111111",
    });
    expect(parsed.issueId).toBe("11111111-1111-4111-8111-111111111111");
    expect(parsed.payload).toBeUndefined();
  });

  it("keeps the task scope when the caller sends taskId at the top level", () => {
    const parsed = wakeAgentSchema.parse({
      taskId: "22222222-2222-4222-8222-222222222222",
    });
    expect(parsed.taskId).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("keeps the canonical payload task scope untouched", () => {
    const parsed = wakeAgentSchema.parse({
      payload: { issueId: "33333333-3333-4333-8333-333333333333" },
    });
    expect(parsed.payload).toEqual({ issueId: "33333333-3333-4333-8333-333333333333" });
    expect(parsed.issueId).toBeUndefined();
  });

  it("rejects a top-level task id that is not a uuid", () => {
    const result = wakeAgentSchema.safeParse({ issueId: "issue-1" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ["issueId"] }),
      ]));
    }
  });
});
