import { describe, expect, it } from "vitest";
import { COMPANY_NAME_FIELD_LABEL } from "./OnboardingWizard";

describe("OnboardingWizard", () => {
  it("uses the concise company name field label", () => {
    expect(COMPANY_NAME_FIELD_LABEL).toBe("Name");
  });
});
