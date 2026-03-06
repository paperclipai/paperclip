import { describe, expect, it } from "vitest";
import { updateMemberPermissionsSchema } from "@paperclipai/shared";
import { evaluateTasksAssignScope, parseTasksAssignScope } from "../services/assignment-scope.js";

describe("tasks:assign_scope validator", () => {
  it("rejects unknown scope keys", () => {
    const parsed = updateMemberPermissionsSchema.safeParse({
      grants: [
        {
          permissionKey: "tasks:assign_scope",
          scope: {
            projectIds: ["*"],
            allowedAssigneeRoles: ["pm"],
            unknownKey: true,
          },
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("parseTasksAssignScope", () => {
  it("normalizes valid scopes and defaults denied role to ceo", () => {
    const parsed = parseTasksAssignScope({
      projectIds: ["550e8400-e29b-41d4-a716-446655440000"],
      allowedAssigneeRoles: ["PM"],
      allowUnassign: true,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.scope.projectIds.has("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(parsed.scope.allowedAssigneeRoles.has("pm")).toBe(true);
    expect(parsed.scope.deniedAssigneeRoles.has("ceo")).toBe(true);
    expect(parsed.scope.allowUnassign).toBe(true);
  });

  it("rejects scopes with no assignee allow-list", () => {
    const parsed = parseTasksAssignScope({
      projectIds: ["*"],
    });
    expect(parsed.ok).toBe(false);
  });
});

describe("evaluateTasksAssignScope", () => {
  const parsed = parseTasksAssignScope({
    projectIds: ["550e8400-e29b-41d4-a716-446655440000"],
    allowedAssigneeRoles: ["pm", "security"],
    allowedAssigneeAgentIds: ["8f5e5a11-cb3e-4b6a-b311-f4d2ad0f94a5"],
    allowUnassign: false,
    allowAssignToUsers: false,
  });

  if (!parsed.ok) {
    throw new Error("test fixture scope must parse");
  }

  const scope = parsed.scope;

  it("allows in-scope role assignment", () => {
    const decision = evaluateTasksAssignScope(scope, {
      projectId: "550e8400-e29b-41d4-a716-446655440000",
      assigneeAgentId: "1fcf389b-a74f-42b7-90a8-112635f74d7e",
      assigneeAgentRole: "security",
      assigneeUserId: null,
    });
    expect(decision).toEqual({ allowed: true });
  });

  it("denies out-of-scope project assignment", () => {
    const decision = evaluateTasksAssignScope(scope, {
      projectId: "cb9f4f97-9dd9-4cc1-9dfc-1dff7f35cd89",
      assigneeAgentId: "1fcf389b-a74f-42b7-90a8-112635f74d7e",
      assigneeAgentRole: "security",
      assigneeUserId: null,
    });
    expect(decision).toEqual({ allowed: false, reason: "project_out_of_scope" });
  });

  it("denies CEO role even when role allow-list is present", () => {
    const decision = evaluateTasksAssignScope(scope, {
      projectId: "550e8400-e29b-41d4-a716-446655440000",
      assigneeAgentId: "1fcf389b-a74f-42b7-90a8-112635f74d7e",
      assigneeAgentRole: "ceo",
      assigneeUserId: null,
    });
    expect(decision).toEqual({ allowed: false, reason: "assignee_role_denied" });
  });

  it("denies user assignment when scope disallows assignee users", () => {
    const decision = evaluateTasksAssignScope(scope, {
      projectId: "550e8400-e29b-41d4-a716-446655440000",
      assigneeAgentId: null,
      assigneeAgentRole: null,
      assigneeUserId: "user-1",
    });
    expect(decision).toEqual({ allowed: false, reason: "assign_user_not_allowed" });
  });

  it("denies unassign when allowUnassign is false", () => {
    const decision = evaluateTasksAssignScope(scope, {
      projectId: "550e8400-e29b-41d4-a716-446655440000",
      assigneeAgentId: null,
      assigneeAgentRole: null,
      assigneeUserId: null,
    });
    expect(decision).toEqual({ allowed: false, reason: "unassign_not_allowed" });
  });
});
