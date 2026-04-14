import { describe, it, expect } from "vitest";
import {
  defaultPermissionsForRole,
  normalizeAgentPermissions,
  type NormalizedAgentPermissions,
} from "../services/agent-permissions.js";

describe("agent-permissions", () => {
  describe("defaultPermissionsForRole", () => {
    it("returns canCreateAgents: true for CEO role", () => {
      const permissions = defaultPermissionsForRole("ceo");
      
      expect(permissions).toMatchObject({
        canCreateAgents: true,
      });
    });

    it("returns canCreateAgents: false for non-CEO roles", () => {
      const roles = ["agent", "admin", "user", "manager", "lead", "developer"];
      
      for (const role of roles) {
        const permissions = defaultPermissionsForRole(role);
        expect(permissions).toMatchObject({
          canCreateAgents: false,
        });
      }
    });

    it("returns canCreateAgents: false for empty string role", () => {
      const permissions = defaultPermissionsForRole("");
      
      expect(permissions).toMatchObject({
        canCreateAgents: false,
      });
    });

    it("is case-sensitive for CEO role", () => {
      const upperCase = defaultPermissionsForRole("CEO");
      const mixedCase = defaultPermissionsForRole("Ceo");
      
      expect(upperCase.canCreateAgents).toBe(false);
      expect(mixedCase.canCreateAgents).toBe(false);
    });
  });

  describe("normalizeAgentPermissions", () => {
    describe("with valid permissions object", () => {
      it("preserves explicit canCreateAgents: true", () => {
        const permissions = { canCreateAgents: true };
        const normalized = normalizeAgentPermissions(permissions, "agent");
        
        expect(normalized.canCreateAgents).toBe(true);
      });

      it("preserves explicit canCreateAgents: false", () => {
        const permissions = { canCreateAgents: false };
        const normalized = normalizeAgentPermissions(permissions, "ceo");
        
        expect(normalized.canCreateAgents).toBe(false);
      });

      it("handles extra properties in permissions object", () => {
        const permissions = {
          canCreateAgents: true,
          someOtherProperty: "value",
          anotherProp: 42,
        };
        const normalized = normalizeAgentPermissions(permissions, "agent");
        
        expect(normalized.canCreateAgents).toBe(true);
        // Should preserve the structure but we don't specify other properties in the type
      });

      it("falls back to role defaults when canCreateAgents is not a boolean", () => {
        const testCases = [
          { canCreateAgents: "true" }, // string
          { canCreateAgents: 1 }, // number
          { canCreateAgents: {} }, // object
          { canCreateAgents: [] }, // array
          { canCreateAgents: null }, // null
          { canCreateAgents: undefined }, // undefined
        ];

        for (const permissions of testCases) {
          const normalizedForCeo = normalizeAgentPermissions(permissions, "ceo");
          const normalizedForAgent = normalizeAgentPermissions(permissions, "agent");
          
          expect(normalizedForCeo.canCreateAgents).toBe(true);
          expect(normalizedForAgent.canCreateAgents).toBe(false);
        }
      });

      it("falls back to role defaults when canCreateAgents is missing", () => {
        const permissions = { someOtherProperty: "value" };
        
        const normalizedForCeo = normalizeAgentPermissions(permissions, "ceo");
        const normalizedForAgent = normalizeAgentPermissions(permissions, "agent");
        
        expect(normalizedForCeo.canCreateAgents).toBe(true);
        expect(normalizedForAgent.canCreateAgents).toBe(false);
      });
    });

    describe("with invalid permissions input", () => {
      it("falls back to role defaults when permissions is null", () => {
        const normalizedForCeo = normalizeAgentPermissions(null, "ceo");
        const normalizedForAgent = normalizeAgentPermissions(null, "agent");
        
        expect(normalizedForCeo.canCreateAgents).toBe(true);
        expect(normalizedForAgent.canCreateAgents).toBe(false);
      });

      it("falls back to role defaults when permissions is undefined", () => {
        const normalizedForCeo = normalizeAgentPermissions(undefined, "ceo");
        const normalizedForAgent = normalizeAgentPermissions(undefined, "agent");
        
        expect(normalizedForCeo.canCreateAgents).toBe(true);
        expect(normalizedForAgent.canCreateAgents).toBe(false);
      });

      it("falls back to role defaults when permissions is an array", () => {
        const permissions = [{ canCreateAgents: true }];
        
        const normalizedForCeo = normalizeAgentPermissions(permissions, "ceo");
        const normalizedForAgent = normalizeAgentPermissions(permissions, "agent");
        
        expect(normalizedForCeo.canCreateAgents).toBe(true);
        expect(normalizedForAgent.canCreateAgents).toBe(false);
      });

      it("falls back to role defaults when permissions is a primitive", () => {
        const primitives = ["string", 42, true, false];
        
        for (const permissions of primitives) {
          const normalizedForCeo = normalizeAgentPermissions(permissions, "ceo");
          const normalizedForAgent = normalizeAgentPermissions(permissions, "agent");
          
          expect(normalizedForCeo.canCreateAgents).toBe(true);
          expect(normalizedForAgent.canCreateAgents).toBe(false);
        }
      });
    });

    describe("integration behavior", () => {
      it("correctly handles CEO override scenarios", () => {
        // CEO role should default to canCreateAgents: true
        // but explicit false should override it
        const explicitFalse = normalizeAgentPermissions(
          { canCreateAgents: false }, 
          "ceo"
        );
        expect(explicitFalse.canCreateAgents).toBe(false);

        // CEO role with no explicit permission should default to true
        const noExplicitPermission = normalizeAgentPermissions({}, "ceo");
        expect(noExplicitPermission.canCreateAgents).toBe(true);
      });

      it("correctly handles non-CEO override scenarios", () => {
        // Non-CEO role should default to canCreateAgents: false
        // but explicit true should override it
        const explicitTrue = normalizeAgentPermissions(
          { canCreateAgents: true }, 
          "agent"
        );
        expect(explicitTrue.canCreateAgents).toBe(true);

        // Non-CEO role with no explicit permission should default to false
        const noExplicitPermission = normalizeAgentPermissions({}, "agent");
        expect(noExplicitPermission.canCreateAgents).toBe(false);
      });
    });

    describe("type safety", () => {
      it("returns object that satisfies NormalizedAgentPermissions type", () => {
        const result = normalizeAgentPermissions({ canCreateAgents: true }, "ceo");
        
        // TypeScript compilation ensures this, but let's verify structure
        expect(result).toHaveProperty("canCreateAgents");
        expect(typeof result.canCreateAgents).toBe("boolean");
        
        // Verify it matches the expected type structure
        const typed: NormalizedAgentPermissions = result;
        expect(typed.canCreateAgents).toBe(true);
      });
    });
  });
});