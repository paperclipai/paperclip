import { describe, expect, it } from "vitest";
import type { CurrentBoardAccess } from "@/api/access";
import { canInviteCompanyMembers } from "./useCompanyInviteAccess";

function snapshot(overrides: Partial<CurrentBoardAccess> = {}): CurrentBoardAccess {
  return {
    user: { id: "user-1", email: "jane@example.com", name: "Jane Example", image: null },
    userId: "user-1",
    isInstanceAdmin: false,
    companyIds: ["company-1"],
    memberships: [{ companyId: "company-1", membershipRole: "operator", status: "active" }],
    source: "session",
    keyId: null,
    ...overrides,
  };
}

describe("canInviteCompanyMembers", () => {
  it("is false until the board access snapshot is known", () => {
    expect(canInviteCompanyMembers("company-1", undefined)).toBe(false);
  });

  it("always passes local boards and instance admins", () => {
    expect(canInviteCompanyMembers("company-1", snapshot({ source: "local_implicit" }))).toBe(true);
    expect(canInviteCompanyMembers("company-1", snapshot({ isInstanceAdmin: true }))).toBe(true);
    // Both bypass the company lookup, so a missing company is fine.
    expect(canInviteCompanyMembers(null, snapshot({ isInstanceAdmin: true }))).toBe(true);
  });

  it.each(["owner", "admin", "operator", "member"] as const)("passes an active company %s", (membershipRole) => {
    const access = snapshot({
      memberships: [{ companyId: "company-1", membershipRole, status: "active" }],
    });
    expect(canInviteCompanyMembers("company-1", access)).toBe(true);
  });

  it.each(["viewer", null] as const)("rejects a company %s", (membershipRole) => {
    const access = snapshot({
      memberships: [{ companyId: "company-1", membershipRole, status: "active" }],
    });
    expect(canInviteCompanyMembers("company-1", access)).toBe(false);
  });

  it("ignores inactive memberships and other companies", () => {
    const suspended = snapshot({
      memberships: [{ companyId: "company-1", membershipRole: "owner", status: "suspended" }],
    });
    expect(canInviteCompanyMembers("company-1", suspended)).toBe(false);
    const elsewhere = snapshot({
      memberships: [{ companyId: "company-2", membershipRole: "owner", status: "active" }],
    });
    expect(canInviteCompanyMembers("company-1", elsewhere)).toBe(false);
    expect(canInviteCompanyMembers(null, elsewhere)).toBe(false);
  });

  it("is false when the snapshot carries no memberships", () => {
    expect(canInviteCompanyMembers("company-1", snapshot({ memberships: undefined }))).toBe(false);
  });
});
