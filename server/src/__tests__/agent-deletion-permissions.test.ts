import { describe, expect, it } from "vitest";
import {
  normalizeAgentPermissions,
  defaultPermissionsForRole,
} from "../services/agent-permissions.js";

describe("agent deletion/termination permissions", () => {
  describe("defaultPermissionsForRole", () => {
    it("defaults canDeleteAgents to false for all roles", () => {
      expect(defaultPermissionsForRole("ceo").canDeleteAgents).toBe(false);
      expect(defaultPermissionsForRole("engineer").canDeleteAgents).toBe(false);
      expect(defaultPermissionsForRole("manager").canDeleteAgents).toBe(false);
    });

    it("defaults canTerminateAgents to false for all roles", () => {
      expect(defaultPermissionsForRole("ceo").canTerminateAgents).toBe(false);
      expect(defaultPermissionsForRole("engineer").canTerminateAgents).toBe(false);
      expect(defaultPermissionsForRole("manager").canTerminateAgents).toBe(false);
    });

    it("still defaults canCreateAgents to true for ceo", () => {
      expect(defaultPermissionsForRole("ceo").canCreateAgents).toBe(true);
      expect(defaultPermissionsForRole("engineer").canCreateAgents).toBe(false);
    });
  });

  describe("normalizeAgentPermissions", () => {
    it("normalizes canDeleteAgents from raw permissions", () => {
      const result = normalizeAgentPermissions({ canDeleteAgents: true }, "engineer");
      expect(result.canDeleteAgents).toBe(true);
      expect(result.canTerminateAgents).toBe(false);
      expect(result.canCreateAgents).toBe(false);
    });

    it("normalizes canTerminateAgents from raw permissions", () => {
      const result = normalizeAgentPermissions({ canTerminateAgents: true }, "engineer");
      expect(result.canTerminateAgents).toBe(true);
      expect(result.canDeleteAgents).toBe(false);
    });

    it("falls back to defaults for missing or invalid permissions", () => {
      expect(normalizeAgentPermissions(null, "engineer").canDeleteAgents).toBe(false);
      expect(normalizeAgentPermissions(null, "engineer").canTerminateAgents).toBe(false);
      expect(normalizeAgentPermissions(undefined, "engineer").canDeleteAgents).toBe(false);
      expect(normalizeAgentPermissions([], "engineer").canDeleteAgents).toBe(false);
    });

    it("ignores non-boolean permission values", () => {
      const result = normalizeAgentPermissions({ canDeleteAgents: "yes", canTerminateAgents: 1 }, "engineer");
      expect(result.canDeleteAgents).toBe(false);
      expect(result.canTerminateAgents).toBe(false);
    });

    it("preserves all permissions when all are set", () => {
      const result = normalizeAgentPermissions(
        { canCreateAgents: true, canDeleteAgents: true, canTerminateAgents: true },
        "engineer",
      );
      expect(result.canCreateAgents).toBe(true);
      expect(result.canDeleteAgents).toBe(true);
      expect(result.canTerminateAgents).toBe(true);
    });
  });
});
