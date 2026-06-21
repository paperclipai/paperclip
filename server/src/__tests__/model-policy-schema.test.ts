import { describe, expect, it } from "vitest";
import { modelPolicyRulesSchema } from "../services/model-policy-schema.ts";

describe("modelPolicyRulesSchema", () => {
  it("accepts a valid rules array", () => {
    const rules = [
      { when: { workMode: ["bulk"] }, modelProfile: "bulk", reason: "x" },
      { when: {}, modelProfile: "cheap" },
    ];
    expect(modelPolicyRulesSchema.parse(rules)).toEqual(rules);
  });
  it("rejects an unknown modelProfile key", () => {
    expect(() => modelPolicyRulesSchema.parse([{ when: {}, modelProfile: "nope" }])).toThrow();
  });
  it("rejects a non-array", () => {
    expect(() => modelPolicyRulesSchema.parse({})).toThrow();
  });
  it("accepts an empty array", () => {
    expect(modelPolicyRulesSchema.parse([])).toEqual([]);
  });
});
