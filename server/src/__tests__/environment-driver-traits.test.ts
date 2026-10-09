import { describe, expect, it } from "vitest";
import {
  ENVIRONMENT_DRIVER_TRAITS,
  getEnvironmentDriverTraits,
  type EnvironmentDriverTraits,
} from "../services/environment-driver-traits.js";

// The exact trait table this phase moves each of the four consumers onto. Each
// value is the value the current per-consumer driver-name condition produces
// today, so this table proves the refactor changes no decision.
const EXPECTED_TRAITS: Record<string, Omit<EnvironmentDriverTraits, "driver">> = {
  local: {
    realizesWorkspace: true,
    runsWorkspaceOffHost: false,
    confinesStagedProjects: false,
    hasLeaseCapabilityModel: false,
  },
  ssh: {
    realizesWorkspace: true,
    runsWorkspaceOffHost: true,
    confinesStagedProjects: false,
    hasLeaseCapabilityModel: false,
  },
  sandbox: {
    realizesWorkspace: true,
    runsWorkspaceOffHost: true,
    confinesStagedProjects: true,
    hasLeaseCapabilityModel: true,
  },
  plugin: {
    realizesWorkspace: false,
    runsWorkspaceOffHost: true,
    confinesStagedProjects: false,
    hasLeaseCapabilityModel: false,
  },
};

describe("environment driver traits", () => {
  for (const [driver, expected] of Object.entries(EXPECTED_TRAITS)) {
    it(`carries the exact trait row for "${driver}"`, () => {
      const traits = ENVIRONMENT_DRIVER_TRAITS[driver as keyof typeof ENVIRONMENT_DRIVER_TRAITS];
      expect(traits.driver).toBe(driver);
      expect(traits.realizesWorkspace).toBe(expected.realizesWorkspace);
      expect(traits.runsWorkspaceOffHost).toBe(expected.runsWorkspaceOffHost);
      expect(traits.confinesStagedProjects).toBe(expected.confinesStagedProjects);
      expect(traits.hasLeaseCapabilityModel).toBe(expected.hasLeaseCapabilityModel);
    });
  }

  it("only the sandbox driver has a lease capability model today", () => {
    const withModel = Object.values(ENVIRONMENT_DRIVER_TRAITS).filter(
      (traits) => traits.hasLeaseCapabilityModel,
    );
    expect(withModel.map((traits) => traits.driver)).toEqual(["sandbox"]);
  });

  it("getEnvironmentDriverTraits resolves a registered driver", () => {
    expect(getEnvironmentDriverTraits("sandbox")?.hasLeaseCapabilityModel).toBe(true);
    expect(getEnvironmentDriverTraits("plugin")?.realizesWorkspace).toBe(false);
  });

  it("getEnvironmentDriverTraits returns null for an unknown or absent driver", () => {
    expect(getEnvironmentDriverTraits("not-a-real-driver")).toBeNull();
    expect(getEnvironmentDriverTraits(null)).toBeNull();
    expect(getEnvironmentDriverTraits(undefined)).toBeNull();
  });
});
