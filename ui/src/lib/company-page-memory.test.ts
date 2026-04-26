// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  isRememberableCompanyPath,
  getRememberedPathOwnerCompanyId,
  sanitizeRememberedPathForCompany,
} from "./company-page-memory";

// ============================================================================
// isRememberableCompanyPath
// ============================================================================

describe("isRememberableCompanyPath", () => {
  it("returns true for the root path", () => {
    expect(isRememberableCompanyPath("/")).toBe(true);
  });

  it("returns true for an empty path", () => {
    expect(isRememberableCompanyPath("")).toBe(true);
  });

  it("returns false for /auth paths", () => {
    expect(isRememberableCompanyPath("/auth/login")).toBe(false);
  });

  it("returns false for /invite paths", () => {
    expect(isRememberableCompanyPath("/invite/some-token")).toBe(false);
  });

  it("returns false for /board-claim", () => {
    expect(isRememberableCompanyPath("/board-claim")).toBe(false);
  });

  it("returns false for /cli-auth", () => {
    expect(isRememberableCompanyPath("/cli-auth/callback")).toBe(false);
  });

  it("returns false for /docs", () => {
    expect(isRememberableCompanyPath("/docs/api")).toBe(false);
  });

  it("returns true for company-prefixed paths", () => {
    expect(isRememberableCompanyPath("/PAP/issues")).toBe(true);
  });

  it("returns true for /dashboard", () => {
    expect(isRememberableCompanyPath("/dashboard")).toBe(true);
  });

  it("strips query string before checking segments", () => {
    expect(isRememberableCompanyPath("/auth/login?redirect=/foo")).toBe(false);
  });

  it("returns true for unknown/arbitrary paths", () => {
    expect(isRememberableCompanyPath("/some-company/agents")).toBe(true);
  });
});

// ============================================================================
// getRememberedPathOwnerCompanyId
// ============================================================================

type Company = { id: string; issuePrefix: string };

const companies: Company[] = [
  { id: "company-pap", issuePrefix: "PAP" },
  { id: "company-zed", issuePrefix: "ZED" },
];

describe("getRememberedPathOwnerCompanyId", () => {
  it("returns the company id that matches the path prefix", () => {
    const result = getRememberedPathOwnerCompanyId({
      companies,
      pathname: "/PAP/issues",
      fallbackCompanyId: null,
    });
    expect(result).toBe("company-pap");
  });

  it("is case-insensitive in prefix matching", () => {
    const result = getRememberedPathOwnerCompanyId({
      companies,
      pathname: "/pap/dashboard",
      fallbackCompanyId: null,
    });
    expect(result).toBe("company-pap");
  });

  it("returns null when prefix matches no known company", () => {
    const result = getRememberedPathOwnerCompanyId({
      companies,
      pathname: "/UNKNOWN/issues",
      fallbackCompanyId: null,
    });
    expect(result).toBeNull();
  });

  it("returns fallbackCompanyId when pathname has no extractable prefix", () => {
    // /dashboard is in BOARD_ROUTE_ROOTS, so no prefix is extracted
    const result = getRememberedPathOwnerCompanyId({
      companies,
      pathname: "/dashboard",
      fallbackCompanyId: "company-pap",
    });
    expect(result).toBe("company-pap");
  });

  it("returns null fallback when pathname has no prefix and fallback is null", () => {
    const result = getRememberedPathOwnerCompanyId({
      companies,
      pathname: "/dashboard",
      fallbackCompanyId: null,
    });
    expect(result).toBeNull();
  });

  it("returns the correct company among multiple", () => {
    const result = getRememberedPathOwnerCompanyId({
      companies,
      pathname: "/ZED/agents",
      fallbackCompanyId: null,
    });
    expect(result).toBe("company-zed");
  });
});

// ============================================================================
// sanitizeRememberedPathForCompany
// ============================================================================

describe("sanitizeRememberedPathForCompany", () => {
  it("returns /dashboard when path is null", () => {
    const result = sanitizeRememberedPathForCompany({ path: null, companyPrefix: "PAP" });
    expect(result).toBe("/dashboard");
  });

  it("returns /dashboard when path is undefined", () => {
    const result = sanitizeRememberedPathForCompany({ path: undefined, companyPrefix: "PAP" });
    expect(result).toBe("/dashboard");
  });

  it("returns /dashboard for global (non-rememberable) paths", () => {
    // /auth is a global segment, so not rememberable
    const result = sanitizeRememberedPathForCompany({ path: "/auth/login", companyPrefix: "PAP" });
    expect(result).toBe("/dashboard");
  });

  it("returns relative path for a standard company-prefixed path", () => {
    // /PAP/issues → relative path /issues
    const result = sanitizeRememberedPathForCompany({ path: "/PAP/issues", companyPrefix: "PAP" });
    expect(result).toBe("/issues");
  });

  it("returns /dashboard when issue identifier belongs to a different company", () => {
    // /PAP/issues/ZED-1 contains ZED- identifier which doesn't match PAP prefix
    const result = sanitizeRememberedPathForCompany({ path: "/PAP/issues/ZED-1", companyPrefix: "PAP" });
    expect(result).toBe("/dashboard");
  });

  it("returns relative path when issue identifier matches the company prefix", () => {
    // /PAP/issues/PAP-1 matches PAP prefix
    const result = sanitizeRememberedPathForCompany({ path: "/PAP/issues/PAP-1", companyPrefix: "PAP" });
    expect(result).toBe("/issues/PAP-1");
  });

  it("allows dashboard paths through", () => {
    // Already at dashboard
    const result = sanitizeRememberedPathForCompany({ path: "/dashboard", companyPrefix: "PAP" });
    expect(result).toBe("/dashboard");
  });
});
