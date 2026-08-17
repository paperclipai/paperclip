import { describe, expect, it } from "vitest";
import { interactionResolverGovernanceSchema } from "./company.js";

describe("interactionResolverGovernanceSchema", () => {
  it("accepts an operational review owner agent id", () => {
    const ownerId = "c085a343-d57f-47fa-b114-0c6ed7f76c41";

    expect(interactionResolverGovernanceSchema.parse({
      operationalReviewOwnerAgentId: ownerId,
    })).toEqual({ operationalReviewOwnerAgentId: ownerId });
  });

  it("rejects non-uuid operational review owner values", () => {
    expect(() =>
      interactionResolverGovernanceSchema.parse({
        operationalReviewOwnerAgentId: "pm",
      })
    ).toThrow();
  });
});
