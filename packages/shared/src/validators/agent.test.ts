import { describe, expect, it } from "vitest";
import { PERMISSION_KEYS } from "../constants.js";
import { updateAgentPermissionsSchema } from "./agent.js";

const baseUpdate = {
  canCreateAgents: false,
  canAssignTasks: true,
};

describe("updateAgentPermissionsSchema", () => {
  it("accepts an optional report-management grant", () => {
    expect(updateAgentPermissionsSchema.parse(baseUpdate).canManageReports).toBeUndefined();
    expect(updateAgentPermissionsSchema.parse({
      ...baseUpdate,
      canManageReports: true,
    }).canManageReports).toBe(true);
  });

  it("rejects non-boolean report-management grants", () => {
    expect(updateAgentPermissionsSchema.safeParse({
      ...baseUpdate,
      canManageReports: "true",
    }).success).toBe(false);
  });

  it("publishes the report-management permission key", () => {
    expect(PERMISSION_KEYS).toContain("issues:manage_reports");
  });
});
