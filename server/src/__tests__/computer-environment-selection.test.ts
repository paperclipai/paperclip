import { describe, expect, it } from "vitest";
import { assertEnvironmentSelectionForCompany } from "../services/environment-selection.js";

describe("computer environment selection", () => {
  const environment = { id: "environment", driver: "computer", status: "active", config: {}, metadata: { computerCompanyId: "owner" } };
  const service = { getById: async () => environment };
  it("permits the attached company and rejects another company", async () => {
    await expect(assertEnvironmentSelectionForCompany(service, "owner", "environment")).resolves.toBeUndefined();
    await expect(assertEnvironmentSelectionForCompany(service, "other", "environment")).rejects.toThrow("not available in this company");
  });
});
