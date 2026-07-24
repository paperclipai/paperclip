import { describe, expect, it } from "vitest";
import {
  COMPANY_STANDING_STATUSES,
  PLUGIN_CAPABILITIES,
  type EffectiveStanding,
} from "./index.js";

describe("company standing shared constants", () => {
  it("declares the three standing statuses in severity order", () => {
    expect(COMPANY_STANDING_STATUSES).toEqual(["active", "grace", "blocked"]);
  });

  it("declares the company.standing.write plugin capability", () => {
    expect(PLUGIN_CAPABILITIES).toContain("company.standing.write");
  });

  it("EffectiveStanding permits a minimal active value", () => {
    const standing: EffectiveStanding = { status: "active" };
    expect(standing.status).toBe("active");
  });
});
