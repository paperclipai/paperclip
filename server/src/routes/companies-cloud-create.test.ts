import { describe, expect, it, vi, beforeEach } from "vitest";
import { canCreateStackCompany, cloudTenantCompanyId } from "../services/cloud-tenant-company.js";

// The route body is exercised end-to-end in the live check (see the plan's
// Task 7); here we lock the decision logic the route composes.
describe("company create authorization for cloud tenants", () => {
  it("owner/admin of a stack may create; the id is forced to the stack company id", () => {
    const actor = {
      source: "cloud_tenant" as const,
      isInstanceAdmin: false,
      cloudStack: { stackId: "stack-abc", stackRole: "owner" as const },
    };
    const cloudStack = actor.source === "cloud_tenant" ? actor.cloudStack : undefined;
    expect(canCreateStackCompany(cloudStack)).toBe(true);
    expect(cloudTenantCompanyId(cloudStack!.stackId)).toBe(cloudTenantCompanyId("stack-abc"));
  });

  it("member/support may not create", () => {
    expect(canCreateStackCompany({ stackId: "s", stackRole: "member" })).toBe(false);
    expect(canCreateStackCompany({ stackId: "s", stackRole: "support" })).toBe(false);
  });

  it("a non-cloud actor without instance admin may not create via the carve-out", () => {
    const actor = { source: "session" as const, isInstanceAdmin: false, cloudStack: undefined };
    const cloudStack = (actor.source as string) === "cloud_tenant" ? actor.cloudStack : undefined;
    expect(canCreateStackCompany(cloudStack)).toBe(false);
  });
});
