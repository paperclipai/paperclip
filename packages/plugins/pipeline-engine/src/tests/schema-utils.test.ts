import { describe, it, expect } from "vitest";
import { getDecisionEnumValues } from "../schema-utils.js";

describe("getDecisionEnumValues", () => {
  it("extracts enum values from decision field", () => {
    const schema = {
      type: "object",
      properties: {
        decision: { type: "string", enum: ["approved", "rejected", "needs_revision"] },
        summary: { type: "string" },
      },
    };
    expect(getDecisionEnumValues(schema)).toEqual(["approved", "rejected", "needs_revision"]);
  });

  it("returns empty array when no decision field", () => {
    const schema = { type: "object", properties: { result: { type: "string" } } };
    expect(getDecisionEnumValues(schema)).toEqual([]);
  });

  it("returns empty array when decision has no enum", () => {
    const schema = { type: "object", properties: { decision: { type: "string" } } };
    expect(getDecisionEnumValues(schema)).toEqual([]);
  });
});
