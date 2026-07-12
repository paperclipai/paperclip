import { describe, expect, it } from "vitest";
import { updateResourceMembershipSchema } from "./validators/resource-memberships.js";

describe("resource membership contract", () => {
  it("accepts legacy state-only membership updates", () => {
    expect(updateResourceMembershipSchema.parse({ state: "left" })).toEqual({ state: "left" });
    expect(updateResourceMembershipSchema.parse({ state: "joined" })).toEqual({ state: "joined" });
  });

  it("accepts star-only updates without requiring a state mutation", () => {
    expect(updateResourceMembershipSchema.parse({ starred: true })).toEqual({ starred: true });
    expect(updateResourceMembershipSchema.parse({ starred: false })).toEqual({ starred: false });
  });

  it("rejects empty or contradictory star/state updates", () => {
    expect(() => updateResourceMembershipSchema.parse({})).toThrow("state or starred is required");
    expect(() => updateResourceMembershipSchema.parse({ state: "left", starred: true })).toThrow(
      "starred resources must be joined",
    );
  });
});
