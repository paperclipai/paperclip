import { describe, expect, it } from "vitest";

import { TIER_LADDER, escalateOneTier } from "../routing/escalate-tier.js";

describe("escalateOneTier (Phase E2 escalation backstop helper)", () => {
  describe("the four canonical transitions", () => {
    it("local -> fast", () => {
      expect(escalateOneTier("local")).toBe("fast");
    });
    it("fast -> default", () => {
      expect(escalateOneTier("fast")).toBe("default");
    });
    it("default -> heavy", () => {
      expect(escalateOneTier("default")).toBe("heavy");
    });
    it("heavy -> null (cap; no further escalation possible)", () => {
      expect(escalateOneTier("heavy")).toBeNull();
    });
  });

  describe("ladder integrity", () => {
    it("TIER_LADDER is in cheap->expensive order with no duplicates", () => {
      // Locked per MODEL_MENU.md. If this changes, the resolver +
      // dispatch escalation behavior change too. Failing this test
      // forces a deliberate update of both layers.
      expect(TIER_LADDER).toEqual(["local", "fast", "default", "heavy"]);
      expect(new Set(TIER_LADDER).size).toBe(TIER_LADDER.length);
    });

    it("escalateOneTier never returns the same tier (no fixed points)", () => {
      for (const t of TIER_LADDER) {
        expect(escalateOneTier(t)).not.toBe(t);
      }
    });

    it("walking the ladder from local reaches heavy then null in three steps", () => {
      const steps: (string | null)[] = [];
      let cur: ReturnType<typeof escalateOneTier> = "local";
      while (cur) {
        steps.push(cur);
        cur = escalateOneTier(cur);
      }
      expect(steps).toEqual(["local", "fast", "default", "heavy"]);
    });
  });
});
