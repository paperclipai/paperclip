import { describe, expect, it } from "vitest";
import { MEMBERSHIP_ROLES, PERMISSION_KEYS, ROLE_PERMISSIONS, ROLE_ACTIONS } from "@ironworksai/shared";

describe("Role Permissions — constants", () => {
  it("defines all four membership roles", () => {
    expect(MEMBERSHIP_ROLES).toEqual(["owner", "admin", "member", "viewer"]);
  });

  it("owner has all permission keys", () => {
    for (const key of PERMISSION_KEYS) {
      expect(ROLE_PERMISSIONS.owner).toContain(key);
    }
  });

  it("admin has all permission keys", () => {
    for (const key of PERMISSION_KEYS) {
      expect(ROLE_PERMISSIONS.admin).toContain(key);
    }
  });

  it("member has agents:create and tasks:assign only", () => {
    expect(ROLE_PERMISSIONS.member).toContain("agents:create");
    expect(ROLE_PERMISSIONS.member).toContain("tasks:assign");
    expect(ROLE_PERMISSIONS.member).not.toContain("users:invite");
    expect(ROLE_PERMISSIONS.member).not.toContain("users:manage_permissions");
    expect(ROLE_PERMISSIONS.member).not.toContain("joins:approve");
  });

  it("viewer has no permission keys", () => {
    expect(ROLE_PERMISSIONS.viewer).toHaveLength(0);
  });
});

describe("Role Actions — UI-level capabilities", () => {
  it("owner can manage_billing", () => {
    expect(ROLE_ACTIONS.owner).toContain("manage_billing");
  });

  it("admin cannot manage_billing", () => {
    expect(ROLE_ACTIONS.admin).not.toContain("manage_billing");
  });

  it("admin can invite_users", () => {
    expect(ROLE_ACTIONS.admin).toContain("invite_users");
  });

  it("member can create_issues and edit_kb", () => {
    expect(ROLE_ACTIONS.member).toContain("create_issues");
    expect(ROLE_ACTIONS.member).toContain("edit_kb");
  });

  it("member cannot invite_users", () => {
    expect(ROLE_ACTIONS.member).not.toContain("invite_users");
  });

  it("viewer can only comment and view_all", () => {
    expect(ROLE_ACTIONS.viewer).toContain("comment");
    expect(ROLE_ACTIONS.viewer).toContain("view_all");
    expect(ROLE_ACTIONS.viewer).not.toContain("create_issues");
    expect(ROLE_ACTIONS.viewer).not.toContain("edit_kb");
    expect(ROLE_ACTIONS.viewer).not.toContain("invite_users");
  });
});
