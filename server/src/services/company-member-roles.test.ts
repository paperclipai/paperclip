import { describe, expect, it } from "vitest";
import { PERMISSION_KEYS } from "@paperclipai/shared";
import type { HumanCompanyMembershipRole } from "@paperclipai/shared";
import { grantsForHumanRole } from "./company-member-roles.js";

function keysFor(role: HumanCompanyMembershipRole): string[] {
  return grantsForHumanRole(role).map((grant) => grant.permissionKey);
}

describe("plugins:manage permission key", () => {
  it("is a registered permission key", () => {
    expect(PERMISSION_KEYS).toContain("plugins:manage");
  });

  it("is implicitly granted to owner and admin roles", () => {
    expect(keysFor("owner")).toContain("plugins:manage");
    expect(keysFor("admin")).toContain("plugins:manage");
  });

  it("is not implicitly granted to operator or viewer roles", () => {
    expect(keysFor("operator")).not.toContain("plugins:manage");
    expect(keysFor("viewer")).not.toContain("plugins:manage");
  });
});
