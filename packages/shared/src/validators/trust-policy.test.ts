import { describe, expect, it } from "vitest";
import { trustAuthorizationPolicySchema } from "./trust-policy.js";

describe("trustAuthorizationPolicySchema", () => {
  it("accepts an empty legacy protected-agent approval reason", () => {
    const result = trustAuthorizationPolicySchema.parse({
      protectedAgent: {
        requiresApproval: true,
        approvalReason: "",
      },
    });

    expect(result.protectedAgent).toMatchObject({
      requiresApproval: true,
      approvalReason: "",
    });
  });

  it("still requires a non-empty canonical assignment block reason", () => {
    const result = trustAuthorizationPolicySchema.safeParse({
      protectedAgent: {
        blockAssignment: true,
        blockReason: "",
      },
    });

    expect(result.success).toBe(false);
  });
});
