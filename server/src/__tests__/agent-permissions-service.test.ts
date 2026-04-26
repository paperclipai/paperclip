import { describe, it, expect } from "vitest";
import {
  defaultPermissionsForRole,
  normalizeAgentPermissions,
} from "../services/agent-permissions.js";

// ---------------------------------------------------------------------------
// defaultPermissionsForRole
// ---------------------------------------------------------------------------

describe("defaultPermissionsForRole", () => {
  it("grants canCreateAgents=true for 'ceo' role", () => {
    expect(defaultPermissionsForRole("ceo").canCreateAgents).toBe(true);
  });

  it("denies canCreateAgents for 'engineer' role", () => {
    expect(defaultPermissionsForRole("engineer").canCreateAgents).toBe(false);
  });

  it("denies canCreateAgents for 'cto' role", () => {
    expect(defaultPermissionsForRole("cto").canCreateAgents).toBe(false);
  });

  it("denies canCreateAgents for 'CEO' (case-sensitive check)", () => {
    expect(defaultPermissionsForRole("CEO").canCreateAgents).toBe(false);
  });

  it("denies canCreateAgents for empty string", () => {
    expect(defaultPermissionsForRole("").canCreateAgents).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// normalizeAgentPermissions
// ---------------------------------------------------------------------------

describe("normalizeAgentPermissions", () => {
  it("returns defaults when permissions is null", () => {
    const result = normalizeAgentPermissions(null, "ceo");
    expect(result.canCreateAgents).toBe(true);
  });

  it("returns defaults when permissions is undefined", () => {
    const result = normalizeAgentPermissions(undefined, "engineer");
    expect(result.canCreateAgents).toBe(false);
  });

  it("returns defaults when permissions is a string", () => {
    const result = normalizeAgentPermissions("yes", "ceo");
    expect(result.canCreateAgents).toBe(true);
  });

  it("returns defaults when permissions is an array", () => {
    const result = normalizeAgentPermissions([], "ceo");
    expect(result.canCreateAgents).toBe(true);
  });

  it("reads canCreateAgents=true from a plain object", () => {
    const result = normalizeAgentPermissions({ canCreateAgents: true }, "engineer");
    expect(result.canCreateAgents).toBe(true);
  });

  it("reads canCreateAgents=false from a plain object", () => {
    const result = normalizeAgentPermissions({ canCreateAgents: false }, "ceo");
    expect(result.canCreateAgents).toBe(false);
  });

  it("falls back to role default when canCreateAgents is not a boolean", () => {
    // "yes" string → not a boolean → falls back to defaults.canCreateAgents
    const result = normalizeAgentPermissions({ canCreateAgents: "yes" }, "ceo");
    expect(result.canCreateAgents).toBe(true); // ceo default = true
  });

  it("falls back to role default when canCreateAgents key is absent", () => {
    const result = normalizeAgentPermissions({ otherField: 42 }, "engineer");
    expect(result.canCreateAgents).toBe(false); // engineer default = false
  });

  it("ignores extra keys in permissions object (only normalises known fields)", () => {
    const result = normalizeAgentPermissions({ canCreateAgents: true, unknown: "ignored" }, "engineer");
    expect(result.canCreateAgents).toBe(true);
  });
});
