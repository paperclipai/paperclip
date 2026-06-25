import { describe, expect, it } from "vitest";
import {
  agentPermissionsSchema,
  updateAgentPermissionsSchema,
} from "@paperclipai/shared";
import {
  defaultPermissionsForRole,
  normalizeAgentPermissions,
} from "../services/agent-permissions.js";

describe("agent permissions service", () => {
  it("keeps agent-creation authority least-privileged by default", () => {
    expect(defaultPermissionsForRole("ceo").canCreateAgents).toBe(true);
    expect(defaultPermissionsForRole("CTO").canCreateAgents).toBe(false);
    expect(defaultPermissionsForRole("engineering-manager").canCreateAgents).toBe(false);
    expect(defaultPermissionsForRole("engineer").canCreateAgents).toBe(false);
  });

  it("enables skill creation for every role by default", () => {
    expect(defaultPermissionsForRole("ceo").canCreateSkills).toBe(true);
    expect(defaultPermissionsForRole("CTO").canCreateSkills).toBe(true);
    expect(defaultPermissionsForRole("engineering-manager").canCreateSkills).toBe(true);
    expect(defaultPermissionsForRole("engineer").canCreateSkills).toBe(true);
  });

  it("preserves explicit canCreateAgents overrides", () => {
    expect(normalizeAgentPermissions({ canCreateAgents: false }, "cto").canCreateAgents).toBe(false);
    expect(normalizeAgentPermissions({ canCreateAgents: true }, "engineer").canCreateAgents).toBe(true);
  });

  it("defaults missing skill creation permission to true and preserves explicit false", () => {
    expect(normalizeAgentPermissions({}, "engineer").canCreateSkills).toBe(true);
    expect(normalizeAgentPermissions({ canCreateSkills: false }, "ceo").canCreateSkills).toBe(false);
    expect(normalizeAgentPermissions({ canCreateSkills: true }, "engineer").canCreateSkills).toBe(true);
  });

  it("validates skill creation permission with a default-on value", () => {
    expect(agentPermissionsSchema.parse({ canCreateAgents: false }).canCreateSkills).toBe(true);
    expect(agentPermissionsSchema.parse({ canCreateAgents: false, canCreateSkills: false }).canCreateSkills).toBe(false);
    expect(updateAgentPermissionsSchema.parse({
      canCreateAgents: false,
      canAssignTasks: false,
    }).canCreateSkills).toBeUndefined();
    expect(updateAgentPermissionsSchema.parse({
      canCreateAgents: false,
      canCreateSkills: false,
      canAssignTasks: false,
    }).canCreateSkills).toBe(false);
  });
});
