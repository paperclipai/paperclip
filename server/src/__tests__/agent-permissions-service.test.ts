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
  stripAgentCoordinationAuthority,
} from "../services/agent-permissions.js";

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

  it("defaults coordination authority to false in every normalization context", () => {
    expect(defaultAgentPermissions().canCoordinateCompanyWork).toBe(false);
    expect(defaultAgentPermissions({ context: "create" }).canCoordinateCompanyWork).toBe(false);
    expect(normalizeAgentPermissions(undefined).canCoordinateCompanyWork).toBe(false);
    expect(normalizeAgentPermissions(undefined, { context: "create" }).canCoordinateCompanyWork).toBe(false);
    expect(normalizeAgentPermissions({}).canCoordinateCompanyWork).toBe(false);
    expect(normalizeAgentPermissions({}, { context: "create" }).canCoordinateCompanyWork).toBe(false);
    expect(normalizeAgentPermissions("malformed").canCoordinateCompanyWork).toBe(false);
    expect(normalizeAgentPermissions([]).canCoordinateCompanyWork).toBe(false);
  });

  it("forces coordination authority false at creation even when input claims it", () => {
    expect(
      normalizeAgentPermissions({ canCoordinateCompanyWork: true }, { context: "create" }).canCoordinateCompanyWork,
    ).toBe(false);
    expect(
      normalizeAgentPermissions(
        { trustPreset: "standard", canCoordinateCompanyWork: true },
        { context: "create" },
      ).canCoordinateCompanyWork,
    ).toBe(false);
  });

  it("preserves an explicit board grant on stored rows only", () => {
    expect(normalizeAgentPermissions({ canCoordinateCompanyWork: true }).canCoordinateCompanyWork).toBe(true);
    expect(normalizeAgentPermissions({ canCoordinateCompanyWork: false }).canCoordinateCompanyWork).toBe(false);
  });

  it("strips coordination authority from imported permission records", () => {
    expect(
      stripAgentCoordinationAuthority({ canCoordinateCompanyWork: true, canCreateAgents: false }),
    ).toEqual({ canCreateAgents: false });
    expect(stripAgentCoordinationAuthority({ canCreateAgents: true })).toEqual({ canCreateAgents: true });
    expect(stripAgentCoordinationAuthority(null)).toBeNull();
    expect(stripAgentCoordinationAuthority(undefined)).toBeUndefined();
    // Normalizing the stripped record keeps the grant off.
    expect(
      normalizeAgentPermissions(stripAgentCoordinationAuthority({ canCoordinateCompanyWork: true })),
    ).toMatchObject({ canCoordinateCompanyWork: false });
  });

  it("round-trips the coordination flag on the wire schemas without a default", () => {
    expect(agentPermissionsSchema.parse({}).canCoordinateCompanyWork).toBeUndefined();
    expect(agentPermissionsSchema.parse({ canCoordinateCompanyWork: true }).canCoordinateCompanyWork).toBe(true);
    expect(
      updateAgentPermissionsSchema.parse({ canCreateAgents: false, canAssignTasks: false }).canCoordinateCompanyWork,
    ).toBeUndefined();
    expect(
      updateAgentPermissionsSchema.parse({
        canCreateAgents: false,
        canAssignTasks: false,
        canCoordinateCompanyWork: true,
      }).canCoordinateCompanyWork,
    ).toBe(true);
  });
});
