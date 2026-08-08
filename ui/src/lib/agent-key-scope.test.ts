import { describe, expect, it } from "vitest";
import {
  buildAgentKeyScopePayload,
  describeAgentKeyScope,
  validateAgentKeyScopeDraft,
} from "./agent-key-scope";

const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const parentIssueId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const agentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("agent key scope form", () => {
  it("builds standard key scope payloads", () => {
    expect(buildAgentKeyScopePayload({
      mode: "standard",
      projectId,
      parentIssueId,
      allowedAssigneeAgentIds: [agentId],
    })).toEqual({ kind: "standard" });
  });

  it("builds deduplicated task bridge scope payloads", () => {
    expect(buildAgentKeyScopePayload({
      mode: "task_bridge",
      projectId,
      parentIssueId,
      allowedAssigneeAgentIds: [agentId, agentId],
    })).toEqual({
      kind: "task_bridge",
      projectId,
      parentIssueId,
      allowedAssigneeAgentIds: [agentId],
    });
  });

  it("requires at least one task bridge boundary", () => {
    expect(validateAgentKeyScopeDraft({
      mode: "task_bridge",
      projectId: "",
      parentIssueId: "",
      allowedAssigneeAgentIds: [],
    })).toContain("project boundary");
  });

  it("rejects malformed manually entered parent ids", () => {
    expect(validateAgentKeyScopeDraft({
      mode: "task_bridge",
      projectId: "",
      parentIssueId: "SYSA-1609",
      allowedAssigneeAgentIds: [],
    })).toContain("valid UUID");
  });

  it("accepts a project-scoped bridge with selected assignees", () => {
    expect(validateAgentKeyScopeDraft({
      mode: "task_bridge",
      projectId,
      parentIssueId: "",
      allowedAssigneeAgentIds: [agentId],
    })).toBeNull();
  });

  it("describes stored scope without exposing token material", () => {
    expect(describeAgentKeyScope({
      kind: "task_bridge",
      projectId,
      allowedAssigneeAgentIds: [agentId],
    })).toBe("Task bridge (1 boundary, 1 allowed assignee)");
    expect(describeAgentKeyScope({
      kind: "skill_test",
      issueId: parentIssueId,
    })).toBe("Skill test");
  });
});
