import { describe, expect, it } from "vitest";
import { createCompanySchema, updateCompanySchema } from "./company.js";

describe("company validators", () => {
  it("defaults developer value assumptions on create", () => {
    expect(createCompanySchema.parse({ name: "Paperclip" })).toEqual({
      name: "Paperclip",
      budgetMonthlyCents: 0,
      devValueHourlyRateCents: 15000,
      devValueTokensPerHour: 100000,
    });
  });

  it("validates developer value assumptions on update", () => {
    expect(updateCompanySchema.parse({
      devValueHourlyRateCents: 17500,
      devValueTokensPerHour: 125000,
    })).toEqual({
      devValueHourlyRateCents: 17500,
      devValueTokensPerHour: 125000,
    });

    expect(() => updateCompanySchema.parse({ devValueHourlyRateCents: -1 })).toThrow();
    expect(() => updateCompanySchema.parse({ devValueTokensPerHour: 0 })).toThrow();
  });
});
