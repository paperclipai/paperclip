import { describe, expect, it } from "vitest";
import { resolveCompanyImportApiPath } from "../commands/client/company.js";

describe("resolveCompanyImportApiPath", () => {
  it("uses company-scoped preview route for existing-company dry runs", () => {
    expect(
      resolveCompanyImportApiPath({
        dryRun: true,
        targetMode: "existing_company",
        companyId: "company-123",
      }),
    ).toBe("/api/companies/company-123/imports/preview");
  });

  it("uses company-scoped apply route for existing-company imports", () => {
    expect(
      resolveCompanyImportApiPath({
        dryRun: false,
        targetMode: "existing_company",
        companyId: "company-123",
      }),
    ).toBe("/api/companies/company-123/imports/apply");
  });

  it("keeps global routes for new-company imports", () => {
    expect(
      resolveCompanyImportApiPath({
        dryRun: true,
        targetMode: "new_company",
      }),
    ).toBe("/api/companies/import/preview");

    expect(
      resolveCompanyImportApiPath({
        dryRun: false,
        targetMode: "new_company",
      }),
    ).toBe("/api/companies/import");
  });

  it("throws when an existing-company import is missing a company id", () => {
    expect(() =>
      resolveCompanyImportApiPath({
        dryRun: true,
        targetMode: "existing_company",
        companyId: " ",
      })
    ).toThrow(/require a companyId/i);
  });
});
