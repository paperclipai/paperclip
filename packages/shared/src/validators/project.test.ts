import { describe, expect, it } from "vitest";
import { updateProjectSchema } from "./project.js";

describe("project update budget boundary", () => {
  it.each([0, 5000, null, "5000", {}])("rejects unsupported budgetMonthlyCents instead of stripping it (%j)", (budgetMonthlyCents) => {
    const parsed = updateProjectSchema.safeParse({ name: "Renamed", budgetMonthlyCents });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: ["budgetMonthlyCents"],
          message: expect.stringContaining("/budgets/policies"),
        }),
      ]));
    }
  });

  it("keeps ordinary patches partial", () => {
    expect(updateProjectSchema.parse({ name: "Renamed" })).toEqual({ name: "Renamed" });
  });
});
