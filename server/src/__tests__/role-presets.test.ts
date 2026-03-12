import { describe, it, expect } from "vitest";
import {
  ROLE_PRESETS,
  ROLE_HIERARCHY,
  MEMBERSHIP_ROLES,
  MEMBERSHIP_STATUSES,
} from "@paperclipai/shared";

describe("Role Presets", () => {
  it("defines all 4 roles", () => {
    expect(MEMBERSHIP_ROLES).toEqual(["owner", "admin", "contributor", "viewer"]);
  });

  it("owner has all 6 permissions", () => {
    expect(ROLE_PRESETS.owner).toHaveLength(6);
    expect(ROLE_PRESETS.owner).toContain("users:invite");
    expect(ROLE_PRESETS.owner).toContain("users:manage_permissions");
    expect(ROLE_PRESETS.owner).toContain("agents:create");
    expect(ROLE_PRESETS.owner).toContain("tasks:assign");
    expect(ROLE_PRESETS.owner).toContain("tasks:assign_scope");
    expect(ROLE_PRESETS.owner).toContain("joins:approve");
  });

  it("admin has all 6 permissions", () => {
    expect(ROLE_PRESETS.admin).toHaveLength(6);
  });

  it("contributor has only tasks:assign and tasks:assign_scope", () => {
    expect(ROLE_PRESETS.contributor).toEqual(["tasks:assign", "tasks:assign_scope"]);
  });

  it("viewer has no permissions", () => {
    expect(ROLE_PRESETS.viewer).toEqual([]);
  });

  it("hierarchy ordinals are correct", () => {
    expect(ROLE_HIERARCHY.owner).toBe(0);
    expect(ROLE_HIERARCHY.admin).toBe(1);
    expect(ROLE_HIERARCHY.contributor).toBe(2);
    expect(ROLE_HIERARCHY.viewer).toBe(3);
  });

  it("owner outranks all others", () => {
    expect(ROLE_HIERARCHY.owner).toBeLessThan(ROLE_HIERARCHY.admin);
    expect(ROLE_HIERARCHY.owner).toBeLessThan(ROLE_HIERARCHY.contributor);
    expect(ROLE_HIERARCHY.owner).toBeLessThan(ROLE_HIERARCHY.viewer);
  });

  it("includes pending, active and suspended membership statuses", () => {
    expect(MEMBERSHIP_STATUSES).toContain("pending");
    expect(MEMBERSHIP_STATUSES).toContain("active");
    expect(MEMBERSHIP_STATUSES).toContain("suspended");
  });
});
