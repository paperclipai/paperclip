import { describe, expect, it } from "vitest";
import { skillPolicyDocumentSchema, skillPolicyEvaluationResourceSchema } from "./skill-policy.js";

const credentialBearingLocators = [
  "https://vault.example/?token=hvs.x",
  "https://vault.example/?api_key=secret",
  "https://vault.example/#token=hvs.x",
  "https://vault.example/#section?authorization=Bearer",
];

describe("skill policy source locators", () => {
  it.each(credentialBearingLocators)("rejects credential-bearing locator %s in policy rules", (sourceLocator) => {
    expect(() => skillPolicyDocumentSchema.parse({
      schemaVersion: 1,
      defaultEffect: "allow",
      rules: [{
        id: "deny-secret-source",
        priority: 1,
        effect: "deny",
        subject: { type: "all_agents" },
        actions: ["skills.import"],
        resources: { sourceLocators: [sourceLocator] },
      }],
    })).toThrow(/credentials or secret query or fragment parameters/i);
  });

  it.each(credentialBearingLocators)("rejects credential-bearing locator %s in evaluations", (sourceLocator) => {
    expect(() => skillPolicyEvaluationResourceSchema.parse({ sourceLocator }))
      .toThrow(/credentials or secret query or fragment parameters/i);
  });

  it("allows non-secret URL fragments", () => {
    expect(skillPolicyEvaluationResourceSchema.parse({
      sourceLocator: "https://docs.example/skill#installation",
    })).toEqual({ sourceLocator: "https://docs.example/skill#installation" });
  });
});
