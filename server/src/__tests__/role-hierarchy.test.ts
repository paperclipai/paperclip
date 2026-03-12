import { describe, it, expect } from "vitest";
import { ROLE_HIERARCHY } from "@paperclipai/shared";
import type { MembershipRole } from "@paperclipai/shared";

/**
 * canModifyMember is returned from accessService(db), but it's a pure function
 * that only uses ROLE_HIERARCHY. We replicate the logic here to test it in
 * isolation without needing a database instance.
 */
function canModifyMember(actorRole: string | null, targetRole: string | null): boolean {
  if (!actorRole || !targetRole) return false;
  const actorOrdinal = ROLE_HIERARCHY[actorRole as MembershipRole];
  const targetOrdinal = ROLE_HIERARCHY[targetRole as MembershipRole];
  if (actorOrdinal === undefined || targetOrdinal === undefined) return false;
  return actorOrdinal < targetOrdinal;
}

describe("canModifyMember (role hierarchy guard)", () => {
  it("owner can modify admin", () => {
    expect(canModifyMember("owner", "admin")).toBe(true);
  });

  it("owner can modify contributor", () => {
    expect(canModifyMember("owner", "contributor")).toBe(true);
  });

  it("owner can modify viewer", () => {
    expect(canModifyMember("owner", "viewer")).toBe(true);
  });

  it("admin can modify contributor", () => {
    expect(canModifyMember("admin", "contributor")).toBe(true);
  });

  it("admin can modify viewer", () => {
    expect(canModifyMember("admin", "viewer")).toBe(true);
  });

  it("admin cannot modify owner", () => {
    expect(canModifyMember("admin", "owner")).toBe(false);
  });

  it("admin cannot modify another admin (same rank)", () => {
    expect(canModifyMember("admin", "admin")).toBe(false);
  });

  it("contributor cannot modify admin", () => {
    expect(canModifyMember("contributor", "admin")).toBe(false);
  });

  it("contributor cannot modify another contributor (same rank)", () => {
    expect(canModifyMember("contributor", "contributor")).toBe(false);
  });

  it("viewer cannot modify anyone", () => {
    expect(canModifyMember("viewer", "owner")).toBe(false);
    expect(canModifyMember("viewer", "admin")).toBe(false);
    expect(canModifyMember("viewer", "contributor")).toBe(false);
    expect(canModifyMember("viewer", "viewer")).toBe(false);
  });

  it("owner cannot modify another owner (same rank)", () => {
    expect(canModifyMember("owner", "owner")).toBe(false);
  });

  it("returns false for null actor role", () => {
    expect(canModifyMember(null, "admin")).toBe(false);
  });

  it("returns false for null target role", () => {
    expect(canModifyMember("owner", null)).toBe(false);
  });

  it("returns false for unknown roles", () => {
    expect(canModifyMember("superadmin", "admin")).toBe(false);
    expect(canModifyMember("owner", "superadmin")).toBe(false);
  });
});
