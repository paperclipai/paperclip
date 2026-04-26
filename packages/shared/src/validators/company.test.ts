import { describe, expect, it } from "vitest";
import {
  createCompanySchema,
  updateCompanyBrandingSchema,
  updateCompanySchema,
} from "./company.js";

describe("createCompanySchema", () => {
  it("accepts a minimal company with just a name", () => {
    expect(createCompanySchema.safeParse({ name: "Acme" }).success).toBe(true);
  });

  it("rejects an empty name", () => {
    expect(createCompanySchema.safeParse({ name: "" }).success).toBe(false);
  });

  it("defaults budgetMonthlyCents to 0", () => {
    const result = createCompanySchema.safeParse({ name: "Acme" });
    expect(result.success && result.data.budgetMonthlyCents).toBe(0);
  });

  it("accepts optional description", () => {
    const result = createCompanySchema.safeParse({ name: "Acme", description: "A company" });
    expect(result.success).toBe(true);
  });

  it("rejects a negative budget", () => {
    expect(
      createCompanySchema.safeParse({ name: "Acme", budgetMonthlyCents: -1 }).success,
    ).toBe(false);
  });

  it("rejects a non-integer budget", () => {
    expect(
      createCompanySchema.safeParse({ name: "Acme", budgetMonthlyCents: 9.99 }).success,
    ).toBe(false);
  });
});

describe("updateCompanySchema", () => {
  it("accepts an empty object (all fields optional)", () => {
    expect(updateCompanySchema.safeParse({}).success).toBe(true);
  });

  it("accepts a valid brand color", () => {
    expect(updateCompanySchema.safeParse({ brandColor: "#ff0000" }).success).toBe(true);
    expect(updateCompanySchema.safeParse({ brandColor: "#AABBCC" }).success).toBe(true);
  });

  it("rejects an invalid brand color format", () => {
    expect(updateCompanySchema.safeParse({ brandColor: "red" }).success).toBe(false);
    expect(updateCompanySchema.safeParse({ brandColor: "#gg0000" }).success).toBe(false);
    expect(updateCompanySchema.safeParse({ brandColor: "#ff00" }).success).toBe(false);
  });

  it("accepts null brand color", () => {
    expect(updateCompanySchema.safeParse({ brandColor: null }).success).toBe(true);
  });
});

describe("updateCompanyBrandingSchema", () => {
  it("accepts a name update", () => {
    expect(updateCompanyBrandingSchema.safeParse({ name: "New Name" }).success).toBe(true);
  });

  it("accepts a description update", () => {
    expect(updateCompanyBrandingSchema.safeParse({ description: "Updated desc" }).success).toBe(true);
  });

  it("accepts a brand color update", () => {
    expect(updateCompanyBrandingSchema.safeParse({ brandColor: "#123456" }).success).toBe(true);
  });

  it("rejects an empty object — at least one field required", () => {
    expect(updateCompanyBrandingSchema.safeParse({}).success).toBe(false);
  });

  it("rejects an invalid brand color", () => {
    expect(updateCompanyBrandingSchema.safeParse({ brandColor: "notacolor" }).success).toBe(false);
  });

  it("rejects unknown fields (strict schema)", () => {
    expect(
      updateCompanyBrandingSchema.safeParse({ name: "Acme", unknownField: true }).success,
    ).toBe(false);
  });
});
