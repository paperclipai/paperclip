import { describe, expect, it } from "vitest";
import {
  canCreateStackCompany,
  cloudTenantCompanyId,
  isCompanyIdConflict,
} from "./cloud-tenant-company.js";

describe("cloudTenantCompanyId", () => {
  it("is deterministic and UUID-shaped", () => {
    const a = cloudTenantCompanyId("stack-abc");
    const b = cloudTenantCompanyId("stack-abc");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("differs per stack", () => {
    expect(cloudTenantCompanyId("stack-a")).not.toBe(cloudTenantCompanyId("stack-b"));
  });
});

describe("canCreateStackCompany", () => {
  it("allows owner and admin", () => {
    expect(canCreateStackCompany({ stackId: "s", stackRole: "owner" })).toBe(true);
    expect(canCreateStackCompany({ stackId: "s", stackRole: "admin" })).toBe(true);
  });

  it("denies member, support, and absent context", () => {
    expect(canCreateStackCompany({ stackId: "s", stackRole: "member" })).toBe(false);
    expect(canCreateStackCompany({ stackId: "s", stackRole: "support" })).toBe(false);
    expect(canCreateStackCompany(undefined)).toBe(false);
    expect(canCreateStackCompany(null)).toBe(false);
  });
});

describe("isCompanyIdConflict", () => {
  it("detects a companies_pkey unique violation, including nested causes", () => {
    expect(isCompanyIdConflict({ code: "23505", constraint: "companies_pkey" })).toBe(true);
    expect(
      isCompanyIdConflict({ cause: { code: "23505", constraint_name: "companies_pkey" } }),
    ).toBe(true);
  });

  it("ignores other errors", () => {
    expect(isCompanyIdConflict({ code: "23505", constraint: "companies_issue_prefix_idx" })).toBe(false);
    expect(isCompanyIdConflict(new Error("boom"))).toBe(false);
    expect(isCompanyIdConflict(null)).toBe(false);
  });
});
