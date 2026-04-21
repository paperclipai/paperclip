import { describe, expect, it } from "vitest";
import { isAgentAssignableStatus } from "../services/agent-assignment-status.ts";

describe("isAgentAssignableStatus", () => {
  it("treats active routing states as assignable", () => {
    expect(isAgentAssignableStatus("idle")).toBe(true);
    expect(isAgentAssignableStatus("running")).toBe(true);
    expect(isAgentAssignableStatus("active")).toBe(true);
    expect(isAgentAssignableStatus(null)).toBe(true);
  });

  it("treats blocked operational states as unassignable", () => {
    expect(isAgentAssignableStatus("error")).toBe(false);
    expect(isAgentAssignableStatus("paused")).toBe(false);
    expect(isAgentAssignableStatus("terminated")).toBe(false);
    expect(isAgentAssignableStatus("pending_approval")).toBe(false);
  });
});
