import { describe, expect, it } from "vitest";
import {
  canAssignTasksWithDefaultPermissionFlag,
  hasDefaultAgentPermissionSet,
  type AssignmentTargetType,
} from "../routes/issues.js";

function canAssign(
  role: string,
  permissions: Record<string, unknown> | null | undefined,
  assignmentTargetType: AssignmentTargetType,
  flagEnabled: boolean,
) {
  return canAssignTasksWithDefaultPermissionFlag(
    { role, permissions },
    assignmentTargetType,
    flagEnabled,
  );
}

describe("hasDefaultAgentPermissionSet", () => {
  it("treats missing permissions as role defaults", () => {
    expect(hasDefaultAgentPermissionSet({ role: "general", permissions: null })).toBe(true);
    expect(hasDefaultAgentPermissionSet({ role: "ceo", permissions: null })).toBe(true);
  });

  it("treats empty permission objects as defaults", () => {
    expect(hasDefaultAgentPermissionSet({ role: "general", permissions: {} })).toBe(true);
    expect(hasDefaultAgentPermissionSet({ role: "ceo", permissions: {} })).toBe(true);
  });

  it("detects permission overrides that differ from defaults", () => {
    expect(
      hasDefaultAgentPermissionSet({
        role: "general",
        permissions: { canCreateAgents: true },
      }),
    ).toBe(false);
    expect(
      hasDefaultAgentPermissionSet({
        role: "ceo",
        permissions: { canCreateAgents: false },
      }),
    ).toBe(false);
    expect(
      hasDefaultAgentPermissionSet({
        role: "general",
        permissions: { canCreateAgents: false },
      }),
    ).toBe(false);
  });
});

describe("canAssignTasksWithDefaultPermissionFlag", () => {
  it("allows assigning to agents when flag is enabled and permissions are defaults", () => {
    expect(canAssign("general", null, "agent", true)).toBe(true);
    expect(canAssign("general", {}, "agent", true)).toBe(true);
  });

  it("blocks non-agent assignment targets even when flag is enabled", () => {
    expect(canAssign("general", null, "user", true)).toBe(false);
    expect(canAssign("general", null, "unassigned", true)).toBe(false);
  });

  it("blocks assignments when flag is disabled", () => {
    expect(canAssign("general", null, "agent", false)).toBe(false);
  });

  it("blocks assignments when permissions are not default", () => {
    expect(canAssign("general", { canCreateAgents: true }, "agent", true)).toBe(false);
    expect(canAssign("general", { canCreateAgents: false }, "agent", true)).toBe(false);
  });
});
