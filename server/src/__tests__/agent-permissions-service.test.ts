import { describe, expect, it } from "vitest";
import {
  agentPermissionsSchema,
  updateAgentPermissionsSchema,
} from "@paperclipai/shared";
import {
  defaultPermissionsForRole,
  normalizeAgentPermissions,
  sanitizePermissionsForUpdate,
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

  it("accepts an explicit null authorizationPolicy on the update schema (clear-intent payload)", () => {
    const parsed = updateAgentPermissionsSchema.parse({
      canCreateAgents: false,
      canAssignTasks: true,
      authorizationPolicy: null,
    });
    expect(parsed.authorizationPolicy).toBeNull();
  });

  it("accepts an explicit null authorizationPolicy on the base permissions schema", () => {
    const parsed = agentPermissionsSchema.parse({
      canCreateAgents: false,
      authorizationPolicy: null,
    });
    expect(parsed.authorizationPolicy).toBeNull();
  });
});

describe("sanitizePermissionsForUpdate", () => {
  it("drops stale nested authorizationPolicy when trustPreset changes without an explicit policy key", () => {
    const existing = {
      canCreateAgents: false,
      trustPreset: "low_trust_review",
      authorizationPolicy: {
        trustPreset: "low_trust_review",
        reviewPreset: { id: "low_trust_review", version: 1, rawOutputDisposition: "quarantine" },
      },
    };
    const result = sanitizePermissionsForUpdate(existing, {
      canCreateAgents: false,
      trustPreset: "standard",
    });
    expect(result).not.toHaveProperty("authorizationPolicy");
    expect(result.trustPreset).toBe("standard");
    expect(result.canCreateAgents).toBe(false);
  });

  it("drops nested authorizationPolicy when the payload sends an explicit null", () => {
    const existing = {
      canCreateAgents: false,
      trustPreset: "standard",
      authorizationPolicy: { trustPreset: "low_trust_review" },
    };
    const result = sanitizePermissionsForUpdate(existing, {
      canCreateAgents: false,
      authorizationPolicy: null,
    });
    expect(result).not.toHaveProperty("authorizationPolicy");
  });

  it("preserves existing nested authorizationPolicy on partial updates with neither preset nor policy key", () => {
    const existing = {
      canCreateAgents: false,
      trustPreset: "low_trust_review",
      authorizationPolicy: { trustPreset: "low_trust_review" },
    };
    const result = sanitizePermissionsForUpdate(existing, {
      canCreateAgents: true,
    });
    expect(result.authorizationPolicy).toEqual({ trustPreset: "low_trust_review" });
    expect(result.canCreateAgents).toBe(true);
    expect(result.trustPreset).toBe("low_trust_review");
  });

  it("preserves nested authorizationPolicy when the trustPreset value does not actually change", () => {
    const existing = {
      canCreateAgents: false,
      trustPreset: "standard",
      authorizationPolicy: { trustPreset: "standard" },
    };
    const result = sanitizePermissionsForUpdate(existing, {
      canCreateAgents: false,
      trustPreset: "standard",
    });
    expect(result.authorizationPolicy).toEqual({ trustPreset: "standard" });
  });

  it("keeps an explicit authorizationPolicy from the payload when the preset also changes", () => {
    const existing = {
      canCreateAgents: false,
      trustPreset: "standard",
    };
    const explicitPolicy = { trustPreset: "low_trust_review" };
    const result = sanitizePermissionsForUpdate(existing, {
      canCreateAgents: false,
      trustPreset: "low_trust_review",
      authorizationPolicy: explicitPolicy,
    });
    expect(result.authorizationPolicy).toEqual(explicitPolicy);
    expect(result.trustPreset).toBe("low_trust_review");
  });

  it("treats missing or non-object existing permissions as an empty record", () => {
    expect(sanitizePermissionsForUpdate(null, { canCreateAgents: true })).toEqual({
      canCreateAgents: true,
    });
    expect(sanitizePermissionsForUpdate(undefined, { canCreateAgents: false })).toEqual({
      canCreateAgents: false,
    });
    expect(sanitizePermissionsForUpdate("garbage", { canCreateAgents: true })).toEqual({
      canCreateAgents: true,
    });
  });
});
