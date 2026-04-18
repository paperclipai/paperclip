import { describe, expect, it } from "vitest";
import type { Company } from "@paperclipai/shared";
import { assertDeleteConfirmation, resolveCompanyForDeletion } from "../commands/client/company.js";

function makeCompany(overrides: Partial<Company>): Company {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    name: "Alpha",
    description: null,
    status: "active",
    pauseReason: null,
    pausedAt: null,
    issuePrefix: "ALP",
    issueCounter: 1,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    requireBoardApprovalForNewAgents: false,
    requireProofDocumentOnClose: false,
    feedbackDataSharingEnabled: false,
    feedbackDataSharingConsentAt: null,
    feedbackDataSharingConsentByUserId: null,
    feedbackDataSharingTermsVersion: null,
    brandColor: null,
    logoAssetId: null,
    logoUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("resolveCompanyForDeletion", () => {
  const companies: Company[] = [
    makeCompany({
      id: "11111111-1111-1111-1111-111111111111",
      name: "Alpha",
      issuePrefix: "ALP",
    }),
    makeCompany({
      id: "22222222-2222-2222-2222-222222222222",
      name: "Paperclip",
      issuePrefix: "PAP",
    }),
  ];

  it("resolves by ID in auto mode", () => {
    const result = resolveCompanyForDeletion(companies, "22222222-2222-2222-2222-222222222222", "auto");
    expect(result.issuePrefix).toBe("PAP");
  });

  it("resolves by prefix in auto mode", () => {
    const result = resolveCompanyForDeletion(companies, "pap", "auto");
    expect(result.id).toBe("22222222-2222-2222-2222-222222222222");
  });

  it("throws when selector is not found", () => {
    expect(() => resolveCompanyForDeletion(companies, "MISSING", "auto")).toThrow(/No company found/);
  });

  it("respects explicit id mode", () => {
    expect(() => resolveCompanyForDeletion(companies, "PAP", "id")).toThrow(/No company found by ID/);
  });

  it("respects explicit prefix mode", () => {
    expect(() => resolveCompanyForDeletion(companies, "22222222-2222-2222-2222-222222222222", "prefix"))
      .toThrow(/No company found by shortname/);
  });
});

describe("assertDeleteConfirmation", () => {
  const company = makeCompany({
    id: "22222222-2222-2222-2222-222222222222",
    issuePrefix: "PAP",
  });

  it("requires --yes", () => {
    expect(() => assertDeleteConfirmation(company, { confirm: "PAP" })).toThrow(/requires --yes/);
  });

  it("accepts matching prefix confirmation", () => {
    expect(() => assertDeleteConfirmation(company, { yes: true, confirm: "pap" })).not.toThrow();
  });

  it("accepts matching id confirmation", () => {
    expect(() =>
      assertDeleteConfirmation(company, {
        yes: true,
        confirm: "22222222-2222-2222-2222-222222222222",
      })).not.toThrow();
  });

  it("rejects mismatched confirmation", () => {
    expect(() => assertDeleteConfirmation(company, { yes: true, confirm: "nope" }))
      .toThrow(/does not match target company/);
  });
});
