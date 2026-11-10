import { describe, expect, it } from "vitest";
import {
  LOW_TRUST_REVIEW_PRESET,
  agentPermissionsSchema,
  updateAgentPermissionsSchema,
} from "@paperclipai/shared";
import {
  defaultAgentPermissions,
  normalizeAgentPermissions,
  permissionsImplyLowTrust,
} from "../lib/agent-permissions.js";

describe("agent permissions service", () => {
  it("grants agent-creation authority to new agents by default", () => {
    expect(defaultAgentPermissions({ context: "create" }).canCreateAgents).toBe(true);
    expect(normalizeAgentPermissions(undefined, { context: "create" }).canCreateAgents).toBe(true);
    expect(normalizeAgentPermissions({}, { context: "create" }).canCreateAgents).toBe(true);
    expect(
      normalizeAgentPermissions({ trustPreset: "standard" }, { context: "create" }).canCreateAgents,
    ).toBe(true);
  });

  it("keeps stored rows without an explicit value fail-closed", () => {
    expect(defaultAgentPermissions().canCreateAgents).toBe(false);
    expect(defaultAgentPermissions({ context: "stored" }).canCreateAgents).toBe(false);
    expect(normalizeAgentPermissions(undefined).canCreateAgents).toBe(false);
    expect(normalizeAgentPermissions({}).canCreateAgents).toBe(false);
    expect(normalizeAgentPermissions("malformed").canCreateAgents).toBe(false);
    expect(normalizeAgentPermissions([]).canCreateAgents).toBe(false);
  });

  it("reports a CEO's hiring authority unless the board recorded a denial", () => {
    expect(normalizeAgentPermissions({}, { role: "ceo" }).canCreateAgents).toBe(true);
    expect(normalizeAgentPermissions(undefined, { role: "ceo" }).canCreateAgents).toBe(true);
    expect(normalizeAgentPermissions({ canCreateAgents: false }, { role: "ceo" }).canCreateAgents).toBe(true);
    const denial = { actorType: "user", actorId: "board-user", at: "2026-11-08T00:00:00.000Z" };
    expect(normalizeAgentPermissions({ canCreateAgents: false, ceoHiringDeniedBy: denial }, { role: "ceo" }))
      .toMatchObject({ canCreateAgents: false, ceoHiringDeniedBy: denial });
    expect(normalizeAgentPermissions({ canCreateAgents: true, ceoHiringDeniedBy: denial }, { role: "ceo" })).not.toHaveProperty("ceoHiringDeniedBy");
    expect(normalizeAgentPermissions({ canCreateAgents: false, ceoHiringDeniedBy: { actorType: "forged" } }, { role: "ceo" }).canCreateAgents).toBe(true);
    expect(normalizeAgentPermissions({ trustPreset: LOW_TRUST_REVIEW_PRESET }, { role: "ceo" }).canCreateAgents).toBe(false);
    expect(normalizeAgentPermissions({}, { role: "engineer" }).canCreateAgents).toBe(false);
  });

  it("withholds agent-creation authority from new low-trust agents", () => {
    expect(defaultAgentPermissions({ lowTrust: true, context: "create" }).canCreateAgents).toBe(false);
    expect(
      normalizeAgentPermissions(
        { trustPreset: LOW_TRUST_REVIEW_PRESET },
        { context: "create" },
      ).canCreateAgents,
    ).toBe(false);
    expect(
      normalizeAgentPermissions(
        { authorizationPolicy: { trustPreset: LOW_TRUST_REVIEW_PRESET } },
        { context: "create" },
      ).canCreateAgents,
    ).toBe(false);
    expect(
      normalizeAgentPermissions(
        { authorizationPolicy: { trustBoundary: { mode: LOW_TRUST_REVIEW_PRESET } } },
        { context: "create" },
      ).canCreateAgents,
    ).toBe(false);
  });

  it("detects low-trust markers wherever the trust policy stores them", () => {
    expect(permissionsImplyLowTrust(undefined)).toBe(false);
    expect(permissionsImplyLowTrust({})).toBe(false);
    expect(permissionsImplyLowTrust({ trustPreset: "standard" })).toBe(false);
    expect(permissionsImplyLowTrust({ trustPreset: LOW_TRUST_REVIEW_PRESET })).toBe(true);
    expect(permissionsImplyLowTrust({ reviewPreset: { id: LOW_TRUST_REVIEW_PRESET } })).toBe(true);
    expect(
      permissionsImplyLowTrust({ authorizationPolicy: { trustPreset: LOW_TRUST_REVIEW_PRESET } }),
    ).toBe(true);
    expect(
      permissionsImplyLowTrust({
        authorizationPolicy: { reviewPreset: { id: LOW_TRUST_REVIEW_PRESET } },
      }),
    ).toBe(true);
    expect(
      permissionsImplyLowTrust({
        authorizationPolicy: { trustBoundary: { mode: LOW_TRUST_REVIEW_PRESET } },
      }),
    ).toBe(true);
  });

  it("enables skill creation by default", () => {
    expect(defaultAgentPermissions().canCreateSkills).toBe(true);
    expect(defaultAgentPermissions({ lowTrust: true, context: "create" }).canCreateSkills).toBe(true);
  });

  it("preserves explicit canCreateAgents overrides in both contexts", () => {
    expect(normalizeAgentPermissions({ canCreateAgents: false }, { context: "create" }).canCreateAgents).toBe(false);
    expect(normalizeAgentPermissions({ canCreateAgents: true }).canCreateAgents).toBe(true);
    expect(
      normalizeAgentPermissions({
        canCreateAgents: true,
        trustPreset: LOW_TRUST_REVIEW_PRESET,
      }).canCreateAgents,
    ).toBe(true);
  });

  it("defaults missing skill creation permission to true and preserves explicit false", () => {
    expect(normalizeAgentPermissions({}).canCreateSkills).toBe(true);
    expect(normalizeAgentPermissions({ canCreateSkills: false }).canCreateSkills).toBe(false);
    expect(normalizeAgentPermissions({ canCreateSkills: true }).canCreateSkills).toBe(true);
  });

  it("leaves omitted canCreateAgents undefined at the schema layer", () => {
    expect(agentPermissionsSchema.parse({}).canCreateAgents).toBeUndefined();
    expect(agentPermissionsSchema.parse({ canCreateAgents: false }).canCreateAgents).toBe(false);
    expect(agentPermissionsSchema.parse({ canCreateAgents: true }).canCreateAgents).toBe(true);
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
