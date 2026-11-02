import { describe, expect, it } from "vitest";
import { isAgentCreatedIssue } from "./issue-creation-source.js";

describe("task creation source", () => {
  it.each(["manual", "onboarding_first_task"])("preserves human-created %s tasks", (originKind) => {
    expect(isAgentCreatedIssue({ createdByUserId: "person", originKind })).toBe(false);
  });
  it.each(["chat_channel", "routine_execution", "stranded_issue_recovery", "task_watchdog", "harness_liveness_escalation", "plugin:workflow:operation", "built_in_agent_bundle", "pipeline_automation"])("classifies %s as automated even with human attribution", (originKind) => {
    expect(isAgentCreatedIssue({ createdByUserId: "person", originKind })).toBe(true);
  });
  it.each([null, "person"])("classifies channel work as automated with creator %s", (createdByUserId) => {
    expect(isAgentCreatedIssue({ originKind: "chat_channel", createdByUserId })).toBe(true);
  });
  it("recognizes agents and creator-less ordinary tasks", () => {
    expect(isAgentCreatedIssue({ createdByAgentId: "agent", originKind: "manual" })).toBe(true);
    expect(isAgentCreatedIssue({ originKind: "manual" })).toBe(true);
    expect(isAgentCreatedIssue({ createdByUserId: "person", createdByAgentId: "agent" })).toBe(true);
    expect(isAgentCreatedIssue({ createdByUserId: "person" })).toBe(false);
  });
});
