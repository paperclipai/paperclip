import { describe, expect, it } from "vitest";
import { detectEnvironmentBlocker } from "./detector.js";

describe("detectEnvironmentBlocker", () => {
  it("returns found=false when no blocker pattern present", () => {
    const result = detectEnvironmentBlocker("This issue tracks onboarding work.");
    expect(result.found).toBe(false);
  });

  it("detects basic blocker pattern", () => {
    const result = detectEnvironmentBlocker(
      "Work cannot start. Blocked until: MT5 terminal is available.",
    );
    expect(result.found).toBe(true);
    expect(result.resource).toContain("MT5 terminal");
  });

  it("assigns CTO ownership for VPS resource", () => {
    const result = detectEnvironmentBlocker(
      "Blocked until: VPS is provisioned.",
    );
    expect(result.found).toBe(true);
    expect(result.ownerType).toBe("CTO");
  });

  it("assigns CTO ownership for MT5 resource", () => {
    const result = detectEnvironmentBlocker(
      "Blocked until: MT5 terminal is available.",
    );
    expect(result.ownerType).toBe("CTO");
  });

  it("assigns CTO ownership for infra/cloud resources", () => {
    for (const word of ["cloud", "terraform", "infra", "docker", "k8s", "database"]) {
      const result = detectEnvironmentBlocker(
        `Blocked until: ${word} is available.`,
      );
      expect(result.ownerType).toBe("CTO");
    }
  });

  it("assigns CEO ownership for non-infra resources", () => {
    const result = detectEnvironmentBlocker(
      "Blocked until: broker account is available.",
    );
    expect(result.found).toBe(true);
    expect(result.ownerType).toBe("CEO");
  });

  it("is case-insensitive for pattern matching", () => {
    const result = detectEnvironmentBlocker(
      "BLOCKED UNTIL: VPS IS PROVISIONED.",
    );
    expect(result.found).toBe(true);
    expect(result.ownerType).toBe("CTO");
  });

  it("matches 'access available' variant", () => {
    const result = detectEnvironmentBlocker(
      "Blocked until: broker API access available.",
    );
    expect(result.found).toBe(true);
  });
});
