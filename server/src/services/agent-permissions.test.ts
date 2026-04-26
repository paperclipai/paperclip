import { describe, expect, it } from "vitest";
import {
  defaultPermissionsForRole,
  normalizeAgentPermissions,
} from "./agent-permissions.js";

// ============================================================================
// defaultPermissionsForRole
// ============================================================================

describe("defaultPermissionsForRole", () => {
  it("grants canCreateAgents=true for role 'ceo'", () => {
    const perms = defaultPermissionsForRole("ceo");
    expect(perms.canCreateAgents).toBe(true);
  });

  it("grants canCreateAgents=false for role 'cto'", () => {
    const perms = defaultPermissionsForRole("cto");
    expect(perms.canCreateAgents).toBe(false);
  });

  it("grants canCreateAgents=false for role 'engineer'", () => {
    const perms = defaultPermissionsForRole("engineer");
    expect(perms.canCreateAgents).toBe(false);
  });

  it("grants canCreateAgents=false for empty role", () => {
    const perms = defaultPermissionsForRole("");
    expect(perms.canCreateAgents).toBe(false);
  });

  it("grants canCreateAgents=false for unknown role", () => {
    const perms = defaultPermissionsForRole("contractor");
    expect(perms.canCreateAgents).toBe(false);
  });

  it("returns an object with at least canCreateAgents", () => {
    const perms = defaultPermissionsForRole("ceo");
    expect(perms).toHaveProperty("canCreateAgents");
  });
});

// ============================================================================
// normalizeAgentPermissions
// ============================================================================

describe("normalizeAgentPermissions", () => {
  it("uses stored canCreateAgents=true when explicitly set", () => {
    const perms = normalizeAgentPermissions({ canCreateAgents: true }, "engineer");
    expect(perms.canCreateAgents).toBe(true);
  });

  it("uses stored canCreateAgents=false when explicitly set", () => {
    const perms = normalizeAgentPermissions({ canCreateAgents: false }, "ceo");
    expect(perms.canCreateAgents).toBe(false);
  });

  it("falls back to role default when canCreateAgents is not in stored object", () => {
    const perms = normalizeAgentPermissions({}, "ceo");
    expect(perms.canCreateAgents).toBe(true);
  });

  it("falls back to role default for non-ceo when field is missing", () => {
    const perms = normalizeAgentPermissions({}, "engineer");
    expect(perms.canCreateAgents).toBe(false);
  });

  it("falls back to role default when stored permissions is null", () => {
    const perms = normalizeAgentPermissions(null, "ceo");
    expect(perms.canCreateAgents).toBe(true);
  });

  it("falls back to role default when stored permissions is undefined", () => {
    const perms = normalizeAgentPermissions(undefined, "ceo");
    expect(perms.canCreateAgents).toBe(true);
  });

  it("falls back to role default when stored permissions is an array", () => {
    const perms = normalizeAgentPermissions([], "ceo");
    expect(perms.canCreateAgents).toBe(true);
  });

  it("falls back to role default when stored permissions is a string", () => {
    const perms = normalizeAgentPermissions("yes", "ceo");
    expect(perms.canCreateAgents).toBe(true);
  });

  it("falls back to role default when canCreateAgents is a non-boolean value", () => {
    // stored value is string "true" — not a boolean, should use role default
    const perms = normalizeAgentPermissions({ canCreateAgents: "true" }, "engineer");
    expect(perms.canCreateAgents).toBe(false); // role default for engineer
  });

  it("treats canCreateAgents=0 (non-boolean) as missing and uses role default", () => {
    const perms = normalizeAgentPermissions({ canCreateAgents: 0 }, "ceo");
    expect(perms.canCreateAgents).toBe(true); // role default for ceo
  });
});
