import { describe, expect, it } from "vitest";
import {
  getRememberedPathOwnerCompanyId,
  isRememberableCompanyPath,
  sanitizeRememberedPathForCompany,
} from "../lib/company-page-memory";

const companies = [
  { id: "for", issuePrefix: "FOR" },
  { id: "pap", issuePrefix: "PAP" },
];

describe("getRememberedPathOwnerCompanyId", () => {
  it("uses the route company instead of stale selected-company state for prefixed routes", () => {
    expect(
      getRememberedPathOwnerCompanyId({
        companies,
        pathname: "/FOR/issues/FOR-1",
        fallbackCompanyId: "pap",
      }),
    ).toBe("for");
  });

  it("skips saving when a prefixed route cannot yet be resolved to a known company", () => {
    expect(
      getRememberedPathOwnerCompanyId({
        companies: [],
        pathname: "/FOR/issues/FOR-1",
        fallbackCompanyId: "pap",
      }),
    ).toBeNull();
  });

  it("falls back to the previous company for unprefixed board routes", () => {
    expect(
      getRememberedPathOwnerCompanyId({
        companies,
        pathname: "/dashboard",
        fallbackCompanyId: "pap",
      }),
    ).toBe("pap");
  });

  it("treats unprefixed skills routes as board routes instead of company prefixes", () => {
    expect(
      getRememberedPathOwnerCompanyId({
        companies,
        pathname: "/skills/skill-123/files/SKILL.md",
        fallbackCompanyId: "pap",
      }),
    ).toBe("pap");
  });
});

describe("sanitizeRememberedPathForCompany", () => {
  it("does not remember an agent UUID before its company-scoped alias is resolved", () => {
    expect(isRememberableCompanyPath("/agents/209d54ec-4f22-4897-b65d-517a49593023/overview")).toBe(false);
    expect(isRememberableCompanyPath("/agents/maya/overview")).toBe(true);
  });

  it("falls back to dashboard for a legacy remembered agent UUID with unknown ownership", () => {
    expect(sanitizeRememberedPathForCompany({
      path: "/PAP/agents/209d54ec-4f22-4897-b65d-517a49593023/runs/run-1",
      companyPrefix: "PAP",
    })).toBe("/dashboard");
  });

  it("keeps canonical agent run paths and their query when switching companies", () => {
    expect(sanitizeRememberedPathForCompany({
      path: "/agents/maya/runs/run-1?mode=raw",
      companyPrefix: "PAP",
    })).toBe("/agents/maya/runs/run-1?mode=raw");
  });

  it("keeps remembered issue paths that belong to the target company", () => {
    expect(
      sanitizeRememberedPathForCompany({
        path: "/issues/PAP-12",
        companyPrefix: "PAP",
      }),
    ).toBe("/issues/PAP-12");
  });

  it("falls back to dashboard for remembered issue identifiers from another company", () => {
    expect(
      sanitizeRememberedPathForCompany({
        path: "/issues/FOR-1",
        companyPrefix: "PAP",
      }),
    ).toBe("/dashboard");
  });

  it("falls back to dashboard when no remembered path exists", () => {
    expect(
      sanitizeRememberedPathForCompany({
        path: null,
        companyPrefix: "PAP",
      }),
    ).toBe("/dashboard");
  });

  it("keeps remembered skills paths intact for the target company", () => {
    expect(
      sanitizeRememberedPathForCompany({
        path: "/skills/skill-123/files/SKILL.md",
        companyPrefix: "PAP",
      }),
    ).toBe("/skills/skill-123/files/SKILL.md");
  });
});
