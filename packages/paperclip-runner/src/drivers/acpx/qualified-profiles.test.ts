import { describe, expect, it } from "vitest";

import {
  QUALIFIED_ACPX_PROFILES,
  resolveQualifiedAcpxProfile,
} from "./qualified-profiles.js";

describe("qualified ACPX profiles", () => {
  it("binds each agent to one immutable package and model declaration", () => {
    for (const agent of ["pi", "claude", "codex"] as const) {
      const profile = QUALIFIED_ACPX_PROFILES[agent];
      expect(profile.agent).toBe(agent);
      expect(profile.commandDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(Object.isFrozen(profile)).toBe(true);
      expect(
        resolveQualifiedAcpxProfile(agent, profile.qualificationModel),
      ).toEqual(profile);
    }
  });

  it("rejects unqualified model substitutions", () => {
    expect(() =>
      resolveQualifiedAcpxProfile("codex", "some-other-model"),
    ).toThrow("requires exact model");
  });
});
