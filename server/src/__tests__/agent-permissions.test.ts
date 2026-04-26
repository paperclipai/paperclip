import { describe, expect, it } from "vitest";
import {
  defaultPermissionsForRole,
  normalizeAgentPermissions,
} from "../services/agent-permissions.js";

describe("defaultPermissionsForRole", () => {
  it("grants canCreateAgents for ceo role", () => {
    expect(defaultPermissionsForRole("ceo")).toEqual({ canCreateAgents: true });
  });

  it("denies canCreateAgents for non-ceo roles", () => {
    expect(defaultPermissionsForRole("cto")).toEqual({ canCreateAgents: false });
    expect(defaultPermissionsForRole("engineer")).toEqual({ canCreateAgents: false });
    expect(defaultPermissionsForRole("")).toEqual({ canCreateAgents: false });
    expect(defaultPermissionsForRole("CEO")).toEqual({ canCreateAgents: false }); // case-sensitive
  });
});

describe("normalizeAgentPermissions", () => {
  it("returns defaults when permissions is undefined", () => {
    expect(normalizeAgentPermissions(undefined, "ceo")).toEqual({ canCreateAgents: true });
    expect(normalizeAgentPermissions(undefined, "cto")).toEqual({ canCreateAgents: false });
  });

  it("returns defaults when permissions is null", () => {
    expect(normalizeAgentPermissions(null, "ceo")).toEqual({ canCreateAgents: true });
  });

  it("returns defaults when permissions is an array", () => {
    expect(normalizeAgentPermissions([], "ceo")).toEqual({ canCreateAgents: true });
    expect(normalizeAgentPermissions([1, 2, 3], "cto")).toEqual({ canCreateAgents: false });
  });

  it("returns defaults when permissions is a primitive", () => {
    expect(normalizeAgentPermissions(42, "ceo")).toEqual({ canCreateAgents: true });
    expect(normalizeAgentPermissions("string", "ceo")).toEqual({ canCreateAgents: true });
    expect(normalizeAgentPermissions(true, "ceo")).toEqual({ canCreateAgents: true });
  });

  it("returns defaults when permissions is an empty object", () => {
    expect(normalizeAgentPermissions({}, "ceo")).toEqual({ canCreateAgents: true });
    expect(normalizeAgentPermissions({}, "cto")).toEqual({ canCreateAgents: false });
  });

  it("uses explicit boolean canCreateAgents when provided", () => {
    expect(normalizeAgentPermissions({ canCreateAgents: false }, "ceo")).toEqual({
      canCreateAgents: false,
    });
    expect(normalizeAgentPermissions({ canCreateAgents: true }, "cto")).toEqual({
      canCreateAgents: true,
    });
  });

  it("falls back to role defaults when canCreateAgents is not a boolean", () => {
    expect(normalizeAgentPermissions({ canCreateAgents: "yes" }, "ceo")).toEqual({
      canCreateAgents: true,
    });
    expect(normalizeAgentPermissions({ canCreateAgents: 1 }, "cto")).toEqual({
      canCreateAgents: false,
    });
    expect(normalizeAgentPermissions({ canCreateAgents: null }, "ceo")).toEqual({
      canCreateAgents: true,
    });
  });

  it("ignores unknown keys in permissions object", () => {
    const result = normalizeAgentPermissions(
      { canCreateAgents: true, unknownField: "ignored" },
      "cto",
    );
    expect(result.canCreateAgents).toBe(true);
  });
});
